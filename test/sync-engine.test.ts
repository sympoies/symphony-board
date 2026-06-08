import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/open.ts";
import { syncSource } from "../src/sync-engine.ts";
import { listActivities, listLiveItems, listLiveEdges, getWatermark } from "../src/db/repo.ts";
import type { Source, SourceDescriptor, FetchOptions, FetchResult, RawRecord } from "../src/sources/types.ts";
import type { NormalizedBundle, CanonicalActivity, CanonicalItem, CanonicalEdge } from "../src/model/types.ts";

// A fake, network-free Source: records the FetchOptions it was handed (so we can
// assert the full/incremental `since` gating) and normalizes from a prebuilt map
// (so we control exactly what each sweep "sees"). This exercises the engine —
// soft-delete gating, watermark persistence, incremental vs full — offline.

const DESC: SourceDescriptor = { sourceId: "fake:test", kind: "fake", host: "test", displayName: null };
const tick = () => new Promise((r) => setTimeout(r, 5)); // force the wall clock forward

function item(externalId: string, over: Partial<CanonicalItem> = {}): CanonicalItem {
  return {
    sourceId: "fake:test", externalId, kind: "issue", projectPath: "x/y", iid: 1,
    url: "http://x", title: "t", state: "open", stateRaw: "open", stateReason: null,
    isDraft: null, author: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    closedAt: null, mergedAt: null, reviewState: null, ciState: null, mergeState: null,
    milestone: null, demand: 0, ...over,
  };
}

class FakeSource implements Source {
  readonly descriptor = DESC;
  readonly normalizerVersion = "fake/1";
  lastFetch: FetchOptions | null = null;
  private readonly result: FetchResult;
  private readonly bundles: Map<string, NormalizedBundle>;
  constructor(result: FetchResult, bundles: Map<string, NormalizedBundle>) {
    this.result = result;
    this.bundles = bundles;
  }
  async fetch(opts: FetchOptions): Promise<FetchResult> {
    this.lastFetch = opts;
    return this.result;
  }
  normalize(raw: RawRecord): NormalizedBundle | null {
    return this.bundles.get(raw.externalId) ?? null;
  }
}

function build(
  items: CanonicalItem[],
  edges: Record<string, CanonicalEdge[]> = {},
  opts: { complete?: boolean; watermark?: string | null } = {},
): FakeSource {
  const records: RawRecord[] = items.map((it) => ({
    entityKind: it.kind, externalId: it.externalId, apiVersion: "fake",
    fetchedAt: "2026-06-01T00:00:00Z", payload: it, contentHash: it.externalId,
  }));
  const bundles = new Map<string, NormalizedBundle>();
  for (const it of items) bundles.set(it.externalId, { item: it, labels: [], edges: edges[it.externalId] ?? [], activities: [] });
  const result: FetchResult = {
    records, watermark: opts.watermark ?? "2026-06-01T00:00:00Z", complete: opts.complete ?? true, error: null,
  };
  return new FakeSource(result, bundles);
}

function activity(externalId: string, over: Partial<CanonicalActivity> = {}): CanonicalActivity {
  return {
    sourceId: "fake:test",
    externalId,
    kind: "commit",
    action: "committed",
    projectPath: "x/y",
    targetKind: "commit",
    target: null,
    targetIid: null,
    title: "Commit title",
    url: "http://x/commit",
    actor: "a",
    occurredAt: "2026-06-01T00:00:00Z",
    summary: "Committed abc1234",
    details: { sha: "abc1234" },
    ...over,
  };
}

function activitySource(activities: CanonicalActivity[]): FakeSource {
  const records: RawRecord[] = activities.map((a) => ({
    entityKind: "activity",
    externalId: a.externalId,
    apiVersion: "fake",
    fetchedAt: "2026-06-01T00:00:00Z",
    payload: a,
    contentHash: a.externalId,
  }));
  const bundles = new Map<string, NormalizedBundle>();
  for (const a of activities) bundles.set(a.externalId, { item: null, labels: [], edges: [], activities: [a] });
  return new FakeSource(
    { records, watermark: "2026-06-01T00:00:00Z", complete: true, error: null },
    bundles,
  );
}

test("the engine forwards full + the prior watermark to the source's fetch", async () => {
  // The engine is a forwarder: it hands the source { full, since: prevWatermark }
  // and lets the source decide what to do (the source nulls `since` on a full
  // sweep — see sources.test.ts; the CLI passes a null prev on full).
  const db = openDb(":memory:");
  const incr = build([item("A")]);
  await syncSource(db, incr, "PRIOR", { full: false, dryRun: false });
  assert.equal(incr.lastFetch?.full, false);
  assert.equal(incr.lastFetch?.since, "PRIOR", "incremental carries the watermark to the source");

  const full = build([item("A")]);
  await syncSource(db, full, null, { full: true, dryRun: false });
  assert.equal(full.lastFetch?.full, true, "full sweep is marked full");
  db.close();
});

