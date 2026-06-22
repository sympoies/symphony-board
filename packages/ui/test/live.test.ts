// Sprint 4 acceptance for the Live page's pure transport logic + snapshot
// client. The hook's effects (EventSource / polling) are exercised by the render
// smoke (which walks #/live) and by live-effects.test.ts; here we unit-test the
// pieces the hook composes, matching the repo's "test the pure logic, smoke the
// render" convention.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { fetchLiveSnapshot, fetchLiveSnapshotResult, LIVE_SNAPSHOT_RETRY_BASE_MS } from "../src/contract.ts";
import { liveAvatarModel } from "../src/live-avatar.ts";
import { appendCapped, liveStreamUrl, pickLiveTransport } from "../src/useLive.ts";
import { LIVE_SEED_LIMIT, LIVE_EVENT_BUFFER_LIMIT } from "../src/live-config.ts";

// The cold-start seed must stay well below the buffer cap: a seed sized at the
// 1000-event cap was the ~26MB download that stranded Live on launch. Guard the
// two constants so a refactor can't silently let them converge again.
test("the cold-start seed limit stays well under the buffer cap", () => {
  assert.ok(LIVE_SEED_LIMIT < LIVE_EVENT_BUFFER_LIMIT, "seed must be smaller than the buffer cap");
  assert.ok(LIVE_SEED_LIMIT > 0, "seed must fetch at least some events");
});

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

// A live snapshot probe must NOT hang forever on a slow cold-start link (the
// reported Android symptom: ~60s stuck on "Connecting…"). It carries a bounded
// per-attempt timeout, so a request that never settles is aborted and reported
// unavailable instead of stranding the page. The `{ timeout }` here makes the
// case fail loudly against an unbounded implementation rather than hanging the run.
test("fetchLiveSnapshot aborts a hung request within its bounded timeout", { timeout: 3000 }, async () => {
  let sawSignal = false;
  globalThis.fetch = ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        sawSignal = true;
        signal.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }
      // never resolves on its own — only the timeout abort settles it
    })) as typeof fetch;
  const snap = await fetchLiveSnapshot(null, undefined, undefined, {
    requestTimeoutMs: 40,
    retries: 0,
  });
  assert.equal(snap, null, "a hung request resolves to null via the timeout, not a hang");
  assert.ok(sawSignal, "the snapshot fetch must pass an abort signal so it can be bounded");
});

