import type { CanonicalActivity, CanonicalItem } from "./types.ts";
import { deriveActorKey } from "./actor.ts";

export function stableActivityId(parts: Array<string | number | null | undefined>): string {
  return parts
    .filter((p): p is string | number => p !== null && p !== undefined && String(p).length > 0)
    .map((p) => encodeURIComponent(String(p)))
    .join(":");
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
