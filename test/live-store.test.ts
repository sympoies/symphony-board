// Sprint 1 acceptance for the dedicated live-event store (docs/plans/2026-06-20-
// live-event-stream). Asserts the append-only / idempotent / monotonic-seq /
// replay / TTL+row-cap-prune contract, lossless round-trip of the neutral
// `live-event/1` record through the JSON columns, NUL-free SSE ids, and the
// hard isolation invariant: the live subsystem never touches the canonical
// store, the product contract, provider tokens, or config. Network-free; runs
// against an in-memory SQLite store. Modeled on the upsert idempotency/ordering
// discipline in store-conformance, kept in its own file per repo convention.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openLiveStore } from "../src/live/store.ts";
import {
  LIVE_EVENT_SCHEMA,
  isLiveEvent,
  stripNul,
  toProviderNumber,
} from "../src/live/types.ts";
import type { LiveEventInput } from "../src/live/types.ts";
import { resolvePruneConfig, startPruneTimer } from "../src/live/prune.ts";

const NUL = String.fromCharCode(0);

async function until(
  predicate: () => boolean | Promise<boolean>,
  attempts = 200,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition not met in time");
}

function at<T>(arr: T[], i: number): T {
  const v = arr[i];
  assert.ok(v !== undefined, `index ${i} out of range`);
  return v;
}

function head<T>(arr: T[]): T {
  return at(arr, 0);
}

// append now returns the persisted LiveEvent for a NEW row (or null for a
// redelivery). This helper asserts a new insert and yields its seq.
function appendNew(
  store: ReturnType<typeof openLiveStore>,
  input: LiveEventInput,
  ordinal = 0,
): number {
  const ev = store.append(input, ordinal);
  assert.ok(ev, "expected append to insert a new row");
  return ev.seq;
}

function makeInput(over: Partial<LiveEventInput> = {}): LiveEventInput {
  return {
    event_id: "d-1",
    source_id: "github:github.com",
    provider: "github",
    received_at: "2026-06-20T08:14:55Z",
    occurred_at: "2026-06-20T08:14:53Z",
    event_type: "pull_request_review",
    action: "submitted",
    category: "review",
    actor: {
      login: "octocat",
      display_name: "The Octocat",
      avatar_url: "https://avatars.example/octocat.png",
      profile_url: "https://github.com/octocat",
    },
    target: {
      kind: "change_request",
      source_id: "github:github.com",
      project_path: "sympoies/symphony-board",
      number: 305,
      external_id: "PR_abc",
      title: "feat: live event stream",
      url: "https://github.com/sympoies/symphony-board/pull/305",
    },
    title: "octocat approved PR #305",
    body: "LGTM",
    url: "https://github.com/sympoies/symphony-board/pull/305#pullrequestreview-1",
    review_state: "approved",
    delivery: {
      delivery_id: "d-1",
      event_header: "pull_request_review",
      hook_id: "h1",
      signature_status: "verified",
    },
    provider_details: { merged: false },
    raw: { hello: "world" },
    ...over,
  };
}

// An input whose event_id and delivery_id share the provider delivery GUID.
function ev(n: number, over: Partial<LiveEventInput> = {}): LiveEventInput {
  const id = `d-${n}`;
  return makeInput({
    event_id: id,
    delivery: {
      delivery_id: id,
      event_header: "issues",
      signature_status: "verified",
    },
    ...over,
  });
}

test("append assigns a strictly monotonic seq and tracks maxSeq", () => {
  const store = openLiveStore(":memory:");
  try {
    const seqs: number[] = [];
    for (let i = 1; i <= 5; i++) seqs.push(appendNew(store, ev(i)));
    for (let i = 1; i < seqs.length; i++) assert.ok(at(seqs, i) > at(seqs, i - 1));
    assert.equal(store.maxSeq(), at(seqs, seqs.length - 1));
  } finally {
    store.close();
  }
});

test("append is idempotent on (source_id, event_id) and is append-only", () => {
  const store = openLiveStore(":memory:");
  try {
    const first = store.append(ev(1));
    assert.ok(first, "the first write inserts a new row");
    const redelivery = store.append(ev(1, { body: "edited later" }));
    assert.equal(redelivery, null, "a redelivery returns null (nothing new)");
    assert.equal(store.recent(100).length, 1, "no duplicate row");
    assert.equal(
      head(store.recent(1)).body,
      "LGTM",
      "append-only: the first write wins, no in-place update",
    );
  } finally {
    store.close();
  }
});

