import { externalWebUrl } from "../../../shared/provider-links.ts";

// Markdown may contain email links; entity destinations use web URLs only.
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try { if (new URL(url).protocol === "mailto:") return url; } catch { return null; }
  return externalWebUrl(url);
}
