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
  WIDE_RAIL_MIN_WIDTH_PX,
  WIDE_RAIL_QUERY,
  RAIL_ROWS_MIN_WIDTH_PX,
  RAIL_ROWS_QUERY,
  RAIL_RANK_LIMIT,
  RAIL_RANK_LIMIT_ROWS,
  SPLIT_RAIL_MIN_WIDTH_PX,
  SPLIT_STACK_QUERY,
} from "../src/layout-tier.ts";
import { WIDE_VIEWPORT_WIDTH } from "../src/runtime.ts";
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
    [".repo-stats-disclosure", ".stats-disclosure"],
    "the reveal group is the exact set of strips this tier can also collapse — adding one without its surface is the defect this asserts",
  );
  // .live-pulse-disclosure is deliberately NOT here: it is revealed at every
  // size instead (see "the Live metric strip can always be collapsed"), because
  // it is the only control for a ~300px strip rather than a stand-in for one
  // shown inline. The pairing rule still binds it — its collapse rule sits at
  // the same top level as its reveal, which that test asserts.
  assert.ok(!revealed.includes(".live-pulse-disclosure"), "the metric strip is revealed globally, not by this tier");

  // Each revealed disclosure, paired with the rule that hides what it summarizes.
  const pairs: ReadonlyArray<readonly [string, RegExp]> = [
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

test("the Activity rail breakpoint is published once and mirrored in the stylesheet", () => {
  assert.equal(WIDE_RAIL_MIN_WIDTH_PX, 1700);
  assert.equal(WIDE_RAIL_QUERY, "(min-width: 1700px)");
  // The component gates on the constant and the grid gains its third column in
  // the stylesheet; if those two drift the rail renders into a two-column grid
  // (or a third column sits empty), which is exactly the class of bug the rest
  // of this file exists to prevent.
  const railTier = mediaBlock(WIDE_RAIL_QUERY);
  assert.match(railTier, /\.activity-layout\s*\{[^}]*grid-template-columns:[^}]*\}/, "the rail tier must widen .activity-layout to three columns");
  const columns = railTier.match(/grid-template-columns:([^;]+);/)?.[1] ?? "";
  assert.equal(columns.split("minmax").length - 1, 3, `the rail tier must declare three columns (got "${columns.trim()}")`);

  const page = readFileSync(new URL("../src/components/ActivityPage.tsx", import.meta.url), "utf8");
  assert.match(page, /WIDE_RAIL_QUERY/, "ActivityPage must gate the rail on the shared query, not a local copy");
  assert.doesNotMatch(page, /min-width:\s*\d+px/, "ActivityPage must not inline a breakpoint of its own");

  // The rail must be additive: below its breakpoint the page keeps the existing
  // two-column grid, so the narrow tiers cannot have been rewritten under it.
  assert.match(mediaBlock(SPLIT_STACK_QUERY), /\.activity-layout\s*\{[^}]*minmax\(0, 720px\)/);
});

test("Commits keeps a reading measure on its list, not on the page", () => {
  // The page cap moved to the list column when the digest rail arrived. If the
  // cap came back to .commits-page the rail would be squeezed out of the layout
  // while still rendering, so pin both halves of that swap.
  assert.doesNotMatch(styles, /\.commits-page\s*\{[^}]*max-width/, ".commits-page must no longer cap the whole page");
  assert.match(styles, /\.commits-split\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1180px\)/, "the commit list keeps its 1180px measure as a grid column");
});

