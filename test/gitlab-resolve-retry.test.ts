// GitLab can answer a per-item resolve with "Timeout on validation of query"
// under load. The same small query usually passes on a later attempt, so the
// resolve is retried on the shared transient backoff before the item fails.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { GitLabSource } from "../src/sources/gitlab.ts";
import { GqlResponseError, type GqlClient } from "../src/sources/graphql.ts";
import type { SourceDescriptor } from "../src/sources/types.ts";

const originalDelays = process.env.SYNC_TRANSIENT_RETRY_DELAYS_MS;
beforeEach(() => { process.env.SYNC_TRANSIENT_RETRY_DELAYS_MS = "1,1"; });
afterEach(() => {
  if (originalDelays === undefined) delete process.env.SYNC_TRANSIENT_RETRY_DELAYS_MS;
  else process.env.SYNC_TRANSIENT_RETRY_DELAYS_MS = originalDelays;
});

const DESC: SourceDescriptor = { sourceId: "gitlab:gitlab.com", kind: "gitlab", host: "gitlab.com", displayName: null };

function mr(id: string, iid: string) {
  return {
    id, iid, title: id, description: "", webUrl: `https://gl/mr/${iid}`, state: "merged",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z", closedAt: null, mergedAt: "2026-06-01T00:00:00Z",
    author: { username: "a" }, labels: { nodes: [] }, userNotesCount: 0, upvotes: 0,
  };
}

function graphqlError(message: string): GqlResponseError {
  return new GqlResponseError(`GraphQL errors: ${message}`, 200, null, [{ message }], null);
}

// One project with two MRs; `failResolve(iid, attempt)` decides whether that
// MR's resolve attempt throws.
function fakeGql(failResolve: (iid: string, attempt: number) => Error | null) {
  const attempts = new Map<string, number>();
  const gql: GqlClient = (async (query: string, vars: any) => {
    if (query.includes("mergeRequests(")) {
      return { project: { mergeRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [mr("gid:MR1", "1"), mr("gid:MR2", "2")] } } };
    }
    if (query.includes("issues(")) {
      return { project: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
    }
    if (query.includes("mergeRequest(iid")) {
      const attempt = (attempts.get(vars.iid) ?? 0) + 1;
      attempts.set(vars.iid, attempt);
      const err = failResolve(vars.iid, attempt);
      if (err) throw err;
      return { project: { mergeRequest: { approvedBy: { nodes: [{ username: "reviewer" }] }, notes: { nodes: [] } } } };
    }
    return {};
  }) as GqlClient;
  return { gql, attempts };
}

const TIMEOUT = "Timeout on validation of query";

test("a resolve that times out in validation once is retried and the sweep stays complete", async () => {
  const { gql, attempts } = fakeGql((iid, attempt) => (iid === "2" && attempt === 1 ? graphqlError(TIMEOUT) : null));
  const res = await new GitLabSource(DESC, gql, ["g/p"]).fetch({ since: null, full: true });
  assert.equal(attempts.get("2"), 2);
  assert.equal(res.complete, true);
  assert.equal(res.error ?? null, null);
  const mr2 = res.records.find((r) => r.externalId === "gid:MR2")!.payload as any;
  assert.deepEqual(mr2.approvedBy.nodes, [{ username: "reviewer" }]);
});

test("a resolve that keeps timing out fails that item only, after the bounded retries", async () => {
  const { gql, attempts } = fakeGql((iid) => (iid === "2" ? graphqlError(TIMEOUT) : null));
  const res = await new GitLabSource(DESC, gql, ["g/p"]).fetch({ since: null, full: true });
  assert.equal(attempts.get("2"), 3, "first attempt plus two retries");
  assert.equal(attempts.get("1"), 1);
  // Its note-derived edges are unknown, so the sweep must stay incomplete: a
  // complete one would retire them.
  assert.equal(res.complete, false);
  assert.match(res.error ?? "", /g\/p change_request#2 resolve: .*Timeout on validation of query/);
  assert.equal(res.records.length, 2, "both items still produce a record");
});

test("other GraphQL errors are not retried", async () => {
  const { gql, attempts } = fakeGql((iid) => (iid === "2" ? graphqlError("Field 'x' doesn't exist") : null));
  const res = await new GitLabSource(DESC, gql, ["g/p"]).fetch({ since: null, full: true });
  assert.equal(attempts.get("2"), 1);
  assert.equal(res.complete, false);
});
