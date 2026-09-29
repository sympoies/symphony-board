#!/usr/bin/env node
// Read-only range query API. This process never syncs, migrates, emits, or
// writes the configured store; Docker runs it beside the `board` sole-writer daemon.
// The request handling lives in src/server/range.ts, shared with the standalone
// app server (src/cli/app-server.ts).

import { sendJson as json } from "../server/http.ts";
import { handleReadApiRequest } from "../server/read-api.ts";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import type { AppConfig } from "../config.ts";
import { loadConfig, resolveConfigPath } from "../config.ts";
import { capabilitiesOptionsFromEnv, type CapabilitiesOptions } from "../server/capabilities.ts";

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

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/healthz") {
      json(res, 200, { ok: true });
      return;
    }
    if (await handleReadApiRequest({
      freshConfig,
      contractOut: opts.contractOut,
      capabilities: () => ({
        ...capabilitiesOptionsFromEnv(process.env, { serverMode: "api" }),
        ...opts.capabilities,
      }),
    }, req, res, url)) return;

    json(res, 404, { error: "not_found" });
  };
  return createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (res.headersSent) { res.destroy(); return; }
      json(res, 500, { error: "internal_error", message: err instanceof Error ? err.message : String(err) });
    });
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
