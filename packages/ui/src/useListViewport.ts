import { useCallback, useEffect, useRef, useState, type UIEvent } from "react";

// Shared scroll/viewport plumbing for the virtualized lists (the Activity feed
// and the Commit timeline). It owns the three things both lists had copy-pasted:
//   - the live scroll position,
//   - the measured viewport height (ResizeObserver, with a window-resize
//     fallback for environments without it), and
//   - "jump back to the top when the data set changes", so a new range/filter
//     never strands the viewer mid-scroll in a different result set.
//
// The visible-window math stays per-list, since the two differ (fixed-height
// activity rows vs. variable-height commit rows with date separators and
// expandable bodies). Anything extra a list needs to read off the scroll
// container on resize — the commit list derives its row-body height from the
// container width — goes through `onMeasure`, which is called on every measure
// with the live element. `onMeasure` is held in a ref, so callers may pass an
// inline closure without re-subscribing the observer.
export function useListViewport<T extends HTMLElement = HTMLDivElement>({
  defaultViewportPx,
  resetKey,
  onMeasure,
}: {
  defaultViewportPx: number;
  // Identity change => the result set changed => scroll back to the top and
  // re-measure (a list that was empty only mounts its scroll container now).
  resetKey: unknown;
  onMeasure?: (el: T) => void;
}) {
  const listRef = useRef<T | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(defaultViewportPx);

  const resetScroll = useCallback(() => {
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, []);

  useEffect(() => {
    resetScroll();
  }, [resetKey, resetScroll]);

  const onMeasureRef = useRef(onMeasure);
  onMeasureRef.current = onMeasure;

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;

    const updateHeight = () => {
      setViewportHeight(el.clientHeight || defaultViewportPx);
      onMeasureRef.current?.(el);
    };
    updateHeight();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateHeight);
      return () => window.removeEventListener("resize", updateHeight);
    }

    const resizeObserver = new ResizeObserver(updateHeight);
    resizeObserver.observe(el);
    return () => resizeObserver.disconnect();
    // `resetKey` re-runs the effect when the data set changes, so a list that
    // first renders empty (no scroll container) starts observing once it mounts.
  }, [resetKey, defaultViewportPx]);

  const handleScroll = useCallback(
    (event: UIEvent<T>) => setScrollTop(event.currentTarget.scrollTop),
    [],
  );

  return { listRef, scrollTop, viewportHeight, resetScroll, handleScroll };
}
