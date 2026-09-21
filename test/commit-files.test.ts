// GET /api/commit-files (src/server/commit-files.ts): the on-demand per-file
// diffstat for ONE opened commit. The REST client is injected, so nothing here
// touches the network — what is asserted is the request contract (what a caller
// may name), the two providers' very different response shapes reduced to one
// result, and the guarantees that make a provider-reaching route safe to serve:
// a configured project is the allowlist, and an immutable commit is cached.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppConfig } from "../src/config.ts";
import type { AuthToken } from "../src/sources/http.ts";
import type { AuthTokenResolver } from "../src/auth.ts";
import type { RestClient } from "../src/sources/rest.ts";
import {
  countDiffLines,
  fetchCommitFiles,
  isCommitFilesError,
  parseCommitFilesRequest,
  type CommitFilesError,
  type CommitFilesResult,
} from "../src/server/commit-files.ts";

// The cache entry shape is internal to the module; a test only needs a map it
// can hand in and never inspect.
type CommitFilesCacheEntry = Parameters<typeof fetchCommitFiles>[2] extends { cache?: Map<string, infer E> } ? E : never;

const SHA = "24f59ca944420547a274023d003032d5e0b666b4";
const OTHER_SHA = "3bdc04a5bb2f4a1d9c7e5f60718a2c93de41b7aa";

function cfg(): AppConfig {
  return {
    db_path: "x.db",
    sources: [
      {
        source_id: "github:github.com",
        kind: "github",
        host: "github.com",
        token_env: "GH_TOKEN",
        graphql_url: "https://api.github.com/graphql",
        projects: ["serenvia/secrets"],
      },
      {
        source_id: "gitlab:gitlab.example.com",
        kind: "gitlab",
        host: "gitlab.example.com",
        token_env: "GL_TOKEN",
        graphql_url: "https://gitlab.example.com/api/graphql",
        projects: ["group/sub/app"],
      },
      {
        source_id: "github:disabled",
        kind: "github",
        host: "github.com",
        enabled: false,
        token_env: "GH_TOKEN",
        graphql_url: "https://api.github.com/graphql",
        projects: ["o/off"],
      },
    ],
  };
}

const token: AuthToken = { env: "GH_TOKEN", value: "secret" };

const resolver: AuthTokenResolver = {
  tokensForSource: async () => [token],
  tokensForProject: async () => [token],
  resolveSourceTokens: async () => [token],
};

const noTokens: AuthTokenResolver = {
  tokensForSource: async () => [],
  tokensForProject: async () => [],
  resolveSourceTokens: async () => [],
};

// Records the provider paths a run asked for, so a cached second call is
// provably a call that did NOT happen.
function restStub(handler: (path: string) => unknown): { rest: RestClient; paths: string[] } {
  const paths: string[] = [];
  const rest: RestClient = async (path: string) => {
    paths.push(path);
    return handler(path) as any;
  };
  return { rest, paths };
}

function deps(rest: RestClient, authTokenResolver: AuthTokenResolver = resolver, clock?: { now: () => number }) {
  return {
    restClientFactory: () => rest,
    authTokenResolver,
    // Per-test cache and in-flight map; the module-level ones must not leak
    // between tests.
    cache: new Map<string, CommitFilesCacheEntry>(),
    inFlight: new Map<string, Promise<CommitFilesResult | CommitFilesError>>(),
    ...(clock ? { now: () => clock.now() } : {}),
  };
}

const GITHUB_COMMIT = {
  stats: { additions: 132, deletions: 3, total: 135 },
  files: [
    { filename: "docs/devlog/2026-09.md", status: "modified", additions: 40, deletions: 0 },
    { filename: "host/README.md", status: "added", additions: 7, deletions: 0 },
    { filename: "old/path.py", previous_filename: "older/path.py", status: "renamed", additions: 85, deletions: 3 },
  ],
};

