import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { EdgeRow, ItemRow, SourceRow } from "../src/db/store.ts";
import type { CanonicalItem } from "../src/model/types.ts";
import type { ReconciledEdge } from "../src/model/edges.ts";
import { openSqliteStore } from "../src/db/sqlite.ts";
import { createRangeApiServer } from "../src/cli/range-api.ts";
import {
  buildGraphNeighborhood,
  coalesceGraphNeighborhoodProjection,
  GRAPH_NEIGHBORHOOD_MAX_DEPTH,
  parseGraphNeighborhoodOptions,
} from "../src/server/graph-neighborhood.ts";
import { GRAPH_FOCUS_MAX_DEPTH } from "../packages/ui/src/model.ts";

const SOURCE = "github:github.com";
const PROJECT = "example/repo";
const source: SourceRow = {
  source_id: SOURCE,
  kind: "github",
  host: "github.com",
  display_name: "GitHub",
  last_success_at: null,
  last_status: "ok",
};

function ref(id: string): string {
  return `${SOURCE}|${id}`;
}

function item(id: string, itemId: number, projectPath = PROJECT): ItemRow {
  return {
    item_id: itemId,
    source_id: SOURCE,
    external_id: id,
    kind: id.startsWith("P") ? "change_request" : "issue",
    project_path: projectPath,
    iid: itemId,
    url: `https://example/${itemId}`,
    title: id,
    body: null,
    state: "open",
    state_raw: "OPEN",
    state_reason: null,
    is_draft: null,
    author: "dev",
    created_at: null,
    updated_at: "2020-01-01T00:00:00Z",
    closed_at: null,
    merged_at: null,
    review_state: null,
    ci_state: null,
    merge_state: null,
    open_review_threads: null,
    total_review_threads: null,
    milestone: null,
    demand: 0,
    comment_total: null,
    last_seen_at: "2026-07-12T00:00:00Z",
  };
}

function edge(from: string, to: string, type = "mentions"): EdgeRow {
  return {
    type,
    from_source_id: SOURCE,
    from_external_id: from,
    to_source_id: SOURCE,
    to_external_id: to,
    from_state: "open",
    to_state: "open",
    lifecycle: type === "closes" ? "declared" : null,
  };
}

function canonicalItem(id: string, iid: number): CanonicalItem {
  return {
    sourceId: SOURCE,
    externalId: id,
    kind: id.startsWith("P") ? "change_request" : "issue",
    projectPath: PROJECT,
    iid,
    url: `https://example/${iid}`,
    title: id,
    body: null,
    state: "open",
    stateRaw: "OPEN",
    stateReason: null,
    isDraft: null,
    author: "dev",
    createdAt: "2020-01-01T00:00:00Z",
    updatedAt: "2020-01-01T00:00:00Z",
    closedAt: null,
    mergedAt: null,
    reviewState: null,
    ciState: null,
    mergeState: null,
    openReviewThreads: null,
    totalReviewThreads: null,
    commentTotal: null,
    milestone: null,
    demand: 0,
  };
}

