// Shared resolver for the active runtime switch (`SYMPHONY_BOARD_ENV`).
//
// The board has two independent docker stacks — the default SQLite
// `docker/compose.yaml` and the opt-in Postgres `docker/compose.pg.yaml`. A
// single gitignored `.env` key, `SYMPHONY_BOARD_ENV`, records which one is
// active. This module is the ONE place that reads + classifies that switch so
// every consumer (the `deploy` tooling and `project-review-cleanup`) resolves
// it identically and they can never target different stacks.
//
// Precedence mirrors review-cleanup: the process environment wins over the repo
// `.env`. `SYMPHONY_BOARD_RUNTIME` is accepted as an alias of
// `SYMPHONY_BOARD_ENV`.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// A usage-flagged error so callers' top-level handlers can exit 2 (usage) vs 1.
export function usageError(message) {
  const error = new Error(message);
  error.usage = true;
  return error;
}

function stripEnvQuotes(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

// Parse `.env` content into a plain object. Tolerant of blanks, `#` comments,
// an optional leading `export `, and surrounding quotes. Never evaluates the
// file (it also holds tokens), so this is safe to run on a secrets-bearing
// `.env`.
export function parseEnvContent(content) {
  const env = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equals = normalized.indexOf("=");
    if (equals <= 0) continue;
    const key = normalized.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = stripEnvQuotes(normalized.slice(equals + 1).trim());
  }
  return env;
}

function repoRoot() {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

// Read the gitignored repo `.env` into an object. Returns `{}` when there is no
// repo root or no `.env`.
export function loadRepoEnv() {
  const root = repoRoot();
  if (!root) return {};
  try {
    return parseEnvContent(readFileSync(join(root, ".env"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`failed to read repo .env: ${error.message}`);
  }
}

// Classify the active runtime. Returns the normalized runtime string:
// `"postgres"`, `"sqlite"`, or `""` (unset). The empty-vs-`"sqlite"` distinction
// is preserved on purpose — review-cleanup reports it in its source `origin`.
// Throws a usage error for any other value.
export function resolveRuntime({ processEnv = {}, repoEnv = {} } = {}) {
  const envValue = (name) => stringValue(processEnv[name]) ?? stringValue(repoEnv[name]);
  const runtime = (envValue("SYMPHONY_BOARD_ENV") ?? envValue("SYMPHONY_BOARD_RUNTIME") ?? "").toLowerCase();
  if (runtime && runtime !== "postgres" && runtime !== "sqlite") {
    throw usageError(`unsupported SYMPHONY_BOARD_ENV=${runtime}; expected postgres or sqlite`);
  }
  return runtime;
}
