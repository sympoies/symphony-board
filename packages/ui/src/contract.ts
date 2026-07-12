// Loading the contract (LAYER 3) for the UI to render. The UI is a pure
// CONSUMER: it reads the versioned JSON envelope and stays liberal in what it
// accepts (it does not re-validate — producers validate strictly; see
// docs/CONTRACT.md). Types come from @symphony-board/contract.

import type { ContractEnvelope, ActivityDailyDTO } from "@symphony-board/contract";
import type { TimeRange, SyncControlInfo, SyncRunStatus, SyncRunRequest, ConfigControlInfo, ConfigDocument, SecretsInfo, StoreStats, DaemonLogsInfo, TokenRateLimitsInfo, ServerCapabilities, LiveSnapshot, GraphNeighborhoodResponse } from "./model.ts";
import { appFetch } from "./runtime.ts";
import { currentClientKind, loadServerBaseUrl, requiresConfiguredServerBaseUrl, ANDROID_CLIENT_KIND } from "./viewconfig.ts";

// The major this UI understands. The contract versions independently; if a
// future emit bumps the MAJOR, the UI should branch (or warn) rather than
// silently mis-render. Minor/patch are backward compatible by contract rule.
export const SUPPORTED_MAJOR = 4;

export function majorOf(version: string): number {
  return Number(version.split(".")[0] ?? "0");
}