test("a request must name a source, a project, and a hex sha", () => {
  const base = "http://x/api/commit-files";
  const missing = parseCommitFilesRequest(new URL(`${base}?project_path=o/r&sha=${SHA}`));
  assert.equal(isCommitFilesError(missing as never) && (missing as any).error, "bad_request");

  const noProject = parseCommitFilesRequest(new URL(`${base}?source_id=s&sha=${SHA}`));
  assert.equal((noProject as any).error, "bad_request");

  // A sha reaches the provider inside a URL path; anything that could steer it
  // elsewhere is refused before a client is even built.
  // An ABBREVIATION is refused too: it resolves to the same commit but under a
  // different cache key, so one commit would have dozens of keys and each of
  // them a real provider call. The UI always sends the full oid.
  for (const bad of ["", "abc", "../../etc/passwd", "HEAD", `${SHA}/../../other`, SHA.slice(0, 7), SHA.slice(0, 39)]) {
    const res = parseCommitFilesRequest(new URL(`${base}?source_id=s&project_path=o/r&sha=${encodeURIComponent(bad)}`));
    assert.equal((res as any).error, "bad_request", `sha "${bad}" must be refused`);
  }

  const ok = parseCommitFilesRequest(new URL(`${base}?source_id=s&project_path=o/r&sha=${SHA}`));
  assert.deepEqual(ok, { source_id: "s", project_path: "o/r", sha: SHA });
});

test("github: the single-commit response becomes one file list plus the commit's own total", async () => {
  const { rest, paths } = restStub(() => GITHUB_COMMIT);
  const result = await fetchCommitFiles(cfg(), { source_id: "github:github.com", project_path: "serenvia/secrets", sha: SHA }, deps(rest));
  assert.ok(!isCommitFilesError(result));
  assert.deepEqual(paths, [`repos/serenvia/secrets/commits/${SHA}`]);
  assert.deepEqual((result as CommitFilesResult).files, [
    { path: "docs/devlog/2026-09.md", status: "modified", additions: 40, deletions: 0 },
    { path: "host/README.md", status: "added", additions: 7, deletions: 0 },
    { path: "old/path.py", status: "renamed", additions: 85, deletions: 3 },
  ]);
  // The commit's own stats, not the sum of the listed files: they still describe
  // the whole commit when the file list is capped.
  assert.deepEqual((result as CommitFilesResult).total, { additions: 132, deletions: 3 });
  assert.equal((result as CommitFilesResult).total_scope, "commit");
  assert.equal((result as CommitFilesResult).truncated, false);
});

test("github: a 300-file response is reported as truncated, not as a small commit", async () => {
  const files = Array.from({ length: 300 }, (_, i) => ({ filename: `src/f${i}.ts`, status: "modified", additions: 1, deletions: 1 }));
  const { rest } = restStub(() => ({ files, stats: { additions: 900, deletions: 900 } }));
  const result = await fetchCommitFiles(cfg(), { source_id: "github:github.com", project_path: "serenvia/secrets", sha: SHA }, deps(rest));
  assert.ok(!isCommitFilesError(result));
  assert.equal((result as CommitFilesResult).truncated, true);
  assert.equal((result as CommitFilesResult).files.length, 300);
  // GitHub still reports the WHOLE commit under a capped list, which is what
  // total_scope has to disclose so a label cannot claim "first N files".
  assert.deepEqual((result as CommitFilesResult).total, { additions: 900, deletions: 900 });
  assert.equal((result as CommitFilesResult).total_scope, "commit");
});

test("gitlab diff lines: hunk content counts, file headers do not", () => {
  const diff = [
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,4 +1,5 @@",
    " context",
    "+added one",
    "+added two",
    "-removed one",
    "\\ No newline at end of file",
  ].join("\n");
  assert.deepEqual(countDiffLines(diff), { additions: 2, deletions: 1 });
  assert.deepEqual(countDiffLines(""), { additions: 0, deletions: 0 });
  // A binary file comes back with no diff text at all rather than as an error.
  assert.deepEqual(countDiffLines(null), { additions: 0, deletions: 0 });
});

