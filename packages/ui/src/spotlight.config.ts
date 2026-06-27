// Spotlight lane configuration — the recency lanes shown beside the status
// columns (Follow-up / Plan-tracking / Change requests by default). These lanes encode label
// and kind CONVENTIONS (here, agent-runtime-kit's `workflow::*` labels), kept as
// DATA in this one file so retargeting the board to a different label scheme is a
// config edit, not a code change in model.ts. model.ts compiles each entry into a
// runtime predicate; see `compileLane` there.
//
// Each lane is matched declaratively:
//   kind     — optional; restrict the lane to one item kind (issue | change_request)
//   anyLabel — optional; match items carrying ANY of these label names
// A lane with neither field matches every item; combine them to narrow.

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
}

export const SPOTLIGHT_LANES: SpotlightLaneConfig[] = [
  { key: "follow-up", label: "Follow-up", hint: "issues labeled workflow::follow-up", kind: "issue", anyLabel: ["workflow::follow-up"] },
  { key: "plan", label: "Plan-tracking", hint: "issues labeled workflow::plan", kind: "issue", anyLabel: ["workflow::plan"] },
  { key: "pr", label: "Change requests", hint: "change requests, any state", kind: "change_request" },
];
