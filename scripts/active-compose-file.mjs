#!/usr/bin/env node
// Resolve which docker compose stack is active from `SYMPHONY_BOARD_ENV` and
// print its path, so `.agents/scripts/deploy.sh` deploys the stack the rest of
// the tooling (project-review-cleanup) reads from. Postgres -> the opt-in
// Postgres stack; sqlite or unset -> the default SQLite stack.
//
//   node scripts/active-compose-file.mjs            # -> docker/compose.yaml | docker/compose.pg.yaml
//   SYMPHONY_BOARD_ENV=postgres node scripts/...    # -> docker/compose.pg.yaml
//
// Exit 2 on an unsupported SYMPHONY_BOARD_ENV; exit 1 on any other failure.

import { fileURLToPath } from "node:url";
import { loadRepoEnv, resolveRuntime } from "./lib/repo-env.mjs";

const COMPOSE_FILES = {
  postgres: "docker/compose.pg.yaml",
  sqlite: "docker/compose.yaml",
};

// Map the active runtime to its compose file. `""` (unset) and `"sqlite"` both
// resolve to the default SQLite stack.
export function resolveComposeFile({ processEnv = {}, repoEnv = {} } = {}) {
  const runtime = resolveRuntime({ processEnv, repoEnv });
  return runtime === "postgres" ? COMPOSE_FILES.postgres : COMPOSE_FILES.sqlite;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const composeFile = resolveComposeFile({ processEnv: process.env, repoEnv: loadRepoEnv() });
    process.stdout.write(`${composeFile}\n`);
  } catch (error) {
    process.stderr.write(`active-compose-file: ${error.message}\n`);
    process.exit(error.usage ? 2 : 1);
  }
}
