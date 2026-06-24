#!/usr/bin/env node
// Enrich the tracked UI sample contract (packages/ui/public/contract.json) with a
// deterministic ~12-month activity history, so the GitHub Pages demo's Activity
// rhythm heatmap and the selected-range trend chart render as a populated board
// instead of the near-empty visual a 7-event fixture produced.
//
// Only the activity surfaces are rewritten:
//   - activity_daily : the trailing-12-month aggregate that feeds the heatmap and
//                      the Activity overview (Events / Busiest Day / Active Days).
//   - activities[]   : the range-filtered feed that feeds the activity list, the
//                      "selected range activity by week" trend, and Top repos by
//                      events. Windowed to the contract's item_window so the feed
//                      stays bounded while spanning the whole displayed range.
// Items, edges, sources, review threads, repo_metrics and aggregates are left
// untouched, so every other view (and render-smoke's item/edge/graph assertions)
// is unchanged.
//
// Deterministic: a fixed seed + the contract's own generated_at, no Date.now() or
// Math.random(), so re-running produces byte-identical output (clean diffs).
// Idempotent: prior "demo-seed:" activities are dropped before regenerating, and
// the curated hand-authored activities are preserved.
//
// Run from anywhere; re-validate after writing:
//   node --disable-warning=ExperimentalWarning scripts/fixtures/seed-sample-activity.mjs
//   pnpm run validate -- --in packages/ui/public/contract.json

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT = join(HERE, "..", "..", "packages", "ui", "public", "contract.json");
const SEED_PREFIX = "demo-seed:";
const DAY_MS = 24 * 60 * 60 * 1000;

// mulberry32: a tiny deterministic PRNG so the fixture is reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const contract = JSON.parse(readFileSync(CONTRACT, "utf8"));
const tz = contract.timezone || "UTC";
if (tz !== "UTC") {
  throw new Error(`seed-sample-activity assumes a UTC sample contract (got ${tz}); update the date grouping before reusing.`);
}
const generatedAt = contract.generated_at;
const genMs = Date.parse(generatedAt);
if (Number.isNaN(genMs)) throw new Error(`contract.generated_at is not a date: ${generatedAt}`);

// The repos/sources/actors the synthetic activity is attributed to — drawn from
// the curated entities so source marks and repo colors resolve exactly as today.
const REPOS = [
  {
    source_id: "github:github.com",
    project_path: "sympoies/symphony-board",
    weight: 0.62,
    actors: ["maintainer", "reviewer", "octo-dev"],
    commitUrl: (sha) => `https://github.com/sympoies/symphony-board/commit/${sha}`,
    prUrl: (iid) => `https://github.com/sympoies/symphony-board/pull/${iid}`,
    issueUrl: (iid) => `https://github.com/sympoies/symphony-board/issues/${iid}`,
  },
  {
    source_id: "gitlab:gitlab.com",
    project_path: "example-group/symphony-board-fixture",
    weight: 0.38,
    actors: ["gitlab-user", "gl-maintainer"],
    commitUrl: (sha) => `https://gitlab.com/example-group/symphony-board-fixture/-/commit/${sha}`,
    prUrl: (iid) => `https://gitlab.com/example-group/symphony-board-fixture/-/merge_requests/${iid}`,
    issueUrl: (iid) => `https://gitlab.com/example-group/symphony-board-fixture/-/issues/${iid}`,
  },
];

// kind weights (sum need not be 1; picked proportionally). Commits dominate, as in
// a real repo's pulse.
const KINDS = [
  ["commit", 0.56],
  ["change_request", 0.13],
  ["review", 0.12],
  ["issue", 0.11],
  ["branch", 0.08],
];

const COMMIT_TITLES = [
  "Tidy contract projection", "Cache the compiled range query", "Trim sync-engine retries",
  "Polish the activity heatmap", "Guard the empty-range view", "Wire repo metrics window",
  "Speed up the reconcile pass", "Fix label color fallback", "Harden the live snapshot probe",
  "Refine board column layout", "Document the removal semantics", "Add graph focus shortcut",
  "Normalize gitlab mention refs", "Bound the cold-start cache", "Smooth the feed arrival",
];
const PR_TITLES = [
  "Add per-source color overrides", "Window activities to the board scope",
  "Project configured sources only", "Refresh the activity overlay on reload",
  "Sequence the Live detail transitions", "Keep virtual feed rows in viewport",
  "Cover both windowed range ends", "Gate the range overlay for file envs",
];
const ISSUE_TITLES = [
  "Heatmap looks empty on a fresh demo", "Range control should lock in static mode",
  "Edge leaks a de-configured source", "Flaky test in the sync engine",
  "Graph focus loses the time window", "Repo analytics misses a column",
];
const BRANCH_NAMES = ["refs/heads/main", "refs/heads/develop", "refs/heads/release"];
const REVIEW_STATES = ["APPROVED", "COMMENTED", "CHANGES_REQUESTED"];

function pickWeighted(rand, pairs) {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of pairs) {
    r -= w;
    if (r <= 0) return v;
  }
  return pairs[pairs.length - 1][0];
}
function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length) % arr.length];
}
function hex(rand, n) {
  let s = "";
  const chars = "0123456789abcdef";
  for (let i = 0; i < n; i++) s += chars[Math.floor(rand() * 16) % 16];
  return s;
}

const rand = rng(0x5717b0a7);
const synthetic = [];
let seq = 0;
let iid = 200;

