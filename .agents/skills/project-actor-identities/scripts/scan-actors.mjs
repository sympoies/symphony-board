// Read-only scan of the canonical store for actor-identity maintenance.
//
// Surfaces, against the current config/sources.json:
//   1. NEW same-person candidates — a commit author name that normalizes EXACTLY
//      to an existing provider username but is not yet declared in identities[].
//      These are high-confidence (the username is the name with separators
//      stripped) and printed as ready-to-paste identity objects.
//   2. Likely bot candidates — usernames that look like a bot but are NOT caught
//      by the board's built-in [bot] / service-account auto-detector and are not
//      yet in exclude_actors. Suggested for exclude_actors after a human glance.
//   3. Uncertain pairs — a username only PARTIALLY matches a commit name
//      (substring), for manual review.
//
// It never writes. The operator pastes the confident suggestions into
// config/sources.json. Reads display names only (commit emails are stored hashed
// and are never read here). Requires Node 24 (node:sqlite).

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

function flag(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const wantJson = process.argv.includes("--json");
const dbPath = resolve(flag("--db", "data/symphony.db"));
const configPath = resolve(flag("--config", "config/sources.json"));

// username<->name match key: keep only [a-z0-9], lowercased. "Ziv Wu" -> "zivwu".
const norm = (s) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// --- existing config ---
let cfg = {};
try {
  cfg = JSON.parse(readFileSync(configPath, "utf8"));
} catch {
  /* tolerate a missing/unreadable config — everything is then "new" */
}
const identities = Array.isArray(cfg.identities) ? cfg.identities : [];
const excludeActors = Array.isArray(cfg.exclude_actors) ? cfg.exclude_actors : [];
const configuredUsernames = new Set(identities.flatMap((i) => (i.usernames ?? []).map((u) => String(u).toLowerCase())));
const excludeRes = excludeActors.map(
  (p) => new RegExp(`^${String(p).trim().toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`),
);
const isExcluded = (s) => excludeRes.some((re) => re.test((s ?? "").toLowerCase()));

// mirrors src/contract/build.ts isAutoBot: the board already drops these.
const isAutoBot = (u) => /\[bot\]$/.test(u) || /^(project|group)_\d+_bot_/.test(u);
// softer heuristic, for SUGGESTIONS only (the board never auto-applies it).
const looksLikeBot = (u) => /(^|[-_])bot([-_]|$)|bot$|codex|connector|^ghost$|renovate|dependabot|github-actions|github-code-quality/i.test(u);

// --- read the canonical store (read-only) ---
const url = pathToFileURL(dbPath);
url.searchParams.set("mode", "ro");
url.searchParams.set("immutable", "1");
const db = new DatabaseSync(url.href);
db.exec("PRAGMA query_only = ON;");

const provUsers = new Map(); // username -> Set(display strings)
for (const r of db.prepare("SELECT DISTINCT actor_key, actor FROM activity WHERE actor_key LIKE 'provider-user:%'").all()) {
  const key = String(r.actor_key);
  const u = key.slice(key.lastIndexOf(":") + 1);
  if (!provUsers.has(u)) provUsers.set(u, new Set());
  if (r.actor) provUsers.get(u).add(r.actor);
}
for (const r of db.prepare("SELECT DISTINCT author FROM item WHERE author IS NOT NULL").all()) {
  const u = String(r.author).toLowerCase();
  if (!provUsers.has(u)) provUsers.set(u, new Set());
  provUsers.get(u).add(r.author);
}
const emailNames = new Map(); // email actor_key -> Set(commit display names)
for (const r of db.prepare("SELECT DISTINCT actor_key, actor FROM activity WHERE actor_key LIKE 'email:%'").all()) {
  if (!emailNames.has(r.actor_key)) emailNames.set(r.actor_key, new Set());
  if (r.actor) emailNames.get(r.actor_key).add(r.actor);
}
db.close();

const usernameByNorm = new Map();
for (const u of provUsers.keys()) usernameByNorm.set(norm(u), u);

const candidates = new Map(); // username -> Set(commit names)
const uncertainSet = new Map(); // "u|name" -> {username, name}
for (const names of emailNames.values()) {
  for (const n of names) {
    const k = norm(n);
    if (!k) continue;
    if (usernameByNorm.has(k)) {
      const u = usernameByNorm.get(k);
      if (!configuredUsernames.has(u) && !isAutoBot(u)) {
        if (!candidates.has(u)) candidates.set(u, new Set());
        candidates.get(u).add(n);
      }
      continue;
    }
    // uncertain: the commit name contains a (>=4 char) username as a substring.
    for (const u of provUsers.keys()) {
      if (configuredUsernames.has(u) || isAutoBot(u)) continue;
      const nu = norm(u);
      if (nu.length >= 4 && k !== nu && k.includes(nu)) uncertainSet.set(`${u}|${n}`, { username: u, name: n });
    }
  }
}

const botCandidates = [...provUsers.keys()].filter((u) => !isAutoBot(u) && looksLikeBot(u) && !isExcluded(u)).sort();
const pickName = (names) => [...names].find((n) => /\s|[^\x00-\x7F]/.test(n)) ?? [...names][0];

const result = {
  configured: { identities: identities.map((i) => i.name), exclude_actors: excludeActors },
  newIdentities: [...candidates.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([u, names]) => ({ name: pickName(names), usernames: [u], names: [...names].sort() })),
  botCandidates,
  uncertain: [...uncertainSet.values()].sort((a, b) => a.username.localeCompare(b.username)),
};

if (wantJson) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const p = (...a) => console.log(...a);
p(`db: ${dbPath}`);
p(`config: ${configPath}`);
p("");
p(`Configured identities (${result.configured.identities.length}): ${result.configured.identities.join(", ") || "(none)"}`);
p(`Configured exclude_actors: ${result.configured.exclude_actors.join(", ") || "(none)"}`);
p("");
p(`== NEW same-person candidates (commit name == an existing username, not yet declared): ${result.newIdentities.length} ==`);
for (const e of result.newIdentities) {
  p(`  @${e.usernames[0]}  <-  ${e.names.map((n) => `"${n}"`).join(", ")}`);
  p(`      ${JSON.stringify(e)}`);
}
if (result.newIdentities.length) p(`  ^ paste these objects into config/sources.json -> "identities": [ ... ]`);
p("");
p(`== Likely bot candidates (not auto-detected, not yet excluded): ${result.botCandidates.length} ==`);
if (result.botCandidates.length) {
  p(`  ${result.botCandidates.join(", ")}`);
  p(`  ^ add the real bots to config/sources.json -> "exclude_actors": [ ... ]`);
}
p("");
p(`== Uncertain pairs (REVIEW BY HAND — username only partially matches a commit name): ${result.uncertain.length} ==`);
for (const u of result.uncertain) p(`  @${u.username}  ?  "${u.name}"`);
