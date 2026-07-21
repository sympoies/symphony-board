import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openSqliteStore } from "../src/db/sqlite.ts";
import { syncSource } from "../src/sync-engine.ts";
import { ForgejoSource } from "../src/sources/forgejo.ts";
import type { RestClient } from "../src/sources/rest.ts";
import type { SourceDescriptor } from "../src/sources/types.ts";

const descriptor: SourceDescriptor = {
  sourceId: "forgejo:codeberg.org",
  kind: "forgejo",
  host: "codeberg.org",
  displayName: "Codeberg",
};

function fixture(name: string): any {
  return JSON.parse(readFileSync(new URL(`./fixtures/forgejo/codeberg-v16/${name}.json`, import.meta.url), "utf8"));
}

function fixtureRest(seen: Array<{ path: string; params: Record<string, unknown> }> = []): RestClient {
  return (async (path: string, params: Record<string, unknown> = {}) => {
    seen.push({ path, params });
    if (path === "version") return fixture("version");
    if (path === "settings/api") return fixture("settings-api");
    if (path === "repos/acme/widgets") return fixture("repository");
    if (path === "repos/acme/widgets/issues") {
      if (Number(params.page) > 1) return [];
      return params.type === "pulls" ? fixture("pulls") : fixture("issues");
    }
    if (path === "repos/acme/widgets/issues/8") return fixture("pulls")[0];
    if (path === "repos/acme/widgets/pulls/8") return fixture("pull-8");
    if (path === "repos/acme/widgets/issues/comments") return Number(params.page) > 1 ? [] : fixture("comments");
    if (path === "repos/acme/widgets/pulls/8/reviews") return Number(params.page) > 1 ? [] : fixture("reviews");
    if (path === "repos/acme/widgets/pulls/8/reviews/3001/comments") return fixture("review-comments");
    if (path === "repos/acme/widgets/issues/7/dependencies") return fixture("dependencies-7");
    if (path.endsWith("/dependencies") || path.endsWith("/blocks")) return [];
    if (path === "repos/acme/widgets/commits") return Number(params.page) > 1 ? [] : fixture("commits");
    if (path === "repos/acme/widgets/commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/status") return fixture("combined-status");
    throw new Error(`unexpected Forgejo fixture request: ${path} ${JSON.stringify(params)}`);
  }) as RestClient;
}

test("Forgejo full fetch preserves issue-backed PR identity and safely normalizes supported surfaces", async () => {
  const seen: Array<{ path: string; params: Record<string, unknown> }> = [];
  const source = new ForgejoSource(descriptor, fixtureRest(seen), ["acme/widgets"]);

  const result = await source.fetch({ since: "2026-07-03T00:00:00Z", full: true });

  assert.equal(result.complete, true);
  assert.equal(result.error, null);
  assert.equal(result.watermark, "2026-07-03T14:00:00Z");
  const itemRecords = result.records.filter((record) => record.entityKind !== "activity");
  assert.deepEqual(itemRecords.map((record) => record.externalId).sort(), ["item:1001", "item:1002", "item:1003"]);

  const issue = source.normalize(itemRecords.find((record) => record.externalId === "item:1001")!)!;
  assert.equal(issue.item?.kind, "issue");
  assert.equal(issue.item?.milestone, "v1");
  assert.equal(issue.item?.commentTotal, 1);
  assert.deepEqual(issue.labels, [{ name: "priority::high", scope: "priority", color: "e11d48" }]);
  assert.deepEqual(issue.edges, [{
    type: "blocked_by",
    from: { sourceId: descriptor.sourceId, externalId: "item:1001" },
    to: { sourceId: descriptor.sourceId, externalId: "item:1003" },
    fromState: "open",
    toState: "open",
  }]);

  const pull = source.normalize(itemRecords.find((record) => record.externalId === "item:1002")!)!;
  assert.equal(pull.item?.kind, "change_request");
  assert.equal(pull.item?.externalId, "item:1002", "the issue id, not PullRequest.id, is canonical identity");
  assert.equal(pull.item?.ciState, "passing");
  assert.equal(pull.item?.reviewState, null, "Forgejo does not expose a safe aggregate approval state in this slice");
  assert.equal(pull.item?.openReviewThreads, null);
  assert.deepEqual(pull.activities.filter((activity) => activity.kind === "review").map((activity) => activity.action), ["approved", "commented"]);

  const activities = result.records
    .filter((record) => record.entityKind === "activity")
    .map((record) => source.normalize(record)!.activities[0]!);
  assert.equal(activities.find((activity) => activity.externalId === "comment:2001")?.target?.externalId, "item:1001");
  assert.equal(activities.find((activity) => activity.externalId === "commit:acme%2Fwidgets:cccccccccccccccccccccccccccccccccccccccc")?.action, "committed");

  assert.ok(seen.some((call) => call.path === "version"));
  assert.ok(seen.some((call) => call.path === "settings/api"));
  assert.ok(seen.some((call) => call.path === "repos/acme/widgets/issues" && call.params.type === "issues"));
  assert.ok(seen.some((call) => call.path === "repos/acme/widgets/issues" && call.params.type === "pulls"));
});

