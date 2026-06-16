#!/usr/bin/env node
// Compute review-cleanup candidates from the board's OWN canonical store /
// contract projection (LAYER 3). This is the board's first-class promotion of
// the bespoke project-review-cleanup discovery logic: the board owns "which
// change requests still need review attention", computed from the same contract
// the UI and external consumers read.
//
// READ-ONLY. This command never mutates the store, the contract, or any
// provider — it builds the contract envelope in memory (the same way
// emit-contract does, but the store is opened read-only) and prints the
// candidate set. The provider-side resolution (--apply) stays in the skill.
//
//   node src/cli/review-candidates.ts [--days <n>] [--actor <login>]...
//                                     [--all-actors] [--limit <n>]
//                                     [--repo <owner/name>] [--pr <iid>]
//                                     [--config <path>] [--json]
//
// Discovery has two passes, mirroring project-review-cleanup buildCandidates:
//   Pass 1 (item-centric, actor-agnostic, the primary signal): every GitHub
//     change_request the contract reports with review_threads.open > 0 ->
//     reason `open_review_threads`. NOT windowed.
//   Pass 2 (activity-centric heuristic, allowlist-gated + --days windowed): an
//     allowlisted bot review that landed late (occurred_at > merged_at/closed_at)
//     -> `late_review`, or on an already-closed item -> `review_on_closed_pr`.

import { pathToFileURL } from "node:url";
import type {
  ActivityDTO,
  ContractEnvelope,
  ItemDTO,
  SourceDTO,
} from "@symphony-board/contract";
import { loadConfig } from "../config.ts";
import { openConfiguredStoreReadOnly } from "../db/factory.ts";
import { buildContractEnvelope } from "../contract/emit.ts";

// The same default allowlist the project-review-cleanup skill uses. The actor
// allowlist governs only Pass 2 discovery (and what --apply may auto-resolve in
// the skill); Pass 1 open-thread discovery is actor-agnostic.
export const DEFAULT_ACTORS = ["chatgpt-codex-connector"];

export type ReviewCandidateReason =
  | "open_review_threads"
  | "late_review"
  | "review_on_closed_pr";

// The candidate record. Field names mirror the project-review-cleanup contract
// candidate shape so the skill (and any --json consumer) reads the same keys.
export interface ReviewCandidate {
  source_id: string | null;
  repo: string | null; // project_path
  pr: number; // iid
  reasons: ReviewCandidateReason[];
  reason: ReviewCandidateReason | null; // the lead reason
  openThreads: number | null;
  totalThreads: number | null;
  title: string | null;
  itemState: string | null;
  itemUrl: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  // Enrichment from the latest review activity on the item (display only).
  actor: string | null;
  action: string | null;
  state: string | null; // review submission state (details.state)
  reviewUrl: string | null;
  reviewOccurredAt: string | null;
}

export interface ReviewCandidateOptions {
  days: number; // late_review window (Pass 2); default 7. NOT applied to Pass 1.
  actors: string[]; // additional allowlisted actors (merged with DEFAULT_ACTORS)
  allActors: boolean; // widen Pass 2 to every actor
  limit: number; // max candidates after sorting; default 20
  repo: string | null; // restrict to one project_path
  pr: number | null; // focus a single iid (relaxes the late/closed gate)
  // Injectable clock so tests can pin the --days window. Defaults to now.
  now: number;
}

export function defaultOptions(): ReviewCandidateOptions {
  return {
    days: 7,
    actors: [],
    allActors: false,
    limit: 20,
    repo: null,
    pr: null,
    now: Date.now(),
  };
}

function itemKey(sourceId: string | null, projectPath: string | null, iid: number | null): string {
  return `${sourceId ?? ""}|${projectPath ?? ""}|${iid ?? ""}`;
}

function toMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// Pure candidate computation over a contract envelope. No store, no provider,
// no clock except the injectable options.now — so it is fully testable from an
// in-memory contract. This is the board-owned reproduction of the skill's
// buildCandidates(contract, options, repo).
export function buildReviewCandidates(
  contract: ContractEnvelope | null,
  options: ReviewCandidateOptions,
): ReviewCandidate[] {
  if (!contract) return [];
  const cutoffMs = options.now - options.days * 24 * 60 * 60 * 1000;

  const sources = new Map<string, SourceDTO>();
  for (const source of contract.sources ?? []) {
    if (source.source_id) sources.set(source.source_id, source);
  }
  const isGithub = (sourceId: string | null): boolean =>
    sourceId != null && sources.get(sourceId)?.kind === "github";

  const items = new Map<string, ItemDTO>();
  const itemsByRef = new Map<string, ItemDTO>();
  for (const item of contract.items ?? []) {
    if (item.kind !== "change_request") continue;
    items.set(itemKey(item.source_id, item.project_path, item.iid), item);
    if (item.id) itemsByRef.set(item.id, item);
  }

  // Resolve the change_request an activity targets. Prefer the immutable
  // target_ref (= item.id, "<source_id>|<external_id>"): a repo rename changes
  // project_path on items and activities independently (they sync at different
  // times), so the mutable (source_id, project_path, iid) tuple can miss an item
  // that is actually present. Fall back to the tuple only when target_ref is
  // absent.
  const resolveItem = (activity: ActivityDTO): ItemDTO | undefined =>
    (activity.target_ref ? itemsByRef.get(activity.target_ref) : undefined) ??
    items.get(itemKey(activity.source_id, activity.project_path, activity.target_iid));

  // The key under which a review's enrichment is filed and looked up: the
  // immutable target_ref / item id when known, else the mutable tuple.
  const reviewKey = (
    sourceId: string | null,
    projectPath: string | null,
    iid: number | null,
    ref: string | null,
  ): string => ref ?? itemKey(sourceId, projectPath, iid);

  // Most recent GitHub review activity per change_request. Used only to enrich
  // candidate display (who reviewed last, when) — never to gate Pass 1, so an
  // open thread from a non-allowlisted actor still surfaces.
  const latestReview = new Map<string, ActivityDTO>();
  for (const activity of contract.activities ?? []) {
    if (activity.kind !== "review" || activity.target_kind !== "change_request") continue;
    if (!isGithub(activity.source_id)) continue;
    const key = reviewKey(activity.source_id, activity.project_path, activity.target_iid, activity.target_ref);
    const prev = latestReview.get(key);
    if (!prev || (toMs(activity.occurred_at) ?? 0) > (toMs(prev.occurred_at) ?? 0)) {
      latestReview.set(key, activity);
    }
  }

  const allowSet = new Set([...DEFAULT_ACTORS, ...options.actors].filter(Boolean));
  const candidates = new Map<string, ReviewCandidate>();
  // candidateKey -> the candidate's item ref, so enrichment can join reviews by
  // the immutable ref (set the first time a ref is known for the candidate).
  const refOfCandidate = new Map<string, string | null>();
  const candidateKey = (sourceId: string | null, projectPath: string | null, iid: number | null): string =>
    `${sourceId ?? ""}|${projectPath ?? ""}#${Number(iid)}`;
  const ensure = (
    sourceId: string | null,
    projectPath: string | null,
    iid: number | null,
    item: ItemDTO | undefined,
    ref: string | null = null,
  ): ReviewCandidate => {
    const sid = sourceId ?? item?.source_id ?? null;
    const key = candidateKey(sid, projectPath, iid);
    const itemRef = ref ?? item?.id ?? null;
    if (itemRef && !refOfCandidate.get(key)) refOfCandidate.set(key, itemRef);
    let candidate = candidates.get(key);
    if (!candidate) {
      candidate = {
        source_id: sid,
        pr: Number(iid),
        repo: projectPath,
        title: item?.title ?? null,
        actor: null,
        action: null,
        state: null,
        reviewUrl: null,
        reviewOccurredAt: null,
        itemState: item?.state ?? null,
        itemUrl: item?.url ?? null,
        mergedAt: item?.merged_at ?? null,
        closedAt: item?.closed_at ?? null,
        openThreads: item?.review_threads?.open ?? null,
        totalThreads: item?.review_threads?.total ?? null,
        reasons: [],
        reason: null,
      };
      candidates.set(key, candidate);
    } else if (!candidate.source_id && sourceId) {
      candidate.source_id = sourceId;
    }
    return candidate;
  };
  const addReason = (candidate: ReviewCandidate, reason: ReviewCandidateReason): void => {
    if (!candidate.reasons.includes(reason)) candidate.reasons.push(reason);
  };

  // Pass 1 — item-centric, actor-agnostic. Any GitHub change_request the
  // contract reports with open review threads. The primary, complete discovery
  // source: it does not depend on a review activity existing in the window, on
  // when the review landed, or on who authored it. NOT windowed.
  for (const item of items.values()) {
    if (!(item.review_threads && item.review_threads.open > 0)) continue;
    if (!isGithub(item.source_id)) continue;
    if (options.repo && item.project_path !== options.repo) continue;
    if (options.pr && Number(item.iid) !== options.pr) continue;
    addReason(ensure(item.source_id, item.project_path, item.iid, item), "open_review_threads");
  }

  // Pass 2 — activity-centric heuristic. An allowlisted bot review that landed
  // after merge/close (late) or on an already-closed PR, even if its threads
  // are now resolved. Gated by the actor allowlist (widen with --all-actors)
  // and the --days window; this flags review timing the point-in-time
  // open-thread count cannot.
  for (const activity of contract.activities ?? []) {
    if (activity.kind !== "review" || activity.target_kind !== "change_request") continue;
    if (!isGithub(activity.source_id)) continue;
    if (options.pr && Number(activity.target_iid) !== options.pr) continue;
    if (!options.allActors && !(activity.actor != null && allowSet.has(activity.actor))) continue;

    const occurredMs = toMs(activity.occurred_at);
    if (occurredMs != null && occurredMs < cutoffMs) continue;

    const item = resolveItem(activity);
    // Apply --repo against the resolved item's CURRENT project_path: a repo
    // rename leaves the activity row's project_path stale, so filtering on it
    // before resolution would skip a renamed PR under focused discovery. Fall
    // back to the activity path only when no item resolved.
    if (options.repo && (item?.project_path ?? activity.project_path) !== options.repo) continue;
    const resolvedAt = item?.merged_at ?? item?.closed_at ?? null;
    const resolvedMs = toMs(resolvedAt);
    const late = resolvedMs != null && occurredMs != null && occurredMs > resolvedMs;
    const closed = item?.state != null && item.state !== "open";
    if (!late && !closed && !options.pr) continue;

    // Key the candidate by the resolved item's own fields when available, so it
    // dedups with the Pass 1 candidate and reports the item's current
    // project_path rather than the (possibly stale) path on the activity row.
    addReason(
      ensure(
        item?.source_id ?? activity.source_id,
        item?.project_path ?? activity.project_path,
        item?.iid ?? activity.target_iid,
        item,
        item?.id ?? activity.target_ref ?? null,
      ),
      late ? "late_review" : "review_on_closed_pr",
    );
  }

  const list = [...candidates.values()];
  for (const candidate of list) {
    const ref = refOfCandidate.get(candidateKey(candidate.source_id, candidate.repo, candidate.pr)) ?? null;
    const review =
      (ref ? latestReview.get(ref) : undefined) ??
      latestReview.get(itemKey(candidate.source_id, candidate.repo, candidate.pr));
    if (review) {
      candidate.actor = review.actor ?? null;
      candidate.action = review.action ?? null;
      candidate.state =
        (review.details && typeof review.details["state"] === "string"
          ? (review.details["state"] as string)
          : null) ?? null;
      candidate.reviewUrl = review.url ?? null;
      candidate.reviewOccurredAt = review.occurred_at ?? null;
      if (!candidate.title) candidate.title = review.title ?? null;
    }
    // Lead with the actionable open-thread signal when present.
    candidate.reason = candidate.reasons.includes("open_review_threads")
      ? "open_review_threads"
      : candidate.reasons[0] ?? null;
  }

  // Open-thread candidates first (most open threads first), then by review
  // recency, so the actionable, complete signal leads the report.
  list.sort((a, b) => {
    const ao = a.openThreads ?? -1;
    const bo = b.openThreads ?? -1;
    if (ao !== bo) return bo - ao;
    return (toMs(b.reviewOccurredAt) ?? 0) - (toMs(a.reviewOccurredAt) ?? 0);
  });
  return list.slice(0, options.limit);
}

