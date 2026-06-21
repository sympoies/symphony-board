// Loading the contract (LAYER 3) for the UI to render. The UI is a pure
// CONSUMER: it reads the versioned JSON envelope and stays liberal in what it
// accepts (it does not re-validate — producers validate strictly; see
// docs/CONTRACT.md). Types come from @symphony-board/contract.

import type { ContractEnvelope } from "@symphony-board/contract";
import type { TimeRange, SyncControlInfo, SyncRunStatus, SyncRunRequest, ConfigControlInfo, ConfigDocument, SecretsInfo, StoreStats, DaemonLogsInfo, LiveSnapshot } from "./model.ts";
import { appFetch } from "./runtime.ts";
import { currentClientKind, loadServerBaseUrl, requiresConfiguredServerBaseUrl } from "./viewconfig.ts";

// The major this UI understands. The contract versions independently; if a
// future emit bumps the MAJOR, the UI should branch (or warn) rather than
// silently mis-render. Minor/patch are backward compatible by contract rule.
export const SUPPORTED_MAJOR = 4;

export function majorOf(version: string): number {
  return Number(version.split(".")[0] ?? "0");
}

export function resolveEndpoint(url: string, serverBaseUrl: string | null = loadServerBaseUrl()): string {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(url)) return url;
  if (!serverBaseUrl) return url;
  const path = url.startsWith("./") ? url.slice(2) : url.startsWith("/") ? url.slice(1) : url;
  return new URL(path, serverBaseUrl).toString();
}

export function endpointRequiresServerUrl(url: string, serverBaseUrl: string | null, clientKind: string | null = currentClientKind()): boolean {
  return !serverBaseUrl && requiresConfiguredServerBaseUrl(clientKind) && !/^[a-z][a-z\d+.-]*:\/\//i.test(url);
}

const textEncoder = new TextEncoder();

function utf8ByteLength(text: string): number {
  return textEncoder.encode(text).length;
}

async function readJson(res: Response): Promise<unknown> {
  const body = (await res.json()) as unknown;
  return typeof body === "string" ? JSON.parse(body) : body;
}

function parseJsonPayload(text: string): unknown {
  const body = JSON.parse(text) as unknown;
  return typeof body === "string" ? JSON.parse(body) : body;
}

async function readContractPayload(res: Response): Promise<{ body: unknown; bytes: number }> {
  if (typeof res.text === "function") {
    const text = await res.text();
    return { body: parseJsonPayload(text), bytes: utf8ByteLength(text) };
  }
  const body = await readJson(res);
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { body, bytes: utf8ByteLength(text) };
}

function headerValue(res: Response, name: string): string | null {
  try {
    return res.headers?.get(name) ?? null;
  } catch {
    return null;
  }
}

