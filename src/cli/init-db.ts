#!/usr/bin/env node
// Create (or migrate) the SQLite store declared in config. Idempotent.
import { loadConfig } from "../config.ts";
import { openSqliteStore } from "../db/sqlite.ts";
import { log } from "../log.ts";

const { cfg, path } = loadConfig(process.argv[2] ?? null);
const store = await openSqliteStore(cfg.db_path);
const diag = await store.diagnostics();
await store.close();
log.info(`db ready: ${cfg.db_path} (schema v${diag.schema_version}, config ${path})`);
