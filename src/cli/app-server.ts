#!/usr/bin/env node
// Standalone app server: everything the Docker stack runs, in ONE process. It is
// the writer-owned loop daemon (sync + emit cadence, manual-run control surface)
// AND the read-only HTTP surface the UI consumes (/contract.json + /api/range).
// The desktop-standalone app spawns this as its bundled sidecar; it also works
// for any single-process, no-Docker deployment.
//
// The sole-writer rule survives the merge: the SyncController still owns the
// single writer slot, and every /api/range request opens the configured store
// read-only and closes it before returning (src/server/range.ts). What nginx
// proxies apart in the Docker stack is here just routes on one server.
//
// The config is re-read on every scheduled run, manual run, and request, so the
// user can edit sources.json (or drop it in on first run) without restarting
// the app; a broken config fails that run/request with its message instead of
// crashing the daemon.
//
// Env: HOST (default 127.0.0.1 — loopback only; the desktop shell is the
// intended client), PORT (default 8787), INTERVAL (seconds, default 600),
// FULL_EVERY (full sweep every Nth iteration, default ~1 day), SYMPHONY_CONFIG
// (default config/sources.json, resolved from the working directory — the
// desktop app sets cwd to its data dir), CONTRACT_OUT (default
// data/contract.json), SYNC_CONTROL_ENABLED (default ON here, unlike the Docker
// daemon: the standalone app is a same-user local deployment; set 0 to disable),
// CONFIG_CONTROL_ENABLED (default ON here for the same reason — the Settings UI
// edits config/sources.json through the writer; set 0 to disable),
// LOG_CONTROL_ENABLED (default ON here — serve this process's recent-log tail
// on GET /api/logs for the UI Diagnostics page; set 0 to disable),
// SYMPHONY_SECRETS_FILE (the KEY=VALUE credential file the write-only secrets
// surface edits and token resolution reads fresh; the desktop shell points it
// at the data dir's secrets.env).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import type { AppConfig } from "../config.ts";
import { loadConfig, resolveConfigPath, resolveSecretsPath, syncScheduleFromConfig, type SyncSchedule } from "../config.ts";
import { openConfiguredStoreReadOnly } from "../db/factory.ts";
import { runConfiguredSync } from "../sync-runner.ts";
import {
  SyncController,
  handleControlRequest,
  runLoop,
  sourceOptions,
  type ControlContext,
} from "./sync-daemon.ts";
import { handleRangeRequest } from "../server/range.ts";
import { handleReviewCandidatesRequest } from "../server/review-candidates.ts";
import { handleStatsRequest } from "../server/stats.ts";
import { handleActivityDailyRequest } from "../server/activity-daily.ts";
import { capabilitiesOptionsFromEnv, handleCapabilitiesRequest } from "../server/capabilities.ts";
import { acceptsGzip } from "../server/http.ts";
import { log } from "../log.ts";

export const STANDALONE_DEFAULT_INTERVAL_SECONDS = 600;
export const STANDALONE_DEFAULT_FULL_INTERVAL_SECONDS = 86400;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body) + "\n");
}

// gzipped-contract cache keyed on (path, emitted-file mtime). The contract is
// the largest, hottest response (every UI load) and only changes when the
// writer emits a new one, so compress once per emit instead of once per request.
// Keyed by path too: tests (and any multi-store host) run several servers in one
// process. nginx already gzips this route in the Docker stack; this brings the
// standalone server — the only un-gzipped path — to parity.
const contractGzipCache = new Map<string, { mtimeMs: number; gz: Buffer }>();

function readEmittedContract(res: ServerResponse, contractPath: string): { body: Buffer; mtimeMs: number } | null {
  try {
    // stat before read so a concurrent emit can only ever leave the cache one
    // request stale: the next request sees the newer mtime and recompresses.
    const mtimeMs = statSync(contractPath).mtimeMs;
    const body = readFileSync(contractPath);
    return { body, mtimeMs };
  } catch {
    sendJson(res, 404, { error: "no_contract", message: "no contract emitted yet" });
  }
  return null;
}

function cachedGzipContract(contractPath: string, body: Buffer, mtimeMs: number): Buffer {
  let cached = contractGzipCache.get(contractPath);
  if (!cached || cached.mtimeMs !== mtimeMs) {
    cached = { mtimeMs, gz: gzipSync(body) };
    contractGzipCache.set(contractPath, cached);
  }
  return cached.gz;
}