test("gitlab: the raw diff feed becomes the same shape, with counts read off the hunks", async () => {
  const { rest, paths } = restStub(() => [
    { new_path: "src/app.ts", old_path: "src/app.ts", diff: "@@\n+one\n+two\n-three\n" },
    { new_path: "docs/new.md", old_path: "docs/new.md", new_file: true, diff: "@@\n+fresh\n" },
    { new_path: "gone.txt", old_path: "gone.txt", deleted_file: true, diff: "@@\n-bye\n" },
    { new_path: "after.ts", old_path: "before.ts", renamed_file: true, diff: "" },
  ]);
  const result = await fetchCommitFiles(cfg(), { source_id: "gitlab:gitlab.example.com", project_path: "group/sub/app", sha: SHA }, deps(rest));
  assert.ok(!isCommitFilesError(result));
  // The full path is URL-encoded as the project id, so no extra id lookup call.
  assert.deepEqual(paths, [`projects/group%2Fsub%2Fapp/repository/commits/${SHA}/diff`]);
  assert.deepEqual((result as CommitFilesResult).files, [
    { path: "src/app.ts", status: "modified", additions: 2, deletions: 1 },
    { path: "docs/new.md", status: "added", additions: 1, deletions: 0 },
    { path: "gone.txt", status: "removed", additions: 0, deletions: 1 },
    { path: "after.ts", status: "renamed", additions: 0, deletions: 0 },
  ]);
  // GitLab reports no commit-level totals on this feed, so the sum of the files
  // is the only honest total.
  assert.deepEqual((result as CommitFilesResult).total, { additions: 3, deletions: 2 });
  assert.equal((result as CommitFilesResult).total_scope, "listed");
  assert.equal((result as CommitFilesResult).truncated, false);
});

test("only a configured project may be read, so the route cannot be pointed at any repo the token can reach", async () => {
  const { rest, paths } = restStub(() => GITHUB_COMMIT);
  const result = await fetchCommitFiles(cfg(), { source_id: "github:github.com", project_path: "someone/private", sha: SHA }, deps(rest));
  assert.ok(isCommitFilesError(result));
  assert.equal(result.error, "unknown_project");
  assert.deepEqual(paths, [], "no provider call may be made for an unconfigured project");
});

test("an unknown or disabled source is refused before any provider call", async () => {
  const { rest, paths } = restStub(() => GITHUB_COMMIT);
  const unknown = await fetchCommitFiles(cfg(), { source_id: "github:nope", project_path: "o/r", sha: SHA }, deps(rest));
  assert.ok(isCommitFilesError(unknown) && unknown.error === "unknown_source");
  const disabled = await fetchCommitFiles(cfg(), { source_id: "github:disabled", project_path: "o/off", sha: SHA }, deps(rest));
  assert.ok(isCommitFilesError(disabled) && disabled.error === "unknown_source");
  assert.deepEqual(paths, []);
});

test("a source with no resolvable token says so instead of failing the request", async () => {
  const { rest } = restStub(() => GITHUB_COMMIT);
  const result = await fetchCommitFiles(
    cfg(),
    { source_id: "github:github.com", project_path: "serenvia/secrets", sha: SHA },
    deps(rest, noTokens),
  );
  assert.ok(isCommitFilesError(result));
  assert.equal(result.error, "no_token");
});

test("a provider failure degrades to a message, never an exception", async () => {
  const { rest } = restStub(() => {
    throw new Error("REST HTTP 404: No commit found for SHA");
  });
  const result = await fetchCommitFiles(cfg(), { source_id: "github:github.com", project_path: "serenvia/secrets", sha: SHA }, deps(rest));
  assert.ok(isCommitFilesError(result));
  assert.equal(result.error, "provider_error");
  assert.match(result.message, /No commit found/);
});

test("a commit is immutable, so the second open costs no provider call", async () => {
  const { rest, paths } = restStub(() => GITHUB_COMMIT);
  const shared = deps(rest);
  const first = await fetchCommitFiles(cfg(), { source_id: "github:github.com", project_path: "serenvia/secrets", sha: SHA }, shared);
  const second = await fetchCommitFiles(cfg(), { source_id: "github:github.com", project_path: "serenvia/secrets", sha: SHA }, shared);
  assert.deepEqual(paths.length, 1, "the cached commit must not be re-fetched");
  assert.deepEqual(first, second);
});

test("diff counting is hunk-scoped, so content that looks like a file header still counts", () => {
  // A removed markdown rule (`---`) arrives as `----` and an added one as
  // `+---`; skipping every line that merely STARTS with a header prefix
  // silently undercounted both. Only lines after a `@@` are content.
  const diff = [
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1,6 +1,6 @@",
    " title",
    "----",
    "+++new heading",
    "+---",
    "-was here",
    "@@ -20,2 +20,2 @@",
    "+second hunk add",
  ].join("\n");
  assert.deepEqual(countDiffLines(diff), { additions: 3, deletions: 2 });
  // Nothing before the first hunk counts, whatever it looks like.
  assert.deepEqual(countDiffLines("--- a/x\n+++ b/x\n"), { additions: 0, deletions: 0 });
});

