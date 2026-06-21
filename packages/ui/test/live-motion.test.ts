import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  LIVE_FEED_ENTER_MS,
  LIVE_FEED_SELECTED_SETTLE_MS,
  LIVE_FOLLOW_DETAIL_HOLD_MS,
  liveFeedSelectedKey,
  resolveLiveFollowDecision,
} from "../src/live-follow.ts";
import { liveEventKey, type LiveEvent } from "../src/model.ts";

const stylesSource = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

function liveEvent(seq: number): LiveEvent {
  return {
    seq,
    event_id: `evt-${seq}`,
    source_id: "github:github.com",
    provider: "github",
    received_at: "2026-06-21T00:00:00.000Z",
    event_type: "pull_request",
    category: "change_request",
    title: `event ${seq}`,
  };
}

test("Live auto-follow delays detail swaps and restarts the hold for bursts", () => {
  assert.equal(LIVE_FEED_SELECTED_SETTLE_MS, 1400);
  assert.equal(LIVE_FOLLOW_DETAIL_HOLD_MS, Math.max(LIVE_FEED_ENTER_MS, LIVE_FEED_SELECTED_SETTLE_MS));

  const current = liveEvent(1);
  const next = liveEvent(2);
  const newest = liveEvent(3);
  const currentKey = liveEventKey(current);
  const nextKey = liveEventKey(next);
  const newestKey = liveEventKey(newest);

  assert.deepEqual(
    resolveLiveFollowDecision({
      following: true,
      newest: next,
      newestKey: nextKey,
      followed: current,
      pendingHoldKey: null,
      filtersChanged: false,
      prefersReducedMotion: false,
    }),
    { action: "schedule-hold", holdKey: nextKey },
    "a new newest row should delay the detail swap until the row has visually settled",
  );
  assert.deepEqual(
    resolveLiveFollowDecision({
      following: true,
      newest: next,
      newestKey: nextKey,
      followed: current,
      pendingHoldKey: nextKey,
      filtersChanged: false,
      prefersReducedMotion: false,
    }),
    { action: "keep" },
    "the same newest row should reuse its pending settle timer",
  );
  assert.deepEqual(
    resolveLiveFollowDecision({
      following: true,
      newest,
      newestKey,
      followed: current,
      pendingHoldKey: nextKey,
      filtersChanged: false,
      prefersReducedMotion: false,
    }),
    { action: "schedule-hold", holdKey: newestKey },
    "a burst should restart the hold for the latest selected feed row",
  );
  assert.equal(
    liveFeedSelectedKey(true, newestKey, currentKey),
    newestKey,
    "follow mode should mark the newest feed row selected before the detail pane changes",
  );
  assert.equal(
    liveFeedSelectedKey(false, newestKey, currentKey),
    currentKey,
    "pinned/manual detail mode should keep the selected feed row tied to the detail pane",
  );
});

test("Live auto-follow bypasses the hold for non-arrival transitions", () => {
  const current = liveEvent(1);
  const newest = liveEvent(2);
  const newestKey = liveEventKey(newest);

  assert.deepEqual(
    resolveLiveFollowDecision({
      following: true,
      newest,
      newestKey,
      followed: null,
      pendingHoldKey: null,
      filtersChanged: false,
      prefersReducedMotion: false,
    }),
    { action: "set-followed", event: newest },
    "the first event should populate detail immediately",
  );
  assert.deepEqual(
    resolveLiveFollowDecision({
      following: true,
      newest,
      newestKey,
      followed: current,
      pendingHoldKey: newestKey,
      filtersChanged: true,
      prefersReducedMotion: false,
    }),
    { action: "set-followed", event: newest },
    "filter changes should not strand a filtered-out detail behind a timer",
  );
  assert.deepEqual(
    resolveLiveFollowDecision({
      following: true,
      newest,
      newestKey,
      followed: current,
      pendingHoldKey: newestKey,
      filtersChanged: false,
      prefersReducedMotion: true,
    }),
    { action: "set-followed", event: newest },
    "reduced-motion should avoid delayed content swaps",
  );
  assert.deepEqual(
    resolveLiveFollowDecision({
      following: true,
      newest: null,
      newestKey: null,
      followed: current,
      pendingHoldKey: newestKey,
      filtersChanged: false,
      prefersReducedMotion: false,
    }),
    { action: "set-followed", event: null },
    "an empty filtered feed should clear the followed detail",
  );
  assert.deepEqual(
    resolveLiveFollowDecision({
      following: false,
      newest,
      newestKey,
      followed: current,
      pendingHoldKey: newestKey,
      filtersChanged: false,
      prefersReducedMotion: false,
    }),
    { action: "clear-pending" },
    "pinning/manual selection should abandon pending auto-follow swaps",
  );
});

test("Live motion CSS keeps the feed settle and detail accent durations explicit", () => {
  assert.match(
    stylesSource,
    new RegExp(
      String.raw`\.live-feed \.live-event\[data-feed-index="0"\]\s*{[^}]*live-enter ${LIVE_FEED_ENTER_MS}ms[^}]*live-arrive ${LIVE_FEED_SELECTED_SETTLE_MS}ms`,
      "s",
    ),
    "CSS should keep the newest row entrance and background settle durations explicit",
  );
  assert.match(
    stylesSource,
    /@keyframes live-arrive\s*{[\s\S]*?to\s*{\s*background: var\(--live-row-bg\);\s*}/,
    "the arrival animation should settle to the row's final selected or unselected background",
  );

  assert.match(
    stylesSource,
    /\.live-detail-shell\s*{[^}]*animation: live-detail-in 360ms/s,
    "detail content should use a deliberate 360ms reveal instead of a brief flash",
  );
  assert.match(
    stylesSource,
    /\.live-detail-shell::before\s*{[^}]*animation: live-detail-accent 900ms/s,
    "detail swaps should include a short accent frame/wash for visual continuity",
  );
  assert.match(
    stylesSource,
    /@keyframes live-detail-accent\s*{[\s\S]*?100%\s*{\s*opacity: 0;/,
    "the detail accent should fade away instead of leaving persistent chrome",
  );
  assert.match(
    stylesSource,
    /\.live-detail-shell::before\s*{ animation: none; }/,
    "reduced-motion should disable the detail accent animation",
  );
});
