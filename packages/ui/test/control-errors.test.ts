import assert from "node:assert/strict";
import test from "node:test";
import { startSyncRun, saveConfigDocument } from "../src/contract.ts";

test("control actions prefer the server's readable error message", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "control_disabled", message: "Manual sync is disabled on this server." }), { status: 403 });
  try {
    const result = await startSyncRun({}, null);
    assert.equal(result.error, "Manual sync is disabled on this server.");
    const config = await saveConfigDocument({ sources: [] }, null);
    assert.equal(config.error, "Manual sync is disabled on this server.");
  } finally { globalThis.fetch = original; }
});

test("control clients preserve HTTP fallback and ignore malformed validation errors", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("gateway error", { status: 502 });
  try {
    assert.equal((await startSyncRun({}, null)).error, "HTTP 502");
    globalThis.fetch = async () => new Response(JSON.stringify({ errors: "bad shape", error: "invalid_config" }), { status: 400 });
    const config = await saveConfigDocument({ sources: [] }, null);
    assert.deepEqual(config.errors, []);
    assert.equal(config.error, "invalid_config");
  } finally { globalThis.fetch = original; }
});