test("gitlab: a full diff page is reported as truncated, with the total covering only what is listed", async () => {
  const entries = Array.from({ length: 100 }, (_, i) => ({
    new_path: `src/f${i}.ts`,
    old_path: `src/f${i}.ts`,
    diff: "@@\n+one\n-two\n",
  }));
  const { rest } = restStub(() => entries);
  const result = await fetchCommitFiles(cfg(), { source_id: "gitlab:gitlab.example.com", project_path: "group/sub/app", sha: SHA }, deps(rest));
  assert.ok(!isCommitFilesError(result));
  assert.equal((result as CommitFilesResult).truncated, true);
  assert.deepEqual((result as CommitFilesResult).total, { additions: 100, deletions: 100 });
  // Unlike GitHub there is no commit-level total to fall back on, so the label
  // must be told that this covers the listed prefix only.
  assert.equal((result as CommitFilesResult).total_scope, "listed");
});

test("the allowlist is re-checked ahead of the cache, so de-configuring a project takes effect at once", async () => {
  const { rest, paths } = restStub(() => GITHUB_COMMIT);
  const shared = deps(rest);
  const req = { source_id: "github:github.com", project_path: "serenvia/secrets", sha: SHA };
  assert.ok(!isCommitFilesError(await fetchCommitFiles(cfg(), req, shared)));

  const withoutProject = cfg();
  withoutProject.sources[0]!.projects = ["serenvia/other"];
  const removed = await fetchCommitFiles(withoutProject, req, shared);
  assert.ok(isCommitFilesError(removed) && removed.error === "unknown_project", "a warmed cache must not outlive the config that authorized it");

  const disabled = cfg();
  disabled.sources[0]!.enabled = false;
  const off = await fetchCommitFiles(disabled, req, shared);
  assert.ok(isCommitFilesError(off) && off.error === "unknown_source");
  assert.equal(paths.length, 1, "neither refusal may reach the provider");
});

test("concurrent identical requests share one provider call", async () => {
  let release: (value: unknown) => void = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { rest, paths } = restStub(() => gate.then(() => GITHUB_COMMIT));
  const shared = deps(rest);
  const req = { source_id: "github:github.com", project_path: "serenvia/secrets", sha: SHA };
  const both = Promise.all([fetchCommitFiles(cfg(), req, shared), fetchCommitFiles(cfg(), req, shared)]);
  release(null);
  const [first, second] = await both;
  assert.equal(paths.length, 1, "the second caller must join the in-flight resolution, not start another");
  assert.deepEqual(first, second);
});

test("a provider failure is cached briefly, then retried; a config refusal is never cached", async () => {
  let clockMs = 1_000_000;
  const clock = { now: () => clockMs };
  let mode: "fail" | "ok" = "fail";
  const { rest, paths } = restStub(() => {
    if (mode === "fail") throw new Error("REST HTTP 502: bad gateway");
    return GITHUB_COMMIT;
  });
  const shared = deps(rest, resolver, clock);
  const req = { source_id: "github:github.com", project_path: "serenvia/secrets", sha: SHA };

  assert.ok(isCommitFilesError(await fetchCommitFiles(cfg(), req, shared)));
  // Within the window a scripted caller cannot turn requests into provider
  // calls 1:1 — that is what makes an unauthenticated route affordable.
  assert.ok(isCommitFilesError(await fetchCommitFiles(cfg(), req, shared)));
  assert.equal(paths.length, 1);

  // But the reason was transient, so it must not stick to the commit.
  clockMs += 61_000;
  mode = "ok";
  assert.ok(!isCommitFilesError(await fetchCommitFiles(cfg(), req, shared)));
  assert.equal(paths.length, 2);

  // A refusal derived from config is recomputed every time, never cached.
  const noToken = deps(rest, noTokens, clock);
  const first = await fetchCommitFiles(cfg(), { ...req, sha: OTHER_SHA }, noToken);
  const again = await fetchCommitFiles(cfg(), { ...req, sha: OTHER_SHA }, noToken);
  assert.ok(isCommitFilesError(first) && first.error === "no_token");
  assert.ok(isCommitFilesError(again) && again.error === "no_token");
});
