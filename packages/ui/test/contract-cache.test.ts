// The contract cache lets a COLD start paint the last (stale) board instantly,
// before the ~1.5MB gzip contract download resolves, then revalidate. The 15MB
// decoded envelope is far over the localStorage quota, so the cache lives in
// IndexedDB; this suite drives the pure load/save logic against an injected
// in-memory async KV, the same "test the logic, not the browser" convention the
// live-cache suite uses. node has no IndexedDB — the module must also degrade to
// "no cache" when no store is available.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadCachedContract,
  saveCachedContract,
  pickColdStartEnv,
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
  // No kv injected and node has no global indexedDB: the cache must degrade to
  // "no cache" silently rather than throw.
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

test("pickColdStartEnv keeps a fetched env and never clobbers it with the cache", () => {
  const fetched = env("4.2.0");
  const cached = env("4.1.0");
  // A fetch that already won is authoritative — the slower cache read must not replace it.
  assert.equal(pickColdStartEnv(fetched, cached), fetched, "an existing (fetched) env wins");
  // No fetch yet -> paint the cached board.
  assert.equal(pickColdStartEnv(null, cached), cached, "a still-empty env is filled from cache");
});
