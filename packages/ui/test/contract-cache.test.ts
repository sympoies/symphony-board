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
