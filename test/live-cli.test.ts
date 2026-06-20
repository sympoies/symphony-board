// Unit coverage for the live receiver CLI's pure env -> config resolution
// (#314): secret-rotation merge, empty-secret warning, allowlist parsing, and
// port/host/db-path fallback. No socket is bound — resolveLiveConfig is pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLiveConfig } from "../src/cli/live-receiver.ts";

test("merges current + previous secrets for zero-downtime rotation", () => {
  const cfg = resolveLiveConfig({
    WEBHOOK_GITHUB_SECRET: "current",
    WEBHOOK_GITHUB_SECRET_PREVIOUS: "previous",
  });
  assert.deepEqual(cfg.githubSecrets, ["current", "previous"]);
  assert.deepEqual(cfg.warnings, []);
});

test("keeps only the previous secret when the current one is unset", () => {
  const cfg = resolveLiveConfig({ WEBHOOK_GITHUB_SECRET_PREVIOUS: "previous" });
  assert.deepEqual(cfg.githubSecrets, ["previous"]);
  assert.deepEqual(cfg.warnings, []);
});

test("warns (and rejects everything) when no secret is configured", () => {
  const cfg = resolveLiveConfig({
    WEBHOOK_GITHUB_SECRET: "",
    WEBHOOK_GITHUB_SECRET_PREVIOUS: undefined,
  });
  assert.deepEqual(cfg.githubSecrets, []);
  assert.equal(cfg.warnings.length, 1);
  assert.ok(cfg.warnings[0]);
  assert.match(cfg.warnings[0], /WEBHOOK_GITHUB_SECRET is unset/);
});

test("parses, trims, and compacts the project allowlist", () => {
  const cfg = resolveLiveConfig({ LIVE_PROJECT_ALLOWLIST: " a/b , c/d ,, e/f " });
  assert.deepEqual(cfg.allowlist, ["a/b", "c/d", "e/f"]);
  assert.deepEqual(resolveLiveConfig({}).allowlist, []);
});

test("falls back to default host/ports/db path and honors overrides", () => {
  const def = resolveLiveConfig({});
  assert.equal(def.host, "127.0.0.1");
  assert.equal(def.port, 8090);
  assert.equal(def.webhookPort, 8091);
  assert.equal(def.dbPath, "data/live.db");

  const over = resolveLiveConfig({
    LIVE_BIND_HOST: "0.0.0.0",
    LIVE_PORT: "9000",
    LIVE_WEBHOOK_PORT: "9001",
    LIVE_DB_PATH: "/srv/live.db",
  });
  assert.equal(over.host, "0.0.0.0");
  assert.equal(over.port, 9000);
  assert.equal(over.webhookPort, 9001);
  assert.equal(over.dbPath, "/srv/live.db");
});

test("the reads and webhook ports default to distinct values", () => {
  const def = resolveLiveConfig({});
  assert.notEqual(def.port, def.webhookPort);
});

test("a non-numeric or empty port falls back to the default", () => {
  const cfg = resolveLiveConfig({ LIVE_PORT: "notaport", LIVE_WEBHOOK_PORT: "" });
  assert.equal(cfg.port, 8090);
  assert.equal(cfg.webhookPort, 8091);
});
