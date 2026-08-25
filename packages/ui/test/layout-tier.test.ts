import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  COMPACT_CHROME_QUERY,
  CONTENT_PANE_MIN_HEIGHT_PX,
  DETAIL_OVERLAY_QUERY,
  NARROW_MAX_WIDTH_PX,
  NARROW_VIEWPORT_QUERY,
  SHORT_MAX_HEIGHT_PX,
  SHORT_VIEWPORT_QUERY,
  SPLIT_MAX_WIDTH_PX,
} from "../src/layout-tier.ts";
import { isShortViewport, matchesViewportQuery } from "../src/useMediaQuery.ts";

const stylesSource = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
// Comments are stripped before any brace counting: this stylesheet is heavily
// commented, and a single `{` inside a comment would silently truncate an
// extracted block and turn the assertions below vacuous.
const styles = stylesSource.replace(/\/\*[\s\S]*?\*\//g, "");

// Pull a tier's `@media <header> { ... }` blocks out by counting braces, so an
// assertion can say "this rule lives in THAT tier" rather than just "it exists
// somewhere". A tier may be split across several blocks (the narrow tier is), so
// every block with the same header is concatenated.
function mediaBlock(header: string): string {
  const opener = `@media ${header} {`;
  const blocks: string[] = [];
  for (let start = styles.indexOf(opener); start !== -1; start = styles.indexOf(opener, start + 1)) {
    let depth = 0;
    for (let i = start + opener.length - 1; i < styles.length; i += 1) {
      if (styles[i] === "{") depth += 1;
      else if (styles[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          blocks.push(styles.slice(start, i + 1));
          break;
        }
      }
    }
    if (blocks.length === 0) throw new Error(`unterminated "@media ${header}" block`);
  }
  assert.notEqual(blocks.length, 0, `styles.css is missing the "@media ${header}" block`);
  return blocks.join("\n");
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
  // And the reach nobody expected: a maximized browser on a 1366x768 laptop is
  // ~640-660px tall, so mainstream laptops are in this tier too. Deliberate — it
  // is where the Live feed went from a ~90px sliver to a full pane.
  assert.ok(660 <= SHORT_MAX_HEIGHT_PX, "a 768p laptop viewport is short");
});

test("styles.css mirrors the tier breakpoints", () => {
  assert.ok(styles.includes(`@media ${COMPACT_CHROME_QUERY} {`), "the compact-chrome tier block must use the shared query verbatim");
  assert.ok(styles.includes(`@media ${NARROW_VIEWPORT_QUERY} {`), "the narrow tier keeps its width-only block");
  assert.ok(styles.includes(`@media ${DETAIL_OVERLAY_QUERY} {`), "the master-detail overlay stays width-only");
});

// A tier may reveal a disclosure ONLY if it also reveals what that disclosure
// opens. The Commits filters broke this: their button was revealed here while the
// phone sheet it opens — and the inline toolbar it replaces — stayed narrow-only,
// so a short-but-wide viewport gained ~42px of dead chrome instead of height.
test("every disclosure the compact tier reveals has its collapse target in the same tier", () => {
  const compact = mediaBlock(COMPACT_CHROME_QUERY);

  const revealed = (compact.match(/([^{}]+)\{\s*display:\s*inline-flex;\s*\}/) ?? [, ""])[1]
    .split(",")
    .map((selector) => selector.trim())
    .filter(Boolean)
    .sort();
  assert.deepEqual(
    revealed,
    [".live-pulse-disclosure", ".repo-stats-disclosure", ".stats-disclosure"],
    "the reveal group is the exact set of strips this tier can also collapse — adding one without its surface is the defect this asserts",
  );

  // Each revealed disclosure, paired with the rule that hides what it summarizes.
  const pairs: ReadonlyArray<readonly [string, RegExp]> = [
    [".live-pulse-disclosure", /\.live-pulse\[data-open="false"\]\s*{\s*display:\s*none;\s*}/],
    [".stats-disclosure", /\.stats-body\[data-stats-collapsed="true"\]\s*{\s*display:\s*none;\s*}/],
    [".repo-stats-disclosure", /\.repo-stat-grid\[data-stats-collapsed="true"\]\s*{\s*display:\s*none;\s*}/],
  ];
  for (const [disclosure, collapse] of pairs) {
    assert.ok(revealed.includes(disclosure), `${disclosure} must be revealed in the compact tier`);
    assert.match(compact, collapse, `${disclosure} must be able to collapse its own surface in the compact tier`);
  }

  // The horizontal collapses stay narrow-only: their expanded state is a fixed
  // phone sheet, and the inline controls they replace are hidden only there.
  for (const narrowOnly of [".commits-filter-disclosure", ".range-disclosure", ".search-disclosure", ".filter-disclosure"]) {
    assert.ok(!compact.includes(narrowOnly), `${narrowOnly} collapses for horizontal room and must stay narrow-only`);
  }
  assert.ok(mediaBlock(NARROW_VIEWPORT_QUERY).includes(".commits-filter-disclosure"), "the Commits filters disclosure belongs to the narrow tier, where its sheet exists");
});

