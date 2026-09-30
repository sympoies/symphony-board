import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { openSqliteStore } from "../src/db/sqlite.ts";
import { syncSource } from "../src/sync-engine.ts";
import { GitHubSource } from "../src/sources/github.ts";
import type { GqlClient } from "../src/sources/graphql.ts";
import { buildContractEnvelope } from "../src/contract/emit.ts";
import { validateContract } from "../src/contract/validate.ts";
import type { CommitFilesCandidate, CommitFilesFetchResult, Source, SourceDescriptor, FetchOptions, FetchResult, RawRecord } from "../src/sources/types.ts";
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
    url: "http://x", title: "t", body: null, state: "open", stateRaw: "open", stateReason: null,
    isDraft: null, author: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    closedAt: null, mergedAt: null, reviewState: null, ciState: null, mergeState: null,
    openReviewThreads: null, totalReviewThreads: null,
    milestone: null, demand: 0, ...over,
    commentTotal: over.commentTotal ?? null,
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

class RefreshingFakeSource extends FakeSource {
  refreshCalls: unknown[][] = [];
  private readonly refreshResult: FetchResult;
  constructor(result: FetchResult, bundles: Map<string, NormalizedBundle>, refreshResult: FetchResult) {
    super(result, bundles);
    this.refreshResult = refreshResult;
  }
  async fetchRefresh(candidates: unknown[]): Promise<FetchResult> {
    this.refreshCalls.push(candidates);
    return this.refreshResult;
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
    actorKey: "provider-user:fake:test:a",
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
  const db = await openSqliteStore(":memory:");
  const incr = build([item("A")]);
  await syncSource(db, incr, "PRIOR", { full: false, dryRun: false });
  assert.equal(incr.lastFetch?.full, false);
  assert.equal(incr.lastFetch?.since, "PRIOR", "incremental carries the watermark to the source");

  const full = build([item("A")]);
  await syncSource(db, full, null, { full: true, dryRun: false });
  assert.equal(full.lastFetch?.full, true, "full sweep is marked full");
  await db.close();
});

test("the new watermark is persisted to sync_state for the next incremental run", async () => {
  const db = await openSqliteStore(":memory:");
  await syncSource(db, build([item("A")], {}, { watermark: "2026-06-05T00:00:00Z" }), null, { full: true, dryRun: false });
  assert.equal(await db.getWatermark("fake:test"), "2026-06-05T00:00:00Z");
  await db.close();
});

test("a source watermark newer than the run start is capped for the next incremental run", async () => {
  const db = await openSqliteStore(":memory:");
  const before = new Date().toISOString();

  await syncSource(
    db,
    build([item("A")], {}, { watermark: "9999-01-01T00:00:00Z" }),
    null,
    { full: true, dryRun: false },
  );

  const after = new Date().toISOString();
  const watermark = await db.getWatermark("fake:test");
  assert.ok(watermark, "watermark was persisted");
  assert.ok(watermark >= before, `watermark ${watermark} should be at or after test start ${before}`);
  assert.ok(watermark <= after, `watermark ${watermark} should be capped before test end ${after}`);
  await db.close();
});

test("a whole-second source watermark before the run start is not capped forward", async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-06-12T12:00:00.500Z") });
  const db = await openSqliteStore(":memory:");
  try {
    await syncSource(
      db,
      build([item("A")], {}, { watermark: "2026-06-12T12:00:00Z" }),
      null,
      { full: true, dryRun: false },
    );

    assert.equal(await db.getWatermark("fake:test"), "2026-06-12T12:00:00Z");
  } finally {
    await db.close();
    mock.timers.reset();
  }
});

test("the engine persists activity-only records without counting them as items", async () => {
  const db = await openSqliteStore(":memory:");
  const rep = await syncSource(db, activitySource([activity("A1")]), null, { full: false, dryRun: false });
  assert.equal(rep.itemsSeen, 0);
  assert.equal(rep.activitiesSeen, 1);
  const rows = (await db.listActivities());
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.external_id, "A1");
  assert.deepEqual(JSON.parse(rows[0]!.details ?? "{}"), { sha: "abc1234" });
  await db.close();
});

