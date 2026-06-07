import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubSource } from "../src/sources/github.ts";
import type { GqlClient } from "../src/sources/graphql.ts";
import type { SourceDescriptor } from "../src/sources/types.ts";

const DESC: SourceDescriptor = { sourceId: "github:github.com", kind: "github", host: "github.com", displayName: null };

function issueNode(id: string, updatedAt: string) {
  return {
    __typename: "Issue", id, number: 1, title: id, url: `https://x/${id}`, state: "OPEN",
    createdAt: "2026-01-01T00:00:00Z", updatedAt, closedAt: null, stateReason: null,
    author: { login: "a" }, repository: { nameWithOwner: "o/r" },
    labels: { nodes: [] }, comments: { totalCount: 0 }, reactions: { totalCount: 0 },
    closedByPullRequestsReferences: { nodes: [] },
  };
}

// A fake gql that serves one page of two issues (a fresh one and a stale one)
// and an empty PR connection. The issue list is UPDATED_AT desc, as the real
// query requests, so the incremental early-stop can fire on the stale node.
const gql: GqlClient = (async (query: string) => {
  if (query.includes("pullRequests(")) {
    return { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
  }
  return {
    repository: {
      issues: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [issueNode("I_fresh", "2026-06-10T00:00:00Z"), issueNode("I_stale", "2026-01-01T00:00:00Z")],
      },
    },
  };
}) as GqlClient;

test("incremental fetch stops at the first record older than the watermark", async () => {
  const src = new GitHubSource(DESC, gql, ["o/r"]);
  const res = await src.fetch({ since: "2026-03-01T00:00:00Z", full: false });
  const ids = res.records.map((r) => r.externalId);
  assert.deepEqual(ids, ["I_fresh"], "the stale issue (older than the watermark) is not fetched");
  assert.equal(res.complete, true);
});

test("a full sweep ignores the watermark and fetches everything", async () => {
  const src = new GitHubSource(DESC, gql, ["o/r"]);
  // Even with a `since` supplied, full:true nulls it inside the source.
  const res = await src.fetch({ since: "2026-03-01T00:00:00Z", full: true });
  const ids = res.records.map((r) => r.externalId).sort();
  assert.deepEqual(ids, ["I_fresh", "I_stale"], "full sweep keeps the stale issue too");
  assert.equal(res.watermark, "2026-06-10T00:00:00Z", "watermark is the max updatedAt seen");
});