test("Forgejo incremental fetch forwards since and never advances a partial watermark", async () => {
  const seen: Array<{ path: string; params: Record<string, unknown> }> = [];
  const source = new ForgejoSource(descriptor, fixtureRest(seen), ["acme/widgets"]);
  const result = await source.fetch({ since: "2026-07-03T00:00:00Z", full: false });

  assert.equal(result.complete, true);
  const issueCalls = seen.filter((call) => call.path === "repos/acme/widgets/issues");
  assert.ok(issueCalls.every((call) => call.params.since === "2026-07-03T00:00:00Z"));
  const commentCall = seen.find((call) => call.path === "repos/acme/widgets/issues/comments");
  assert.equal(commentCall?.params.since, "2026-07-03T00:00:00Z");

  const endless = (async (path: string) => {
    if (path === "version") return fixture("version");
    if (path === "settings/api") return { max_response_items: 1 };
    if (path === "repos/acme/widgets") return fixture("repository");
    if (path === "repos/acme/widgets/issues") return [fixture("issues")[0]];
    return [];
  }) as RestClient;
  const capped = new ForgejoSource(descriptor, endless, ["acme/widgets"], { maxPages: 1 });
  const partial = await capped.fetch({ since: "2026-07-03T00:00:00Z", full: false });
  assert.equal(partial.complete, false);
  assert.equal(partial.watermark, null);
  assert.match(partial.error ?? "", /page cap/);
});

test("Forgejo rejects unverified server majors before project data is fetched", async () => {
  const seen: string[] = [];
  const rest = (async (path: string) => {
    seen.push(path);
    if (path === "version") return { version: "17.0.0" };
    throw new Error(`must not fetch ${path}`);
  }) as RestClient;
  const source = new ForgejoSource(descriptor, rest, ["acme/widgets"]);

  const result = await source.fetch({ since: null, full: true });

  assert.equal(result.complete, false);
  assert.equal(result.watermark, null);
  assert.match(result.error ?? "", /unsupported Forgejo major 17/);
  assert.deepEqual(seen, ["version"]);
});

test("Forgejo incremental refresh rejects an incompatible server before yielding refresh records", async () => {
  const db = await openSqliteStore(":memory:");
  try {
    const seed = new ForgejoSource(descriptor, fixtureRest(), ["acme/widgets"]);
    const seeded = await syncSource(db, seed, null, { full: true, dryRun: false });
    assert.equal(seeded.status, "ok");

    const seen: string[] = [];
    const incompatibleRest = (async (path: string, params: Record<string, unknown> = {}) => {
      seen.push(path);
      if (path === "version") return { version: "17.0.0" };
      if (path === "repos/acme/widgets/issues/8") return fixture("pulls")[0];
      if (path === "repos/acme/widgets/pulls/8") return fixture("pull-8");
      if (path === "repos/acme/widgets/commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/status") return fixture("combined-status");
      if (path === "repos/acme/widgets/pulls/8/reviews") return Number(params.page) > 1 ? [] : fixture("reviews");
      throw new Error(`unexpected incompatible-server request: ${path}`);
    }) as RestClient;
    const incompatible = new ForgejoSource(descriptor, incompatibleRest, ["acme/widgets"]);

    const result = await syncSource(db, incompatible, "2026-07-03T00:00:00Z", {
      full: false,
      dryRun: false,
      ciRefreshGraceMs: 365 * 86_400_000,
    });

    assert.equal(result.status, "partial");
    assert.equal(result.itemsSeen, 0, "an incompatible refresh must yield no records for persistence");
    assert.match(result.error ?? "", /unsupported Forgejo major 17/);
    assert.deepEqual(seen, ["version", "version"], "both primary and refresh gates stop at the version probe");
  } finally {
    await db.close();
  }
});

