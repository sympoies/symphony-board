import { useEffect, useState } from "react";

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
