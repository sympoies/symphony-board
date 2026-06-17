// Runtime adapters for the same React UI in two hosts:
//   - browser/web deploy: use normal Web APIs
//   - Tauri desktop: use native plugins for cross-origin HTTP and external links

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && (window.location.protocol === "tauri:" || "__TAURI_INTERNALS__" in window);
}

export interface AndroidSafeAreaBridge {
  top(): number;
  right(): number;
  bottom(): number;
  left(): number;
}

declare global {
  interface Window {
    symphonyAndroidInsets?: AndroidSafeAreaBridge;
  }
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

function cssInset(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  return `${Math.max(0, Number.isFinite(n) ? n : 0).toFixed(2)}px`;
}

export function applyAndroidSafeAreaInsets(targetWindow: Window = window): boolean {
  const bridge = targetWindow.symphonyAndroidInsets;
  if (!bridge) return false;

  const style = targetWindow.document.documentElement.style;
  style.setProperty("--android-safe-area-top", cssInset(bridge.top()));
  style.setProperty("--android-safe-area-right", cssInset(bridge.right()));
  style.setProperty("--android-safe-area-bottom", cssInset(bridge.bottom()));
  style.setProperty("--android-safe-area-left", cssInset(bridge.left()));
  targetWindow.document.documentElement.dataset.androidSystemInsets = "true";
  return true;
}

export function installAndroidSafeAreaInsets(): void {
  if (typeof window === "undefined" || !isTauriRuntime()) return;

  const apply = () => applyAndroidSafeAreaInsets(window);
  for (const delay of [0, 100, 500, 1000]) window.setTimeout(apply, delay);
  window.addEventListener("resize", apply);
  document.addEventListener("visibilitychange", apply);
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
