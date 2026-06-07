// Config loading. Sources, their tokens (by env-var name, never inlined), and
// the DB path are declared in config/sources.json (gitignored; see
// config/sources.example.json). JSON keeps runtime dependencies at zero.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// A project entry is either a bare "owner/name" path or an object that also
// carries a per-repo highlight color. Most stay bare strings; only the few
// repos worth highlighting take the object form.
export type ProjectConfig = string | { path: string; color?: string };

export interface SourceConfig {
  source_id: string;
  kind: string; // github | gitlab | ...
  host: string;
  display_name?: string;
  // Optional source-level highlight color (hex). A repo with no color of its
  // own inherits it; resolution (override -> repo -> source) lives in the
  // consumer. Display-only metadata — never stored in the DB.
  color?: string;
  token_env: string; // name of the env var holding the PAT
  graphql_url: string;
  projects: ProjectConfig[]; // owner/name (GitHub) or group/.../project (GitLab)
}

export interface AppConfig {
  db_path: string;
  sources: SourceConfig[];
}

const DEFAULT_PATH = "config/sources.json";

// Highlight colors are #rgb or #rrggbb. This mirrors what an <input type="color">
// emits and keeps the contract's repo/source color a plain hex string.
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

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
    if (s.color !== undefined && !HEX_COLOR.test(s.color)) {
      throw new Error(`Config ${path}: source "${s.source_id}" color "${s.color}" is not a hex color (#rgb or #rrggbb)`);
    }
    if (!Array.isArray(s.projects) || s.projects.length === 0) {
      throw new Error(`Config ${path}: source "${s.source_id}" has no projects`);
    }
    for (const entry of s.projects) {
      const projPath = typeof entry === "string" ? entry : entry?.path;
      if (typeof projPath !== "string" || projPath.length === 0) {
        throw new Error(`Config ${path}: source "${s.source_id}" has a project entry with no "path"`);
      }
      if (typeof entry !== "string" && entry.color !== undefined && !HEX_COLOR.test(entry.color)) {
        throw new Error(`Config ${path}: project "${projPath}" color "${entry.color}" is not a hex color (#rgb or #rrggbb)`);
      }
    }
  }
  return { cfg: cfg as AppConfig, path };
}

// The bare project paths for a source, dropping any per-repo color metadata.
// The fetch layer only needs paths to query; color is an emit/consumer concern.
export function projectPaths(s: SourceConfig): string[] {
  return s.projects.map((p) => (typeof p === "string" ? p : p.path));
}

// Resolve a source's token from its declared env var. Returns null when unset,
// so a caller can skip that source with a warning instead of crashing the run.
export function tokenFor(s: SourceConfig): string | null {
  const v = (process.env[s.token_env] ?? "").trim();
  return v.length ? v : null;
}
