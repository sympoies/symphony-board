// The per-repository file aggregate (`commit_file_stats`, contract 4.9.0):
// what the builder counts, what it leaves out, and that both projections emit
// it only when they were handed file rows.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config.ts";
import type { ActivityRow, CommitFilesRow, ItemRow, SourceRow } from "../src/db/store.ts";
import { openSqliteStore } from "../src/db/sqlite.ts";
import { buildContract, buildRangeContract } from "../src/contract/build.ts";
import { buildContractEnvelope } from "../src/contract/emit.ts";
import { rangeEnvelope } from "../src/server/range.ts";
import { COMMIT_FILE_SHA_LIMIT, COMMIT_FILE_TOP_DIRS, COMMIT_FILE_TOP_FILES, buildCommitFileStats, commitFileDirectory } from "../src/contract/commit-files.ts";
import { validateContract } from "../src/contract/validate.ts";
import { refOf } from "../src/model/ref.ts";
import type { ActivityDTO } from "../packages/contract/types.ts";

const SRC = "github:github.com";
// Distinct in its FIRST twelve characters, which is all the aggregate emits: a
// left-padded number would give every commit the same prefix, and no assertion
// about which commits an entry lists could fail.
const sha = (n: number) => n.toString(16).padStart(12, "0").padEnd(40, "f");

function commit(n: number, over: Partial<ActivityDTO> & { details?: Record<string, unknown> } = {}): ActivityDTO {
  const { details, ...rest } = over;
  return {
    source_id: SRC,
    external_id: `commit:${n}`,
    kind: "commit",
    action: "committed",
    project_path: "o/r",
    target_kind: "commit",
    target_ref: null,
    target_iid: null,
    title: `Commit ${n}`,
    url: null,
    actor: "ada",
    // Newest first, like the projection's own order: a higher n is more recent.
    occurred_at: new Date(Date.UTC(2026, 4, 1) + n * 3_600_000).toISOString(),
    details: { sha: sha(n), ...details },
    first_seen_at: null,
    last_seen_at: null,
    ...rest,
  };
}

function files(n: number, list: Array<[path: string, additions: number, deletions: number]>, over: Partial<CommitFilesRow> = {}): CommitFilesRow {
  return {
    source_id: SRC,
    external_id: `commit:${n}`,
    project_path: "o/r",
    sha: sha(n),
    state: "ok",
    truncated: false,
    files: JSON.stringify(list.map(([path, additions, deletions]) => ({ path, status: "modified", additions, deletions }))),
    fetched_at: "2026-06-01T00:00:00Z",
    ...over,
  };
}

const keysOf = (activities: ActivityDTO[], by: (a: ActivityDTO) => string | null = (a) => a.actor) =>
  new Map(activities.map((a) => [refOf(a.source_id, a.external_id), by(a)]));

test("commitFileDirectory folds a path to at most two leading directories", () => {
  assert.equal(commitFileDirectory("packages/ui/src/model.ts"), "packages/ui/");
  assert.equal(commitFileDirectory("src/config.ts"), "src/");
  assert.equal(commitFileDirectory("README.md"), "./");
  assert.equal(commitFileDirectory("a/b/c/d/e.ts"), "a/b/");
});

test("buildCommitFileStats ranks a repository's files and directories by the commits that touched them", () => {
  const activities = [
    commit(4, { actor: "grace" }),
    commit(3),
    commit(2, { details: { merge: true } }),
    commit(1),
    // A commit with no file data yet: counted, not scanned.
    commit(0),
  ];
  const stats = buildCommitFileStats(activities, keysOf(activities), [
    files(4, [["src/app.ts", 5, 1], ["src/util.ts", 2, 1]]),
    files(3, [["src/app.ts", 10, 4], ["docs/guide.md", 7, 0], ["README.md", 1, 1]], { truncated: true }),
    // Its commit is a merge: file data that arrived before the merge flag did
    // must not count, or the merged branch's work is counted twice.
    files(2, [["src/app.ts", 400, 400]]),
    files(1, [["src/app.ts", 1, 1]]),
  ]);

  assert.equal(stats.repos.length, 1);
  const repo = stats.repos[0]!;
  assert.deepEqual(
    { source_id: repo.source_id, project_path: repo.project_path, commits: repo.commits, scanned: repo.scanned, truncated: repo.truncated, files: repo.files },
    { source_id: SRC, project_path: "o/r", commits: 4, scanned: 3, truncated: 1, files: 4 },
    "four non-merge commits, three of them with file data, four distinct paths",
  );
  assert.deepEqual(repo.top_files[0], {
    path: "src/app.ts",
    commits: 3,
    additions: 16,
    deletions: 6,
    authors: 2,
    // The commits that touched it, newest first, as 12-character prefixes.
    shas: [sha(4), sha(3), sha(1)].map((s) => s.slice(0, 12)),
  });
  assert.deepEqual(repo.top_files.map((f) => f.path), ["src/app.ts", "docs/guide.md", "src/util.ts", "README.md"], "commits, then churn, then path");
  // A directory counts a commit once however many of its files the commit
  // touched, and the repository root is a directory like any other.
  assert.deepEqual(
    repo.top_dirs.map((d) => [d.path, d.commits, d.additions, d.deletions, d.authors]),
    [
      ["src/", 3, 18, 7, 2],
      ["docs/", 1, 7, 0, 1],
      ["./", 1, 1, 1, 1],
    ],
  );
  assert.deepEqual(repo.top_dirs[0]!.shas, [sha(4), sha(3), sha(1)].map((s) => s.slice(0, 12)));
});

