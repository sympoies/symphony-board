import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORTED_MAJOR,
  majorOf,
  parseContract,
  fetchContract,
  fetchSyncControl,
  fetchCurrentSyncRun,
  startSyncRun,
  SYNC_CONTROL_HEADER,
} from "../src/contract.ts";

test("majorOf reads the leading integer of a version string (never NaN)", () => {
  assert.equal(SUPPORTED_MAJOR, 3);
  assert.equal(majorOf("1.2.3"), 1);
  assert.equal(majorOf("3.0.0"), 3);
  assert.equal(majorOf("10.4.1"), 10);
  assert.equal(majorOf(""), 0, "empty -> 0, not NaN");
});

test("parseContract accepts a well-formed envelope and rejects malformed input", () => {
  const ok = parseContract(JSON.stringify({ contract_version: "1.0.0", items: [] }));
  assert.equal(ok.contract_version, "1.0.0");
  assert.deepEqual(ok.items, []);

  assert.throws(() => parseContract("not json"), SyntaxError, "invalid JSON bubbles up");
  assert.throws(() => parseContract("[]"), /missing contract_version \/ items/, "array is not an envelope");
  assert.throws(() => parseContract(JSON.stringify({ items: [] })), /missing contract_version/, "no version");
  assert.throws(() => parseContract(JSON.stringify({ contract_version: "1.0.0" })), /missing contract_version \/ items/, "no items");
});

test("fetchContract parses the JSON on a 2xx and throws with the status on a non-ok response", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ contract_version: "1.0.0", items: [] }),
    })) as unknown as typeof fetch;
    const env = await fetchContract("./x.json");
    assert.equal(env.contract_version, "1.0.0");

    globalThis.fetch = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    await assert.rejects(() => fetchContract("./missing.json"), /could not load .* HTTP 404/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchSyncControl returns the info on 2xx and null on any failure", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ enabled: true, sources: [], current: null, last: null }) })) as unknown as typeof fetch;
    const info = await fetchSyncControl();
    assert.equal(info?.enabled, true);

    // a missing control surface (404) reads as "unavailable", not an error
    globalThis.fetch = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;
    assert.equal(await fetchSyncControl(), null);

    // a network failure also reads as unavailable
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    assert.equal(await fetchSyncControl(), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("fetchCurrentSyncRun unwraps the current run", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ current: { run_id: "r1", status: "running" } }) })) as unknown as typeof fetch;
    assert.equal((await fetchCurrentSyncRun())?.run_id, "r1");

    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ current: null }) })) as unknown as typeof fetch;
    assert.equal(await fetchCurrentSyncRun(), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("startSyncRun sends the same-origin header and adopts the 409 active run", async () => {
  const realFetch = globalThis.fetch;
  try {
    let seenHeader: string | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seenHeader = (init.headers as Record<string, string>)[SYNC_CONTROL_HEADER];
      return { ok: true, status: 202, json: async () => ({ current: { run_id: "r2", status: "running" } }) };
    }) as unknown as typeof fetch;
    const ok = await startSyncRun({ mode: "incremental", dry_run: false, source_id: null });
    assert.equal(ok.ok, true);
    assert.equal(ok.run?.run_id, "r2");
    assert.equal(seenHeader, "1", "the mutating POST carries the same-origin guard header");

    // 409: a run is already active; the active run rides back in `current`.
    globalThis.fetch = (async () => ({ ok: false, status: 409, json: async () => ({ error: "run_active", current: { run_id: "r3", status: "running" } }) })) as unknown as typeof fetch;
    const busy = await startSyncRun({ mode: "full", dry_run: false, source_id: null });
    assert.equal(busy.ok, false);
    assert.equal(busy.status, 409);
    assert.equal(busy.run?.run_id, "r3", "the 409 response adopts the active run for polling");
  } finally {
    globalThis.fetch = realFetch;
  }
});