test("dead rules do not ride along in a tier", () => {
  // `[data-filters-collapsed]` was never set by any component; relocating it under
  // an authoritative comment would make the next reader trust a mechanism that is
  // not there.
  assert.ok(!styles.includes("data-filters-collapsed"), "no rule may key on an attribute nothing sets");
});

test("content panes size against the dynamic viewport on every axis of the cascade", () => {
  // Two rules, and the second is the one that was missing: it is not enough for
  // the custom-property FALLBACKS to use dvh, because the rules that actually win
  // in the 761-1180px band used to carry bare `vh` and no custom property at all,
  // so Board and Graph silently opted out of the shared clamp at the very width
  // this change was written for.
  const paneFallbacks = styles.match(/var\(--(?:content-pane|live-pane)-height,[^)]*\)/g) ?? [];
  assert.ok(paneFallbacks.length > 0, "expected content panes to size off the shared custom properties");
  for (const fallback of paneFallbacks) {
    assert.doesNotMatch(fallback, /\d(?:vh|svh|lvh)\b/, `pane fallback should use dvh: ${fallback}`);
  }

  // No pane-sizing declaration anywhere may use a static viewport unit. The only
  // survivors are the `height: 100vh; height: 100dvh;` progressive-enhancement
  // pairs on full-screen fixed overlays, and the fixed phone sheets — neither is
  // a measured content pane.
  const paneSelectors = [".col", ".graph-list", ".graph-canvas", ".items-list", ".items-detail", ".live-feed", ".live-detail", ".activity-list", ".commit-list"];
  for (const selector of paneSelectors) {
    const rules = styles.match(new RegExp(`\\${selector}\\s*{[^}]*}`, "g")) ?? [];
    for (const rule of rules) {
      const sizing = rule.match(/(?:max-|min-)?height:[^;]*/g) ?? [];
      for (const declaration of sizing) {
        if (/100vh/.test(declaration)) continue; // paired with 100dvh on the next line
        assert.doesNotMatch(declaration, /\d+(?:vh|svh|lvh)\b/, `${selector} sizes a pane with a static viewport unit: ${declaration.trim()}`);
      }
    }
  }
});

test("the viewport probe reads the HEIGHT axis, and stays SSR-safe", () => {
  // The stub echoes its query: without that, swapping isShortViewport to probe the
  // NARROW query passes — and that mutation is the original bug, since a 933x704
  // foldable is short but not narrow.
  const stub = (matches: (query: string) => boolean) => ({ matchMedia: (query: string) => ({ matches: matches(query) }) }) as unknown as Window;
  let asked: string | undefined;
  isShortViewport(stub((query) => { asked = query; return true; }));
  assert.equal(asked, SHORT_VIEWPORT_QUERY, "isShortViewport must probe the height axis");
  assert.equal(isShortViewport(stub((query) => query === SHORT_VIEWPORT_QUERY)), true);
  assert.equal(isShortViewport(stub((query) => query === NARROW_VIEWPORT_QUERY)), false, "a narrow-only match must not read as short");

  // `undefined` selects the parameter default, which resolves to globalThis.window
  // — absent under `node --test`, so this asserts the SSR path via the ambient
  // environment. It would begin exercising a different path if a DOM global were
  // ever introduced into the UI test setup.
  assert.equal(matchesViewportQuery(SHORT_VIEWPORT_QUERY, undefined), false);
  assert.equal(matchesViewportQuery(SHORT_VIEWPORT_QUERY, {} as Window), false);
  assert.equal(
    isShortViewport({ matchMedia: () => { throw new Error("unsupported"); } } as unknown as Window),
    false,
    "a host that throws on matchMedia must fall back to the roomy default",
  );
});

test("the pane floor is published once and consumed everywhere", () => {
  assert.equal(CONTENT_PANE_MIN_HEIGHT_PX, 240);
  // No page may re-fork the floor or the breakpoints behind a local alias.
  for (const source of ["../src/components/LivePage.tsx", "../src/components/ReviewsPage.tsx", "../src/components/ItemsPage.tsx"]) {
    const text = readFileSync(new URL(source, import.meta.url), "utf8");
    assert.doesNotMatch(text, /_PANE_MIN_HEIGHT_PX\s*=/, `${source} must use the shared floor, not a local copy`);
    assert.doesNotMatch(text, /_DETAIL_OVERLAY_QUERY\s*=/, `${source} must use the shared breakpoint, not a local copy`);
  }
});