// Serve the daemon-emitted contract file (the nginx `location = /contract.json`
// role). 404 until the first emit — the UI shows its load error and the user can
// trigger or await a sync. Compresses when the client accepts gzip, serving the
// mtime-cached buffer; plain clients still get the raw bytes.
function serveContract(res: ServerResponse, contractPath: string, acceptEncoding: string | string[] | undefined): void {
  const emitted = readEmittedContract(res, contractPath);
  if (!emitted) return;
  if (acceptsGzip(acceptEncoding)) {
    const gz = cachedGzipContract(contractPath, emitted.body, emitted.mtimeMs);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Content-Encoding": "gzip",
      "Content-Length": gz.length,
      Vary: "Accept-Encoding",
    });
    res.end(gz);
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Accept-Encoding" });
  res.end(emitted.body);
}

function servePrecompressedContract(res: ServerResponse, contractPath: string, method: string): void {
  const emitted = readEmittedContract(res, contractPath);
  if (!emitted) return;
  const gz = cachedGzipContract(contractPath, emitted.body, emitted.mtimeMs);
  res.writeHead(200, {
    "Content-Type": "application/gzip",
    "Cache-Control": "no-store",
    "Content-Length": gz.length,
  });
  res.end(method === "HEAD" ? undefined : gz);
}

export interface AppServerOptions {
  configPath: string | null;
  contractOut: string;
  controlEnabled: boolean;
  configControlEnabled: boolean;
  logsEnabled: boolean;
  secretsPath: string | null;
  intervalSeconds: number;
  fullEvery: number;
}

// Build the unified HTTP server (not yet listening). Exported so tests can
// drive it on an ephemeral port with an injected controller.
export function createAppServer(controller: SyncController, opts: AppServerOptions): Server {
  // Fresh config per use, so edits apply without a restart. Throws with the
  // config error; each route maps that to its own failure surface.
  const freshConfig = (): AppConfig => loadConfig(opts.configPath).cfg;

  const controlCtx = (): ControlContext => {
    let sources: ControlContext["sources"] = [];
    let cfg: AppConfig | null = null;
    try {
      cfg = freshConfig();
      sources = sourceOptions(cfg);
    } catch {
      // Missing/broken config: the control surface stays up with no source
      // scopes; runs started against it report the config error as their result.
    }
    const schedule = syncScheduleFromConfig(cfg, { intervalSeconds: opts.intervalSeconds, fullEvery: opts.fullEvery });
    return {
      controlEnabled: opts.controlEnabled,
      configControl: { enabled: opts.configControlEnabled, path: resolveConfigPath(opts.configPath), secretsPath: opts.secretsPath },
      logsEnabled: opts.logsEnabled,
      sources,
      intervalSeconds: schedule.intervalSeconds,
      fullEvery: schedule.fullEvery,
      fullIntervalSeconds: schedule.fullIntervalSeconds,
    };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method ?? "GET";
    const path = url.pathname;

    if (method === "GET" && path === "/contract.json") {
      serveContract(res, opts.contractOut, req.headers["accept-encoding"]);
      return;
    }

    if ((method === "GET" || method === "HEAD") && path === "/contract.json.gz") {
      servePrecompressedContract(res, opts.contractOut, method);
      return;
    }

    // Full-history activity_daily, read straight from the emitted contract file
    // (no store access, no config needed). Lets the Activity Overview render a true
    // trailing 12 months even when this device's Board data scope loaded a windowed
    // range as its primary env. See src/server/activity-daily.ts.
    if (method === "GET" && path === "/api/activity-daily") {
      handleActivityDailyRequest(opts.contractOut, res, req.headers["accept-encoding"]);
      return;
    }

    if (method === "GET" && path === "/api/capabilities") {
      await handleCapabilitiesRequest(capabilitiesOptionsFromEnv(process.env, { serverMode: "standalone" }), res);
      return;
    }

    if (method === "GET" && (path === "/api/range" || path === "/api/stats" || path === "/api/review-candidates")) {
      let cfg: AppConfig;
      try {
        cfg = freshConfig();
      } catch (err) {
        sendJson(res, 500, { error: "config_error", message: (err as Error).message });
        return;
      }
      if (path === "/api/stats") await handleStatsRequest(cfg, url, res);
      else if (path === "/api/review-candidates") await handleReviewCandidatesRequest(cfg, url, res);
      else await handleRangeRequest(cfg, url, res, req.headers["accept-encoding"]);
      return;
    }

    // /healthz, /api/sync-control, /api/sync-runs*, /api/config and the 404
    // fallback all live in the shared control handler.
    await handleControlRequest(controller, controlCtx(), req, res);
  };

  return createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      sendJson(res, 500, { error: "internal_error", message: (err as Error).message });
    });
  });
}

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

