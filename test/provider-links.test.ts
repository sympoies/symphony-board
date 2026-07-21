import { test } from "node:test";
import assert from "node:assert/strict";
import {
  providerChangeRequestUrl,
  providerCommitUrl,
  providerIssueUrl,
  providerProfileUrl,
  providerRepoUrl,
} from "../src/provider-links.ts";

test("Forgejo links use GitHub-like routes and preserve a configured instance path", () => {
  const codeberg = { kind: "forgejo", host: "codeberg.org", baseUrl: "https://codeberg.org" };
  assert.equal(providerRepoUrl(codeberg, "acme/widgets"), "https://codeberg.org/acme/widgets");
  assert.equal(providerIssueUrl(codeberg, "acme/widgets", 7), "https://codeberg.org/acme/widgets/issues/7");
  assert.equal(providerChangeRequestUrl(codeberg, "acme/widgets", 8), "https://codeberg.org/acme/widgets/pulls/8");
  assert.equal(providerCommitUrl(codeberg, "acme/widgets", "abcdef1"), "https://codeberg.org/acme/widgets/commit/abcdef1");
  assert.equal(providerProfileUrl(codeberg, "alice"), "https://codeberg.org/alice");

  const nested = { kind: "forgejo", host: "forge.example", baseUrl: "https://forge.example/services/code" };
  assert.equal(providerRepoUrl(nested, "acme/widgets"), "https://forge.example/services/code/acme/widgets");
  assert.equal(providerIssueUrl(nested, "acme/widgets", 7), "https://forge.example/services/code/acme/widgets/issues/7");
});
