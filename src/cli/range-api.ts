#!/usr/bin/env node
// Read-only range query API. This process never syncs, migrates, emits, or
// writes the SQLite store; Docker runs it beside the `board` sole-writer daemon.

import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { RepoDTO, TimeRangeDTO } from "@symphony-board/contract";
import { loadConfig } from "../config.ts";
import { openDbReadOnly } from "../db/open.ts";
import { listSources, listLiveItems, listLabels, listLiveEdges, listActivities } from "../db/repo.ts";
import { buildRangeContract } from "../contract/build.ts";
import { zonedDayStartIso, zonedDayEndIso } from "../lib/tz.ts";

interface Args {
  config: string | null;
  host: string;
  port: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    config: null,
    host: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.PORT ?? "8081"),
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--config") args.config = argv[++i] ?? null;
    else if (x === "--host") args.host = argv[++i] ?? args.host;
    else if (x === "--port") args.port = Number(argv[++i] ?? args.port);
    else throw new Error(`unknown argument: ${x}`);
  }
  if (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65535) {
    throw new Error(`invalid --port: ${args.port}`);
  }
  return args;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body) + "\n");
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

function parseRange(url: URL, tz: string): TimeRangeDTO {
  const from = parseDateParam(url.searchParams.get("from"), "from", tz);
  const to = parseDateParam(url.searchParams.get("to"), "to", tz);
  if (from > to) throw new Error("from must be on or before to");
  return { from, to };
}

const args = parseArgs(process.argv.slice(2));
const { cfg, path: configPath } = loadConfig(args.config);

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

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/healthz") {
      json(res, 200, { ok: true });
      return;
    }
    if (req.method !== "GET" || url.pathname !== "/api/range") {
      json(res, 404, { error: "not_found" });
      return;
    }

    const range = parseRange(url, cfg.timezone ?? "UTC");
    const db = openDbReadOnly(cfg.db_path);
    try {
      const envelope = buildRangeContract({
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
      json(res, 200, envelope);
    } finally {
      db.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("must be") || message.includes("valid date") ? 400 : 500;
    json(res, status, { error: status === 400 ? "bad_request" : "internal_error", message });
  }
});

server.listen(args.port, args.host, () => {
  process.stderr.write(`range api listening on ${args.host}:${args.port}, config ${configPath}\n`);
});
