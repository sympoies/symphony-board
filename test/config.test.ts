import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  configErrors,
  loadConfig,
  parseEnvFile,
  projectPaths,
  resolveConfigPath,
  saveConfig,
  saveSecret,
  sourceTokenEnvNames,
  tokenFor,
  tokensForSource,
  tokensForProject,
  upsertEnvText,
  type AppConfig,
} from "../src/config.ts";

// loadConfig reads a file, so each case writes a throwaway fixture. The OS would
// reap tmp anyway; we clean up explicitly to keep the dir tidy between runs.
const tmp = mkdtempSync(join(tmpdir(), "sb-config-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function baseSource(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source_id: "github:github.com",
    kind: "github",
    host: "github.com",
    token_env: "GITHUB_TOKEN",
    graphql_url: "https://api.github.com/graphql",
    projects: ["a/b"],
    ...over,
  };
}
function writeConfig(source: Record<string, unknown>): string {
  const p = join(tmp, `cfg-${n++}.json`);
  writeFileSync(p, JSON.stringify({ db_path: "data/symphony.db", sources: [source] }));
  return p;
}
// Write an arbitrary top-level value to exercise the document-shape guards.
function writeRaw(value: unknown): string {
  const p = join(tmp, `raw-${n++}.json`);
  writeFileSync(p, JSON.stringify(value));
  return p;
}

test("projectPaths drops per-repo color metadata and keeps order", () => {
  const path = writeConfig(baseSource({ projects: ["a/b", { path: "c/d", color: "#fff" }, "e/f"] }));
  const { cfg } = loadConfig(path);
  assert.deepEqual(projectPaths(cfg.sources[0]!), ["a/b", "c/d", "e/f"]);
});

test("accepts a source-level color and a per-repo color (3- and 6-digit hex)", () => {
  const path = writeConfig(baseSource({ color: "#1f6feb", rest_url: "https://api.github.com", projects: [{ path: "c/d", color: "#abc" }] }));
  const { cfg } = loadConfig(path);
  assert.equal(cfg.sources[0]!.color, "#1f6feb");
  assert.equal(cfg.sources[0]!.rest_url, "https://api.github.com");
});

test("rejects a non-hex source color", () => {
  const path = writeConfig(baseSource({ color: "blue" }));
  assert.throws(() => loadConfig(path), /color "blue" is not a hex color/);
});

test("rejects a non-hex per-repo color", () => {
  const path = writeConfig(baseSource({ projects: [{ path: "c/d", color: "red" }] }));
  assert.throws(() => loadConfig(path), /color "red" is not a hex color/);
});

test("rejects a project entry with no path", () => {
  const path = writeConfig(baseSource({ projects: [{ color: "#fff" }] }));
  assert.throws(() => loadConfig(path), /project entry with no "path"/);
});

test("rejects a non-string rest_url", () => {
  const path = writeConfig(baseSource({ rest_url: 42 }));
  assert.throws(() => loadConfig(path), /rest_url must be a string/);
});

test("accepts commit_branches all/default and rejects any other value", () => {
  assert.deepEqual(configErrors({ db_path: "x", sources: [baseSource({ commit_branches: "all" })] }, "config"), []);
  assert.deepEqual(configErrors({ db_path: "x", sources: [baseSource({ commit_branches: "default" })] }, "config"), []);
  assert.deepEqual(configErrors({ db_path: "x", sources: [baseSource()] }, "config"), [], "unset stays valid");
  const errors = configErrors({ db_path: "x", sources: [baseSource({ commit_branches: "branches" })] }, "config");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /commit_branches must be "all" or "default"/);
});

test("accepts fallback_token_envs and rejects malformed token pools", () => {
  assert.deepEqual(configErrors({ db_path: "x", sources: [baseSource({ fallback_token_envs: ["GITHUB_TOKEN_BACKUP"] })] }, "config"), []);
  assert.match(
    configErrors({ db_path: "x", sources: [baseSource({ fallback_token_envs: "GITHUB_TOKEN_BACKUP" })] }, "config")[0]!,
    /fallback_token_envs must be an array/,
  );
  assert.match(
    configErrors({ db_path: "x", sources: [baseSource({ fallback_token_envs: ["  "] })] }, "config")[0]!,
    /fallback_token_envs entries must be non-empty strings/,
  );
  assert.match(
    configErrors({ db_path: "x", sources: [baseSource({ token_env: "GITHUB_TOKEN", fallback_token_envs: ["GITHUB_TOKEN"] })] }, "config")[0]!,
    /must not repeat token_env/,
  );
});

