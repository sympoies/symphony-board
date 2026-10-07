import type { ActivityDTO, RepoMetricDTO } from "@symphony-board/contract";
import { commitBranches } from "./model.ts";
import type { ActorIndex } from "./rail-stats.ts";
import { externalWebUrl, type ProviderEntity, type ProviderLinkSource } from "../../../shared/provider-links.ts";

export interface EntityDestination { sourceId: string; entity: ProviderEntity; label: string }

export function linkSource(sourceId: string | null | undefined, sources: ReadonlyMap<string, ProviderLinkSource>): ProviderLinkSource | null {
  if (!sourceId) return null;
  const configured = sources.get(sourceId);
  if (configured) return configured;
  const match = /^(github|gitlab):([^|]+)$/.exec(sourceId);
  return match ? { kind: match[1]!, host: match[2]! } : null;
}

// Aggregate labels can refer to multiple repositories/provider accounts. Retain
// every candidate; the component deduplicates exact URLs rather than picking an
// arbitrary first row as the destination.
export function branchDestinations(activities: readonly ActivityDTO[], branch: string): EntityDestination[] {
  const rows = new Map<string, EntityDestination>();
  for (const activity of activities) {
    if (!activity.project_path || !commitBranches(activity).includes(branch)) continue;
    const key = `${activity.source_id}|${activity.project_path}`;
    rows.set(key, { sourceId: activity.source_id, label: `${activity.project_path} · ${activity.source_id}`,
      entity: { kind: "branch", projectPath: activity.project_path, ref: branch } });
  }
  return [...rows.values()];
}

export function actorDestinations(activities: readonly ActivityDTO[], name: string, index: ActorIndex): EntityDestination[] {
  const rows = new Map<string, EntityDestination>();
  for (const activity of activities) {
    if (!activity.actor || (index.canonical.get(activity.actor) ?? activity.actor) !== name) continue;
    const url = typeof activity.details?.actor_profile_url === "string" ? activity.details.actor_profile_url : null;
    const key = `${activity.source_id}|${activity.actor}|${url ?? ""}`;
    rows.set(key, { sourceId: activity.source_id, label: `${activity.actor} · ${activity.source_id}`,
      entity: { kind: "profile", username: activity.kind === "commit" ? null : activity.actor, url } });
  }
  return [...rows.values()];
}

export function profileIndex(metrics: readonly Pick<RepoMetricDTO, "source_id" | "top_actors">[]): ReadonlyMap<string, string> {
  const urls = new Map<string, Set<string>>();
  for (const metric of metrics) for (const actor of metric.top_actors ?? []) {
    const url = externalWebUrl(actor.profile_url);
    if (!url) continue;
    for (const name of [actor.actor, actor.display_name, ...(actor.aliases ?? [])]) {
      const key = `${metric.source_id}|${name}`;
      const set = urls.get(key) ?? new Set<string>();
      set.add(url); urls.set(key, set);
    }
  }
  return new Map([...urls].filter(([, values]) => values.size === 1).map(([key, values]) => [key, [...values][0]!]));
}
