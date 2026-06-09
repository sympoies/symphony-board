// Runtime adapters for the same React UI in two hosts:
//   - browser/web deploy: use normal Web APIs
//   - Tauri desktop: use native plugins for cross-origin HTTP and external links

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && (window.location.protocol === "tauri:" || "__TAURI_INTERNALS__" in window);
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
