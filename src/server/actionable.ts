// Read-only actionable work discovery for agent/local automation consumers.
// This is an operational API, not the semver contract: it reads the canonical
// store directly so consumers do not infer full open-work inventory from the
// intentionally windowed contract `items[]`.

import type { ServerResponse } from "node:http";
import type { AppConfig } from "../config.ts";
import { configuredRepoRefs } from "../config.ts";
import { openConfiguredStoreReadOnly } from "../db/factory.ts";
import type { EdgeRow, ItemRow, LabelRow, SourceRow } from "../db/store.ts";

export type ActionableBucket =
  | "ready-to-merge"
  | "awaiting-review"
  | "needs-work"
  | "in-progress"
  | "ready-to-pick-up"
  | "draft-prs"
  | "parked";

export const ACTIONABLE_BUCKET_ORDER: readonly ActionableBucket[] = [
  "ready-to-merge",
  "awaiting-review",
  "needs-work",
  "in-progress",
  "ready-to-pick-up",
  "draft-prs",
  "parked",
] as const;

export interface ActionableOptions {
  limit: number | null;
  staleDays: number;
  repo: string | null;
  source: string | null;
  includeUnconfigured: boolean;
}

export interface ActionableLabel {
  name: string;
  scope: string | null;
  color: string | null;
}

export interface ActionableItem {
  source_id: string;
  source_kind: string | null;
  repo: string | null;
  iid: number | null;
  kind: string;
  title: string | null;
  url: string | null;
  created_at: string | null;
  updated_at: string | null;
  labels: ActionableLabel[];
  demand: number;
  comments: number | null;
  is_draft: boolean | null;
  review_state: string | null;
  ci_state: string | null;
  merge_state: string | null;
  review_threads: { open: number; total: number } | null;
  bucket: ActionableBucket;
  flags: string[];
}

export interface ActionableBucketGroup {
  bucket: ActionableBucket;
  total: number;
  shown: number;
  more: number;
  items: ActionableItem[];
}

export interface ActionableProjection {
  generated_at: string;
  total: number;
  stale_days: number;
  include_unconfigured: boolean;
  bucket_order: readonly ActionableBucket[];
  buckets: ActionableBucketGroup[];
}

export interface BuildActionableProjectionInput {
  sources: SourceRow[];
  items: ItemRow[];
  labels: LabelRow[];
  edges?: EdgeRow[];
  configuredRepos?: Array<{ source_id: string; project_path: string }>;
  limit?: number | null;
  staleDays?: number;
  repo?: string | null;
  source?: string | null;
  includeUnconfigured?: boolean;
  nowMs?: number;
}

const DEFAULT_STALE_DAYS = 14;

const PARK_LABELS = new Set([
  "blocked",
  "wontfix",
  "on-hold",
  "needs-design",
  "wip",
  "do-not-merge",
  "state::blocked",
  "state::needs-decision",
  "state::needs-info",
  "state::needs-triage",
  "workflow::plan",
  "workflow::tracking",
]);

