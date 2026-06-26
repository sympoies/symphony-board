// Shared fetch wrapper that bounds every provider request with an abort-based
// timeout. Without it, a socket that stalls (e.g. a half-up network or VPN right
// after the host wakes from sleep) hangs the whole sync iteration until the OS
// TCP timeout — minutes of dead air. A timeout here surfaces as an ordinary
// fetch error, which the engine treats as an INCOMPLETE fetch, so it can never
// trigger a disappearance soft-delete: a slow source degrades to "stale", never
// "deleted".
//
// Override the default with SYNC_FETCH_TIMEOUT_MS (milliseconds).
export const DEFAULT_FETCH_TIMEOUT_MS = Math.max(1000, Number(process.env.SYNC_FETCH_TIMEOUT_MS) || 30000);

export interface AuthToken {
  env: string;
  value: string;
  kind?: "pat" | "github_app";
  name?: string;
  strategy?: "failover" | "round_robin";
}

export type AuthTokenInput = string | AuthToken[];

export interface AuthSelectionState {
  roundRobinCursor: number;
}

export interface GitHubRateLimitInfo {
  kind: "primary" | "secondary";
  resetAtMs: number | null;
  retryAfterMs: number | null;
}

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly rateLimit: GitHubRateLimitInfo | null;

  constructor(message: string, status: number, rateLimit: GitHubRateLimitInfo | null = null) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = status;
    this.rateLimit = rateLimit;
  }
}

export function normalizeAuthTokens(input: AuthTokenInput): AuthToken[] {
  if (typeof input === "string") {
    const value = input.trim();
    return value.length > 0 ? [{ env: "token", value, kind: "pat", strategy: "failover" }] : [];
  }
  return input
    .filter((token) => token.value.trim().length > 0)
    .map((token) => ({
      ...token,
      value: token.value.trim(),
      kind: token.kind ?? (token.env.startsWith("github_app:") ? "github_app" : "pat"),
      strategy: token.strategy ?? "failover",
      ...(token.name?.trim() ? { name: token.name.trim() } : {}),
    }));
}

export function githubRateLimitInfo(headers: Headers, message: string): GitHubRateLimitInfo | null {
  const lower = message.toLowerCase();
  const retryAfter = Number(headers.get("retry-after"));
  const reset = Number(headers.get("x-ratelimit-reset"));
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : null;
  const resetAtMs = Number.isFinite(reset) && reset > 0 ? reset * 1000 : null;

  if (lower.includes("secondary rate limit") || lower.includes("abuse detection")) {
    return { kind: "secondary", resetAtMs, retryAfterMs };
  }
  if (headers.get("x-ratelimit-remaining") === "0") {
    return { kind: "primary", resetAtMs, retryAfterMs };
  }
  return null;
}

export function githubRepoAccessFailure(status: number, message: string): boolean {
  const lower = message.toLowerCase();
  if (lower.includes("could not resolve to a repository")) return true;
  if (lower.includes("resource not accessible")) return true;
  if (lower.includes("not accessible by integration")) return true;
  if (status === 404 && lower.includes("not found")) return true;
  if (status === 403 && lower.includes("forbidden")) return true;
  return false;
}

export function fallbackRepoAccessMessage(message: string, token: AuthToken, status: number, provider: string, isFallback: boolean): string {
  if (!isFallback || provider !== "github" || !githubRepoAccessFailure(status, message)) return message;
  return `${message} (fallback token lacks repo access: ${token.env})`;
}

export function primaryCooldownUntil(rateLimit: GitHubRateLimitInfo): number {
  return rateLimit.resetAtMs ?? Date.now() + 60 * 60 * 1000;
}

// Index of the first token whose cooldown (`blockedUntil`) has elapsed, or
// `null` when EVERY token in the pool is still cooled down. The shared selector
// for both the REST and GraphQL clients: returning `null` lets the caller
// short-circuit instead of re-sending a request with a known-rate-limited PAT,
// which would otherwise risk escalating to a secondary rate limit / abuse
// detection.
export function firstAvailableToken(tokenCount: number, blockedUntil: Map<number, number>, now: number = Date.now()): number | null {
  for (let idx = 0; idx < tokenCount; idx++) {
    if ((blockedUntil.get(idx) ?? 0) <= now) return idx;
  }
  return null;
}

export function selectAvailableToken(
  tokens: readonly AuthToken[],
  blockedUntil: Map<number, number>,
  selection: AuthSelectionState,
  now: number = Date.now(),
): number | null {
  if (tokens.length === 0) return null;
  for (let step = 0; step < tokens.length; step++) {
    const idx = (selection.roundRobinCursor + step) % tokens.length;
    const token = tokens[idx]!;
    if (token.strategy !== "round_robin") continue;
    if ((blockedUntil.get(idx) ?? 0) > now) continue;
    selection.roundRobinCursor = (idx + 1) % tokens.length;
    return idx;
  }
  return firstAvailableToken(tokens.length, blockedUntil, now);
}

// Pick the next token to retry after `after` was rate-limited, mirroring
// selectAvailableToken's bot-first rule: prefer an available GitHub App bot
// token before falling back to any available token (e.g. the failover PAT). The
// preference keys on the token being a bot (`kind === "github_app"`), not on the
// round_robin strategy, so a `bot_then_pat` pool whose apps use the failover
// strategy still rotates to a sibling bot before spending PAT quota. The initial
// pick is already bot-first; without the same preference here a retry could
// spend PAT quota while a bot in the pool is still available.
export function nextAvailableToken(
  tokens: readonly AuthToken[],
  blockedUntil: Map<number, number>,
  tried: ReadonlySet<number>,
  after: number,
  now: number = Date.now(),
): number | null {
  const tokenCount = tokens.length;
  for (let step = 1; step <= tokenCount; step++) {
    const idx = (after + step) % tokenCount;
    if (tried.has(idx)) continue;
    if (tokens[idx]?.kind !== "github_app") continue;
    if ((blockedUntil.get(idx) ?? 0) > now) continue;
    return idx;
  }
  for (let step = 1; step <= tokenCount; step++) {
    const idx = (after + step) % tokenCount;
    if (tried.has(idx)) continue;
    if ((blockedUntil.get(idx) ?? 0) <= now) return idx;
  }
  return null;
}

export function isGithubPrimaryRateLimit(provider: string, err: ProviderHttpError): boolean {
  return provider === "github" && err.rateLimit?.kind === "primary";
}

// Error raised when every token in the pool is cooled down. Carries the soonest
// reset so callers/telemetry can see when a retry could succeed.
export function allTokensCooledDownError(label: string, tokenCount: number, blockedUntil: Map<number, number>): ProviderHttpError {
  let soonest: number | null = null;
  for (const at of blockedUntil.values()) {
    if (soonest === null || at < soonest) soonest = at;
  }
  const when = soonest ? ` until ${new Date(soonest).toISOString()}` : "";
  return new ProviderHttpError(
    `${label}: all ${tokenCount} token(s) are rate-limited${when}`,
    429,
    soonest ? { kind: "primary", resetAtMs: soonest, retryAfterMs: null } : null,
  );
}

export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`request to ${String(input)} timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
