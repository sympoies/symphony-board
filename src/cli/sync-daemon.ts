#!/usr/bin/env node
// Writer-owned control daemon for SYNC_MODE=loop. It owns three things the shell
// loop could not safely own together:
//
//   1. the background cadence — a full sweep on the first iteration and every
//      FULL_EVERY-th iteration, incremental in between (a full+complete sweep is
//      what tombstones disappeared items/edges; see docs/DESIGN.md);
//   2. a single run lock, so a manual run and a scheduled run can never overlap
//      and SQLite never has two sync writers;
//   3. a small HTTP control surface for starting and observing manual sync runs.
//
// This is the SOLE writer by design. The read-only `api` sidecar never runs this
// daemon. The control surface always serves read-only status (and /healthz), but
// the mutating POST is gated behind SYNC_CONTROL_ENABLED and a same-origin custom
// header, so a blind cross-site POST cannot trigger a sync.
//
// Env: INTERVAL (seconds, default 120), FULL_EVERY (full sweep every Nth
// iteration, default 30; 1 = always full), SYMPHONY_CONFIG (default
// config/sources.json), CONTRACT_OUT (default data/contract.json),
// SYNC_CONTROL_ENABLED (enable manual runs; default off), SYNC_CONTROL_PORT
// (default 8080), SYNC_CONTROL_HOST (default 0.0.0.0).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import type { AppConfig, SourceConfig } from "../config.ts";
import { loadConfig } from "../config.ts";
import { runConfiguredSync, type SyncMode, type SourceRunResult, type SyncRunResult, type SyncRunTotals } from "../sync-runner.ts";
import { log } from "../log.ts";

// The same-origin guard for the mutating endpoint. A custom request header cannot
// be set by a cross-site simple form POST and forces a CORS preflight we never
// answer, so requiring it blocks blind cross-site POSTs without a shared secret.
export const SYNC_CONTROL_HEADER = "x-symphony-sync-control";
const MAX_BODY_BYTES = 16 * 1024;

export interface SyncRequest {
  mode: SyncMode;
  dryRun: boolean;
  sourceId: string | null;
}

// The JSON status the UI consumes for a run. `status` is "running" until the run
// finishes, then the worst-of per-source outcome (ok | partial | error).
export interface RunStatus {
  run_id: string;
  trigger: "manual" | "scheduled";
  mode: SyncMode;
  dry_run: boolean;
  source_scope: string | null;
  status: "running" | "ok" | "partial" | "error";
  started_at: string;
  finished_at: string | null;
  emitted: boolean;
  totals: SyncRunTotals | null;
  sources: SourceRunResult[];
  error: string | null;
}

export type RunExecutor = (req: SyncRequest) => Promise<SyncRunResult>;

export interface SyncControllerDeps {
  run: RunExecutor;
  now?: () => string;
  makeRunId?: (seq: number, startedAt: string) => string;
}

export interface StartOutcome {
  accepted: boolean;
  // The newly-started run (accepted) or the already-active run (rejected).
  status: RunStatus;
  // Resolves when the started run finishes; an immediately-resolved promise when
  // the start was rejected because a run is already active.
  done: Promise<void>;
}

