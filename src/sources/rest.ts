import {
  DEFAULT_FETCH_TIMEOUT_MS,
  ProviderHttpError,
  allTokensCooledDownError,
  fallbackRepoAccessMessage,
  fetchWithTimeout,
  githubRateLimitInfo,
  isGithubPrimaryRateLimit,
  nextAvailableToken,
  normalizeAuthTokens,
  primaryCooldownUntil,
  selectAvailableToken,
  type AuthTokenInput,
} from "./http.ts";

export type RestClient = <T = any>(path: string, params?: Record<string, string | number | boolean | null | undefined>) => Promise<T>;

export function makeRestClient(baseUrl: string, tokenInput: AuthTokenInput, provider: "github" | "gitlab", timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS): RestClient {
  const base = baseUrl.replace(/\/+$/, "");
  const tokens = normalizeAuthTokens(tokenInput);
  // Shared across all callers of this client, now including the bounded-concurrent
  // resolve passes (lib/concurrency.ts). Writes are idempotent cooldown stamps and
  // reads only pick an available token, so concurrent callers racing on it is
  // benign: the worst case is several each re-stamping the same cooldown.
  const blockedUntil = new Map<number, number>();
  const selection = { roundRobinCursor: 0 };

  return async function rest<T = any>(path: string, params: Record<string, string | number | boolean | null | undefined> = {}): Promise<T> {
    const url = new URL(`${base}/${path.replace(/^\/+/, "")}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }

    const first = selectAvailableToken(tokens, blockedUntil, selection);
    if (first === null) {
      // Every token is still cooled down from a prior rate limit; do not send
      // another doomed request with a known-blocked PAT.
      throw allTokensCooledDownError(`REST request to ${url}`, tokens.length, blockedUntil);
    }
    let idx = first;
    const tried = new Set<number>();
    let lastError: Error | null = null;

    while (!tried.has(idx)) {
      tried.add(idx);
      const token = tokens[idx]!;
      const headers: Record<string, string> = {
        "User-Agent": "symphony-board",
      };
      if (provider === "github") {
        headers.Authorization = `Bearer ${token.value}`;
        headers.Accept = "application/vnd.github+json";
        headers["X-GitHub-Api-Version"] = "2022-11-28";
      } else {
        headers["PRIVATE-TOKEN"] = token.value;
      }
      const res = await fetchWithTimeout(url, { headers }, timeoutMs);
      const text = await res.text();
      let json: any;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(`REST HTTP ${res.status}: non-JSON response from ${url}`);
      }
      if (!res.ok) {
        const rawMessage = `REST HTTP ${res.status}: ${json?.message ?? text}`;
        const message = fallbackRepoAccessMessage(rawMessage, token, res.status, provider, tried.size > 1);
        const err = new ProviderHttpError(message, res.status, provider === "github" ? githubRateLimitInfo(res.headers, message) : null);
        if (isGithubPrimaryRateLimit(provider, err)) {
          blockedUntil.set(idx, primaryCooldownUntil(err.rateLimit!));
          const next = nextAvailableToken(tokens, blockedUntil, tried, idx);
          if (next !== null) {
            if (tokens[next]?.strategy === "round_robin") selection.roundRobinCursor = (next + 1) % tokens.length;
            lastError = err;
            idx = next;
            continue;
          }
        }
        throw err;
      }
      return json as T;
    }
    throw lastError ?? new Error(`REST request could not select an available token for ${url}`);
  };
}

export function defaultRestUrl(kind: string, host: string): string {
  if (kind === "github") return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
  if (kind === "gitlab") return `https://${host}/api/v4`;
  return `https://${host}`;
}
