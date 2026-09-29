import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createAppServer } from "../src/cli/app-server.ts";
import { createRangeApiServer } from "../src/cli/range-api.ts";
import { SyncController } from "../src/cli/sync-daemon.ts";

for (const mode of ["standalone", "api"] as const) {
  test(`${mode}: common read-route inventory, fresh config failures and deployment isolation`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "read-api-conformance-"));
    const configPath = join(dir, "sources.json");
    writeFileSync(configPath, "invalid json");
    const opts = { configPath, contractOut: join(dir, "contract.json"), capabilities: { liveReadBaseUrl: null } };
    const server = mode === "api" ? createRangeApiServer(opts) : createAppServer(new SyncController({
      run: async () => { throw new Error("read routes must never sync"); },
    }), { ...opts, controlEnabled: false, configControlEnabled: false, logsEnabled: false, secretsPath: null, intervalSeconds: 120, fullEvery: 30 });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const path of ["range", "stats", "review-candidates", "actionable", "graph-neighborhood"]) {
        const response = await fetch(`${base}/api/${path}`);
        assert.equal(response.status, 500, path);
        const body = await response.json() as { error: string };
        assert.equal(body.error, "config_error", path);
      }
      const capabilities = await fetch(`${base}/api/capabilities`);
      assert.equal(capabilities.status, 200);
      const info = await capabilities.json() as { server: { mode: string } };
      assert.equal(info.server.mode, mode);
      const daily = await fetch(`${base}/api/activity-daily`);
      assert.equal(daily.status, 404, "file-only read must not require valid config");
      assert.equal((await fetch(`${base}/api/toString`)).status, 404);
      assert.equal((await fetch(`${base}/healthz`)).status, 200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
