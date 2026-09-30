// The sync side of per-commit files: how a source reads the file lists the
// engine asks for, what it stores, and how a stored record normalizes. The
// on-demand route for ONE commit (GET /api/commit-files) is covered by
// commit-files.test.ts; both share the provider readers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubSource } from "../src/sources/github.ts";
import { GitLabSource } from "../src/sources/gitlab.ts";
import { ProviderHttpError } from "../src/sources/http.ts";
import type { GqlClient } from "../src/sources/graphql.ts";
import type { RestClient } from "../src/sources/rest.ts";
import type { CommitFilesCandidate, RawRecord, SourceDescriptor } from "../src/sources/types.ts";

const GH: SourceDescriptor = { sourceId: "github:github.com", kind: "github", host: "github.com", displayName: null };
const GL: SourceDescriptor = { sourceId: "gitlab:gitlab.com", kind: "gitlab", host: "gitlab.com", displayName: null };
const noGql: GqlClient = (async () => {
  throw new Error("no GraphQL request is expected here");
}) as GqlClient;

const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const candidate = (seed: string, projectPath = "o/r"): CommitFilesCandidate => ({
  externalId: `commit:${encodeURIComponent(projectPath)}:${sha(seed)}`,
  projectPath,
  sha: sha(seed),
});
const payloadOf = (record: RawRecord) => record.payload as Record<string, any>;

test("GitHub reads each asked commit's files and stores paths and counts, never patch text", async () => {
  const calls: string[] = [];
  const rest: RestClient = async <T = any>(path: string): Promise<T> => {
    calls.push(path);
    return {
      sha: sha("a"),
      parents: [{ sha: "p1" }],
      stats: { additions: 12, deletions: 3 },
      files: [
        { filename: "src/app.ts", status: "modified", additions: 10, deletions: 3, patch: "@@ -1 +1 @@\n-secret\n+SECRET" },
        { filename: "docs/new.md", status: "added", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+a\n+b" },
        { filename: "src/moved.ts", previous_filename: "src/old.ts", status: "renamed", additions: 0, deletions: 0 },
      ],
    } as T;
  };
  const src = new GitHubSource(GH, noGql, ["o/r"], rest);
  const res = await src.fetchCommitFiles([candidate("a")]);

  assert.deepEqual(calls, [`repos/o/r/commits/${sha("a")}`]);
  assert.equal(res.stopped, null);
  assert.equal(res.records.length, 1);
  const record = res.records[0]!;
  assert.equal(record.entityKind, "commit_files");
  assert.equal(record.externalId, `commit_files:${candidate("a").externalId}`, "an id of its own: the raw store keeps one payload per id, and the commit's is already there");
  assert.equal(payloadOf(record).activity, candidate("a").externalId, "and it names the commit activity it belongs to");
  assert.ok(!JSON.stringify(record.payload).includes("SECRET"), "the diff text is dropped before anything is stored");
  assert.deepEqual(payloadOf(record).files, [
    { path: "src/app.ts", status: "modified", additions: 10, deletions: 3 },
    { path: "docs/new.md", status: "added", additions: 2, deletions: 0 },
    { path: "src/moved.ts", status: "renamed", additions: 0, deletions: 0 },
  ]);

  const bundle = src.normalize(record)!;
  assert.equal(bundle.item, null);
  assert.deepEqual(bundle.activities, []);
  assert.deepEqual(bundle.commitFiles, [
    {
      sourceId: "github:github.com",
      externalId: candidate("a").externalId,
      projectPath: "o/r",
      sha: sha("a"),
      state: "ok",
      truncated: false,
      files: payloadOf(record).files,
    },
  ]);
});

test("a GitHub commit that turns out to be a merge is recorded as one, without its files", async () => {
  // The engine answers known merges without asking. A row stored before the
  // merge flag existed can still reach the provider, and its diff is against
  // the first parent — the merged branch's work, counted a second time.
  const rest: RestClient = async <T = any>(): Promise<T> =>
    ({ parents: [{ sha: "p1" }, { sha: "p2" }], files: [{ filename: "a.ts", status: "modified", additions: 400, deletions: 1 }] }) as T;
  const src = new GitHubSource(GH, noGql, ["o/r"], rest);
  const res = await src.fetchCommitFiles([candidate("b")]);
  assert.equal(payloadOf(res.records[0]!).state, "merge");
  assert.deepEqual(src.normalize(res.records[0]!)!.commitFiles![0]!.files, []);
});

test("a commit the provider no longer has is recorded as unavailable, not retried forever", async () => {
  const rest: RestClient = async <T = any>(path: string): Promise<T> => {
    if (path.endsWith(sha("c"))) throw new ProviderHttpError("REST HTTP 422: No commit found for SHA", 422);
    if (path.endsWith(sha("d"))) throw new ProviderHttpError("REST HTTP 404: Not Found", 404);
    return { parents: [{ sha: "p" }], files: [] } as T;
  };
  const src = new GitHubSource(GH, noGql, ["o/r"], rest);
  const res = await src.fetchCommitFiles([candidate("c"), candidate("d"), candidate("e")]);
  assert.equal(res.stopped, null, "a missing commit is an answer, not a failure");
  assert.deepEqual(
    res.records.map((r) => payloadOf(r).state),
    ["unavailable", "unavailable", "ok"],
  );
  assert.equal(src.normalize(res.records[0]!)!.commitFiles![0]!.state, "unavailable");
});

// One request at a time, so a test can say exactly which requests were made.
async function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.SYNC_RESOLVE_CONCURRENCY;
  process.env.SYNC_RESOLVE_CONCURRENCY = "1";
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.SYNC_RESOLVE_CONCURRENCY;
    else process.env.SYNC_RESOLVE_CONCURRENCY = previous;
  }
}