function parsePositiveInt(value: string | null, name: string): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeNumber(value: string | null, name: string): number | null {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function parseBoolean(value: string | null): boolean {
  if (value == null || value === "") return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function parseActionableOptions(url: URL): ActionableOptions {
  const staleDays = parseNonNegativeNumber(url.searchParams.get("stale_days"), "stale_days") ?? DEFAULT_STALE_DAYS;
  return {
    limit: parsePositiveInt(url.searchParams.get("limit"), "limit"),
    staleDays,
    repo: url.searchParams.get("repo") || null,
    source: url.searchParams.get("source") || null,
    includeUnconfigured:
      parseBoolean(url.searchParams.get("include_unconfigured")) ||
      parseBoolean(url.searchParams.get("include-unconfigured")) ||
      parseBoolean(url.searchParams.get("includeUnconfigured")),
  };
}

function repoKey(sourceId: string, projectPath: string | null): string {
  return JSON.stringify([sourceId, projectPath]);
}

function byItemId(labels: LabelRow[]): Map<number, ActionableLabel[]> {
  const out = new Map<number, ActionableLabel[]>();
  for (const l of labels) {
    const list = out.get(l.item_id) ?? [];
    list.push({ name: l.name, scope: l.scope, color: l.color });
    out.set(l.item_id, list);
  }
  return out;
}

function isParked(labels: readonly ActionableLabel[]): boolean {
  return labels.some((l) => PARK_LABELS.has(l.name.trim().toLowerCase()));
}

function isBadMergeState(value: string | null | undefined): boolean {
  return value === "conflicting" || value === "blocked";
}

function isCiReady(value: string | null | undefined): boolean {
  return value === "passing" || value === "none" || value == null;
}

function hasOpenInboundWork(item: ItemRow, edges: readonly EdgeRow[]): boolean {
  if (item.kind !== "issue") return false;
  return edges.some(
    (e) =>
      e.type === "closes" &&
      e.lifecycle === "declared" &&
      e.to_source_id === item.source_id &&
      e.to_external_id === item.external_id &&
      e.from_state === "open",
  );
}

function bucketFor(item: ItemRow, labels: readonly ActionableLabel[], edges: readonly EdgeRow[]): ActionableBucket {
  if (isParked(labels)) return "parked";
  if (item.kind !== "change_request") return hasOpenInboundWork(item, edges) ? "in-progress" : "ready-to-pick-up";
  if (item.is_draft) return "draft-prs";
  if (
    item.review_state === "changes_requested" ||
    item.ci_state === "failing" ||
    isBadMergeState(item.merge_state) ||
    (item.open_review_threads ?? 0) > 0
  ) {
    return "needs-work";
  }
  if (item.review_state === "approved" && isCiReady(item.ci_state)) return "ready-to-merge";
  return "awaiting-review";
}

function stalenessDays(updatedAt: string | null | undefined, nowMs: number): number {
  if (!updatedAt) return 0;
  const parsed = Date.parse(updatedAt);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor((nowMs - parsed) / 86_400_000));
}

function flagsFor(
  item: ItemRow,
  labels: readonly ActionableLabel[],
  bucket: ActionableBucket,
  configured: boolean,
  nowMs: number,
  staleDays: number,
): string[] {
  const flags: string[] = [];
  if (!configured) flags.push("unconfigured");
  const priority = labels.find((l) => l.scope === "priority" || /^priority::/i.test(l.name) || /^p[0-3]\b/i.test(l.name));
  if (priority) flags.push(`priority:${priority.name}`);
  const stale = stalenessDays(item.updated_at, nowMs);
  if (stale >= staleDays) flags.push(`stale:${stale}d`);
  if (item.is_draft) flags.push("draft");
  if (item.review_state) flags.push(`review:${item.review_state}`);
  if (item.ci_state) flags.push(`ci:${item.ci_state}`);
  if (item.merge_state) flags.push(`merge:${item.merge_state}`);
  if (item.open_review_threads != null || item.total_review_threads != null) {
    flags.push(`threads:${item.open_review_threads ?? 0}/${item.total_review_threads ?? 0}`);
  }
  if (bucket === "parked") {
    const parked = labels.find((l) => PARK_LABELS.has(l.name.trim().toLowerCase()));
    if (parked) flags.push(`parked:${parked.name}`);
  }
  return flags;
}

function itemComparator(bucket: ActionableBucket): (a: ActionableItem, b: ActionableItem) => number {
  if (bucket === "ready-to-pick-up") {
    return (a, b) => {
      if (a.demand !== b.demand) return b.demand - a.demand;
      const createdA = a.created_at ? Date.parse(a.created_at) : Number.POSITIVE_INFINITY;
      const createdB = b.created_at ? Date.parse(b.created_at) : Number.POSITIVE_INFINITY;
      if (createdA !== createdB) return createdA - createdB;
      return (a.iid ?? 0) - (b.iid ?? 0);
    };
  }
  return (a, b) => {
    const updatedA = a.updated_at ? Date.parse(a.updated_at) : 0;
    const updatedB = b.updated_at ? Date.parse(b.updated_at) : 0;
    if (updatedA !== updatedB) return updatedA - updatedB;
    return (a.iid ?? 0) - (b.iid ?? 0);
  };
}

export function buildActionableProjection(input: BuildActionableProjectionInput): ActionableProjection {
  const nowMs = input.nowMs ?? Date.now();
  const staleDays = input.staleDays ?? DEFAULT_STALE_DAYS;
  const includeUnconfigured = input.includeUnconfigured ?? false;
  const configured = input.configuredRepos ? new Set(input.configuredRepos.map((r) => repoKey(r.source_id, r.project_path))) : null;
  const labelsByItem = byItemId(input.labels);
  const sourceKinds = new Map(input.sources.map((s) => [s.source_id, s.kind]));
  const candidates: ActionableItem[] = [];

  for (const row of input.items) {
    if (row.state !== "open") continue;
    if (input.repo && row.project_path !== input.repo) continue;
    if (input.source && row.source_id !== input.source) continue;
    const isConfigured = !configured || configured.has(repoKey(row.source_id, row.project_path));
    if (!includeUnconfigured && !isConfigured) continue;

    const labels = labelsByItem.get(row.item_id) ?? [];
    const bucket = bucketFor(row, labels, input.edges ?? []);
    candidates.push({
      source_id: row.source_id,
      source_kind: sourceKinds.get(row.source_id) ?? null,
      repo: row.project_path,
      iid: row.iid,
      kind: row.kind,
      title: row.title,
      url: row.url,
      created_at: row.created_at,
      updated_at: row.updated_at,
      labels,
      demand: row.demand ?? 0,
      comments: row.comment_total,
      is_draft: row.is_draft,
      review_state: row.review_state,
      ci_state: row.ci_state,
      merge_state: row.merge_state,
      review_threads:
        row.open_review_threads == null && row.total_review_threads == null
          ? null
          : { open: row.open_review_threads ?? 0, total: row.total_review_threads ?? 0 },
      bucket,
      flags: flagsFor(row, labels, bucket, isConfigured, nowMs, staleDays),
    });
  }

  const buckets = ACTIONABLE_BUCKET_ORDER.map((bucket) => {
    const items = candidates.filter((item) => item.bucket === bucket).sort(itemComparator(bucket));
    const shownItems = input.limit == null ? items : items.slice(0, input.limit);
    return {
      bucket,
      total: items.length,
      shown: shownItems.length,
      more: items.length - shownItems.length,
      items: shownItems,
    };
  });

  return {
    generated_at: new Date(nowMs).toISOString(),
    total: candidates.length,
    stale_days: staleDays,
    include_unconfigured: includeUnconfigured,
    bucket_order: ACTIONABLE_BUCKET_ORDER,
    buckets,
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body) + "\n");
}

export async function actionableProjection(cfg: AppConfig, options: ActionableOptions): Promise<ActionableProjection> {
  const store = await openConfiguredStoreReadOnly(cfg);
  try {
    return buildActionableProjection({
      sources: await store.listSources(),
      items: await store.listLiveItems(),
      labels: await store.listLabels(),
      edges: await store.listLiveEdges(),
      configuredRepos: configuredRepoRefs(cfg),
      ...options,
    });
  } finally {
    await store.close();
  }
}

export async function handleActionableRequest(cfg: AppConfig, url: URL, res: ServerResponse): Promise<void> {
  let options: ActionableOptions;
  try {
    options = parseActionableOptions(url);
  } catch (error) {
    json(res, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
    return;
  }

  try {
    json(res, 200, await actionableProjection(cfg, options));
  } catch (error) {
    json(res, 500, { error: "internal_error", message: error instanceof Error ? error.message : String(error) });
  }
}
