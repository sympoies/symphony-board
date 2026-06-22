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

// Apply the resolved cold-start hash in the Tauri webview BEFORE React mounts, so
// the desktop app never flashes the restored route before redirecting. The
// landing decision (honor the configured default tab) lives in `startupRouteHash`
// (nav.ts) and is shared with the web path in App; this is just the DOM applier,
// gated to the desktop host. A no-op on web, where the browser owns the hash and
// App applies the same rule on mount.
export function normalizeDesktopStartupRoute(targetHash: string): void {
  if (!isTauriRuntime() || typeof window === "undefined") return;
  if (targetHash && window.location.hash !== targetHash) window.location.hash = targetHash;
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

// --- wide (desktop) layout for the Android app --------------------------------
// A large e-reader can host the desktop multi-column layout the CSS breakpoints
// gate on, but reports a small device-width and so falls into the phone layout.
// The user can turn on a per-device "Wide layout" setting that forces a fixed
// desktop-width viewport — but ONLY in the Android WebView: the browser and the
// desktop shell are freely resizable and must keep the responsive
// width=device-width meta. The fixed width crosses into the desktop multi-column
// tiers (>= 1180px in styles.css) while staying narrow enough that the scaled-down
// text stays readable on a smaller e-reader (1500px scaled ~0.45x was too small).
// The native shell sets useWideViewPort + loadWithOverviewMode so the WebView
// honors this width and scales it to fit.
export const WIDE_VIEWPORT_WIDTH = 1280;

// The viewport `content` to apply for a layout preference + client, or null to
// keep the responsive default. Only the Android client with wide layout ON gets a
// fixed width; every other combination returns null. Pure + unit-tested so the
// gate cannot silently leak onto the browser / desktop / default Android layout.
// (Compares against "android" — the value of viewconfig.ANDROID_CLIENT_KIND, not
// imported here to avoid a viewconfig <-> runtime import cycle.)
export function wideViewportContent(wide: boolean, clientKind: string | null): string | null {
  if (!wide || clientKind !== "android") return null;
  return `width=${WIDE_VIEWPORT_WIDTH}`;
}

// Apply the wide-layout preference to the document's viewport meta. A no-op on the
// browser and desktop shell (they keep the responsive index.html meta); on Android
// it sets the fixed desktop width when ON and restores width=device-width when OFF,
// so toggling the setting flips the layout without an app restart.
export function applyWideViewport(wide: boolean, clientKind: string | null, targetWindow: Window = window): void {
  if (clientKind !== "android" || typeof targetWindow === "undefined") return;
  const meta = targetWindow.document?.querySelector('meta[name="viewport"]');
  if (!meta) return;
  meta.setAttribute("content", wideViewportContent(wide, clientKind) ?? "width=device-width, initial-scale=1.0");
  if (wide) targetWindow.document.documentElement.dataset.wideViewport = "true";
  else targetWindow.document.documentElement.removeAttribute("data-wide-viewport");
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

// Standard fetch init plus the one plugin-http ClientOptions key we use.
// `connectTimeout` bounds connection establishment on the Tauri desktop client
// without aborting an in-progress body transfer; the browser fetch ignores the
// extra key (a stalled connect is bounded there by `signal` instead).
export interface AppFetchInit extends RequestInit {
  connectTimeout?: number;
}

export async function appFetch(url: string, init?: AppFetchInit): Promise<Response> {
  if (isTauriRuntime() && isHttpUrl(url)) {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    return tauriFetch(url, init);
  }
  return fetch(url, init as RequestInit);
}

export async function openExternalUrl(url: string): Promise<boolean> {
  if (!isTauriRuntime() || !isHttpUrl(url)) return false;
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
  return true;
}
