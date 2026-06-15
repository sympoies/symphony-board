#!/usr/bin/env node
// Writer-owned control daemon for SYNC_MODE=loop. It owns three things the shell
// loop could not safely own together:
//
//   1. the background cadence — a full sweep on the first iteration and every
//      FULL_EVERY-th iteration, incremental in between (a full+complete sweep is
//      what tombstones disappeared items/edges; see docs/DESIGN.md);
//   2. a single run lock, so a manual run and a scheduled run can never overlap
//      and the configured store never has two sync writers;
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
// (default 8080), SYNC_CONTROL_HOST (default 0.0.0.0),
// CONFIG_CONTROL_ENABLED (enable config edits over HTTP; default off here —
// the Docker stack mounts config read-only and stays file-managed),
// LOG_CONTROL_ENABLED (serve this process's recent-log tail on GET /api/logs
// for the UI Diagnostics page; default off here, the compose stack opts in).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import type { AppConfig, SourceConfig } from "../config.ts";
import { configErrors, loadConfig, readSecretsOverlay, resolveSecretsPath, saveConfig, saveSecret } from "../config.ts";
import {
  runConfiguredSync,
  type SyncMode,
  type SyncProgressReporter,
  type SourceRunResult,
  type SyncRunResult,
  type SyncRunTotals,
} from "../sync-runner.ts";
import { log, recentLogs, latestLogSeq, LOG_BUFFER_CAPACITY } from "../log.ts";

// The same-origin guard for every mutating control-plane endpoint (manual sync
// AND config writes). A custom request header cannot be set by a cross-site
// simple form POST and forces a CORS preflight we never answer, so requiring it
// blocks blind cross-site mutations without a shared secret.
export const SYNC_CONTROL_HEADER = "x-symphony-sync-control";
const MAX_BODY_BYTES = 16 * 1024;
// Config documents carry identities/exclude_actors lists and grow with the
// deployment; give PUT /api/config more headroom than a sync-run POST.
const MAX_CONFIG_BODY_BYTES = 256 * 1024;

export interface SyncRequest {
  mode: SyncMode;
  dryRun: boolean;
  sourceId: string | null;
}

// The JSON status the UI consumes for a run. `status` is "running" until the run
// finishes, then the worst-of per-source outcome (ok | partial | error), or
// "skipped" when the run was refused the store's writer lease — another
// live writer (e.g. a host-side sync against the daemon's store) held it. While
// running, `sources` fills incrementally as each source finishes and
// `active_source_id` names the source currently being fetched (null between
// sources and on a finished run), so the UI can narrate per-source progress.
export interface RunStatus {
  run_id: string;
  trigger: "manual" | "scheduled";
  mode: SyncMode;
  dry_run: boolean;
  source_scope: string | null;
  status: "running" | "ok" | "partial" | "error" | "skipped";
  started_at: string;
  finished_at: string | null;
  emitted: boolean;
  totals: SyncRunTotals | null;
  sources: SourceRunResult[];
  active_source_id: string | null;
  error: string | null;
}

