// Config loading. Sources, their tokens (by env-var name, never inlined), and
// the DB path are declared in config/sources.json (gitignored; see
// config/sources.example.json). JSON keeps runtime dependencies at zero.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface SourceConfig {
  source_id: string;
  kind: string; // github | gitlab | ...
  host: string;
  display_name?: string;
  token_env: string; // name of the env var holding the PAT
  graphql_url: string;
  projects: string[]; // owner/name (GitHub) or group/.../project (GitLab)
}

export interface AppConfig {
  db_path: string;
  sources: SourceConfig[];
}

const DEFAULT_PATH = "config/sources.json";

export function loadConfig(explicitPath?: string | null): { cfg: AppConfig; path: string } {
  const path = resolve(explicitPath ?? process.env.SYMPHONY_CONFIG ?? DEFAULT_PATH);
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Config ${path} is not an object`);
  }
  const cfg = raw as Partial<AppConfig>;
  if (!cfg.db_path) throw new Error(`Config ${path} is missing db_path`);
  if (!Array.isArray(cfg.sources) || cfg.sources.length === 0) {
    throw new Error(`Config ${path} has no sources`);
  }
  for (const s of cfg.sources) {
    for (const field of ["source_id", "kind", "host", "token_env", "graphql_url"] as const) {
      if (!s[field]) throw new Error(`Config ${path}: source missing "${field}"`);
    }
    if (s.source_id.includes("|")) {
      throw new Error(`Config ${path}: source_id "${s.source_id}" must not contain '|'`);
    }
    if (!Array.isArray(s.projects) || s.projects.length === 0) {
      throw new Error(`Config ${path}: source "${s.source_id}" has no projects`);
    }
  }
  return { cfg: cfg as AppConfig, path };
}

// Resolve a source's token from its declared env var. Returns null when unset,
// so a caller can skip that source with a warning instead of crashing the run.
export function tokenFor(s: SourceConfig): string | null {
  const v = (process.env[s.token_env] ?? "").trim();
  return v.length ? v : null;
}
