import { useLayoutEffect, useRef } from "react";

const NESTED_DETAIL_SCROLL_SELECTOR = "[data-detail-scroll]";

export function resetDetailScroll(root: HTMLElement | null): void {
  if (!root) return;
  root.scrollTop = 0;
  for (const scroller of root.querySelectorAll<HTMLElement>(NESTED_DETAIL_SCROLL_SELECTOR)) {
    scroller.scrollTop = 0;
  }
}

export function useDetailScrollReset<T extends HTMLElement>(identity: string | null) {
  const rootRef = useRef<T>(null);

  useLayoutEffect(() => {
    resetDetailScroll(rootRef.current);
  }, [identity]);

  return rootRef;
}