// 365 days ending the day before generated_at; the curated activities stay the
// freshest entries.
const startMs = genMs - 365 * DAY_MS;
for (let ms = startMs; ms < genMs - DAY_MS; ms += DAY_MS) {
  const date = new Date(ms);
  const dow = date.getUTCDay(); // 0 Sun .. 6 Sat
  const weekend = dow === 0 || dow === 6;
  // Daily volume with texture: most weekdays active, occasional quiet/burst days,
  // weekends sparse. ~3.3 events/weekday on average fills the heatmap without
  // saturating it.
  let count;
  const roll = rand();
  if (weekend) count = roll < 0.55 ? 0 : roll < 0.85 ? 1 : 2;
  else if (roll < 0.08) count = 0; // the occasional quiet weekday
  else if (roll < 0.7) count = 2 + Math.floor(rand() * 3); // 2-4
  else count = 4 + Math.floor(rand() * 3); // 4-6 burst
  for (let i = 0; i < count; i++) {
    const repo = rand() < REPOS[0].weight ? REPOS[0] : REPOS[1];
    const kind = pickWeighted(rand, KINDS);
    const actor = pick(rand, repo.actors);
    const hh = String(8 + Math.floor(rand() * 11)).padStart(2, "0"); // 08..18
    const mm = String(Math.floor(rand() * 60)).padStart(2, "0");
    const dstr = date.toISOString().slice(0, 10);
    const occurred = `${dstr}T${hh}:${mm}:00Z`;
    const id = `${SEED_PREFIX}${seq++}`;
    const base = {
      source_id: repo.source_id,
      external_id: id,
      kind,
      project_path: repo.project_path,
      actor,
      occurred_at: occurred,
      first_seen_at: occurred,
      last_seen_at: occurred,
      target_kind: null,
      target_ref: null,
      target_iid: null,
      title: null,
      url: null,
      details: null,
      action: "",
    };
    if (kind === "commit") {
      const sha = hex(rand, 7);
      base.action = "committed";
      base.target_kind = "commit";
      base.title = pick(rand, COMMIT_TITLES);
      base.url = repo.commitUrl(sha);
      base.details = { sha, message: base.title };
    } else if (kind === "change_request") {
      const n = iid++;
      base.action = rand() < 0.6 ? "merged" : "opened";
      base.target_kind = "change_request";
      base.target_iid = n;
      base.title = pick(rand, PR_TITLES);
      base.url = repo.prUrl(n);
    } else if (kind === "review") {
      const n = iid++;
      base.action = "reviewed";
      base.target_kind = "change_request";
      base.target_iid = n;
      base.title = pick(rand, PR_TITLES);
      base.url = repo.prUrl(n);
      base.details = { state: pick(rand, REVIEW_STATES) };
    } else if (kind === "issue") {
      const n = iid++;
      base.action = rand() < 0.5 ? "opened" : "closed";
      base.target_kind = "issue";
      base.target_iid = n;
      base.title = pick(rand, ISSUE_TITLES);
      base.url = repo.issueUrl(n);
    } else {
      // branch
      base.action = "pushed";
      base.target_kind = "branch";
      base.title = pick(rand, BRANCH_NAMES).replace("refs/heads/", "");
      base.details = { ref: pick(rand, BRANCH_NAMES), before: hex(rand, 7), after: hex(rand, 7), push_type: "normal" };
    }
    synthetic.push(base);
  }
}

// Preserve curated (hand-authored) activities; drop any previous demo-seed run.
const curated = (contract.activities || []).filter((a) => !String(a.external_id || "").startsWith(SEED_PREFIX));
const full = [...curated, ...synthetic];

// Sort by_kind maps by key so serialization is order-independent (idempotent).
const sortKinds = (m) => Object.fromEntries(Object.entries(m).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

// activity_daily over the FULL set (UTC: the zoned date is the ISO date prefix).
const genDate = generatedAt.slice(0, 10);
const byDay = new Map();
const byKindTotal = {};
let total = 0;
let from = genDate;
for (const a of full) {
  const day = String(a.occurred_at).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
  let bucket = byDay.get(day);
  if (!bucket) {
    bucket = { count: 0, by_kind: {} };
    byDay.set(day, bucket);
  }
  bucket.count += 1;
  bucket.by_kind[a.kind] = (bucket.by_kind[a.kind] || 0) + 1;
  byKindTotal[a.kind] = (byKindTotal[a.kind] || 0) + 1;
  total += 1;
  if (day < from) from = day;
}
const days = [...byDay.entries()]
  .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
  .map(([date, b]) => ({ date, count: b.count, by_kind: sortKinds(b.by_kind) }));
contract.activity_daily = { timezone: tz, from, to: genDate, total, by_kind: sortKinds(byKindTotal), days };

// Emitted activities[]: the displayed range (item_window) so the feed and the
// weekly trend span the whole shown window, newest first.
const sinceMs = Date.parse(contract.item_window?.window?.since ?? generatedAt) || startMs;
contract.activities = full
  .filter((a) => Date.parse(a.occurred_at) >= sinceMs)
  // Newest first, with external_id as a total-order tiebreaker so same-minute
  // events sort deterministically regardless of input order (idempotent re-runs).
  .sort((x, y) => {
    const d = Date.parse(y.occurred_at) - Date.parse(x.occurred_at);
    if (d !== 0) return d;
    return x.external_id < y.external_id ? -1 : x.external_id > y.external_id ? 1 : 0;
  });

writeFileSync(CONTRACT, JSON.stringify(contract, null, 2) + "\n", "utf8");
console.log(
  `seed-sample-activity: activity_daily total=${total} across ${days.length} active days; ` +
    `activities[] feed=${contract.activities.length} (since ${contract.item_window?.window?.since?.slice(0, 10)}).`,
);
