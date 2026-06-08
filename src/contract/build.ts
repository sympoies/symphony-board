// Build the contract envelope (LAYER 3) from canonical DB rows. Pure mapping:
// given rows + a `generatedAt` instant, produce the versioned envelope. No DB
// access here, so it is unit-testable with fabricated rows.

import type { ActivityRow, ItemRow, LabelRow, EdgeRow, SourceRow } from "../db/repo.ts";
import type {
  ActivityDTO,
  ContractEnvelope,
  ItemDTO,
  EdgeDTO,
  SourceDTO,
  RepoDTO,
  RepoStatsDTO,
  RepoMetricActorDTO,
  RepoMetricBucket,
  RepoMetricDTO,
  RepoMetricStatsDTO,
  RepoMetricWindowDTO,
  LabelDTO,
  AggregateDTO,
  AggregateStatsDTO,
  AggregateWindowDTO,
  ItemWindowDTO,
  ItemWindowReason,
  TimeRangeDTO,
  ItemState,
  ReviewState,
  CiState,
  MergeState,
  EdgeLifecycle,
} from "@symphony-board/contract";
import { refOf } from "../model/ref.ts";
import { deriveActorKey, emailActorKey, normalizeActorName } from "../model/actor.ts";
import type { IdentityConfig } from "../config.ts";
import { CONTRACT_VERSION, GENERATOR } from "./version.ts";
import { zonedDayStartIso, zonedDateOnly, shiftDateOnly } from "../lib/tz.ts";

const asState = (s: string): ItemState => s as ItemState;
const orNull = <T extends string>(s: string | null): T | null => (s === null ? null : (s as T));
const ACTIVE_WINDOW_DAYS = [7, 14, 30, 90] as const;
const CONTRACT_ITEM_WINDOW_DAYS = 90;
const MAX_REPO_METRIC_ACTORS = 5;

function toLabelDTO(l: LabelRow): LabelDTO {
  return { name: l.name, scope: l.scope, color: l.color };
}

function toItemDTO(row: ItemRow, labels: LabelRow[], windowReasons?: ItemWindowReason[]): ItemDTO {
  return {
    id: refOf(row.source_id, row.external_id),
    source_id: row.source_id,
    external_id: row.external_id,
    kind: row.kind,
    project_path: row.project_path,
    iid: row.iid,
    url: row.url ?? "",
    title: row.title,
    state: asState(row.state),
    state_raw: row.state_raw,
    state_reason: row.state_reason,
    is_draft: row.is_draft === null ? null : row.is_draft !== 0,
    author: row.author,
    created_at: row.created_at,
    updated_at: row.updated_at,
    closed_at: row.closed_at,
    merged_at: row.merged_at,
    labels: labels.map(toLabelDTO),
    review_state: orNull<ReviewState>(row.review_state),
    ci_state: orNull<CiState>(row.ci_state),
    merge_state: orNull<MergeState>(row.merge_state),
    milestone: row.milestone,
    demand: row.demand,
    last_seen_at: row.last_seen_at,
    ...(windowReasons && windowReasons.length ? { window_reasons: windowReasons } : {}),
  };
}

function toEdgeDTO(row: EdgeRow): EdgeDTO {
  return {
    type: row.type,
    from: refOf(row.from_source_id, row.from_external_id),
    to: refOf(row.to_source_id, row.to_external_id),
    from_state: orNull<ItemState>(row.from_state),
    to_state: orNull<ItemState>(row.to_state),
    lifecycle: orNull<EdgeLifecycle>(row.lifecycle),
  };
}