export type RunExecutor = (req: SyncRequest, onProgress: SyncProgressReporter) => Promise<SyncRunResult>;

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
      active_source_id: null,
      error: null,
    };
    this.active = status;
    this.activeDone = this.execute(status, req);
    return { accepted: true, status, done: this.activeDone };
  }

  private async execute(status: RunStatus, req: SyncRequest): Promise<void> {
    try {
      // Live per-source progress straight onto the active status. The guard
      // drops a stray report after the slot cleared, so a late callback can
      // never resurrect "running" details on a finished run.
      const result = await this.run(req, (p) => {
        if (this.active !== status) return;
        status.sources = p.sources;
        status.active_source_id = p.active_source_id;
      });
      status.status = result.status;
      status.totals = result.totals;
      status.sources = result.sources;
      status.emitted = result.emitted;
      status.error = result.error;
    } catch (err) {
      status.status = "error";
      status.error = (err as Error).message;
    } finally {
      status.active_source_id = null;
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

// The writer-owned config control plane. `enabled` gates mutations (and config
// reads — a disabled deployment never serves its config document over HTTP);
// `path` is where GET reads and PUT atomically writes. The file may not exist
// yet: a missing config is "not configured", which is exactly the state the
// standalone first-run onboarding starts from. `secretsPath` is the KEY=VALUE
// token file the write-only secrets surface edits; null when the deployment
// has no writable secrets file (tokens then come from the process env only).
export interface ConfigControl {
  enabled: boolean;
  path: string;
  secretsPath: string | null;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ControlContext {
  controlEnabled: boolean;
  configControl: ConfigControl;
  // Serve this process's in-memory recent-log tail on GET /api/logs. Read-only
  // and same-process by construction (the buffer lives in src/log.ts), so the
  // Docker stack must route the path to the writer daemon, not the api sidecar.
  logsEnabled: boolean;
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

function readBody(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (tooLarge) {
        // Keep draining (discarded) so the 413 reaches a live socket instead of
        // an ECONNRESET; a runaway stream still gets cut at 4x the limit.
        if (size > maxBytes * 4) req.destroy();
        return;
      }
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) reject(new Error("request body too large"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

// Build the HTTP control server (not yet listening). Exported so tests can drive
// it on an ephemeral port with an injected controller.
export function createControlServer(controller: SyncController, ctx: ControlContext): Server {
  return createServer((req, res) => {
    void handleControlRequest(controller, ctx, req, res).catch((err: unknown) => {
      sendJson(res, 500, { error: "internal_error", message: (err as Error).message });
    });
  });
}

// One control-surface request. Exported so the standalone app server can mount
// these routes on its unified HTTP surface beside /contract.json and /api/range.
export async function handleControlRequest(
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

  // Recent-log tail for the UI Diagnostics page. GET doubles as the capability
  // probe (a disabled deployment answers { enabled: false } and leaks nothing).
  // "?after=<seq>" returns only entries newer than the caller's last-seen seq,
  // so the poll loop ships deltas instead of the whole buffer every tick.
  if (method === "GET" && path === "/api/logs") {
    if (!ctx.logsEnabled) {
      sendJson(res, 200, { enabled: false, entries: [], latest_seq: 0, capacity: 0 });
      return;
    }
    const afterRaw = Number(url.searchParams.get("after") ?? "0");
    const after = Number.isFinite(afterRaw) && afterRaw > 0 ? Math.trunc(afterRaw) : 0;
    sendJson(res, 200, { enabled: true, entries: recentLogs(after), latest_seq: latestLogSeq(), capacity: LOG_BUFFER_CAPACITY });
    return;
  }

  // Config control plane. GET doubles as the UI capability probe: a disabled
  // deployment answers { enabled: false } with no config document, so the
  // Settings editor stays hidden and nothing about the deployment leaks.
  if (method === "GET" && path === "/api/config") {
    const cc = ctx.configControl;
    if (!cc.enabled) {
      sendJson(res, 200, { enabled: false, config: null, error: null });
      return;
    }
    try {
      const { cfg } = loadConfig(cc.path);
      sendJson(res, 200, { enabled: true, config: cfg, error: null });
    } catch (err) {
      // Missing or broken config: still advertise the capability so the UI can
      // offer creating one — the standalone first-run onboarding path.
      sendJson(res, 200, { enabled: true, config: null, error: (err as Error).message });
    }
    return;
  }

  if (method === "PUT" && path === "/api/config") {
    const cc = ctx.configControl;
    if (!cc.enabled) {
      sendJson(res, 403, { error: "control_disabled", message: "config control is not enabled on this deployment" });
      return;
    }
    if (!req.headers[SYNC_CONTROL_HEADER]) {
      sendJson(res, 403, { error: "forbidden", message: `missing ${SYNC_CONTROL_HEADER} header` });
      return;
    }
    let raw: string;
    try {
      raw = await readBody(req, MAX_CONFIG_BODY_BYTES);
    } catch (err) {
      sendJson(res, 413, { error: "payload_too_large", message: (err as Error).message });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { error: "bad_request", message: "request body is not valid JSON" });
      return;
    }
    // Server-side validation is authoritative; every problem comes back in one
    // round trip. An invalid document never reaches disk.
    const errors = configErrors(parsed, "config");
    if (errors.length > 0) {
      sendJson(res, 400, { error: "invalid_config", errors });
      return;
    }
    saveConfig(parsed as AppConfig, cc.path);
    sendJson(res, 200, { ok: true, config: parsed });
    return;
  }

  // Write-only secrets surface. GET reports which env-var names resolve to a
  // token — booleans only, a value never crosses this surface in either
  // direction beyond the user's own PUT.
  if (method === "GET" && path === "/api/secrets") {
    const cc = ctx.configControl;
    if (!cc.enabled) {
      sendJson(res, 200, { enabled: false, writable: false, secrets: {} });
      return;
    }
    const secrets: Record<string, boolean> = {};
    try {
      const { cfg } = loadConfig(cc.path);
      for (const s of cfg.sources) {
        for (const envName of [s.token_env, ...(s.fallback_token_envs ?? [])]) secrets[envName] = false;
      }
    } catch {
      // no config yet: report only the names present in the secrets file
    }
    for (const [name, value] of readSecretsOverlay(cc.secretsPath)) {
      if (value.length > 0) secrets[name] = true;
    }
    for (const name of Object.keys(secrets)) {
      if (!secrets[name] && (process.env[name] ?? "").trim().length > 0) secrets[name] = true;
    }
    sendJson(res, 200, { enabled: true, writable: cc.secretsPath !== null, secrets });
    return;
  }

  if (method === "PUT" && path === "/api/secrets") {
    const cc = ctx.configControl;
    if (!cc.enabled) {
      sendJson(res, 403, { error: "control_disabled", message: "config control is not enabled on this deployment" });
      return;
    }
    if (!req.headers[SYNC_CONTROL_HEADER]) {
      sendJson(res, 403, { error: "forbidden", message: `missing ${SYNC_CONTROL_HEADER} header` });
      return;
    }
    if (!cc.secretsPath) {
      sendJson(res, 403, { error: "secrets_unavailable", message: "no writable secrets file on this deployment (set SYMPHONY_SECRETS_FILE)" });
      return;
    }
    let raw: string;
    try {
      raw = await readBody(req);
    } catch (err) {
      sendJson(res, 413, { error: "payload_too_large", message: (err as Error).message });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { error: "bad_request", message: "request body is not valid JSON" });
      return;
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      sendJson(res, 400, { error: "bad_request", message: "request body must be a JSON object" });
      return;
    }
    const { env, value } = body as Record<string, unknown>;
    if (typeof env !== "string" || !ENV_NAME.test(env)) {
      sendJson(res, 400, { error: "bad_request", message: "env must be a valid env-var name" });
      return;
    }
    if (value !== null && (typeof value !== "string" || value.trim().length === 0)) {
      sendJson(res, 400, { error: "bad_request", message: "value must be a non-empty string, or null to remove the entry" });
      return;
    }
    saveSecret(cc.secretsPath, env, value === null ? null : (value as string).trim());
    sendJson(res, 200, { ok: true, env, set: value !== null });
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
    // Fresh config per run (matching app-server), so an edit to the mounted
    // config file — by hand or through the control plane — applies on the next
    // run without a restart. The active run keeps the config it started with.
    run: (req, onProgress) => {
      const { cfg: fresh } = loadConfig(process.env.SYMPHONY_CONFIG ?? null);
      return runConfiguredSync(fresh, { mode: req.mode, dryRun: req.dryRun, sourceId: req.sourceId }, out, { onProgress });
    },
  });
  const ctx: ControlContext = {
    controlEnabled,
    configControl: { enabled: envFlag("CONFIG_CONTROL_ENABLED"), path: configPath, secretsPath: resolveSecretsPath() },
    logsEnabled: envFlag("LOG_CONTROL_ENABLED"),
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
