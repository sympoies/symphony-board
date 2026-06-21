// Action -> badge style for mixed activity/live feeds. Every action the sources
// emit should land here; unmapped actions fall through to the quiet neutral
// "status-unknown" pill.
export const ACTION_KIND: Record<string, string> = {
  // item lifecycle
  opened: "open",
  reopened: "open",
  closed: "closed",
  merged: "merged",
  accepted: "merged", // GitLab emits "accepted" when an MR is merged
  // commits / pushes
  committed: "status-ok",
  created: "status-ok",
  pushed: "lifecycle-declared",
  force_pushed: "lifecycle-broken",
  deleted: "status-error",
  // comments + reviews
  commented: "status-partial",
  approved: "status-ok",
  reviewed: "status-partial",
  changes_requested: "status-error",
  dismissed: "status-idle",
};
