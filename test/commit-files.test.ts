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
  type CommitFilesResult,
} from "../src/server/commit-files.ts";

const SHA = "24f59ca944420547a274023d003032d5e0b666b4";

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

function deps(rest: RestClient, authTokenResolver: AuthTokenResolver = resolver) {
  return {
    restClientFactory: () => rest,
    authTokenResolver,
    // A per-test cache; the module-level one must not leak between tests.
    cache: new Map<string, CommitFilesResult>(),
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
  for (const bad of ["", "abc", "../../etc/passwd", "HEAD", `${SHA}/../../other`]) {
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
  assert.equal((result as CommitFilesResult).truncated, false);
});

test("github: a 300-file response is reported as truncated, not as a small commit", async () => {
  const files = Array.from({ length: 300 }, (_, i) => ({ filename: `src/f${i}.ts`, status: "modified", additions: 1, deletions: 1 }));
  const { rest } = restStub(() => ({ files, stats: { additions: 900, deletions: 900 } }));
  const result = await fetchCommitFiles(cfg(), { source_id: "github:github.com", project_path: "serenvia/secrets", sha: SHA }, deps(rest));
  assert.ok(!isCommitFilesError(result));
  assert.equal((result as CommitFilesResult).truncated, true);
  assert.equal((result as CommitFilesResult).files.length, 300);
  assert.deepEqual((result as CommitFilesResult).total, { additions: 900, deletions: 900 });
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
