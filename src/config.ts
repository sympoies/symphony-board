// Config loading. Sources, their tokens (by env-var name, never inlined), and
// the DB path are declared in config/sources.json (gitignored; see
// config/sources.example.json). JSON keeps runtime dependencies at zero.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isValidTimezone } from "./lib/tz.ts";

// A project entry is either a bare "owner/name" path or an object that also
// carries per-repo metadata. Most stay bare strings; only the few repos worth
// highlighting or routing to a named token pool take the object form.
export type ProjectConfig = string | { path: string; color?: string; token_pool?: string };

export interface TokenPoolConfig {
  token_env: string;
  fallback_token_envs?: string[];
}

export interface SourceConfig {
  source_id: string;
  kind: string; // github | gitlab | ...
  host: string;
  display_name?: string;
  // Optional runtime switch. Omitted/true means the source participates in sync
  // runs; false keeps the source in config but prevents fetch/build attempts.
  enabled?: boolean;
  // Optional source-level highlight color (hex). A repo with no color of its
  // own inherits it; resolution (override -> repo -> source) lives in the
  // consumer. Display-only metadata — never stored in the DB.
  color?: string;
  token_env: string; // name of the env var holding the default PAT
  // Optional fallback PAT env vars. The primary token_env is tried first; these
  // are only used when the provider clearly reports a primary rate-limit
  // exhaustion for the current token.
  fallback_token_envs?: string[];
  // Optional named token pools. A project object may set `token_pool` to route
  // just that repo through a different primary/fallback env-var set; omitted
  // projects keep using token_env + fallback_token_envs.
  token_pools?: Record<string, TokenPoolConfig>;
  graphql_url: string;
  // Optional REST base URL. Defaults by provider/host when omitted; used for
  // activity surfaces such as commits and project/repository events.
  rest_url?: string;
  // Optional commit branch expansion mode. "all" (the default when omitted)
  // also labels commits on live side branches — discovered from push events and
  // fetched as branch-unique compare sets; "default" restricts the commit feed
  // to the default branch only (the pre-expansion behavior, an escape hatch for
  // a repo whose branch churn is too noisy or rate-limit-expensive to expand).
  commit_branches?: "all" | "default";
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
// — never stored in the DB, applied at emit time. `source_ids` optionally scopes
// a declaration to one or more configured provider instances; omitted keeps the
// historical global behavior.
export interface IdentityConfig {
  name: string; // canonical display name for the merged actor
  usernames?: string[]; // provider usernames (any source) that are this person
  emails?: string[]; // commit emails that are this person
  names?: string[]; // raw commit display names that are this person
  source_ids?: string[]; // optional source_id allowlist for this identity
}

export interface AppConfig {
  db_path: string;
  // Optional NAME of an env var holding a postgres:// connection URL (the URL
  // itself never lives in config, matching the token_env convention). When
  // set, the store is Postgres and db_path is unused; when the named env var
  // is empty the run fails rather than silently falling back to SQLite. The
  // default deployment stays on SQLite; docker/compose.pg.yaml opts into
  // Postgres through this selector.
  db_url_env?: string;
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

export interface ResolvedToken {
  env: string;
  value: string;
}

const DEFAULT_PATH = "config/sources.json";

// Highlight colors are #rgb or #rrggbb. This mirrors what an <input type="color">
// emits and keeps the contract's repo/source color a plain hex string.
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function tokenEnvNamesFromPool(pool: TokenPoolConfig): string[] {
  return [pool.token_env, ...(pool.fallback_token_envs ?? [])].filter((env) => env.trim().length > 0);
}

function validateTokenPool(pool: unknown, poolLabel: string, errors: string[]): void {
  if (!isPlainObject(pool)) {
    errors.push(`${poolLabel} must be an object`);
    return;
  }
  if (typeof pool.token_env !== "string" || pool.token_env.trim().length === 0) {
    errors.push(`${poolLabel} missing "token_env"`);
  }
  if (pool.fallback_token_envs !== undefined) {
    if (!Array.isArray(pool.fallback_token_envs)) {
      errors.push(`${poolLabel} fallback_token_envs must be an array when set`);
    } else {
      const seenTokenEnvNames = new Set<string>();
      if (typeof pool.token_env === "string") seenTokenEnvNames.add(pool.token_env.trim());
      for (const envName of pool.fallback_token_envs) {
        if (typeof envName !== "string" || envName.trim().length === 0) {
          errors.push(`${poolLabel} fallback_token_envs entries must be non-empty strings`);
          continue;
        }
        const trimmed = envName.trim();
        if (seenTokenEnvNames.has(trimmed)) {
          errors.push(`${poolLabel} fallback_token_envs must not repeat token_env or another fallback token env`);
          continue;
        }
        seenTokenEnvNames.add(trimmed);
      }
    }
  }
}

// The path loadConfig would read and the config control plane writes: explicit
// argument, then SYMPHONY_CONFIG, then the repo-relative default.
export function resolveConfigPath(explicitPath?: string | null): string {
  return resolve(explicitPath ?? process.env.SYMPHONY_CONFIG ?? DEFAULT_PATH);
}

// Validate a parsed config document and return every problem found (empty =
// valid). `label` names the document in messages — a file path for loadConfig,
// "config" for a control-plane PUT body. Collecting instead of throwing lets
// the config control plane report all field errors in one round trip; only
// guards that would cascade into noise (a non-array `sources`) stop early.
export function configErrors(raw: unknown, label: string): string[] {
  const errors: string[] = [];
  if (!isPlainObject(raw)) {
    return [`${label} is not an object`];
  }
  const cfg = raw as Partial<AppConfig>;
  if (!cfg.db_path) errors.push(`${label} is missing db_path`);
  if (cfg.db_url_env !== undefined && (typeof cfg.db_url_env !== "string" || cfg.db_url_env.trim().length === 0)) {
    errors.push(`${label}: "db_url_env" must be a non-empty env-var name when set (omit it for SQLite)`);
  }
  if (!Array.isArray(cfg.sources) || cfg.sources.length === 0) {
    errors.push(`${label} has no sources`);
  } else {
    for (const s of cfg.sources) {
      if (typeof s !== "object" || s === null) {
        errors.push(`${label}: every source must be an object`);
        continue;
      }
      for (const field of ["source_id", "kind", "host", "token_env", "graphql_url"] as const) {
        if (!s[field]) errors.push(`${label}: source missing "${field}"`);
      }
      if (typeof s.source_id === "string" && s.source_id.includes("|")) {
        errors.push(`${label}: source_id "${s.source_id}" must not contain '|'`);
      }
      if (s.enabled !== undefined && typeof s.enabled !== "boolean") {
        errors.push(`${label}: source "${s.source_id}" enabled must be a boolean when set`);
      }
      if (s.color !== undefined && !HEX_COLOR.test(s.color)) {
        errors.push(`${label}: source "${s.source_id}" color "${s.color}" is not a hex color (#rgb or #rrggbb)`);
      }
      if (s.rest_url !== undefined && typeof s.rest_url !== "string") {
        errors.push(`${label}: source "${s.source_id}" rest_url must be a string when set`);
      }
      if (s.commit_branches !== undefined && s.commit_branches !== "all" && s.commit_branches !== "default") {
        errors.push(`${label}: source "${s.source_id}" commit_branches must be "all" or "default" when set`);
      }
      validateTokenPool(s, `${label}: source "${s.source_id}"`, errors);
      if (s.token_pools !== undefined) {
        if (s.kind !== "github") {
          errors.push(`${label}: source "${s.source_id}" token_pools are only supported for GitHub sources`);
        }
        if (!isPlainObject(s.token_pools)) {
          errors.push(`${label}: source "${s.source_id}" token_pools must be an object when set`);
        } else {
          for (const [poolName, pool] of Object.entries(s.token_pools)) {
            if (poolName.trim().length === 0) {
              errors.push(`${label}: source "${s.source_id}" token_pools contains an empty pool name`);
              continue;
            }
            validateTokenPool(pool, `${label}: source "${s.source_id}" token_pools.${poolName}`, errors);
          }
        }
      }
      if (!Array.isArray(s.projects) || s.projects.length === 0) {
        errors.push(`${label}: source "${s.source_id}" has no projects`);
        continue;
      }
      for (const entry of s.projects) {
        const projPath = typeof entry === "string" ? entry : entry?.path;
        if (typeof projPath !== "string" || projPath.length === 0) {
          errors.push(`${label}: source "${s.source_id}" has a project entry with no "path"`);
          continue;
        }
        if (typeof entry !== "string" && entry.color !== undefined && !HEX_COLOR.test(entry.color)) {
          errors.push(`${label}: project "${projPath}" color "${entry.color}" is not a hex color (#rgb or #rrggbb)`);
        }
        if (typeof entry !== "string" && entry.token_pool !== undefined) {
          if (typeof entry.token_pool !== "string" || entry.token_pool.trim().length === 0) {
            errors.push(`${label}: project "${projPath}" token_pool must be a non-empty string when set`);
          } else if (s.kind !== "github") {
            errors.push(`${label}: project "${projPath}" token_pool is only supported for GitHub sources`);
          } else if (!isPlainObject(s.token_pools) || !Object.prototype.hasOwnProperty.call(s.token_pools, entry.token_pool)) {
            errors.push(`${label}: project "${projPath}" references unknown token_pool "${entry.token_pool}"`);
          }
        }
      }
    }
  }
  if (cfg.identities !== undefined) {
    if (!Array.isArray(cfg.identities)) {
      errors.push(`${label}: "identities" must be an array when set`);
    } else {
      for (const id of cfg.identities) {
        if (typeof id !== "object" || id === null || typeof id.name !== "string" || id.name.trim().length === 0) {
          errors.push(`${label}: every identity needs a non-empty "name"`);
          continue;
        }
        for (const field of ["usernames", "emails", "names", "source_ids"] as const) {
          const v = id[field];
          if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== "string"))) {
            errors.push(`${label}: identity "${id.name}" ${field} must be an array of strings when set`);
          }
        }
      }
    }
  }
  if (cfg.exclude_actors !== undefined && (!Array.isArray(cfg.exclude_actors) || cfg.exclude_actors.some((x) => typeof x !== "string"))) {
    errors.push(`${label}: "exclude_actors" must be an array of strings when set`);
  }
  if (cfg.timezone !== undefined) {
    if (typeof cfg.timezone !== "string" || cfg.timezone.trim().length === 0) {
      errors.push(`${label}: "timezone" must be a non-empty string when set (omit it for UTC)`);
    } else if (!isValidTimezone(cfg.timezone)) {
      errors.push(`${label}: "timezone" "${cfg.timezone}" is not a valid IANA timezone (e.g. "UTC", "Asia/Taipei")`);
    }
  }
  return errors;
}