test("accepts named token pools and resolves repo-specific tokens", () => {
  const sourcePath = writeConfig(
    baseSource({
      token_env: "CONFIG_POOL_DEFAULT",
      fallback_token_envs: ["CONFIG_POOL_DEFAULT_BACKUP"],
      token_pools: {
        sympoies: {
          token_env: "CONFIG_POOL_SYMPOIES",
          fallback_token_envs: ["CONFIG_POOL_SYMPOIES_BACKUP"],
        },
      },
      projects: [
        "default/repo",
        { path: "sympoies/repo", color: "#abc", token_pool: "sympoies" },
      ],
    }),
  );
  const { cfg } = loadConfig(sourcePath);
  const source = cfg.sources[0]!;
  process.env.CONFIG_POOL_DEFAULT = "default-primary";
  process.env.CONFIG_POOL_DEFAULT_BACKUP = "default-backup";
  process.env.CONFIG_POOL_SYMPOIES = "sympoies-primary";
  process.env.CONFIG_POOL_SYMPOIES_BACKUP = "sympoies-backup";
  try {
    assert.deepEqual(projectPaths(source), ["default/repo", "sympoies/repo"]);
    assert.deepEqual(sourceTokenEnvNames(source), [
      "CONFIG_POOL_DEFAULT",
      "CONFIG_POOL_DEFAULT_BACKUP",
      "CONFIG_POOL_SYMPOIES",
      "CONFIG_POOL_SYMPOIES_BACKUP",
    ]);
    assert.deepEqual(tokensForProject(source, "default/repo"), [
      { env: "CONFIG_POOL_DEFAULT", value: "default-primary" },
      { env: "CONFIG_POOL_DEFAULT_BACKUP", value: "default-backup" },
    ]);
    assert.deepEqual(tokensForProject(source, "sympoies/repo"), [
      { env: "CONFIG_POOL_SYMPOIES", value: "sympoies-primary" },
      { env: "CONFIG_POOL_SYMPOIES_BACKUP", value: "sympoies-backup" },
    ]);
    assert.deepEqual(tokensForSource(source), [
      { env: "CONFIG_POOL_DEFAULT", value: "default-primary" },
      { env: "CONFIG_POOL_DEFAULT_BACKUP", value: "default-backup" },
    ], "source-level default pool remains unchanged");
  } finally {
    delete process.env.CONFIG_POOL_DEFAULT;
    delete process.env.CONFIG_POOL_DEFAULT_BACKUP;
    delete process.env.CONFIG_POOL_SYMPOIES;
    delete process.env.CONFIG_POOL_SYMPOIES_BACKUP;
  }
});

test("rejects malformed named token pools and unknown project token_pool refs", () => {
  assert.match(
    configErrors({ db_path: "x", sources: [baseSource({ token_pools: [] })] }, "config")[0]!,
    /token_pools must be an object/,
  );
  assert.match(
    configErrors({ db_path: "x", sources: [baseSource({ token_pools: { bad: { fallback_token_envs: [] } } })] }, "config")[0]!,
    /token_pools\.bad missing "token_env"/,
  );
  assert.match(
    configErrors({ db_path: "x", sources: [baseSource({ token_pools: { bad: { token_env: "GH", fallback_token_envs: "NOPE" } } })] }, "config")[0]!,
    /token_pools\.bad fallback_token_envs must be an array/,
  );
  assert.match(
    configErrors({ db_path: "x", sources: [baseSource({ token_pools: { dup: { token_env: "GH", fallback_token_envs: ["GH"] } } })] }, "config")[0]!,
    /token_pools\.dup fallback_token_envs must not repeat token_env/,
  );
  assert.match(
    configErrors({ db_path: "x", sources: [baseSource({ projects: [{ path: "o/r", token_pool: "missing" }] })] }, "config")[0]!,
    /project "o\/r" references unknown token_pool "missing"/,
  );
});

test("repo token pools fall back to source tokens when no pool token is set", () => {
  const sourcePath = writeConfig(
    baseSource({
      token_env: "CONFIG_POOL_FALLBACK_DEFAULT",
      token_pools: {
        sympoies: { token_env: "CONFIG_POOL_FALLBACK_MISSING" },
      },
      projects: [{ path: "sympoies/repo", token_pool: "sympoies" }],
    }),
  );
  const { cfg } = loadConfig(sourcePath);
  const source = cfg.sources[0]!;
  process.env.CONFIG_POOL_FALLBACK_DEFAULT = "default-token";
  try {
    assert.deepEqual(tokensForProject(source, "sympoies/repo"), [
      { env: "CONFIG_POOL_FALLBACK_DEFAULT", value: "default-token" },
    ]);
  } finally {
    delete process.env.CONFIG_POOL_FALLBACK_DEFAULT;
  }
});

