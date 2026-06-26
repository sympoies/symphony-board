// The contract cache lets a COLD start paint the last (stale) board instantly,
// before the ~1.5MB gzip contract download resolves, then revalidate. The 15MB
// decoded envelope is far over the localStorage quota, so the default backend
// stores it gzip-compressed (~1.5MB) in localStorage. Most cases drive the pure
// load/save logic against an injected in-memory async KV (the "test the logic,
// not the browser" convention the live-cache suite uses); one case shims
// localStorage to exercise the real default backend end to end. The module must
// also degrade to "no cache" when no store is available.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadCachedContract,
  saveCachedContract,
  pickColdStartEnv,
  selectCacheBackend,
  CONTRACT_CACHE_TTL_MS,
  type AsyncKV,
} from "../src/contract-cache.ts";
import type { ContractEnvelope } from "@symphony-board/contract";

class FakeKV implements AsyncKV {
  m = new Map<string, unknown>();
  async get(k: string): Promise<unknown> {
    return this.m.has(k) ? this.m.get(k) : undefined;
  }
  async set(k: string, v: unknown): Promise<void> {
    this.m.set(k, v);
  }
  _raw(k: string, v: unknown): void {
    this.m.set(k, v);
  }
  _keys(): string[] {
    return [...this.m.keys()];
  }
}

// In-memory Storage shim: node has no localStorage, but the DEFAULT cache
// backend persists to it (gzip-compressed). Lets us exercise the real
// compress -> store -> decompress -> parse path without a browser.
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

// A minimal but shape-valid contract: asContractEnvelope only requires an
// `items` array and a string `contract_version`; the cache additionally checks
// the major matches SUPPORTED_MAJOR (4).
function env(contractVersion = "4.2.0", extra: Partial<ContractEnvelope> = {}): ContractEnvelope {
  return {
    contract_version: contractVersion,
    items: [{ id: "github:1" }],
    ...extra,
  } as unknown as ContractEnvelope;
}

test("a contract round-trips for the matching server within TTL", async () => {
  const kv = new FakeKV();
  const now = 1_000_000;
  await saveCachedContract("https://srv", env("4.2.0"), { kv, now });
  const got = await loadCachedContract("https://srv", { kv, now: now + 1_000 });
  assert.ok(got, "the cache returns the contract within TTL");
  assert.equal(got.contract_version, "4.2.0");
  assert.equal(got.items.length, 1);
});

test("the cache is per-server: a different server reads nothing", async () => {
  const kv = new FakeKV();
  const now = 1_000_000;
  await saveCachedContract("https://srv-a", env(), { kv, now });
  assert.equal(await loadCachedContract("https://srv-b", { kv, now }), null);
});

test("the cache is keyed by range: a different landing range reads nothing (#488)", async () => {
  // Under range-as-download the cached env is for a specific window; painting it
  // when the user is opening a DIFFERENT range would flash the wrong window, so a
  // mismatch reads as a miss. The same range round-trips; a no-range request also
  // misses a range-tagged entry.
  const kv = new FakeKV();
  const now = 1_000_000;
  const r1 = { from: "2026-06-20", to: "2026-06-26" };
  const r2 = { from: "2026-01-01", to: "2026-06-26" };
  await saveCachedContract("https://srv", env("4.2.0"), { kv, now, range: r1 });
  assert.ok(await loadCachedContract("https://srv", { kv, now, range: r1 }), "same range hits");
  assert.equal(await loadCachedContract("https://srv", { kv, now, range: r2 }), null, "other range misses");
  assert.equal(await loadCachedContract("https://srv", { kv, now }), null, "no-range request misses a range-tagged entry");
});

test("a contract older than the TTL is ignored", async () => {
  const kv = new FakeKV();
  const now = 1_000_000;
  await saveCachedContract("https://srv", env(), { kv, now });
  const got = await loadCachedContract("https://srv", { kv, now: now + CONTRACT_CACHE_TTL_MS + 1 });
  assert.equal(got, null, "an expired entry is not painted");
});

test("an entry exactly at the TTL boundary is still valid", async () => {
  const kv = new FakeKV();
  const now = 1_000_000;
  await saveCachedContract("https://srv", env(), { kv, now });
  // The comparator is `age > TTL`, so age === TTL is still fresh; pin it so a
  // `>` -> `>=` refactor can't silently expire the boundary a tick early.
  const got = await loadCachedContract("https://srv", { kv, now: now + CONTRACT_CACHE_TTL_MS });
  assert.ok(got, "an entry at exactly the TTL boundary is still painted");
});

test("a non-finite cachedAt is rejected, not treated as fresh", async () => {
  const kv = new FakeKV();
  const now = 1_000_000;
  // A NaN cachedAt would make `now - NaN > TTL` evaluate false and wrongly pass
  // without the explicit finite guard.
  kv._raw(kv._keys()[0] ?? "symphony-board:contract-cache", { serverBaseUrl: "https://srv", cachedAt: NaN, env: env() });
  assert.equal(await loadCachedContract("https://srv", { kv, now }), null);
});

