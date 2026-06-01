#!/usr/bin/env node
// Create (or migrate) the SQLite store declared in config. Idempotent.
import { loadConfig } from "../config.ts";
import { openDb } from "../db/open.ts";
import { log } from "../log.ts";

const { cfg, path } = loadConfig(process.argv[2] ?? null);
const db = openDb(cfg.db_path);
const v = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
db.close();
log.info(`db ready: ${cfg.db_path} (schema v${v}, config ${path})`);