test("accepts source enabled boolean and rejects malformed enabled values", () => {
  assert.deepEqual(configErrors({ db_path: "x", sources: [baseSource({ enabled: true })] }, "config"), []);
  assert.deepEqual(configErrors({ db_path: "x", sources: [baseSource({ enabled: false })] }, "config"), []);
  assert.equal(loadConfig(writeConfig(baseSource({ enabled: false }))).cfg.sources[0]!.enabled, false);
  assert.match(
    configErrors({ db_path: "x", sources: [baseSource({ enabled: "false" })] }, "config")[0]!,
    /enabled must be a boolean/,
  );
});

test("rejects document-shape violations: non-object, missing db_path, no sources", () => {
  assert.throws(() => loadConfig(writeRaw(42)), /is not an object/);
  assert.throws(() => loadConfig(writeRaw(null)), /is not an object/);
  assert.throws(() => loadConfig(writeRaw({ sources: [baseSource()] })), /missing db_path/);
  assert.throws(() => loadConfig(writeRaw({ db_path: "d", sources: [] })), /has no sources/);
  assert.throws(() => loadConfig(writeRaw({ db_path: "d" })), /has no sources/);
});

test("rejects a source missing a required field, an empty projects list, and a piped source_id", () => {
  assert.throws(() => loadConfig(writeConfig(baseSource({ kind: undefined }))), /source missing "kind"/);
  assert.throws(() => loadConfig(writeConfig(baseSource({ graphql_url: undefined }))), /source missing "graphql_url"/);
  assert.throws(() => loadConfig(writeConfig(baseSource({ source_id: "a|b" }))), /must not contain '\|'/);
  assert.throws(() => loadConfig(writeConfig(baseSource({ projects: [] }))), /has no projects/);
});

test("tokenFor reads the declared env var, trims it, and returns null when unset or blank", () => {
  const { cfg } = loadConfig(writeConfig(baseSource({ token_env: "SB_TEST_TOKEN_XYZ" })));
  const s = cfg.sources[0]!;
  delete process.env.SB_TEST_TOKEN_XYZ;
  assert.equal(tokenFor(s), null, "unset env -> null (caller skips the source)");
  process.env.SB_TEST_TOKEN_XYZ = "   ";
  assert.equal(tokenFor(s), null, "all-whitespace -> null");
  process.env.SB_TEST_TOKEN_XYZ = "  ghp_secret  ";
  assert.equal(tokenFor(s), "ghp_secret", "surrounding whitespace is trimmed");
  delete process.env.SB_TEST_TOKEN_XYZ;
});

// A full config (db_path + one valid source) plus an arbitrary identities value,
// so the identity guards can be exercised independently of the source guards.
function writeWithIdentities(identities: unknown): string {
  return writeRaw({ db_path: "data/symphony.db", sources: [baseSource()], identities });
}

test("accepts a valid identities map and leaves it on the config", () => {
  const { cfg } = loadConfig(
    writeWithIdentities([{ name: "Dev A", usernames: ["dev-b"], emails: ["dev-a@example.com"], names: ["Dev A"], source_ids: ["gitlab:gitlab.internal"] }]),
  );
  assert.equal(cfg.identities?.length, 1);
  assert.equal(cfg.identities?.[0]!.name, "Dev A");
  assert.deepEqual(cfg.identities?.[0]!.usernames, ["dev-b"]);
  assert.deepEqual(cfg.identities?.[0]!.source_ids, ["gitlab:gitlab.internal"]);
});

test("rejects a malformed identities map", () => {
  assert.throws(() => loadConfig(writeWithIdentities({})), /"identities" must be an array/);
  assert.throws(() => loadConfig(writeWithIdentities([{ usernames: ["x"] }])), /needs a non-empty "name"/);
  assert.throws(() => loadConfig(writeWithIdentities([{ name: "  " }])), /needs a non-empty "name"/);
  assert.throws(() => loadConfig(writeWithIdentities([{ name: "X", emails: "a@b.com" }])), /emails must be an array of strings/);
  assert.throws(() => loadConfig(writeWithIdentities([{ name: "X", usernames: [1] }])), /usernames must be an array of strings/);
  assert.throws(() => loadConfig(writeWithIdentities([{ name: "X", source_ids: [1] }])), /source_ids must be an array of strings/);
});

