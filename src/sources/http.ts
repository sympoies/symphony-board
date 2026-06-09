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