test("incremental sync refreshes recent pending CI candidates missed by the updatedAt watermark", async () => {
  const db = await openSqliteStore(":memory:");
  await syncSource(
    db,
    build([item("PR_1", {
      kind: "change_request",
      projectPath: "x/y",
      iid: 1,
      state: "merged",
      stateRaw: "MERGED",
      ciState: "pending",
      updatedAt: "2026-06-01T00:00:00Z",
      mergedAt: "2026-06-01T00:00:00Z",
      closedAt: "2026-06-01T00:00:00Z",
    })]),
    null,
    { full: true, dryRun: false },
  );

  const refreshItem = item("PR_1", {
    kind: "change_request",
    projectPath: "x/y",
    iid: 1,
    state: "merged",
    stateRaw: "MERGED",
    ciState: "passing",
    updatedAt: "2026-06-01T00:00:00Z",
    mergedAt: "2026-06-01T00:00:00Z",
    closedAt: "2026-06-01T00:00:00Z",
  });
  const refreshRecords: RawRecord[] = [{
    entityKind: "change_request",
    externalId: refreshItem.externalId,
    apiVersion: "fake",
    fetchedAt: "2026-06-01T00:05:00Z",
    payload: refreshItem,
    contentHash: "refresh",
  }];
  const bundles = new Map<string, NormalizedBundle>([
    [refreshItem.externalId, { item: refreshItem, labels: [], edges: [], activities: [] }],
  ]);
  const source = new RefreshingFakeSource(
    { records: [], watermark: "2026-06-02T00:00:00Z", complete: true, error: null },
    bundles,
    { records: refreshRecords, watermark: null, complete: true, error: null },
  );

  const rep = await syncSource(db, source, "2026-06-02T00:00:00Z", {
    full: false,
    dryRun: false,
    ciRefreshGraceMs: 365 * 86_400_000,
  });

  assert.equal(source.refreshCalls.length, 1, "incremental sync asks the source to refresh stale CI candidates");
  assert.equal(rep.itemsSeen, 1, "refreshed PR is counted as seen");
  assert.equal((await db.listLiveItems()).find((row) => row.external_id === "PR_1")?.ci_state, "passing");
  await db.close();
});

test("only a full+complete sweep deletes; incremental and partial sweeps never do", async () => {
  const db = await openSqliteStore(":memory:");
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
  assert.equal((await db.listLiveItems()).length, 2);
  assert.equal((await db.listLiveEdges()).length, 1);

  await tick(); // ensure later sweeps start strictly after the seed's last_seen_at

  // An incremental sweep that sees nothing must NOT delete the unseen items/edge.
  const incr = await syncSource(db, build([]), "wm", { full: false, dryRun: false });
  assert.equal(incr.softDeleted, 0);
  assert.equal(incr.softDeletedEdges, 0);
  assert.equal((await db.listLiveItems()).length, 2, "incremental never tombstones");

  // A partial (incomplete) full sweep must NOT delete either.
  const partial = await syncSource(db, build([], {}, { complete: false }), null, { full: true, dryRun: false });
  assert.equal(partial.status, "partial");
  assert.equal(partial.softDeleted, 0);
  assert.equal((await db.listLiveItems()).length, 2, "a partial sweep never tombstones");

  // A full + complete sweep that sees nothing tombstones both items and the edge.
  const full = await syncSource(db, build([]), null, { full: true, dryRun: false });
  assert.equal(full.status, "ok");
  assert.equal(full.softDeleted, 2);
  assert.equal(full.softDeletedEdges, 1);
  assert.equal((await db.listLiveItems()).length, 0);
  assert.equal((await db.listLiveEdges()).length, 0);
  await db.close();
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
  const db = await openSqliteStore(":memory:");
  await syncSource(db, build([item("A")]), null, { full: true, dryRun: false }); // seed one live item
  assert.equal((await db.listLiveItems()).length, 1);
  await tick();

  const rep = await syncSource(db, new BoomSource(), "wm", {
    full: true,
    dryRun: false,
    graphqlRequestCount: () => 4,
    graphqlCost: () => 9,
    graphqlCostUnknown: () => 1,
  });
  assert.equal(rep.status, "error");
  assert.equal(rep.error, "network down");
  assert.equal(rep.graphqlRequests, 4);
  assert.equal(rep.graphqlCost, 9);
  assert.equal(rep.graphqlCostUnknown, 1);
  assert.equal(rep.watermark, null, "a failed fetch advances no watermark");
  assert.equal(rep.softDeleted, 0);
  assert.equal((await db.listLiveItems()).length, 1, "a failed fetch never tombstones");
  const run = (await db.overview(10)).sync_runs[0]!;
  assert.equal(run.graphql_requests, 4);
  assert.equal(run.graphql_cost, 9);
  assert.equal(run.graphql_cost_unknown, 1);
  // The error is persisted, but the prior good watermark is NOT clobbered.
  assert.equal(await db.getWatermark("fake:test"), "2026-06-01T00:00:00Z");
  await db.close();
});