function parseDetails(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function toActivityDTO(row: ActivityRow): ActivityDTO {
  const target_ref =
    row.target_source_id && row.target_external_id
      ? refOf(row.target_source_id, row.target_external_id)
      : null;
  return {
    id: refOf(row.source_id, row.external_id),
    source_id: row.source_id,
    external_id: row.external_id,
    kind: row.kind,
    action: row.action,
    project_path: row.project_path,
    target_kind: row.target_kind,
    target_ref,
    target_iid: row.target_iid,
    title: row.title,
    url: row.url,
    actor: row.actor,
    occurred_at: row.occurred_at,
    summary: row.summary,
    details: parseDetails(row.details),
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
  };
}

function toSourceDTO(row: SourceRow, sourceColors: Record<string, string>): SourceDTO {
  return {
    source_id: row.source_id,
    kind: row.kind,
    host: row.host,
    display_name: row.display_name,
    last_success_at: row.last_success_at,
    last_status: orNull<"ok" | "partial" | "error">(row.last_status),
    color: sourceColors[row.source_id] ?? null,
  };
}

function inc(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function computeItemEdgeStats(items: ItemDTO[], edges: EdgeDTO[]): AggregateStatsDTO {
  const by_state: Record<string, number> = {};
  const by_kind: Record<string, number> = {};
  for (const it of items) {
    inc(by_state, it.state);
    inc(by_kind, it.kind);
  }

  const by_lifecycle: Record<string, number> = {};
  for (const edge of edges) inc(by_lifecycle, edge.lifecycle ?? "other");
  return { items: items.length, by_state, by_kind, by_lifecycle };
}

function aggregateWindow(
  kind: AggregateWindowDTO["kind"],
  basis: AggregateWindowDTO["basis"],
  since: string | null,
  days: number | null,
  edgeFilter: AggregateWindowDTO["edge_filter"],
): AggregateWindowDTO {
  return { kind, basis, since, days, edge_filter: edgeFilter };
}

function cutoffIso(days: number, generatedAt: string): string {
  return new Date(Date.parse(generatedAt) - days * 86_400_000).toISOString();
}

function timestampMs(value: string | null | undefined): number | null {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) ? ms : null;
}

function timestampAtOrAfter(value: string | null | undefined, cutoff: string | null): boolean {
  if (!cutoff) return true;
  const valueMs = timestampMs(value);
  const cutoffMs = timestampMs(cutoff);
  return valueMs !== null && cutoffMs !== null && valueMs >= cutoffMs;
}

function timestampInRange(value: string | null | undefined, range: TimeRangeDTO): boolean {
  const valueMs = timestampMs(value);
  const fromMs = timestampMs(range.from);
  const toMs = timestampMs(range.to);
  return valueMs !== null && fromMs !== null && toMs !== null && valueMs >= fromMs && valueMs <= toMs;
}

function itemActiveSince(item: ItemDTO, cutoff: string | null): boolean {
  return timestampAtOrAfter(item.updated_at, cutoff);
}

function itemUpdatedInRange(item: ItemDTO, range: TimeRangeDTO): boolean {
  return timestampInRange(item.updated_at, range);
}

function activityOccurredInRange(activity: ActivityDTO, range: TimeRangeDTO): boolean {
  return timestampInRange(activity.occurred_at, range);
}

function compareActivityInstantDesc(a: ActivityDTO, b: ActivityDTO): number {
  const aMs = timestampMs(a.occurred_at);
  const bMs = timestampMs(b.occurred_at);
  if (aMs !== null && bMs !== null && aMs !== bMs) return bMs - aMs;
  if (aMs !== null && bMs === null) return -1;
  if (aMs === null && bMs !== null) return 1;
  return 0;
}

function sortActivitiesByInstantDesc(activities: ActivityDTO[]): ActivityDTO[] {
  return [...activities].sort(compareActivityInstantDesc);
}

function boardWindowEdges(items: ItemDTO[], edges: EdgeDTO[]): EdgeDTO[] {
  const ids = new Set(items.map((item) => item.id));
  return edges.filter((edge) => ids.has(edge.from) || ids.has(edge.to));
}

function graphWindowEdges(edges: EdgeDTO[], byId: Map<string, ItemDTO>, cutoff: string | null): EdgeDTO[] {
  return edges.filter((edge) => {
    if (!cutoff) return true;
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from && !to) return true;
    return timestampAtOrAfter(from?.updated_at, cutoff) || timestampAtOrAfter(to?.updated_at, cutoff);
  });
}

function noMentions(edges: EdgeDTO[]): EdgeDTO[] {
  return edges.filter((edge) => edge.type !== "mentions");
}

function computeGraphStats(edges: EdgeDTO[], byId: Map<string, ItemDTO>): AggregateStatsDTO {
  const refs = new Set<string>();
  for (const edge of edges) {
    refs.add(edge.from);
    refs.add(edge.to);
  }

  const by_state: Record<string, number> = {};
  const by_kind: Record<string, number> = {};
  for (const ref of refs) {
    const item = byId.get(ref);
    inc(by_state, item?.state ?? "unknown");
    inc(by_kind, item?.kind ?? "unknown");
  }

  const by_lifecycle: Record<string, number> = {};
  for (const edge of edges) inc(by_lifecycle, edge.lifecycle ?? "other");
  return { items: refs.size, by_state, by_kind, by_lifecycle };
}

function buildRepoStats(items: ItemDTO[]): RepoStatsDTO[] {
  const byRepo = new Map<string, RepoStatsDTO>();
  for (const item of items) {
    const key = JSON.stringify([item.source_id, item.project_path]);
    let repo = byRepo.get(key);
    if (!repo) {
      repo = {
        source_id: item.source_id,
        project_path: item.project_path,
        items: 0,
        by_state: {},
        by_kind: {},
      };
      byRepo.set(key, repo);
    }
    repo.items += 1;
    inc(repo.by_state, item.state);
    inc(repo.by_kind, item.kind);
  }
  return [...byRepo.values()].sort(
    (a, b) => a.source_id.localeCompare(b.source_id) || (a.project_path ?? "").localeCompare(b.project_path ?? ""),
  );
}

function emptyRepoMetricStats(): RepoMetricStatsDTO {
  return {
    items_active: 0,
    items_opened: 0,
    items_closed: 0,
    change_requests_opened: 0,
    change_requests_closed: 0,
    change_requests_merged: 0,
    activities: 0,
    activity_score: 0,
    commits: 0,
    pushes: 0,
    comments: 0,
    reviews: 0,
    approvals: 0,
    edge_declared: 0,
    edge_fulfilled: 0,
    edge_broken: 0,
    by_item_state: {},
    by_item_kind: {},
    by_activity_kind: {},
    by_activity_action: {},
    by_edge_type: {},
    by_edge_lifecycle: {},
    by_review_state: {},
    by_ci_state: {},
    by_merge_state: {},
    by_label_scope: {},
  };
}

function repoKey(sourceId: string, projectPath: string | null): string {
  return JSON.stringify([sourceId, projectPath]);
}

