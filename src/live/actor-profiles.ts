import { log } from "../log.ts";
import type { LiveStore, LiveActorProfileInput } from "./store.ts";
import type { LiveEvent } from "./types.ts";

const GITHUB_API = "https://api.github.com";
const DEFAULT_PROFILE_TTL_MS = 7 * 86_400_000;
const DEFAULT_NEGATIVE_TTL_MS = 15 * 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_MAX_QUEUE = 256;

type FetchFn = typeof fetch;

export interface GithubActorProfileOptions {
  fetchFn?: FetchFn;
  now?: () => Date;
  ttlMs?: number;
  negativeTtlMs?: number;
  timeoutMs?: number;
}

export interface ActorProfileObserver {
  observe(event: LiveEvent, onUpdate?: (event: LiveEvent) => void): void;
  close?(): void;
}

export interface ActorProfileObserverOptions extends GithubActorProfileOptions {
  maxConcurrent?: number;
  maxQueue?: number;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function profileTime(now: Date, ttlMs: number): string {
  return new Date(now.getTime() + ttlMs).toISOString();
}

function negativeProfile(
  login: string,
  error: string,
  now: Date,
  ttlMs: number,
): LiveActorProfileInput {
  return {
    source_id: "github:github.com",
    provider: "github",
    login,
    display_name: null,
    avatar_url: null,
    profile_url: null,
    fetched_at: now.toISOString(),
    expires_at: profileTime(now, ttlMs),
    last_error: error,
  };
}

function hasSeed(actor: LiveEvent["actor"]): boolean {
  return !!(actor?.display_name || actor?.avatar_url || actor?.profile_url);
}

function hasAvatar(actor: LiveEvent["actor"]): boolean {
  return !!actor?.avatar_url;
}

function applyProfile(event: LiveEvent, profile: LiveActorProfileInput): LiveEvent {
  const actor = event.actor;
  if (!actor || !actor.login) return event;
  const next = {
    ...actor,
    display_name: actor.display_name ?? profile.display_name ?? null,
    avatar_url: actor.avatar_url ?? profile.avatar_url ?? null,
    profile_url: actor.profile_url ?? profile.profile_url ?? null,
  };
  if (
    next.display_name === actor.display_name &&
    next.avatar_url === actor.avatar_url &&
    next.profile_url === actor.profile_url
  ) {
    return event;
  }
  return { ...event, actor: next };
}

export async function fetchGithubActorProfile(
  login: string,
  opts: GithubActorProfileOptions = {},
): Promise<LiveActorProfileInput> {
  const now = opts.now?.() ?? new Date();
  const fetchFn = opts.fetchFn ?? fetch;
  const ttlMs = opts.ttlMs ?? DEFAULT_PROFILE_TTL_MS;
  const negativeTtlMs = opts.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${GITHUB_API}/users/${encodeURIComponent(login)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "symphony-board-live",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return negativeProfile(login, `GitHub users API HTTP ${res.status}`, now, negativeTtlMs);
    }
    const json = (await res.json()) as Record<string, unknown>;
    return {
      source_id: "github:github.com",
      provider: "github",
      login,
      display_name: asString(json.name) ?? asString(json.login),
      avatar_url: asString(json.avatar_url),
      profile_url: asString(json.html_url),
      fetched_at: now.toISOString(),
      expires_at: profileTime(now, ttlMs),
      last_error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return negativeProfile(login, `GitHub users API: ${message}`, now, negativeTtlMs);
  } finally {
    clearTimeout(timer);
  }
}

export function createGithubActorProfileObserver(
  store: LiveStore,
  opts: ActorProfileObserverOptions = {},
): ActorProfileObserver {
  const maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE;
  const queue: Array<{
    key: string;
    login: string;
    waiters: Array<{ event: LiveEvent; onUpdate?: (event: LiveEvent) => void }>;
  }> = [];
  const queued = new Map<string, (typeof queue)[number]>();
  let active = 0;
  let closed = false;

  const runNext = (): void => {
    if (closed || active >= maxConcurrent) return;
    const job = queue.shift();
    if (!job) return;
    active += 1;
    void fetchGithubActorProfile(job.login, opts)
      .then((profile) => {
        if (closed) return;
        store.upsertActorProfile(profile);
        if (!profile.avatar_url) return;
        for (const waiter of job.waiters) {
          const enriched = applyProfile(waiter.event, profile);
          if (enriched === waiter.event) continue;
          try {
            waiter.onUpdate?.(enriched);
          } catch (err) {
            log.warn(`[live] actor profile update failed for ${job.login}: ${(err as Error).message}`);
          }
        }
      })
      .catch((err: unknown) => {
        if (!closed) {
          log.warn(`[live] actor profile lookup failed for ${job.login}: ${(err as Error).message}`);
        }
      })
      .finally(() => {
        active -= 1;
        queued.delete(job.key);
        runNext();
      });
  };

  const enqueue = (
    login: string,
    event: LiveEvent,
    onUpdate?: (event: LiveEvent) => void,
  ): void => {
    const key = login.toLowerCase();
    if (closed) return;
    const existing = queued.get(key);
    if (existing) {
      existing.waiters.push({ event, onUpdate });
      return;
    }
    if (queue.length >= maxQueue) {
      log.warn("[live] actor profile lookup queue full; dropping lookup");
      return;
    }
    const job = { key, login, waiters: [{ event, onUpdate }] };
    queued.set(key, job);
    queue.push(job);
    runNext();
  };

  return {
    observe(event: LiveEvent, onUpdate?: (event: LiveEvent) => void): void {
      if (event.provider !== "github" || event.source_id !== "github:github.com") return;
      const actor = event.actor;
      const login = actor?.login;
      if (!login) return;
      if (hasSeed(actor)) {
        const now = new Date();
        store.upsertActorProfile({
          source_id: event.source_id,
          provider: event.provider,
          login,
          display_name: actor.display_name ?? null,
          avatar_url: actor.avatar_url ?? null,
          profile_url: actor.profile_url ?? null,
          fetched_at: now.toISOString(),
          expires_at: profileTime(now, opts.ttlMs ?? DEFAULT_PROFILE_TTL_MS),
          last_error: null,
        });
      }
      if (hasAvatar(actor)) return;
      if (store.hasFreshResolvedActorProfile(event.source_id, event.provider, login)) return;
      enqueue(login, event, onUpdate);
    },
    close(): void {
      closed = true;
      queue.length = 0;
      queued.clear();
    },
  };
}
