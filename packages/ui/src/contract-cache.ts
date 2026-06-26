// Per-server, device-local cache of the last contract envelope. It lets a COLD
// start paint the last (stale) board the instant the app mounts — before the
// ~1.5MB gzip / ~15MB-decoded contract download resolves — then revalidate from
// the live server. The download (re-fetched every launch under `cache-control:
// no-store`) is the dominant cold-start cost on a phone; decode + JSON.parse are
// cheap. This cache takes that download OFF the first-paint critical path.
//
// The backend differs by client because the Tauri Android WebView's built-in
// storage is unreliable for a payload this size: it does NOT persist IndexedDB
// across app restarts, and it silently drops a ~1.5MB localStorage value (the
// quota is too small) — yet it persists SMALL localStorage (the server URL /
// theme survive a force-quit). So the Android client writes to the native
// filesystem (AppLocalData, no quota); desktop and web WebViews persist
// localStorage fine, so they keep it, gzip-compressed (a 15MB contract -> ~1.5MB,
// stored as a latin1 byte string). The store is abstracted behind a tiny async
// KV so the pure load/save logic is unit-tested with an in-memory fake, and the
// FS plugin is imported lazily; the default backend is null when none is usable
// (SSR / some node tests), so this is always a safe import.
//
// The cache is a DISPLAY accelerator only: the init fetch always re-loads the
// full contract and REPLACES the painted env wholesale, so a stale row the
// server no longer returns cannot linger. It is keyed by the active
// serverBaseUrl so switching servers never paints another server's board.
import { gzipSync, gunzipSync, strToU8, strFromU8 } from "fflate";
import { majorOf, SUPPORTED_MAJOR, isContractEnvelopeShape } from "./contract.ts";
import { currentClientKind, ANDROID_CLIENT_KIND } from "./viewconfig.ts";
import type { ContractEnvelope } from "@symphony-board/contract";

const CACHE_KEY = "symphony-board:contract-cache";
// AppLocalData filename for the native-FS backend (Android). A flat filename, not
// the colon-bearing CACHE_KEY, so it is a valid path on every platform.
const CACHE_FILE = "contract-cache.json";

// Ignore a cache older than this so a long-dormant client never flashes a
// genuinely ancient board before the fresh fetch lands. The fetch revalidates
// immediately on every launch, so a generous window is safe; a week balances
// "instant repeat launches" against "do not surface week-old data as if live".
export const CONTRACT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Minimal async key/value store. The default impl wraps localStorage (gzip-
// compressed); tests inject an in-memory fake so the load/save logic runs
// without a browser.
export interface AsyncKV {
  get(key: string): Promise<unknown>;
  set(key: string, val: unknown): Promise<void>;
}

interface ContractCacheEntry {
  serverBaseUrl: string | null;
  cachedAt: number;
  // The date range this env was loaded for (#488: the selected range is the
  // primary download, so a cached full/this-week env must NOT paint when the user
  // is now opening a different range — it would flash the wrong window). null for
  // a range-agnostic entry (legacy / callers that pass no range). Compared by
  // value, so a revisit on the same landing range still paints instantly.
  range?: { from: string; to: string } | null;
  env: ContractEnvelope;
}

function sameRangeKey(a: { from: string; to: string } | null | undefined, b: { from: string; to: string } | null | undefined): boolean {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null || y === null) return x === y;
  return x.from === y.from && x.to === y.to;
}

// A stale contract is only safe to paint if its major matches what this build
// renders — a pre-upgrade 3.x entry must never paint into a v4 UI. Reuses the
// shared envelope shape predicate so it can't drift from asContractEnvelope.
function isSupportedContract(body: unknown): body is ContractEnvelope {
  return isContractEnvelopeShape(body) && majorOf(body.contract_version) === SUPPORTED_MAJOR;
}

// Cold-start merge rule: keep the current env if a fetch already resolved one
// (it is authoritative and must not be clobbered by the slower cache read),
// otherwise paint the cached one. Pure + unit-tested so the anti-clobber
// guarantee can't silently regress to a plain `setEnv(cached)`.
export function pickColdStartEnv(
  current: ContractEnvelope | null,
  cached: ContractEnvelope,
): ContractEnvelope {
  return current ?? cached;
}

// Which storage backend the default cache uses. The Android WebView does not
// reliably persist IndexedDB and silently drops a ~1.5MB localStorage value, so
// the Android client writes to the native filesystem instead (no quota, survives
// a force-quit). Desktop and web WebViews persist localStorage fine, so they keep
// it (gzipped). Pure + exported so the routing decision is unit-tested without a
// Tauri/Android runtime.
export function selectCacheBackend(
  clientKind: string | null,
  hasLocalStorage: boolean,
): "fs" | "localStorage" | "none" {
  // Case-insensitive so a stray-cased VITE_SYMPHONY_BOARD_CLIENT can't silently
  // route the Android client to the localStorage backend this fix exists to
  // avoid (currentClientKind already lowercases — don't depend on it staying so).
  if (clientKind?.toLowerCase() === ANDROID_CLIENT_KIND) return "fs";
  if (hasLocalStorage) return "localStorage";
  return "none";
}

