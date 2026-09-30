import type { CanonicalActivity, CanonicalItem } from "./types.ts";
import { deriveActorKey } from "./actor.ts";

export function stableActivityId(parts: Array<string | number | null | undefined>): string {
  return parts
    .filter((p): p is string | number => p !== null && p !== undefined && String(p).length > 0)
    .map((p) => encodeURIComponent(String(p)))
    .join(":");
}

export interface CommitLineStats {
  additions: number;
  deletions: number;
}

// The line counts a commit activity may carry, or null when the row must not
// carry any. Shared by both providers so the rule is one rule.
//
// A MERGE commit is deliberately excluded. Both providers report a merge's
// additions/deletions as the diff against its FIRST parent, so anything that
// sums a range counts the merged branch's work twice — once in its own commits
// and again in the merge that brought them in. The fetchers already skip the
// lookup for merges (no request spent); this is the replay-side guard, because
// a stored payload can carry stats for one anyway — GitLab's list response
// returns them for every commit once `with_stats` is on, merges included.
//
// Anything that is not a whole non-negative count yields null rather than a
// coerced number: an absent value means "unknown", which consumers render as
// nothing, and inventing a 0 would claim the commit changed nothing.
export function commitLineStats(raw: unknown, parentCount: number): CommitLineStats | null {
  if (parentCount > 1) return null;
  const stats = raw as { additions?: unknown; deletions?: unknown } | null | undefined;
  const additions = lineCount(stats?.additions);
  const deletions = lineCount(stats?.deletions);
  return additions === null || deletions === null ? null : { additions, deletions };
}

function lineCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

// What a commit activity row says about its commit, shared by both providers so
// the row has one shape and one set of rules (see docs/CONTRACT.md, Activities).
//
// `branch`/`ref` carry the primary branch (the default branch whenever the
// commit is on it), and multi-branch membership adds the full `branches`/`refs`
// lists. `default_branch` names the repository's default branch beside them,
// because the primary branch of a commit that lives only on a side branch is
// that side branch — so without it a consumer cannot tell the two apart.
//
// `merge` is present, and true, only for a commit with more than one parent. A
// merge carries no line counts by design (commitLineStats), which made it
// indistinguishable from a commit whose counts could not be read.
//
// Every optional key is absent rather than empty when the payload does not
// support it: absent means "unknown", never "no".
export interface CommitDetailsInput {
  sha: string;
  message: string | null;
  body: string | null;
  // Default branch first, side branches alphabetical (the payload's order).
  branches: string[];
  defaultBranch: string | null;
  parentCount: number;
  // The provider's raw line counts, validated by commitLineStats.
  stats: unknown;
}

export function commitDetails(input: CommitDetailsInput): Record<string, unknown> {
  const details: Record<string, unknown> = { sha: input.sha, message: input.message };
  if (input.body) details.body = input.body;
  const primary = input.branches[0];
  if (primary) {
    details.branch = primary;
    details.ref = `refs/heads/${primary}`;
  }
  if (input.branches.length > 1) {
    details.branches = input.branches;
    details.refs = input.branches.map((b) => `refs/heads/${b}`);
  }
  if (input.defaultBranch) details.default_branch = input.defaultBranch;
  if (input.parentCount > 1) details.merge = true;
  const stats = commitLineStats(input.stats, input.parentCount);
  if (stats) {
    details.additions = stats.additions;
    details.deletions = stats.deletions;
  }
  return details;
}

export function itemActivities(item: CanonicalItem): CanonicalActivity[] {
  const target = { sourceId: item.sourceId, externalId: item.externalId };
  const base = {
    sourceId: item.sourceId,
    projectPath: item.projectPath,
    targetKind: item.kind,
    target,
    targetIid: item.iid,
    title: item.title,
    url: item.url,
    actor: item.author,
    // Item authors are always a provider username, so the key is the
    // `provider-user:*` form — the same key build.ts recomputes for the item
    // row, which merges an "opened" transition with the item it describes.
    actorKey: deriveActorKey({ sourceId: item.sourceId, username: item.author }),
    details: null,
  } satisfies Partial<CanonicalActivity>;
  const out: CanonicalActivity[] = [];
  if (item.createdAt) {
    out.push({
      ...base,
      externalId: stableActivityId(["item", item.externalId, "opened", item.createdAt]),
      kind: item.kind,
      action: "opened",
      occurredAt: item.createdAt,
      summary: `${item.kind === "change_request" ? "Opened change request" : "Opened issue"}${item.iid != null ? ` #${item.iid}` : ""}`,
    } as CanonicalActivity);
  }
  if (item.kind === "change_request" && item.mergedAt) {
    out.push({
      ...base,
      externalId: stableActivityId(["item", item.externalId, "merged", item.mergedAt]),
      kind: item.kind,
      action: "merged",
      occurredAt: item.mergedAt,
      summary: `Merged change request${item.iid != null ? ` #${item.iid}` : ""}`,
    } as CanonicalActivity);
  } else if (item.closedAt) {
    out.push({
      ...base,
      externalId: stableActivityId(["item", item.externalId, "closed", item.closedAt]),
      kind: item.kind,
      action: "closed",
      occurredAt: item.closedAt,
      summary: `${item.kind === "change_request" ? "Closed change request" : "Closed issue"}${item.iid != null ? ` #${item.iid}` : ""}`,
    } as CanonicalActivity);
  }
  return out;
}