test("buildCommitFileStats keeps repositories apart and only lists those with commits", () => {
  const activities = [
    commit(2, { project_path: "o/web" }),
    commit(1),
    { ...commit(9), kind: "issue", action: "opened" },
    commit(8, { project_path: null }),
  ];
  const stats = buildCommitFileStats(activities, keysOf(activities), [
    files(2, [["src/app.ts", 1, 0]], { project_path: "o/web" }),
    files(1, [["src/app.ts", 2, 0]]),
    // No commit row in the window names this one: it is not counted anywhere.
    files(7, [["src/app.ts", 99, 0]]),
  ]);
  assert.deepEqual(stats.repos.map((r) => [r.project_path, r.commits, r.scanned, r.top_files[0]?.additions]), [
    ["o/r", 1, 1, 2],
    ["o/web", 1, 1, 1],
  ]);
});

test("buildCommitFileStats counts people, not actor strings, and bounds what it emits", () => {
  const activities = Array.from({ length: COMMIT_FILE_SHA_LIMIT + 20 }, (_, i) =>
    commit(i, { actor: i % 2 === 0 ? "Terry LIN" : "terrylin" }),
  ).reverse();
  // Both spellings share one persisted actor key, so they are one author.
  const stats = buildCommitFileStats(activities, keysOf(activities, () => "person:terry"), [
    ...activities.map((a, i) => files(Number(a.external_id.split(":")[1]), [["hot.ts", 1, 0], [`dir${i % (COMMIT_FILE_TOP_DIRS + 5)}/f${i}.ts`, 1, 0]])),
  ]);
  const repo = stats.repos[0]!;
  const hot = repo.top_files.find((f) => f.path === "hot.ts")!;
  assert.equal(hot.commits, COMMIT_FILE_SHA_LIMIT + 20, "the count is the whole truth");
  assert.equal(hot.authors, 1);
  assert.equal(hot.shas.length, COMMIT_FILE_SHA_LIMIT, "the sha list is a bounded, newest-first prefix of it");
  assert.equal(hot.shas[0], sha(COMMIT_FILE_SHA_LIMIT + 19).slice(0, 12));
  assert.equal(repo.top_files.length, COMMIT_FILE_TOP_FILES);
  assert.equal(repo.top_dirs.length, COMMIT_FILE_TOP_DIRS);
  assert.equal(repo.files, COMMIT_FILE_SHA_LIMIT + 21, "distinct paths are counted over everything scanned, not over the top list");
});

test("buildCommitFileStats breaks ties by path and counts a path once per commit", () => {
  const activities = [commit(2), commit(1)];
  const stats = buildCommitFileStats(activities, keysOf(activities), [
    // The provider listed one path twice: that is one touch of the file.
    files(2, [["b.ts", 1, 1], ["b.ts", 5, 5], ["a.ts", 2, 0], ["lib/z.ts", 1, 0], ["app/z.ts", 1, 0]]),
  ]);
  const repo = stats.repos[0]!;
  assert.deepEqual(
    repo.top_files.map((f) => [f.path, f.commits, f.additions + f.deletions]),
    [["a.ts", 1, 2], ["b.ts", 1, 2], ["app/z.ts", 1, 1], ["lib/z.ts", 1, 1]],
    "equal commits and equal churn fall back to the path, so two builds agree",
  );
  assert.deepEqual(repo.top_dirs.map((d) => d.path), ["./", "app/", "lib/"]);
  assert.equal(repo.files, 4);
});

