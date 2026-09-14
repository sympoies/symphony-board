// Layout tiers are keyed on BOTH viewport axes.
//
// Width alone was the original model, and it mis-sized every short-but-wide
// viewport: a foldable's inner screen (~933x704 CSS px), a phone in landscape, a
// half-height desktop window. All of them clear the width breakpoints, so they
// keep the full desktop chrome — brand header, tabs, the metric / stats strip,
// the filter bar — and whatever is left of the viewport becomes the content
// pane. On a 704px-tall viewport that left ~93px, and because the panes end
// exactly at the viewport bottom the DOCUMENT never scrolls either: the feed was
// a sliver with nothing below it to reach.
//
//   narrow  (<= 760px wide)   horizontal collapse: single column, desktop-only
//                             cells hidden, popovers repositioned.
//   short   (<= 760px tall)   vertical collapse: the metric / stats strips fold
//                             behind their disclosure so the content pane keeps
//                             a usable height.
//   compact (narrow OR short) the shared disclosure chrome both tiers rely on.
//
// The split-to-overlay breakpoint stays width-only: whether two panes fit side
// by side is a horizontal question. Height is answered by the pane floor in
// pane-height.ts, which hands short viewports document scrolling instead of a
// squeezed pane.
//
// styles.css mirrors these numbers; layout-tier.test.ts asserts the stylesheet
// and these constants stay in sync, so a breakpoint only ever moves in one place.
export const NARROW_MAX_WIDTH_PX = 760;
export const SHORT_MAX_HEIGHT_PX = 760;
export const SPLIT_MAX_WIDTH_PX = 900;

// The width at which Activity gains its third column (the who / where / when
// rail). Derived from what the three columns actually need rather than picked
// round: the feed's 40vw, the overview's 560px floor and a 340px rail plus gaps
// fit from about 1660px of content box, which a 1700px viewport provides.
// Deliberately BELOW the 1728px of a 16" MacBook Pro at default scaling, so the
// laptop this board is read on gets the rail rather than just missing it.
export const WIDE_RAIL_MIN_WIDTH_PX = 1700;
export const WIDE_RAIL_QUERY = `(min-width: ${WIDE_RAIL_MIN_WIDTH_PX}px)`;

// The viewport width at which a two-pane split (Activity feed + overview,
// Commits list + rail) starts sitting side by side. Sized from the Activity
// tracks, the tighter of the two: the feed clamp floor (640px), the overview
// floor (560px) and one --pane-gap (12px).
//
// It is a VIEWPORT width and those are content-box widths, so the page padding
// is not in the number: measured at exactly 1212 the feed sits at 590px rather
// than its preferred 640px, which minmax(0, ...) allows on purpose. Nothing is
// stranded there and nothing overflows; the feed reaches its full 640px from
// about 1262px, and at the 1280px that matters below it already has it.
//
// This has to stay at or below runtime.WIDE_VIEWPORT_WIDTH. Android's
// wide-layout setting pins the WebView viewport to exactly that width, so a
// split that stacks above it hands a foldable desktop chrome WITH mobile
// stacking -- the Z Fold put the Commits rail under the list and capped the
// Activity feed at 720px with ~560px of dead gutter beside it.
// layout-tier.test.ts compares the two numbers, because nothing else in the
// build reads both.
// Where a rail stops being a wide panel and becomes a tall narrow sidebar. At
// this width the stylesheet relays its rank charts from vertical bars flowed
// across to one row per item, which changes what a row costs: a row is ~26px of
// HEIGHT instead of ~34px of WIDTH. Rows are cheap in a column that has height
// to spare and labels that were truncating to three characters, so the charts
// also carry more of them here.
//
// styles.css mirrors this number; layout-tier.test.ts keeps the two in step.
export const RAIL_ROWS_MIN_WIDTH_PX = 2200;
export const RAIL_ROWS_QUERY = `(min-width: ${RAIL_ROWS_MIN_WIDTH_PX}px)`;
// Six bars is what fits across a narrow column; eight rows is what fills a tall
// one. Measured against a 1252px Commits list: four rank panes at eight rows,
// plus the day-bar pane and the gaps, land at about 1240px.
export const RAIL_RANK_LIMIT = 6;
export const RAIL_RANK_LIMIT_ROWS = 8;

export const SPLIT_RAIL_MIN_WIDTH_PX = 1212;
export const SPLIT_STACK_QUERY = `(max-width: ${SPLIT_RAIL_MIN_WIDTH_PX - 1}px)`;

// Not every breakpoint belongs here, and one nearby deliberately does not: the
// Commits list/rail split collapses at 1500px purely in CSS. Nothing in JS gates
// it — the rail renders at every width and the grid decides whether it sits
// beside the list or under it — so there is no pair that could drift, and
// publishing a constant only this file would read is noise. Recorded so an audit
// starting here does not conclude 1500 went missing.

// Floor for a content pane, in the units that matter: rows. A Live/Reviews row
// is 114px at the default two-line preview plus a 6px gap, so 240px is two whole
// rows — the point below which a pane stops reading as a list at all (the
// foldable regression left 93px, less than one row). Below the floor pane-height
// stops shrinking and hands scrolling back to the document. Deliberately BELOW
// what an ordinary desktop leaves over (a 1280x900 window leaves ~312px), so the
// no-scroll dashboard feel survives everywhere it already worked.
export const CONTENT_PANE_MIN_HEIGHT_PX = 240;

export const NARROW_VIEWPORT_QUERY = `(max-width: ${NARROW_MAX_WIDTH_PX}px)`;
export const SHORT_VIEWPORT_QUERY = `(max-height: ${SHORT_MAX_HEIGHT_PX}px)`;
// A comma-separated media query list is an OR, and mirrors the stylesheet's
// `@media (max-width: 760px), (max-height: 760px)` block verbatim.
export const COMPACT_CHROME_QUERY = `${NARROW_VIEWPORT_QUERY}, ${SHORT_VIEWPORT_QUERY}`;
export const DETAIL_OVERLAY_QUERY = `(max-width: ${SPLIT_MAX_WIDTH_PX}px)`;

// Deliberately DOM-free, and not by preference: model.ts re-exports the narrow
// query, and test/graph-neighborhood.test.ts imports model.ts, which pulls this
// module into the repo-root type-check program — whose tsconfig sets
// `lib: ["ES2023"]` with no DOM. A single `Window` here breaks
// `pnpm run typecheck` with an error that names neither file's real reason.
//
// So the rule is about THIS module, not about probes in general: a probe lives
// wherever its consumer lives. The viewport probes sit in useMediaQuery.ts next to
// the hook they mirror; readSafeAreaBottomPx sits in pane-height.ts next to the
// gutter arithmetic that consumes it.