test("a dry-run fetch error reports error but writes nothing", async () => {
  const db = await openSqliteStore(":memory:");
  const rep = await syncSource(db, new BoomSource(), null, { full: true, dryRun: true });
  assert.equal(rep.status, "error");
  assert.equal(rep.error, "network down");
  assert.equal(await db.getWatermark("fake:test"), null, "dry-run never touches sync_state");
  await db.close();
});

// A source whose normalize throws (a malformed payload tripping a normalizer
// bug): a SOURCE failure like a failed fetch — reported and persisted as an
// error run, never a process crash, and never a tombstone.
class NormalizeBoomSource implements Source {
  readonly descriptor = DESC;
  readonly normalizerVersion = "fake/1";
  async fetch(): Promise<FetchResult> {
    const records: RawRecord[] = [{
      entityKind: "issue", externalId: "A", apiVersion: "fake",
      fetchedAt: "2026-06-09T00:00:00Z", payload: { junk: true }, contentHash: "junk",
    }];
    return { records, watermark: "2026-06-09T00:00:00Z", complete: true, error: null };
  }
  normalize(): NormalizedBundle | null {
    throw new Error("bad payload shape");
  }
}

test("a normalize() throw is a source error: reported, persisted, and deletes nothing (even full)", async () => {
  const db = await openSqliteStore(":memory:");
  await syncSource(db, build([item("A")]), null, { full: true, dryRun: false }); // seed one live item
  await tick();

  const rep = await syncSource(db, new NormalizeBoomSource(), null, { full: true, dryRun: false });
  assert.equal(rep.status, "error");
  assert.match(rep.error ?? "", /normalize: bad payload shape/);
  assert.equal(rep.watermark, null, "a crashed normalize advances no watermark");
  assert.equal(rep.softDeleted, 0);
  assert.equal((await db.listLiveItems()).length, 1, "a normalizer crash never tombstones");
  // Persisted like a failed fetch; the prior good watermark survives.
  assert.equal(await db.getWatermark("fake:test"), "2026-06-01T00:00:00Z");
  await db.close();
});

test("a dry-run normalize() throw reports error but writes nothing", async () => {
  const db = await openSqliteStore(":memory:");
  const rep = await syncSource(db, new NormalizeBoomSource(), null, { full: true, dryRun: true });
  assert.equal(rep.status, "error");
  assert.match(rep.error ?? "", /normalize: bad payload shape/);
  assert.equal(await db.getWatermark("fake:test"), null, "dry-run never touches sync_state");
  await db.close();
});

// --- program tracker edges through the real GitHub source ---------------------
//
// A tracker issue reports `parent` (tracker -> row issue) and `blocks`
// (prerequisite -> dependent) from its phase table. They are ordinary
// intra-source edges, so the disappearance rule above governs them: a row
// removed from the tracker is "an edge not re-emitted", and only a full +
// complete sweep may read that as gone.

const GH_DESC: SourceDescriptor = { sourceId: "github:github.com", kind: "github", host: "github.com", displayName: null };

