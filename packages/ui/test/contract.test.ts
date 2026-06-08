import { test } from "node:test";
import assert from "node:assert/strict";
import { SUPPORTED_MAJOR, majorOf, parseContract, fetchContract } from "../src/contract.ts";

test("majorOf reads the leading integer of a version string (never NaN)", () => {
  assert.equal(SUPPORTED_MAJOR, 2);
  assert.equal(majorOf("1.2.3"), 1);
  assert.equal(majorOf("2.0.0"), 2);
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
