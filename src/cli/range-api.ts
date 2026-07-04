#!/usr/bin/env node
// Read-only range query API. This process never syncs, migrates, emits, or
// writes the configured store; Docker runs it beside the `board` sole-writer daemon.
// The request handling lives in src/server/range.ts, shared with the standalone
// app server (src/cli/app-server.ts).

import { createServer, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import type { AppConfig } from "../config.ts";
import { loadConfig, resolveConfigPath } from "../config.ts";
import { handleRangeRequest } from "../server/range.ts";
import { handleReviewCandidatesRequest } from "../server/review-candidates.ts";
import { handleStatsRequest } from "../server/stats.ts";
import { handleActivityDailyRequest } from "../server/activity-daily.ts";
import { handleActionableRequest } from "../server/actionable.ts";
import { capabilitiesOptionsFromEnv, handleCapabilitiesRequest, type CapabilitiesOptions } from "../server/capabilities.ts";

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

export interface RangeApiOptions {
  // Path to config/sources.json (null resolves the default search path).
  configPath: string | null;
  // The daemon-emitted contract file, mounted read-only into this sidecar (the
  // same data dir the writer emits to). Source for the full-history
  // /api/activity-daily aggregate; matches the CONTRACT_OUT the board daemon
  // writes.
  contractOut: string;
  // Optional test/deployment override for GET /api/capabilities. Runtime defaults
  // come from safe, non-secret environment metadata.
  capabilities?: Partial<CapabilitiesOptions>;
}

// Build the read-only range-query server (not yet listening). Exported so tests
// can drive it on an ephemeral port.
export function createRangeApiServer(opts: RangeApiOptions): Server {
  // Fresh config per request, so config-only edits (identities, exclude_actors,
  // highlight colors, configured repo set, timezone) apply without restarting
  // this sidecar — matching app-server.ts and the board daemon, which the static
  // contract already reflects within one sync. A load error maps to a per-request
  // 500 instead of crashing the listener.
  const freshConfig = (): AppConfig => loadConfig(opts.configPath).cfg;

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/healthz") {
      json(res, 200, { ok: true });
      return;
    }
    // Reads the emitted contract file directly (no config, no store access).
    if (req.method === "GET" && url.pathname === "/api/activity-daily") {
      handleActivityDailyRequest(opts.contractOut, res, req.headers["accept-encoding"]);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/capabilities") {
      void handleCapabilitiesRequest(
        {
          ...capabilitiesOptionsFromEnv(process.env, { serverMode: "api" }),
          ...opts.capabilities,
        },
        res,
      );
      return;
    }
    if (
      req.method === "GET" &&
      (url.pathname === "/api/range" ||
        url.pathname === "/api/stats" ||
        url.pathname === "/api/review-candidates" ||
        url.pathname === "/api/actionable")
    ) {
      let cfg: AppConfig;
      try {
        cfg = freshConfig();
      } catch (err) {
        json(res, 500, { error: "config_error", message: (err as Error).message });
        return;
      }
      // The handlers respond on every path (success and failure), so the returned
      // promise never rejects and is safe to detach.
      if (url.pathname === "/api/stats") void handleStatsRequest(cfg, url, res);
      else if (url.pathname === "/api/review-candidates") void handleReviewCandidatesRequest(cfg, url, res);
      else if (url.pathname === "/api/actionable") void handleActionableRequest(cfg, url, res);
      else void handleRangeRequest(cfg, url, res, req.headers["accept-encoding"]);
      return;
    }
    json(res, 404, { error: "not_found" });
  });
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const contractOut = process.env.CONTRACT_OUT ?? "data/contract.json";
  const configPath = resolveConfigPath(args.config);
  const server = createRangeApiServer({ configPath: args.config, contractOut });
  server.listen(args.port, args.host, () => {
    // Probe config once at boot for diagnostics ONLY. Config is read fresh per
    // request, so a failure here must NOT exit — the listener stays up and
    // degrades to a per-request config_error. But the /healthz probe needs no
    // config, so a fatally broken config would otherwise report healthy; log it
    // loudly here so a broken sources.json is visible in container logs at boot.
    try {
      loadConfig(args.config);
      process.stderr.write(`range api listening on ${args.host}:${args.port}, config ${configPath}\n`);
    } catch (err) {
      process.stderr.write(
        `range api listening on ${args.host}:${args.port}, but config ${configPath} FAILED to load: ${(err as Error).message}; serving per-request config_error until fixed\n`,
      );
    }
  });
}

// Only run when invoked directly (node src/cli/range-api.ts), so tests can
// import createRangeApiServer without side effects.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