function ghIssue(id: string, number: number, state: "OPEN" | "CLOSED", body: string) {
  return {
    __typename: "Issue", id, number, title: id, body, url: `https://x/${id}`, state,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-06-10T00:00:00Z", closedAt: null, stateReason: null,
    author: { login: "a" }, repository: { nameWithOwner: "o/r" },
    labels: { nodes: [] }, comments: { totalCount: 0 }, reactions: { totalCount: 0 },
    closedByPullRequestsReferences: { nodes: [] },
  };
}

test("a row removed from a tracker tombstones its edges only on a full + complete sweep", async () => {
  const db = await openSqliteStore(":memory:");
  const twoRows = "## Phase table\n\n- [x] **A** First: #2\n- [ ] **B** Second: #3 · after A\n";
  const oneRow = "## Phase table\n\n- [x] **A** First: #2\n";
  let body = twoRows;
  let failLookup = false;
  const gql: GqlClient = (async (query: string) => {
    if (query.includes("issueOrPullRequest(")) {
      if (failLookup) throw new Error("GraphQL HTTP 502: Bad Gateway");
      const data: Record<string, unknown> = {};
      for (const m of query.matchAll(/(t\d+): repository\(owner:"o", name:"r"\) \{ issueOrPullRequest\(number:(\d+)\)/g)) {
        // The lookup's own state snapshot says OPEN for both; #2 is CLOSED on
        // the item this same sweep fetched.
        data[m[1]!] = { issueOrPullRequest: { __typename: "Issue", id: `I_${m[2]}`, state: "OPEN" } };
      }
      return data;
    }
    if (query.includes("pullRequests(")) {
      return { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
    }
    return {
      repository: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [ghIssue("I_tracker", 1, "OPEN", body), ghIssue("I_2", 2, "CLOSED", "first"), ghIssue("I_3", 3, "OPEN", "second")],
        },
      },
    };
  }) as GqlClient;
  const source = new GitHubSource(GH_DESC, gql, ["o/r"]);
  const live = async () =>
    (await db.listLiveEdges()).map((e) => `${e.type}:${e.from_external_id}>${e.to_external_id}`).sort();
  const ALL = ["blocks:I_2>I_3", "parent:I_tracker>I_2", "parent:I_tracker>I_3"];

  const seed = await syncSource(db, source, null, { full: true, dryRun: false });
  assert.equal(seed.status, "ok");
  assert.equal(seed.edgesSeen, 3);
  assert.deepEqual(await live(), ALL);
  const blocks = (await db.listLiveEdges()).find((e) => e.type === "blocks")!;
  assert.equal(blocks.from_source_id, "github:github.com");
  assert.equal(blocks.to_source_id, "github:github.com", "tracker edges are intra-source, so the sweep rule covers them");
  assert.deepEqual(
    [blocks.from_state, blocks.to_state, blocks.lifecycle],
    ["closed", "open", null],
    "an edge the tracker reports between two OTHER items takes their states from the items seen this run",
  );

  // Store -> contract: they are emitted as ordinary open-vocabulary edges.
  const env = await buildContractEnvelope(
    db,
    { db_path: "unused.db", sources: [{ source_id: "github:github.com", kind: "github", host: "github.com", token_env: "T", graphql_url: "http://x", projects: ["o/r"] }] },
    "2026-06-11T00:00:00.000Z",
    { itemWindow: "full" },
  );
  assert.deepEqual(validateContract(env), []);
  assert.deepEqual(
    env.edges.map((e) => [e.type, e.from, e.to, e.from_state, e.to_state, e.lifecycle]).sort(),
    [
      ["blocks", "github:github.com|I_2", "github:github.com|I_3", "closed", "open", null],
      ["parent", "github:github.com|I_tracker", "github:github.com|I_2", "open", "closed", null],
      ["parent", "github:github.com|I_tracker", "github:github.com|I_3", "open", "open", null],
    ],
  );

  await tick(); // ensure later sweeps start strictly after the seed's last_seen_at
  body = oneRow; // row B leaves the tracker: parent ->I_3 and blocks I_2->I_3 are no longer reported

  const incr = await syncSource(db, source, "2026-03-01T00:00:00Z", { full: false, dryRun: false });
  assert.equal(incr.status, "ok");
  assert.equal(incr.softDeletedEdges, 0);
  assert.deepEqual(await live(), ALL, "an incremental sweep never tombstones a removed row's edges");

  failLookup = true;
  const partial = await syncSource(db, source, null, { full: true, dryRun: false });
  assert.equal(partial.status, "partial", "a failed ref lookup leaves the full sweep incomplete");
  assert.equal(partial.softDeletedEdges, 0);
  assert.deepEqual(await live(), ALL, "a tracker whose refs could not be resolved never tombstones its edges");
  failLookup = false;

  await tick();
  const full = await syncSource(db, source, null, { full: true, dryRun: false });
  assert.equal(full.status, "ok");
  assert.equal(full.softDeletedEdges, 2);
  assert.deepEqual(await live(), ["parent:I_tracker>I_2"], "a full + complete sweep tombstones the removed row's edges");

  body = twoRows;
  const back = await syncSource(db, source, null, { full: true, dryRun: false });
  assert.equal(back.softDeletedEdges, 0);
  assert.deepEqual(await live(), ALL, "a re-added row revives its edges");
  await db.close();
});