export function loadConfig(explicitPath?: string | null): { cfg: AppConfig; path: string } {
  const path = resolveConfigPath(explicitPath);
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const errors = configErrors(raw, `Config ${path}`);
  if (errors.length > 0) throw new Error(errors[0]);
  return { cfg: raw as AppConfig, path };
}

// Persist a validated config. Write-to-temp + rename so a concurrent reader
// (the daemon re-reads config per run) never sees a torn file; pretty-printed
// because the file stays hand-editable on deployments without the control
// plane. Callers validate first — this only persists.
export function saveConfig(cfg: AppConfig, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf8" });
  renameSync(tmp, path);
}

// The bare project paths for a source, dropping any per-repo color metadata.
// The fetch layer only needs paths to query; color is an emit/consumer concern.
export function projectPaths(s: SourceConfig): string[] {
  return s.projects.map((p) => (typeof p === "string" ? p : p.path));
}

function projectEntryForPath(s: SourceConfig, projectPath: string): ProjectConfig | undefined {
  return s.projects.find((p) => (typeof p === "string" ? p : p.path) === projectPath);
}

// The (source_id, project_path) pairs currently declared across every source.
// buildContract uses this so a repo dropped from config (and carrying no live
// items — e.g. one surviving only via never-tombstoned activity rows) stops
// appearing in the repo lists. Display/config concern, computed at emit time
// like colors/identities — never stored in the DB, so buildContract stays pure.
export function configuredRepoRefs(cfg: Pick<AppConfig, "sources">): Array<{ source_id: string; project_path: string }> {
  return cfg.sources.flatMap((s) => projectPaths(s).map((project_path) => ({ source_id: s.source_id, project_path })));
}

