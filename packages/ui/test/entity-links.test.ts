import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActivityDTO, RepoMetricActorDTO } from "@symphony-board/contract";
import { actorDestinations, branchDestinations, linkSource, profileIndex } from "../src/entity-links.ts";
import { EMPTY_ACTOR_INDEX } from "../src/rail-stats.ts";

const row = (values: Partial<ActivityDTO>): ActivityDTO => ({
  source_id: "gitlab:gitlab.example.test", external_id: "event", kind: "commit", action: "committed",
  project_path: "group/project", target_kind: null, target_ref: null, target_iid: null, title: null, url: null,
  actor: "Commit Author", occurred_at: "2020-01-01T00:00:00Z", details: { branches: ["main"] },
  first_seen_at: null, last_seen_at: null, ...values,
});

test("configured instances win; Live uses only explicit provider source identities", () => {
  const configured = new Map([["custom", { kind: "gitlab", host: "gitlab.example.test:8443" }]]);
  assert.deepEqual(linkSource("custom", configured), configured.get("custom"));
  assert.deepEqual(linkSource("github:github.com", configured), { kind: "github", host: "github.com" });
  assert.deepEqual(linkSource("gitlab:gitlab.example.test", configured), { kind: "gitlab", host: "gitlab.example.test" });
  assert.equal(linkSource("unsupported", configured), null);
  assert.equal(linkSource(null, configured), null);
});

test("branch destinations retain every repository and deduplicate repeated rows", () => {
  const entries = branchDestinations([row({}), row({}), row({ project_path: "group/other" }), row({ project_path: null }), row({ details: null })], "main");
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.entity.projectPath, "group/project");
  assert.equal(entries[1]?.entity.projectPath, "group/other");
  assert.deepEqual(branchDestinations([row({})], "missing"), []);
});

test("commit display names never become guessed usernames; provider handles and observed bot URLs do", () => {
  const entries = actorDestinations([row({}), row({}), row({ kind: "comment", details: { actor_profile_url: "https://gitlab.example.test/contributor" } })], "Commit Author", EMPTY_ACTOR_INDEX);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.entity.username, null);
  assert.equal(entries[1]?.entity.url, "https://gitlab.example.test/contributor");
  assert.equal(entries[1]?.entity.username, "Commit Author");
  const index = { canonical: new Map([["contributor", "Contributor"]]), bots: new Set<string>() };
  assert.equal(actorDestinations([row({ actor: "contributor", kind: "review" }), row({ actor: null })], "Contributor", index).length, 1);
  assert.deepEqual(actorDestinations([row({ actor: null })], "unknown", EMPTY_ACTOR_INDEX), []);
});

test("profile aliases are source-specific and ambiguous display names remain unlinked", () => {
  const actor = (profile_url: string, aliases: string[] = []): RepoMetricActorDTO => ({ actor: "Contributor", actor_key: "person:contributor", display_name: "Contributor", profile_url, aliases, activities: 1, commits: 1, items_opened: 0, change_requests_merged: 0 });
  const index = profileIndex([
    { source_id: "github:github.com", top_actors: [actor("https://github.com/contributor", ["Commit Author"])] },
    { source_id: "gitlab:gitlab.example.test", top_actors: [actor("https://gitlab.example.test/contributor")] },
    { source_id: "github:github.com", top_actors: [actor("https://github.com/other")] },
    { source_id: "unsupported", top_actors: [actor("javascript:alert(1)")] },
  ]);
  assert.equal(index.get("github:github.com|Commit Author"), "https://github.com/contributor");
  assert.equal(index.get("github:github.com|Contributor"), undefined);
  assert.equal(index.get("gitlab:gitlab.example.test|Contributor"), "https://gitlab.example.test/contributor");
  assert.equal(index.get("unsupported|Contributor"), undefined);
});