test("a tracker whose rows name a repository the board does not track adds nothing to store, payload, or aggregates", async () => {
  // Tracker refs are resolved only into the source's configured repositories,
  // so the contract never has to account for a tracker edge between two items
  // it cannot emit: the payload and the aggregate counts agree on "none".
  const db = await openSqliteStore(":memory:");
  const body = "## Phase table\n\n- [x] **A** First: o/elsewhere#2\n- [ ] **B** Second: o/elsewhere#3 · after A\n";
  const lookups: string[] = [];
  const gql: GqlClient = (async (query: string) => {
    if (query.includes("issueOrPullRequest(")) {
      // The sync token could read them; the board must not ask.
      lookups.push(query);
      const data: Record<string, unknown> = {};
      for (const m of query.matchAll(/(t\d+): repository\([^)]*\) \{ issueOrPullRequest\(number:(\d+)\)/g)) {
        data[m[1]!] = { issueOrPullRequest: { __typename: "Issue", id: `I_elsewhere_${m[2]}`, state: "OPEN" } };
      }
      return data;
    }
    if (query.includes("pullRequests(")) {
      return { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
    }
    return { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [ghIssue("I_tracker", 1, "OPEN", body)] } } };
  }) as GqlClient;

  const rep = await syncSource(db, new GitHubSource(GH_DESC, gql, ["o/r"]), null, { full: true, dryRun: false });
  assert.equal(rep.status, "ok");
  assert.deepEqual(lookups, [], "no lookup leaves for a repository outside the source's projects");
  assert.equal(rep.edgesSeen, 0);
  assert.deepEqual(await db.listLiveEdges(), []);

  const env = await buildContractEnvelope(
    db,
    { db_path: "unused.db", sources: [{ source_id: "github:github.com", kind: "github", host: "github.com", token_env: "T", graphql_url: "http://x", projects: ["o/r"] }] },
    "2026-06-11T00:00:00.000Z",
    { itemWindow: "full" },
  );
  assert.deepEqual(validateContract(env), []);
  assert.deepEqual(env.items.map((item) => item.external_id), ["I_tracker"]);
  assert.deepEqual(env.edges, []);
  assert.ok((env.aggregates ?? []).length > 0);
  for (const aggregate of env.aggregates ?? []) {
    assert.deepEqual(aggregate.stats.by_lifecycle, {}, `${aggregate.scope} ${aggregate.window.kind} counts no edge the payload does not carry`);
  }
  await db.close();
});

// --- commit file enrichment ---------------------------------------------------

