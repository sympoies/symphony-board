import type { ActivityDTO } from "@symphony-board/contract";
import { zonedDateOnly, zonedHour } from "./tz.ts";
import { commitBranches, commitMessage } from "./model.ts";

// Aggregations for the Commits and Activity side rails. Every one of these reads
// the SAME array the page already renders, so a rail can never disagree with the
// list beside it and never needs a fetch of its own. Deliberately DOM-free, like
// model.ts, so it stays unit-testable and cannot drag the DOM lib into a
// type-check program that has none.
//
// `rankRepos` below and `model.ts::commitRepoOptions` both group by
// `(source_id, project_path)` and both count, but they are not interchangeable:
//
//   commitRepoOptions  builds the combobox OPTION SET over the whole window and
//                      keeps `project_path` / `source_id` as separate fields
//                      because the picker needs them. Ties break on
//                      `project_path`, then `source_id`.
//   rankRepos          ranks an ARBITRARY slice — the facet source, which already
//                      has the other filters applied — into the generic RailRank
//                      shape the chart consumes. Ties break on the composite
//                      `source_id|project_path` key.
//
// So the tie-break differs, and only between repos with equal counts. Folding
// either into the other would mean giving one consumer the other's sort.

export type RailRank = {
  key: string;
  label: string;
  count: number;
};

export type HourBucket = {
  hour: number;
  count: number;
};

export type DayBucket = {
  // Zoned `YYYY-MM-DD`, so a bar lines up with the calendar day a viewer sees.
  date: string;
  count: number;
};

// Rank by author. `actor` is nullable in the contract and a null author is not a
// person — bucketing those together under one "unknown" row would invent a
// contributor, so they are dropped and only named actors compete.
export function rankActors(activities: readonly ActivityDTO[], limit: number): RailRank[] {
  const counts = new Map<string, number>();
  for (const a of activities) {
    const actor = a.actor?.trim();
    if (!actor) continue;
    counts.set(actor, (counts.get(actor) ?? 0) + 1);
  }
  return topRanks(counts, limit);
}

// Rank by repository, across sources. The key carries `source_id` so the same
// `project_path` mirrored on two providers stays two rows — identity is
// `(source_id, project_path)` per the repo's grouping rule.
export function rankRepos(activities: readonly ActivityDTO[], limit: number): RailRank[] {
  const counts = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const a of activities) {
    const path = a.project_path?.trim();
    if (!path) continue;
    const key = `${a.source_id}|${path}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    labels.set(key, path);
  }
  return topRanks(counts, limit).map((rank) => ({ ...rank, label: labels.get(rank.key) ?? rank.label }));
}

// Ties break on the label, so an unchanged data set always ranks the same way
// rather than following Map insertion order.
function topRanks(counts: ReadonlyMap<string, number>, limit: number): RailRank[] {
  const ranks = [...counts.entries()].map(([key, count]) => ({ key, label: key, count }));
  ranks.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return limit > 0 ? ranks.slice(0, limit) : ranks;
}

// Hour-of-day profile, in the viewer's zone. Always 24 buckets, including empty
// ones: the shape of a working day is the point, and dropping quiet hours would
// compress the axis and hide the gap between night and morning.
export function countsByHour(activities: readonly ActivityDTO[], tz: string): HourBucket[] {
  const buckets: HourBucket[] = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  for (const a of activities) {
    const ms = Date.parse(a.occurred_at);
    if (!Number.isFinite(ms)) continue;
    const hour = zonedHour(ms, tz);
    const bucket = buckets[hour];
    if (bucket) bucket.count += 1;
  }
  return buckets;
}

// Per-day counts across an inclusive `YYYY-MM-DD` span, zero-filled. The span is
// driven by the selected range rather than by the data, so a quiet day renders as
// a gap instead of silently collapsing the axis and making activity look
// continuous.
export function countsByDay(
  activities: readonly ActivityDTO[],
  tz: string,
  fromDate: string,
  toDate: string,
): DayBucket[] {
  const counts = new Map<string, number>();
  for (const a of activities) {
    const ms = Date.parse(a.occurred_at);
    if (!Number.isFinite(ms)) continue;
    const date = zonedDateOnly(ms, tz);
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  const days = enumerateDays(fromDate, toDate);
  return days.map((date) => ({ date, count: counts.get(date) ?? 0 }));
}

// Walk the span in UTC whole days. The endpoints are already zoned date strings,
// so this is pure calendar arithmetic on them and never re-crosses a zone — which
// is what keeps a DST day from being skipped or doubled.
const DAY_MS = 86_400_000;
const MAX_DAYS = 400;

function enumerateDays(fromDate: string, toDate: string): string[] {
  const start = Date.parse(`${fromDate}T00:00:00Z`);
  const end = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const out: string[] = [];
  for (let ms = start; ms <= end && out.length < MAX_DAYS; ms += DAY_MS) {
    out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}

// A rank footer is only a few characters wide, so `owner/name` never fits. The
// name is the half that identifies the repo to a reader who already knows the
// org. Shared by both rails so the labelling rule has one home.
export function shortRepoLabel(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

// Rank by branch membership. A commit can sit on several branches, so it counts
// once per branch it belongs to — the number beside a branch is "commits on this
// branch", not a partition of the range.
export function rankBranches(activities: readonly ActivityDTO[], limit: number): RailRank[] {
  const counts = new Map<string, number>();
  for (const a of activities) {
    for (const branch of commitBranches(a)) {
      counts.set(branch, (counts.get(branch) ?? 0) + 1);
    }
  }
  return topRanks(counts, limit);
}

// Conventional-commit type, read off the message prefix (`feat:`, `fix(scope):`).
// A board that must stay provider-neutral cannot assume the convention, so
// anything that does not parse is counted as "other" rather than dropped — a repo
// that does not use conventional commits then shows one honest "other" bar
// instead of an empty panel pretending there was nothing to measure.
const CONVENTIONAL_TYPE = /^([a-z]+)(?:\([^)]*\))?!?:\s/;

export function commitTypeOf(message: string): string {
  const match = CONVENTIONAL_TYPE.exec(message.trim().toLowerCase());
  return match?.[1] ?? "other";
}

export function rankCommitTypes(activities: readonly ActivityDTO[], limit: number): RailRank[] {
  const counts = new Map<string, number>();
  for (const a of activities) {
    const type = commitTypeOf(commitMessage(a));
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return topRanks(counts, limit);
}

// Rank by a plain string field. Backs the Activity rail's What (kind) and How
// (action) panels, which put counts on the same vocabulary the filter chips above
// the feed already use — the chips have never shown how much each one covers.
function rankByField(activities: readonly ActivityDTO[], field: "kind" | "action", limit: number): RailRank[] {
  const counts = new Map<string, number>();
  for (const a of activities) {
    const value = a[field]?.trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return topRanks(counts, limit);
}

export function rankKinds(activities: readonly ActivityDTO[], limit: number): RailRank[] {
  return rankByField(activities, "kind", limit);
}

export function rankActions(activities: readonly ActivityDTO[], limit: number): RailRank[] {
  return rankByField(activities, "action", limit);
}
