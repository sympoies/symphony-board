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
//                                     [--endpoint <url>] [--json]
//
// Discovery is endpoint-first on purpose: this repo's active board runs on a
// dedicated host, so local-store fallback is more dangerous than useful. The
// endpoint can be overridden with --endpoint, SYMPHONY_BOARD_REVIEW_CANDIDATES_URL,
// or SYMPHONY_BOARD_BASE_URL. The default is a loopback board endpoint; point it
// at the real board with one of those vars.
//
// Discovery has two passes, mirroring project-review-cleanup buildCandidates:
//   Pass 1 (item-centric, actor-agnostic, the primary signal): every GitHub
//     change_request the contract reports with review_threads.open > 0 ->
//     reason `open_review_threads`. NOT windowed.
//   Pass 2 (activity-centric heuristic, allowlist-gated + --days windowed): an
//     allowlisted bot review that landed late (occurred_at > merged_at/closed_at)
//     -> `late_review`, or on an already-closed item -> `review_on_closed_pr`.

import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

import { buildReviewCandidates, defaultOptions, type ReviewCandidate, type ReviewCandidateOptions } from "../model/review-candidates.ts";
// Preserve the existing import surface for local consumers and tests.
export { buildReviewCandidates, defaultOptions, DEFAULT_ACTORS } from "../model/review-candidates.ts";
export type { ReviewCandidate, ReviewCandidateOptions, ReviewCandidateReason } from "../model/review-candidates.ts";

interface CliArgs extends ReviewCandidateOptions {
  endpoint: string | null;
  json: boolean;
}

const DEFAULT_REVIEW_CANDIDATES_ENDPOINT =
  "http://127.0.0.1:18080/api/review-candidates";

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
  const a: CliArgs = { ...defaultOptions(), endpoint: null, json: false };
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
    else if (x === "--endpoint") a.endpoint = argv[++i] ?? null;
    else if (x === "--json") a.json = true;
    else throw new Error(`unknown argument: ${x}`);
  }
  return a;
}

function stripEnvQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function loadRepoEnv(): Record<string, string> {
  try {
    const env: Record<string, string> = {};
    for (const rawLine of readFileSync(".env", "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
      const equals = normalized.indexOf("=");
      if (equals <= 0) continue;
      const key = normalized.slice(0, equals).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      env[key] = stripEnvQuotes(normalized.slice(equals + 1).trim());
    }
    return env;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function envValue(repoEnv: Record<string, string>, name: string): string | null {
  const raw = process.env[name] ?? repoEnv[name] ?? "";
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function defaultEndpoint(repoEnv: Record<string, string>): string {
  const explicit = envValue(repoEnv, "SYMPHONY_BOARD_REVIEW_CANDIDATES_URL");
  if (explicit) return explicit;
  const base = envValue(repoEnv, "SYMPHONY_BOARD_BASE_URL");
  if (base) return `${base.replace(/\/+$/, "")}/api/review-candidates`;
  return DEFAULT_REVIEW_CANDIDATES_ENDPOINT;
}

function endpointWithOptions(endpoint: string, args: CliArgs): string {
  const url = new URL(endpoint);
  url.searchParams.set("days", String(args.days));
  url.searchParams.set("limit", String(args.limit));
  if (args.repo) url.searchParams.set("repo", args.repo);
  if (args.pr) url.searchParams.set("pr", String(args.pr));
  for (const actor of args.actors) url.searchParams.append("actor", actor);
  if (args.allActors) url.searchParams.set("all_actors", "1");
  return url.toString();
}

function isCandidateArray(value: unknown): value is ReviewCandidate[] {
  return Array.isArray(value);
}

async function fetchRemoteCandidates(endpoint: string, args: CliArgs): Promise<ReviewCandidate[]> {
  const url = endpointWithOptions(endpoint, args);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`candidate endpoint ${url} returned HTTP ${response.status}`);
  }
  const payload = (await response.json()) as unknown;
  if (isCandidateArray(payload)) return payload;
  throw new Error(`candidate endpoint ${url} returned unsupported JSON shape; expected candidate array`);
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
  const endpoint = args.endpoint ?? defaultEndpoint(loadRepoEnv());
  const candidates = await fetchRemoteCandidates(endpoint, args);
  process.stdout.write(args.json ? JSON.stringify(candidates, null, 2) + "\n" : renderText(candidates) + "\n");
}

// Only run when invoked directly (node src/cli/review-candidates.ts), so tests
// can import buildReviewCandidates without the store side effects firing.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
