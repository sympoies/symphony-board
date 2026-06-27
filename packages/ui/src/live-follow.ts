import { liveEventKey, type LiveEvent } from "./model.ts";
import { clampContentPaneHeight } from "./pane-height.ts";

// The newest feed row's `live-enter` and `live-arrive` durations. In follow
// mode the detail pane holds its content swap until the row has reached its
// final selected color, then crossfades to the same event. Keep these in sync
// with the newest-row animation durations in styles.css.
export const LIVE_FEED_ENTER_MS = 650;
export const LIVE_FEED_SELECTED_SETTLE_MS = 1400;
export const LIVE_FOLLOW_DETAIL_HOLD_MS = Math.max(LIVE_FEED_ENTER_MS, LIVE_FEED_SELECTED_SETTLE_MS);

export type LiveFollowDecision =
  | { action: "clear-pending" }
  | { action: "set-followed"; event: LiveEvent | null }
  | { action: "keep" }
  | { action: "schedule-hold"; holdKey: string };

export interface LiveFollowDecisionInput {
  following: boolean;
  newest: LiveEvent | null;
  newestKey: string | null;
  followed: LiveEvent | null;
  pendingHoldKey: string | null;
  filtersChanged: boolean;
  prefersReducedMotion: boolean;
}

export function resolveLiveFollowDecision({
  following,
  newest,
  newestKey,
  followed,
  pendingHoldKey,
  filtersChanged,
  prefersReducedMotion,
}: LiveFollowDecisionInput): LiveFollowDecision {
  if (!following) return { action: "clear-pending" };
  if (newest == null) return { action: "set-followed", event: null };
  if (followed == null || prefersReducedMotion || filtersChanged) return { action: "set-followed", event: newest };
  if (newestKey == null) return { action: "keep" };
  if (liveEventKey(followed) === newestKey) {
    // Same logical event. An identical object reference is a no-op; a fresh
    // object under the same key is a `live-update` replacement (e.g. actor
    // profile / avatar enrichment broadcast on the same seq), so refresh the
    // detail in place — it is not a new arrival, so no settle hold.
    return followed === newest ? { action: "keep" } : { action: "set-followed", event: newest };
  }
  // A genuinely newer event. Hold the detail swap so the feed row can settle.
  // Do NOT reset an already-pending hold on every arrival: under a continuous
  // stream that would debounce-to-quiet forever and strand the detail on an old
  // event. Let the pending timer fire on its own schedule (leading-edge
  // throttle); the arrival after it lands schedules the next swap.
  if (pendingHoldKey != null) return { action: "keep" };
  return { action: "schedule-hold", holdKey: newestKey };
}

export const clampLivePaneHeight = clampContentPaneHeight;

export function liveFeedSelectedKey(
  following: boolean,
  newestKey: string | null,
  detailKey: string | null,
): string | null {
  return following ? newestKey : detailKey;
}
