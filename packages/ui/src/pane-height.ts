import { CONTENT_PANE_MIN_HEIGHT_PX } from "./layout-tier.ts";

// Shared content panes fill the viewport below their split/header while keeping
// a small bottom gutter.
//
// `paneTop` is the pane's offset from the DOCUMENT top, not from the viewport:
// once the floor below lets the page scroll, a viewport-relative measurement
// would re-shrink the pane on every scroll tick and the height would jitter.
//
// `min` is a real floor, not a target. It used to be a soft hint — a short
// viewport just took whatever was left, on the reasoning that forcing the
// minimum "reintroduces document-level scrolling". It does, and that turned out
// to be the point: because a pane always ends at the viewport bottom, the
// document is exactly viewport-height and has nothing to scroll. A viewport with
// tall chrome above the pane (a foldable's inner screen at 933x704 CSS px left
// ~93px) was left with a sliver AND no way to scroll to the rest. Taking the
// floor pushes the document past the viewport, which is what restores scrolling.
// The floor is still capped by the viewport itself, so a pane is never taller
// than the screen that has to show it.
export function clampContentPaneHeight(
  innerHeight: number,
  paneTop: number,
  bottomGutter: number,
  min: number = CONTENT_PANE_MIN_HEIGHT_PX,
): number {
  const available = Math.floor(innerHeight - paneTop - bottomGutter);
  if (available >= min) return available;
  return Math.max(0, Math.min(min, Math.floor(innerHeight - bottomGutter)));
}

// Edge-to-edge Android (targetSdk >= 35) runs the WebView to the screen edges and
// paints opaque scrims over the system-bar regions (body::before / ::after). A
// pane measured against the raw `innerHeight` therefore ran its last rows under
// the navigation bar. Folding the bottom inset into the gutter keeps the pane
// above it; the inset resolves to 0 in the browser and on desktop, where this is
// the plain base gutter.
export function contentPaneBottomGutter(baseGutter: number, safeAreaBottom: number): number {
  return baseGutter + (Number.isFinite(safeAreaBottom) ? Math.max(0, safeAreaBottom) : 0);
}

// `--android-safe-area-bottom` is written as a px string by the insets bridge
// (runtime.ts) and is simply unset off Android, where getPropertyValue returns "".
export function parseSafeAreaInsetPx(raw: string): number {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

// Read one resolved safe-area inset off the document element. Returns 0 for any
// host that cannot answer (SSR, a stubbed window in tests), so a caller always
// gets a usable gutter.
export function readSafeAreaBottomPx(target: Window | undefined = typeof window === "undefined" ? undefined : window): number {
  const root = target?.document?.documentElement;
  if (!root || typeof target?.getComputedStyle !== "function") return 0;
  try {
    return parseSafeAreaInsetPx(target.getComputedStyle(root).getPropertyValue("--android-safe-area-bottom"));
  } catch {
    return 0;
  }
}

// The pane's document-relative top: viewport-relative rect plus the current page
// scroll, so the measurement is stable no matter where the viewer has scrolled.
export function paneDocumentTop(viewportTop: number, scrollY: number): number {
  return viewportTop + (Number.isFinite(scrollY) ? scrollY : 0);
}