function reconciledEdge(from: string, to: string): ReconciledEdge {
  return {
    type: "mentions",
    from: { sourceId: SOURCE, externalId: from },
    to: { sourceId: SOURCE, externalId: to },
    fromState: "open",
    toState: "open",
    lifecycle: null,
    discoveredFrom: "from",
  };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function build(ids: string[], edges: EdgeRow[], over: Partial<Parameters<typeof buildGraphNeighborhood>[0]> = {}) {
  return buildGraphNeighborhood({
    sources: [source],
    items: ids.map((id, index) => item(id, index + 1)),
    labels: [],
    edges,
    generatedAt: "2026-07-12T00:00:00Z",
    configuredRepos: [{ source_id: SOURCE, project_path: PROJECT }],
    focusRef: ref(ids[0]!),
    ...over,
  });
}

test("graph neighborhood defaults to five hops and reports a deeper frontier", () => {
  const ids = ["I0", "I1", "I2", "I3", "I4", "I5", "I6"];
  const result = build(ids, ids.slice(0, -1).map((id, index) => edge(id, ids[index + 1]!)));
  assert.equal(result.requested_depth, 5);
  assert.equal(result.reached_depth, 5);
  assert.deepEqual(result.nodes.map((node) => [node.ref, node.hop]), ids.slice(0, 6).map((id, hop) => [ref(id), hop]));
  assert.equal(result.edges.length, 5);
  assert.equal(result.complete, false);
  assert.deepEqual(result.limit_reasons, ["depth"]);
  assert.equal(GRAPH_NEIGHBORHOOD_MAX_DEPTH, GRAPH_FOCUS_MAX_DEPTH);
});

test("graph neighborhood handles cycles and keeps induced multi-type edges deterministically", () => {
  const result = build(
    ["I0", "I1", "I2", "I3"],
    [edge("I2", "I0", "relates"), edge("I0", "I1"), edge("I1", "I2"), edge("I1", "I0", "mentions"), edge("I2", "I3", "closes")],
    { depth: 2 },
  );
  assert.deepEqual(result.nodes.map((node) => [node.ref, node.hop]), [
    [ref("I0"), 0],
    [ref("I1"), 1],
    [ref("I2"), 1],
    [ref("I3"), 2],
  ]);
  assert.equal(new Set(result.nodes.map((node) => node.ref)).size, result.nodes.length);
  assert.deepEqual(result.edges.map((entry) => [entry.type, entry.from, entry.to]), [
    ["mentions", ref("I0"), ref("I1")],
    ["relates", ref("I2"), ref("I0")],
    ["closes", ref("I2"), ref("I3")],
    ["mentions", ref("I1"), ref("I0")],
    ["mentions", ref("I1"), ref("I2")],
  ]);
});

test("graph neighborhood applies deterministic node and edge safety caps", () => {
  const nodeCapped = build(
    ["I0", "I1", "I2", "I3"],
    [edge("I0", "I3"), edge("I0", "I2"), edge("I0", "I1")],
    { maxNodes: 3 },
  );
  assert.deepEqual(nodeCapped.nodes.map((node) => node.ref), [ref("I0"), ref("I1"), ref("I2")]);
  assert.deepEqual(nodeCapped.limit_reasons, ["nodes"]);

  const edgeCapped = build(
    ["I0", "I1", "I2"],
    [edge("I0", "I1"), edge("I0", "I2"), edge("I1", "I2", "relates")],
    { maxEdges: 2 },
  );
  assert.equal(edgeCapped.edges.length, 2);
  assert.deepEqual(edgeCapped.limit_reasons, ["edges"]);
  assert.ok(edgeCapped.edges.every((entry) => entry.from === ref("I0") || entry.to === ref("I0")), "spanning edges win before induced extras");
});

test("graph neighborhood drops items and edges from removed config repos", () => {
  const result = buildGraphNeighborhood({
    sources: [source],
    items: [item("I0", 1), item("I1", 2), item("I2", 3, "removed/repo")],
    labels: [],
    edges: [edge("I0", "I1"), edge("I1", "I2")],
    generatedAt: "2026-07-12T00:00:00Z",
    configuredRepos: [{ source_id: SOURCE, project_path: PROJECT }],
    focusRef: ref("I0"),
  });
  assert.deepEqual(result.nodes.map((node) => node.ref), [ref("I0"), ref("I1")]);
  assert.equal(result.edges.length, 1);
});

test("graph neighborhood options validate ref and depth", () => {
  assert.deepEqual(parseGraphNeighborhoodOptions(new URL("https://x/api/graph-neighborhood?ref=a%7Cb")), {
    focusRef: "a|b",
    depth: 5,
  });
  assert.deepEqual(parseGraphNeighborhoodOptions(new URL("https://x/api/graph-neighborhood?ref=a%7Cb&depth=2")), {
    focusRef: "a|b",
    depth: 2,
  });
  assert.throws(() => parseGraphNeighborhoodOptions(new URL("https://x/api/graph-neighborhood?depth=2")), /ref is required/);
  assert.throws(() => parseGraphNeighborhoodOptions(new URL("https://x/api/graph-neighborhood?ref=x&depth=6")), /1 to 5/);
});

test("identical projections coalesce and the final consumer abort stops the loader", async () => {
  const first = new AbortController();
  const second = new AbortController();
  let loads = 0;
  let laterStages = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loader = async (signal: AbortSignal) => {
    loads++;
    await gate;
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    laterStages++;
    return build(["I0"], [], { depth: 1 });
  };
  const key = `test:${Date.now()}:${Math.random()}`;
  const one = coalesceGraphNeighborhoodProjection(key, loader, first.signal);
  const two = coalesceGraphNeighborhoodProjection(key, loader, second.signal);
  const settled = Promise.allSettled([one, two]);
  assert.equal(loads, 1, "identical callers share one loader");
  first.abort();
  await Promise.resolve();
  second.abort();
  release();
  const results = await settled;
  assert.ok(results.every((result) => result.status === "rejected"));
  assert.equal(laterStages, 0, "the shared loader stops before its next stage after the final consumer aborts");
});

test("range API serves older multi-hop canonical relations through the read-only route", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-neighborhood-api-"));
  const dbPath = join(dir, "data", "board.db");
  const configPath = join(dir, "config", "sources.json");
  const store = await openSqliteStore(dbPath);
  try {
    await store.ensureSource({ sourceId: SOURCE, kind: "github", host: "github.com", displayName: "GitHub" }, "2026-07-12T00:00:00Z");
    for (const [index, id] of ["I0", "I1", "I2"].entries()) {
      await store.upsertItem({ ...canonicalItem(id, index + 1), body: `provider body ${id}` }, "test", "2026-07-12T00:00:00Z");
    }
    await store.upsertEdge(reconciledEdge("I0", "I1"), "2026-07-12T00:00:00Z");
    await store.upsertEdge(reconciledEdge("I1", "I2"), "2026-07-12T00:00:00Z");
  } finally {
    await store.close();
  }
  mkdirSync(join(dir, "config"), { recursive: true });
  writeFileSync(configPath, JSON.stringify({
    db_path: dbPath,
    timezone: "UTC",
    sources: [{
      source_id: SOURCE,
      kind: "github",
      host: "github.com",
      display_name: "GitHub",
      token_env: "GRAPH_NEIGHBORHOOD_TEST_TOKEN_UNSET",
      graphql_url: "https://api.github.com/graphql",
      projects: [PROJECT],
    }],
  }));
  const server = createRangeApiServer({ configPath, contractOut: join(dir, "data", "contract.json") });
  const base = await listen(server);
  try {
    const response = await fetch(`${base}/api/graph-neighborhood?ref=${encodeURIComponent(ref("I0"))}&depth=2`, {
      headers: { "Accept-Encoding": "gzip" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-encoding"), "gzip");
    const body = await response.json() as { schema: string; nodes: Array<{ ref: string; hop: number; item: Record<string, unknown> | null }>; edges: unknown[] };
    assert.equal(body.schema, "symphony-board-graph-neighborhood/1");
    assert.deepEqual(body.nodes.map((node) => [node.ref, node.hop]), [[ref("I0"), 0], [ref("I1"), 1], [ref("I2"), 2]]);
    assert.equal(body.edges.length, 2);
    assert.ok(body.nodes.every((node) => node.item === null || !("body" in node.item)), "Graph payload omits unused provider bodies");
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});
