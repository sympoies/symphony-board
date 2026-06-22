import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  LIVE_FEED_ENTER_MS,
  LIVE_FEED_SELECTED_SETTLE_MS,
  LIVE_FOLLOW_DETAIL_HOLD_MS,
  clampLivePaneHeight,
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

test("Live auto-follow delays detail swaps and holds (does not reset) across bursts", () => {
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
    { action: "keep" },
    "a burst must NOT restart the hold: the pending settle timer fires on its own schedule (leading-edge throttle), so a continuous stream still advances the detail instead of debouncing to quiet forever",
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

test("Live auto-follow refreshes the detail in place when the followed event is re-sent with fresh data", () => {
  // A same-(source,event,seq) replacement (e.g. actor-profile/avatar enrichment
  // broadcast over `live-update`) arrives as a fresh object under the same key.
  // The detail must re-render with the enriched object, not be skipped as "keep".
  const followed = liveEvent(1);
  const refreshed: LiveEvent = { ...followed, title: "event 1 (enriched)" };
  const key = liveEventKey(followed);

  assert.deepEqual(
    resolveLiveFollowDecision({
      following: true,
      newest: refreshed,
      newestKey: key,
      followed,
      pendingHoldKey: null,
      filtersChanged: false,
      prefersReducedMotion: false,
    }),
    { action: "set-followed", event: refreshed },
    "a same-key fresh object should refresh the detail immediately (no settle hold — it is the same logical event)",
  );
  assert.deepEqual(
    resolveLiveFollowDecision({
      following: true,
      newest: followed,
      newestKey: key,
      followed,
      pendingHoldKey: null,
      filtersChanged: false,
      prefersReducedMotion: false,
    }),
    { action: "keep" },
    "the identical object reference should keep — no needless detail churn",
  );
});

test("clampLivePaneHeight fills the available viewport and never forces the minimum past it", () => {
  // Tall window: plenty of room below the split, the minimum is comfortably met.
  assert.equal(clampLivePaneHeight(1000, 200, 16, 320), 784);
  // Short window: less than the minimum remains. Forcing 320 here reintroduces
  // document-level scrolling, so clamp to what is actually available instead.
  assert.equal(clampLivePaneHeight(480, 300, 16, 320), 164);
  // Degenerate: the split already sits past the viewport — never go negative.
  assert.equal(clampLivePaneHeight(300, 320, 16, 320), 0);
});

test("Live pulse strip collapses to two columns before the ranked charts would overflow a four-column row", () => {
  // The four-column pulse grid starves the ranked-chart cards on ~1280px desktops
  // (the charts need more width than a 1fr/1.2fr card gives), so the strip drops
  // to two columns below the large-desktop breakpoint.
  assert.match(
    stylesSource,
    /@media \(max-width: 1439px\)\s*{\s*\.live-pulse\s*{\s*grid-template-columns:\s*1fr 1fr;\s*}\s*}/,
    "the pulse strip should collapse to two columns at the 1439px breakpoint",
  );
});

test("Live pulse strip is collapsible on a phone and stays open on desktop", () => {
  // The four metric cards push the feed far down a phone screen. On mobile they
  // hide behind a tap-to-collapse disclosure (default open); the collapsed state
  // is carried by data-open="false" and only takes effect inside the phone
  // breakpoint, so desktop always shows the strip regardless of the toggle.
  assert.match(
    stylesSource,
    /@media \(max-width: 760px\)\s*{[\s\S]*?\.live-pulse\[data-open="false"\]\s*{[^}]*display:\s*none;/,
    "a collapsed pulse strip should be hidden only within the phone breakpoint",
  );
  // The toggle reuses the shared collapsed-filter chrome, which is display:none
  // on desktop — so the disclosure never appears on a wide screen.
  assert.match(
    stylesSource,
    /\.filter-summary-disclosure\s*{\s*display:\s*none;\s*}/,
    "the shared disclosure chrome should be hidden by default (desktop)",
  );
  assert.match(
    stylesSource,
    /@media \(max-width: 760px\)\s*{[\s\S]*?\.live-pulse-disclosure\s*{[^}]*width:\s*100%;/,
    "the pulse disclosure should be a full-width header bar on a phone",
  );
});

test("Live detail navigation is mobile-only and centered in the detail pane", () => {
  assert.match(
    stylesSource,
    /\.live-detail-nav\s*{[^}]*display:\s*none;[^}]*justify-content:\s*center;/s,
    "the detail pagination controls should stay hidden outside the mobile overlay",
  );
  assert.match(
    stylesSource,
    /@media \(max-width: 900px\)\s*{[\s\S]*?\.live-detail-nav\s*{[^}]*display:\s*flex;[^}]*margin:\s*10px 0 0;/,
    "the detail pagination controls should be centered in the detail pane",
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
    /\.live-detail-shell::before\s*{[^}]*animation: live-detail-accent 1600ms/s,
    "detail swaps should include a readable accent frame/wash for visual continuity",
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
