// Config loading. Sources, their tokens (by env-var name, never inlined), and
// the DB path are declared in config/sources.json (gitignored; see
// config/sources.example.json). JSON keeps runtime dependencies at zero.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isValidTimezone } from "./lib/tz.ts";

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
  // Optional REST base URL. Defaults by provider/host when omitted; used for
  // activity surfaces such as commits and project/repository events.
  rest_url?: string;
  projects: ProjectConfig[]; // owner/name (GitHub) or group/.../project (GitLab)
}

// A declared person: the provider usernames, commit emails, and raw commit
// display names that are the same human. The contract's repo-analytics actor
// grouping (`top_actors[]`) collapses every matching identity into one canonical
// row named `name`. This is the .mailmap-style escape hatch for the cases the
// automatic key cannot bridge — most notably a GitLab person whose issues/MRs
// carry a username while their commits carry only an email. Emails are matched
// by hash (the raw address is never stored or emitted); names are matched
// case-insensitively with whitespace collapsed. Display-only config, like colors
// — never stored in the DB, applied at emit time.
export interface IdentityConfig {
  name: string; // canonical display name for the merged actor
  usernames?: string[]; // provider usernames (any source) that are this person
  emails?: string[]; // commit emails that are this person
  names?: string[]; // raw commit display names that are this person
}

export interface AppConfig {
  db_path: string;
  // IANA timezone the board buckets calendar days in (e.g. "Asia/Taipei").
  // Optional; unset/empty means "UTC". It is emitted onto the contract envelope
  // so the UI aligns its `today` / `this week` presets and the activity-heatmap
  // day cells to this zone, and the range API expands `from` / `to` queries at
  // this zone's day boundaries. Absolute instants stay UTC; only calendar-day
  // bucketing honors it. Display-only — never stored in the DB.
  timezone?: string;
  sources: SourceConfig[];
  identities?: IdentityConfig[];
  // Actors to drop from repo-analytics `top_actors[]` as noise (CI / dependency
  // bots). Each entry matches an actor's provider username OR a display name,
  // case-insensitively, with `*` as a wildcard (e.g. "github-code-quality",
  // "renovate*"). The board already auto-drops the unambiguous markers — a
  // GitHub `[bot]` login suffix and GitLab service-account usernames
  // (`project_/group_<id>_bot_…`) — so this list is for the unmarked ones
  // (e.g. "dependabot"). Excluded actors still count in repo totals; they are
  // only hidden from the bounded actor list. Display-only config, never stored.
  exclude_actors?: string[];
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
    if (s.rest_url !== undefined && typeof s.rest_url !== "string") {
      throw new Error(`Config ${path}: source "${s.source_id}" rest_url must be a string when set`);
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
  if (cfg.identities !== undefined) {
    if (!Array.isArray(cfg.identities)) {
      throw new Error(`Config ${path}: "identities" must be an array when set`);
    }
    for (const id of cfg.identities) {
      if (typeof id !== "object" || id === null || typeof id.name !== "string" || id.name.trim().length === 0) {
        throw new Error(`Config ${path}: every identity needs a non-empty "name"`);
      }
      for (const field of ["usernames", "emails", "names"] as const) {
        const v = id[field];
        if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== "string"))) {
          throw new Error(`Config ${path}: identity "${id.name}" ${field} must be an array of strings when set`);
        }
      }
    }
  }
  if (cfg.exclude_actors !== undefined && (!Array.isArray(cfg.exclude_actors) || cfg.exclude_actors.some((x) => typeof x !== "string"))) {
    throw new Error(`Config ${path}: "exclude_actors" must be an array of strings when set`);
  }
  if (cfg.timezone !== undefined) {
    if (typeof cfg.timezone !== "string" || cfg.timezone.trim().length === 0) {
      throw new Error(`Config ${path}: "timezone" must be a non-empty string when set (omit it for UTC)`);
    }
    if (!isValidTimezone(cfg.timezone)) {
      throw new Error(`Config ${path}: "timezone" "${cfg.timezone}" is not a valid IANA timezone (e.g. "UTC", "Asia/Taipei")`);
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