test("a multi-event delivery keeps one row per ordinal; a redelivery is a no-op", () => {
  const store = openLiveStore(":memory:");
  try {
    const delivery = "push-1";
    const base = makeInput({
      event_id: delivery,
      delivery: {
        delivery_id: delivery,
        event_header: "push",
        signature_status: "verified",
      },
    });
    const s0 = appendNew(store, { ...base, title: "commit a" }, 0);
    const s1 = appendNew(store, { ...base, title: "commit b" }, 1);
    const s2 = appendNew(store, { ...base, title: "commit c" }, 2);
    assert.ok(s1 > s0 && s2 > s1, "each ordinal gets its own monotonic seq");
    assert.equal(store.recent(100).length, 3, "one row per ordinal");
    assert.equal(
      store.append({ ...base, title: "commit a (redelivered)" }, 0),
      null,
      "redelivery of ordinal 0 returns null",
    );
    assert.equal(store.recent(100).length, 3, "redelivery adds no rows");
    assert.deepEqual(
      store
        .recent(100)
        .map((e) => e.title)
        .sort(),
      ["commit a", "commit b", "commit c"],
    );
  } finally {
    store.close();
  }
});

test("since returns only rows after the cursor, ascending, bounded by limit", () => {
  const store = openLiveStore(":memory:");
  try {
    const seqs: number[] = [];
    for (let i = 1; i <= 5; i++) seqs.push(appendNew(store, ev(i)));
    assert.deepEqual(
      store.since(at(seqs, 1)).map((e) => e.seq),
      [at(seqs, 2), at(seqs, 3), at(seqs, 4)],
    );
    assert.equal(store.since(at(seqs, 4)).length, 0);
    assert.deepEqual(
      store.since(0).map((e) => e.event_id),
      ["d-1", "d-2", "d-3", "d-4", "d-5"],
    );
    assert.equal(store.since(0, 2).length, 2);
  } finally {
    store.close();
  }
});

test("recent returns newest-first, bounded by limit", () => {
  const store = openLiveStore(":memory:");
  try {
    for (let i = 1; i <= 5; i++) store.append(ev(i));
    assert.deepEqual(
      store.recent(3).map((e) => e.event_id),
      ["d-5", "d-4", "d-3"],
    );
  } finally {
    store.close();
  }
});

test("a fully-populated record round-trips through the JSON columns without loss", () => {
  const store = openLiveStore(":memory:");
  try {
    const input = ev(1);
    const inserted = store.append(input);
    assert.ok(inserted);
    const back = head(store.recent(1));
    assert.deepEqual(back, { ...input, schema: LIVE_EVENT_SCHEMA, seq: inserted.seq });
    // append's returned event (broadcast over SSE) must equal the read-back row
    // (snapshot/replay) — the no-re-query broadcast parity invariant.
    assert.deepEqual(inserted, back, "append returns exactly the persisted event");
  } finally {
    store.close();
  }
});

test("cached actor profiles hydrate events whose actor lacks avatar fields", () => {
  const store = openLiveStore(":memory:");
  try {
    const input = ev(1, {
      actor: {
        login: "graysurf",
        display_name: null,
        avatar_url: null,
        profile_url: null,
      },
    });
    const inserted = store.append(input);
    assert.ok(inserted);
    store.upsertActorProfile({
      source_id: "github:github.com",
      provider: "github",
      login: "graysurf",
      display_name: "Gray Surf",
      avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
      profile_url: "https://github.com/graysurf",
      fetched_at: "2026-06-21T00:00:00.000Z",
      expires_at: "2026-06-28T00:00:00.000Z",
      last_error: null,
    });

    const back = head(store.recent(1));
    assert.equal(back.actor?.display_name, "Gray Surf");
    assert.equal(back.actor?.avatar_url, "https://avatars.githubusercontent.com/u/1?v=4");
    assert.equal(back.actor?.profile_url, "https://github.com/graysurf");
  } finally {
    store.close();
  }
});

