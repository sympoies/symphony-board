import {
  DEFAULT_FETCH_TIMEOUT_MS,
  ProviderHttpError,
  fallbackRepoAccessMessage,
  fetchWithTimeout,
  githubRateLimitInfo,
  normalizeAuthTokens,
  primaryCooldownUntil,
  type AuthTokenInput,
} from "./http.ts";

export type RestClient = <T = any>(path: string, params?: Record<string, string | number | boolean | null | undefined>) => Promise<T>;

function firstTokenIndex(tokens: ReturnType<typeof normalizeAuthTokens>, blockedUntil: Map<number, number>): number {
  const now = Date.now();
  for (let idx = 0; idx < tokens.length; idx++) {
    const blocked = blockedUntil.get(idx) ?? 0;
    if (blocked <= now) return idx;
  }
  return 0;
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

function shouldRotateToken(provider: "github" | "gitlab", err: ProviderHttpError, tokensLength: number): boolean {
  return provider === "github" && tokensLength > 1 && err.rateLimit?.kind === "primary";
}

export function makeRestClient(baseUrl: string, tokenInput: AuthTokenInput, provider: "github" | "gitlab", timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS): RestClient {
  const base = baseUrl.replace(/\/+$/, "");
  const tokens = normalizeAuthTokens(tokenInput);
  const blockedUntil = new Map<number, number>();

  return async function rest<T = any>(path: string, params: Record<string, string | number | boolean | null | undefined> = {}): Promise<T> {
    const url = new URL(`${base}/${path.replace(/^\/+/, "")}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }

    let idx = firstTokenIndex(tokens, blockedUntil);
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
