import assert from "node:assert/strict";
import test from "node:test";
import { clampContentPaneHeight, contentPaneBottomGutter, parseSafeAreaInsetPx } from "../src/pane-height.ts";
import { CONTENT_PANE_MIN_HEIGHT_PX } from "../src/layout-tier.ts";

test("a content pane fills the space below the chrome when there is room for one", () => {
  // Tall window: plenty of room below the split, the floor is comfortably met.
  assert.equal(clampContentPaneHeight(1000, 200, 16, 320), 784);
  // Exactly at the floor still fills — the floor is a lower bound, not a target.
  assert.equal(clampContentPaneHeight(1000, 664, 16, 320), 320);
});

test("a pane that would be squeezed below the floor takes the floor and lets the document scroll", () => {
  // The regression: a foldable's inner screen (933x704 CSS px) clears every
  // width breakpoint, so it renders the full desktop chrome. ~595px of chrome
  // above the split left 93px of pane — and because a pane always ended exactly
  // at the viewport bottom, the document had nothing to scroll either, so the
  // feed was unreachable. Taking the floor pushes the page past the viewport,
  // which is what gives the viewer something to scroll.
  assert.equal(clampContentPaneHeight(704, 595, 16, 320), 320);
  assert.ok(595 + clampContentPaneHeight(704, 595, 16, 320) > 704, "the document must outgrow the viewport so it can scroll");
  // Deeply starved: still the floor, never a sliver.
  assert.equal(clampContentPaneHeight(480, 300, 16, 320), 320);
});

test("the floor never exceeds the viewport itself, and a pane below the fold never goes negative", () => {
  // A viewport shorter than the floor: cap at what the viewport can show, so a
  // tiny window does not get a pane taller than the screen.
  assert.equal(clampContentPaneHeight(240, 200, 16, 320), 224);
  // Degenerate: the split already sits past the viewport bottom.
  assert.equal(clampContentPaneHeight(300, 320, 16, 320), 284);
  assert.equal(clampContentPaneHeight(0, 320, 16, 320), 0);
});

test("the bottom gutter absorbs the Android navigation-bar inset", () => {
  // Edge-to-edge Android fills the WebView to the screen edges and paints an
  // opaque scrim over the system bars (body::after). A pane measured against the
  // raw innerHeight ran its last rows under that scrim; folding the inset into
  // the gutter keeps the pane above it.
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

test("the shared floor is the one the layout tiers publish", () => {
  assert.equal(CONTENT_PANE_MIN_HEIGHT_PX, 240);
  assert.equal(clampContentPaneHeight(704, 595, 16), CONTENT_PANE_MIN_HEIGHT_PX, "the floor is the default minimum");
  // Two whole rows at the default preview length (114px row + 6px gap).
  assert.ok(CONTENT_PANE_MIN_HEIGHT_PX >= 2 * 120 - 6, "the floor should clear two default rows");
});