// Whether the blocking "Loading contract…" view should cover the app. Gated on
// "no content yet", NOT on `loading` alone: the per-server cache can paint a
// (stale) env on cold start while the background revalidation fetch keeps
// `loading` true for its whole duration — gating on `loading` alone then hid the
// cached board behind the overlay until the fetch resolved (the bug that made
// every cache backend look broken on Android). With content present, render the
// board and revalidate behind it. Pure + unit-tested so it can't regress.
export function contractLoadingViewVisible(loading: boolean, hasEnv: boolean): boolean {
  return loading && !hasEnv;
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

type EncodedBytesSource = "resource-timing" | "content-length" | "encoded-length-header" | "precompressed-content-length" | "precompressed-body";
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
  // The dynamic /api/range route advertises its exact compressed size via
  // X-Encoded-Length (see src/server/http.ts). Prefer it over Content-Length:
  // a decoded gzip body strips Content-Length, and this is the only encoded-size
  // signal that survives on the browser / Tauri-native paths that have no
  // Resource Timing for this route. The static /contract.json never sends it and
  // falls through to its Content-Length / precompressed-.gz probe path.
  const encodedHeader = parseByteHeader(headerValue(res, "x-encoded-length"));
  if (encodedHeader != null) {
    return {
      encodedBytes: encodedHeader,
      transferBytes: resourceTiming.transferBytes,
      contentEncoding,
      encodedBytesSource: "encoded-length-header",
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

// The minimal structural test for a contract envelope: an `items` array and a
// string `contract_version`. Exported as the single source of truth so callers
// that need a non-throwing shape check (e.g. the cold-start cache guard) cannot
// drift from what `asContractEnvelope` enforces.
export function isContractEnvelopeShape(body: unknown): body is ContractEnvelope {
  return (
    !!body &&
    typeof body === "object" &&
    Array.isArray((body as { items?: unknown }).items) &&
    typeof (body as { contract_version?: unknown }).contract_version === "string"
  );
}

function asContractEnvelope(body: unknown): ContractEnvelope {
  if (!isContractEnvelopeShape(body)) {
    throw new Error("not a symphony-board contract (missing contract_version / items)");
  }
  return body;
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
// Per-attempt ceiling for the whole fetch + body read. Sized for the mobile
// worst case: the contract is ~1.5MB gzip, and an Android client on a slow /
// relayed tailnet link transfers it at a fraction of LAN speed. At the old 30s
// ceiling that transfer could abort mid-body, and because an abort is transient
// the outer loop just re-fetched the full 1.5MB again — a "Loading contract…"
// retry storm that never settled (the smaller Live snapshot fit and succeeded,
// so Live worked while contract pages did not). 60s gives a slow-but-progressing
// download room to finish on the first attempt instead of looping. A healthy
// link still resolves in ~1s; this ceiling only matters when the link is slow.
export const CONTRACT_REQUEST_TIMEOUT_MS = 60_000;
// The Android thin client needs a far larger ceiling. The 60s above assumed the
// cost was a slow LINK; in practice the link is fine (the ~1.5MB gzip arrives in
// well under a second) and the time goes to CLIENT-SIDE work: gunzip to ~15MB,
// marshal that ~15MB body across the Tauri Android IPC bridge, then JSON.parse.
// On weak hardware (an e-ink tablet) that exceeds 60s, so the attempt aborts and
// the outer loop re-fetches forever — the "Loading contract…" / "Failed to fetch"
// retry storm. Desktop/web have no IPC hop and decode fast, so they keep 60s; the
// connect timeout still fails an unreachable server fast, so this larger ceiling
// only ever applies to a connected-but-slow-to-decode Android device.
export const CONTRACT_REQUEST_TIMEOUT_MS_ANDROID = 240_000;
export const CONTRACT_LOAD_RETRIES = 2;

// True for the Android thin client (case-insensitive, matching currentClientKind).
function isAndroidClient(clientKind: string | null): boolean {
  return clientKind?.toLowerCase() === ANDROID_CLIENT_KIND;
}

// Per-attempt contract-load ceiling for a client kind: the larger Android ceiling
// for the Android thin client, the shared default otherwise. Pure + exported so
// the routing is unit-testable without a Tauri/Android runtime.
export function contractRequestTimeoutMs(clientKind: string | null): number {
  return isAndroidClient(clientKind) ? CONTRACT_REQUEST_TIMEOUT_MS_ANDROID : CONTRACT_REQUEST_TIMEOUT_MS;
}
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

// --- Render-time load-error classification ----------------------------------
// By the time a load failure reaches the UI it is only a STRING: App stores
// `(err as Error).message` and drops the TaggedError `.status`/`.transient` tags
// the throwers above attach. So the degraded-data banner re-derives a coarse kind
// from the message TEXT to pick friendly copy. This is a best-effort heuristic
// over non-contractual third-party strings — browser fetch ("Failed to fetch" /
// "Load failed" / "NetworkError"), Tauri plugin-http / reqwest ("error sending
// request for url (…)"), and abort/timeout wording all differ and can drift. Only
// the `HTTP <n>` template WE emit below (loadContractAttempt) is authoritative;
// every other match is a fuzzy `contains` that FAILS SAFE to a generic banner.
// The raw message is shown only behind a details disclosure, never inline — so a
// miss degrades to "unknown" (friendly copy), it never re-leaks the URL.
export type ContractLoadErrorKind = "offline" | "unreachable" | "server" | "client" | "malformed" | "unknown";

// SyntaxError text from a fully-received but non-JSON body (wording varies by engine).
const MALFORMED_LOAD_MESSAGE = /unexpected token|unexpected end of (json|input)|in json|is not valid json|json\.parse|json parse error/i;
// Transport / abort / timeout throws (no HTTP status reached): reqwest "error
// sending request", Chromium "Failed to fetch", WebKit "Load failed", Firefox
// "NetworkError", and AbortSignal.timeout / AbortController-fallback messages.
const TRANSPORT_LOAD_MESSAGE = /error sending request|failed to fetch|load failed|network ?error|aborted|abort|timed out|timeout|operation was aborted|signal is aborted/i;

// Map a caught load-error message to a coarse kind for the inline banner. The
// optional `online` flag (default true) keeps existing callers unchanged; a caller
// that knows the device is offline passes `false` so a transport failure reads as
// "offline" rather than "unreachable". HTTP-status and malformed-body outcomes
// IGNORE `online` — a real response proves the server was reached. Pure + total.
export function classifyContractLoadError(message: string | null | undefined, online = true): ContractLoadErrorKind {
  const m = (message ?? "").trim();
  if (!m) return "unknown";
  // (1) The one string we own — authoritative HTTP status split (5xx vs 4xx).
  const http = /HTTP (\d{3})/.exec(m);
  if (http) return Number(http[1]) >= 500 ? "server" : "client";
  // (2) Received-but-unparseable body. Checked before transport so an aborted
  //     mid-body read (transport) is not mistaken for a content error.
  if (MALFORMED_LOAD_MESSAGE.test(m)) return "malformed";
  // (3) Transport throw with no status. Offline device wins the copy when known.
  if (TRANSPORT_LOAD_MESSAGE.test(m)) return online ? "unreachable" : "offline";
  // (4) Unrecognized — generic friendly fallback, never an inline raw dump.
  return "unknown";
}

// User-facing English banner copy per kind. `{freshness}` is substituted at render
// with the cache age (relativeTime(env.generated_at)). Keep every string English.
export const contractLoadErrorCopy: Record<ContractLoadErrorKind, string> = {
  offline: "You're offline — showing cached data from {freshness}.",
  unreachable: "Can't reach Symphony Board — showing cached data from {freshness}.",
  server: "Symphony Board hit an error — showing cached data from {freshness}.",
  client: "Couldn't load this range — showing cached data from {freshness}.",
  malformed: "Got an unreadable response — showing cached data from {freshness}.",
  unknown: "Can't reach Symphony Board — showing cached data from {freshness}.",
};

// Resolve a banner headline for a kind, substituting the cache-age phrase.
export function formatContractLoadError(kind: ContractLoadErrorKind, freshness: string): string {
  return contractLoadErrorCopy[kind].replace("{freshness}", freshness);
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
  const requestTimeoutMs = opts.requestTimeoutMs ?? contractRequestTimeoutMs(clientKind);
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
  return (await fetchRangeContractWithMetadata(range, serverBaseUrl, opts)).env;
}

// The metadata-carrying range fetch. A mobile client whose board-scope is a time
// window loads this AS its primary contract (instead of ./contract.json), so it
// needs the same LoadedContract shape (env + load metadata for Diagnostics) the
// full loader returns. Reuses the same resilient loader (timeouts/retries), so
// the Android per-attempt ceiling applies here too.
export async function fetchRangeContractWithMetadata(range: TimeRange, serverBaseUrl: string | null = loadServerBaseUrl(), opts: ContractLoadOptions = {}): Promise<LoadedContract> {
  const params = new URLSearchParams({ from: range.from, to: range.to });
  return fetchContractWithMetadata(`./api/range?${params.toString()}`, serverBaseUrl, currentClientKind(), opts);
}

function isGraphNeighborhood(body: unknown): body is GraphNeighborhoodResponse {
  if (!body || typeof body !== "object") return false;
  const value = body as Partial<GraphNeighborhoodResponse>;
  const limitReasons = new Set(["depth", "nodes", "edges"]);
  const limits = value.limits as Partial<GraphNeighborhoodResponse["limits"]> | undefined;
  const counts = value.counts as Partial<GraphNeighborhoodResponse["counts"]> | undefined;
  return (
    value.schema === "symphony-board-graph-neighborhood/1" &&
    typeof value.generated_at === "string" &&
    typeof value.focus_ref === "string" &&
    Number.isInteger(value.requested_depth) &&
    Number.isInteger(value.reached_depth) &&
    typeof value.complete === "boolean" &&
    Array.isArray(value.limit_reasons) && value.limit_reasons.every((reason) => limitReasons.has(reason)) &&
    !!limits && Number.isInteger(limits.max_depth) && Number.isInteger(limits.max_nodes) && Number.isInteger(limits.max_edges) &&
    !!counts && Number.isInteger(counts.nodes) && Number.isInteger(counts.edges) &&
    Array.isArray(value.nodes) && value.nodes.every((node) =>
      !!node && typeof node === "object" && typeof node.ref === "string" && Number.isInteger(node.hop) &&
      (node.item === null || (!!node.item && typeof node.item.id === "string" && typeof node.item.source_id === "string" && typeof node.item.project_path === "string")),
    ) &&
    Array.isArray(value.edges) && value.edges.every((edge) =>
      !!edge && typeof edge === "object" && typeof edge.type === "string" && typeof edge.from === "string" && typeof edge.to === "string",
    ) &&
    counts.nodes === value.nodes.length && counts.edges === value.edges.length
  );
}

export async function fetchGraphNeighborhood(
  focusRef: string,
  depth: number,
  serverBaseUrl: string | null = loadServerBaseUrl(),
  signal?: AbortSignal,
): Promise<GraphNeighborhoodResponse> {
  const params = new URLSearchParams({ ref: focusRef, depth: String(depth) });
  const target = resolveEndpoint(`./api/graph-neighborhood?${params.toString()}`, serverBaseUrl);
  const res = await appFetch(target, { cache: "no-store", signal });
  if (!res.ok) throw new Error(`graph neighborhood: HTTP ${res.status}`);
  const body = await readJson(res);
  if (!isGraphNeighborhood(body) || body.focus_ref !== focusRef || body.requested_depth !== depth) {
    throw new Error("graph neighborhood: invalid response");
  }
  return body;
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

// Validate a PAT against the configured source before it is persisted. The token
// value is sent once for the provider probe and is never returned by the server.
export async function validateSecretValue(
  sourceId: string,
  env: string,
  value: string,
  serverBaseUrl: string | null = loadServerBaseUrl(),
): Promise<SaveSecretResult> {
  const res = await appFetch(resolveEndpoint("./api/secrets/validate", serverBaseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", [SYNC_CONTROL_HEADER]: "1" },
    body: JSON.stringify({ source_id: sourceId, env, value }),
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

// The full-history activity_daily aggregate, served independently of the board
// window. The Activity Overview is fixed to the trailing 12 months, but a windowed
// Board data scope loads a /api/range projection as the primary env, whose
// activity_daily covers only that window. This probe fetches the full aggregate so
// the overview stays a true 12 months; null on ANY failure (route missing on a
// pure-static deploy, no server, network error, pre-4.0.0 contract) so the caller
// falls back to the primary env's own activity_daily — the prior behavior.
export async function fetchActivityDaily(serverBaseUrl: string | null = loadServerBaseUrl()): Promise<ActivityDailyDTO | null> {
  try {
    const res = await appFetch(resolveEndpoint("./api/activity-daily", serverBaseUrl), { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await readJson(res)) as { activity_daily?: ActivityDailyDTO | null } | null;
    const daily = body?.activity_daily ?? null;
    return daily && typeof daily === "object" && Array.isArray(daily.days) && typeof daily.total === "number" ? daily : null;
  } catch {
    return null;
  }
}

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

// On-demand GitHub GraphQL rate-limit probe. null on ANY failure (route missing
// on this deployment, or network error) so the tab renders "unavailable" rather
// than erroring — the same probe discipline as the store/log surfaces above.
export async function fetchTokenRateLimits(serverBaseUrl: string | null = loadServerBaseUrl()): Promise<TokenRateLimitsInfo | null> {
  try {
    const res = await appFetch(resolveEndpoint("./api/token-rate-limits", serverBaseUrl), { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await readJson(res)) as TokenRateLimitsInfo | null;
    return body && Array.isArray((body as { tokens?: unknown }).tokens) ? body : null;
  } catch {
    return null;
  }
}

function isCapabilitiesStatus(value: unknown): value is ServerCapabilities["live"]["status"] {
  return value === "unsupported" || value === "unreachable" || value === "empty" || value === "ready";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isCapabilitiesWebhookSetup(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object") return false;
  const setup = value as { provider?: unknown; public_url?: unknown; events?: unknown };
  return isOptionalString(setup.provider) && isOptionalString(setup.public_url) && (setup.events === undefined || isStringArray(setup.events));
}

export function isServerCapabilities(body: unknown): body is ServerCapabilities {
  if (!body || typeof body !== "object") return false;
  const record = body as Partial<ServerCapabilities>;
  if (record.schema !== "symphony-board-capabilities/1") return false;
  if (!record.server || typeof record.server !== "object") return false;
  const live = record.live;
  if (!live || typeof live !== "object") return false;
  if (typeof live.reads !== "boolean") return false;
  if (live.status !== undefined && !isCapabilitiesStatus(live.status)) return false;
  if (live.latest_seq !== undefined && live.latest_seq !== null && typeof live.latest_seq !== "number") return false;
  if (live.allowlist) {
    if (typeof live.allowlist !== "object") return false;
    if (typeof live.allowlist.enabled !== "boolean" || typeof live.allowlist.count !== "number") return false;
  }
  if (live.transport !== undefined && !Array.isArray(live.transport)) return false;
  if (live.provider_webhooks !== undefined && !Array.isArray(live.provider_webhooks)) return false;
  if (!isCapabilitiesWebhookSetup(live.webhook_setup)) return false;
  return true;
}

export const CAPABILITIES_CONNECT_TIMEOUT_MS = 5_000;
export const CAPABILITIES_REQUEST_TIMEOUT_MS = 8_000;

export interface CapabilitiesFetchOptions {
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
}

export async function fetchCapabilities(
  serverBaseUrl: string | null = loadServerBaseUrl(),
  opts: CapabilitiesFetchOptions = {},
): Promise<ServerCapabilities | null> {
  const signal = createAttemptTimeoutSignal(opts.requestTimeoutMs ?? CAPABILITIES_REQUEST_TIMEOUT_MS);
  try {
    const res = await appFetch(resolveEndpoint("./api/capabilities", serverBaseUrl), {
      cache: "no-store",
      signal,
      connectTimeout: opts.connectTimeoutMs ?? CAPABILITIES_CONNECT_TIMEOUT_MS,
    });
    if (!res.ok) return null;
    const body = await readJson(res);
    return isServerCapabilities(body) ? body : null;
  } catch {
    return null;
  }
}

// --- live event stream (the #/live page) ---

// Bounded timeouts + a small classified retry for the snapshot probe. Unlike the
// contract loader these are SHORT: the snapshot is a small JSON probe whose only
// caller that wants patience is the one-shot cold-start seed; the 3s poll loop is
// its own retry, so the steady-state poll passes `retries: 0`.
export const LIVE_SNAPSHOT_CONNECT_TIMEOUT_MS = 5_000;
export const LIVE_SNAPSHOT_REQUEST_TIMEOUT_MS = 12_000;
// The Android thin client needs a larger snapshot ceiling for the same reason as
// the contract (see CONTRACT_REQUEST_TIMEOUT_MS_ANDROID): the cold-start seed is
// ~4.8MB decoded, and the gunzip + Tauri IPC marshal + JSON.parse can exceed 12s
// on weak e-ink hardware, leaving Live stuck "Connecting…" and re-probing forever.
// Desktop/web decode fast and keep 12s.
export const LIVE_SNAPSHOT_REQUEST_TIMEOUT_MS_ANDROID = 60_000;
// Per-attempt live-snapshot ceiling for a client kind (see contractRequestTimeoutMs).
export function liveSnapshotRequestTimeoutMs(clientKind: string | null): number {
  return isAndroidClient(clientKind) ? LIVE_SNAPSHOT_REQUEST_TIMEOUT_MS_ANDROID : LIVE_SNAPSHOT_REQUEST_TIMEOUT_MS;
}
export const LIVE_SNAPSHOT_PROBE_RETRIES = 2;
export const LIVE_SNAPSHOT_RETRY_BASE_MS = 500;
const LIVE_SNAPSHOT_RETRY_MAX_MS = 4_000;

export interface LiveSnapshotFetchOptions {
  retries?: number; // extra attempts after the first, only on a TRANSIENT failure
  retryBaseDelayMs?: number;
  requestTimeoutMs?: number; // per-attempt overall ceiling (browser + desktop)
  connectTimeoutMs?: number; // per-attempt connect bound (desktop only)
  sleep?: (ms: number) => Promise<void>; // injectable for tests
}

// Validate the snapshot shape the seed/poll/reset paths and the local cache rely
// on: a `live-snapshot/1` schema string, an events array, and a finite max_seq
// cursor. A wrong shape is treated as unavailable, mirroring the other probe
// clients — the UI then renders "live unavailable" rather than seeding from a
// bogus cursor. Exported so the offline cache validates the same shape.
export function isLiveSnapshot(body: unknown): body is LiveSnapshot {
  return (
    !!body &&
    typeof body === "object" &&
    typeof (body as LiveSnapshot).schema === "string" &&
    (body as LiveSnapshot).schema.startsWith("live-snapshot/1") &&
    Array.isArray((body as LiveSnapshot).events) &&
    typeof (body as LiveSnapshot).max_seq === "number" &&
    Number.isFinite((body as LiveSnapshot).max_seq)
  );
}

// One bounded snapshot attempt. Returns the snapshot on success, or null tagged
// with whether the failure is worth a retry: a thrown fetch (network error /
// abort from the per-attempt timeout) and a 5xx are TRANSIENT; a 4xx (no receiver
// on this deploy) and a 200 whose body is not a snapshot are DEFINITIVE.
async function fetchLiveSnapshotAttempt(
  target: string,
  requestTimeoutMs: number,
  connectTimeoutMs: number,
): Promise<{ snapshot: LiveSnapshot | null; transient: boolean }> {
  const signal = createAttemptTimeoutSignal(requestTimeoutMs);
  let res: Response;
  try {
    res = await appFetch(target, { cache: "no-store", signal, connectTimeout: connectTimeoutMs });
  } catch {
    return { snapshot: null, transient: true };
  }
  if (!res.ok) return { snapshot: null, transient: res.status >= 500 };
  let body: unknown;
  try {
    body = await readJson(res);
  } catch (err) {
    // An interrupted body read is transient: the per-attempt timeout fired
    // (signal.aborted), OR the connection dropped mid-body before that abort —
    // which throws a non-SyntaxError (e.g. a TypeError) with signal.aborted still
    // false. Only a SyntaxError on a fully-received body is a definitive content
    // error and not worth retrying. Mirrors loadContractAttempt so a dropped
    // cold-link body read keeps retrying instead of bouncing a live deploy.
    return { snapshot: null, transient: signal.aborted || !(err instanceof SyntaxError) };
  }
  return isLiveSnapshot(body) ? { snapshot: body, transient: false } : { snapshot: null, transient: false };
}

export interface LiveSnapshotFetchResult {
  snapshot: LiveSnapshot | null;
  // When `snapshot` is null: true if the LAST attempt failed transiently
  // (network / abort / 5xx) and is worth retrying; false if it failed
  // definitively (4xx — no receiver on this deploy — or a wrong-shape body).
  // The cold-start seed uses this to keep "Connecting…" + retry on a transient
  // failure rather than resolving to "unavailable" and bouncing off a Live deploy.
  transientFailure: boolean;
}

// Snapshot GET that seeds the Live page and the Tauri polling fallback, returning
// the snapshot AND why it failed. The browser path streams via EventSource against
// ./api/live directly (it cannot go through appFetch); only the snapshot uses this
// client. The per-attempt timeout is the key cold-start fix: an unbounded request
// hung for ~a minute on a cold link and left the Live page stuck on "Connecting…";
// now it aborts and (for the patient one-shot probe) retries on a transient
// failure instead of stranding.
export async function fetchLiveSnapshotResult(
  serverBaseUrl: string | null = loadServerBaseUrl(),
  limit?: number,
  sinceSeq?: number,
  opts: LiveSnapshotFetchOptions = {},
): Promise<LiveSnapshotFetchResult> {
  const requestTimeoutMs = opts.requestTimeoutMs ?? liveSnapshotRequestTimeoutMs(currentClientKind());
  const connectTimeoutMs = opts.connectTimeoutMs ?? LIVE_SNAPSHOT_CONNECT_TIMEOUT_MS;
  const retries = Math.max(0, opts.retries ?? 0);
  const retryBaseDelayMs = opts.retryBaseDelayMs ?? LIVE_SNAPSHOT_RETRY_BASE_MS;
  const sleep = opts.sleep ?? defaultSleep;

  const params = new URLSearchParams();
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) {
    params.set("limit", String(Math.trunc(limit)));
  }
  if (typeof sinceSeq === "number" && Number.isFinite(sinceSeq) && sinceSeq >= 0) {
    params.set("since", String(Math.trunc(sinceSeq)));
  }
  const query = params.toString();
  const path = query ? `./api/live-snapshot?${query}` : "./api/live-snapshot";
  const target = resolveEndpoint(path, serverBaseUrl);

  for (let attempt = 0; ; attempt++) {
    const { snapshot, transient } = await fetchLiveSnapshotAttempt(target, requestTimeoutMs, connectTimeoutMs);
    if (snapshot !== null) return { snapshot, transientFailure: false };
    if (!transient || attempt >= retries) return { snapshot: null, transientFailure: transient };
    await sleep(Math.min(retryBaseDelayMs * 2 ** attempt, LIVE_SNAPSHOT_RETRY_MAX_MS));
  }
}

// Snapshot-or-null convenience wrapper for callers that don't need the failure
// classification (the SSE reset refetch, tests).
export async function fetchLiveSnapshot(
  serverBaseUrl: string | null = loadServerBaseUrl(),
  limit?: number,
  sinceSeq?: number,
  opts: LiveSnapshotFetchOptions = {},
): Promise<LiveSnapshot | null> {
  return (await fetchLiveSnapshotResult(serverBaseUrl, limit, sinceSeq, opts)).snapshot;
}

// Parse a contract the user dropped in via the file picker.
export function parseContract(text: string): ContractEnvelope {
  return parseContractWithMetadata(text).env;
}