function repoSort(a: { source_id: string; project_path: string | null }, b: { source_id: string; project_path: string | null }): number {
  return a.source_id.localeCompare(b.source_id) || (a.project_path ?? "").localeCompare(b.project_path ?? "");
}

function rangeMs(range: TimeRangeDTO): { fromMs: number; toMs: number } {
  return { fromMs: Date.parse(range.from), toMs: Date.parse(range.to) };
}

function windowDays(range: TimeRangeDTO): number {
  const { fromMs, toMs } = rangeMs(range);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return 0;
  return Math.ceil((toMs - fromMs + 1) / 86_400_000);
}

function repoMetricBucket(range: TimeRangeDTO): RepoMetricBucket {
  const days = windowDays(range);
  if (days <= 31) return "day";
  if (days <= 180) return "week";
  return "month";
}

// The next bucket's start date (a "YYYY-MM-DD" in the configured zone). Day and
// week step whole calendar days; month advances one calendar month, preserving
// the day-of-month with JS roll-over (e.g. Jan 31 -> Mar 3), matching the prior
// UTC behavior.
function advanceBucketDate(dateStr: string, bucket: RepoMetricBucket): string {
  if (bucket === "day") return shiftDateOnly(dateStr, 1);
  if (bucket === "week") return shiftDateOnly(dateStr, 7);
  const parts = dateStr.split("-");
  return new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1 + 1, Number(parts[2]))).toISOString().slice(0, 10);
}

// Split a range into series buckets aligned to the configured zone's calendar
// days (so e.g. one local day is exactly one "day" bucket). The boundary day
// starts are resolved at the zone's local midnight; `tz === "UTC"` reduces to
// the original UTC-day alignment.
function bucketRanges(range: TimeRangeDTO, bucket: RepoMetricBucket, tz: string): TimeRangeDTO[] {
  const { fromMs, toMs } = rangeMs(range);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return [];
  const buckets: TimeRangeDTO[] = [];
  let cursorDate = zonedDateOnly(fromMs, tz);
  let cursorMs = Date.parse(zonedDayStartIso(cursorDate, tz));
  while (cursorMs <= toMs) {
    const nextDate = advanceBucketDate(cursorDate, bucket);
    const nextMs = Date.parse(zonedDayStartIso(nextDate, tz));
    const start = Math.max(cursorMs, fromMs);
    const end = Math.min(nextMs - 1, toMs);
    buckets.push({ from: new Date(start).toISOString(), to: new Date(end).toISOString() });
    cursorDate = nextDate;
    cursorMs = nextMs;
  }
  return buckets;
}

function valueInRange(value: string | null | undefined, range: TimeRangeDTO): boolean {
  const valueMs = timestampMs(value);
  const { fromMs, toMs } = rangeMs(range);
  return valueMs !== null && Number.isFinite(fromMs) && Number.isFinite(toMs) && valueMs >= fromMs && valueMs <= toMs;
}

function isCommitActivity(activity: ActivityDTO): boolean {
  return activity.kind === "commit" || activity.action === "committed";
}

function isPushActivity(activity: ActivityDTO): boolean {
  return activity.kind === "push" || activity.action === "pushed" || activity.action === "force_pushed";
}

function isCommentActivity(activity: ActivityDTO): boolean {
  return activity.kind === "comment" || activity.action.includes("comment");
}

function isReviewActivity(activity: ActivityDTO): boolean {
  return activity.kind === "review" || activity.action.includes("review");
}

function isApprovalActivity(activity: ActivityDTO): boolean {
  return activity.action === "approved" || activity.action.includes("approval");
}

function repoActivityScore(stats: RepoMetricStatsDTO): number {
  const issuesOpened = Math.max(0, stats.items_opened - stats.change_requests_opened);
  return (
    stats.commits * 0.25 +
    issuesOpened * 2 +
    stats.change_requests_opened * 3 +
    stats.change_requests_merged * 4 +
    stats.comments * 0.5 +
    stats.reviews * 1.5 +
    stats.approvals * 1.5
  );
}

// One human's aggregated repo-metric counters, keyed by canonical actor identity
// (see src/model/actor.ts), not by raw display string. `names` tallies every raw
// display string seen for the identity so the build can pick a deterministic
// display name and surface the rest as aliases.
interface ActorAccumulator {
  key: string;
  names: Map<string, number>;
  // Set when a config identity merged this accumulator: the declared display
  // name wins over the frequency pick (see chooseDisplayName).
  canonicalName?: string;
  activities: number;
  commits: number;
  items_opened: number;
  change_requests_merged: number;
}

// Get-or-create the accumulator for `key`, recording one observation of the raw
// display `name`. A null key (a record that names no actor) is dropped, matching
// the old raw-string behavior of skipping empty actors.
function recordActor(
  map: Map<string, ActorAccumulator>,
  key: string | null,
  name: string | null,
): ActorAccumulator | null {
  if (!key) return null;
  let acc = map.get(key);
  if (!acc) {
    acc = { key, names: new Map(), activities: 0, commits: 0, items_opened: 0, change_requests_merged: 0 };
    map.set(key, acc);
  }
  const display = name?.trim();
  if (display) acc.names.set(display, (acc.names.get(display) ?? 0) + 1);
  return acc;
}