// A transient failure (network blip / timeout) on the cold-start probe should be
// retried a bounded number of times before giving up, so a momentary blip does
// not hide the Live tab. Backoff sleep is injected so the test stays instant.
test("fetchLiveSnapshot retries a transient failure then succeeds", async () => {
  let calls = 0;
  globalThis.fetch = ((_url: string) => {
    calls += 1;
    if (calls === 1) return Promise.reject(new Error("transient network"));
    return Promise.resolve(
      new Response(
        JSON.stringify({ schema: "live-snapshot/1", events: [{ seq: 1 }], max_seq: 1, generated_at: "x" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }) as typeof fetch;
  const sleeps: number[] = [];
  const snap = await fetchLiveSnapshot(null, undefined, undefined, {
    retries: 2,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });
  assert.ok(snap, "the retry recovers the snapshot");
  assert.equal(snap?.max_seq, 1);
  assert.equal(calls, 2, "one failure + one success");
  assert.equal(sleeps.length, 1, "backoff slept once between the two attempts");
  assert.equal(sleeps[0], LIVE_SNAPSHOT_RETRY_BASE_MS, "first backoff is the base delay (base * 2^0)");
});

// A 200 whose body is not valid JSON (a fully-received but unparseable body) is a
// DEFINITIVE content error, surfaced immediately without burning retry rounds —
// distinct from an interrupted/aborted body read, which is transient.
test("fetchLiveSnapshot does not retry a parse error on a settled body", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  globalThis.fetch = ((_url: string) => {
    calls += 1;
    return Promise.resolve(
      new Response("not json{", { status: 200, headers: { "content-type": "application/json" } }),
    );
  }) as typeof fetch;
  const snap = await fetchLiveSnapshot(null, undefined, undefined, {
    retries: 5,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });
  assert.equal(snap, null);
  assert.equal(calls, 1, "a SyntaxError on a settled body is definitive -> no retry");
  assert.equal(sleeps.length, 0);
});

// A body read that DROPS mid-stream (connection cut before the 12s abort fires)
// rejects with a network error, NOT a SyntaxError, and the per-attempt signal is
// not yet aborted. That interrupted read is transient — exactly like a thrown
// fetch — and must be RETRIED, mirroring loadContractAttempt's rule. The old
// `transient: signal.aborted` mis-classified this as definitive and stranded a
// cold-start blip on "unavailable".
test("fetchLiveSnapshot retries a dropped (non-SyntaxError) body read before the abort fires", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  globalThis.fetch = ((_url: string, _init?: RequestInit) => {
    calls += 1;
    if (calls < 2) {
      // headers arrived (200, ok), then the connection drops mid-body: json()
      // rejects with a network error while the abort signal is NOT yet aborted.
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => {
          throw new TypeError("network connection lost mid-body");
        },
      } as unknown as Response);
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({ schema: "live-snapshot/1", events: [{ seq: 1 }], max_seq: 1, generated_at: "x" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }) as typeof fetch;
  const snap = await fetchLiveSnapshot(null, undefined, undefined, {
    retries: 3,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });
  assert.ok(snap, "the dropped body read is transient -> the retry recovers the snapshot");
  assert.equal(snap?.max_seq, 1);
  assert.equal(calls, 2, "one dropped-body failure + one success");
  assert.equal(sleeps.length, 1, "one backoff between the dropped read and the retry");
});

// fetchLiveSnapshotResult exposes WHY a probe failed so the cold-start seed can
// tell a retriable cold-link blip from a deployment that simply has no receiver.
test("fetchLiveSnapshotResult classifies transient vs definitive failures", async () => {
  globalThis.fetch = (async () => {
    throw new Error("network");
  }) as typeof fetch;
  const network = await fetchLiveSnapshotResult(null, undefined, undefined, { retries: 0 });
  assert.equal(network.snapshot, null);
  assert.equal(network.transientFailure, true, "a thrown fetch is transient (worth retrying)");

  stubFetch(404, { error: "nope" });
  const missing = await fetchLiveSnapshotResult(null, undefined, undefined, { retries: 0 });
  assert.equal(missing.snapshot, null);
  assert.equal(missing.transientFailure, false, "a 404 is definitive (no receiver) — do not keep connecting");

  stubFetch(200, { schema: "live-snapshot/1", events: [{ seq: 1 }], max_seq: 1, generated_at: "x" });
  const ok = await fetchLiveSnapshotResult(null);
  assert.ok(ok.snapshot);
  assert.equal(ok.transientFailure, false);
});

// A DEFINITIVE answer must not be retried: a 404 (no receiver on this deploy) or a
// wrong-shape 200 is reported unavailable immediately, so the availability probe
// does not waste retry rounds on a deployment that simply has no Live receiver.
test("fetchLiveSnapshot does not retry a definitive non-ok or wrong-shape response", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };

  globalThis.fetch = ((_url: string) => {
    calls += 1;
    return Promise.resolve(new Response(JSON.stringify({ error: "nope" }), { status: 404 }));
  }) as typeof fetch;
  assert.equal(await fetchLiveSnapshot(null, undefined, undefined, { retries: 5, sleep }), null);
  assert.equal(calls, 1, "a 404 is definitive -> no retry");

  calls = 0;
  globalThis.fetch = ((_url: string) => {
    calls += 1;
    return Promise.resolve(
      new Response(JSON.stringify({ schema: "live-snapshot/1", events: {}, max_seq: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  assert.equal(await fetchLiveSnapshot(null, undefined, undefined, { retries: 5, sleep }), null);
  assert.equal(calls, 1, "a wrong-shape 200 is definitive -> no retry");
  assert.equal(sleeps.length, 0, "no backoff for definitive answers");
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
