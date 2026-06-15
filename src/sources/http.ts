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
}

export type AuthTokenInput = string | AuthToken[];

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
  if (typeof input === "string") return [{ env: "token", value: input }];
  return input.filter((token) => token.value.trim().length > 0).map((token) => ({ env: token.env, value: token.value.trim() }));
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