test("accepts a valid timezone (UTC / IANA), defaults to undefined, and rejects bad values", () => {
  const tzConfig = (timezone: unknown): string => writeRaw({ db_path: "data/symphony.db", sources: [baseSource()], timezone });
  assert.equal(loadConfig(writeRaw({ db_path: "data/symphony.db", sources: [baseSource()] })).cfg.timezone, undefined);
  assert.equal(loadConfig(tzConfig("UTC")).cfg.timezone, "UTC");
  assert.equal(loadConfig(tzConfig("Asia/Taipei")).cfg.timezone, "Asia/Taipei");
  assert.throws(() => loadConfig(tzConfig("Not/AZone")), /is not a valid IANA timezone/);
  assert.throws(() => loadConfig(tzConfig("")), /"timezone" must be a non-empty string/);
  assert.throws(() => loadConfig(tzConfig(8)), /"timezone" must be a non-empty string/);
});

test("accepts a valid exclude_actors list and rejects a malformed one", () => {
  const ok = writeRaw({ db_path: "data/symphony.db", sources: [baseSource()], exclude_actors: ["dependabot", "github-code-quality", "*-bot"] });
  assert.deepEqual(loadConfig(ok).cfg.exclude_actors, ["dependabot", "github-code-quality", "*-bot"]);
  assert.throws(() => loadConfig(writeRaw({ db_path: "data/symphony.db", sources: [baseSource()], exclude_actors: "dependabot" })), /"exclude_actors" must be an array of strings/);
  assert.throws(() => loadConfig(writeRaw({ db_path: "data/symphony.db", sources: [baseSource()], exclude_actors: [1, 2] })), /"exclude_actors" must be an array of strings/);
});

test("configErrors collects every problem in one pass instead of stopping at the first", () => {
  const errors = configErrors({ sources: [{ kind: "github", color: "blue" }], timezone: "Nope/Zone" }, "config");
  assert.ok(errors.includes("config is missing db_path"));
  assert.ok(errors.some((e) => e === 'config: source missing "source_id"'));
  assert.ok(errors.some((e) => e === 'config: source missing "token_env"'));
  assert.ok(errors.some((e) => e.includes("is not a hex color")));
  assert.ok(errors.some((e) => e.includes("is not a valid IANA timezone")));
  assert.ok(errors.length >= 5);
});

test("configErrors returns empty for a valid document and flags non-object sources cleanly", () => {
  assert.deepEqual(configErrors({ db_path: "data/x.db", sources: [baseSource()] }, "config"), []);
  assert.deepEqual(configErrors("nope", "config"), ["config is not an object"]);
  assert.deepEqual(configErrors([], "config"), ["config is not an object"]);
  const errors = configErrors({ db_path: "x", sources: [null, "str"] }, "config");
  assert.ok(errors.every((e) => e.startsWith("config")), "no thrown TypeError, only collected messages");
});

test("saveConfig writes atomically, creates parent dirs, and round-trips through loadConfig", () => {
  const target = join(tmp, "saved", "sources.json"); // parent dir does not exist yet
  const cfg = {
    db_path: "data/board.db",
    timezone: "Asia/Taipei",
    sources: [baseSource()],
    identities: [{ name: "Dev A", usernames: ["dev-a"] }],
    exclude_actors: ["renovate*"],
  } as unknown as AppConfig;
  saveConfig(cfg, target);
  const { cfg: readBack } = loadConfig(target);
  assert.deepEqual(readBack, cfg);
  const leftovers = readdirSync(join(tmp, "saved")).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "the temp file is renamed away");
});

test("parseEnvFile mirrors the desktop shell: comments, blanks, first '=', trimmed", () => {
  const parsed = parseEnvFile("# comment\n\n  GITHUB_TOKEN = ghp_x \nBAD LINE\n=novalue\nGITLAB_TOKEN=glpat=with=equals\n");
  assert.deepEqual([...parsed], [["GITHUB_TOKEN", "ghp_x"], ["GITLAB_TOKEN", "glpat=with=equals"]]);
});