test("the file-mode (null server) entry round-trips and never collides with a server entry", async () => {
  const kv = new FakeKV();
  const now = 1_000_000;
  // The bundled `./contract.json` desktop/standalone deployment keys on a null
  // serverBaseUrl — assert it round-trips and does not bleed across the null/string boundary.
  await saveCachedContract(null, env("4.2.0"), { kv, now });
  const got = await loadCachedContract(null, { kv, now });
  assert.ok(got, "a null-keyed contract round-trips for a null-keyed load");
  assert.equal(got.contract_version, "4.2.0");
  assert.equal(await loadCachedContract("https://srv", { kv, now }), null, "a server load must not read the file-mode entry");
});

test("a cached contract from an unsupported major is rejected", async () => {
  const kv = new FakeKV();
  const now = 1_000_000;
  // A 3.x contract cached before an app upgrade must never paint into a v4 UI.
  await saveCachedContract("https://srv", env("3.9.0"), { kv, now });
  assert.equal(await loadCachedContract("https://srv", { kv, now }), null);
});

test("a malformed cached entry is ignored, not thrown", async () => {
  const kv = new FakeKV();
  const now = 1_000_000;
  await saveCachedContract("https://srv", env(), { kv, now });
  // Corrupt the stored envelope (missing items / wrong shape).
  kv._raw(kv._keys()[0], { serverBaseUrl: "https://srv", cachedAt: now, env: { nope: true } });
  assert.equal(await loadCachedContract("https://srv", { kv, now }), null);
});

test("load returns null and save is a no-op when no store is available", async () => {
  // No kv injected and node has no global localStorage: the cache must degrade
  // to "no cache" silently rather than throw.
  assert.equal(await loadCachedContract("https://srv", { now: 1 }), null);
  await assert.doesNotReject(saveCachedContract("https://srv", env(), { now: 1 }));
});

test("save never throws even when the underlying store rejects", async () => {
  // The cache is a best-effort accelerator: a rejecting set() (over quota /
  // storage error) must be swallowed, never surfaced to the caller.
  const failingKv: AsyncKV = {
    async get() {
      return undefined;
    },
    async set() {
      throw new Error("QuotaExceededError");
    },
  };
  await assert.doesNotReject(saveCachedContract("https://srv", env(), { kv: failingKv, now: 1 }));
});

test("the default backend persists to localStorage (gzip-compressed) and round-trips", async () => {
  // The default backend selects localStorage here because node's import.meta.env
  // is undefined, so currentClientKind() returns null (not "android") and
  // selectCacheBackend picks localStorage. The contract is stored gzipped to fit
  // the ~5MB quota (a 15MB contract compresses to ~1.5MB). No injected kv: this
  // drives the real default path.
  const store = new MemStorage();
  (globalThis as { localStorage?: unknown }).localStorage = store;
  try {
    await saveCachedContract("https://srv", env("4.2.0"));
    const got = await loadCachedContract("https://srv");
    assert.ok(got, "the contract round-trips through the default localStorage backend");
    assert.equal(got.contract_version, "4.2.0");
    const stored = store.getItem("symphony-board:contract-cache");
    assert.ok(stored, "something was persisted to localStorage");
    assert.ok(stored![0] !== "{", "the stored value is compressed, not raw JSON");
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test("selectCacheBackend routes the Android client to the native filesystem", () => {
  // The Android WebView can't hold the cache in IndexedDB or a ~1.5MB
  // localStorage value, so it uses the native FS; desktop/web keep localStorage
  // where it persists.
  assert.equal(selectCacheBackend("android", false), "fs", "Android uses FS even without localStorage");
  assert.equal(selectCacheBackend("android", true), "fs");
  // Case-insensitive: a stray-cased client kind must still route Android to FS,
  // not silently fall back to the localStorage backend this fix avoids.
  assert.equal(selectCacheBackend("Android", true), "fs", "mixed-case android still routes to FS");
  assert.equal(selectCacheBackend("ANDROID", false), "fs");
  assert.equal(selectCacheBackend(null, true), "localStorage", "web/desktop use localStorage when present");
  assert.equal(selectCacheBackend("desktop", true), "localStorage");
  assert.equal(selectCacheBackend(null, false), "none", "no backend usable -> no cache");
});

test("pickColdStartEnv keeps a fetched env and never clobbers it with the cache", () => {
  const fetched = env("4.2.0");
  const cached = env("4.1.0");
  // A fetch that already won is authoritative — the slower cache read must not replace it.
  assert.equal(pickColdStartEnv(fetched, cached), fetched, "an existing (fetched) env wins");
  // No fetch yet -> paint the cached board.
  assert.equal(pickColdStartEnv(null, cached), cached, "a still-empty env is filled from cache");
});
