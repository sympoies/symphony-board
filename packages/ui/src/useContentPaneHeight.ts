import { useCallback, useLayoutEffect, useState, type CSSProperties, type RefCallback } from "react";
import { clampContentPaneHeight, contentPaneBottomGutter, paneDocumentTop, readSafeAreaBottomPx } from "./pane-height.ts";
import { CONTENT_PANE_MIN_HEIGHT_PX } from "./layout-tier.ts";

type PaneHeightStyle = CSSProperties & { "--content-pane-height"?: string };

export function useContentPaneHeight<T extends HTMLElement>(
  deps: readonly unknown[] = [],
  { bottomGutter = 16, min = CONTENT_PANE_MIN_HEIGHT_PX }: { bottomGutter?: number; min?: number } = {},
): { paneRef: RefCallback<T>; paneHeightStyle: PaneHeightStyle | undefined } {
  const [node, setNode] = useState<T | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const paneRef = useCallback((next: T | null) => setNode(next), []);

  useLayoutEffect(() => {
    if (!node || typeof window === "undefined") return undefined;

    let frame = 0;
    const measure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const rect = node.getBoundingClientRect();
        // Document-relative top + an inset-aware gutter: the pane keeps one
        // height whether or not the page is scrolled, and stays clear of the
        // Android navigation bar. See pane-height.ts.
        const next = clampContentPaneHeight(
          window.innerHeight,
          paneDocumentTop(rect.top, window.scrollY),
          contentPaneBottomGutter(bottomGutter, readSafeAreaBottomPx(window)),
          min,
        );
        setHeight((current) => (current === next ? current : next));
      });
    };

    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    observer?.observe(document.body);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [node, bottomGutter, min, ...deps]);

  return {
    paneRef,
    paneHeightStyle: height == null ? undefined : ({ "--content-pane-height": `${height}px` } as PaneHeightStyle),
  };
}