function defaultRunId(seq: number, startedAt: string): string {
  const stamp = startedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${String(seq).padStart(4, "0")}`;
}

// Owns the single run slot and the last finished run. JS is single-threaded, so
// the check-and-claim in `start` cannot race: a manual and a scheduled caller can
// never both observe a free slot.
export class SyncController {
  private active: RunStatus | null = null;
  private last: RunStatus | null = null;
  private activeDone: Promise<void> = Promise.resolve();
  private seq = 0;
  private readonly run: RunExecutor;
  private readonly nowFn: () => string;
  private readonly makeRunId: (seq: number, startedAt: string) => string;

  constructor(deps: SyncControllerDeps) {
    this.run = deps.run;
    this.nowFn = deps.now ?? (() => new Date().toISOString());
    this.makeRunId = deps.makeRunId ?? defaultRunId;
  }

  current(): RunStatus | null {
    return this.active;
  }

  lastRun(): RunStatus | null {
    return this.last;
  }

  isRunning(): boolean {
    return this.active !== null;
  }

  start(req: SyncRequest, trigger: "manual" | "scheduled"): StartOutcome {
    if (this.active) {
      return { accepted: false, status: this.active, done: Promise.resolve() };
    }
    const startedAt = this.nowFn();
    const status: RunStatus = {
      run_id: this.makeRunId(++this.seq, startedAt),
      trigger,
      mode: req.mode,
      dry_run: req.dryRun,
      source_scope: req.sourceId,
      status: "running",
      started_at: startedAt,
      finished_at: null,
      emitted: false,
      totals: null,
      sources: [],
      error: null,
    };
    this.active = status;
    this.activeDone = this.execute(status, req);
    return { accepted: true, status, done: this.activeDone };
  }

  private async execute(status: RunStatus, req: SyncRequest): Promise<void> {
    try {
      const result = await this.run(req);
      status.status = result.status;
      status.totals = result.totals;
      status.sources = result.sources;
      status.emitted = result.emitted;
      status.error = result.error;
    } catch (err) {
      status.status = "error";
      status.error = (err as Error).message;
    } finally {
      status.finished_at = this.nowFn();
      this.last = status;
      this.active = null;
    }
  }

  // One scheduled tick. It never overlaps a manual run: if the slot is taken it
  // skips this tick (it does not queue) and the next interval tries again.
  async runScheduled(full: boolean): Promise<"ran" | "skipped"> {
    const outcome = this.start({ mode: full ? "full" : "incremental", dryRun: false, sourceId: null }, "scheduled");
    if (!outcome.accepted) return "skipped";
    await outcome.done;
    return "ran";
  }
}

export interface SourceOption {
  source_id: string;
  display_name: string | null;
  kind: string;
}

export function sourceOptions(cfg: AppConfig): SourceOption[] {
  return cfg.sources.map((s: SourceConfig) => ({
    source_id: s.source_id,
    display_name: s.display_name ?? null,
    kind: s.kind,
  }));
}

export interface ControlContext {
  controlEnabled: boolean;
  sources: SourceOption[];
  intervalSeconds: number;
  fullEvery: number;
}

export type ParsedRequest = { ok: true; request: SyncRequest } | { ok: false; message: string };

// Validate a control POST body into a SyncRequest. An empty body is the default
// request (incremental, all sources, write). Unknown mode or an unknown source_id
// is a 400, not a silent default, so a typo never quietly runs the wrong sweep.
export function parseSyncRequest(raw: string, sources: SourceOption[]): ParsedRequest {
  let body: unknown = {};
  if (raw.trim().length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      return { ok: false, message: "request body is not valid JSON" };
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  let mode: SyncMode = "incremental";
  if (b.mode !== undefined) {
    if (b.mode !== "incremental" && b.mode !== "full") {
      return { ok: false, message: `mode must be "incremental" or "full"` };
    }
    mode = b.mode;
  }

  let dryRun = false;
  if (b.dry_run !== undefined) {
    if (typeof b.dry_run !== "boolean") return { ok: false, message: "dry_run must be a boolean" };
    dryRun = b.dry_run;
  }

  let sourceId: string | null = null;
  if (b.source_id !== undefined && b.source_id !== null) {
    if (typeof b.source_id !== "string") return { ok: false, message: "source_id must be a string or null" };
    if (!sources.some((s) => s.source_id === b.source_id)) {
      return { ok: false, message: `unknown source_id: ${b.source_id}` };
    }
    sourceId = b.source_id;
  }

  return { ok: true, request: { mode, dryRun, sourceId } };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body) + "\n");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Build the HTTP control server (not yet listening). Exported so tests can drive
// it on an ephemeral port with an injected controller.
export function createControlServer(controller: SyncController, ctx: ControlContext): Server {
  return createServer((req, res) => {
    void handleRequest(controller, ctx, req, res).catch((err: unknown) => {
      sendJson(res, 500, { error: "internal_error", message: (err as Error).message });
    });
  });
}

async function handleRequest(
  controller: SyncController,
  ctx: ControlContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const method = req.method ?? "GET";
  const path = url.pathname;

  if (method === "GET" && path === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "GET" && path === "/api/sync-control") {
    sendJson(res, 200, {
      enabled: ctx.controlEnabled,
      sources: ctx.sources,
      current: controller.current(),
      last: controller.lastRun(),
      interval_seconds: ctx.intervalSeconds,
      full_every: ctx.fullEvery,
    });
    return;
  }

  if (method === "GET" && path === "/api/sync-runs/current") {
    sendJson(res, 200, { current: controller.current() });
    return;
  }

  if (method === "GET" && path === "/api/sync-runs/last") {
    sendJson(res, 200, { last: controller.lastRun() });
    return;
  }

  if (path === "/api/sync-runs" && method === "POST") {
    if (!ctx.controlEnabled) {
      sendJson(res, 403, { error: "control_disabled", message: "manual sync control is not enabled on this deployment" });
      return;
    }
    if (!req.headers[SYNC_CONTROL_HEADER]) {
      sendJson(res, 403, { error: "forbidden", message: `missing ${SYNC_CONTROL_HEADER} header` });
      return;
    }
    let raw: string;
    try {
      raw = await readBody(req);
    } catch (err) {
      sendJson(res, 413, { error: "payload_too_large", message: (err as Error).message });
      return;
    }
    const parsed = parseSyncRequest(raw, ctx.sources);
    if (!parsed.ok) {
      sendJson(res, 400, { error: "bad_request", message: parsed.message });
      return;
    }
    const outcome = controller.start(parsed.request, "manual");
    if (!outcome.accepted) {
      // Re-entrancy: a run is already active. Return its status so the UI can
      // adopt and poll it instead of starting a second writer.
      sendJson(res, 409, { error: "run_active", current: outcome.status });
      return;
    }
    sendJson(res, 202, { current: outcome.status });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

// Abortable sleep so the loop can stop promptly on SIGTERM/SIGINT.
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface LoopOptions {
  intervalMs: number;
  fullEvery: number;
  signal: AbortSignal;
}

// The background cadence. Mirrors the prior shell loop: iteration 0 (and every
// FULL_EVERY-th) is a full sweep, the rest incremental, sleeping `intervalMs`
// between. A manual run in progress makes a scheduled tick skip rather than wait.
export async function runLoop(controller: SyncController, opts: LoopOptions): Promise<void> {
  log.info(`[loop] sync + emit every ${Math.round(opts.intervalMs / 1000)}s (full sweep every ${opts.fullEvery} iterations)`);
  let i = 0;
  while (!opts.signal.aborted) {
    const full = i % opts.fullEvery === 0;
    log.info(`[loop] iteration ${i} (${full ? "full" : "incremental"})`);
    try {
      const outcome = await controller.runScheduled(full);
      if (outcome === "skipped") log.info(`[loop] iteration ${i} skipped: a manual run is active`);
    } catch (err) {
      log.error(`[loop] iteration ${i} error: ${(err as Error).message}; continuing`);
    }
    i++;
    await sleep(opts.intervalMs, opts.signal);
  }
}

function envFlag(name: string): boolean {
  const v = (process.env[name] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function main(): void {
  const { cfg, path: configPath } = loadConfig(process.env.SYMPHONY_CONFIG ?? null);
  const out = process.env.CONTRACT_OUT ?? "data/contract.json";
  const intervalSeconds = Math.max(1, Number(process.env.INTERVAL ?? "120") || 120);
  const fullEvery = Math.max(1, Number(process.env.FULL_EVERY ?? "30") || 30);
  const controlEnabled = envFlag("SYNC_CONTROL_ENABLED");
  const controlPort = Number(process.env.SYNC_CONTROL_PORT ?? "8080") || 8080;
  const controlHost = process.env.SYNC_CONTROL_HOST ?? "0.0.0.0";

  const controller = new SyncController({
    run: (req) => runConfiguredSync(cfg, { mode: req.mode, dryRun: req.dryRun, sourceId: req.sourceId }, out),
  });
  const ctx: ControlContext = {
    controlEnabled,
    sources: sourceOptions(cfg),
    intervalSeconds,
    fullEvery,
  };

  const server = createControlServer(controller, ctx);
  server.listen(controlPort, controlHost, () => {
    log.info(
      `[loop] control surface on ${controlHost}:${controlPort} (manual sync ${controlEnabled ? "ENABLED" : "disabled"}), config ${configPath} -> ${out}`,
    );
  });

  const aborter = new AbortController();
  const shutdown = (sig: string) => {
    log.info(`[loop] ${sig} received; shutting down`);
    aborter.abort();
    server.close();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  void runLoop(controller, { intervalMs: intervalSeconds * 1000, fullEvery, signal: aborter.signal }).then(() => {
    server.close();
    process.exit(0);
  });
}

// Only run the daemon when invoked directly (node src/cli/sync-daemon.ts), so
// tests can import SyncController / createControlServer without side effects.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
