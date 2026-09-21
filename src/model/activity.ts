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