const readable = { parents: [{ sha: "p" }], files: [{ filename: "a.ts", status: "modified", additions: 1, deletions: 1 }] };

test("a rejected or rate-limited token stops the pass and answers nothing for the rest", async () => {
  for (const failure of [
    new ProviderHttpError("REST HTTP 403: API rate limit exceeded", 403, { kind: "primary", resetAtMs: null, retryAfterMs: null }),
    new ProviderHttpError("REST HTTP 429: Too Many Requests", 429),
    new ProviderHttpError("REST HTTP 401: Bad credentials", 401),
  ]) {
    await oneAtATime(async () => {
      const calls: string[] = [];
      const rest: RestClient = async <T = any>(path: string): Promise<T> => {
        calls.push(path);
        if (path.endsWith(sha("b"))) throw failure;
        return readable as T;
      };
      const src = new GitHubSource(GH, noGql, ["o/r"], rest);
      const res = await src.fetchCommitFiles([candidate("a"), candidate("b"), candidate("c")]);
      assert.equal(res.stopped, failure.message);
      assert.deepEqual(res.records.map((r) => payloadOf(r).sha), [sha("a")], "what was read before the failure is kept");
      assert.equal(calls.length, 2, "nothing is asked after the failure: the commit stays in the queue for the next sweep");
    });
  }
});

test("a commit that fails on its own is set aside, the rest are read, and it is answered unavailable", async () => {
  // A diff the provider cannot render, a timeout, a repository this token may
  // not read (a 403 with no rate-limit headers). Were it left unanswered it
  // would head the newest-first queue every sweep and starve every older commit.
  for (const failure of [
    new ProviderHttpError("REST HTTP 500: Server Error", 500),
    new ProviderHttpError("REST HTTP 403: Resource not accessible by personal access token", 403),
    new Error("request timed out after 30000ms"),
  ]) {
    await oneAtATime(async () => {
      const calls: string[] = [];
      const rest: RestClient = async <T = any>(path: string): Promise<T> => {
        calls.push(path);
        if (path.endsWith(sha("a")) || path.endsWith(sha("b"))) throw failure;
        return readable as T;
      };
      const src = new GitHubSource(GH, noGql, ["o/r"], rest);
      const res = await src.fetchCommitFiles([candidate("a"), candidate("b"), candidate("c"), candidate("d")]);
      assert.equal(res.stopped, null, "the pass ran to the end");
      assert.equal(calls.length, 4, "the commits behind the failing ones are still asked for");
      assert.deepEqual(
        Object.fromEntries(res.records.map((r) => [payloadOf(r).sha, payloadOf(r).state])),
        { [sha("a")]: "unavailable", [sha("b")]: "unavailable", [sha("c")]: "ok", [sha("d")]: "ok" },
        "the provider answered other commits, so these failures are the commits' own",
      );
    });
  }
});

