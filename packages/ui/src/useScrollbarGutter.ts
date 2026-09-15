import { useEffect, useState, type RefObject } from "react";

// The width a scroller reserves for its scrollbar INSIDE its own box.
//
// It exists because a pane's grid gap is not the gap a reader sees. The bar is
// reserved inside the track (`scrollbar-gutter: stable`, or plain overflow), so
// the last pixel the pane paints stops short of its own track edge and the
// whitespace beside it reads wider than the gap that produced it -- 22px beside
// the Live feed against the 12px every other pane on the page uses. The
// stylesheet pulls that reservation back out with a negative margin, and this is
// where the number comes from.
//
// Measured rather than assumed: the width is the UA's call -- 10px in Chrome for
// the thin bar these scrollers ask for, 8 in the macOS WebView, ~15 for a
// classic bar -- so a constant in the stylesheet would be wrong on some of them.
//
// offsetWidth counts the gutter and clientWidth does not, so the difference is
// exactly it, PROVIDED the element has no horizontal border (offsetWidth would
// fold that in too). None of the scrollers using this declare one; a list that
// grows a border must subtract it here rather than pull its neighbour closer.
//
// EVERY caller must pass a dep that flips when its scroller mounts. These
// lists all render something else while they have no rows (an empty state,
// "Connecting..."), so the element this measures does not exist on the first
// render. Without that dep the effect runs once against a null ref, never
// measures, and the pane keeps the very gap this exists to close -- silently,
// because the page looks right again as soon as anything else re-renders it.
// `deps` is spread into a dependency array, so a caller must pass the same
// NUMBER of deps on every render.
export function useScrollbarGutter<T extends HTMLElement>(
  ref: RefObject<T | null>,
  deps: readonly unknown[] = [],
): number {
  const [scrollbarPx, setScrollbarPx] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    // Bails on an unchanged value, so the resize this measurement itself causes
    // (the negative margin widens the element) settles in one extra delivery
    // instead of looping. Safe because the bar's width does not depend on the
    // element's width: these lists size their scroll height from their row
    // count, so widening one can never toggle the bar on or off.
    const measure = () =>
      setScrollbarPx((current) => {
        const next = Math.max(0, Math.round(el.offsetWidth - el.clientWidth));
        return current === next ? current : next;
      });

    measure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
    // See the contract above: this is what re-runs the measurement for a list
    // that mounts its scroll container late.
  }, [ref, ...deps]);

  return scrollbarPx;
}
