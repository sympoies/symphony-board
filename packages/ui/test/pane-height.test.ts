import assert from "node:assert/strict";
import test from "node:test";
import {
  clampContentPaneHeight,
  contentPaneBottomGutter,
  paneDocumentTop,
  parseSafeAreaInsetPx,
  readSafeAreaBottomPx,
} from "../src/pane-height.ts";
import { CONTENT_PANE_MIN_HEIGHT_PX } from "../src/layout-tier.ts";

const FLOOR = CONTENT_PANE_MIN_HEIGHT_PX;

test("a content pane fills the space below the chrome when there is room for one", () => {
  // Tall window: plenty of room below the split, the floor is comfortably met.
  assert.equal(clampContentPaneHeight(1000, 200, 16, FLOOR), 784);
  // Exactly at the floor still fills — the floor is a lower bound, not a target.
  assert.equal(clampContentPaneHeight(1000, 1000 - 16 - FLOOR, 16, FLOOR), FLOOR);
});

test("the floor engages the moment one more pixel would be lost, not before", () => {
  // Pin the comparison operator: one pixel above the floor still FILLS (so the
  // document stays exactly viewport-height and no scrollbar appears), one pixel
  // below takes the floor and hands scrolling to the document. A `>` / `>=` slip
  // shows up here and nowhere else.
  const fills = clampContentPaneHeight(1000, 1000 - 16 - FLOOR - 1, 16, FLOOR);
  assert.equal(fills, FLOOR + 1, "available === floor + 1 must fill, not clamp");
  const floors = clampContentPaneHeight(1000, 1000 - 16 - FLOOR + 1, 16, FLOOR);
  assert.equal(floors, FLOOR, "available === floor - 1 must take the floor");
});

test("a pane that would be squeezed below the floor takes the floor and lets the document scroll", () => {
  // The regression: a foldable's inner screen (933x704 CSS px) clears every width
  // breakpoint, so it renders the full desktop chrome. ~595px of chrome above the
  // split left ~93px of pane — and because a pane always ended exactly at the
  // viewport bottom, the document had nothing to scroll either, so the feed was
  // unreachable. Taking the floor pushes the page past the viewport, which is what
  // gives the viewer something to scroll.
  assert.equal(clampContentPaneHeight(704, 595, 16, FLOOR), FLOOR);
  assert.ok(595 + clampContentPaneHeight(704, 595, 16, FLOOR) > 704, "the document must outgrow the viewport so it can scroll");
  // Deeply starved: still the floor, never a sliver.
  assert.equal(clampContentPaneHeight(480, 300, 16, FLOOR), FLOOR);
});

test("the floor never exceeds the viewport itself, and a pane below the fold never goes negative", () => {
  // The crossover: once `innerHeight - gutter` drops under the floor, the viewport
  // cap is what wins, so the pane can never be taller than the screen showing it.
  assert.equal(clampContentPaneHeight(FLOOR + 16, 100, 16, FLOOR), FLOOR, "exactly at the crossover the floor still fits");
  assert.equal(clampContentPaneHeight(FLOOR + 15, 100, 16, FLOOR), FLOOR - 1, "one pixel under it, the cap takes over");
  assert.equal(clampContentPaneHeight(240, 200, 16, 320), 224);
  // Degenerate: the split already sits past the viewport bottom.
  assert.equal(clampContentPaneHeight(300, 320, 16, 320), 284);
  assert.equal(clampContentPaneHeight(0, 320, 16, 320), 0);
});