test("when nothing is answered the failures are not the commits': nothing is recorded and the pass gives up", async () => {
  // The provider or the network is down. Recording these as unavailable would
  // drop fifty readable commits from the aggregate on every sweep of an outage.
  await oneAtATime(async () => {
    const calls: string[] = [];
    const rest: RestClient = async <T = any>(path: string): Promise<T> => {
      calls.push(path);
      throw new ProviderHttpError("REST HTTP 503: Service Unavailable", 503);
    };
    const src = new GitHubSource(GH, noGql, ["o/r"], rest);
    const seeds = ["a", "b", "c", "d", "e", "f", "0", "1", "2", "3", "4", "5"];
    const res = await src.fetchCommitFiles(seeds.map((seed) => candidate(seed)));
    assert.deepEqual(res.records, [], "every commit stays in the queue");
    assert.match(res.stopped ?? "", /503/);
    assert.equal(calls.length, 8, "and the pass stops asking after a few");

    // Short of that limit the pass still records nothing and says why.
    const few = await src.fetchCommitFiles([candidate("a"), candidate("b")]);
    assert.deepEqual(few.records, []);
    assert.match(few.stopped ?? "", /503/);
  });
});

test("a commit outside the configured repositories, or with no usable sha, is answered without a request", async () => {
  const calls: string[] = [];
  const rest: RestClient = async <T = any>(path: string): Promise<T> => {
    calls.push(path);
    return { parents: [{ sha: "p" }], files: [] } as T;
  };
  const src = new GitHubSource(GH, noGql, ["o/r"], rest);
  const res = await src.fetchCommitFiles([
    candidate("a", "someone/else"),
    { externalId: "commit:o%2Fr:short", projectPath: "o/r", sha: "abc123" },
    { externalId: "commit:o%2Fr:inject", projectPath: "o/r", sha: `${sha("a").slice(0, 39)}/` },
  ]);
  assert.deepEqual(calls, [], "the token may read more than the board tracks; the configured list is the allowlist");
  assert.deepEqual(res.records.map((r) => payloadOf(r).state), ["unavailable", "unavailable", "unavailable"]);

  // The same list guards GitLab, where the project reaches the URL encoded.
  const gitlab = new GitLabSource(GL, noGql, ["g/p"], rest);
  const other = await gitlab.fetchCommitFiles([candidate("a", "g/other")]);
  assert.deepEqual(calls, []);
  assert.deepEqual(other.records.map((r) => payloadOf(r).state), ["unavailable"]);
});

test("GitLab counts a commit's diff lines from the diff it is served", async () => {
  const calls: Array<{ path: string; params: unknown }> = [];
  const rest: RestClient = async <T = any>(path: string, params?: Record<string, string | number | boolean | null | undefined>): Promise<T> => {
    calls.push({ path, params });
    return [
      { new_path: "lib/a.rb", old_path: "lib/a.rb", diff: "@@ -1,2 +1,2 @@\n-old\n+new\n context", new_file: false, deleted_file: false, renamed_file: false },
      { new_path: "lib/b.rb", old_path: "lib/b.rb", diff: "@@ -0,0 +1 @@\n+only", new_file: true },
    ] as T;
  };
  const src = new GitLabSource(GL, noGql, ["g/p"], rest);
  const res = await src.fetchCommitFiles([candidate("f", "g/p")]);
  assert.equal(calls[0]!.path, `projects/g%2Fp/repository/commits/${sha("f")}/diff`);
  assert.equal(res.stopped, null);
  const record = res.records[0]!;
  assert.ok(!JSON.stringify(record.payload).includes("only"), "no diff text is stored");
  assert.deepEqual(src.normalize(record)!.commitFiles, [
    {
      sourceId: "gitlab:gitlab.com",
      externalId: candidate("f", "g/p").externalId,
      projectPath: "g/p",
      sha: sha("f"),
      state: "ok",
      truncated: false,
      files: [
        { path: "lib/a.rb", status: "modified", additions: 1, deletions: 1 },
        { path: "lib/b.rb", status: "added", additions: 1, deletions: 0 },
      ],
    },
  ]);
});

