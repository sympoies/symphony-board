// Read-only review-cleanup candidate discovery for the board's operational API.
// This is the HTTP counterpart to `pnpm review-candidates`: it builds the same
// full, unwindowed contract projection from the configured canonical store, then
// runs the pure candidate selector. It never mutates the store or providers.

import type { ServerResponse } from "node:http";
import type { AppConfig } from "../config.ts";
import { buildContractEnvelope } from "../contract/emit.ts";
import { openConfiguredStoreReadOnly } from "../db/factory.ts";
import {
  buildReviewCandidates,
  defaultOptions,
  type ReviewCandidate,
  type ReviewCandidateOptions,
} from "../cli/review-candidates.ts";

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

export function reviewCandidateOptionsFromUrl(url: URL, now = Date.now()): ReviewCandidateOptions {
  const options = { ...defaultOptions(), now };
  const days = parseNonNegativeNumber(url.searchParams.get("days"), "days");
  if (days != null) options.days = days;
  const limit = parsePositiveInt(url.searchParams.get("limit"), "limit");
  if (limit != null) options.limit = limit;
  const pr = parsePositiveInt(url.searchParams.get("pr"), "pr");
  if (pr != null) options.pr = pr;
  options.repo = url.searchParams.get("repo") || null;
  options.actors = url.searchParams.getAll("actor").filter(Boolean);
  options.allActors =
    parseBoolean(url.searchParams.get("all_actors")) ||
    parseBoolean(url.searchParams.get("all-actors")) ||
    parseBoolean(url.searchParams.get("allActors"));
  return options;
}

export async function reviewCandidates(cfg: AppConfig, options: ReviewCandidateOptions): Promise<ReviewCandidate[]> {
  const store = await openConfiguredStoreReadOnly(cfg);
  try {
    const envelope = await buildContractEnvelope(store, cfg, new Date().toISOString(), { itemWindow: "full" });
    return buildReviewCandidates(envelope, options);
  } finally {
    await store.close();
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body) + "\n");
}

export async function handleReviewCandidatesRequest(cfg: AppConfig, url: URL, res: ServerResponse): Promise<void> {
  let options: ReviewCandidateOptions;
  try {
    options = reviewCandidateOptionsFromUrl(url);
  } catch (error) {
    json(res, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
    return;
  }

  try {
    json(res, 200, await reviewCandidates(cfg, options));
  } catch (error) {
    json(res, 500, { error: "internal_error", message: error instanceof Error ? error.message : String(error) });
  }
}
