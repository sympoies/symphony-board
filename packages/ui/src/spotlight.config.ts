// Spotlight lane configuration — the recency lanes shown around the status
// columns (Trackers ahead of them; Follow-up / Change requests after by
// default). These lanes encode label and kind CONVENTIONS (here,
// agent-runtime-kit's `workflow::*` labels), kept as DATA in this one file so
// retargeting the board to a different label scheme is a config edit, not a
// code change in model.ts. model.ts compiles each entry into a runtime
// predicate; see `compileLane` there.
//
// Each lane is matched declaratively:
//   kind     — optional; restrict the lane to one item kind (issue | change_request)
//   anyLabel — optional; match items carrying ANY of these label names
//   state    — optional; restrict the lane to one item state (e.g. open)
// A lane with none of these fields matches every item; combine them to narrow.

export interface SpotlightLaneConfig {
  /** stable key — used as the CSS class suffix (`col-lane-<key>`) and React key. */
  key: string;
  /** column header text. */
  label: string;
  /** sub-header hint shown under the title (also the column's hover title). */
  hint: string;
  /** optional: restrict the lane to one item kind. */
  kind?: string;
  /** optional: match items carrying ANY of these label names. */
  anyLabel?: string[];
  /** optional: restrict the lane to one item state. */
  state?: string;
  /** optional: render the lane ahead of the status columns instead of after them. */
  lead?: boolean;
  /** optional: list open items first and fold the rest behind a "Closed (N)" count. */
  foldClosed?: boolean;
}

export const SPOTLIGHT_LANES: SpotlightLaneConfig[] = [
  { key: "trackers", label: "Trackers", hint: "issues labeled workflow::tracking", kind: "issue", anyLabel: ["workflow::tracking"], lead: true, foldClosed: true },
  { key: "follow-up", label: "Follow-up", hint: "issues labeled workflow::follow-up", kind: "issue", anyLabel: ["workflow::follow-up"] },
  { key: "pr", label: "Change requests", hint: "open change requests", kind: "change_request", state: "open" },
];