async function latestFinishedFullSyncAt(configPath: string | null, runsLimit: number): Promise<string | null> {
  const { cfg } = loadConfig(configPath);
  const store = await openConfiguredStoreReadOnly(cfg);
  try {
    const overview = await store.overview(runsLimit);
    return overview.sync_runs.find((run) => run.mode === "full" && run.finished_at !== null)?.finished_at ?? null;
  } finally {
    await store.close();
  }
}

export async function shouldRunStandaloneFullSync(
  configPath: string | null,
  schedule: Pick<SyncSchedule, "fullEvery" | "fullIntervalSeconds">,
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    const lastFull = await latestFinishedFullSyncAt(configPath, Math.max(200, Math.trunc(schedule.fullEvery) + 10));
    if (!lastFull) return true;
    const lastFullMs = Date.parse(lastFull);
    if (!Number.isFinite(lastFullMs)) return true;
    return nowMs - lastFullMs >= Math.max(1, Math.trunc(schedule.fullIntervalSeconds)) * 1000;
  } catch {
    // No readable store yet: a first full sweep is still the right bootstrap.
    return true;
  }
}

function main(): void {
  const configPath = process.env.SYMPHONY_CONFIG ?? null;
  const intervalSeconds = Math.max(1, Number(process.env.INTERVAL ?? String(STANDALONE_DEFAULT_INTERVAL_SECONDS)) || STANDALONE_DEFAULT_INTERVAL_SECONDS);
  const fullEveryDefault = Math.max(1, Math.ceil(STANDALONE_DEFAULT_FULL_INTERVAL_SECONDS / intervalSeconds));
  const opts: AppServerOptions = {
    configPath,
    contractOut: process.env.CONTRACT_OUT ?? "data/contract.json",
    controlEnabled: envFlag("SYNC_CONTROL_ENABLED", true),
    configControlEnabled: envFlag("CONFIG_CONTROL_ENABLED", true),
    logsEnabled: envFlag("LOG_CONTROL_ENABLED", true),
    secretsPath: resolveSecretsPath(),
    intervalSeconds,
    fullEvery: Math.max(1, Number(process.env.FULL_EVERY ?? String(fullEveryDefault)) || fullEveryDefault),
  };
  const port = Number(process.env.PORT ?? "8787") || 8787;
  const host = process.env.HOST ?? "127.0.0.1";

  const controller = new SyncController({
    run: (req, onProgress) => {
      const { cfg } = loadConfig(configPath);
      return runConfiguredSync(cfg, { mode: req.mode, dryRun: req.dryRun, sourceId: req.sourceId }, opts.contractOut, { onProgress });
    },
  });

  const server = createAppServer(controller, opts);
  server.listen(port, host, () => {
    log.info(
      `[app] standalone server on ${host}:${port} (manual sync ${opts.controlEnabled ? "ENABLED" : "disabled"}), config ${configPath ?? "config/sources.json"} -> ${opts.contractOut}`,
    );
  });

  const aborter = new AbortController();
  const shutdown = (sig: string) => {
    log.info(`[app] ${sig} received; shutting down`);
    aborter.abort();
    server.close();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  const schedule = () => {
    try {
      return syncScheduleFromConfig(loadConfig(configPath).cfg, { intervalSeconds: opts.intervalSeconds, fullEvery: opts.fullEvery });
    } catch {
      return syncScheduleFromConfig(null, { intervalSeconds: opts.intervalSeconds, fullEvery: opts.fullEvery });
    }
  };

  void runLoop(controller, {
    intervalMs: opts.intervalSeconds * 1000,
    fullEvery: opts.fullEvery,
    schedule,
    shouldRunFull: (_iteration, currentSchedule) => shouldRunStandaloneFullSync(configPath, currentSchedule),
    signal: aborter.signal,
  }).then(() => {
    server.close();
    process.exit(0);
  });
}

// Only run when invoked directly (node src/cli/app-server.ts), so tests can
// import createAppServer without side effects.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