// A source that can also answer for commit files. The engine hands it the
// commits the store has no answer for; it replies with one raw record each,
// which normalize then turns into a canonical file list.
class CommitFilesFakeSource extends FakeSource {
  calls: CommitFilesCandidate[][] = [];
  private readonly answer: (candidates: CommitFilesCandidate[]) => Promise<CommitFilesFetchResult>;
  constructor(result: FetchResult, bundles: Map<string, NormalizedBundle>, answer: (candidates: CommitFilesCandidate[]) => Promise<CommitFilesFetchResult>) {
    super(result, bundles);
    this.answer = answer;
  }
  async fetchCommitFiles(candidates: CommitFilesCandidate[]): Promise<CommitFilesFetchResult> {
    this.calls.push(candidates);
    return this.answer(candidates);
  }
  override normalize(raw: RawRecord): NormalizedBundle | null {
    if (raw.entityKind !== "commit_files") return super.normalize(raw);
    const p = raw.payload as { project: string; sha: string };
    return {
      item: null,
      labels: [],
      edges: [],
      activities: [],
      commitFiles: [
        {
          sourceId: "fake:test",
          externalId: raw.externalId,
          projectPath: p.project,
          sha: p.sha,
          state: "ok",
          truncated: false,
          files: [{ path: `${p.sha}.ts`, status: "modified", additions: 1, deletions: 0 }],
        },
      ],
    };
  }
}

function commitFilesSource(
  activities: CanonicalActivity[],
  answer?: (candidates: CommitFilesCandidate[]) => Promise<CommitFilesFetchResult>,
): CommitFilesFakeSource {
  const records: RawRecord[] = activities.map((a) => ({
    entityKind: "activity", externalId: a.externalId, apiVersion: "fake", fetchedAt: "2026-06-01T00:00:00Z", payload: a, contentHash: a.externalId,
  }));
  const bundles = new Map<string, NormalizedBundle>();
  for (const a of activities) bundles.set(a.externalId, { item: null, labels: [], edges: [], activities: [a] });
  const ok = async (candidates: CommitFilesCandidate[]): Promise<CommitFilesFetchResult> => ({
    records: candidates.map((c) => ({
      entityKind: "commit_files", externalId: c.externalId, apiVersion: "fake", fetchedAt: "2026-06-01T00:00:00Z",
      payload: { project: c.projectPath, sha: c.sha }, contentHash: c.sha,
    })),
    stopped: null,
  });
  return new CommitFilesFakeSource({ records, watermark: "2026-06-01T00:00:00Z", complete: true, error: null }, bundles, answer ?? ok);
}

// Recent enough to be inside the pass's lookback whenever the suite runs.
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const FOUR_COMMITS = (): CanonicalActivity[] => [
  activity("c1", { occurredAt: daysAgo(4), details: { sha: "sha1" } }),
  activity("c2", { occurredAt: daysAgo(3), details: { sha: "sha2" } }),
  activity("c3", { occurredAt: daysAgo(2), details: { sha: "sha3", merge: true } }),
  activity("c4", { occurredAt: daysAgo(1), details: { sha: "sha4" } }),
];
const filesInRange = async (store: Awaited<ReturnType<typeof openSqliteStore>>) =>
  (await store.listCommitFilesInRange(daysAgo(30), daysAgo(0))).map((row) => row.external_id).sort();

test("the file pass asks for unanswered commits after the sweep, newest first and within its limit", async () => {
  const store = await openSqliteStore(":memory:");
  const source = commitFilesSource(FOUR_COMMITS());

  const first = await syncSource(store, source, null, { full: true, dryRun: false, commitFilesLimit: 2 });
  assert.equal(first.status, "ok");
  // The two newest commits are c4 and c3. c3 is a merge, so it is answered
  // without a request; only c4 reaches the source.
  assert.deepEqual(source.calls, [[{ externalId: "c4", projectPath: "x/y", sha: "sha4" }]]);
  assert.equal(first.commitFiles, 2, "both were answered: one read, one recorded as a merge");
  assert.deepEqual(await filesInRange(store), ["c4"], "only a real file list is read back");

  const second = await syncSource(store, source, "2026-06-01T00:00:00Z", { full: false, dryRun: false, commitFilesLimit: 2 });
  assert.deepEqual(source.calls[1], [
    { externalId: "c2", projectPath: "x/y", sha: "sha2" },
    { externalId: "c1", projectPath: "x/y", sha: "sha1" },
  ]);
  assert.equal(second.commitFiles, 2);
  assert.deepEqual(await filesInRange(store), ["c1", "c2", "c4"]);

  const third = await syncSource(store, source, "2026-06-01T00:00:00Z", { full: false, dryRun: false, commitFilesLimit: 2 });
  assert.equal(source.calls.length, 2, "nothing left to ask for");
  assert.equal(third.commitFiles, 0);
  await store.close();
});