test("the forced wide viewport clears every two-pane split breakpoint", () => {
  // Android's "wide layout" setting pins the WebView viewport to exactly
  // WIDE_VIEWPORT_WIDTH CSS px, whatever the panel is. A split that stacks above
  // that width therefore hands the foldable desktop chrome WITH mobile stacking,
  // which is the worst of both: on the Z Fold, Commits put its rail under the
  // list, and Activity capped its feed at 720px and left ~560px of dead gutter
  // beside it. Nothing else in the build compares the two numbers, so they drift
  // silently — this is the assertion that notices.
  assert.equal(WIDE_VIEWPORT_WIDTH, 1280);
  assert.ok(
    SPLIT_RAIL_MIN_WIDTH_PX <= WIDE_VIEWPORT_WIDTH,
    `a two-pane split must fit the forced wide viewport (needs ${SPLIT_RAIL_MIN_WIDTH_PX}px, gets ${WIDE_VIEWPORT_WIDTH}px)`,
  );

  // Sized from the Activity tracks rather than picked round: the feed's 640px
  // clamp floor, the overview's 560px floor, and one pane gap. Page padding is
  // not in it, so the feed dips under its preference for the first ~50px above
  // the floor -- measured 590px at 1212, and its full 640px by 1280.
  assert.equal(SPLIT_RAIL_MIN_WIDTH_PX, 1212);

  // Both pages must stack strictly BELOW the floor, so the forced width lands on
  // the side-by-side rule rather than one pixel into the stacked one.
  const stacked = mediaBlock(SPLIT_STACK_QUERY);
  assert.match(stacked, /\.activity-layout\s*\{[^}]*minmax\(0, 720px\)/, "Activity stacks below the split floor");
  assert.match(stacked, /\.commits-split\s*\{[^}]*minmax\(0, 1fr\)/, "Commits stacks below the split floor");
  assert.equal(SPLIT_STACK_QUERY, `(max-width: ${SPLIT_RAIL_MIN_WIDTH_PX - 1}px)`);

  // And no page may re-fork the number behind a local literal.
  for (const source of ["../src/components/ActivityPage.tsx", "../src/components/CommitsPage.tsx"]) {
    const text = readFileSync(new URL(source, import.meta.url), "utf8");
    assert.doesNotMatch(text, /max-width:\s*\d+px/, `${source} must not inline a split breakpoint`);
  }
});

test("the Activity overview absorbs slack below the rail tier", () => {
  // Between the split floor and the rail tier both Activity columns used to cap
  // (feed 720 + overview 680), so every width from ~1412px to the 1700px rail
  // breakpoint left a dead gutter — the same defect the page caps were removed
  // to fix, one level further in. The overview takes the remainder instead, which
  // is the rule Commits' rail and Activity's own rail already follow.
  const split = /\.activity-layout\s*\{([^}]*)\}/.exec(styles)?.[1] ?? "";
  assert.match(split, /minmax\(560px, 1fr\)/, "the overview column must absorb the leftover, not stop at a ceiling");
  assert.doesNotMatch(split, /minmax\(560px, 680px\)/, "a fixed overview ceiling strands width below the rail tier");
});