// ---- CLI driver (only runs when invoked directly) ---------------------------

interface CliArgs extends ReviewCandidateOptions {
  config: string | null;
  json: boolean;
}

function parsePositiveInt(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeNumber(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { ...defaultOptions(), config: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--days") a.days = parseNonNegativeNumber(argv[++i], "--days");
    else if (x === "--actor") {
      const v = argv[++i];
      if (v == null) throw new Error("--actor requires a value");
      a.actors.push(v);
    } else if (x === "--all-actors") a.allActors = true;
    else if (x === "--limit") a.limit = parsePositiveInt(argv[++i], "--limit");
    else if (x === "--repo") a.repo = argv[++i] ?? null;
    else if (x === "--pr") a.pr = parsePositiveInt(argv[++i], "--pr");
    else if (x === "--config") a.config = argv[++i] ?? null;
    else if (x === "--json") a.json = true;
    else throw new Error(`unknown argument: ${x}`);
  }
  return a;
}

function renderText(candidates: ReviewCandidate[]): string {
  if (candidates.length === 0) return "no review candidates";
  const lines: string[] = [`${candidates.length} review candidate(s):`];
  for (const c of candidates) {
    const ref = `${c.repo ?? "?"}#${c.pr}`;
    const threads =
      c.openThreads != null ? `${c.openThreads}/${c.totalThreads ?? "?"} open threads` : "no thread count";
    const reasons = c.reasons.join(", ");
    const who = c.actor ? ` last review by ${c.actor}` : "";
    lines.push(`  ${ref} [${c.itemState ?? "?"}] ${threads} — ${reasons}${who}`);
    if (c.itemUrl) lines.push(`    ${c.itemUrl}`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { cfg } = loadConfig(args.config);

  // Read-only: the candidate set is computed from the contract projection, and
  // this command must never mutate the canonical store.
  const store = await openConfiguredStoreReadOnly(cfg);
  let envelope: ContractEnvelope;
  try {
    // Discovery must see EVERY change_request with open threads, so build the
    // unwindowed projection: the default 90-day board window would drop an old
    // PR whose unresolved thread has aged out of it (Pass 1 is documented as the
    // complete, non-windowed signal).
    envelope = await buildContractEnvelope(store, cfg, new Date().toISOString(), { itemWindow: "full" });
  } finally {
    await store.close();
  }

  const candidates = buildReviewCandidates(envelope, args);

  if (args.json) {
    process.stdout.write(JSON.stringify(candidates, null, 2) + "\n");
  } else {
    process.stdout.write(renderText(candidates) + "\n");
  }
}

// Only run when invoked directly (node src/cli/review-candidates.ts), so tests
// can import buildReviewCandidates without the store side effects firing.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
