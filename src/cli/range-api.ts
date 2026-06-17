#!/usr/bin/env node
// Read-only range query API. This process never syncs, migrates, emits, or
// writes the configured store; Docker runs it beside the `board` sole-writer daemon.
// The request handling lives in src/server/range.ts, shared with the standalone
// app server (src/cli/app-server.ts).

import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { loadConfig } from "../config.ts";
import { handleRangeRequest } from "../server/range.ts";
import { handleReviewCandidatesRequest } from "../server/review-candidates.ts";
import { handleStatsRequest } from "../server/stats.ts";

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

const args = parseArgs(process.argv.slice(2));
const { cfg, path: configPath } = loadConfig(args.config);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (req.method === "GET" && url.pathname === "/healthz") {
    json(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/stats") {
    // The handlers respond on every path (success and failure), so the returned
    // promise never rejects and is safe to detach.
    void handleStatsRequest(cfg, url, res);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/review-candidates") {
    void handleReviewCandidatesRequest(cfg, url, res);
    return;
  }
  if (req.method !== "GET" || url.pathname !== "/api/range") {
    json(res, 404, { error: "not_found" });
    return;
  }
  void handleRangeRequest(cfg, url, res);
});

server.listen(args.port, args.host, () => {
  process.stderr.write(`range api listening on ${args.host}:${args.port}, config ${configPath}\n`);
});
