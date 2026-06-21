// Sprint 4 acceptance for the Live page's pure transport logic + snapshot
// client. The hook's effects (EventSource / polling) are exercised by the render
// smoke (which walks #/live) and by live-effects.test.ts; here we unit-test the
// pieces the hook composes, matching the repo's "test the pure logic, smoke the
// render" convention.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchLiveSnapshot } from "../src/contract.ts";
import { liveAvatarModel } from "../src/live-avatar.ts";
import { appendCapped, liveStreamUrl, pickLiveTransport } from "../src/useLive.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(status: number, body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

test("fetchLiveSnapshot returns the parsed snapshot", async () => {
  stubFetch(200, {
    schema: "live-snapshot/1",
    events: [{ seq: 2 }, { seq: 1 }],
    max_seq: 2,
    generated_at: "2026-06-20T10:00:00Z",
  });
  const snap = await fetchLiveSnapshot(null);
  assert.ok(snap);
  assert.equal(snap.max_seq, 2);
  assert.equal(snap.events.length, 2);
});

test("fetchLiveSnapshot returns null on a non-ok response", async () => {
  stubFetch(404, { error: "nope" });
  assert.equal(await fetchLiveSnapshot(null), null);
});

test("fetchLiveSnapshot returns null when the snapshot shape is wrong", async () => {
  // events not an array
  stubFetch(200, { schema: "live-snapshot/1", events: {}, max_seq: 2 });
  assert.equal(await fetchLiveSnapshot(null), null);
  // wrong / missing schema prefix
  stubFetch(200, { schema: "something-else", events: [], max_seq: 2 });
  assert.equal(await fetchLiveSnapshot(null), null);
  stubFetch(200, { events: [], max_seq: 2 });
  assert.equal(await fetchLiveSnapshot(null), null);
  // max_seq not a finite number
  stubFetch(200, { schema: "live-snapshot/1", events: [], max_seq: "2" });
  assert.equal(await fetchLiveSnapshot(null), null);
  stubFetch(200, { schema: "live-snapshot/1", events: [] });
  assert.equal(await fetchLiveSnapshot(null), null);
});

test("fetchLiveSnapshot returns null when the request throws", async () => {
  globalThis.fetch = (async () => {
    throw new Error("network");
  }) as typeof fetch;
  assert.equal(await fetchLiveSnapshot(null), null);
});

test("pickLiveTransport chooses sse only in a browser with EventSource", () => {
  assert.equal(pickLiveTransport({ tauri: false, hasEventSource: true }), "sse");
  assert.equal(pickLiveTransport({ tauri: true, hasEventSource: true }), "poll");
  assert.equal(pickLiveTransport({ tauri: false, hasEventSource: false }), "poll");
});

test("appendCapped dedupes by seq, newest-first, capped", () => {
  assert.deepEqual(
    appendCapped([], [{ seq: 1 }, { seq: 2 }], 10).map((e) => e.seq),
    [2, 1],
  );
  assert.deepEqual(
    appendCapped([{ seq: 2 }, { seq: 1 }], [{ seq: 2 }, { seq: 3 }], 10).map(
      (e) => e.seq,
    ),
    [3, 2, 1],
  );
  assert.deepEqual(
    appendCapped([], [{ seq: 1 }, { seq: 2 }, { seq: 3 }], 2).map((e) => e.seq),
    [3, 2],
  );
});

test("liveStreamUrl appends the since cursor only when > 0", () => {
  assert.equal(liveStreamUrl(null, 0), "./api/live");
  assert.equal(liveStreamUrl(null, 5), "./api/live?since=5");
});

test("liveAvatarModel renders an image model with a safe profile href", () => {
  assert.deepEqual(
    liveAvatarModel({
      login: "octocat",
      display_name: "The Octocat",
      avatar_url: "https://avatars.githubusercontent.com/u/583231?v=4",
      profile_url: "https://github.com/octocat",
    }),
    {
      label: "The Octocat",
      initials: "TO",
      imageUrl: "https://avatars.githubusercontent.com/u/583231?v=4",
      profileUrl: "https://github.com/octocat",
    },
  );
});

test("liveAvatarModel falls back deterministically and drops unsafe urls", () => {
  assert.deepEqual(
    liveAvatarModel({
      login: "renovate[bot]",
      display_name: null,
      avatar_url: "javascript:alert(1)",
      profile_url: "data:text/html,<script>1</script>",
    }),
    {
      label: "renovate[bot]",
      initials: "R",
      imageUrl: null,
      profileUrl: null,
    },
  );
  assert.deepEqual(liveAvatarModel(null), {
    label: "someone",
    initials: "?",
    imageUrl: null,
    profileUrl: null,
  });
});
