import { test } from "node:test";
import assert from "node:assert/strict";
import { refOf, parseRef } from "../src/model/ref.ts";

test("refOf + parseRef roundtrip survives a GitLab gid (colons and slashes)", () => {
  const ref = refOf("gitlab:gitlab.example.com", "gid://gitlab/Issue/123");
  assert.equal(ref, "gitlab:gitlab.example.com|gid://gitlab/Issue/123");
  const ep = parseRef(ref);
  assert.equal(ep.sourceId, "gitlab:gitlab.example.com");
  assert.equal(ep.externalId, "gid://gitlab/Issue/123");
});

test("refOf rejects a '|' in source_id", () => {
  assert.throws(() => refOf("bad|source", "x"), /must not contain/);
});

test("parseRef splits on the first '|' only", () => {
  const ep = parseRef("github:github.com|a|b|c");
  assert.equal(ep.sourceId, "github:github.com");
  assert.equal(ep.externalId, "a|b|c");
});