// Case-insensitive then code-unit ordering: deterministic across runs (unlike a
// bare localeCompare tie) while still folding case for the primary comparison.
function compareName(a: string, b: string): number {
  return a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b);
}

// Deterministic display name for an identity: a config-declared `canonicalName`
// when one merged this actor, else the most frequently observed raw name,
// tie-broken by `compareName`. The remaining distinct names become aliases. An
// identity with no name ever observed (e.g. an email-only record) falls back to
// its key so the field is never empty.
function chooseDisplayName(acc: ActorAccumulator): { displayName: string; aliases: string[] } {
  const observed = [...acc.names.entries()].sort((a, b) => b[1] - a[1] || compareName(a[0], b[0])).map(([name]) => name);
  if (acc.canonicalName) {
    return { displayName: acc.canonicalName, aliases: observed.filter((n) => n !== acc.canonicalName).sort(compareName) };
  }
  if (observed.length === 0) return { displayName: acc.key, aliases: [] };
  return { displayName: observed[0]!, aliases: observed.slice(1).sort(compareName) };
}

// A compiled config identity: the canonical key/name plus the match sets it owns
// (provider usernames, hashed email keys, normalized names). See IdentityConfig.
interface IdentityMatcher {
  key: string; // person:<slug>
  name: string;
  usernames: Set<string>; // lowercased
  emailKeys: Set<string>; // email:<hash>
  names: Set<string>; // normalized
}

function identitySlug(name: string, index: number): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `person:${slug || index}`;
}

function buildIdentityMatchers(identities: IdentityConfig[] | undefined): IdentityMatcher[] {
  // Two entries whose names slug to the same value (e.g. "Terry Lin" and
  // "terry-lin"), or that collide with the empty-slug index fallback, would
  // otherwise share a person:<slug> key and wrongly merge two distinct declared
  // people. Disambiguate so every entry gets a unique canonical key.
  const used = new Set<string>();
  return (identities ?? []).map((id, i) => {
    const base = identitySlug(id.name, i);
    let key = base;
    for (let n = 0; used.has(key); n++) key = `${base}-${i}-${n}`;
    used.add(key);
    return {
      key,
      name: id.name,
      usernames: new Set((id.usernames ?? []).map((u) => u.trim().toLowerCase()).filter(Boolean)),
      emailKeys: new Set((id.emails ?? []).map((e) => emailActorKey(e)).filter((k): k is string => !!k)),
      names: new Set((id.names ?? []).map((n) => normalizeActorName(n)).filter(Boolean)),
    };
  });
}

// The username component of a `provider-user:<source_id>:<username>` key. Usernames
// never contain ':' at the providers we model, so the final segment is the username.
function usernameOfKey(key: string): string | null {
  if (!key.startsWith("provider-user:")) return null;
  const i = key.lastIndexOf(":");
  return i >= 0 ? key.slice(i + 1) : null;
}

// First identity that claims this accumulator (by username, hashed email, or any
// observed display name), or null. First-match wins on a (mis)configured overlap.
function resolveIdentity(acc: ActorAccumulator, matchers: IdentityMatcher[]): IdentityMatcher | null {
  if (matchers.length === 0) return null;
  const username = usernameOfKey(acc.key);
  const observed = [...acc.names.keys()].map((n) => normalizeActorName(n));
  for (const m of matchers) {
    if (username && m.usernames.has(username)) return m;
    if (m.emailKeys.has(acc.key)) return m;
    if (observed.some((n) => m.names.has(n))) return m;
  }
  return null;
}

// Collapse every accumulator a config identity claims into one canonical row,
// summing counters and unioning observed names. Untouched actors keep their key.
function applyIdentities(actors: Map<string, ActorAccumulator>, matchers: IdentityMatcher[]): Map<string, ActorAccumulator> {
  if (matchers.length === 0) return actors;
  const merged = new Map<string, ActorAccumulator>();
  for (const acc of actors.values()) {
    const id = resolveIdentity(acc, matchers);
    const key = id ? id.key : acc.key;
    let target = merged.get(key);
    if (!target) {
      target = { key, names: new Map(), activities: 0, commits: 0, items_opened: 0, change_requests_merged: 0 };
      if (id) target.canonicalName = id.name;
      merged.set(key, target);
    }
    target.activities += acc.activities;
    target.commits += acc.commits;
    target.items_opened += acc.items_opened;
    target.change_requests_merged += acc.change_requests_merged;
    for (const [name, count] of acc.names) target.names.set(name, (target.names.get(name) ?? 0) + count);
  }
  return merged;
}

// Auto-detected service accounts: a GitHub `[bot]` login suffix (reserved by
// GitHub) or a GitLab project/group access-token username. Official,
// zero-false-positive markers, dropped from top_actors without any config.
function isAutoBot(key: string): boolean {
  const username = usernameOfKey(key);
  if (!username) return false;
  return username.endsWith("[bot]") || /^(project|group)_\d+_bot_/.test(username);
}