export function sourceEnabled(s: Pick<SourceConfig, "enabled">): boolean {
  return s.enabled !== false;
}

// --- secrets file (token overlay) ---

// Parse a KEY=VALUE env file (the standalone app's secrets.env). Mirrors the
// Tauri shell's parser exactly: trimmed lines, '#' comments, the first '='
// splits, both sides trimmed, no quoting or escaping.
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key.length === 0) continue;
    out.set(key, line.slice(eq + 1).trim());
  }
  return out;
}

// The secrets file the control plane writes and tokenFor overlays; unset when
// the deployment has no writable secrets file (the Docker stack, where tokens
// arrive as container env).
export function resolveSecretsPath(): string | null {
  const p = (process.env.SYMPHONY_SECRETS_FILE ?? "").trim();
  return p.length ? resolve(p) : null;
}

// Fresh read of the secrets file; a missing or unreadable file is an empty
// overlay, never an error — tokens then resolve from the process env alone.
export function readSecretsOverlay(path: string | null): Map<string, string> {
  if (!path) return new Map();
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return new Map();
  }
}

function secretValueForEnv(envName: string, overlay: Map<string, string>): string | null {
  const fromFile = overlay.get(envName) ?? "";
  const v = (fromFile.length > 0 ? fromFile : (process.env[envName] ?? "")).trim();
  return v.length ? v : null;
}