test("upsertEnvText sets, replaces, and removes while preserving comments and order", () => {
  const start = "# tokens\nA=1\nB=2\n";
  assert.equal(upsertEnvText(start, "C", "3"), "# tokens\nA=1\nB=2\nC=3\n");
  assert.equal(upsertEnvText(start, "A", "9"), "# tokens\nA=9\nB=2\n");
  assert.equal(upsertEnvText(start, "A", null), "# tokens\nB=2\n");
  assert.equal(upsertEnvText("", "A", "1"), "A=1\n");
  assert.equal(upsertEnvText("A=1\nA=2\n", "A", "3"), "A=3\n", "duplicates collapse on set");
});

test("saveSecret creates the file owner-only and tokenFor prefers the fresh file over the env", () => {
  const secretsPath = join(tmp, "secrets", "secrets.env");
  const prev = process.env.SYMPHONY_SECRETS_FILE;
  process.env.CONFIG_TEST_OVERLAY_TOKEN = "from-env";
  try {
    process.env.SYMPHONY_SECRETS_FILE = secretsPath;
    const source = { ...baseSource(), token_env: "CONFIG_TEST_OVERLAY_TOKEN" } as unknown as Parameters<typeof tokenFor>[0];

    // no file yet: falls back to the process env
    assert.equal(tokenFor(source), "from-env");

    // a written secret wins over the spawn-time env copy, with no restart
    saveSecret(secretsPath, "CONFIG_TEST_OVERLAY_TOKEN", "from-file");
    assert.equal(tokenFor(source), "from-file");
    assert.equal(statSync(secretsPath).mode & 0o777, 0o600);

    // removing the entry falls back to the env again
    saveSecret(secretsPath, "CONFIG_TEST_OVERLAY_TOKEN", null);
    assert.equal(tokenFor(source), "from-env");
  } finally {
    if (prev === undefined) delete process.env.SYMPHONY_SECRETS_FILE;
    else process.env.SYMPHONY_SECRETS_FILE = prev;
    delete process.env.CONFIG_TEST_OVERLAY_TOKEN;
  }
});

test("tokensForSource resolves primary plus fallback tokens from env and fresh secrets overlay", () => {
  const secretsPath = join(tmp, "secrets", "pool.env");
  const prevSecrets = process.env.SYMPHONY_SECRETS_FILE;
  const source = {
    ...baseSource({ token_env: "CONFIG_POOL_PRIMARY", fallback_token_envs: ["CONFIG_POOL_BACKUP_1", "CONFIG_POOL_BACKUP_2"] }),
  } as unknown as Parameters<typeof tokensForSource>[0];
  process.env.CONFIG_POOL_PRIMARY = " from-env-primary ";
  process.env.CONFIG_POOL_BACKUP_1 = " ";
  process.env.CONFIG_POOL_BACKUP_2 = "from-env-backup-2";
  try {
    process.env.SYMPHONY_SECRETS_FILE = secretsPath;
    assert.deepEqual(tokensForSource(source), [
      { env: "CONFIG_POOL_PRIMARY", value: "from-env-primary" },
      { env: "CONFIG_POOL_BACKUP_2", value: "from-env-backup-2" },
    ]);

    saveSecret(secretsPath, "CONFIG_POOL_BACKUP_1", "from-file-backup-1");
    assert.deepEqual(tokensForSource(source), [
      { env: "CONFIG_POOL_PRIMARY", value: "from-env-primary" },
      { env: "CONFIG_POOL_BACKUP_1", value: "from-file-backup-1" },
      { env: "CONFIG_POOL_BACKUP_2", value: "from-env-backup-2" },
    ]);
  } finally {
    if (prevSecrets === undefined) delete process.env.SYMPHONY_SECRETS_FILE;
    else process.env.SYMPHONY_SECRETS_FILE = prevSecrets;
    delete process.env.CONFIG_POOL_PRIMARY;
    delete process.env.CONFIG_POOL_BACKUP_1;
    delete process.env.CONFIG_POOL_BACKUP_2;
  }
});

test("resolveConfigPath prefers the explicit path, then SYMPHONY_CONFIG, then the default", () => {
  const prev = process.env.SYMPHONY_CONFIG;
  try {
    process.env.SYMPHONY_CONFIG = "/env/sources.json";
    assert.equal(resolveConfigPath("/explicit/sources.json"), resolve("/explicit/sources.json"));
    assert.equal(resolveConfigPath(null), resolve("/env/sources.json"));
    delete process.env.SYMPHONY_CONFIG;
    assert.equal(resolveConfigPath(null), resolve("config/sources.json"));
  } finally {
    if (prev === undefined) delete process.env.SYMPHONY_CONFIG;
    else process.env.SYMPHONY_CONFIG = prev;
  }
});