test("the new watermark is persisted to sync_state for the next incremental run", async () => {
  const db = openDb(":memory:");
  await syncSource(db, build([item("A")], {}, { watermark: "2026-06-05T00:00:00Z" }), null, { full: true, dryRun: false });
  assert.equal(getWatermark(db, "fake:test"), "2026-06-05T00:00:00Z");
  db.close();
});

test("the engine persists activity-only records without counting them as items", async () => {
  const db = openDb(":memory:");
  const rep = await syncSource(db, activitySource([activity("A1")]), null, { full: false, dryRun: false });
  assert.equal(rep.itemsSeen, 0);
  assert.equal(rep.activitiesSeen, 1);
  const rows = listActivities(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.external_id, "A1");
  assert.deepEqual(JSON.parse(rows[0]!.details ?? "{}"), { sha: "abc1234" });
  db.close();
});

test("only a full+complete sweep deletes; incremental and partial sweeps never do", async () => {
  const db = openDb(":memory:");
  const edgeAB: CanonicalEdge = {
    type: "closes",
    from: { sourceId: "fake:test", externalId: "A" },
    to: { sourceId: "fake:test", externalId: "B" },
    fromState: "merged", toState: "closed",
  };
  // Seed two items + the edge between them.
  await syncSource(
    db,
    build([item("A", { kind: "change_request", state: "merged" }), item("B", { state: "closed" })], { A: [edgeAB] }),
    null,
    { full: true, dryRun: false },
  );
  assert.equal(listLiveItems(db).length, 2);
  assert.equal(listLiveEdges(db).length, 1);

  await tick(); // ensure later sweeps start strictly after the seed's last_seen_at

  // An incremental sweep that sees nothing must NOT delete the unseen items/edge.
  const incr = await syncSource(db, build([]), "wm", { full: false, dryRun: false });
  assert.equal(incr.softDeleted, 0);
  assert.equal(incr.softDeletedEdges, 0);
  assert.equal(listLiveItems(db).length, 2, "incremental never tombstones");

  // A partial (incomplete) full sweep must NOT delete either.
  const partial = await syncSource(db, build([], {}, { complete: false }), null, { full: true, dryRun: false });
  assert.equal(partial.status, "partial");
  assert.equal(partial.softDeleted, 0);
  assert.equal(listLiveItems(db).length, 2, "a partial sweep never tombstones");

  // A full + complete sweep that sees nothing tombstones both items and the edge.
  const full = await syncSource(db, build([]), null, { full: true, dryRun: false });
  assert.equal(full.status, "ok");
  assert.equal(full.softDeleted, 2);
  assert.equal(full.softDeletedEdges, 1);
  assert.equal(listLiveItems(db).length, 0);
  assert.equal(listLiveEdges(db).length, 0);
  db.close();
});

// A source whose fetch throws: it reports error and tombstones NOTHING, even on a
// full sweep — a failed fetch must never be mistaken for a mass deletion (the
// same invariant as the partial sweep above, via the error path).
class BoomSource implements Source {
  readonly descriptor = DESC;
  readonly normalizerVersion = "fake/1";
  async fetch(): Promise<FetchResult> {
    throw new Error("network down");
  }
  normalize(): NormalizedBundle | null {
    return null;
  }
}

test("a failed fetch reports error, persists the error, and deletes nothing (even full)", async () => {
  const db = openDb(":memory:");
  await syncSource(db, build([item("A")]), null, { full: true, dryRun: false }); // seed one live item
  assert.equal(listLiveItems(db).length, 1);
  await tick();

  const rep = await syncSource(db, new BoomSource(), "wm", { full: true, dryRun: false });
  assert.equal(rep.status, "error");
  assert.equal(rep.error, "network down");
  assert.equal(rep.watermark, null, "a failed fetch advances no watermark");
  assert.equal(rep.softDeleted, 0);
  assert.equal(listLiveItems(db).length, 1, "a failed fetch never tombstones");
  // The error is persisted, but the prior good watermark is NOT clobbered.
  assert.equal(getWatermark(db, "fake:test"), "2026-06-01T00:00:00Z");
  db.close();
});

test("a dry-run fetch error reports error but writes nothing", async () => {
  const db = openDb(":memory:");
  const rep = await syncSource(db, new BoomSource(), null, { full: true, dryRun: true });
  assert.equal(rep.status, "error");
  assert.equal(rep.error, "network down");
  assert.equal(getWatermark(db, "fake:test"), null, "dry-run never touches sync_state");
  db.close();
});