test("a stored commit-files record with unusable entries normalizes to what is usable", () => {
  const src = new GitHubSource(GH, noGql, ["o/r"]);
  const raw: RawRecord = {
    entityKind: "commit_files",
    externalId: "commit_files:commit:o%2Fr:abc",
    apiVersion: "github.graphql.v4.rest",
    fetchedAt: "2026-06-09T00:00:00Z",
    contentHash: "h",
    payload: {
      __kind: "commit_files",
      activity: "commit:o%2Fr:abc",
      project: "o/r",
      sha: sha("a"),
      state: "ok",
      truncated: true,
      files: [
        { path: "ok.ts", status: "modified", additions: 1, deletions: 2 },
        { path: "", status: "modified", additions: 1, deletions: 2 },
        { path: "weird.ts", status: "exploded", additions: 1, deletions: 2 },
        { path: "negative.ts", status: "added", additions: -1, deletions: 0 },
        "not an object",
      ],
    },
  };
  assert.deepEqual(src.normalize(raw)!.commitFiles, [
    {
      sourceId: "github:github.com",
      externalId: "commit:o%2Fr:abc",
      projectPath: "o/r",
      sha: sha("a"),
      state: "ok",
      truncated: true,
      files: [
        { path: "ok.ts", status: "modified", additions: 1, deletions: 2 },
        // An unknown status is a modification; the path and counts are still real.
        { path: "weird.ts", status: "modified", additions: 1, deletions: 2 },
      ],
    },
  ]);
  // A record with no sha, an unknown state, or no commit activity to belong to
  // is dropped rather than half-read.
  const stored = { __kind: "commit_files", activity: "commit:o%2Fr:abc", project: "o/r", sha: sha("a"), state: "ok", files: [] };
  assert.notEqual(src.normalize({ ...raw, payload: stored }), null);
  assert.equal(src.normalize({ ...raw, payload: { ...stored, sha: undefined } }), null);
  assert.equal(src.normalize({ ...raw, payload: { ...stored, state: "maybe" } }), null);
  assert.equal(src.normalize({ ...raw, payload: { ...stored, activity: undefined } }), null);
});

test("a provider-capped file list is stored as truncated", async () => {
  // GitLab pages its diff and this reads one page; GitHub stops at 300 files.
  // Either way the list is a prefix, and the row says so rather than passing
  // for a small commit.
  const page = Array.from({ length: 100 }, (_, i) => ({ new_path: `f${i}.rb`, diff: "@@ -0,0 +1 @@\n+x", new_file: true }));
  const gitlab = new GitLabSource(GL, noGql, ["g/p"], (async () => page) as unknown as RestClient);
  const gl = await gitlab.fetchCommitFiles([candidate("a", "g/p")]);
  assert.equal(gitlab.normalize(gl.records[0]!)!.commitFiles![0]!.truncated, true);
  assert.equal(gitlab.normalize(gl.records[0]!)!.commitFiles![0]!.files.length, 100);

  const many = { parents: [{ sha: "p" }], files: Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.ts`, status: "modified", additions: 1, deletions: 0 })) };
  const github = new GitHubSource(GH, noGql, ["o/r"], (async () => many) as unknown as RestClient);
  const gh = await github.fetchCommitFiles([candidate("b")]);
  assert.equal(github.normalize(gh.records[0]!)!.commitFiles![0]!.truncated, true);
});
