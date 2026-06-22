// Tiny GraphQL-over-HTTP client shared by the provider sources. Both GitHub and
// GitLab accept `Authorization: Bearer <PAT>` on their GraphQL endpoints, so one
// helper serves both; only the URL and token differ.

import {
  DEFAULT_FETCH_TIMEOUT_MS,
  ProviderHttpError,
  allTokensCooledDownError,
  fallbackRepoAccessMessage,
  fetchWithTimeout,
  firstAvailableToken,
  githubRateLimitInfo,
  isGithubPrimaryRateLimit,
  nextAvailableToken,
  normalizeAuthTokens,
  primaryCooldownUntil,
  type AuthTokenInput,
} from "./http.ts";

export type GqlClient = <T = any>(query: string, variables?: Record<string, unknown>) => Promise<T>;

export interface GqlClientOptions {
  timeoutMs?: number;
  provider?: string;
}

function gqlOptions(input: number | GqlClientOptions | undefined, url: string): Required<GqlClientOptions> {
  if (typeof input === "number") return { timeoutMs: input, provider: url.includes("github") ? "github" : "" };
  return {
    timeoutMs: input?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
    provider: input?.provider ?? (url.includes("github") ? "github" : ""),
  };
}

export function makeGqlClient(url: string, tokenInput: AuthTokenInput, opts?: number | GqlClientOptions): GqlClient {
  const tokens = normalizeAuthTokens(tokenInput);
  const { timeoutMs, provider } = gqlOptions(opts, url);
  // Shared across all callers of this client, now including the bounded-concurrent
  // resolve passes (lib/concurrency.ts). Writes are idempotent cooldown stamps and
  // reads only pick an available token, so concurrent callers racing on it is
  // benign: the worst case is several each re-stamping the same cooldown.
  const blockedUntil = new Map<number, number>();

  return async function gql<T = any>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const first = firstAvailableToken(tokens.length, blockedUntil);
    if (first === null) {
      // Every token is still cooled down from a prior rate limit; do not send
      // another doomed request with a known-blocked PAT.
      throw allTokensCooledDownError(`GraphQL request to ${url}`, tokens.length, blockedUntil);
    }
    let idx = first;
    const tried = new Set<number>();
    let lastError: Error | null = null;

    while (!tried.has(idx)) {
      tried.add(idx);
      const token = tokens[idx]!;
      const res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token.value}`,
            "Content-Type": "application/json",
            "User-Agent": "symphony-board",
          },
          body: JSON.stringify({ query, variables }),
        },
        timeoutMs,
      );
      const text = await res.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`GraphQL HTTP ${res.status}: non-JSON response from ${url}`);
      }
      if (!res.ok) {
        const rawMessage = `GraphQL HTTP ${res.status}: ${json?.message ?? text}`;
        const message = fallbackRepoAccessMessage(rawMessage, token, res.status, provider, idx > 0);
        const err = new ProviderHttpError(message, res.status, provider === "github" ? githubRateLimitInfo(res.headers, message) : null);
        if (isGithubPrimaryRateLimit(provider, err)) {
          blockedUntil.set(idx, primaryCooldownUntil(err.rateLimit!));
          const next = nextAvailableToken(tokens.length, blockedUntil, tried, idx);
          if (next !== null) {
            lastError = err;
            idx = next;
            continue;
          }
        }
        throw err;
      }
      if (json.errors?.length) {
        const rawMessage = `GraphQL errors: ${json.errors.map((e: { message: string }) => e.message).join("; ")}`;
        const message = fallbackRepoAccessMessage(rawMessage, token, res.status, provider, idx > 0);
        const err = new ProviderHttpError(message, res.status, provider === "github" ? githubRateLimitInfo(res.headers, message) : null);
        if (isGithubPrimaryRateLimit(provider, err)) {
          blockedUntil.set(idx, primaryCooldownUntil(err.rateLimit!));
          const next = nextAvailableToken(tokens.length, blockedUntil, tried, idx);
          if (next !== null) {
            lastError = err;
            idx = next;
            continue;
          }
        }
        throw err;
      }
      return json.data as T;
    }
    throw lastError ?? new Error(`GraphQL request could not select an available token for ${url}`);
  };
}
