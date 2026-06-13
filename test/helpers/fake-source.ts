// Network-free Source fakes shared by the runner tests and the Postgres live
// e2e: a FakeSource returns a prebuilt FetchResult and normalizes from a map,
// so the engine/runner orchestration runs offline against any Store driver.
// Lives under test/helpers/ (outside the `test/*.test.ts` glob) — helpers, not
// a suite.

import type { SourceConfig } from "../../src/config.ts";
import type { Source, SourceDescriptor, FetchOptions, FetchResult, RawRecord } from "../../src/sources/types.ts";
import type { CanonicalActivity, CanonicalItem, NormalizedBundle } from "../../src/model/types.ts";
import type { ReconciledEdge } from "../../src/model/edges.ts";
import type { PreparedSource } from "../../src/sync-runner.ts";

export function item(externalId: string, over: Partial<CanonicalItem> = {}): CanonicalItem {
  return {
    sourceId: "fake:test", externalId, kind: "issue", projectPath: "x/y", iid: 1,
    url: "http://x", title: "t", state: "open", stateRaw: "open", stateReason: null,
    isDraft: null, author: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    closedAt: null, mergedAt: null, reviewState: null, ciState: null, mergeState: null,
    openReviewThreads: null, totalReviewThreads: null,
    milestone: null, demand: 0, ...over,
  };
}

export class FakeSource implements Source {
  readonly descriptor: SourceDescriptor;
  readonly normalizerVersion = "fake/1";
  private readonly result: FetchResult;
  private readonly bundles: Map<string, NormalizedBundle>;
  constructor(sourceId: string, result: FetchResult, bundles: Map<string, NormalizedBundle>) {
    this.descriptor = { sourceId, kind: "fake", host: "test", displayName: null };
    this.result = result;
    this.bundles = bundles;
  }
  async fetch(_opts: FetchOptions): Promise<FetchResult> {
    return this.result;
  }
  normalize(raw: RawRecord): NormalizedBundle | null {
    return this.bundles.get(raw.externalId) ?? null;
  }
}

export class BoomSource implements Source {
  readonly descriptor: SourceDescriptor;
  readonly normalizerVersion = "fake/1";
  constructor(sourceId: string) {
    this.descriptor = { sourceId, kind: "fake", host: "test", displayName: null };
  }
  async fetch(): Promise<FetchResult> {
    throw new Error("network down");
  }
  normalize(): NormalizedBundle | null {
    return null;
  }
}

export function sc(sourceId: string): SourceConfig {
  return { source_id: sourceId, kind: "fake", host: "test", token_env: "FAKE_TOKEN", graphql_url: "http://x", projects: ["x/y"] };
}

export interface PreparedOptions {
  complete?: boolean;
  watermark?: string;
  // Per-item extras carried into the normalized bundle, keyed by externalId.
  edges?: Map<string, ReconciledEdge[]>;
  activities?: Map<string, CanonicalActivity[]>;
}

export function prepared(sourceId: string, items: CanonicalItem[], opts: PreparedOptions = {}): PreparedSource {
  // Scope each item to this source so its FK to the sources row resolves (the
  // engine ensures the source from the descriptor's sourceId).
  const scoped = items.map((it) => ({ ...it, sourceId }));
  const records: RawRecord[] = scoped.map((it) => ({
    entityKind: it.kind, externalId: it.externalId, apiVersion: "fake",
    fetchedAt: "2026-06-01T00:00:00Z", payload: it, contentHash: `${it.externalId}:${it.title}`,
  }));
  const bundles = new Map<string, NormalizedBundle>();
  for (const it of scoped) {
    bundles.set(it.externalId, {
      item: it,
      labels: [],
      edges: opts.edges?.get(it.externalId) ?? [],
      activities: opts.activities?.get(it.externalId) ?? [],
    });
  }
  const result: FetchResult = {
    records,
    watermark: opts.watermark ?? "2026-06-01T00:00:00Z",
    complete: opts.complete ?? true,
    error: null,
  };
  return { config: sc(sourceId), source: new FakeSource(sourceId, result, bundles) };
}
