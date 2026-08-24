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

// Deliberately DOM-free: model.ts re-exports the narrow query, and model.ts is
// compiled by the backend type-check program (no DOM lib), so a `Window` in this
// module would break `pnpm run typecheck` at the repo root. The runtime probes
// that answer "is this viewport short right now" live in useMediaQuery.ts.
