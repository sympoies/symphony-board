import { useEffect, useState } from "react";
import { SHORT_VIEWPORT_QUERY } from "./layout-tier.ts";

// SSR-safe one-shot probe (no subscription): a missing `window` or matchMedia
// reads as "no match", so the caller falls back to its roomy-viewport default.
// Mirrors this file's hook seeding rule; use the hook when the answer must stay
// live across a resize, and this when a one-time default is all that is needed
// (a lazy useState initializer, say).
export function matchesViewportQuery(query: string, target: Window | undefined = typeof window === "undefined" ? undefined : window): boolean {
  if (typeof target?.matchMedia !== "function") return false;
  try {
    return target.matchMedia(query).matches;
  } catch {
    return false;
  }
}

export function isShortViewport(target?: Window): boolean {
  return matchesViewportQuery(SHORT_VIEWPORT_QUERY, target);
}

// Subscribe to a CSS media query, re-rendering when it flips. The state seeds
// synchronously from the current match so the first paint already reflects the
// viewport (no narrow/wide flash), and it stays SSR-safe by treating a missing
// `window` as "no match". Shared by the Activity feed (row height) and the
// Activity page (single-pane mobile layout) so both read one breakpoint.
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