test("buildCommitFileStats survives a stored file list that is not what it should be", () => {
  const activities = [commit(2), commit(1)];
  const stats = buildCommitFileStats(activities, keysOf(activities), [
    files(2, [["ok.ts", 1, 1]], { files: "not json" }),
    { ...files(1, []), files: JSON.stringify([{ path: "ok.ts", additions: 3, deletions: 0 }, { path: 7 }, null, { path: "neg.ts", additions: -1, deletions: 0 }]) },
  ]);
  const repo = stats.repos[0]!;
  assert.equal(repo.scanned, 2, "an unreadable list still means the commit was answered");
  assert.deepEqual(repo.top_files.map((f) => [f.path, f.additions]), [["ok.ts", 3]]);
});

// ---- the envelope -----------------------------------------------------------

const source: SourceRow = { source_id: SRC, kind: "github", host: "github.com", display_name: "GitHub", last_success_at: null, last_status: "ok" };
const noItems: ItemRow[] = [];

function commitRow(n: number, occurredAt: string, details: Record<string, unknown> = {}): ActivityRow {
  return {
    source_id: SRC,
    external_id: `commit:${n}`,
    kind: "commit",
    action: "committed",
    project_path: "o/r",
    target_kind: "commit",
    target_source_id: null,
    target_external_id: null,
    target_iid: null,
    title: `Commit ${n}`,
    url: null,
    actor: "ada",
    actor_key: `provider-user:${SRC}:ada`,
    occurred_at: occurredAt,
    summary: null,
    details: JSON.stringify({ sha: sha(n), ...details }),
    first_seen_at: null,
    last_seen_at: null,
  };
}

test("the static contract aggregates files over its 30-day activity window, and validates", () => {
  const env = buildContract({
    sources: [source],
    items: noItems,
    labels: [],
    edges: [],
    activities: [commitRow(2, "2026-06-10T00:00:00Z"), commitRow(1, "2026-03-01T00:00:00Z")],
    commitFiles: [files(2, [["src/app.ts", 3, 1]]), files(1, [["src/old.ts", 9, 9]])],
    generatedAt: "2026-06-20T00:00:00Z",
  });
  assert.deepEqual(validateContract(env), []);
  assert.deepEqual(env.commit_file_stats?.repos.map((r) => [r.project_path, r.commits, r.scanned, r.top_files.map((f) => f.path)]), [
    ["o/r", 1, 1, ["src/app.ts"]],
  ], "the commit outside the emitted activity window is not aggregated");
});

test("a range response aggregates files over the requested range, and validates", () => {
  const env = buildRangeContract({
    sources: [source],
    items: noItems,
    labels: [],
    edges: [],
    activities: [commitRow(2, "2026-05-10T00:00:00Z"), commitRow(1, "2026-04-10T00:00:00Z")],
    commitFiles: [files(2, [["src/app.ts", 3, 1]]), files(1, [["src/old.ts", 9, 9]])],
    generatedAt: "2026-06-20T00:00:00Z",
    range: { from: "2026-05-01T00:00:00.000Z", to: "2026-05-31T23:59:59.999Z" },
  });
  assert.deepEqual(validateContract(env), []);
  assert.deepEqual(env.commit_file_stats?.repos.map((r) => r.top_files.map((f) => f.path)), [["src/app.ts"]]);
});

test("a projection that was handed no file rows emits no aggregate at all", () => {
  // Absent is "this producer does not collect files"; an empty `repos` would
  // read as "collected, and nothing changed".
  const base = { sources: [source], items: noItems, labels: [], edges: [], activities: [commitRow(2, "2026-06-10T00:00:00Z")], generatedAt: "2026-06-20T00:00:00Z" };
  assert.equal("commit_file_stats" in buildContract(base), false);
  assert.equal("commit_file_stats" in buildRangeContract({ ...base, range: { from: "2026-06-01T00:00:00.000Z", to: "2026-06-30T23:59:59.999Z" } }), false);
  // Handed an empty list, it reports coverage: a commit, none scanned.
  const empty = buildContract({ ...base, commitFiles: [] });
  assert.deepEqual(empty.commit_file_stats?.repos.map((r) => [r.commits, r.scanned, r.top_files.length]), [[1, 0, 0]]);
  assert.deepEqual(validateContract(empty), []);
});

