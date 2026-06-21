import { liveEventKey, type LiveEvent } from "./model.ts";

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
  if (newestKey == null || liveEventKey(followed) === newestKey) return { action: "keep" };
  if (pendingHoldKey === newestKey) return { action: "keep" };
  return { action: "schedule-hold", holdKey: newestKey };
}

export function liveFeedSelectedKey(
  following: boolean,
  newestKey: string | null,
  detailKey: string | null,
): string | null {
  return following ? newestKey : detailKey;
}
