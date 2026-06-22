// Per-server, device-local cache of the last contract envelope. It lets a COLD
// start paint the last (stale) board the instant the app mounts — before the
// ~1.5MB gzip / ~15MB-decoded contract download resolves — then revalidate from
// the live server. The download (re-fetched every launch under `cache-control:
// no-store`) is the dominant cold-start cost on a phone; decode + JSON.parse are
// cheap. This cache takes that download OFF the first-paint critical path.
//
// Unlike the Live snapshot cache (live-cache.ts, ~300 stripped events that fit
// localStorage), the full contract is ~15MB decoded — far over the ~5MB
// localStorage quota — so it lives in IndexedDB, which has a much larger quota
// and stores structured-cloned objects (read-back needs no JSON.parse). The
// store is abstracted behind a tiny async KV so the pure load/save logic is
// unit-tested with an in-memory fake; the default impl is a no-op when no
// IndexedDB exists (SSR / node tests), so this is always a safe import.
//
// The cache is a DISPLAY accelerator only: the init fetch always re-loads the
// full contract and REPLACES the painted env wholesale, so a stale row the
// server no longer returns cannot linger. It is keyed by the active
// serverBaseUrl so switching servers never paints another server's board.
import { majorOf, SUPPORTED_MAJOR } from "./contract.ts";
import type { ContractEnvelope } from "@symphony-board/contract";

const CACHE_KEY = "symphony-board:contract-cache";
const DB_NAME = "symphony-board";
const STORE = "kv";

// Ignore a cache older than this so a long-dormant client never flashes a
// genuinely ancient board before the fresh fetch lands. The fetch revalidates
// immediately on every launch, so a generous window is safe; a week balances
// "instant repeat launches" against "do not surface week-old data as if live".
export const CONTRACT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Minimal async key/value store. The default impl wraps IndexedDB; tests inject
// an in-memory fake so the load/save logic runs without a browser.
export interface AsyncKV {
  get(key: string): Promise<unknown>;
  set(key: string, val: unknown): Promise<void>;
}

interface ContractCacheEntry {
  serverBaseUrl: string | null;
  cachedAt: number;
  env: ContractEnvelope;
}

// A stale contract is only safe to paint if its major matches what this build
// renders — a pre-upgrade 3.x entry must never paint into a v4 UI. Mirrors
// asContractEnvelope's shape check plus the supported-major gate.
function isSupportedContract(body: unknown): body is ContractEnvelope {
  if (!body || typeof body !== "object") return false;
  const b = body as { items?: unknown; contract_version?: unknown };
  if (!Array.isArray(b.items)) return false;
  if (typeof b.contract_version !== "string") return false;
  return majorOf(b.contract_version) === SUPPORTED_MAJOR;
}

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function getDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openDb().catch((err) => {
      // Let a later call retry rather than caching a rejected handle forever.
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

// IndexedDB-backed KV, or null when no IndexedDB exists (node tests / SSR) so
// callers degrade to "no cache" without a browser dependency.
function defaultKv(): AsyncKV | null {
  if (typeof indexedDB === "undefined") return null;
  return {
    async get(key) {
      const db = await getDb();
      return new Promise((resolve, reject) => {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    },
    async set(key, val) {
      const db = await getDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(val, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    },
  };
}

// Read the cached contract for `serverBaseUrl`, or null when absent, for a
// different server, expired, malformed, or an unsupported major. `kv`/`now` are
// injectable for tests; never throws.
export async function loadCachedContract(
  serverBaseUrl: string | null,
  opts: { kv?: AsyncKV; now?: number } = {},
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
  opts: { kv?: AsyncKV; now?: number } = {},
): Promise<void> {
  const kv = opts.kv ?? defaultKv();
  if (!kv) return;
  const now = opts.now ?? Date.now();
  try {
    const entry: ContractCacheEntry = { serverBaseUrl: serverBaseUrl ?? null, cachedAt: now, env };
    await kv.set(CACHE_KEY, entry);
  } catch {
    /* storage unavailable / over quota — the cache just won't persist this time */
  }
}