test("the file pass is off without a limit, on a dry run, and for a source that cannot answer", async () => {
  const store = await openSqliteStore(":memory:");
  const source = commitFilesSource(FOUR_COMMITS());
  const noLimit = await syncSource(store, source, null, { full: true, dryRun: false });
  assert.equal(noLimit.commitFiles, 0);
  const zero = await syncSource(store, source, null, { full: true, dryRun: false, commitFilesLimit: 0 });
  assert.equal(zero.commitFiles, 0);
  const dry = await syncSource(store, source, null, { full: true, dryRun: true, commitFilesLimit: 5 });
  assert.equal(dry.commitFiles, 0);
  assert.deepEqual(source.calls, []);

  const plain = activitySource(FOUR_COMMITS());
  const report = await syncSource(store, plain, null, { full: true, dryRun: false, commitFilesLimit: 5 });
  assert.equal(report.status, "ok");
  assert.equal(report.commitFiles, 0);
  assert.deepEqual(await filesInRange(store), []);
  await store.close();
});

test("a failing file pass never degrades the sweep it follows", async () => {
  const store = await openSqliteStore(":memory:");
  // A pass that stops part-way keeps what it read and reports why it stopped.
  const partial = commitFilesSource(FOUR_COMMITS(), async (candidates) => ({
    records: [{ entityKind: "commit_files", externalId: candidates[0]!.externalId, apiVersion: "fake", fetchedAt: "2026-06-01T00:00:00Z", payload: { project: "x/y", sha: candidates[0]!.sha }, contentHash: "h" }],
    stopped: "REST HTTP 403: rate limited",
  }));
  const stopped = await syncSource(store, partial, null, { full: true, dryRun: false, commitFilesLimit: 10 });
  assert.equal(stopped.status, "ok", "file data is a decoration: the sweep is still complete");
  assert.equal(stopped.error, null);
  assert.match(stopped.commitFilesError ?? "", /rate limited/);
  assert.deepEqual(await filesInRange(store), ["c4"]);

  // A pass that throws outright changes nothing and is reported the same way.
  const broken = commitFilesSource(FOUR_COMMITS(), async () => {
    throw new Error("socket hang up");
  });
  const threw = await syncSource(store, broken, null, { full: true, dryRun: false, commitFilesLimit: 10 });
  assert.equal(threw.status, "ok");
  assert.match(threw.commitFilesError ?? "", /socket hang up/);
  assert.deepEqual(await filesInRange(store), ["c4"]);
  await store.close();
});

test("the file pass looks back a bounded time and skips a commit with no sha", async () => {
  const store = await openSqliteStore(":memory:");
  const source = commitFilesSource([
    activity("ancient", { occurredAt: daysAgo(800), details: { sha: "old" } }),
    activity("no-sha", { occurredAt: daysAgo(2), details: {} }),
    activity("recent", { occurredAt: daysAgo(1), details: { sha: "new" } }),
  ]);
  const report = await syncSource(store, source, null, { full: true, dryRun: false, commitFilesLimit: 10 });
  assert.deepEqual(source.calls, [[{ externalId: "recent", projectPath: "x/y", sha: "new" }]]);
  assert.equal(report.commitFiles, 2, "the row with no sha is answered as unavailable, so it leaves the queue");
  const again = await syncSource(store, source, null, { full: true, dryRun: false, commitFilesLimit: 10 });
  assert.equal(again.commitFiles, 0);
  assert.equal(source.calls.length, 1);
  await store.close();
});