function parseByteHeader(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

interface ResourceTimingLike extends PerformanceEntry {
  decodedBodySize?: number;
  encodedBodySize?: number;
  transferSize?: number;
}

function positiveTimingBytes(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function resourceTimingNames(target: string, responseUrl: string | null): string[] {
  const names = new Set<string>();
  if (target) names.add(target);
  if (responseUrl) names.add(responseUrl);
  if (typeof window !== "undefined") {
    try {
      names.add(new URL(target, window.location.href).toString());
    } catch {
      // Relative paths resolve in browsers; malformed custom schemes can fall
      // back to the direct target/response URL names above.
    }
  }
  return [...names];
}

function readResourceTimingBytes(target: string, responseUrl: string | null): Pick<ContractLoadMetadata, "encodedBytes" | "transferBytes" | "encodedBytesSource"> {
  if (typeof performance === "undefined" || typeof performance.getEntriesByName !== "function") {
    return { encodedBytes: null, transferBytes: null, encodedBytesSource: null };
  }
  for (const name of resourceTimingNames(target, responseUrl)) {
    const entries = performance.getEntriesByName(name).filter((entry) => entry.entryType === "resource") as ResourceTimingLike[];
    const entry = entries[entries.length - 1];
    if (!entry) continue;
    const encodedBytes = positiveTimingBytes(entry.encodedBodySize);
    const transferBytes = positiveTimingBytes(entry.transferSize);
    if (encodedBytes || transferBytes) {
      return {
        encodedBytes,
        transferBytes,
        encodedBytesSource: encodedBytes ? "resource-timing" : null,
      };
    }
  }
  return { encodedBytes: null, transferBytes: null, encodedBytesSource: null };
}

type EncodedBytesSource = "resource-timing" | "content-length" | "precompressed-content-length" | "precompressed-body";
type TransferMetadata = Pick<ContractLoadMetadata, "encodedBytes" | "transferBytes" | "contentEncoding" | "encodedBytesSource">;

function readTransferMetadata(target: string, res: Response): TransferMetadata {
  const contentEncoding = headerValue(res, "content-encoding");
  const resourceTiming = readResourceTimingBytes(target, typeof res.url === "string" && res.url ? res.url : null);
  if (resourceTiming.encodedBytes != null) {
    return {
      ...resourceTiming,
      contentEncoding,
    };
  }
  const contentLength = parseByteHeader(headerValue(res, "content-length"));
  return {
    encodedBytes: contentLength,
    transferBytes: resourceTiming.transferBytes,
    contentEncoding,
    encodedBytesSource: contentLength == null ? null : "content-length",
  };
}

function precompressedContractUrl(target: string): string | null {
  try {
    const base = typeof window !== "undefined" ? window.location.href : undefined;
    const resolved = new URL(target, base);
    if (!resolved.pathname.endsWith("/contract.json")) return null;
    resolved.pathname = `${resolved.pathname}.gz`;
    return resolved.toString();
  } catch {
    return target.endsWith("contract.json") ? `${target}.gz` : null;
  }
}

function isPrecompressedContentType(res: Response): boolean {
  const contentType = headerValue(res, "content-type")?.toLowerCase() ?? "";
  return contentType.includes("gzip") || contentType.includes("application/octet-stream");
}

function looksLikeGzip(body: ArrayBuffer): boolean {
  const bytes = new Uint8Array(body);
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function precompressedMetadataFromLength(res: Response): TransferMetadata | null {
  if (!isPrecompressedContentType(res)) return null;
  const contentLength = parseByteHeader(headerValue(res, "content-length"));
  if (contentLength == null) return null;
  return {
    encodedBytes: contentLength,
    transferBytes: null,
    contentEncoding: "gzip",
    encodedBytesSource: "precompressed-content-length",
  };
}

async function probePrecompressedContractMetadata(target: string, signal: AbortSignal, connectTimeoutMs: number): Promise<TransferMetadata | null> {
  const gzUrl = precompressedContractUrl(target);
  if (!gzUrl) return null;

  const requestInit = {
    cache: "no-store" as RequestCache,
    headers: { "Accept-Encoding": "identity" },
    signal,
    connectTimeout: connectTimeoutMs,
  };

  try {
    const head = await appFetch(gzUrl, { ...requestInit, method: "HEAD" });
    if (head.ok) {
      const metadata = precompressedMetadataFromLength(head);
      if (metadata) return metadata;
    }

    const res = await appFetch(gzUrl, { ...requestInit, method: "GET" });
    if (!res.ok) return null;
    const metadata = precompressedMetadataFromLength(res);
    if (metadata) return metadata;
    if (typeof res.arrayBuffer !== "function") return null;
    const body = await res.arrayBuffer();
    if (!looksLikeGzip(body)) return null;
    return {
      encodedBytes: body.byteLength,
      transferBytes: null,
      contentEncoding: "gzip",
      encodedBytesSource: "precompressed-body",
    };
  } catch {
    return null;
  }
}

function asContractEnvelope(body: unknown): ContractEnvelope {
  if (!body || typeof body !== "object" || !Array.isArray((body as { items?: unknown }).items) || typeof (body as { contract_version?: unknown }).contract_version !== "string") {
    throw new Error("not a symphony-board contract (missing contract_version / items)");
  }
  return body as ContractEnvelope;
}

export interface ContractLoadMetadata {
  source: "network" | "file";
  url: string;
  // Decoded JSON text bytes. Browser/native fetches expose the body after
  // Content-Encoding has been decoded.
  bytes: number;
  // Encoded response-body bytes. Prefer Resource Timing's encodedBodySize, then
  // fall back to Content-Length when a server provides it for the encoded entity.
  encodedBytes: number | null;
  // Total HTTP transfer bytes including headers when Resource Timing exposes it.
  transferBytes: number | null;
  contentEncoding: string | null;
  encodedBytesSource: EncodedBytesSource | null;
  loadedAt: string;
  durationMs: number;
}

export interface LoadedContract {
  env: ContractEnvelope;
  meta: ContractLoadMetadata;
}

// --- contract-load resilience -------------------------------------------------
// The contract is fetched from a possibly-remote board over a link that can be
// slow or briefly unreachable: the server may be restarting, the connection may
// stall, or a large payload may arrive over a degraded path. A bare one-shot
// fetch with no time bound leaves the UI's "Loading contract…" hanging forever
// with no recovery but an app restart; a single try with no retry turns a
// momentary blip into a board that only a restart clears. So the load gets a
// bounded per-attempt timeout plus a few backoff retries on transient failures.
//
// `connectTimeout` bounds connection setup on the desktop client WITHOUT
// aborting an in-progress transfer (so a legitimately slow but progressing
// download still completes); `AbortSignal.timeout` is the overall per-attempt
// ceiling and also covers the browser, which ignores `connectTimeout`. Transient
// failures (a thrown fetch — network error / abort / timeout — or a 5xx) retry
// with exponential backoff; a definitive answer (a 4xx, or a 200 whose body is
// not a contract) is surfaced immediately rather than retried.
export const CONTRACT_CONNECT_TIMEOUT_MS = 10_000;
export const CONTRACT_REQUEST_TIMEOUT_MS = 30_000;
export const CONTRACT_LOAD_RETRIES = 2;
export const CONTRACT_RETRY_BASE_DELAY_MS = 1_000;
const CONTRACT_RETRY_MAX_DELAY_MS = 8_000;

// --- cold-start init retry (App-level outer loop) ----------------------------
// The loader above retries a few times WITHIN one call. The App also runs an
// OUTER retry loop on cold start so a board that is briefly unreachable at launch
// (server still starting, the tailnet not up yet, a momentary blip) self-heals
// into a working board WITHOUT an app restart — the old behaviour stranded the UI
// on a dead error screen until relaunch. Each outer round does a SINGLE fetch
// (retries: 0) so the visible status reflects each try; this policy then spaces
// the rounds with capped exponential backoff. The first PATIENT rounds keep the
// cold-start splash up and retry quietly; after that the actionable error UI
// shows while the loop keeps retrying in the background.
export const INIT_LOAD_PATIENT_ATTEMPTS = 2;
export const INIT_LOAD_RETRY_BASE_MS = 1_500;
export const INIT_LOAD_RETRY_MAX_MS = 15_000;

// Backoff before the Nth consecutive init retry (attempt counts failures so far,
// >= 1), capped. Pure + unit-tested (contract.test.ts).
export function initLoadRetryDelayMs(
  attempt: number,
  baseMs: number = INIT_LOAD_RETRY_BASE_MS,
  maxMs: number = INIT_LOAD_RETRY_MAX_MS,
): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(baseMs * 2 ** (n - 1), maxMs);
}

export interface ContractLoadOptions {
  retries?: number; // extra attempts after the first
  retryBaseDelayMs?: number; // exponential-backoff base
  requestTimeoutMs?: number; // per-attempt overall ceiling (browser + desktop)
  connectTimeoutMs?: number; // per-attempt connect bound (desktop only)
  sleep?: (ms: number) => Promise<void>; // injectable for tests
}

interface TaggedError extends Error {
  transient?: boolean;
  status?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isTransient(err: unknown): boolean {
  return !!(err && typeof err === "object" && (err as TaggedError).transient === true);
}

// Per-attempt overall-timeout signal. `AbortSignal.timeout` is the direct path,
// but some older WebViews (e.g. an older WKWebView, since the Tauri configs do
// not raise the default macOS minimum) have not implemented the static helper;
// calling it unguarded throws a TypeError that the retry loop would only repeat,
// so the UI would never load a contract. Fall back to an AbortController +
// setTimeout — universally available — when the static helper is missing.
function createAttemptTimeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

async function loadContractAttempt(target: string, requestTimeoutMs: number, connectTimeoutMs: number): Promise<{ env: ContractEnvelope } & Pick<ContractLoadMetadata, "bytes" | "encodedBytes" | "transferBytes" | "contentEncoding" | "encodedBytesSource">> {
  const signal = createAttemptTimeoutSignal(requestTimeoutMs);
  let res: Response;
  try {
    res = await appFetch(target, {
      cache: "no-store",
      signal,
      connectTimeout: connectTimeoutMs,
    });
  } catch (err) {
    // A thrown fetch — a network error, or an abort from the per-attempt timeout
    // — is transient and worth a retry.
    const tagged = (err instanceof Error ? err : new Error(String(err))) as TaggedError;
    tagged.transient = true;
    throw tagged;
  }
  if (!res.ok) {
    const tagged: TaggedError = new Error(`could not load ${target}: HTTP ${res.status}`);
    tagged.status = res.status;
    tagged.transient = res.status >= 500; // 5xx is transient; a 4xx is definitive
    throw tagged;
  }
  // The transfer can still stall AFTER headers arrive: the per-attempt timeout
  // fires (or the connection drops) mid-body, so readJson rejects. That interrupted
  // body read is transient — retry it like a thrown fetch — but a SyntaxError on a
  // fully-received body is a definitive content error, surfaced without retrying.
  let payload: { body: unknown; bytes: number };
  try {
    payload = await readContractPayload(res);
  } catch (err) {
    const tagged = (err instanceof Error ? err : new Error(String(err))) as TaggedError;
    tagged.transient = signal.aborted || !(err instanceof SyntaxError);
    throw tagged;
  }
  let transferMetadata = readTransferMetadata(target, res);
  if (transferMetadata.encodedBytes == null) {
    const precompressedMetadata = await probePrecompressedContractMetadata(target, signal, connectTimeoutMs);
    if (precompressedMetadata) {
      transferMetadata = {
        ...precompressedMetadata,
        transferBytes: transferMetadata.transferBytes,
      };
    }
  }
  // A well-formed but non-contract body is definitive: asContractEnvelope throws a
  // plain (untagged) error, so it surfaces immediately without spinning.
  return { env: asContractEnvelope(payload.body), bytes: payload.bytes, ...transferMetadata };
}

// Fetch the contract emitted alongside the app (the loop daemon writes
// data/contract.json; deploy it next to index.html). Relative URL so it works
// under any base path.
export async function fetchContractWithMetadata(
  url = "./contract.json",
  serverBaseUrl: string | null = loadServerBaseUrl(),
  clientKind: string | null = currentClientKind(),
  opts: ContractLoadOptions = {},
): Promise<LoadedContract> {
  if (endpointRequiresServerUrl(url, serverBaseUrl, clientKind)) {
    throw new Error("Android client requires a server URL. Set Settings -> Server to a reachable Symphony Board HTTP(S) surface.");
  }
  const target = resolveEndpoint(url, serverBaseUrl);
  const retries = opts.retries ?? CONTRACT_LOAD_RETRIES;
  const baseDelay = opts.retryBaseDelayMs ?? CONTRACT_RETRY_BASE_DELAY_MS;
  const requestTimeoutMs = opts.requestTimeoutMs ?? CONTRACT_REQUEST_TIMEOUT_MS;
  const connectTimeoutMs = opts.connectTimeoutMs ?? CONTRACT_CONNECT_TIMEOUT_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      const loaded = await loadContractAttempt(target, requestTimeoutMs, connectTimeoutMs);
      const finishedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
      return {
        env: loaded.env,
        meta: {
          source: "network",
          url: target,
          bytes: loaded.bytes,
          encodedBytes: loaded.encodedBytes,
          transferBytes: loaded.transferBytes,
          contentEncoding: loaded.contentEncoding,
          encodedBytesSource: loaded.encodedBytesSource,
          loadedAt: new Date().toISOString(),
          durationMs: Math.max(0, Math.round(finishedAt - startedAt)),
        },
      };
    } catch (err) {
      if (attempt >= retries || !isTransient(err)) throw err;
      await sleep(Math.min(baseDelay * 2 ** attempt, CONTRACT_RETRY_MAX_DELAY_MS));
    }
  }
}

export async function fetchContract(
  url = "./contract.json",
  serverBaseUrl: string | null = loadServerBaseUrl(),
  clientKind: string | null = currentClientKind(),
  opts: ContractLoadOptions = {},
): Promise<ContractEnvelope> {
  return (await fetchContractWithMetadata(url, serverBaseUrl, clientKind, opts)).env;
}

export function parseContractWithMetadata(text: string, url = "uploaded contract.json", durationMs = 0): LoadedContract {
  return {
    env: asContractEnvelope(parseJsonPayload(text)),
    meta: {
      source: "file",
      url,
      bytes: utf8ByteLength(text),
      encodedBytes: null,
      transferBytes: null,
      contentEncoding: null,
      encodedBytesSource: null,
      loadedAt: new Date().toISOString(),
      durationMs,
    },
  };
}

export async function fetchRangeContract(range: TimeRange, serverBaseUrl: string | null = loadServerBaseUrl(), opts: ContractLoadOptions = {}): Promise<ContractEnvelope> {
  const params = new URLSearchParams({ from: range.from, to: range.to });
  return fetchContract(`./api/range?${params.toString()}`, serverBaseUrl, currentClientKind(), opts);
}

// --- UI-triggered manual sync control plane client ---
// The board daemon serves these beside the contract; the web sidecar proxies
// them. All routes are relative so they work under any base path.

// Same-origin guard the daemon requires on the mutating POST. A custom header
// cannot be set by a cross-site simple form POST, so sending it proves the
// request came from this app.
export const SYNC_CONTROL_HEADER = "X-Symphony-Sync-Control";

// Availability probe. Returns null on ANY failure (route missing, network error,
// non-2xx) so the caller treats sync control as simply unavailable and hides the
// affordance — the common case for a static deploy without the daemon.
export async function fetchSyncControl(serverBaseUrl: string | null = loadServerBaseUrl()): Promise<SyncControlInfo | null> {
  try {
    const res = await appFetch(resolveEndpoint("./api/sync-control", serverBaseUrl), { cache: "no-store" });
    if (!res.ok) return null;
    return (await readJson(res)) as SyncControlInfo;
  } catch {
    return null;
  }
}

export async function fetchCurrentSyncRun(serverBaseUrl: string | null = loadServerBaseUrl()): Promise<SyncRunStatus | null> {
  const res = await appFetch(resolveEndpoint("./api/sync-runs/current", serverBaseUrl), { cache: "no-store" });
  if (!res.ok) throw new Error(`sync status: HTTP ${res.status}`);
  const body = (await readJson(res)) as { current: SyncRunStatus | null };
  return body.current ?? null;
}

export async function fetchLastSyncRun(serverBaseUrl: string | null = loadServerBaseUrl()): Promise<SyncRunStatus | null> {
  const res = await appFetch(resolveEndpoint("./api/sync-runs/last", serverBaseUrl), { cache: "no-store" });
  if (!res.ok) throw new Error(`sync status: HTTP ${res.status}`);
  const body = (await readJson(res)) as { last: SyncRunStatus | null };
  return body.last ?? null;
}

export interface StartSyncResult {
  // ok: a new run was accepted (202). status 409: a run is already active and
  // `run` carries it, so the caller can adopt and poll it rather than erroring.
  ok: boolean;
  status: number;
  run: SyncRunStatus | null;
  error: string | null;
}

export async function startSyncRun(req: SyncRunRequest, serverBaseUrl: string | null = loadServerBaseUrl()): Promise<StartSyncResult> {
  const res = await appFetch(resolveEndpoint("./api/sync-runs", serverBaseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", [SYNC_CONTROL_HEADER]: "1" },
    body: JSON.stringify(req),
  });
  let body: { current?: SyncRunStatus | null; error?: string } | null = null;
  try {
    body = (await readJson(res)) as { current?: SyncRunStatus | null; error?: string };
  } catch {
    body = null;
  }
  return {
    ok: res.ok,
    status: res.status,
    run: body?.current ?? null,
    error: res.ok ? null : (body?.error ?? `HTTP ${res.status}`),
  };
}

// --- writer-owned config control plane client (Settings -> Sources editor) ---
// Same shape as the sync control client above: GET probes return null on any
// failure so the editor simply stays hidden, and mutations carry the shared
// same-origin guard header. Server-side validation is authoritative.

// Capability probe + current document. `enabled: false` (or null) hides the
// editor; `enabled: true` with `config: null` is the not-configured-yet state
// the first-run onboarding starts from.
export async function fetchConfigControl(serverBaseUrl: string | null = loadServerBaseUrl()): Promise<ConfigControlInfo | null> {
  try {
    const res = await appFetch(resolveEndpoint("./api/config", serverBaseUrl), { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await readJson(res)) as ConfigControlInfo | null;
    return body && typeof body.enabled === "boolean" ? body : null;
  } catch {
    return null;
  }
}

export interface SaveConfigResult {
  ok: boolean;
  status: number;
  errors: string[]; // the daemon's per-field validation messages on a 400 invalid_config
  error: string | null; // any other failure
}

export async function saveConfigDocument(config: ConfigDocument, serverBaseUrl: string | null = loadServerBaseUrl()): Promise<SaveConfigResult> {
  const res = await appFetch(resolveEndpoint("./api/config", serverBaseUrl), {
    method: "PUT",
    headers: { "Content-Type": "application/json", [SYNC_CONTROL_HEADER]: "1" },
    body: JSON.stringify(config),
  });
  let body: { error?: string; errors?: string[] } | null = null;
  try {
    body = (await readJson(res)) as { error?: string; errors?: string[] };
  } catch {
    body = null;
  }
  const errors = body?.errors ?? [];
  return {
    ok: res.ok,
    status: res.status,
    errors,
    error: res.ok || errors.length > 0 ? null : (body?.error ?? `HTTP ${res.status}`),
  };
}

// Which token env names are set (booleans only — values never cross this
// surface). Null on any failure, mirroring the capability probes.
export async function fetchSecrets(serverBaseUrl: string | null = loadServerBaseUrl()): Promise<SecretsInfo | null> {
  try {
    const res = await appFetch(resolveEndpoint("./api/secrets", serverBaseUrl), { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await readJson(res)) as SecretsInfo | null;
    return body && typeof body.enabled === "boolean" ? body : null;
  } catch {
    return null;
  }
}

export interface SaveSecretResult {
  ok: boolean;
  status: number;
  error: string | null;
}

// Write-only: set/replace a token for an env name, or remove it with null.
// The value rides in the request body once and is never echoed or stored.
export async function saveSecretValue(env: string, value: string | null, serverBaseUrl: string | null = loadServerBaseUrl()): Promise<SaveSecretResult> {
  const res = await appFetch(resolveEndpoint("./api/secrets", serverBaseUrl), {
    method: "PUT",
    headers: { "Content-Type": "application/json", [SYNC_CONTROL_HEADER]: "1" },
    body: JSON.stringify({ env, value }),
  });
  let body: { error?: string; message?: string } | null = null;
  try {
    body = (await readJson(res)) as { error?: string; message?: string };
  } catch {
    body = null;
  }
  return {
    ok: res.ok,
    status: res.status,
    error: res.ok ? null : (body?.message ?? body?.error ?? `HTTP ${res.status}`),
  };
}

// --- diagnostics client (the hidden #/debug page) ---
// Probe-pattern GETs like the control planes above: null on ANY failure (route
// missing, no store yet, network error) so the page renders "unavailable"
// instead of erroring — the common case for a static deploy.

export async function fetchStoreStats(serverBaseUrl: string | null = loadServerBaseUrl()): Promise<StoreStats | null> {
  try {
    const res = await appFetch(resolveEndpoint("./api/stats", serverBaseUrl), { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await readJson(res)) as StoreStats | null;
    return body && typeof body === "object" && typeof (body as { db?: unknown }).db === "object" ? body : null;
  } catch {
    return null;
  }
}

// The writer daemon's recent-log tail. `after` is the caller's last-seen seq
// (0 = full buffer), so the poll loop ships deltas, not the whole buffer.
export async function fetchDaemonLogs(after: number, serverBaseUrl: string | null = loadServerBaseUrl()): Promise<DaemonLogsInfo | null> {
  try {
    const path = after > 0 ? `./api/logs?after=${after}` : "./api/logs";
    const res = await appFetch(resolveEndpoint(path, serverBaseUrl), { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await readJson(res)) as DaemonLogsInfo | null;
    return body && typeof body.enabled === "boolean" ? body : null;
  } catch {
    return null;
  }
}

// --- live event stream (the #/live page) ---
// Snapshot GET that seeds the Live page and the Tauri polling fallback. Null on
// ANY failure (route missing, no receiver, network error) so the page reports
// "live unavailable" instead of erroring — mirrors the diagnostics probes. The
// browser path streams via EventSource against ./api/live directly (it cannot
// go through appFetch); only the snapshot uses this client.
export async function fetchLiveSnapshot(
  serverBaseUrl: string | null = loadServerBaseUrl(),
  limit?: number,
  sinceSeq?: number,
): Promise<LiveSnapshot | null> {
  try {
    const params = new URLSearchParams();
    if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
      params.set("limit", String(Math.trunc(limit)));
    }
    if (typeof sinceSeq === "number" && Number.isFinite(sinceSeq) && sinceSeq >= 0) {
      params.set("since", String(Math.trunc(sinceSeq)));
    }
    const query = params.toString();
    const path = query ? `./api/live-snapshot?${query}` : "./api/live-snapshot";
    const res = await appFetch(resolveEndpoint(path, serverBaseUrl), {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await readJson(res)) as LiveSnapshot | null;
    // Validate the snapshot shape the re-seed/poll paths rely on: a
    // `live-snapshot/1` schema string, an events array, and a finite max_seq
    // cursor. A wrong shape is treated as unavailable (null), mirroring the
    // other probe clients — the UI then renders "live unavailable" rather than
    // seeding from a bogus cursor.
    if (
      !body ||
      typeof body !== "object" ||
      typeof body.schema !== "string" ||
      !body.schema.startsWith("live-snapshot/1") ||
      !Array.isArray(body.events) ||
      typeof body.max_seq !== "number" ||
      !Number.isFinite(body.max_seq)
    ) {
      return null;
    }
    return body;
  } catch {
    return null;
  }
}

// Parse a contract the user dropped in via the file picker.
export function parseContract(text: string): ContractEnvelope {
  return parseContractWithMetadata(text).env;
}