// localStorage-backed KV. The value is gzipped (a 15MB contract -> ~1.5MB) and
// stored as a latin1 byte string so it fits the quota without base64's 33%
// overhead. A get on a corrupt or legacy entry throws out of gunzip/JSON.parse
// and is caught by the caller (treated as a miss), so a bad entry can never
// strand the loader.
function localStorageGzipKv(): AsyncKV {
  return {
    async get(key) {
      const stored = localStorage.getItem(key);
      if (stored == null) return undefined;
      return JSON.parse(strFromU8(gunzipSync(strToU8(stored, true))));
    },
    async set(key, val) {
      const gz = gzipSync(strToU8(JSON.stringify(val)));
      localStorage.setItem(key, strFromU8(gz, true));
    },
  };
}

// Native-filesystem KV (Android only), writing one JSON file under AppLocalData.
// Stores RAW JSON (unlike localStorageGzipKv) because the native FS has no quota,
// so the gzip needed to fit the localStorage limit is unnecessary here. The
// plugin is imported lazily so the module stays a safe import on web / in tests;
// this is gated by selectCacheBackend on the "android" client kind, which only
// ships inside the Tauri Android shell where tauri-plugin-fs is wired (Cargo +
// lib.rs + capability) — a mismatch would reject the import, which the callers
// swallow as a miss rather than crash. This is a SINGLE-ENTRY store: it ignores
// the KV key and always uses CACHE_FILE (the module persists exactly one entry;
// per-server discrimination is the serverBaseUrl field inside the entry). A read
// of a missing file resolves to undefined; a corrupt file throws into the
// caller's catch (a miss).
function tauriFsKv(): AsyncKV {
  return {
    async get() {
      const { readTextFile, exists, BaseDirectory } = await import("@tauri-apps/plugin-fs");
      if (!(await exists(CACHE_FILE, { baseDir: BaseDirectory.AppLocalData }))) return undefined;
      return JSON.parse(await readTextFile(CACHE_FILE, { baseDir: BaseDirectory.AppLocalData }));
    },
    async set(_key, val) {
      const { writeTextFile, BaseDirectory } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(CACHE_FILE, JSON.stringify(val), { baseDir: BaseDirectory.AppLocalData });
    },
  };
}

// The default backend for this runtime, or null when none is usable (SSR / some
// node tests) so callers degrade to "no cache".
function defaultKv(): AsyncKV | null {
  const backend = selectCacheBackend(currentClientKind(), typeof localStorage !== "undefined");
  if (backend === "fs") return tauriFsKv();
  if (backend === "localStorage") return localStorageGzipKv();
  return null;
}

// Read the cached contract for `serverBaseUrl`, or null when absent, for a
// different server, expired, malformed, or an unsupported major. `kv`/`now` are
// injectable for tests; never throws.
export async function loadCachedContract(
  serverBaseUrl: string | null,
  opts: { kv?: AsyncKV; now?: number; range?: { from: string; to: string } | null } = {},
): Promise<ContractEnvelope | null> {
  const kv = opts.kv ?? defaultKv();
  if (!kv) return null;
  const now = opts.now ?? Date.now();
  try {
    const raw = await kv.get(CACHE_KEY);
    if (!raw || typeof raw !== "object") return null;
    const entry = raw as ContractCacheEntry;
    if ((entry.serverBaseUrl ?? null) !== (serverBaseUrl ?? null)) return null;
    if (typeof entry.cachedAt !== "number" || !Number.isFinite(entry.cachedAt)) return null;
    if (now - entry.cachedAt > CONTRACT_CACHE_TTL_MS) return null;
    // Only paint a cached env loaded for the SAME range we are about to load,
    // so a different landing range never flashes the wrong window first (#488).
    if (!sameRangeKey(entry.range, opts.range)) return null;
    return isSupportedContract(entry.env) ? entry.env : null;
  } catch {
    return null;
  }
}

// Persist the freshly-loaded contract as the cache for `serverBaseUrl`. Silent
// on any failure (storage unavailable / over quota) — the cache is a best-effort
// accelerator, never a correctness dependency. `kv`/`now` are injectable.
export async function saveCachedContract(
  serverBaseUrl: string | null,
  env: ContractEnvelope,
  opts: { kv?: AsyncKV; now?: number; range?: { from: string; to: string } | null } = {},
): Promise<void> {
  const kv = opts.kv ?? defaultKv();
  if (!kv) return;
  const now = opts.now ?? Date.now();
  try {
    const entry: ContractCacheEntry = { serverBaseUrl: serverBaseUrl ?? null, cachedAt: now, range: opts.range ?? null, env };
    await kv.set(CACHE_KEY, entry);
  } catch {
    /* storage unavailable / over quota — the cache just won't persist this time */
  }
}