// ---- from the store to the envelope ------------------------------------------

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const day = (iso: string) => iso.slice(0, 10);

function config(dbPath: string, perSweep?: number): AppConfig {
  return {
    db_path: dbPath,
    sources: [
      {
        source_id: SRC,
        kind: "github",
        host: "github.com",
        token_env: "T",
        graphql_url: "https://api.github.com/graphql",
        projects: ["o/r"],
        ...(perSweep === undefined ? {} : { commit_files_per_sweep: perSweep }),
      },
    ],
  };
}

async function seededStore(dbPath: string, withFiles: boolean) {
  const store = await openSqliteStore(dbPath);
  const now = new Date().toISOString();
  await store.ensureSource({ sourceId: SRC, kind: "github", host: "github.com", displayName: null }, now);
  const commits: Array<[n: number, occurredAt: string, path: string]> = [
    [2, daysAgo(2), "src/recent.ts"],
    [1, daysAgo(60), "src/old.ts"],
  ];
  for (const [n, occurredAt, path] of commits) {
    await store.upsertActivity(
      {
        sourceId: SRC, externalId: `commit:${n}`, kind: "commit", action: "committed", projectPath: "o/r", targetKind: "commit", target: null, targetIid: null,
        title: `Commit ${n}`, url: null, actor: "ada", actorKey: `provider-user:${SRC}:ada`, occurredAt, summary: null, details: { sha: sha(n) },
      },
      now,
    );
    if (withFiles) {
      await store.upsertCommitFiles(
        { sourceId: SRC, externalId: `commit:${n}`, projectPath: "o/r", sha: sha(n), state: "ok", truncated: false, files: [{ path, status: "modified", additions: 1, deletions: 0 }] },
        now,
      );
    }
  }
  return store;
}

const topFiles = (env: { commit_file_stats?: { repos: Array<{ scanned: number; top_files: Array<{ path: string }> }> } }) =>
  env.commit_file_stats?.repos.map((r) => [r.scanned, r.top_files.map((f) => f.path)]);

test("both projections load the stored file rows of exactly the commits they emit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-commit-files-"));
  try {
    const dbPath = join(dir, "board.db");
    const store = await seededStore(dbPath, true);
    const cfg = config(dbPath);

    // The static contract emits a 30-day activity window: the older commit is
    // outside it, so neither it nor its files are aggregated.
    const emitted = await buildContractEnvelope(store, cfg, new Date().toISOString());
    assert.deepEqual(validateContract(emitted), []);
    assert.deepEqual(topFiles(emitted), [[1, ["src/recent.ts"]]]);
    await store.close();

    // A range response aggregates the range it was asked for, and only that.
    const old = await rangeEnvelope(cfg, new URL(`http://board/api/range?from=${day(daysAgo(70))}&to=${day(daysAgo(40))}`));
    assert.deepEqual(validateContract(old), []);
    assert.deepEqual(topFiles(old), [[1, ["src/old.ts"]]]);
    const both = await rangeEnvelope(cfg, new URL(`http://board/api/range?from=${day(daysAgo(70))}&to=${day(daysAgo(0))}`));
    assert.deepEqual(topFiles(both), [[2, ["src/old.ts", "src/recent.ts"]]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a deployment that collects no files leaves the aggregate out; one that does reports coverage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-commit-files-"));
  try {
    const bare = join(dir, "bare.db");
    const store = await seededStore(bare, false);
    const range = new URL(`http://board/api/range?from=${day(daysAgo(70))}&to=${day(daysAgo(0))}`);
    const now = new Date().toISOString();

    // The pass is off and nothing was ever collected: the key is absent, so a
    // consumer does not promise file data that will never arrive.
    const off = await buildContractEnvelope(store, config(bare, 0), now);
    // The pass is on (the default) and has not reached these commits yet.
    const on = await buildContractEnvelope(store, config(bare), now);
    await store.close();
    assert.equal("commit_file_stats" in off, false);
    assert.equal("commit_file_stats" in (await rangeEnvelope(config(bare, 0), range)), false);
    assert.deepEqual(topFiles(on), [[0, []]]);
    assert.deepEqual(topFiles(await rangeEnvelope(config(bare), range)), [[0, []]]);

    // Rows collected before the pass was turned off are real, and still shown.
    const kept = join(dir, "kept.db");
    await (await seededStore(kept, true)).close();
    assert.deepEqual(topFiles(await rangeEnvelope(config(kept, 0), range)), [[2, ["src/old.ts", "src/recent.ts"]]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
