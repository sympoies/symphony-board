// Config-driven store selection. SQLite (db_path) is the default and the
// production store; a config carrying `db_url_env` (the NAME of an env var
// holding a postgres:// URL, matching the token-by-env-var-name convention)
// selects the Postgres driver instead. The pg driver — and its `postgres`
// dependency — loads lazily, so SQLite-only deployments (including the Docker
// image, which ships no node_modules) never resolve it.

import type { AppConfig } from "../config.ts";
import type { Store } from "./store.ts";
import { openSqliteStore, openSqliteStoreReadOnly } from "./sqlite.ts";

// The Postgres URL the config names, or null when the config means SQLite.
function configuredPgUrl(cfg: AppConfig): string | null {
  const urlEnv = cfg.db_url_env?.trim();
  if (!urlEnv) return null;
  const url = (process.env[urlEnv] ?? "").trim();
  if (!url) {
    // A config that names a Postgres URL env must resolve it: silently falling
    // back to SQLite would split the canonical store across two databases.
    throw new Error(`config selects Postgres via db_url_env, but env ${urlEnv} is not set`);
  }
  return url;
}

export async function openConfiguredStore(cfg: AppConfig): Promise<Store> {
  const url = configuredPgUrl(cfg);
  if (!url) return openSqliteStore(cfg.db_path);
  const { openPostgresStore } = await import("./postgres.ts");
  return openPostgresStore(url);
}

// Read-only counterpart for the API sidecars and inspection surfaces: the same
// selection rules, but the store opens read-only — never migrates, and writes
// through the handle fail (#170).
export async function openConfiguredStoreReadOnly(cfg: AppConfig): Promise<Store> {
  const url = configuredPgUrl(cfg);
  if (!url) return openSqliteStoreReadOnly(cfg.db_path);
  const { openPostgresStoreReadOnly } = await import("./postgres.ts");
  return openPostgresStoreReadOnly(url);
}

// Human-readable description of the configured store for log lines (never the
// URL itself — it may carry credentials).
export function describeConfiguredStore(cfg: AppConfig): string {
  const urlEnv = cfg.db_url_env?.trim();
  return urlEnv ? `postgres (via env ${urlEnv})` : cfg.db_path;
}
