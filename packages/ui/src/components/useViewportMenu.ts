import { useLayoutEffect, useRef } from "react";

/** Keep a label-anchored menu inside the viewport while it is open. */
export function useViewportMenu(open: boolean, content: unknown) {
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!open || !menu) return;
    const fit = () => {
      // Reset before measuring so scroll/resize corrections never accumulate.
      const viewport = document.documentElement.clientWidth;
      menu.style.setProperty("--viewport-menu-max-width", `${Math.max(0, viewport - 16)}px`);
      menu.style.setProperty("--viewport-menu-shift", "0px");
      // Nested Live destination disclosures flow inside the checkbox menu.
      if (getComputedStyle(menu).position === "static") return;
      const rect = menu.getBoundingClientRect();
      const left = Math.max(8, Math.min(rect.left, viewport - 8 - rect.width));
      menu.style.setProperty("--viewport-menu-shift", `${left - rect.left}px`);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(menu);
    // Opening a panel can introduce a scrollbar without resizing the window.
    observer.observe(document.documentElement);
    window.addEventListener("resize", fit);
    window.addEventListener("scroll", fit, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
      window.removeEventListener("scroll", fit, true);
    };
  }, [open, content]);
  return menuRef;
}