test("a pane keeps one height no matter where the viewer has scrolled", () => {
  // This is the property that makes the floor safe: once the document can scroll,
  // a viewport-relative `rect.top` shrinks as the page moves, so re-measuring
  // would grow the pane on every scroll tick — and LivePage re-measures on every
  // arriving event. Measuring from the DOCUMENT top is scroll-invariant.
  const atRest = clampContentPaneHeight(704, paneDocumentTop(595, 0), 16, FLOOR);
  for (const scrollY of [1, 137, 595, 5000]) {
    assert.equal(
      clampContentPaneHeight(704, paneDocumentTop(595 - scrollY, scrollY), 16, FLOOR),
      atRest,
      `scrolled by ${scrollY}, the pane must not resize`,
    );
  }
  assert.equal(paneDocumentTop(100, 250), 350);
  // A host without a usable scroll position degrades to the viewport-relative top
  // rather than poisoning the arithmetic with NaN.
  assert.equal(paneDocumentTop(100, Number.NaN), 100);
  assert.equal(paneDocumentTop(100, Number.POSITIVE_INFINITY), 100);
});

test("the bottom gutter absorbs the Android navigation-bar inset", () => {
  // Edge-to-edge Android fills the WebView to the screen edges and paints an
  // opaque scrim over the system bars (body::after). A pane measured against the
  // raw innerHeight ran its last rows under that scrim; folding the inset into the
  // gutter keeps the pane above it.
  assert.equal(contentPaneBottomGutter(16, 48), 64);
  assert.equal(contentPaneBottomGutter(16, 0), 16);
  // Browser / desktop: the bridge never set the variable, so it resolves to 0.
  assert.equal(contentPaneBottomGutter(16, Number.NaN), 16);
  assert.equal(contentPaneBottomGutter(16, -12), 16);
});

test("safe-area insets parse out of their CSS custom-property text", () => {
  assert.equal(parseSafeAreaInsetPx("48.00px"), 48);
  assert.equal(parseSafeAreaInsetPx(" 24px "), 24);
  assert.equal(parseSafeAreaInsetPx(""), 0);
  assert.equal(parseSafeAreaInsetPx("auto"), 0);
});

test("reading the inset off the document survives every host that cannot answer", () => {
  // The parser above is pure text; this covers the DOM read itself — the element
  // it targets, the guard, and the try/catch. Without it a typo'd property name or
  // a wrong element silently reverts the navigation-bar clearance with the suite
  // green.
  const root = {} as unknown as HTMLElement;
  const win = (getComputedStyle: unknown) =>
    ({ document: { documentElement: root }, getComputedStyle } as unknown as Window);

  let asked: string | undefined;
  const live = win((el: unknown) => {
    assert.equal(el, root, "the inset lives on the document element, not the body");
    return { getPropertyValue: (name: string) => ((asked = name) === "--android-safe-area-bottom" ? "48.00px" : "") };
  });
  assert.equal(readSafeAreaBottomPx(live), 48);
  assert.equal(asked, "--android-safe-area-bottom");

  assert.equal(readSafeAreaBottomPx(undefined), 0, "no window (SSR)");
  assert.equal(readSafeAreaBottomPx({} as Window), 0, "no document");
  assert.equal(readSafeAreaBottomPx({ document: { documentElement: root } } as unknown as Window), 0, "no getComputedStyle");
  assert.equal(
    readSafeAreaBottomPx(win(() => { throw new Error("unsupported"); })),
    0,
    "a host that throws must degrade to no inset, not crash the measurement",
  );
});

test("the shared floor is the one the layout tiers publish", () => {
  // Two whole rows at the default two-line preview (114px row + 6px gap), and
  // deliberately below what an ordinary 1280x900 desktop leaves over (~312px), so
  // the no-scroll dashboard survives where it already worked.
  assert.equal(CONTENT_PANE_MIN_HEIGHT_PX, 240);
  assert.ok(CONTENT_PANE_MIN_HEIGHT_PX >= 2 * 120 - 6, "the floor should clear two default rows");
  assert.ok(CONTENT_PANE_MIN_HEIGHT_PX < 312, "the floor must not engage on an ordinary desktop");
  assert.equal(clampContentPaneHeight(704, 595, 16), CONTENT_PANE_MIN_HEIGHT_PX, "the floor is the default minimum");
});
