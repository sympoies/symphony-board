// Runtime adapters for the same React UI in two hosts:
//   - browser/web deploy: use normal Web APIs
//   - Tauri desktop: use native plugins for cross-origin HTTP and external links

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && (window.location.protocol === "tauri:" || "__TAURI_INTERNALS__" in window);
}

export const DESKTOP_DEFAULT_HASH = "#/activity";

export function desktopStartupRouteHash(currentHash: string, navigationType: string | null): string | null {
  if (navigationType === "reload") return null;
  return currentHash === DESKTOP_DEFAULT_HASH ? null : DESKTOP_DEFAULT_HASH;
}

export function normalizeDesktopStartupRoute(): void {
  if (!isTauriRuntime() || typeof window === "undefined") return;

  const navigation = window.performance.getEntriesByType("navigation")[0];
  const navigationType = navigation && "type" in navigation && typeof navigation.type === "string" ? navigation.type : null;
  const nextHash = desktopStartupRouteHash(window.location.hash, navigationType);
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

export function internalRouteHashFromHref(rawHref: string | null, resolvedHref: string, currentHref: string): string | null {
  const href = rawHref?.trim() ?? "";
  if (href.startsWith("#/")) return href;

  try {
    const resolved = new URL(resolvedHref);
    const current = new URL(currentHref);
    if (!resolved.hash.startsWith("#/")) return null;
    if (resolved.origin !== current.origin) return null;
    if (resolved.pathname !== current.pathname) return null;
    if (resolved.search !== current.search) return null;
    return resolved.hash;
  } catch {
    return null;
  }
}

export function shouldOpenExternalHttpHref(rawHref: string | null, resolvedHref: string, currentHref: string): boolean {
  if (internalRouteHashFromHref(rawHref, resolvedHref, currentHref)) return false;
  return isHttpUrl(resolvedHref);
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
