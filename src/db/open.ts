// Open + migrate the SQLite store using Node's built-in node:sqlite driver
// (DatabaseSync). No native build step, no external dependency — it ships with
// Node 24, matching the project's "pin Node, no build" stance. node:sqlite is
// still flagged experimental; runs silence the warning with
// --disable-warning=ExperimentalWarning.
//
// Schema migrations are tracked with PRAGMA user_version. The DDL lives in
// schema/*.sql (the human-readable, normative artifact) and is applied verbatim,
// so there is a single source of truth for the schema.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = resolve(__dirname, "..", "..", "schema");

interface Migration {
  version: number;
  file: string;
}

// Ordered list of migrations. Append future ones; never edit an applied file
// (write a new migration that rebuilds the affected table).
const MIGRATIONS: Migration[] = [{ version: 1, file: "0001_init.sql" }];

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }
  const db = new DatabaseSync(path);
  // WAL lets the UI sidecar and read-only inspection helpers read while the
  // single sync daemon writes.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function currentVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
}

export function migrate(db: DatabaseSync): void {
  const have = currentVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version <= have) continue;
    const ddl = readFileSync(resolve(SCHEMA_DIR, m.file), "utf8");
    db.exec(ddl);
    // user_version takes an integer literal; m.version is a trusted constant.
    db.exec(`PRAGMA user_version = ${m.version}`);
  }
}
