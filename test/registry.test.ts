import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSource } from "../src/sources/registry.ts";
import { GitHubSource } from "../src/sources/github.ts";
import { GitLabSource } from "../src/sources/gitlab.ts";
import type { SourceConfig } from "../src/config.ts";

// buildSource is the only place a SourceConfig becomes a live Source — a wiring
// mistake here (wrong class, dropped descriptor field) breaks every sync, so the
// mapping is locked even though each class is tested on its own.

function cfg(over: Partial<SourceConfig> = {}): SourceConfig {
  return {
    source_id: "github:github.com",
    kind: "github",
    host: "github.com",
    token_env: "T",
    graphql_url: "https://api.github.com/graphql",
    projects: ["o/r"],
    ...over,
  };
}

test("a github config builds a GitHubSource with the descriptor mapped field-for-field", () => {
  const src = buildSource(cfg({ display_name: "GitHub" }), "tok");
  assert.ok(src instanceof GitHubSource);
  assert.deepEqual(src.descriptor, {
    sourceId: "github:github.com",
    kind: "github",
    host: "github.com",
    displayName: "GitHub",
  });
});

test("a missing display_name maps to a null descriptor displayName", () => {
  const src = buildSource(cfg(), "tok");
  assert.equal(src.descriptor.displayName, null);
});

test("a gitlab config builds a GitLabSource", () => {
  const src = buildSource(
    cfg({ source_id: "gitlab:gitlab.com", kind: "gitlab", host: "gitlab.com", graphql_url: "https://gitlab.com/api/graphql" }),
    "tok",
  );
  assert.ok(src instanceof GitLabSource);
  assert.equal(src.descriptor.sourceId, "gitlab:gitlab.com");
  assert.equal(src.descriptor.kind, "gitlab");
});

test("an unknown source kind throws and names the offending source", () => {
  assert.throws(
    () => buildSource(cfg({ kind: "bitbucket", source_id: "bb:x" }), "tok"),
    /unknown source kind "bitbucket" for bb:x/,
  );
});
