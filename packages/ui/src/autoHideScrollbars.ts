// Auto-hiding scrollbars. The scrollbars are styled transparent at rest (see the
// `:where(html, body, …)::-webkit-scrollbar-*` rules in styles.css) and only paint
// while their scroller carries `data-scrolling="true"`. A single capture-phase
// `scroll` listener on `window` catches both the viewport scroll (event target is
// `document`) and every inner scroller (`.activity-list`, `.col-cards`, …), flags
// the scrolled element, and clears the flag a short idle later so the bar fades
// back out — the macOS overlay behavior, but driven by us so it is consistent
// across the desktop WebView, the web build, and the Android WebView regardless of
// the OS "show scroll bars" setting.

const IDLE_HIDE_MS = 1400;

export function setupAutoHideScrollbars(): () => void {
  if (typeof window === "undefined") return () => {};

  const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

  const onScroll = (event: Event) => {
    const target = event.target;
    // Viewport scroll fires with `document` as the target; map it to the root
    // element whose scrollbar the page actually shows. Inner scrollers are the
    // element itself.
    const el =
      target instanceof Element
        ? target
        : target instanceof Document
          ? target.documentElement
          : null;
    if (!el) return;

    el.setAttribute("data-scrolling", "true");
    const prev = timers.get(el);
    if (prev) clearTimeout(prev);
    timers.set(
      el,
      setTimeout(() => {
        el.removeAttribute("data-scrolling");
        timers.delete(el);
      }, IDLE_HIDE_MS),
    );
  };

  window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => window.removeEventListener("scroll", onScroll, { capture: true });
}
