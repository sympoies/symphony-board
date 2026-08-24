import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  COMPACT_CHROME_QUERY,
  DETAIL_OVERLAY_QUERY,
  NARROW_MAX_WIDTH_PX,
  NARROW_VIEWPORT_QUERY,
  SHORT_MAX_HEIGHT_PX,
  SHORT_VIEWPORT_QUERY,
  SPLIT_MAX_WIDTH_PX,
} from "../src/layout-tier.ts";
import { isShortViewport, matchesViewportQuery } from "../src/useMediaQuery.ts";

const stylesSource = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

// Pull one `@media <header> { ... }` block out of the stylesheet by counting
// braces, so an assertion can say "this rule lives in THAT tier" rather than
// just "this rule exists somewhere".
function mediaBlock(header: string): string {
  const opener = `@media ${header} {`;
  const start = stylesSource.indexOf(opener);
  assert.notEqual(start, -1, `styles.css is missing the "@media ${header}" block`);
  let depth = 0;
  for (let i = start + opener.length - 1; i < stylesSource.length; i += 1) {
    if (stylesSource[i] === "{") depth += 1;
    else if (stylesSource[i] === "}") {
      depth -= 1;
      if (depth === 0) return stylesSource.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated "@media ${header}" block`);
}

test("the layout tiers read on both viewport axes", () => {
  assert.equal(NARROW_VIEWPORT_QUERY, "(max-width: 760px)");
  assert.equal(SHORT_VIEWPORT_QUERY, "(max-height: 760px)");
  // A comma in a media query list is an OR: narrow OR short gets compact chrome.
  assert.equal(COMPACT_CHROME_QUERY, "(max-width: 760px), (max-height: 760px)");
  assert.equal(DETAIL_OVERLAY_QUERY, "(max-width: 900px)");
  // The foldable inner screen that motivated the tier: wide enough for the
  // two-pane split, far too short for the full desktop chrome above it.
  assert.ok(933 > SPLIT_MAX_WIDTH_PX, "the foldable clears the split breakpoint on width");
  assert.ok(933 > NARROW_MAX_WIDTH_PX, "...and is not narrow");
  assert.ok(704 <= SHORT_MAX_HEIGHT_PX, "...but is short, so it must get compact chrome");
});

test("styles.css mirrors the tier breakpoints", () => {
  assert.ok(stylesSource.includes(`@media ${COMPACT_CHROME_QUERY} {`), "the compact-chrome tier block must use the shared query verbatim");
  assert.ok(stylesSource.includes(`@media ${NARROW_VIEWPORT_QUERY} {`), "the narrow tier keeps its width-only block");
  assert.ok(stylesSource.includes(`@media ${DETAIL_OVERLAY_QUERY} {`), "the master-detail overlay stays width-only");
});

test("the vertical chrome folds in the compact tier, not only on a phone", () => {
  const compact = mediaBlock(COMPACT_CHROME_QUERY);
  // The strips that own the vertical space above a content pane.
  assert.match(compact, /\.live-pulse\[data-open="false"\]\s*{\s*display:\s*none;\s*}/, "the Live metric strip must be collapsible when short");
  assert.match(compact, /\.stats-body\[data-stats-collapsed="true"\]\s*{\s*display:\s*none;\s*}/, "the stats bar must be collapsible when short");
  // ...and the disclosures that reveal them again.
  for (const disclosure of [".live-pulse-disclosure", ".stats-disclosure", ".repo-stats-disclosure", ".commits-filter-disclosure"]) {
    assert.ok(compact.includes(disclosure), `${disclosure} must be reachable in the compact tier`);
  }
});

test("content panes size against the dynamic viewport, so a collapsing mobile toolbar cannot strand them", () => {
  // The JS measurement wins in practice (it sets --content-pane-height /
  // --live-pane-height); these fallbacks are what paints before it lands, so a
  // static `vh` there overshoots on a phone whose toolbar is still expanded.
  const paneFallbacks = stylesSource.match(/var\(--(?:content-pane|live-pane)-height,[^)]*\)/g) ?? [];
  assert.ok(paneFallbacks.length > 0, "expected content panes to size off the shared custom properties");
  for (const fallback of paneFallbacks) {
    assert.doesNotMatch(fallback, /\d(?:vh|svh|lvh)\b/, `pane fallback should use dvh: ${fallback}`);
  }
});

test("viewport probes stay SSR-safe", () => {
  assert.equal(matchesViewportQuery(SHORT_VIEWPORT_QUERY, undefined), false);
  assert.equal(matchesViewportQuery(SHORT_VIEWPORT_QUERY, {} as Window), false);
  assert.equal(isShortViewport({ matchMedia: () => ({ matches: true }) } as unknown as Window), true);
  assert.equal(isShortViewport({ matchMedia: () => ({ matches: false }) } as unknown as Window), false);
  assert.equal(
    isShortViewport({ matchMedia: () => { throw new Error("unsupported"); } } as unknown as Window),
    false,
    "a host that throws on matchMedia must fall back to the roomy default",
  );
});
