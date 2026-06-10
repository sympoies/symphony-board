// Shared contract emit: build the versioned envelope (LAYER 3) from the current
// store state and, optionally, write it to a file. Both the emit-contract CLI and
// the sync runner go through here, so "emit the contract" has exactly one
// definition (and the producer validation guard is never skipped by accident).
//
// buildContract stays a pure mapping (see docs/DESIGN.md); the display colors are
// the only emit-time, config-derived metadata, so they are resolved here and
// never stored in the DB.

import { writeFileSync } from "node:fs";
import type { ContractEnvelope, RepoDTO } from "@symphony-board/contract";
import type { AppConfig } from "../config.ts";
import type { Store } from "../db/store.ts";
import { buildContract } from "./build.ts";
import { validateContract, type ValidationError } from "./validate.ts";

// Config-derived display colors: source-level on each source, repo-level on the
// few project entries that carry one. Display metadata only — read at emit time,
// never stored in the DB, so buildContract stays a pure mapping.
export function displayColors(cfg: AppConfig): { sourceColors: Record<string, string>; repoColors: RepoDTO[] } {
  const sourceColors: Record<string, string> = {};
  const repoColors: RepoDTO[] = [];
  for (const s of cfg.sources) {
    if (s.color) sourceColors[s.source_id] = s.color;
    for (const p of s.projects) {
      if (typeof p !== "string" && p.color) {
        repoColors.push({ source_id: s.source_id, project_path: p.path, color: p.color });
      }
    }
  }
  return { sourceColors, repoColors };
}

// Build the contract envelope from the current store state: a pure mapping over
// the canonical rows plus the config-derived display colors / identities.
export async function buildContractEnvelope(store: Store, cfg: AppConfig, generatedAt: string): Promise<ContractEnvelope> {
  const { sourceColors, repoColors } = displayColors(cfg);
  return buildContract({
    sources: await store.listSources(),
    items: await store.listLiveItems(),
    labels: await store.listLabels(),
    edges: await store.listLiveEdges(),
    activities: await store.listActivities(),
    generatedAt,
    sourceColors,
    repoColors,
    identities: cfg.identities,
    excludeActors: cfg.exclude_actors,
    timezone: cfg.timezone,
  });
}

// A contract that failed producer validation must never ship (the producer
// guard). This carries the violations so callers can report them.
export class ContractValidationError extends Error {
  readonly errors: ValidationError[];
  constructor(errors: ValidationError[]) {
    super(`contract failed schema validation (${errors.length} violation(s))`);
    this.name = "ContractValidationError";
    this.errors = errors;
  }
}

export interface EmitCounts {
  items: number;
  totalItems: number;
  edges: number;
  activities: number;
}

// Build, validate (unless explicitly disabled), and write the contract to a file.
// Throws ContractValidationError when validation fails, so a malformed contract
// never lands on disk. Returns the counts useful for an operator log line.
export async function emitContractToFile(
  store: Store,
  cfg: AppConfig,
  outPath: string,
  generatedAt: string,
  validate = true,
): Promise<EmitCounts> {
  const envelope = await buildContractEnvelope(store, cfg, generatedAt);
  if (validate) {
    const errors = validateContract(envelope);
    if (errors.length > 0) throw new ContractValidationError(errors);
  }
  writeFileSync(outPath, JSON.stringify(envelope, null, 2) + "\n");
  return {
    items: envelope.items.length,
    totalItems: envelope.item_window?.total_items ?? envelope.items.length,
    edges: envelope.edges.length,
    activities: envelope.activities?.length ?? 0,
  };
}