test("Forgejo refresh preserves supported PR enrichment and reports status truncation as partial", async (t) => {
  await t.test("dependencies, inline review comments, status, and advertised paging match a normal fetch", async () => {
    const seen: Array<{ path: string; params: Record<string, unknown> }> = [];
    const base = fixtureRest(seen);
    const rest = (async (path: string, params: Record<string, string | number | boolean | null | undefined> = {}) => {
      if (path === "repos/acme/widgets/issues/8/dependencies") {
        seen.push({ path, params });
        return fixture("dependencies-7");
      }
      return base(path, params);
    }) as RestClient;
    const source = new ForgejoSource(descriptor, rest, ["acme/widgets"]);

    const result = await source.fetchRefresh([{
      externalId: "item:1002",
      projectPath: "acme/widgets",
      iid: 8,
      reason: "open_change_request",
    }], { since: null, full: false });

    assert.equal(result.complete, true);
    assert.equal(result.records.length, 1);
    const payload = result.records[0]!.payload as any;
    assert.equal(payload.dependencies[0]?.id, 1003);
    assert.equal(payload.reviews[0]?.comments[0]?.id, 3101);
    assert.equal(payload.combinedStatus?.state, "success");
    const normalized = source.normalize(result.records[0]!)!;
    assert.deepEqual(normalized.edges.map((edge) => edge.type), ["blocked_by"]);
    assert.ok(normalized.activities.some((activity) => activity.externalId === "review-comment:3101"));
    assert.ok(seen.some((call) => call.path === "version"));
    assert.ok(seen.some((call) => call.path === "settings/api"));
    assert.ok(seen.some((call) => call.path.endsWith("/reviews") && call.params.limit === 2));
  });

  await t.test("a truncated combined status remains diagnosable and incomplete", async () => {
    const base = fixtureRest();
    const rest = (async (path: string, params: Record<string, string | number | boolean | null | undefined> = {}) => {
      if (path === "repos/acme/widgets/commits/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/status") {
        const status = fixture("combined-status");
        return { ...status, total_count: 2 };
      }
      return base(path, params);
    }) as RestClient;
    const source = new ForgejoSource(descriptor, rest, ["acme/widgets"]);

    const result = await source.fetchRefresh([{
      externalId: "item:1002",
      projectPath: "acme/widgets",
      iid: 8,
      reason: "ci_unresolved",
    }], { since: null, full: false });

    assert.equal(result.complete, false);
    assert.equal(result.watermark, null);
    assert.match(result.error ?? "", /combined status response truncated \(1\/2\)/);
    assert.equal(result.records.length, 1, "the item remains available while the run is explicitly partial");
  });
});

test("Forgejo incremental commit pagination stops after a newest-first page crosses the watermark", async () => {
  const commit = (sha: string, created: string) => ({
    sha,
    created,
    html_url: `https://codeberg.org/acme/widgets/commit/${sha}`,
    commit: { message: sha, author: { name: "Fixture Author", date: created } },
  });
  const commitPages: number[] = [];
  const rest = (async (path: string, params: Record<string, unknown> = {}) => {
    if (path === "version") return fixture("version");
    if (path === "settings/api") return { max_response_items: 2 };
    if (path === "repos/acme/widgets") return fixture("repository");
    if (path === "repos/acme/widgets/issues" || path === "repos/acme/widgets/issues/comments") return [];
    if (path === "repos/acme/widgets/commits") {
      const page = Number(params.page);
      commitPages.push(page);
      if (page === 1) return [
        commit("new-1", "2026-07-03T02:00:00Z"),
        commit("new-2", "2026-07-03T01:00:00Z"),
      ];
      if (page === 2) return [
        commit("old-1", "2026-07-02T23:00:00Z"),
        commit("old-2", "2026-07-02T22:00:00Z"),
      ];
      throw new Error(`commit page ${page} must not be requested after crossing the watermark`);
    }
    throw new Error(`unexpected incremental request: ${path}`);
  }) as RestClient;
  const source = new ForgejoSource(descriptor, rest, ["acme/widgets"]);

  const result = await source.fetch({ since: "2026-07-03T00:00:00Z", full: false });

  assert.equal(result.complete, true);
  assert.equal(result.error, null);
  assert.deepEqual(commitPages, [1, 2]);
  assert.deepEqual(
    result.records.filter((record) => record.entityKind === "activity").map((record) => record.externalId),
    ["commit:acme%2Fwidgets:new-1", "commit:acme%2Fwidgets:new-2"],
  );
});
