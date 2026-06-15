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

function nextTokenIndex(tokens: ReturnType<typeof normalizeAuthTokens>, blockedUntil: Map<number, number>, tried: Set<number>, after: number): number | null {
  const now = Date.now();
  for (let step = 1; step <= tokens.length; step++) {
    const idx = (after + step) % tokens.length;
    if (tried.has(idx)) continue;
    const blocked = blockedUntil.get(idx) ?? 0;
    if (blocked <= now) return idx;
  }
  return null;
}

function shouldRotateToken(provider: string, err: ProviderHttpError, tokensLength: number): boolean {
  return provider === "github" && tokensLength > 1 && err.rateLimit?.kind === "primary";
}

export function makeGqlClient(url: string, tokenInput: AuthTokenInput, opts?: number | GqlClientOptions): GqlClient {
  const tokens = normalizeAuthTokens(tokenInput);
  const { timeoutMs, provider } = gqlOptions(opts, url);
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
        if (shouldRotateToken(provider, err, tokens.length)) {
          blockedUntil.set(idx, primaryCooldownUntil(err.rateLimit!));
          const next = nextTokenIndex(tokens, blockedUntil, tried, idx);
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
        if (shouldRotateToken(provider, err, tokens.length)) {
          blockedUntil.set(idx, primaryCooldownUntil(err.rateLimit!));
          const next = nextTokenIndex(tokens, blockedUntil, tried, idx);
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