// Compile config `exclude_actors` into anchored, case-insensitive matchers with
// `*` as a wildcard, tested against an actor's provider username and its display
// names — for the unmarked bots the auto-detector can't catch (e.g. "dependabot").
function compileActorExcludes(patterns: string[] | undefined): RegExp[] {
  return (patterns ?? [])
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
    .map((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`));
}

function isExcludedActor(acc: ActorAccumulator, excludes: RegExp[]): boolean {
  if (excludes.length === 0) return false;
  const candidates = [usernameOfKey(acc.key), ...acc.names.keys()]
    .filter((s): s is string => !!s)
    .map((s) => s.toLowerCase());
  return candidates.some((c) => excludes.some((re) => re.test(c)));
}

// Drop bot / config-excluded actors from the ranked set. Their counters already
// landed in the repo `totals`; this only trims the bounded top_actors list.
function excludeBots(map: Map<string, ActorAccumulator>, excludes: RegExp[]): Map<string, ActorAccumulator> {
  const kept = new Map<string, ActorAccumulator>();
  for (const [key, acc] of map) {
    if (isAutoBot(key) || isExcludedActor(acc, excludes)) continue;
    kept.set(key, acc);
  }
  return kept;
}

function topActors(map: Map<string, ActorAccumulator>): RepoMetricActorDTO[] {
  return [...map.values()]
    .map((acc): RepoMetricActorDTO => {
      const { displayName, aliases } = chooseDisplayName(acc);
      return {
        actor: displayName,
        actor_key: acc.key,
        display_name: displayName,
        ...(aliases.length ? { aliases } : {}),
        activities: acc.activities,
        commits: acc.commits,
        items_opened: acc.items_opened,
        change_requests_merged: acc.change_requests_merged,
      };
    })
    .sort(
      (a, b) =>
        b.activities - a.activities ||
        b.commits - a.commits ||
        b.items_opened - a.items_opened ||
        b.change_requests_merged - a.change_requests_merged ||
        compareName(a.display_name, b.display_name) ||
        a.actor_key.localeCompare(b.actor_key),
    )
    .slice(0, MAX_REPO_METRIC_ACTORS);
}

function edgeEndpointItems(edge: EdgeDTO, byId: Map<string, ItemDTO>): ItemDTO[] {
  const items: ItemDTO[] = [];
  const from = byId.get(edge.from);
  const to = byId.get(edge.to);
  if (from) items.push(from);
  if (to && to.id !== from?.id) items.push(to);
  return items;
}

function edgeTouchesRange(edge: EdgeDTO, byId: Map<string, ItemDTO>, range: TimeRangeDTO): boolean {
  const endpoints = edgeEndpointItems(edge, byId);
  return endpoints.length === 0 || endpoints.some((item) => valueInRange(item.updated_at, range));
}

function repoActivityObservedSince(activities: ActivityDTO[]): string | null {
  let earliest: string | null = null;
  for (const activity of activities) {
    const ms = timestampMs(activity.occurred_at);
    if (ms === null) continue;
    if (earliest === null || ms < Date.parse(earliest)) earliest = activity.occurred_at;
  }
  return earliest;
}

// The most recent activity instant observed for the repo, or null when no row
// carries a parseable timestamp. Mirror of repoActivityObservedSince (max, not
// min) — the "last active" surface the Repo Analytics row renders instead of the
// less useful earliest-observed instant.
function repoActivityObservedUntil(activities: ActivityDTO[]): string | null {
  let latest: string | null = null;
  for (const activity of activities) {
    const ms = timestampMs(activity.occurred_at);
    if (ms === null) continue;
    if (latest === null || ms > Date.parse(latest)) latest = activity.occurred_at;
  }
  return latest;
}

function computeRepoMetricStats(
  items: ItemDTO[],
  edges: EdgeDTO[],
  activities: ActivityDTO[],
  byId: Map<string, ItemDTO>,
  range: TimeRangeDTO,
  actors?: Map<string, ActorAccumulator>,
  // activity id -> canonical actor key, persisted at normalization time. Items
  // carry no email, so their key is recomputed here from (source, author).
  actorKeys?: Map<string, string | null>,
): RepoMetricStatsDTO {
  const stats = emptyRepoMetricStats();

  for (const item of items) {
    const active = valueInRange(item.updated_at, range);
    if (active) {
      stats.items_active += 1;
      inc(stats.by_item_state, item.state);
      inc(stats.by_item_kind, item.kind);
      if (item.review_state) inc(stats.by_review_state, item.review_state);
      if (item.ci_state) inc(stats.by_ci_state, item.ci_state);
      if (item.merge_state) inc(stats.by_merge_state, item.merge_state);
      for (const label of item.labels) inc(stats.by_label_scope, label.scope ?? "unscoped");
    }

    const itemActorKey = actors ? deriveActorKey({ sourceId: item.source_id, username: item.author }) : null;
    if (valueInRange(item.created_at, range)) {
      stats.items_opened += 1;
      const actor = actors ? recordActor(actors, itemActorKey, item.author) : null;
      if (actor) actor.items_opened += 1;
      if (item.kind === "change_request") stats.change_requests_opened += 1;
    }
    if (valueInRange(item.closed_at, range)) {
      stats.items_closed += 1;
      if (item.kind === "change_request" && item.state === "closed") stats.change_requests_closed += 1;
    }
    if (item.kind === "change_request" && valueInRange(item.merged_at, range)) {
      stats.change_requests_merged += 1;
      const actor = actors ? recordActor(actors, itemActorKey, item.author) : null;
      if (actor) actor.change_requests_merged += 1;
    }
  }

  for (const activity of activities) {
    if (!valueInRange(activity.occurred_at, range)) continue;
    stats.activities += 1;
    inc(stats.by_activity_kind, activity.kind);
    inc(stats.by_activity_action, activity.action);
    const actor = actors ? recordActor(actors, actorKeys?.get(activity.id) ?? null, activity.actor) : null;
    if (actor) actor.activities += 1;

    if (isCommitActivity(activity)) {
      stats.commits += 1;
      if (actor) actor.commits += 1;
    }
    if (isPushActivity(activity)) stats.pushes += 1;
    if (isCommentActivity(activity)) stats.comments += 1;
    if (isReviewActivity(activity)) stats.reviews += 1;
    if (isApprovalActivity(activity)) stats.approvals += 1;
  }

  for (const edge of edges) {
    if (!edgeTouchesRange(edge, byId, range)) continue;
    inc(stats.by_edge_type, edge.type);
    inc(stats.by_edge_lifecycle, edge.lifecycle ?? "other");
    if (edge.lifecycle === "declared") stats.edge_declared += 1;
    else if (edge.lifecycle === "fulfilled") stats.edge_fulfilled += 1;
    else if (edge.lifecycle === "broken") stats.edge_broken += 1;
  }

  stats.activity_score = repoActivityScore(stats);
  return stats;
}

function buildRepoMetricWindow(kind: RepoMetricWindowDTO["kind"], range: TimeRangeDTO): RepoMetricWindowDTO {
  return { kind, basis: "repo_activity", from: range.from, to: range.to, bucket: repoMetricBucket(range) };
}

function buildRepoMetrics(
  items: ItemDTO[],
  edges: EdgeDTO[],
  activities: ActivityDTO[],
  window: RepoMetricWindowDTO,
  actorKeys: Map<string, string | null>,
  identityMatchers: IdentityMatcher[],
  actorExcludes: RegExp[],
  timezone: string,
): RepoMetricDTO[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const repoItems = new Map<string, ItemDTO[]>();
  const repoActivities = new Map<string, ActivityDTO[]>();
  const repoEdges = new Map<string, EdgeDTO[]>();
  const repoIdentity = new Map<string, { source_id: string; project_path: string | null }>();

  const ensureRepo = (source_id: string, project_path: string | null): string => {
    const key = repoKey(source_id, project_path);
    if (!repoIdentity.has(key)) repoIdentity.set(key, { source_id, project_path });
    return key;
  };

  for (const item of items) {
    const key = ensureRepo(item.source_id, item.project_path);
    const list = repoItems.get(key) ?? [];
    list.push(item);
    repoItems.set(key, list);
  }

  for (const activity of activities) {
    const key = ensureRepo(activity.source_id, activity.project_path);
    const list = repoActivities.get(key) ?? [];
    list.push(activity);
    repoActivities.set(key, list);
  }

  for (const edge of edges) {
    const keys = new Set<string>();
    for (const endpoint of edgeEndpointItems(edge, byId)) keys.add(ensureRepo(endpoint.source_id, endpoint.project_path));
    for (const key of keys) {
      const list = repoEdges.get(key) ?? [];
      list.push(edge);
      repoEdges.set(key, list);
    }
  }

  const range: TimeRangeDTO = { from: window.from, to: window.to };
  return [...repoIdentity.entries()]
    .map(([key, identity]) => {
      const itemsForRepo = repoItems.get(key) ?? [];
      const activitiesForRepo = repoActivities.get(key) ?? [];
      const edgesForRepo = repoEdges.get(key) ?? [];
      const actors = new Map<string, ActorAccumulator>();
      const totals = computeRepoMetricStats(itemsForRepo, edgesForRepo, activitiesForRepo, byId, range, actors, actorKeys);
      const actorRows = topActors(excludeBots(applyIdentities(actors, identityMatchers), actorExcludes));
      const series = bucketRanges(range, window.bucket, timezone).map((bucket) => ({
        bucket_start: bucket.from,
        bucket_end: bucket.to,
        stats: computeRepoMetricStats(itemsForRepo, edgesForRepo, activitiesForRepo, byId, bucket),
      }));
      const observedSince = repoActivityObservedSince(activitiesForRepo);
      const lastActivityAt = repoActivityObservedUntil(activitiesForRepo);
      const notes: string[] = [];
      if (observedSince === null) {
        notes.push("No activity rows observed for this repo; commit, push, comment, and review metrics may be incomplete.");
      }
      if (identity.project_path === null) notes.push("Project path is missing, so this row groups provider data without repo display metadata.");
      return {
        source_id: identity.source_id,
        project_path: identity.project_path,
        window,
        totals,
        series,
        ...(actorRows.length ? { top_actors: actorRows } : {}),
        data_quality: {
          activity_available: observedSince !== null,
          observed_since: observedSince,
          last_activity_at: lastActivityAt,
          notes,
        },
      };
    })
    .sort(repoSort);
}

function buildAggregates(items: ItemDTO[], edges: EdgeDTO[], generatedAt: string): AggregateDTO[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const graphBaseEdges = noMentions(edges);
  const aggregates: AggregateDTO[] = [
    {
      scope: "global",
      window: aggregateWindow("full", "full_contract", null, null, null),
      stats: computeItemEdgeStats(items, edges),
    },
    {
      scope: "boardWindow",
      window: aggregateWindow("full", "item_updated_at", null, null, null),
      stats: computeItemEdgeStats(items, boardWindowEdges(items, edges)),
    },
    {
      scope: "graphWindow",
      window: aggregateWindow("full", "edge_endpoint_updated_at", null, null, "no_mentions"),
      stats: computeGraphStats(graphBaseEdges, byId),
    },
  ];

  for (const days of ACTIVE_WINDOW_DAYS) {
    const since = cutoffIso(days, generatedAt);
    const boardItems = items.filter((item) => itemActiveSince(item, since));
    aggregates.push({
      scope: "boardWindow",
      window: aggregateWindow("active_since", "item_updated_at", since, days, null),
      stats: computeItemEdgeStats(boardItems, boardWindowEdges(boardItems, edges)),
    });

    const graphEdges = graphWindowEdges(graphBaseEdges, byId, since);
    aggregates.push({
      scope: "graphWindow",
      window: aggregateWindow("active_since", "edge_endpoint_updated_at", since, days, "no_mentions"),
      stats: computeGraphStats(graphEdges, byId),
    });
  }

  return aggregates;
}

function buildWindowedProjection(
  items: ItemDTO[],
  edges: EdgeDTO[],
  generatedAt: string,
): { items: ItemDTO[]; edges: EdgeDTO[]; itemWindow: ItemWindowDTO } {
  const since = cutoffIso(CONTRACT_ITEM_WINDOW_DAYS, generatedAt);
  const primaryIds = new Set(items.filter((item) => itemActiveSince(item, since)).map((item) => item.id));
  const selectedEdges = edges.filter((edge) => primaryIds.has(edge.from) || primaryIds.has(edge.to));

  const endpointIds = new Set<string>();
  for (const edge of selectedEdges) {
    endpointIds.add(edge.from);
    endpointIds.add(edge.to);
  }

  const emittedIds = new Set([...primaryIds, ...endpointIds]);
  const windowedItems = items
    .filter((item) => emittedIds.has(item.id))
    .map((item) => {
      const reasons: ItemWindowReason[] = [];
      if (primaryIds.has(item.id)) reasons.push("primary");
      if (endpointIds.has(item.id)) reasons.push("edge_endpoint");
      return { ...item, window_reasons: reasons };
    });

  const edgeEndpointItems = windowedItems.filter((item) => !primaryIds.has(item.id) && endpointIds.has(item.id)).length;
  return {
    items: windowedItems,
    edges: selectedEdges,
    itemWindow: {
      scope: "boardWindow",
      window: aggregateWindow("active_since", "item_updated_at", since, CONTRACT_ITEM_WINDOW_DAYS, null),
      primary_items: primaryIds.size,
      edge_endpoint_items: edgeEndpointItems,
      total_items: items.length,
      truncated: windowedItems.length < items.length,
    },
  };
}

function edgeKey(edge: EdgeDTO): string {
  return JSON.stringify([edge.type, edge.from, edge.to]);
}

function buildRangeProjection(
  items: ItemDTO[],
  edges: EdgeDTO[],
  activities: ActivityDTO[],
  range: TimeRangeDTO,
): { items: ItemDTO[]; edges: EdgeDTO[]; activities: ActivityDTO[]; itemWindow: ItemWindowDTO } {
  const byId = new Map(items.map((item) => [item.id, item]));
  const primaryIds = new Set(items.filter((item) => itemUpdatedInRange(item, range)).map((item) => item.id));
  const boardEdges = edges.filter((edge) => primaryIds.has(edge.from) || primaryIds.has(edge.to));
  const graphEdges = edges.filter((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    return (from ? itemUpdatedInRange(from, range) : false) || (to ? itemUpdatedInRange(to, range) : false);
  });

  const selectedByKey = new Map<string, EdgeDTO>();
  for (const edge of [...boardEdges, ...graphEdges]) selectedByKey.set(edgeKey(edge), edge);
  const selectedEdges = [...selectedByKey.values()];

  const endpointIds = new Set<string>();
  for (const edge of selectedEdges) {
    endpointIds.add(edge.from);
    endpointIds.add(edge.to);
  }

  const emittedIds = new Set([...primaryIds, ...endpointIds]);
  const windowedItems = items
    .filter((item) => emittedIds.has(item.id))
    .map((item) => {
      const reasons: ItemWindowReason[] = [];
      if (primaryIds.has(item.id)) reasons.push("primary");
      if (endpointIds.has(item.id)) reasons.push("edge_endpoint");
      return { ...item, window_reasons: reasons };
    });

  const edgeEndpointItems = windowedItems.filter((item) => !primaryIds.has(item.id) && endpointIds.has(item.id)).length;
  return {
    items: windowedItems,
    edges: selectedEdges,
    activities: activities.filter((activity) => activityOccurredInRange(activity, range)),
    itemWindow: {
      scope: "boardWindow",
      window: aggregateWindow("active_since", "item_updated_at", range.from, null, null),
      primary_items: primaryIds.size,
      edge_endpoint_items: edgeEndpointItems,
      total_items: items.length,
      truncated: windowedItems.length < items.length,
    },
  };
}

export interface BuildInput {
  sources: SourceRow[];
  items: ItemRow[];
  labels: LabelRow[];
  edges: EdgeRow[];
  activities?: ActivityRow[];
  generatedAt: string;
  // Config-derived display colors (NOT stored in the DB). Threaded in by the
  // emit CLI, which reads config; buildContract stays a pure mapping of its
  // inputs. Both default to empty, so existing callers/tests are unaffected.
  sourceColors?: Record<string, string>; // source_id -> hex
  repoColors?: RepoDTO[]; // sparse: only repos with a configured color
  // Config-declared identity aliases (NOT stored in the DB). Collapse a person's
  // separate actor identities (e.g. a GitLab username vs their commit email) into
  // one top_actors row. Empty/absent leaves automatic keying untouched.
  identities?: IdentityConfig[];
  // Config-declared actor exclusions (NOT stored in the DB). Drop CI/dependency
  // bots from top_actors; combines with the built-in [bot] / service-account
  // auto-detector. Excluded actors still count in totals.
  excludeActors?: string[];
  // Config-declared IANA timezone for calendar-day bucketing (NOT stored in the
  // DB). Emitted onto the envelope for consumers; "UTC" when unset.
  timezone?: string;
}

// Map each activity DTO id to its persisted canonical actor key. Kept off the
// emitted ActivityDTO (the contract's actor identity surface is repo_metrics'
// top_actors); repo-metric aggregation reads it through this side map.
function activityActorKeyMap(rows: ActivityRow[] | undefined): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const row of rows ?? []) map.set(refOf(row.source_id, row.external_id), row.actor_key);
  return map;
}

export function buildContract(input: BuildInput): ContractEnvelope {
  const mapped = mapRows(input);
  const windowed = buildWindowedProjection(mapped.items, mapped.edges, input.generatedAt);
  const actorKeys = activityActorKeyMap(input.activities);
  const identityMatchers = buildIdentityMatchers(input.identities);
  const actorExcludes = compileActorExcludes(input.excludeActors);
  const repoMetricRange = {
    from: cutoffIso(CONTRACT_ITEM_WINDOW_DAYS, input.generatedAt),
    to: input.generatedAt,
  };
  const repoMetricWindow = buildRepoMetricWindow("active_since", repoMetricRange);
  return {
    contract_version: CONTRACT_VERSION,
    generated_at: input.generatedAt,
    generator: GENERATOR,
    timezone: input.timezone ?? "UTC",
    sources: mapped.sources,
    items: windowed.items,
    edges: windowed.edges,
    activities: mapped.activities,
    repos: mapped.repos,
    aggregates: buildAggregates(mapped.items, mapped.edges, input.generatedAt),
    item_window: windowed.itemWindow,
    repo_stats: buildRepoStats(mapped.items),
    repo_metrics: buildRepoMetrics(mapped.items, mapped.edges, mapped.activities, repoMetricWindow, actorKeys, identityMatchers, actorExcludes, input.timezone ?? "UTC"),
  };
}

function mapRows(input: BuildInput): {
  sources: SourceDTO[];
  items: ItemDTO[];
  edges: EdgeDTO[];
  activities: ActivityDTO[];
  repos: RepoDTO[];
} {
  const labelsByItem = new Map<number, LabelRow[]>();
  for (const l of input.labels) {
    const arr = labelsByItem.get(l.item_id) ?? [];
    arr.push(l);
    labelsByItem.set(l.item_id, arr);
  }
  const sourceColors = input.sourceColors ?? {};
  const items = input.items.map((it) => toItemDTO(it, labelsByItem.get(it.item_id) ?? []));
  const edges = input.edges.map(toEdgeDTO);
  return {
    sources: input.sources.map((s) => toSourceDTO(s, sourceColors)),
    activities: sortActivitiesByInstantDesc((input.activities ?? []).map(toActivityDTO)),
    repos: (input.repoColors ?? []).map((r) => ({ source_id: r.source_id, project_path: r.project_path, color: r.color })),
    items,
    edges,
  };
}

export interface BuildRangeInput extends BuildInput {
  range: TimeRangeDTO;
}

export function buildRangeContract(input: BuildRangeInput): ContractEnvelope {
  const mapped = mapRows(input);
  const ranged = buildRangeProjection(mapped.items, mapped.edges, mapped.activities, input.range);
  const actorKeys = activityActorKeyMap(input.activities);
  const identityMatchers = buildIdentityMatchers(input.identities);
  const actorExcludes = compileActorExcludes(input.excludeActors);
  const repoMetricWindow = buildRepoMetricWindow("time_range", input.range);
  const timezone = input.timezone ?? "UTC";
  return {
    contract_version: CONTRACT_VERSION,
    generated_at: input.generatedAt,
    generator: GENERATOR,
    timezone,
    sources: mapped.sources,
    items: ranged.items,
    edges: ranged.edges,
    activities: ranged.activities,
    repos: mapped.repos,
    aggregates: [],
    item_window: ranged.itemWindow,
    repo_stats: buildRepoStats(mapped.items),
    repo_metrics: buildRepoMetrics(mapped.items, mapped.edges, mapped.activities, repoMetricWindow, actorKeys, identityMatchers, actorExcludes, input.timezone ?? "UTC"),
    range_query: { kind: "time_range", timezone, from: input.range.from, to: input.range.to },
  };
}
