import {
  DEFAULT_FETCH_TIMEOUT_MS,
  ProviderHttpError,
  allTokensCooledDownError,
  createAuthSelectionState,
  describeRestOperation,
  fallbackRepoAccessMessage,
  fetchWithTimeout,
  githubRateBudgetFromHeaders,
  githubRateLimitInfo,
  isGithubPrimaryRateLimit,
  markAuthTokenCooledDown,
  nextAvailableToken,
  normalizeAuthTokens,
  primaryCooldownUntil,
  recordAuthAttemptDone,
  recordAuthAttemptStart,
  repoFromRestPath,
  selectAvailableToken,
  traceAuthSelection,
  type AuthTokenInput,
} from "./http.ts";

export type RestClient = <T = any>(path: string, params?: Record<string, string | number | boolean | null | undefined>) => Promise<T>;

export type RestProvider = "github" | "gitlab" | "forgejo";

export interface RestClientOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
  onRequest?: () => void;
}

const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

async function boundedResponseText(res: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(`REST HTTP ${res.status}: response exceeded ${maxBytes} bytes`);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`REST HTTP ${res.status}: response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function safeErrorText(value: string, tokens: readonly { value: string }[]): string {
  let out = value;
  for (const token of tokens) {
    if (token.value) out = out.split(token.value).join("[REDACTED]");
  }
  return out.length > 500 ? `${out.slice(0, 500)}…` : out;
}

export function makeRestClient(
  baseUrl: string,
  tokenInput: AuthTokenInput,
  provider: RestProvider,
  timeoutOrOptions: number | RestClientOptions = DEFAULT_FETCH_TIMEOUT_MS,
): RestClient {
  const base = baseUrl.replace(/\/+$/, "");
  const options = typeof timeoutOrOptions === "number" ? { timeoutMs: timeoutOrOptions } : timeoutOrOptions;
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const configuredBase = new URL(`${base}/`);
  const configuredPath = configuredBase.pathname.replace(/\/+$/, "");
  const tokens = normalizeAuthTokens(tokenInput);
  // Shared across all callers of this client, now including the bounded-concurrent
  // resolve passes (lib/concurrency.ts). Writes are idempotent cooldown stamps and
  // reads only pick an available token, so concurrent callers racing on it is
  // benign: the worst case is several each re-stamping the same cooldown.
  const blockedUntil = new Map<number, number>();
  const selection = createAuthSelectionState(tokens, `rest:${provider}:${base}`);

  return async function rest<T = any>(path: string, params: Record<string, string | number | boolean | null | undefined> = {}): Promise<T> {
    const url = new URL(`${base}/${path.replace(/^\/+/, "")}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }

    const first = selectAvailableToken(tokens, blockedUntil, selection);
    if (first === null) {
      // Every token is still cooled down from a prior rate limit; do not send
      // another doomed request with a known-blocked PAT.
      throw allTokensCooledDownError(`REST request to ${url}`, tokens.length, blockedUntil, tokens, selection);
    }
    let idx = first;
    const tried = new Set<number>();
    let lastError: Error | null = null;

    while (!tried.has(idx)) {
      tried.add(idx);
      const token = tokens[idx]!;
      traceAuthSelection({
        provider,
        api: "rest",
        token,
        operation: describeRestOperation(path),
        repo: repoFromRestPath(path),
      });
      recordAuthAttemptStart(tokens, idx, selection);
      let attemptRecorded = false;
      try {
        const headers: Record<string, string> = {
          "User-Agent": "symphony-board",
        };
        if (provider === "github") {
          headers.Authorization = `Bearer ${token.value}`;
          headers.Accept = "application/vnd.github+json";
          headers["X-GitHub-Api-Version"] = "2022-11-28";
        } else if (provider === "gitlab") {
          headers["PRIVATE-TOKEN"] = token.value;
        } else {
          headers.Authorization = `token ${token.value}`;
        }
        let requestUrl = url;
        let res: Response;
        for (let redirects = 0; ; redirects++) {
          options.onRequest?.();
          res = await fetchWithTimeout(
            requestUrl,
            { headers, ...(provider === "forgejo" ? { redirect: "manual" as const } : {}) },
            timeoutMs,
          );
          if (provider !== "forgejo" || ![301, 302, 303, 307, 308].includes(res.status)) break;
          const location = res.headers.get("location");
          if (!location) throw new Error(`REST HTTP ${res.status}: redirect without Location from ${requestUrl}`);
          const next = new URL(location, requestUrl);
          if (next.origin !== configuredBase.origin) {
            throw new Error(`REST HTTP ${res.status}: cross-origin redirect refused for ${requestUrl}`);
          }
          const nextPath = next.pathname.replace(/\/+$/, "");
          if (nextPath !== configuredPath && !nextPath.startsWith(`${configuredPath}/`)) {
            throw new Error(`REST HTTP ${res.status}: redirect outside configured API root refused for ${requestUrl}`);
          }
          if (redirects >= maxRedirects) throw new Error(`REST HTTP ${res.status}: redirect limit ${maxRedirects} exceeded for ${url}`);
          requestUrl = next;
        }
        const text = await boundedResponseText(res, maxResponseBytes);
        let json: any;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          recordAuthAttemptDone(tokens, idx, selection, provider === "github" ? githubRateBudgetFromHeaders(res.headers) : null);
          attemptRecorded = true;
          throw new Error(`REST HTTP ${res.status}: non-JSON response from ${requestUrl}`);
        }
        recordAuthAttemptDone(tokens, idx, selection, provider === "github" ? githubRateBudgetFromHeaders(res.headers) : null);
        attemptRecorded = true;
        if (!res.ok) {
          const rawMessage = safeErrorText(`REST HTTP ${res.status}: ${json?.message ?? text}`, tokens);
          const message = fallbackRepoAccessMessage(rawMessage, token, res.status, provider, tried.size > 1);
          const err = new ProviderHttpError(message, res.status, provider === "github" ? githubRateLimitInfo(res.headers, message) : null);
          if (isGithubPrimaryRateLimit(provider, err)) {
            const until = primaryCooldownUntil(err.rateLimit!);
            blockedUntil.set(idx, until);
            markAuthTokenCooledDown(tokens, idx, selection, until);
            const next = nextAvailableToken(tokens, blockedUntil, tried, idx, selection);
            if (next !== null) {
              lastError = err;
              idx = next;
              continue;
            }
          }
          throw err;
        }
        return json as T;
      } finally {
        if (!attemptRecorded) recordAuthAttemptDone(tokens, idx, selection);
      }
    }
    throw lastError ?? new Error(`REST request could not select an available token for ${url}`);
  };
}

export function defaultRestUrl(kind: string, host: string): string {
  if (kind === "github") return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
  if (kind === "gitlab") return `https://${host}/api/v4`;
  if (kind === "forgejo") return `https://${host}/api/v1`;
  return `https://${host}`;
}

export function forgejoApiUrl(baseUrl: string): string {
  const base = new URL(baseUrl);
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/api/v1`;
  base.search = "";
  base.hash = "";
  return base.toString().replace(/\/+$/, "");
}
