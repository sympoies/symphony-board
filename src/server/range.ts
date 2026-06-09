// Read-only range-query handling shared by the Docker `api` sidecar
// (src/cli/range-api.ts) and the standalone app server (src/cli/app-server.ts).
// Every call opens the SQLite store read-only and closes it before returning,
// so the hosting process — even the writer-owned standalone server — never
// holds a second writable handle.

import type { ServerResponse } from "node:http";
import type { RepoDTO, TimeRangeDTO, ContractEnvelope } from "@symphony-board/contract";
import type { AppConfig } from "../config.ts";
import { openDbReadOnly } from "../db/open.ts";
import { listSources, listLiveItems, listLabels, listLiveEdges, listActivities } from "../db/repo.ts";
import { buildRangeContract } from "../contract/build.ts";
import { zonedDayStartIso, zonedDayEndIso } from "../lib/tz.ts";

export interface ConfigColors {
  sourceColors: Record<string, string>;
  repoColors: RepoDTO[];
}

// Display-only highlight colors declared in config, threaded onto the envelope.
export function configColors(cfg: AppConfig): ConfigColors {
  const sourceColors: Record<string, string> = {};
  const repoColors: RepoDTO[] = [];
  for (const source of cfg.sources) {
    if (source.color) sourceColors[source.source_id] = source.color;
    for (const project of source.projects) {
      if (typeof project !== "string" && project.color) {
        repoColors.push({ source_id: source.source_id, project_path: project.path, color: project.color });
      }
    }
  }
  return { sourceColors, repoColors };
}

function parseDateParam(value: string | null, field: "from" | "to", tz: string): string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${field} must be YYYY-MM-DD`);
  }
  // Expand the calendar date at the configured zone's day boundary, so the
  // window matches the zoned preset the UI computed (defaults to UTC).
  const iso = field === "from" ? zonedDayStartIso(value, tz) : zonedDayEndIso(value, tz);
  if (Number.isNaN(Date.parse(iso))) throw new Error(`${field} is not a valid date`);
  return iso;
}

export function parseRange(url: URL, tz: string): TimeRangeDTO {
  const from = parseDateParam(url.searchParams.get("from"), "from", tz);
  const to = parseDateParam(url.searchParams.get("to"), "to", tz);
  if (from > to) throw new Error("from must be on or before to");
  return { from, to };
}

// Build the range-scoped contract envelope for one GET /api/range request.
export function rangeEnvelope(cfg: AppConfig, url: URL): ContractEnvelope {
  const range = parseRange(url, cfg.timezone ?? "UTC");
  const { sourceColors, repoColors } = configColors(cfg);
  const db = openDbReadOnly(cfg.db_path);
  try {
    return buildRangeContract({
      sources: listSources(db),
      items: listLiveItems(db),
      labels: listLabels(db),
      edges: listLiveEdges(db),
      activities: listActivities(db),
      generatedAt: new Date().toISOString(),
      sourceColors,
      repoColors,
      identities: cfg.identities,
      excludeActors: cfg.exclude_actors,
      timezone: cfg.timezone,
      range,
    });
  } finally {
    db.close();
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body) + "\n");
}

// Serve one GET /api/range request, mapping validation failures to 400 and
// everything else to 500 — the same surface the Docker api sidecar exposes.
export function handleRangeRequest(cfg: AppConfig, url: URL, res: ServerResponse): void {
  try {
    json(res, 200, rangeEnvelope(cfg, url));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("must be") || message.includes("valid date") ? 400 : 500;
    json(res, status, { error: status === 400 ? "bad_request" : "internal_error", message });
  }
}
