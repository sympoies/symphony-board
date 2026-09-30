import type { ActivityDTO, ActorDirectoryDTO, ReviewThreadDTO } from "@symphony-board/contract";
import { zonedDateOnly, zonedHour } from "./tz.ts";
import { commitBranches, commitMessage, commitStats } from "./model.ts";
import { safeHref } from "./url.ts";

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

// The contract's `actor_directory` (4.7.0+) as the two lookups a ranking needs:
// raw actor string -> canonical display name, and canonical name -> bot.
//
// Resolved once per directory rather than per call: every rail ranks actors on
// two or three different facet sources, and each of those re-ranks on any filter
// change. Absent directory (a pre-4.7.0 payload, or a hand-loaded file) yields
// empty maps, which `rankActors` treats as "rank the raw strings" — the old
// behavior, so an old contract still renders.
export interface ActorIndex {
  canonical: ReadonlyMap<string, string>;
  bots: ReadonlySet<string>;
}

export const EMPTY_ACTOR_INDEX: ActorIndex = { canonical: new Map(), bots: new Set() };

export function actorIndex(directory: ActorDirectoryDTO | null | undefined): ActorIndex {
  const canonical = new Map<string, string>();
  const bots = new Set<string>();
  for (const identity of directory?.identities ?? []) {
    if (identity.bot) bots.add(identity.name);
    for (const actor of identity.actors) canonical.set(actor, identity.name);
  }
  return { canonical, bots };
}

// Every raw actor string belonging to one canonical name, for turning a ranked
// row back into a filter the raw feed can apply.
//
// Unions EVERY entry with that name rather than taking the first. Two identities
// can legitimately share a display name — distinct actor_keys the producer had
// no config bridge for, e.g. a CI account seen both as a provider user and as
// commit authorship — and the ranking already counts them as one row, since it
// groups by name. Taking only the first entry's actors would then filter to part
// of the row you clicked.
export function actorsOf(directory: ActorDirectoryDTO | null | undefined, name: string): string[] {
  const actors = (directory?.identities ?? []).filter((i) => i.name === name).flatMap((i) => i.actors);
  return actors.length > 0 ? [...new Set(actors)] : [name];
}

// A row's calendar day and hour in a zone, computed once per row.
//
// Zoning a timestamp goes through Intl and costs about 5us, which is nothing
// for one pass and is the whole cost of this module for seven. The Commits
// wide-panes tier draws that many views of the same rows -- per-day counts, a
// stack, lines changed, a day-by-hour grid, a series per author -- and at 25k
// rows each extra pass was another ~125ms on every filter change. The rows are
// the contract's own objects and outlive a render, so the answer is remembered
// on the object: the first view to ask pays, the rest read it back.
//
// Keyed weakly, so a replaced contract takes its entries with it, and by zone,
// so changing the zone recomputes instead of returning yesterday's bucket.
type ZonedParts = { tz: string; date: string; hour: number | null };
const zonedParts = new WeakMap<ActivityDTO, ZonedParts | null>();

function zonedOf(a: ActivityDTO, tz: string): ZonedParts | null {
  const cached = zonedParts.get(a);
  if (cached !== undefined && (cached === null || cached.tz === tz)) return cached;
  const ms = Date.parse(a.occurred_at);
  const parts = Number.isFinite(ms) ? { tz, date: zonedDateOnly(ms, tz), hour: null } : null;
  zonedParts.set(a, parts);
  return parts;
}

// The zoned `YYYY-MM-DD` a row falls on, or null for an unparseable instant.
function zonedDateOf(a: ActivityDTO, tz: string): string | null {
  return zonedOf(a, tz)?.date ?? null;
}

// The zoned hour, filled in on first use: only two of the views need it.
function zonedHourOf(a: ActivityDTO, tz: string): number | null {
  const parts = zonedOf(a, tz);
  if (!parts) return null;
  if (parts.hour === null) parts.hour = zonedHour(Date.parse(a.occurred_at), tz);
  return parts.hour;
}

