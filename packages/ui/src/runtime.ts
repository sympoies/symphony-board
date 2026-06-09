// Runtime adapters for the same React UI in two hosts:
//   - browser/web deploy: use normal Web APIs
//   - Tauri desktop: use native plugins for cross-origin HTTP and external links

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && (window.location.protocol === "tauri:" || "__TAURI_INTERNALS__" in window);
}

export const DESKTOP_DEFAULT_HASH = "#/activity";
const DESKTOP_STARTUP_ROUTE_KEY = "symphony-board:desktop-startup-route-normalized";

export function desktopStartupRouteHash(currentHash: string, alreadyNormalized: boolean): string | null {
  if (alreadyNormalized) return null;
  return currentHash === DESKTOP_DEFAULT_HASH ? null : DESKTOP_DEFAULT_HASH;
}

export function normalizeDesktopStartupRoute(): void {
  if (!isTauriRuntime() || typeof window === "undefined") return;

  let alreadyNormalized = false;
  try {
    alreadyNormalized = window.sessionStorage.getItem(DESKTOP_STARTUP_ROUTE_KEY) === "1";
    window.sessionStorage.setItem(DESKTOP_STARTUP_ROUTE_KEY, "1");
  } catch {
    alreadyNormalized = false;
  }

  const nextHash = desktopStartupRouteHash(window.location.hash, alreadyNormalized);
  if (nextHash && window.location.hash !== nextHash) window.location.hash = nextHash;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export async function appFetch(url: string, init?: RequestInit): Promise<Response> {
  if (isTauriRuntime() && isHttpUrl(url)) {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    return tauriFetch(url, init);
  }
  return fetch(url, init);
}

export async function openExternalUrl(url: string): Promise<boolean> {
  if (!isTauriRuntime() || !isHttpUrl(url)) return false;
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
  return true;
}