test("webhook-provided actor avatars seed the profile cache for later rows", () => {
  const store = openLiveStore(":memory:");
  try {
    store.append(ev(1, {
      actor: {
        login: "octocat",
        display_name: "The Octocat",
        avatar_url: "https://avatars.githubusercontent.com/u/583231?v=4",
        profile_url: "https://github.com/octocat",
      },
    }));
    store.append(ev(2, {
      actor: {
        login: "octocat",
        display_name: null,
        avatar_url: null,
        profile_url: null,
      },
    }));

    const latest = head(store.recent(1));
    assert.equal(latest.event_id, "d-2");
    assert.equal(latest.actor?.display_name, "The Octocat");
    assert.equal(latest.actor?.avatar_url, "https://avatars.githubusercontent.com/u/583231?v=4");
    assert.equal(latest.actor?.profile_url, "https://github.com/octocat");
  } finally {
    store.close();
  }
});

test("a minimal record reads back with nullable fields as null", () => {
  const store = openLiveStore(":memory:");
  try {
    const minimal: LiveEventInput = {
      event_id: "m-1",
      source_id: "github:github.com",
      provider: "github",
      received_at: "2026-06-20T00:00:00Z",
      event_type: "issues",
      category: "issue",
      delivery: {
        delivery_id: "m-1",
        event_header: "issues",
        signature_status: "verified",
      },
    };
    const inserted = store.append(minimal);
    assert.ok(inserted);
    const back = head(store.recent(1));
    assert.deepEqual(inserted, back, "append returns exactly the persisted event");
    assert.deepEqual(back, {
      schema: LIVE_EVENT_SCHEMA,
      seq: inserted.seq,
      event_id: "m-1",
      source_id: "github:github.com",
      provider: "github",
      received_at: "2026-06-20T00:00:00Z",
      occurred_at: null,
      event_type: "issues",
      action: null,
      category: "issue",
      actor: null,
      target: null,
      title: null,
      body: null,
      url: null,
      review_state: null,
      delivery: {
        delivery_id: "m-1",
        event_header: "issues",
        signature_status: "verified",
      },
      provider_details: null,
      raw: null,
    });
  } finally {
    store.close();
  }
});

test("NUL bytes are stripped from text and SSE ids are NUL-free", () => {
  const store = openLiveStore(":memory:");
  try {
    const inserted = store.append(
      ev(7, { body: `line1${NUL}line2`, title: `t${NUL}` }),
    );
    assert.ok(inserted);
    const back = head(store.recent(1));
    assert.equal(back.body, "line1line2");
    assert.equal(back.title, "t");
    // The returned (broadcast) event has NUL stripped too — storage parity.
    assert.equal(inserted.body, "line1line2");
    assert.equal(inserted.title, "t");
    assert.ok(!String(back.seq).includes(NUL), "the SSE id: value is NUL-free");
    assert.equal(back.seq, inserted.seq);
  } finally {
    store.close();
  }
});

test("stripNul removes only NUL bytes and preserves other whitespace", () => {
  assert.equal(stripNul(`a${NUL}b\tc\nd`), "ab\tc\nd");
  assert.equal(stripNul(null), null);
  assert.equal(stripNul(undefined), null);
});