// Set or remove one KEY in env-file text, preserving comments and unrelated
// lines. A set replaces the first existing KEY= line (dropping duplicates); a
// remove drops every KEY= line.
export function upsertEnvText(text: string, name: string, value: string | null): string {
  const lines = text.length > 0 ? text.split("\n") : [];
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const out: string[] = [];
  let replaced = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const eq = line.indexOf("=");
    const key = !line.startsWith("#") && eq > 0 ? line.slice(0, eq).trim() : null;
    if (key === name) {
      if (value !== null && !replaced) {
        out.push(`${name}=${value}`);
        replaced = true;
      }
      continue;
    }
    out.push(rawLine);
  }
  if (value !== null && !replaced) out.push(`${name}=${value}`);
  return out.length > 0 ? out.join("\n") + "\n" : "";
}

// Atomically persist one secret change. The file is created owner-only when
// missing and rewritten owner-only on update; comments and unrelated entries
// survive. Token values pass through this function and are never logged.
export function saveSecret(path: string, name: string, value: string | null): void {
  mkdirSync(dirname(path), { recursive: true });
  let current = "";
  try {
    current = readFileSync(path, "utf8");
  } catch {
    // first write creates the file
  }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, upsertEnvText(current, name, value), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

// Resolve a source's token: a fresh secrets-file read wins over the process
// env, because the standalone shell passes secrets.env as spawn env — a token
// edited at runtime is newer truth than the copy this process started with.
// Returns null when unset, so a caller can skip that source with a warning
// instead of crashing the run.
export function tokenFor(s: SourceConfig): string | null {
  return tokensForSource(s)[0]?.value ?? null;
}

export function tokensForSource(s: SourceConfig): ResolvedToken[] {
  return tokensForPool(s);
}

function tokensForPool(pool: TokenPoolConfig): ResolvedToken[] {
  const overlay = readSecretsOverlay(resolveSecretsPath());
  const out: ResolvedToken[] = [];
  for (const rawEnvName of tokenEnvNamesFromPool(pool)) {
    const envName = rawEnvName.trim();
    if (envName.length === 0) continue;
    const value = secretValueForEnv(envName, overlay);
    if (value) out.push({ env: envName, value });
  }
  return out;
}

export function tokensForProject(s: SourceConfig, projectPath: string): ResolvedToken[] {
  const entry = projectEntryForPath(s, projectPath);
  const poolName = typeof entry === "string" ? undefined : entry?.token_pool;
  if (!poolName) return tokensForSource(s);
  const pool = s.token_pools?.[poolName];
  const poolTokens = pool ? tokensForPool(pool) : [];
  return poolTokens.length > 0 ? poolTokens : tokensForSource(s);
}

export function sourceTokenEnvNames(s: SourceConfig): string[] {
  const out: string[] = [];
  const push = (envName: string): void => {
    const trimmed = envName.trim();
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
  };
  for (const envName of tokenEnvNamesFromPool(s)) push(envName);
  for (const pool of Object.values(s.token_pools ?? {})) {
    for (const envName of tokenEnvNamesFromPool(pool)) push(envName);
  }
  return out;
}

// Every distinct token a source can authenticate with — its default pool AND
// every named token pool — resolved to a live value (secrets-file overlay over
// the process env), keyed by env-var name and deduped. Like tokensForSource it
// drops env names that resolve to nothing, so the result is exactly the tokens
// that could make a request. The token-rate-limit probe uses this to check each
// token's GraphQL budget; the VALUES are returned so the probe can authenticate
// and MUST never be exposed past it (the surface reports env names only).
export function resolveSourceTokens(s: SourceConfig): ResolvedToken[] {
  const overlay = readSecretsOverlay(resolveSecretsPath());
  const out: ResolvedToken[] = [];
  for (const envName of sourceTokenEnvNames(s)) {
    const value = secretValueForEnv(envName, overlay);
    if (value) out.push({ env: envName, value });
  }
  return out;
}
