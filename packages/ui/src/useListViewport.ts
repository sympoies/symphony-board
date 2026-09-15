import { useCallback, useEffect, useRef, useState, type UIEvent } from "react";

// Shared scroll/viewport plumbing for the virtualized lists (the Activity feed
// and the Commit timeline). It owns what both lists read off their scroll
// container -- the first, second and fourth of these were copy-pasted in each:
//   - the live scroll position,
//   - the measured viewport height (ResizeObserver, with a window-resize
//     fallback for environments without it),
//   - the width the scrollbar reserves inside the container, which the
//     stylesheet needs to keep the gap BESIDE a list equal to every other pane
//     gap, and
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
  // offsetWidth counts the scrollbar gutter, clientWidth does not, so the
  // difference is the gutter -- PROVIDED the container has no horizontal border,
  // which offsetWidth would fold in on top of it. Neither list declares one, and
  // the value is consumed as a negative margin, so a list that grows a border
  // must subtract it here rather than pull its neighbour's pane 2px closer.
  // Measured rather than assumed because the gutter's width is
  // the UA's call — 10px in Chrome for the thin bar these scrollers ask for, 8
  // in the macOS WebView — and a stylesheet that guessed would be wrong on one
  // of them. Both virtualized lists size their scroll height from the row count
  // rather than from their width, so widening one can never toggle the bar and
  // start a measure loop.
  const [scrollbarPx, setScrollbarPx] = useState(0);

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
      setScrollbarPx(Math.max(0, Math.round(el.offsetWidth - el.clientWidth)));
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

  return { listRef, scrollTop, viewportHeight, scrollbarPx, resetScroll, handleScroll };
}