test("toProviderNumber string-encodes integers beyond MAX_SAFE_INTEGER", () => {
  assert.equal(toProviderNumber(305), 305);
  assert.equal(toProviderNumber(null), null);
  assert.equal(toProviderNumber(undefined), null);
  assert.equal(toProviderNumber("12345678901234567890"), "12345678901234567890");
  assert.equal(toProviderNumber(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  assert.equal(toProviderNumber(9007199254740993n), "9007199254740993");
});

test("isLiveEvent validates the live-event/1 tag and required fields", () => {
  const store = openLiveStore(":memory:");
  try {
    store.append(ev(1));
    const rec = head(store.recent(1));
    assert.ok(isLiveEvent(rec));
    assert.equal(rec.schema, LIVE_EVENT_SCHEMA);
    assert.ok(!isLiveEvent({ ...rec, schema: "live-event/2" }));
    assert.ok(!isLiveEvent({ ...rec, event_id: 123 }));
    assert.ok(!isLiveEvent({ ...rec, delivery: undefined }));
    assert.ok(!isLiveEvent(null));
    assert.ok(!isLiveEvent("nope"));
  } finally {
    store.close();
  }
});

test("each LiveStore is self-contained: separate stores do not share rows", () => {
  const a = openLiveStore(":memory:");
  const b = openLiveStore(":memory:");
  try {
    a.append(ev(1));
    assert.equal(a.recent(100).length, 1);
    assert.equal(b.recent(100).length, 0);
  } finally {
    a.close();
    b.close();
  }
});

test("the live subsystem imports neither the canonical store, contract, tokens, nor config", () => {
  const liveDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "live",
  );
  for (const f of ["store.ts", "types.ts", "prune.ts"]) {
    const src = readFileSync(resolve(liveDir, f), "utf8");
    assert.ok(
      !/from\s+["'][^"']*db\/store/.test(src),
      `${f} must not import the canonical store`,
    );
    assert.ok(
      !/from\s+["'][^"']*db\/(sqlite|postgres|factory)/.test(src),
      `${f} must not import a canonical driver`,
    );
    assert.ok(
      !/from\s+["'][^"']*@symphony-board\/contract/.test(src),
      `${f} must not import the product contract`,
    );
    assert.ok(
      !/acquireWriterLease|releaseWriterLease/.test(src),
      `${f} must not reference the canonical writer lease`,
    );
    assert.ok(
      !/_TOKEN/.test(src),
      `${f} must not reference a provider token`,
    );
    assert.ok(
      !/loadConfig|sources\.json/.test(src),
      `${f} must not load provider config`,
    );
  }
});

test("resolvePruneConfig uses documented defaults and honors env overrides", () => {
  const def = resolvePruneConfig({});
  assert.equal(def.ttlDays, 30);
  assert.ok(def.maxRows > 0);
  assert.ok(def.intervalMs > 0);
  const over = resolvePruneConfig({
    LIVE_EVENT_TTL_DAYS: "7",
    LIVE_MAX_ROWS: "100",
    LIVE_PRUNE_INTERVAL_MS: "1000",
  });
  assert.equal(over.ttlDays, 7);
  assert.equal(over.maxRows, 100);
  assert.equal(over.intervalMs, 1000);
});

test("prune drops rows older than the TTL, keeps newer rows and the max seq", () => {
  const store = openLiveStore(":memory:");
  try {
    store.append(ev(1, { received_at: "2026-01-01T00:00:00Z" }));
    store.append(ev(2, { received_at: "2026-01-02T00:00:00Z" }));
    store.append(ev(3, { received_at: "2026-06-20T00:00:00Z" }));
    store.append(ev(4, { received_at: "2026-06-20T01:00:00Z" }));
    store.append(ev(5, { received_at: "2026-06-20T02:00:00Z" }));
    const now = new Date("2026-06-20T03:00:00Z");
    const deleted = store.prune(30, 100000, now);
    assert.equal(deleted, 2);
    assert.deepEqual(
      store
        .recent(100)
        .map((e) => e.event_id)
        .sort(),
      ["d-3", "d-4", "d-5"],
    );
    assert.equal(store.maxSeq(), 5);
    const replayed = store.since(0).map((e) => e.event_id);
    assert.ok(!replayed.includes("d-1") && !replayed.includes("d-2"));
  } finally {
    store.close();
  }
});

test("prune enforces the row cap oldest-first; replay never returns a pruned row", () => {
  const store = openLiveStore(":memory:");
  try {
    for (let i = 1; i <= 10; i++) {
      store.append(ev(i, { received_at: "2026-06-20T00:00:00Z" }));
    }
    const now = new Date("2026-06-20T00:10:00Z");
    const deleted = store.prune(3650, 5, now);
    assert.equal(deleted, 5);
    assert.deepEqual(
      store.since(0).map((e) => e.event_id),
      ["d-6", "d-7", "d-8", "d-9", "d-10"],
    );
  } finally {
    store.close();
  }
});

test("startPruneTimer prunes on an interval and stops cleanly", async () => {
  const store = openLiveStore(":memory:");
  const stop = startPruneTimer(store, {
    ttlDays: 3650,
    maxRows: 3,
    intervalMs: 5,
  });
  try {
    for (let i = 1; i <= 8; i++) {
      store.append(ev(i, { received_at: "2026-06-20T00:00:00Z" }));
    }
    await until(() => store.recent(100).length <= 3);
    assert.equal(store.recent(100).length, 3);
  } finally {
    stop();
    store.close();
  }
});
