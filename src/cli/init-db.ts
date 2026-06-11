#!/usr/bin/env node
// Create (or migrate) the store declared in config. Idempotent. The driver is
// config-selected (SQLite by default; db_url_env selects Postgres).
import { loadConfig } from "../config.ts";
import { describeConfiguredStore, openConfiguredStore } from "../db/factory.ts";
import { log } from "../log.ts";

const { cfg, path } = loadConfig(process.argv[2] ?? null);
const store = await openConfiguredStore(cfg);
const diag = await store.diagnostics();
await store.close();
log.info(`db ready: ${describeConfiguredStore(cfg)} (schema v${diag.schema_version}, config ${path})`);