// Rank by author. `actor` is nullable in the contract and a null author is not a
// person — bucketing those together under one "unknown" row would invent a
// contributor, so they are dropped and only named actors compete.
//
// With a directory, a person's facets (provider username, commit display names)
// count as ONE row under their canonical name and CI/dependency accounts are
// dropped — the same merge and filter `repo_metrics.top_actors` applies, which
// this ranking could not reach before 4.7.0 because it keys on raw feed strings.
// Bots are dropped from the RANKING only; they still count wherever totals are
// computed off the same rows, exactly as top_actors behaves.
export function rankActors(
  activities: readonly ActivityDTO[],
  limit: number,
  index: ActorIndex = EMPTY_ACTOR_INDEX,
): RailRank[] {
  const counts = new Map<string, number>();
  for (const a of activities) {
    const actor = a.actor?.trim();
    if (!actor) continue;
    const name = index.canonical.get(actor) ?? actor;
    if (index.bots.has(name)) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return topRanks(counts, limit);
}

export interface CommitAuthorOption {
  author: string;
  count: number;
}

// The author options the Commits toolbar offers, counted over the facet source
// (every filter applied except this one) and merged through the same
// `actor_directory` identity as the rail, so picking a name in the dropdown and
// clicking that person's rail row select the same rows.
//
// Unlike `rankActors` this KEEPS bot accounts. That ranking answers "who are
// the top people", where a CI account is noise; a filter answers "show me only
// these commits", and hiding bots there would leave rows plainly visible in the
// list with no way to select them. It is also unlimited, because a picker that
// silently omits the author you are looking for is worse than a long list.
//
// It lives here rather than beside commitBranchOptions in model.ts because the
// identity merge it depends on is this module's — and model.ts cannot import
// back from here.
export function commitAuthorOptions(
  activities: readonly ActivityDTO[],
  index: ActorIndex = EMPTY_ACTOR_INDEX,
): CommitAuthorOption[] {
  const counts = new Map<string, number>();
  for (const a of activities) {
    const actor = a.actor?.trim();
    if (!actor) continue;
    const name = index.canonical.get(actor) ?? actor;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([author, count]) => ({ author, count }))
    .sort((a, b) => b.count - a.count || a.author.localeCompare(b.author));
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
    const hour = zonedHourOf(a, tz);
    if (hour === null) continue;
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
    const date = zonedDateOf(a, tz);
    if (date === null) continue;
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  const days = enumerateDays(fromDate, toDate);
  return days.map((date) => ({ date, count: counts.get(date) ?? 0 }));
}

// Which bars of the per-day strip carry a date under them.
//
// A week gets one label per bar. Past that the labels are wider than the bars
// they name and would run into each other, so only the ends and the middle
// stay -- enough to read the span and its direction, with the rest on hover.
// `index` is the bar's position, so the caller can put the label under the
// right one without re-deriving it from the date.
export type DayAxisTick = {
  index: number;
  // `MM-DD`. The year is the range's, which the overview head already states.
  label: string;
};

const DAY_AXIS_EVERY_MAX = 10;

// Takes anything dated rather than DayBucket: the stacked and the lines-changed
// charts label the same axis over their own per-day shapes.
export function dayAxisTicks(days: readonly { date: string }[]): DayAxisTick[] {
  const tick = (index: number): DayAxisTick => ({ index, label: days[index]!.date.slice(5) });
  if (days.length <= DAY_AXIS_EVERY_MAX) return days.map((_, index) => tick(index));
  const last = days.length - 1;
  return [tick(0), tick(Math.floor(last / 2)), tick(last)];
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

// Canonical actor name -> provider-reported avatar URL. Project/repository events
// carry the event author's photo in details; review comments fill gaps. Resolve
// both through the same directory as rankActors so a GitLab username can supply
// the photo for its merged commit-author name. Never infer an image URL from a
// username: account-less git authors have no reliable provider profile.
export function actorAvatarIndex(
  threads: readonly ReviewThreadDTO[],
  activities: readonly ActivityDTO[] = [],
  actorIndex: ActorIndex = EMPTY_ACTOR_INDEX,
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  const add = (actor: string | null | undefined, value: unknown) => {
    const name = actor?.trim();
    const url = typeof value === "string" ? safeHref(value.trim()) : null;
    if (!name || !url || !/^https?:\/\//i.test(url)) return;
    const canonical = actorIndex.canonical.get(name) ?? name;
    if (!index.has(canonical)) index.set(canonical, url);
  };
  for (const activity of activities) add(activity.actor, activity.details?.actor_avatar_url);
  for (const thread of threads) {
    for (const comment of thread.comments ?? []) {
      add(comment.author, comment.avatar_url);
    }
  }
  return index;
}

// ==================== wide-panes aggregates ==================================
// What the Commits page adds once its supporting columns have room for more
// than rankings: the shape of each day, the size of the work, and who and
// where in more than one number. Same rule as everything above — derived from
// the rows the list already renders, so a pane can never disagree with it.

// ---- stacked per-day series -------------------------------------------------

export type StackSeries = {
  key: string;
  label: string;
  // Total over the whole span, which is also what ranks the series.
  count: number;
};

export type StackedDay = {
  date: string;
  total: number;
  // One count per series, in the series' order, so a bar is drawn by index.
  segments: number[];
};

export type StackedDays = {
  series: StackSeries[];
  days: StackedDay[];
  // The tallest day, for the axis.
  max: number;
};

// The fold's key and label. It is a real key on purpose: the commit-type
// vocabulary already calls an unparsed subject "other", and that row belongs IN
// the fold rather than beside it as a second bar with the same name.
export const STACK_FOLD_KEY = "other";

// Per-day counts split by whatever `keyOf` names, keeping the `limit` largest
// series and folding the rest into one. The fold is what lets an open
// vocabulary (32 repositories, 11 commit types) be drawn with a handful of
// colours without dropping a single commit: every day's segments add up to its
// total.
export function stackedDays(
  activities: readonly ActivityDTO[],
  tz: string,
  fromDate: string,
  toDate: string,
  keyOf: (activity: ActivityDTO) => { key: string; label: string },
  limit: number,
): StackedDays {
  const totals = new Map<string, number>();
  const labels = new Map<string, string>();
  const perDay = new Map<string, Map<string, number>>();
  for (const a of activities) {
    const date = zonedDateOf(a, tz);
    if (date === null) continue;
    const { key, label } = keyOf(a);
    totals.set(key, (totals.get(key) ?? 0) + 1);
    labels.set(key, label);
    const day = perDay.get(date) ?? new Map<string, number>();
    day.set(key, (day.get(key) ?? 0) + 1);
    perDay.set(date, day);
  }

  const named = topRanks(totals, 0).filter((rank) => rank.key !== STACK_FOLD_KEY);
  const kept = named.slice(0, Math.max(0, limit));
  const keptKeys = new Set(kept.map((rank) => rank.key));
  const foldTotal = [...totals.entries()].reduce((sum, [key, count]) => (keptKeys.has(key) ? sum : sum + count), 0);

  const series: StackSeries[] = kept.map((rank) => ({ key: rank.key, label: labels.get(rank.key) ?? rank.key, count: rank.count }));
  if (foldTotal > 0) series.push({ key: STACK_FOLD_KEY, label: STACK_FOLD_KEY, count: foldTotal });

  const days = enumerateDays(fromDate, toDate).map((date) => {
    const counts = perDay.get(date);
    const segments = series.map(() => 0);
    let total = 0;
    for (const [key, count] of counts ?? []) {
      const index = keptKeys.has(key) ? series.findIndex((s) => s.key === key) : series.length - 1;
      segments[index] = (segments[index] ?? 0) + count;
      total += count;
    }
    return { date, total, segments };
  });
  return { series, days, max: Math.max(0, ...days.map((day) => day.total)) };
}

// ---- lines changed ----------------------------------------------------------

export type ChurnDay = {
  date: string;
  additions: number;
  deletions: number;
  // Commits that carried counts, against every commit that day. They differ:
  // a merge never carries them and a commit the producer could not read has
  // none, so the pane can say how much of the day the figure covers.
  counted: number;
  commits: number;
};

export function churnByDay(activities: readonly ActivityDTO[], tz: string, fromDate: string, toDate: string): ChurnDay[] {
  const byDate = new Map<string, ChurnDay>();
  for (const a of activities) {
    const date = zonedDateOf(a, tz);
    if (date === null) continue;
    const day = byDate.get(date) ?? { date, additions: 0, deletions: 0, counted: 0, commits: 0 };
    day.commits += 1;
    const stats = commitStats(a);
    if (stats) {
      day.additions += stats.additions;
      day.deletions += stats.deletions;
      day.counted += 1;
    }
    byDate.set(date, day);
  }
  return enumerateDays(fromDate, toDate).map(
    (date) => byDate.get(date) ?? { date, additions: 0, deletions: 0, counted: 0, commits: 0 },
  );
}

// ---- day x hour -------------------------------------------------------------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
// Monday first: the grid is read as a working week, and Sunday-first splits the
// weekend across its two ends.
const WEEKDAY_ROWS = [1, 2, 3, 4, 5, 6, 0] as const;
// Past this many days a row per date stops being a grid and becomes a list.
const PUNCH_CARD_DAY_ROWS_MAX = 14;

export type PunchRow = {
  // The date for a per-day row, the weekday name for a folded one.
  key: string;
  weekday: string;
  total: number;
  hours: number[];
};

export type PunchCard = {
  rows: PunchRow[];
  // True when the range was too long for a row per day and was folded onto the
  // seven weekdays instead.
  byWeekday: boolean;
  max: number;
  peak: { key: string; weekday: string; hour: number; count: number } | null;
};

// The weekday of a zoned `YYYY-MM-DD`. The string is already a calendar date in
// the viewer's zone, so reading it at UTC midnight is pure calendar arithmetic.
function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

// "Thu" for a zoned date, for axis labels that name the day as well as the date.
export function weekdayLabel(date: string): string {
  return WEEKDAYS[weekdayOf(date)] ?? "";
}

// Commits by day and hour, in the viewer's zone. The hour strip answers "what
// time of day"; this also answers "on which days", which is the difference
// between a team that works evenings and one that shipped late once.
export function punchCard(activities: readonly ActivityDTO[], tz: string, fromDate: string, toDate: string): PunchCard {
  const dates = enumerateDays(fromDate, toDate);
  const byWeekday = dates.length > PUNCH_CARD_DAY_ROWS_MAX;
  const rows: PunchRow[] = byWeekday
    ? WEEKDAY_ROWS.map((day) => ({ key: WEEKDAYS[day], weekday: WEEKDAYS[day], total: 0, hours: Array.from({ length: 24 }, () => 0) }))
    : dates.map((date) => ({ key: date, weekday: WEEKDAYS[weekdayOf(date)]!, total: 0, hours: Array.from({ length: 24 }, () => 0) }));
  const rowOf = new Map(rows.map((row) => [row.key, row]));

  for (const a of activities) {
    const date = zonedDateOf(a, tz);
    if (date === null) continue;
    const row = rowOf.get(byWeekday ? WEEKDAYS[weekdayOf(date)]! : date);
    if (!row) continue;
    const hour = zonedHourOf(a, tz) ?? 0;
    row.hours[hour] = (row.hours[hour] ?? 0) + 1;
    row.total += 1;
  }

  let peak: PunchCard["peak"] = null;
  for (const row of rows) {
    row.hours.forEach((count, hour) => {
      if (count > 0 && (!peak || count > peak.count)) peak = { key: row.key, weekday: row.weekday, hour, count };
    });
  }
  return { rows, byWeekday, max: peak ? (peak as { count: number }).count : 0, peak };
}

// ---- commit size ------------------------------------------------------------

export type SizedCommit = {
  commit: ActivityDTO;
  additions: number;
  deletions: number;
  lines: number;
};

function sizedCommits(activities: readonly ActivityDTO[]): SizedCommit[] {
  const out: SizedCommit[] = [];
  for (const commit of activities) {
    const stats = commitStats(commit);
    if (stats) out.push({ commit, additions: stats.additions, deletions: stats.deletions, lines: stats.additions + stats.deletions });
  }
  return out;
}

// The commits that changed the most lines. Commits without counts are left out
// rather than ranked as zero: unknown is not small. Ties go to the newer commit.
export function largestCommits(activities: readonly ActivityDTO[], limit: number): SizedCommit[] {
  const sized = sizedCommits(activities).sort(
    (a, b) => b.lines - a.lines || b.commit.occurred_at.localeCompare(a.commit.occurred_at),
  );
  return limit > 0 ? sized.slice(0, limit) : sized;
}

// The middle and the largest commit size, from one pass and one sort.
//
// The median is what "a typical commit" means here: the mean is dragged by one
// vendored file or lockfile. Both are null when no commit carries counts.
export function commitSizeSummary(activities: readonly ActivityDTO[]): { median: number | null; largest: number | null } {
  const lines: number[] = [];
  for (const commit of activities) {
    const stats = commitStats(commit);
    if (stats) lines.push(stats.additions + stats.deletions);
  }
  if (lines.length === 0) return { median: null, largest: null };
  lines.sort((a, b) => a - b);
  return { median: lines[Math.floor((lines.length - 1) / 2)] ?? null, largest: lines[lines.length - 1] ?? null };
}

// A per-day series reduced to at most `max` bars, by summing runs of days.
//
// The author sparkline sits in a column about 86px wide. A week fits a bar per
// day; a year does not, and a bar per day there was 365 elements per author --
// 18,250 across fifty authors -- each narrower than a pixel. Summing into at
// most `max` buckets keeps the shape of the range and bounds the row's DOM by
// the column rather than by the calendar.
export function sparkBuckets(perDay: readonly number[], max: number): number[] {
  if (max <= 0 || perDay.length <= max) return [...perDay];
  const out = Array.from({ length: max }, () => 0);
  perDay.forEach((count, index) => {
    const bucket = Math.min(max - 1, Math.floor((index * max) / perDay.length));
    out[bucket] = (out[bucket] ?? 0) + count;
  });
  return out;
}

// ---- scopes -----------------------------------------------------------------

const CONVENTIONAL_SCOPE = /^[a-z]+\(([^)]+)\)!?:\s/;

// The `scope` of `type(scope): subject`, lower-cased. Null for an unscoped or
// unconventional subject: unlike the type, there is no honest "other" scope.
export function commitScopeOf(message: string): string | null {
  const match = CONVENTIONAL_SCOPE.exec(message.trim().toLowerCase());
  const scope = match?.[1]?.trim();
  return scope ? scope : null;
}

// Which areas the range's work touched, as its authors named them.
export function rankCommitScopes(activities: readonly ActivityDTO[], limit: number): RailRank[] {
  const counts = new Map<string, number>();
  for (const a of activities) {
    const scope = commitScopeOf(commitMessage(a));
    if (scope) counts.set(scope, (counts.get(scope) ?? 0) + 1);
  }
  return topRanks(counts, limit);
}

// ---- facts beside a ranked row ----------------------------------------------
// Keyed exactly as the rankings key their rows, so a row looks its facts up by
// the key it already has.

export type ActorDetail = {
  additions: number;
  deletions: number;
  counted: number;
  repos: number;
  activeDays: number;
  // One count per day of the span, for the row's sparkline.
  perDay: number[];
};

export function actorDetails(
  activities: readonly ActivityDTO[],
  index: ActorIndex,
  tz: string,
  fromDate: string,
  toDate: string,
): Map<string, ActorDetail> {
  const dates = enumerateDays(fromDate, toDate);
  const dayIndex = new Map(dates.map((date, i) => [date, i]));
  const details = new Map<string, ActorDetail>();
  const repos = new Map<string, Set<string>>();
  for (const a of activities) {
    const actor = a.actor?.trim();
    if (!actor) continue;
    const name = index.canonical.get(actor) ?? actor;
    const detail = details.get(name) ?? { additions: 0, deletions: 0, counted: 0, repos: 0, activeDays: 0, perDay: dates.map(() => 0) };
    const stats = commitStats(a);
    if (stats) {
      detail.additions += stats.additions;
      detail.deletions += stats.deletions;
      detail.counted += 1;
    }
    const date = zonedDateOf(a, tz);
    const slot = date === null ? undefined : dayIndex.get(date);
    if (slot !== undefined) detail.perDay[slot] = (detail.perDay[slot] ?? 0) + 1;
    const path = a.project_path?.trim();
    if (path) {
      const set = repos.get(name) ?? new Set<string>();
      set.add(`${a.source_id}|${path}`);
      repos.set(name, set);
    }
    details.set(name, detail);
  }
  for (const [name, detail] of details) {
    detail.repos = repos.get(name)?.size ?? 0;
    detail.activeDays = detail.perDay.filter((count) => count > 0).length;
  }
  return details;
}

export type RepoDetail = {
  // Distinct people, merged the way the author ranking merges them.
  authors: number;
  lastAt: string | null;
};

export function repoDetails(activities: readonly ActivityDTO[], index: ActorIndex): Map<string, RepoDetail> {
  const details = new Map<string, RepoDetail>();
  const authors = new Map<string, Set<string>>();
  for (const a of activities) {
    const path = a.project_path?.trim();
    if (!path) continue;
    const key = `${a.source_id}|${path}`;
    const detail = details.get(key) ?? { authors: 0, lastAt: null };
    if (!detail.lastAt || a.occurred_at > detail.lastAt) detail.lastAt = a.occurred_at;
    const actor = a.actor?.trim();
    if (actor) {
      const set = authors.get(key) ?? new Set<string>();
      set.add(index.canonical.get(actor) ?? actor);
      authors.set(key, set);
    }
    details.set(key, detail);
  }
  for (const [key, detail] of details) detail.authors = authors.get(key)?.size ?? 0;
  return details;
}

export type BranchDetail = {
  // A branch is ranked by NAME across repositories, so `main` is every repo's
  // main. This says how many that is.
  repos: number;
};

export function branchDetails(activities: readonly ActivityDTO[]): Map<string, BranchDetail> {
  const repos = new Map<string, Set<string>>();
  for (const a of activities) {
    const path = a.project_path?.trim();
    for (const branch of commitBranches(a)) {
      const set = repos.get(branch) ?? new Set<string>();
      if (path) set.add(`${a.source_id}|${path}`);
      repos.set(branch, set);
    }
  }
  return new Map([...repos.entries()].map(([branch, set]) => [branch, { repos: set.size }]));
}
