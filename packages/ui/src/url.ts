// Small URL helpers shared by views that render externally-sourced links.

// Only web/mail schemes may become a clickable href. URLs that originate from a
// provider/webhook payload reach the DOM via React, which does NOT sanitize the
// href attribute — so a `javascript:` / `data:` value must be dropped, not
// rendered as a link. Returns the url unchanged when safe, else null (no link).
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const scheme = new URL(url).protocol;
    return scheme === "http:" || scheme === "https:" || scheme === "mailto:"
      ? url
      : null;
  } catch {
    return null;
  }
}