test("the Live metric strip can always be collapsed", () => {
  // The strip costs ~300px. Its disclosure used to be revealed only by the
  // compact tier, so a forced-wide foldable in landscape (1280x891 CSS px: wide
  // enough to miss the narrow tier, tall enough to miss the short one) had no
  // way to collapse it and kept a feed sliver. The control is cheap and it is
  // the ONLY control for this strip — unlike the filter disclosures, which stand
  // in for real controls shown inline on a roomy viewport — so it is always
  // available, while WHICH state it defaults to still follows the tier.
  assert.match(
    styles,
    /\.live-pulse-disclosure\s*\{[^}]*display:\s*inline-flex/,
    "the metrics disclosure must be available at every size",
  );
  assert.match(
    styles,
    /\.live-pulse\[data-open="false"\]\s*\{\s*display:\s*none/,
    "collapsing must actually hide the strip at every size",
  );
  // ...and the rule has to be UNGATED, which a whole-stylesheet match cannot
  // see. Leaving the reveal at top level while the collapse stayed tier-gated
  // passed every assertion above with the button visibly doing nothing at
  // 1280x891: it flipped aria-expanded and data-open, and the strip stayed.
  assert.ok(
    !mediaBlock(COMPACT_CHROME_QUERY).includes('.live-pulse[data-open="false"]'),
    "the collapse rule must not be tier-gated, or the button is inert outside that tier",
  );
  assert.ok(
    !mediaBlock(WIDE_RAIL_QUERY).includes('.live-pulse[data-open="false"]'),
    "nor may it be gated the other way",
  );
  const page = readFileSync(new URL("../src/components/LivePage.tsx", import.meta.url), "utf8");
  assert.match(page, /pulseChoice\s*\?\?\s*!shortViewport/, "the DEFAULT state still follows the short tier");
});

test("no pane carries a width ceiling inside a track that has none", () => {
  // The defect this exists for: v1.19.0 removed the overview COLUMN's ceiling
  // (minmax(560px, 680px) -> minmax(560px, 1fr)) and left the panel's own
  // `inline-size: min(100%, 680px)` in place. The track grew to 1030px at
  // 3008px wide and the panel stayed at 680, stranding 363px BETWEEN the
  // overview and the rail — where the render-smoke right-edge check could not
  // see it. Removing a ceiling one level out just moves the dead space one
  // level in.
  const panel = /\.activity-heatmap\s*\{([^}]*)\}/.exec(styles)?.[1] ?? "";
  assert.ok(panel, "the overview panel must still be styled here");
  assert.doesNotMatch(
    panel,
    /inline-size:\s*min\(/,
    "the overview panel must fill its track, not re-cap itself inside it",
  );
  assert.match(panel, /inline-size:\s*100%/, "the overview panel fills its track");

  // The calendar inside is a fixed-cell grid with a natural width and may sit
  // left; that is content sizing, not a pane ceiling, and is fine.
});

test("Commits leads with its list across three ratio columns, left-aligned", () => {
  // Two defects in sequence produced this rule. First the list was pinned at a
  // 1180px reading measure while the rail took everything else, so at 3008px the
  // SUPPORTING column was wider (1776px) than the primary one and a third its
  // height. Then the very-wide tier fixed that by centring, which left the split
  // visibly inset from the full-bleed toolbar above it. A third column takes the
  // slack instead, and the list keeps the largest share of it because it
  // carries the long strings on the page.
  const split = /\.commits-split\s*\{([^}]*)\}/.exec(styles)?.[1] ?? "";
  assert.ok(split, "the Commits split must still be styled here");

  const cols = /grid-template-columns:([^;]+);/.exec(split)?.[1] ?? "";
  const ratios = [...cols.matchAll(/minmax\(0,\s*(\d+)fr\)/g)].map((m) => Number(m[1]));
  assert.deepEqual(ratios, [40, 30, 30], "the list leads; the two supporting columns share the rest evenly");
  assert.match(split, /justify-content:\s*start/, "the split stays flush with the chrome above it");

  // Deliberately NOT Activity's proportions. Both pages are three ratio columns,
  // but the Commits list carries the long strings — a commit subject, an
  // org/repo path, an actor and a branch chip on two fixed-height lines — so at
  // Activity's 30 it ellipsized all of them. The Activity feed wraps instead of
  // truncating and reads fine narrower, so it keeps 30/35/35 and the two are
  // pinned separately rather than to each other.
  const railTier = mediaBlock("(min-width: 1700px)");
  const activity = /\.activity-layout\s*\{([^}]*)\}/.exec(railTier)?.[1] ?? "";
  assert.deepEqual(
    [...(/grid-template-columns:([^;]+);/.exec(activity)?.[1] ?? "").matchAll(/minmax\(0,\s*(\d+)fr\)/g)].map((m) => Number(m[1])),
    [30, 35, 35],
    "Activity keeps its own proportions",
  );
  assert.equal(ratios.reduce((sum, n) => sum + n, 0), 100, "the Commits tracks still describe a whole");

  // No very-wide override survives: centring the split is what stranded it.
  const wide = mediaBlock("(min-width: 2200px)");
  assert.doesNotMatch(wide, /\.commits-split/, "the very-wide tier must not re-size or re-centre the split");
  // The Commits rail still does not go two-up there. Not because it is narrow —
  // at 35fr it is about 1050px — but because its four ranked charts already fill
  // the height beside the list, so halving their width would only leave the
  // column half empty.
  assert.doesNotMatch(wide, /\.commits-rail[^{]*\{[^}]*repeat\(2/, "a sidebar rail must not also go two-up");
  assert.match(wide, /\.activity-rail\s*\{[^}]*repeat\(2/, "Activity's rail keeps its two-up tier");
});

test("both list panes fill the measured content-pane height", () => {
  // .activity-list and .commit-list were the last two panes on a hardcoded
  // fraction of the viewport. Every other pane measures its own document top
  // and ends at the viewport bottom (pane-height.ts), so on a 4K panel these two
  // alone disagreed with the rest of the board: the feed stopped ~100px short,
  // and the commit list ran its last row past the bottom edge.
  for (const pane of [".activity-list", ".commit-list"]) {
    const block = new RegExp(`^\\${pane}\\s*\\{([^}]*)\\}`, "m").exec(styles)?.[1] ?? "";
    assert.ok(block, `${pane} must still be styled here`);
    assert.match(
      block,
      /max-height:\s*var\(--content-pane-height,/,
      `${pane} must take the measured pane height, with the fixed fraction only as a fallback`,
    );
  }
});
test("every inner scroller shares the auto-hiding scrollbar treatment", () => {
  // .live-feed was missing from this set, so it alone got the platform default
  // bar: full width, always painted, and sitting between the feed cards and the
  // detail pane where it read as extra gap against the flat 12px of the metric
  // cards above it.
  const group = /:where\(html, body,([^)]*)\)\s*\{\s*scrollbar-color/.exec(styles)?.[1] ?? "";
  assert.ok(group, "the shared scroller set must still exist");
  for (const scroller of [".activity-list", ".commit-list", ".live-feed"]) {
    assert.ok(group.includes(scroller), `${scroller} must use the shared auto-hiding scrollbar`);
  }
});

test("the rail row tier is published once and mirrored in the stylesheet", () => {
  assert.equal(RAIL_ROWS_MIN_WIDTH_PX, 2200);
  assert.equal(RAIL_ROWS_QUERY, "(min-width: 2200px)");

  // Above this width the stylesheet relays the rank charts from vertical bars
  // flowed across to one row per item. If the query and the constant drift, the
  // components feed a row count for a layout the stylesheet is not applying:
  // eight items crammed across a 700px column as vertical bars, which is the
  // shape that truncated those labels to three characters in the first place.
  const rowsTier = mediaBlock(RAIL_ROWS_QUERY);
  assert.match(rowsTier, /\.commits-rail \.live-rank-plot[^{]*\{[^}]*grid-auto-flow:\s*row/);
  assert.match(rowsTier, /\.commits-rail \.live-rank-bar[^{]*\{[^}]*width:\s*var\(--rank-h\)/);

  // More rows than bars, because a row costs height the sidebar has and a bar
  // costs width it does not.
  assert.ok(
    RAIL_RANK_LIMIT_ROWS > RAIL_RANK_LIMIT,
    `the rows tier must carry more items than the bar tier (${RAIL_RANK_LIMIT_ROWS} vs ${RAIL_RANK_LIMIT})`,
  );

  // A truncating label must keep a way to be read. The first cut of this tier
  // hid .rank-name-tip on the grounds that rows give labels room -- but the
  // label column is 13rem with line-clamp: 1, so a long repository or branch
  // name still clips, and hiding the tip left those with no recovery at all.
  // Fewer clipped labels is not none.
  assert.doesNotMatch(
    rowsTier,
    /\.rank-name-tip[^{]*\{[^}]*display:\s*none/,
    "the rows tier must keep the name tooltip: its label column still clips long names",
  );

  // Neither rail may re-fork the count behind a local constant, which is how it
  // was written before the tier existed.
  for (const source of ["../src/components/CommitsRail.tsx", "../src/components/ActivityRail.tsx"]) {
    const text = readFileSync(new URL(source, import.meta.url), "utf8");
    assert.doesNotMatch(text, /const RAIL_RANK_LIMIT\s*=/, `${source} must use the shared tier, not a local copy`);
    assert.match(text, /RAIL_ROWS_QUERY/, `${source} must gate the count on the shared query`);
    // A memo that reads the limit must depend on it, or crossing the breakpoint
    // keeps the old row count until something unrelated invalidates the cache.
    for (const [, deps] of text.matchAll(/useMemo\(\(\) => rank\w+\([^)]*rankLimit\), \[([^\]]*)\]\)/g)) {
      assert.match(deps, /rankLimit/, "a memo reading rankLimit must list it as a dependency");
    }
  }
});
