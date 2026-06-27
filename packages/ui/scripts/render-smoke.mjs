// Headless render smoke for the UI. The unit tests cover the pure model, and
// `vite build` covers the type/bundle layer — but neither RENDERS the React
// tree, so a render-only crash (e.g. a reserved `ref` prop) slips through. This
// script actually renders the built app in headless Chrome against the bundled
// sample contract and asserts the board, graph, activity feed, and settings page
// draw with ZERO console errors / uncaught exceptions.
//
// Self-contained: it serves dist/ from an in-process HTTP server and drives
// Chrome over the DevTools Protocol using Node's built-in WebSocket/fetch — no
// extra dependencies. Chrome binary: $CHROME_BIN, else a platform default.
//
//   pnpm --filter @symphony-board/ui run build && pnpm --filter @symphony-board/ui run smoke

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, platform } from "node:os";
// Source of truth for the seed/buffer sizes, so the assertions below track the
// constants (a retune updates here, not a frozen literal that could rot).
import { LIVE_SEED_LIMIT, LIVE_EVENT_BUFFER_LIMIT } from "../src/live-config.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const FIRST_PAINT_SCRIPT_MARKER = "Apply the persisted color mode BEFORE first paint";

function firstPaintScriptFromHtml(html) {
  const markerIndex = html.indexOf(FIRST_PAINT_SCRIPT_MARKER);
  if (markerIndex < 0) return null;
  const openTagStart = html.lastIndexOf("<script", markerIndex);
  if (openTagStart < 0) return null;
  const openTagEnd = html.indexOf(">", openTagStart);
  if (openTagEnd < 0 || openTagEnd > markerIndex) return null;
  const closeTagStart = html.indexOf("</script>", markerIndex);
  if (closeTagStart < 0) return null;
  return html.slice(openTagEnd + 1, closeTagStart);
}

function envPort(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`invalid ${name}: ${raw}`);
  return n;
}
const HTTP_PORT = envPort("SYMPHONY_BOARD_SMOKE_HTTP_PORT", 4399);
const CDP_PORT = envPort("SYMPHONY_BOARD_SMOKE_CDP_PORT", 9333);
const DEADLINE_MS = 60000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
const ACTIVITY_SMOKE_ROWS = 1200;
let rangeResponseDelayMs = 500;
let contractResponseDelayMs = 0;

// A minimal in-process mock of the board daemon's sync control surface, so the
// headless render exercises the writer-owned manual-sync affordance (the static
// dist has no daemon). A POST starts a "running" run that completes shortly after
// (current -> last), so the UI shows running, then reloaded.
const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const syncMock = { current: null, last: null, seq: 0 };
// The hidden #/debug fill-height tabs read these two writer-daemon surfaces:
// GET /api/stats feeds the Sync runs table (stats.sync_runs) and GET /api/logs
// feeds the Daemon log tail. Enough rows/lines to overflow any viewport so the
// fill panels actually scroll internally (the fill-height assertions below
// depend on the content exceeding the viewport-capped panel height).
const STORE_STATS_MOCK = (() => {
  const sources = ["github", "gitlab:gitlab.com", "gitlab:gitlab.gamania.com"];
  const sync_runs = Array.from({ length: 40 }, (_, i) => ({
    run_id: 40 - i,
    source_id: sources[i % sources.length],
    mode: i % 4 === 0 ? "full" : "incremental",
    status: i % 7 === 0 ? "error" : "ok",
    started_at: `2026-06-23T05:${String(59 - (i % 60)).padStart(2, "0")}:00Z`,
    finished_at: `2026-06-23T05:${String(59 - (i % 60)).padStart(2, "0")}:04Z`,
    items_seen: 1800 + i,
    edges_seen: 2300 + i,
    activities_seen: 11000 + i * 3,
    error: i % 7 === 0 ? "rate limited: secondary limit hit, backing off" : null,
  }));
  return {
    generated_at: "2026-06-23T05:02:00Z",
    db: { driver: "postgres", schema_version: 10 },
    tables: {},
    items: { live: 1836, tombstoned: 0, by_kind: {}, by_state: {}, by_source: {} },
    edges: { live: 2368, tombstoned: 0, by_type: {}, by_lifecycle: {} },
    activities: { total: 11670, by_kind: {}, earliest: null, latest: null },
    sync_runs,
  };
})();
const DAEMON_LOG_MOCK = Array.from({ length: 200 }, (_, i) => ({
  seq: i + 1,
  ts: `2026-06-22T21:32:${String(i % 60).padStart(2, "0")}.000Z`,
  level: i % 41 === 0 ? "error" : i % 23 === 0 ? "warn" : "info",
  message: `[gitlab:gitlab.gamania.com] project terrylin/repo-${i % 9}: activity fetched ${i % 5} records`,
}));
let cachedSyncSources = null;
let contractRequestCount = 0;
// #488: under the range-as-download model the primary load is /api/range (the
// static ./contract.json is only the default-90d / static-deploy fast-path), so
// the refresh assertion below counts range requests, not contract.json hits.
let rangeRequestCount = 0;
let rangeFailOnce = false;
let activityDailyRequestCount = 0;
let liveSnapshotRequestCount = 0;
const liveSnapshotRequestUrls = [];
let liveSnapshotLarge = false;
let liveSnapshotRankFit = false;
async function syncSources() {
  if (cachedSyncSources) return cachedSyncSources;
  try {
    const env = JSON.parse((await readFile(join(DIST, "contract.json"))).toString("utf8"));
    cachedSyncSources = (env.sources || []).map((s) => ({ source_id: s.source_id, display_name: s.display_name ?? null, kind: s.kind }));
  } catch {
    cachedSyncSources = [];
  }
  return cachedSyncSources;
}
function startSyncMock(req = {}) {
  const run = {
    run_id: `smoke-${++syncMock.seq}`,
    trigger: "manual",
    mode: req.mode === "full" ? "full" : "incremental",
    dry_run: !!req.dry_run,
    source_scope: req.source_id ?? null,
    status: "running",
    started_at: new Date().toISOString(),
    finished_at: null,
    emitted: false,
    totals: null,
    sources: [],
    error: null,
  };
  syncMock.current = run;
  setTimeout(() => {
    syncMock.current = null;
    syncMock.last = {
      ...run,
      status: "ok",
      finished_at: new Date().toISOString(),
      emitted: !run.dry_run,
      totals: { items: 5, edges: 1, activities: 2, soft_deleted: 0, soft_deleted_edges: 0 },
    };
  }, 600);
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
    req.on("error", () => resolve(""));
  });
}

function withSmokeHeaderSources(env) {
  const sources = Array.isArray(env.sources) ? env.sources : [];
  if (sources.length >= 3 || sources.some((s) => s?.source_id === "gitlab:gitlab.gamania.com")) return env;
  const gitlab = sources.find((s) => s?.kind === "gitlab") ?? sources[0] ?? {};
  return {
    ...env,
    sources: [
      ...sources,
      {
        ...gitlab,
        source_id: "gitlab:gitlab.gamania.com",
        kind: "gitlab",
        host: "gitlab.gamania.com",
        display_name: "GitLab (Gamania)",
        last_status: "ok",
        last_success_at: env.generated_at ?? gitlab.last_success_at ?? null,
        color: null,
      },
    ],
  };
}

// A minimal mock of the writer-owned config control plane, so the headless
// render exercises the Settings -> Sources editor (capability present, one
// credential set and one missing). PUTs adopt the submitted document like the real
// daemon (validation is not mocked — the editor only sees success here).
const configMock = { doc: null, secrets: {} };
async function configMockDoc() {
  if (configMock.doc) return configMock.doc;
  const sources = (await syncSources()).map((s) => ({
    source_id: s.source_id,
    kind: s.kind,
    host: `${s.kind}.example.com`,
    display_name: s.display_name ?? undefined,
    token_env: `${s.kind.toUpperCase()}_TOKEN`,
    graphql_url: `https://${s.kind}.example.com/api/graphql`,
    projects: ["example/repo"],
  }));
  configMock.doc = { db_path: "data/board.db", sources };
  return configMock.doc;
}

// A small, valid `live-snapshot/1` payload for the #/live seed. Three events
// with distinct seqs (newest-first) cover the feed rows; one carries an
// event-level `url` permalink (a comment), one only a target url, and one is
// outside the 5h pulse window so Activity proves the rolling-window count while
// Buffer proves every retained memory-cap row remains counted.
function liveSnapshotMock() {
  const now = Date.now();
  const newest = new Date(now - 5_000).toISOString();
  const outsideTrailingHour = new Date(now - 70 * 60_000).toISOString();
  const outsidePulseWindow = new Date(now - 6 * 60 * 60_000).toISOString();
  const generated_at = new Date(now).toISOString();
  const baseEvents = [
      {
        seq: 3,
        event_id: "smoke-live-2",
        source_id: "github:github.com",
        provider: "github",
        received_at: newest,
        occurred_at: newest,
        event_type: "issue_comment",
        action: "created",
        category: "comment",
        actor: {
          login: "octocat",
          display_name: "The Octocat",
          avatar_url: "https://avatars.githubusercontent.com/u/583231?v=4",
          profile_url: "https://github.com/octocat",
        },
        target: { kind: "issue", source_id: "github:github.com", project_path: "acme/widgets", number: 42, title: "Widget overflow", url: "https://github.com/acme/widgets/issues/42" },
        title: "octocat commented on Widget overflow",
        body: "Looks good, shipping.",
        url: "https://github.com/acme/widgets/issues/42#issuecomment-99",
      },
      {
        seq: 2,
        event_id: "smoke-live-1",
        source_id: "github:github.com",
        provider: "github",
        received_at: outsideTrailingHour,
        occurred_at: outsideTrailingHour,
        event_type: "pull_request",
        action: "opened",
        category: "change_request",
        actor: { login: "hubot" },
        target: { kind: "change_request", source_id: "github:github.com", project_path: "acme/widgets", number: 7, title: "Add live feed", url: "https://github.com/acme/widgets/pull/7" },
        title: "hubot opened Add live feed",
      },
      {
        seq: 1,
        event_id: "smoke-live-0",
        source_id: "github:github.com",
        provider: "github",
        received_at: outsidePulseWindow,
        occurred_at: outsidePulseWindow,
        event_type: "issue_comment",
        action: "created",
        category: "comment",
        actor: { login: "octocat" },
        target: { kind: "issue", source_id: "github:github.com", project_path: "acme/widgets", number: 41, title: "Old widget note", url: "https://github.com/acme/widgets/issues/41" },
        title: "octocat commented on Old widget note",
        body: "Older than the Live pulse window.",
        url: "https://github.com/acme/widgets/issues/41#issuecomment-41",
      },
    ];
  if (!liveSnapshotLarge) {
    if (liveSnapshotRankFit) {
      const longRows = Array.from({ length: 14 }, (_, i) =>
        `| Long delivery comment row ${i + 1} | fixed-now | Tables and paragraphs stay inside the card while navigation remains pinned. |`,
      );
      const longBody = [
        "Delivery Review Outcome",
        "",
        "- Reviewable: PR #374",
        "- Decision: proceed-to-merge",
        "- Lenses: testing, maintainability, security, performance, red-team",
        "- Validation: `pnpm --filter @symphony-board/ui run smoke; pnpm run typecheck && pnpm test`",
        "",
        "| Item | Disposition | Reason |",
        "| --- | --- | --- |",
        "| Analytics review/thread call-site coverage gap | fixed-now | Render smoke keeps the review drilldown covered. |",
        "| Reviews repo-breakdown click-through coverage gap | fixed-now | The mobile detail card must scroll without moving navigation. |",
        "| Long delivery comment body | regression guard | Tables and paragraphs stay inside the card. |",
        ...longRows,
        "",
        "This trailing paragraph intentionally makes the mobile detail body tall enough to need its own scroll region.",
      ].join("\n");
      const rankEvents = Array.from({ length: 6 }, (_, i) => {
        const seq = 20 - i;
        const n = i + 1;
        return {
          seq,
          event_id: `smoke-live-rank-fit-${n}`,
          source_id: "github:github.com",
          provider: "github",
          received_at: newest,
          occurred_at: newest,
          event_type: "push",
          action: "committed",
          category: "commit",
          actor: {
            login: `rank-user-${n}`,
            display_name: `Rank User ${n}`,
            avatar_url: null,
            profile_url: `https://github.com/rank-user-${n}`,
          },
          target: {
            kind: "commit",
            source_id: "github:github.com",
            project_path: `rank-org/rank-repo-${n}`,
            number: seq,
            title: `Rank fit commit ${n}`,
            url: `https://github.com/rank-org/rank-repo-${n}/commit/${seq}`,
          },
          title: `rank-user-${n} committed ${seq}`,
          body: n === 2 ? longBody : undefined,
        };
      });
      return {
        schema: "live-snapshot/1",
        max_seq: 20,
        generated_at,
        events: [...rankEvents, ...baseEvents],
      };
    }
    return {
      schema: "live-snapshot/1",
      max_seq: 3,
      generated_at,
      events: baseEvents,
    };
  }
  const largeEvents = [
    { ...baseEvents[0], seq: 1000, event_id: "smoke-live-large-1000" },
    { ...baseEvents[1], seq: 999, event_id: "smoke-live-large-999" },
    { ...baseEvents[2], seq: 998, event_id: "smoke-live-large-998" },
    ...Array.from({ length: 997 }, (_, i) => {
      const seq = 997 - i;
      return {
        seq,
        event_id: `smoke-live-large-${seq}`,
        source_id: "github:github.com",
        provider: "github",
        received_at: outsidePulseWindow,
        occurred_at: outsidePulseWindow,
        event_type: "push",
        action: "committed",
        category: "commit",
        actor: { login: "hubot" },
        target: { kind: "commit", source_id: "github:github.com", project_path: "acme/widgets", number: seq, title: `Historical commit ${seq}`, url: `https://github.com/acme/widgets/commit/${seq}` },
        title: `hubot committed historical ${seq}`,
      };
    }),
  ];
  return {
    schema: "live-snapshot/1",
    max_seq: 1000,
    generated_at,
    events: largeEvents,
  };
}

function chromeBinary() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  if (platform() === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  for (const c of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) return c; // PATH lookup
  return "google-chrome";
}

function fail(msg) {
  console.error(`render-smoke FAIL: ${msg}`);
  process.exitCode = 1;
}

function inflateActivityContract(body) {
  const env = withSmokeHeaderSources(JSON.parse(body.toString("utf8")));
  if (!Array.isArray(env.activities) || env.activities.length === 0) return JSON.stringify(env);

  const baseTime = Date.parse(env.activities[0].occurred_at) || Date.parse(env.generated_at) || Date.now();
  const activities = Array.from({ length: ACTIVITY_SMOKE_ROWS }, (_, i) => {
    const a = env.activities[i % env.activities.length];
    // 4.0.0 dropped activity `id`/`summary`; rows are keyed on source_id|external_id
    // (external_id made unique per synthetic row) and titled from the structured fields.
    return {
      ...a,
      external_id: `${a.external_id}:smoke:${i}`,
      title: `${a.title || `${a.action} ${a.kind}`} smoke ${i}`,
      occurred_at: new Date(baseTime - i * 60_000).toISOString(),
      details: {
        ...(a.details && typeof a.details === "object" && !Array.isArray(a.details) ? a.details : {}),
        ...(a.kind === "commit"
          ? {
              // Every third commit carries a long branch name so the Commits page
              // exercises a wide `commit-ref-chip` (regression guard for the chip
              // wrapping past the fixed virtualized row height in portrait).
              refs: [
                i % 3 === 0
                  ? "refs/heads/feat/android-thin-client-shell-portrait-overflow-guard"
                  : i % 2 === 0
                    ? "refs/heads/main"
                    : "refs/heads/release",
              ],
              ...(i % 3 === 0 ? { body: `Smoke body ${i}\n\nRendered commit body details.` } : {}),
            }
          : {}),
        smoke_index: i,
      },
    };
  });
  return JSON.stringify({ ...env, activities });
}

function parseInflatedContract(rawBody) {
  const body = inflateActivityContract(rawBody);
  return JSON.parse(Buffer.isBuffer(body) ? body.toString("utf8") : body);
}

function timestampMs(value) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : null;
}

function inRange(value, fromMs, toMs) {
  const ms = timestampMs(value);
  return ms !== null && ms >= fromMs && ms <= toMs;
}

function rangeProjection(rawBody, reqUrl) {
  const url = new URL(reqUrl, `http://127.0.0.1:${HTTP_PORT}`);
  const fromDate = url.searchParams.get("from") || "";
  const toDate = url.searchParams.get("to") || "";
  const fromIso = `${fromDate}T00:00:00.000Z`;
  const toIso = `${toDate}T23:59:59.999Z`;
  const fromMs = timestampMs(fromIso);
  const toMs = timestampMs(toIso);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate) || fromMs === null || toMs === null || fromMs > toMs) {
    return { status: 400, body: JSON.stringify({ error: "bad range" }) };
  }

  const env = parseInflatedContract(rawBody);
  const byId = new Map(env.items.map((item) => [item.id, item]));
  const primaryIds = new Set(env.items.filter((item) => inRange(item.updated_at, fromMs, toMs)).map((item) => item.id));
  const selectedEdges = new Map();
  const addEdge = (edge) => selectedEdges.set(`${edge.type}\u0000${edge.from}\u0000${edge.to}`, edge);
  for (const edge of env.edges) {
    if (primaryIds.has(edge.from) || primaryIds.has(edge.to)) addEdge(edge);
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (inRange(from?.updated_at, fromMs, toMs) || inRange(to?.updated_at, fromMs, toMs)) addEdge(edge);
  }

  const endpointIds = new Set();
  for (const edge of selectedEdges.values()) {
    endpointIds.add(edge.from);
    endpointIds.add(edge.to);
  }
  const rangedActivities = (env.activities || []).filter((activity) => inRange(activity.occurred_at, fromMs, toMs));
  const activityTargetIds = new Set();
  for (const activity of rangedActivities) {
    if (activity.kind === "review" && activity.target_ref && byId.has(activity.target_ref)) activityTargetIds.add(activity.target_ref);
  }
  const emittedIds = new Set([...primaryIds, ...endpointIds, ...activityTargetIds]);
  const items = env.items
    .filter((item) => emittedIds.has(item.id))
    .map((item) => {
      const window_reasons = [];
      if (primaryIds.has(item.id)) window_reasons.push("primary");
      if (endpointIds.has(item.id)) window_reasons.push("edge_endpoint");
      if (activityTargetIds.has(item.id)) window_reasons.push("activity_target");
      return { ...item, window_reasons };
    });
  const edgeEndpointItems = items.filter((item) => item.window_reasons.includes("edge_endpoint") && !item.window_reasons.includes("primary")).length;
  const activityTargetItems = items.filter((item) => item.window_reasons.includes("activity_target") && !item.window_reasons.includes("primary")).length;
  return {
    status: 200,
    body: JSON.stringify({
      ...env,
      items,
      edges: [...selectedEdges.values()],
      activities: rangedActivities,
      aggregates: [],
      repo_metrics: (env.repo_metrics || []).map((metric) => ({
        ...metric,
        window: { ...metric.window, kind: "time_range", from: fromIso, to: toIso },
      })),
      item_window: {
        scope: "boardWindow",
        window: { kind: "active_since", basis: "item_updated_at", since: fromIso, days: null, edge_filter: null },
        primary_items: primaryIds.size,
        edge_endpoint_items: edgeEndpointItems,
        activity_target_items: activityTargetItems,
        total_items: env.items.length,
        truncated: true,
      },
      range_query: { kind: "time_range", timezone: "UTC", from: fromIso, to: toIso },
    }),
  };
}

if (!existsSync(join(DIST, "index.html"))) {
  fail(`dist not built (${DIST}/index.html missing) — run \`vite build\` first`);
  process.exit(1);
}

// --- in-process static server for dist/ ---
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || "/").split("?")[0]);
    if (p === "/api/range") {
      rangeRequestCount += 1;
      const delayMs = rangeResponseDelayMs;
      if (delayMs > 0) await sleep(delayMs);
      if (rangeFailOnce) {
        rangeFailOnce = false;
        res.writeHead(500, JSON_HEADERS).end(JSON.stringify({ error: "smoke_range_failed" }));
        return;
      }
      const rawBody = await readFile(join(DIST, "contract.json"));
      const response = rangeProjection(rawBody, req.url || "/api/range");
      res.writeHead(response.status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(response.body);
      return;
    }
    if (p === "/__smoke/contract-count") {
      res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ contractRequests: contractRequestCount }));
      return;
    }
    if (p === "/__smoke/range-count") {
      res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ rangeRequests: rangeRequestCount }));
      return;
    }
    if (p === "/__smoke/activity-daily-count") {
      res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ activityDailyRequests: activityDailyRequestCount }));
      return;
    }
    if (p === "/__smoke/live-snapshot-count") {
      res.writeHead(200, JSON_HEADERS).end(JSON.stringify({
        liveSnapshotRequests: liveSnapshotRequestCount,
        liveSnapshotUrls: liveSnapshotRequestUrls,
      }));
      return;
    }
    if (p === "/__smoke/first-paint") {
      const url = new URL(req.url || "/__smoke/first-paint", `http://127.0.0.1:${HTTP_PORT}`);
      const indexHtml = await readFile(join(DIST, "index.html"), "utf8");
      const scriptSource = firstPaintScriptFromHtml(indexHtml);
      if (!scriptSource) {
        res.writeHead(500, JSON_HEADERS).end(JSON.stringify({ error: "missing_first_paint_script" }));
        return;
      }
      const marker = (url.searchParams.get("marker") || "default").replace(/[^A-Za-z0-9._:-]/g, "_");
      const stored = url.searchParams.get("stored");
      const seed =
        url.searchParams.get("storage") === "throw"
          ? "Storage.prototype.getItem = function () { throw new Error('storage blocked'); };"
          : stored
            ? `localStorage.setItem("symphony-board:theme", ${JSON.stringify(stored)});`
            : 'localStorage.removeItem("symphony-board:theme");';
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" }).end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="theme-color" content="#030b22" />
    <script>${seed}</script>
    <script>${scriptSource}</script>
  </head>
  <body>first-paint-probe:${marker}</body>
</html>`);
      return;
    }
    if (p === "/__smoke/live-large") {
      const url = new URL(req.url || "/__smoke/live-large", `http://127.0.0.1:${HTTP_PORT}`);
      liveSnapshotLarge = url.searchParams.get("enabled") !== "0";
      res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ liveSnapshotLarge }));
      return;
    }
    // A minimal mock of the live receiver's snapshot surface, so the headless
    // render exercises the #/live page's seed path. The browser EventSource
    // stream itself is not mocked here (CDP has no SSE server to point at), but
    // the snapshot seed renders the feed rows and the connection status, which
    // is what this smoke asserts. `live-snapshot/1` schema + a finite max_seq
    // match fetchLiveSnapshot's validation.
    if (p === "/api/live-snapshot") {
      liveSnapshotRequestCount += 1;
      liveSnapshotRequestUrls.push(req.url || "/api/live-snapshot");
      res.writeHead(200, JSON_HEADERS).end(JSON.stringify(liveSnapshotMock()));
      return;
    }
    if (p === "/api/stats") {
      res.writeHead(200, JSON_HEADERS).end(JSON.stringify(STORE_STATS_MOCK));
      return;
    }
    if (p === "/api/activity-daily") {
      activityDailyRequestCount += 1;
      const rawBody = await readFile(join(DIST, "contract.json"));
      const env = parseInflatedContract(rawBody);
      res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ activity_daily: env.activity_daily ?? null }));
      return;
    }
    if (p === "/api/logs") {
      const after = Number(new URL(req.url, "http://smoke.local").searchParams.get("after") || 0);
      const entries = Number.isFinite(after) && after > 0 ? DAEMON_LOG_MOCK.filter((e) => e.seq > after) : DAEMON_LOG_MOCK;
      res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ enabled: true, entries, latest_seq: DAEMON_LOG_MOCK.length, capacity: 1000 }));
      return;
    }
    if (p === "/api/sync-control") {
      res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ enabled: true, sources: await syncSources(), current: syncMock.current, last: syncMock.last, interval_seconds: 120, full_every: 30 }));
      return;
    }
    if (p === "/api/sync-runs/current") {
      res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ current: syncMock.current }));
      return;
    }
    if (p === "/api/sync-runs/last") {
      res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ last: syncMock.last }));
      return;
    }
    if (p === "/api/sync-runs" && req.method === "POST") {
      const raw = await readBody(req);
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        body = {};
      }
      startSyncMock(body);
      res.writeHead(202, JSON_HEADERS).end(JSON.stringify({ current: syncMock.current }));
      return;
    }
    if (p === "/api/config") {
      if (req.method === "PUT") {
        const raw = await readBody(req);
        try {
          configMock.doc = JSON.parse(raw);
        } catch {
          res.writeHead(400, JSON_HEADERS).end(JSON.stringify({ error: "bad_request", message: "request body is not valid JSON" }));
          return;
        }
        res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ ok: true, config: configMock.doc }));
        return;
      }
      res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ enabled: true, config: await configMockDoc(), error: null }));
      return;
    }
    if (p === "/api/secrets") {
      if (req.method === "PUT") {
        const raw = await readBody(req);
        let body = {};
        try {
          body = JSON.parse(raw || "{}");
        } catch {
          body = {};
        }
        if (body.env) configMock.secrets[body.env] = body.value !== null;
        res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ ok: true, env: body.env ?? "", set: body.value !== null }));
        return;
      }
      const doc = await configMockDoc();
      const secrets = {};
      for (const s of doc.sources) secrets[s.token_env] = configMock.secrets[s.token_env] ?? s.token_env === "GITHUB_TOKEN";
      res.writeHead(200, JSON_HEADERS).end(JSON.stringify({ enabled: true, writable: true, secrets }));
      return;
    }
    if (p === "/") p = "/index.html";
    const file = normalize(join(DIST, p));
    if (!file.startsWith(DIST)) {
      res.writeHead(403).end();
      return;
    }
    const rawBody = await readFile(file);
    const isContract = file === join(DIST, "contract.json");
    if (isContract) contractRequestCount += 1;
    if (isContract && contractResponseDelayMs > 0) await sleep(contractResponseDelayMs);
    const body = isContract ? inflateActivityContract(rawBody) : rawBody;
    const ext = file.slice(file.lastIndexOf("."));
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((resolve, reject) => {
  const onError = (err) => reject(err);
  server.once("error", onError);
  server.listen(HTTP_PORT, "127.0.0.1", () => {
    server.off("error", onError);
    resolve();
  });
});

// --- launch headless Chrome ---
const userDataDir = mkdtempSync(join(tmpdir(), "sb-render-"));
const chrome = spawn(
  chromeBinary(),
  [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${CDP_PORT}`, "--remote-allow-origins=*",
    "about:blank",
  ],
  { stdio: "ignore" },
);

function cleanup() {
  try { chrome.kill("SIGKILL"); } catch {}
  try { server.close(); } catch {}
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
}

try {
  // wait for a page target
  const deadline = Date.now() + DEADLINE_MS;
  let wsUrl = null;
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch {}
    await sleep(200);
  }
  if (!wsUrl) throw new Error("Chrome DevTools page target never appeared");

  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  const exceptions = [];
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      return;
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" "));
    }
    if (m.method === "Runtime.exceptionThrown") {
      const e = m.params.exceptionDetails;
      exceptions.push(e?.exception?.description || e?.text || "exception");
    }
  });
  await new Promise((res, rej) => {
    ws.addEventListener("open", res);
    ws.addEventListener("error", () => rej(new Error("CDP websocket error")));
  });
  await send("Runtime.enable");
  await send("Page.enable");

  // wait for some DOM matching `readyExpr` to render, then return body HTML
  const waitHtml = async (readyExpr) => {
    let h = "";
    while (Date.now() < deadline) {
      const r = await send("Runtime.evaluate", { expression: `${readyExpr} ? document.body.innerHTML : ''`, returnByValue: true });
      h = r.result.value || "";
      if (h.length > 200) break;
      await sleep(250);
    }
    return h;
  };
  const waitValue = async (expr) => {
    let value = null;
    while (Date.now() < deadline) {
      const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
      value = r.result.value ?? null;
      if (value) break;
      await sleep(50);
    }
    return value;
  };
  let firstPaintProbeSeq = 0;
  const firstPaintProbe = async ({ scheme, stored = "", storage = "" }) => {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    const marker = `probe-${++firstPaintProbeSeq}`;
    const params = new URLSearchParams();
    params.set("marker", marker);
    if (stored) params.set("stored", stored);
    if (storage) params.set("storage", storage);
    await send("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/__smoke/first-paint?${params}` });
    return await waitValue(`(() => {
      if (location.pathname !== "/__smoke/first-paint") return null;
      if (new URLSearchParams(location.search).get("marker") !== ${JSON.stringify(marker)}) return null;
      if (document.body?.textContent?.trim() !== ${JSON.stringify(`first-paint-probe:${marker}`)}) return null;
      return {
        theme: document.documentElement.dataset.theme || '',
        colorScheme: document.documentElement.style.colorScheme || '',
        themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') || '',
      };
    })()`);
  };
  const firstPaintSystemDark = await firstPaintProbe({ scheme: "dark" });
  const firstPaintStorageBlockedLight = await firstPaintProbe({ scheme: "light", storage: "throw" });
  const firstPaintStoredLight = await firstPaintProbe({ scheme: "dark", stored: "light" });
  const firstPaintStoredDark = await firstPaintProbe({ scheme: "light", stored: "dark" });
  const firstPaintLegacyPaper = await firstPaintProbe({ scheme: "dark", stored: "paper" });
  const firstPaintLegacyNightOwl = await firstPaintProbe({ scheme: "light", stored: "night-owl" });
  await send("Runtime.evaluate", { expression: "try { localStorage.clear(); } catch (e) {}", returnByValue: true });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await send("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/` });

  const textOf = async (selector) =>
    (await send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})?.innerText || ''`, returnByValue: true })).result.value || "";
  const titleLinkHitTargets = [];
  const captureTitleLinkHitTarget = async (surface, linkSelector, containerSelector) => {
    const result = (await send("Runtime.evaluate", {
      expression: `(() => {
        const links = Array.from(document.querySelectorAll(${JSON.stringify(linkSelector)}));
        const candidates = links.map((link) => {
          const container = link.closest(${JSON.stringify(containerSelector)});
          const linkRect = link.getBoundingClientRect();
          const containerRect = container?.getBoundingClientRect();
          const text = (link.textContent || '').replace(/↗/g, '').replace(/\\s+/g, ' ').trim();
          if (!containerRect || !text || linkRect.width <= 0 || linkRect.height <= 0 || containerRect.width <= 0) return null;
          return {
            surface: ${JSON.stringify(surface)},
            text,
            textLength: text.length,
            linkWidth: Math.round(linkRect.width),
            containerWidth: Math.round(containerRect.width),
            trailingGap: Math.round(containerRect.right - linkRect.right),
            fillRatio: Math.round((linkRect.width / containerRect.width) * 1000) / 1000,
          };
        }).filter(Boolean);
        candidates.sort((a, b) => {
          const aShort = a.textLength <= 44 ? 0 : 1;
          const bShort = b.textLength <= 44 ? 0 : 1;
          return aShort - bShort || a.textLength - b.textLength || b.containerWidth - a.containerWidth;
        });
        const picked = candidates[0] || null;
        const hasTextSizedHitTarget = !picked || (picked.trailingGap >= 16 && picked.fillRatio <= 0.92);
        return {
          surface: ${JSON.stringify(surface)},
          found: !!picked,
          ok: hasTextSizedHitTarget,
          picked,
        };
      })()`,
      returnByValue: true,
    })).result.value || { surface, found: false, ok: false, picked: null };
    titleLinkHitTargets.push(result);
    return result;
  };
  // The stat summary collapses behind a disclosure at narrow widths (incl. the
  // headless default window), so expand it before reading its text.
  const statsTextOf = async () => {
    await send("Runtime.evaluate", {
      expression: "(() => { const d = document.querySelector('.stats-disclosure'); if (d && getComputedStyle(d).display !== 'none' && d.getAttribute('aria-expanded') !== 'true') { d.click(); return 'expanded'; } return 'already-visible'; })()",
    });
    await sleep(60);
    return textOf(".stats");
  };
  const contractRequests = async () =>
    (await send("Runtime.evaluate", {
      expression: "fetch('/__smoke/contract-count').then((res) => res.json()).then((body) => body.contractRequests || 0)",
      awaitPromise: true,
      returnByValue: true,
    })).result.value || 0;
  const rangeRequests = async () =>
    (await send("Runtime.evaluate", {
      expression: "fetch('/__smoke/range-count').then((res) => res.json()).then((body) => body.rangeRequests || 0)",
      awaitPromise: true,
      returnByValue: true,
    })).result.value || 0;
  const activityDailyRequests = async () =>
    (await send("Runtime.evaluate", {
      expression: "fetch('/__smoke/activity-daily-count').then((res) => res.json()).then((body) => body.activityDailyRequests || 0)",
      awaitPromise: true,
      returnByValue: true,
    })).result.value || 0;
  const liveSnapshotRequests = async () =>
    (await send("Runtime.evaluate", {
      expression: "fetch('/__smoke/live-snapshot-count').then((res) => res.json()).then((body) => body.liveSnapshotRequests || 0)",
      awaitPromise: true,
      returnByValue: true,
    })).result.value || 0;
  const liveSnapshotState = async () =>
    (await send("Runtime.evaluate", {
      expression: "fetch('/__smoke/live-snapshot-count').then((res) => res.json())",
      awaitPromise: true,
      returnByValue: true,
    })).result.value || {};
  const rangeButtonLabels = async () =>
    (await send("Runtime.evaluate", {
      expression: "Array.from(document.querySelectorAll('.time-range-controls .toggle')).map((el) => el.textContent?.trim() || '')",
      returnByValue: true,
    })).result.value || [];
  const setControlledInput = async (selector, value) => {
    await send("Runtime.evaluate", {
      expression: `(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        if (!input) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`,
      returnByValue: true,
    });
    await sleep(300);
  };

  // The Live tab is OFF by default, so a hashless first open falls back to
  // Activity with NO Live tab in the bar (and — by design — the live-snapshot
  // probe never fires). Capture that first as the opt-out assertion.
  const liveOffLanding = await waitValue(`(() => {
    const tabs = document.querySelector('.page-tabs');
    if (!tabs) return null;
    return JSON.stringify({ hash: location.hash, hasLiveTab: !!document.querySelector('.tab-live') });
  })()`);
  const liveSnapshotRequestsBeforeEnable = await liveSnapshotRequests();
  // Then enable the Live tab (and pin it as the default) the way Settings would,
  // and reload so the rest of the smoke exercises the realtime feed.
  await send("Runtime.evaluate", {
    expression: "localStorage.setItem('symphony-board:live-tab-enabled','true'); localStorage.setItem('symphony-board:default-tab','live'); localStorage.removeItem('symphony-board:hidden-event-types'); history.replaceState(history.state, '', location.pathname + location.search); location.reload();",
  });
  await sleep(400);
  // With Live enabled and pinned as the default, a hashless open lands on Live;
  // capture it for the default-route assertion (the Live page is
  // contract-independent and renders immediately). Wait until the receiver probe
  // resolves and the Live tab is active (gated on the async liveAvailable probe).
  const defaultLandingHtml = await waitHtml("document.querySelector('.live-page') && document.querySelector('.tab-live.tab-on')");
  // The cold-start boot splash (index.html) must (a) be PRESENT in the served
  // markup — it is painted before any JS runs, so a build that ships no splash
  // element is caught here — and (b) be REMOVED once a real view is ready (never
  // left covering a usable app: the "frozen / blank" regression).
  const bootSplashServed = (await readFile(join(DIST, "index.html"), "utf8")).includes('id="boot-splash"');
  const bootSplashRemoved = await waitValue("document.getElementById('boot-splash') ? null : 'gone'");
  // #488: under the range-as-download model the selected range IS the primary
  // download — there is no separate /api/range OVERLAY and no "Loading range…"
  // spinner anymore; a range change re-fetches the primary env stale-while-
  // revalidate. The invariant this still guards (the original intent): a slow
  // range fetch must NOT tear down the app chrome or blank the board behind the
  // full-screen "Loading contract…" gate — the header, tabs, range controls, AND
  // the already-loaded content stay mounted while the new projection streams in.
  // So: land on Activity (the bootstrap converges to the contract's generated_at
  // week and renders rows), then force a fresh /api/range fetch (a wider custom
  // range, not the static 90-day fast-path) with the range API still delayed and
  // capture that in-flight state before it resolves.
  await send("Runtime.evaluate", { expression: "location.hash = '#/activity'" });
  await waitHtml("document.querySelector('.activity-row')");
  rangeResponseDelayMs = 600;
  await send("Runtime.evaluate", {
    expression: `(() => {
      const input = document.querySelector('.time-range-controls .date-input');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(input, '2026-05-01');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`,
  });
  const initialRangePending = await waitValue(`(() => {
    // The in-flight window: the new /api/range fetch is pending, env is unchanged,
    // so the (stale) feed is still mounted. Wait until it is, then snapshot.
    const rows = document.querySelectorAll('.activity-row').length;
    if (rows === 0) return null;
    return {
      header: !!document.querySelector('.app-header'),
      tabs: !!document.querySelector('.page-tabs'),
      rangeControls: !!document.querySelector('.time-range-controls'),
      // The loaded content is NOT replaced by the full-screen "Loading contract…"
      // gate while revalidating — the previous projection stays visible.
      contentRetained: !document.querySelector('.state-msg') && rows > 0,
    };
  })()`);
  rangeResponseDelayMs = 0;
  await waitHtml("document.querySelector('.activity-page')");
  rangeFailOnce = true;
  await send("Runtime.evaluate", {
    expression: `(() => {
      const input = document.querySelector('.time-range-controls .date-input');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      set?.call(input, '2026-04-15');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`,
  });
  const rangeFailureRetained = await waitValue(`(() => {
    const error = document.querySelector('.state-msg-inline.error');
    const rows = document.querySelectorAll('.activity-row').length;
    if (!error) return null;
    return {
      error: error.textContent || '',
      header: !!document.querySelector('.app-header'),
      tabs: !!document.querySelector('.page-tabs'),
      rangeControls: !!document.querySelector('.time-range-controls'),
      contentRetained: rows > 0,
    };
  })()`);
  await sleep(150);
  const activityDailyBeforeFileUpload = await activityDailyRequests();
  rangeResponseDelayMs = 700;
  await send("Runtime.evaluate", { expression: "document.querySelector('.brand-refresh')?.click()" });
  await sleep(50);
  const fileAuthorityUpload = (await send("Runtime.evaluate", {
    expression: `(async () => {
      location.hash = '#/board';
      const input = document.querySelector('input[type="file"]');
      if (!input) return { input: false };
      const env = await fetch('/contract.json').then((res) => res.json());
      env.contract_version = env.contract_version || '4.4.0';
      env.range_query = {
        kind: 'time_range',
        timezone: env.timezone || 'UTC',
        from: '2026-05-01T00:00:00.000Z',
        to: '2026-06-10T23:59:59.999Z',
      };
      env.timezone = 'UTC';
      env.items = Array.isArray(env.items) ? env.items : [];
      env.items = env.items.map((item, index) => ({
        ...item,
        title: 'uploaded-file-sentinel ' + index,
        window_reasons: ['primary'],
      }));
      env.item_window = {
        ...(env.item_window || {}),
        scope: 'boardWindow',
        window: env.item_window?.window || { kind: 'active_since', basis: 'item_updated_at', since: '2026-05-01T00:00:00.000Z', days: null, edge_filter: null },
        primary_items: env.items.length,
        edge_endpoint_items: env.item_window?.edge_endpoint_items || 0,
        activity_target_items: env.item_window?.activity_target_items || 0,
        total_items: env.item_window?.total_items || env.items.length,
        truncated: !!env.item_window?.truncated,
      };
      const dt = new DataTransfer();
      dt.items.add(new File([JSON.stringify(env)], 'uploaded-range-contract.json', { type: 'application/json' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { input: true, itemCount: env.items.length };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })).result.value || {};
  const fileAuthorityVisible = await waitValue(`(() => {
    if (!document.body.innerText.includes('uploaded-file-sentinel')) return null;
    return {
      hash: location.hash,
      sentinel: document.body.innerText.includes('uploaded-file-sentinel'),
      hasInlineRangeError: !!document.querySelector('.state-msg-inline.error'),
    };
  })()`);
  await sleep(900);
  rangeResponseDelayMs = 0;
  const fileAuthorityAfterPending = (await send("Runtime.evaluate", {
    expression: `(() => ({
      sentinel: document.body.innerText.includes('uploaded-file-sentinel'),
      hasBoardCard: !!document.querySelector('.board-7 .card'),
      hasInlineRangeError: !!document.querySelector('.state-msg-inline.error'),
    }))()`,
    returnByValue: true,
  })).result.value || {};
  const activityDailyAfterFileUpload = await activityDailyRequests();
  await send("Runtime.evaluate", { expression: "location.hash = '#/activity'" });
  await sleep(300);
  // Auto-hiding scrollbars: the styled scrollbars are transparent at rest and only
  // paint while their scroller carries `data-scrolling="true"`. A single
  // capture-phase scroll listener flags the scrolled element and clears it after a
  // short idle. Drive it synchronously: clear the flag, assert it is absent at rest,
  // dispatch a scroll on the viewport (target: document -> documentElement) and on an
  // inner scroller, and assert each one is flagged.
  const scrollAutoHide = (await send("Runtime.evaluate", {
    expression: `(() => {
      const root = document.documentElement;
      root.removeAttribute('data-scrolling');
      const restHidden = !root.hasAttribute('data-scrolling');
      document.dispatchEvent(new Event('scroll'));
      const shownOnPageScroll = root.getAttribute('data-scrolling') === 'true';
      const inner = document.querySelector('.activity-list');
      let shownOnInnerScroll = null;
      if (inner) {
        inner.removeAttribute('data-scrolling');
        inner.dispatchEvent(new Event('scroll'));
        shownOnInnerScroll = inner.getAttribute('data-scrolling') === 'true';
      }
      return { restHidden, shownOnPageScroll, hasInner: !!inner, shownOnInnerScroll };
    })()`,
    returnByValue: true,
  })).result.value || {};
  const colorSchemeHints = (await send("Runtime.evaluate", {
    expression: `(() => ({
      colorScheme: document.querySelector('meta[name="color-scheme"]')?.getAttribute('content') || '',
      supportedColorSchemes: document.querySelector('meta[name="supported-color-schemes"]')?.getAttribute('content') || '',
    }))()`,
    returnByValue: true,
  })).result.value || {};
  // #488: the header refresh reloads the PRIMARY env in place — which is now the
  // selected range via /api/range (not ./contract.json, used only for the
  // default-90d / static-deploy fast-path the smoke is not on). So count range
  // requests for the reload assertion, and delay the RANGE response (not the
  // contract one) so the busy refresh glyph is observable mid-load.
  const headerRefreshBefore = await rangeRequests();
  const headerRefreshHashBefore = (await send("Runtime.evaluate", { expression: "location.hash", returnByValue: true })).result.value || "";
  rangeResponseDelayMs = 250;
  const headerRefresh = (await send("Runtime.evaluate", {
    expression: `(() => {
      const btn = document.querySelector('.brand-refresh');
      const idleIcon = btn?.querySelector('.brand-refresh-app-icon');
      btn?.click();
      return {
        title: document.querySelector('.brand h1')?.textContent?.trim() || '',
        hasButton: !!btn,
        hasIdleAppIcon: !!idleIcon,
        idleIconTag: idleIcon?.tagName?.toLowerCase() || '',
        idleIconViewBox: idleIcon?.getAttribute('viewBox') || '',
        label: btn?.getAttribute('aria-label') || '',
        clicked: !!btn,
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await sleep(80);
  headerRefresh.hasBusyRefreshGlyph = (await send("Runtime.evaluate", {
    expression: "!!document.querySelector('.brand-refresh .brand-refresh-glyph')",
    returnByValue: true,
  })).result.value === true;
  await sleep(400);
  rangeResponseDelayMs = 0;
  headerRefresh.requestsBefore = headerRefreshBefore;
  headerRefresh.requestsAfter = await rangeRequests();
  headerRefresh.hashBefore = headerRefreshHashBefore;
  headerRefresh.hashAfter = (await send("Runtime.evaluate", { expression: "location.hash", returnByValue: true })).result.value || "";
  headerRefresh.restoredAppIcon = (await send("Runtime.evaluate", {
    expression: "!!document.querySelector('.brand-refresh .brand-refresh-app-icon')",
    returnByValue: true,
  })).result.value === true;
  await send("Emulation.setDeviceMetricsOverride", { width: 1880, height: 1100, deviceScaleFactor: 1, mobile: false });
  await sleep(100);
  await send("Runtime.evaluate", { expression: "location.hash = '#/board'" });
  await sleep(300);
  // Page 1 — the full-bleed 7-column board.
  const boardHtml = await waitHtml("document.querySelector('.board-7 .card')");
  await captureTitleLinkHitTarget("board card", ".board-7 .card-title[href]", ".card");
  const boardPaneLayout = (await send("Runtime.evaluate", {
    expression: `(() => {
      const column = Array.from(document.querySelectorAll('.board-7 .col'))
        .find((el) => getComputedStyle(el).display !== 'none' && !el.classList.contains('col-collapsed'));
      const rect = column?.getBoundingClientRect();
      return {
        found: !!rect,
        height: Math.round(rect?.height || 0),
        bottomGap: rect ? Math.round(window.innerHeight - rect.bottom) : 0,
        fillsViewport: !!rect && window.innerHeight - rect.bottom >= 8 && window.innerHeight - rect.bottom <= 32,
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  const boardCardChrome = (await send("Runtime.evaluate", {
    expression: `(() => {
      const card = document.querySelector('.board-7 .card');
      const icon = card?.querySelector('.card-kind-icon');
      const badge = card?.querySelector('.badge');
      const title = card?.querySelector('.card-title');
      const iconRect = icon?.getBoundingClientRect();
      const badgeRect = badge?.getBoundingClientRect();
      const titleRect = title?.getBoundingClientRect();
      return {
        found: !!(iconRect && badgeRect && titleRect),
        iconRight: Math.round(iconRect?.right || 0),
        badgeLeft: Math.round(badgeRect?.left || 0),
        titleLeft: Math.round(titleRect?.left || 0),
        badgeStartsAfterIcon: !!(iconRect && badgeRect) && badgeRect.left >= iconRect.right + 6,
        titleStartsAfterIcon: !!(iconRect && titleRect) && titleRect.left >= iconRect.right + 6,
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  const boardRangeButtons = await rangeButtonLabels();
  const boardInitialStats = await statsTextOf();
  await send("Runtime.evaluate", {
    expression: "Array.from(document.querySelectorAll('.time-range-controls .toggle')).find((el) => el.textContent?.trim() === 'this week')?.click()",
  });
  await waitHtml("location.hash.includes('preset=this-week') && !document.body.innerText.includes('Loading range')");
  const boardThisWeekClick = (await send("Runtime.evaluate", {
    expression: `(() => ({
      hash: location.hash,
      active: Array.from(document.querySelectorAll('.time-range-controls .toggle-on'))
        .map((el) => el.textContent?.trim())
        .filter(Boolean),
    }))()`,
    returnByValue: true,
  })).result.value || {};
  await setControlledInput(".time-range-controls label:nth-of-type(1) input", "2026-06-10");
  const boardNarrowHtml = await waitHtml("document.querySelector('.board-7 .card') && !document.body.innerText.includes('Loading range')");
  const boardNarrowStats = await statsTextOf();
  // Page 2 — the relationship graph (React Flow renders DOM card nodes; assert
  // the page, count label, and at least one node mount cleanly and the lazy
  // chunk loads without errors).
  // The canvas only renders above the mobile breakpoint (the List/Graph toggle
  // shows the list alone on narrow viewports), so pin a desktop width for this
  // desktop graph capture — otherwise the canvas is absent and the shared
  // waitHtml deadline would be burned waiting for a React Flow node.
  await send("Emulation.setDeviceMetricsOverride", { width: 1880, height: 1100, deviceScaleFactor: 1, mobile: false });
  await sleep(100);
  await send("Runtime.evaluate", { expression: "location.hash = '#/graph'" });
  await sleep(400);
  const graphHtml = await waitHtml("document.querySelector('.react-flow__node')");
  await captureTitleLinkHitTarget("graph canvas node", ".graph-page .rf-node-title[href]", ".rf-node");
  const graphPaneLayout = (await send("Runtime.evaluate", {
    expression: `(() => {
      const list = document.querySelector('.graph-list');
      const canvas = document.querySelector('.graph-canvas');
      const listRect = list?.getBoundingClientRect();
      const canvasRect = canvas?.getBoundingClientRect();
      const totalWidth = listRect && canvasRect ? canvasRect.right - listRect.left : 0;
      const listShare = totalWidth > 0 ? Math.round((listRect.width / totalWidth) * 1000) / 1000 : 0;
      const bottomGap = listRect && canvasRect ? window.innerHeight - Math.max(listRect.bottom, canvasRect.bottom) : 0;
      return {
        found: !!(listRect && canvasRect),
        listWidth: Math.round(listRect?.width || 0),
        canvasWidth: Math.round(canvasRect?.width || 0),
        listHeight: Math.round(listRect?.height || 0),
        canvasHeight: Math.round(canvasRect?.height || 0),
        listShare,
        heightsMatch: !!(listRect && canvasRect) && Math.abs(listRect.height - canvasRect.height) <= 2,
        masterDetailShare: listShare >= 0.30 && listShare <= 0.36,
        fillsViewport: !!(listRect && canvasRect) && bottomGap >= 8 && bottomGap <= 32,
        bottomGap: Math.round(bottomGap),
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  // The mounted canvas pane reads the theme base, not ReactFlow's default dark
  // pane grey (#141414 → rgb(20, 20, 20)): .graph-canvas re-points RF's
  // --xy-background-color at --bg, so the resolved .react-flow background must be
  // the night-owl --bg (#011627 → rgb(1, 22, 39)). Regression guard for the
  // off-theme-grey fix; would fail on RF's default fill.
  const graphCanvasPaneBg = ((await send("Runtime.evaluate", {
    expression: "getComputedStyle(document.querySelector('.react-flow')).backgroundColor",
    returnByValue: true,
  })).result.value || "").trim();
  // Real layout measurement: no node's content may vertically overflow its
  // fixed-size box (the regression mode when a meta row gains a chip and wraps).
  const graphNodeOverflow = (await send("Runtime.evaluate", {
    expression:
      "JSON.stringify([...document.querySelectorAll('.rf-node')].filter((n) => n.scrollHeight > n.clientHeight + 1).map((n) => ({ sh: n.scrollHeight, ch: n.clientHeight, t: (n.querySelector('.rf-node-title')?.textContent || '').slice(0, 30) })))",
    returnByValue: true,
  })).result.value ?? "null";
  const graphNodeOverflows = JSON.parse(graphNodeOverflow) ?? [];
  const graphRangeButtons = await rangeButtonLabels();
  const graphInitialStats = await statsTextOf();
  await setControlledInput(".time-range-controls label:nth-of-type(1) input", "2026-06-10");
  await waitHtml("document.querySelector('.react-flow__node') && !document.body.innerText.includes('Loading range')");
  const graphNarrowStats = await statsTextOf();
  await setControlledInput(".time-range-controls label:nth-of-type(1) input", "2026-03-01");
  await waitHtml("document.querySelector('.react-flow__node') && !document.body.innerText.includes('Loading range')");
  // Graph side list: capture the (enriched) list cards, then click one to enter
  // the focus view and confirm the back button + related-items header render.
  await waitHtml("document.querySelector('.graph-list-card')");
  await captureTitleLinkHitTarget("graph list card", ".graph-page .graph-list-card .card-title[href]", ".graph-list-card .card");
  const graphCardChrome = (await send("Runtime.evaluate", {
    expression: `(() => {
      const card = document.querySelector('.graph-page .graph-list-card .card');
      const icon = card?.querySelector('.card-kind-icon');
      const badge = card?.querySelector('.badge');
      const title = card?.querySelector('.card-title');
      const iconRect = icon?.getBoundingClientRect();
      const badgeRect = badge?.getBoundingClientRect();
      const titleRect = title?.getBoundingClientRect();
      return {
        found: !!(iconRect && badgeRect && titleRect),
        iconRight: Math.round(iconRect?.right || 0),
        badgeLeft: Math.round(badgeRect?.left || 0),
        titleLeft: Math.round(titleRect?.left || 0),
        badgeStartsAfterIcon: !!(iconRect && badgeRect) && badgeRect.left >= iconRect.right + 6,
        titleStartsAfterIcon: !!(iconRect && titleRect) && titleRect.left >= iconRect.right + 6,
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  const graphListHtml = (await send("Runtime.evaluate", { expression: "document.body.innerHTML", returnByValue: true })).result.value || "";
  await send("Runtime.evaluate", { expression: "document.querySelector('.graph-list-card')?.click()" });
  await sleep(400);
  const focusHtml = (await send("Runtime.evaluate", { expression: "document.body.innerHTML", returnByValue: true })).result.value || "";
  const focusStats = await statsTextOf();
  // Re-click the focused (active) card to toggle focus OFF — it returns to the
  // searchable list, the same exit as "← all items". Then re-enter focus so the
  // back-button assertion below still exercises that path.
  await send("Runtime.evaluate", { expression: "document.querySelector('.graph-list-card.active')?.click()" });
  await sleep(300);
  const toggleOffHtml = (await send("Runtime.evaluate", { expression: "document.body.innerHTML", returnByValue: true })).result.value || "";
  await send("Runtime.evaluate", { expression: "document.querySelector('.graph-list-card')?.click()" });
  await sleep(300);
  // Click "← all items" and confirm the searchable list returns.
  await send("Runtime.evaluate", { expression: "document.querySelector('.graph-list-back')?.click()" });
  await sleep(300);
  const backHtml = (await send("Runtime.evaluate", { expression: "document.body.innerHTML", returnByValue: true })).result.value || "";
  // Page 3 — the Activity feed: developer-significant events from item state
  // transitions plus provider REST activity surfaces.
  await send("Emulation.setDeviceMetricsOverride", { width: 1880, height: 1100, deviceScaleFactor: 1, mobile: false });
  await sleep(100);
  await send("Runtime.evaluate", { expression: "location.hash = '#/activity'" });
  await sleep(300);
  const activityHtml = await waitHtml("document.querySelector('.activity-row')");
  await captureTitleLinkHitTarget("activity row", ".activity-page .activity-title[href]", ".activity-row");
  const activityRangeButtons = await rangeButtonLabels();
  const activityCountText = await textOf(".activity-head .count");
  const activityDomRows = (await send("Runtime.evaluate", {
    expression: "document.querySelectorAll('.activity-row').length",
    returnByValue: true,
  })).result.value || 0;
  // Facet chips on the Activity feed are route-backed: clicking one must BOTH
  // write the filter into the URL and light the chip up. The reported bug was a
  // drill-down narrowing the feed while its chip stayed dark, so this is the
  // end-to-end lock for that contract. Toggle a kind chip, assert hash + chip
  // agree, then clear it so the feed returns to its unfiltered default for the
  // assertions below.
  const kindGroupExpr = `Array.from(document.querySelectorAll('.controls .toggle-group')).find((g) => g.querySelector('.toggle-label')?.textContent === 'kind')`;
  const activityFacetInitial = (await send("Runtime.evaluate", {
    expression: `(() => {
      const group = ${kindGroupExpr};
      const chip = group?.querySelector('.toggle');
      return { hasGroup: !!group, value: chip?.textContent?.trim() || null, anyOn: !!group?.querySelector('.toggle.toggle-on'), hashHasKind: location.hash.includes('kind=') };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await send("Runtime.evaluate", { expression: `(() => { ${kindGroupExpr}?.querySelector('.toggle')?.click(); })()` });
  await sleep(250);
  const activityFacetOn = (await send("Runtime.evaluate", {
    expression: `(() => {
      const group = ${kindGroupExpr};
      const on = group?.querySelector('.toggle.toggle-on');
      return { hash: location.hash, chipOn: !!on, chipText: on?.textContent?.trim() || null, onCount: group?.querySelectorAll('.toggle.toggle-on').length || 0 };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await send("Runtime.evaluate", { expression: `(() => { ${kindGroupExpr}?.querySelector('.toggle.toggle-on')?.click(); })()` });
  await sleep(250);
  const activityFacetCleared = (await send("Runtime.evaluate", {
    expression: `(() => ({ hashHasKind: location.hash.includes('kind='), anyOn: !!${kindGroupExpr}?.querySelector('.toggle.toggle-on') }))()`,
    returnByValue: true,
  })).result.value || {};
  const activityRangeInputs = (await send("Runtime.evaluate", {
    expression: `(() => {
      const rangeInputs = Array.from(document.querySelectorAll('.time-range-controls .date-input'));
      const pickerButtons = Array.from(document.querySelectorAll('.time-range-controls .date-picker-button'));
      const wraps = Array.from(document.querySelectorAll('.time-range-controls .date-input-wrap'));
      pickerButtons[0]?.click();
      return {
        from: rangeInputs[0]?.value || '',
        to: rangeInputs[1]?.value || '',
        types: rangeInputs.map((input) => input.type),
        placeholders: rangeInputs.map((input) => input.getAttribute('placeholder') || ''),
        pickerButtons: pickerButtons.length,
        wrapWidths: wraps.map((el) => Math.round(el.getBoundingClientRect().width)),
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await sleep(50);
  const activityDatePicker = (await send("Runtime.evaluate", {
    expression: `(() => ({
      open: !!document.querySelector('.date-picker-popover'),
      days: document.querySelectorAll('.date-picker-popover .date-picker-day').length,
    }))()`,
    returnByValue: true,
  })).result.value || {};
  // The rhythm heatmap tints the cells inside the feed's selected range (default
  // "this week") a distinct blue over the green density ramp. Count grid cells
  // (excluding the legend) vs the in-range subset to prove the overlay renders and
  // stays scoped to the range — not the whole grid. Guarded by `present` so this
  // no-ops if the sample contract ever ages past the trailing-12-month window.
  const activityHeatmap = (await send("Runtime.evaluate", {
    expression: `(() => {
      const heatmap = document.querySelector('.activity-heatmap');
      if (!heatmap) return { present: false, total: 0, inRange: 0, columns: 0, summary: false, overviewLabels: [], rangeLabels: [], scope: false, trend: false, trendBucket: null, trendScope: false, rangeSummary: false, rangeRepos: 0, rangeReposSorted: false, balancedHeight: false, listHeight: 0, panelHeight: 0 };
      const repoCounts = Array.from(heatmap.querySelectorAll('.hm-range-repos li b')).map((node) => Number((node.textContent || '').replace(/,/g, '')));
      const overviewScope = heatmap.querySelector(':scope > .hm-overview-head small')?.textContent || '';
      const overviewLabels = Array.from(heatmap.querySelectorAll(':scope > .hm-summary dt')).map((node) => node.textContent?.trim() || '');
      const rangeLabels = Array.from(heatmap.querySelectorAll('.hm-range-summary dt')).map((node) => node.textContent?.trim() || '');
      const listHeight = Math.round(document.querySelector('.activity-list')?.getBoundingClientRect().height || 0);
      const panelHeight = Math.round(heatmap.getBoundingClientRect().height || 0);
      const wideLayout = window.matchMedia('(min-width: 1451px)').matches;
      return {
        present: true,
        total: heatmap.querySelectorAll('.hm-grid .hm-cell:not(.hm-cell-empty)').length,
        inRange: heatmap.querySelectorAll('.hm-grid .hm-cell[data-in-range]').length,
        columns: heatmap.querySelectorAll('.hm-grid .hm-col').length,
        summary: !!heatmap.querySelector('.hm-summary dd'),
        overviewLabels,
        scope: overviewScope.includes('last 12 months') && overviewScope.includes(' to '),
        trend: !!heatmap.querySelector('.hm-trend-line[d]'),
        trendBucket: heatmap.querySelector('.hm-trend')?.getAttribute('data-bucket') || null,
        trendScope: (heatmap.querySelector('.hm-trend-head small')?.textContent || '').includes(' to '),
        rangeSummary: !!heatmap.querySelector('.hm-range-summary dd'),
        rangeLabels,
        rangeRepos: repoCounts.length,
        rangeReposSorted: repoCounts.length > 0 && repoCounts.every((count, index) => index === 0 || repoCounts[index - 1] >= count),
        balancedHeight: !wideLayout || listHeight + 1 >= panelHeight,
        listHeight,
        panelHeight,
      };
    })()`,
    returnByValue: true,
  })).result.value || { present: false, total: 0, inRange: 0, columns: 0, summary: false, overviewLabels: [], rangeLabels: [], scope: false, trend: false, trendBucket: null, trendScope: false, rangeSummary: false, rangeRepos: 0, rangeReposSorted: false, balancedHeight: false, listHeight: 0, panelHeight: 0 };
  // Trend hover: dispatch a mouseover on a hit band (React's onMouseEnter listens
  // to bubbled mouseover) and expect the shared per-line tooltip plus the
  // enlarged focus dot. Guarded by `present`, like the heatmap checks above.
  await send("Runtime.evaluate", {
    expression: `(() => {
      const hit = document.querySelector('.hm-trend .hm-trend-hit');
      if (!hit) return;
      const rect = hit.getBoundingClientRect();
      hit.dispatchEvent(new MouseEvent('mouseover', {
        bubbles: true,
        clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2,
      }));
    })()`,
  });
  await sleep(100);
  const trendHover = (await send("Runtime.evaluate", {
    expression: `(() => {
      const tipText = document.querySelector('.hm-tip')?.textContent || '';
      return {
        hits: document.querySelectorAll('.hm-trend .hm-trend-hit').length,
        legend: document.querySelectorAll('.hm-trend-legend .hm-trend-legend-item').length,
        lines: document.querySelectorAll('.hm-trend-chart .hm-trend-line').length,
        tip: tipText.includes('total') && /\\d/.test(tipText),
        focus: !!document.querySelector('.hm-trend-dot-focus'),
      };
    })()`,
    returnByValue: true,
  })).result.value || { hits: 0, legend: 0, lines: 0, tip: false, focus: false };
  const activityBreakpoint = {};
  for (const width of [1450, 1451]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(80);
    activityBreakpoint[String(width)] = (await send("Runtime.evaluate", {
      expression: `(() => {
        const layout = document.querySelector('.activity-layout');
        const list = document.querySelector('.activity-list');
        const panel = document.querySelector('.activity-heatmap');
        const layoutStyle = layout ? getComputedStyle(layout) : null;
        const listRect = list?.getBoundingClientRect();
        const panelRect = panel?.getBoundingClientRect();
        return {
          columns: layoutStyle?.gridTemplateColumns || '',
          gap: layoutStyle?.columnGap || '',
          stacked: !!listRect && !!panelRect && panelRect.top > listRect.bottom - 2,
          sideBySide: !!listRect && !!panelRect && Math.abs(panelRect.top - listRect.top) <= 2 && panelRect.left > listRect.right,
        };
      })()`,
      returnByValue: true,
    })).result.value || {};
  }
  // Page 3b — Items: a chronological issue + PR/MR lookup surface over items[].
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(100);
  await send("Runtime.evaluate", { expression: "location.hash = '#/items'" });
  await sleep(300);
  const itemsHtml = await waitHtml("document.querySelector('.items-page .item-row')");
  await captureTitleLinkHitTarget("items row", ".items-page .item-row-title[href]", ".item-row");
  await captureTitleLinkHitTarget("items detail", ".items-page .items-detail-title-link", ".items-detail-title");
  const itemsRangeButtons = await rangeButtonLabels();
  const itemsCountText = await textOf(".items-head .count");
  const itemsSummary = (await send("Runtime.evaluate", {
    expression: `new Promise((resolve) => {
      const rows = Array.from(document.querySelectorAll('.items-page .item-row'));
      const first = rows[0];
      const second = rows[1];
      const firstTitle = first?.querySelector('.item-row-title')?.textContent?.trim() || '';
      const secondTitle = second?.querySelector('.item-row-title')?.textContent?.trim() || '';
      const initialDetailTitle = document.querySelector('.items-page .items-detail-title')?.textContent?.trim() || '';
      second?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      setTimeout(() => {
        const afterClickDetailTitle = document.querySelector('.items-page .items-detail-title')?.textContent?.trim() || '';
        const listBox = document.querySelector('.items-page .items-list')?.getBoundingClientRect();
        const detailBox = document.querySelector('.items-page .items-detail')?.getBoundingClientRect();
        const detailCardBox = document.querySelector('.items-page .items-detail-card')?.getBoundingClientRect();
        const bottomGap = listBox && detailBox ? window.innerHeight - Math.max(listBox.bottom, detailBox.bottom) : 0;
        const kindGroup = Array.from(document.querySelectorAll('.controls .toggle-group'))
          .find((g) => g.querySelector('.toggle-label')?.textContent === 'kind');
        resolve({
          rows: rows.length,
          providerLinks: Array.from(document.querySelectorAll('.items-page .item-row-title[href]')).length,
          graphLinks: Array.from(document.querySelectorAll('.items-page .item-row-graph[href^="#/graph"]')).length,
          detailMetricGraphLinks: Array.from(document.querySelectorAll('.items-page .items-detail .item-metric-related[href^="#/graph"]')).length,
          firstUpdated: first?.querySelector('time[title]')?.textContent || '',
          split: !!document.querySelector('.items-page .items-split'),
          detail: !!document.querySelector('.items-page .items-detail'),
          detailBodyText: document.querySelector('.items-page .items-detail-body')?.textContent?.trim() || '',
          selectedRows: document.querySelectorAll('.items-page .item-row-selected').length,
          firstTitle,
          secondTitle,
          initialDetailTitle,
          afterClickDetailTitle,
          listLeftOfDetail: !!listBox && !!detailBox && listBox.left < detailBox.left && listBox.right <= detailBox.left + 24,
          listHeight: Math.round(listBox?.height || 0),
          detailHeight: Math.round(detailBox?.height || 0),
          detailCardHeight: Math.round(detailCardBox?.height || 0),
          detailFillsListHeight: !!listBox && !!detailBox && detailBox.height >= listBox.height - 2,
          detailCardFillsPane: !!detailBox && !!detailCardBox && detailCardBox.height >= detailBox.height - 2,
          bottomGap: Math.round(bottomGap),
          fillsViewport: !!listBox && !!detailBox && bottomGap >= 8 && bottomGap <= 32,
          hasKindGroup: !!kindGroup,
          kindChips: Array.from(kindGroup?.querySelectorAll('.toggle') || []).map((el) => el.textContent?.trim() || ''),
        });
      }, 0);
    })`,
    awaitPromise: true,
    returnByValue: true,
  })).result.value || {};
  // Page 3c — Commits: a focused, GitHub-like commit log with SCM filters. Repo
  // uses the self-styled combobox; branch uses optional commit ref details when
  // present. The smoke inflation above adds synthetic refs to exercise that path
  // without changing the tracked sample contract.
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(100);
  await send("Runtime.evaluate", { expression: "location.hash = '#/commits'" });
  await sleep(300);
  const commitsHtml = await waitHtml("document.querySelector('.commits-page .commit-row')");
  await captureTitleLinkHitTarget("commits row", ".commits-page .commit-message-link[href]", ".commit-row-body");
  // The repo + branch filters collapse by default at narrow widths; expand them
  // so the toolbar layout / chrome / combobox checks below can see the controls.
  await send("Runtime.evaluate", {
    expression:
      "(() => { const d = document.querySelector('.commits-filter-disclosure'); if (d && getComputedStyle(d).display !== 'none' && d.getAttribute('aria-expanded') !== 'true') { d.click(); return 'expanded'; } return 'already-visible'; })()",
  });
  await sleep(150);
  const commitsRangeButtons = await rangeButtonLabels();
  const commitsCountText = await textOf(".commits-page .count");
  const commitsRowsAll = (await send("Runtime.evaluate", {
    expression: "document.querySelectorAll('.commits-page .commit-row').length",
    returnByValue: true,
  })).result.value || 0;
  const commitsHasCommitLink = (await send("Runtime.evaluate", {
    expression: "Array.from(document.querySelectorAll('.commits-page a.commit-message-link')).some((a) => (a.getAttribute('href') || '').includes('/commit'))",
    returnByValue: true,
  })).result.value || false;
  const commitsHasCopyHash = (await send("Runtime.evaluate", {
    expression: "document.querySelectorAll('.commits-page button[aria-label^=\"Copy commit hash\"]').length > 0",
    returnByValue: true,
  })).result.value || false;
  const commitsDateSlotsHaveLabels = (await send("Runtime.evaluate", {
    expression: `Array.from(document.querySelectorAll('.commits-page .commit-date-slot'))
      .every((el) => (el.textContent || '').includes('Commits on '))`,
    returnByValue: true,
  })).result.value || false;
  const commitsDateSlotsAreGrouped = (await send("Runtime.evaluate", {
    expression: "document.querySelectorAll('.commits-page .commit-date-slot').length < document.querySelectorAll('.commits-page .commit-row').length",
    returnByValue: true,
  })).result.value || false;
  const commitsBodyButtons = (await send("Runtime.evaluate", {
    expression: "document.querySelectorAll('.commits-page button[aria-label^=\"Show commit body\"]').length",
    returnByValue: true,
  })).result.value || 0;
  const commitsToolbarLayout = (await send("Runtime.evaluate", {
    expression: `(() => {
      const visible = (selector, root = document) => Array.from(root.querySelectorAll(selector))
        .find((el) => getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0);
      const toolbar = visible('.commits-page .commits-toolbar');
      const repoFilter = toolbar?.querySelector(':scope > .commits-filter');
      const repoInput = repoFilter?.querySelector('input.search');
      const repoField = repoFilter?.querySelector('.repo-combobox-field');
      const branch = toolbar?.querySelector(':scope > .commit-branch-select');
      const bodyButton = document.querySelector('.commits-page button[aria-label^="Show commit body"], .commits-page button[aria-label^="Hide commit body"]');
      if (!repoFilter || !repoInput || !branch) return { repoBeforeBranch: false, topAligned: false, bodyToggleHasNoTitle: false };
      const repoRect = repoInput.getBoundingClientRect();
      const filterRect = repoFilter.getBoundingClientRect();
      const branchRect = branch.getBoundingClientRect();
      const repoFieldRect = repoField ? repoField.getBoundingClientRect() : null;
      const stacked = getComputedStyle(toolbar).flexDirection === 'column';
      const stackedGap = branchRect.top - filterRect.bottom;
      return {
        repoBeforeBranch: !!(repoFilter.compareDocumentPosition(branch) & Node.DOCUMENT_POSITION_FOLLOWING),
        topAligned: stacked ? stackedGap >= 8 && stackedGap <= 14 : Math.abs(repoRect.top - branchRect.top) <= 2,
        topDelta: Math.round((stacked ? stackedGap : repoRect.top - branchRect.top) * 10) / 10,
        stacked,
        // The repo combobox and branch picker should share the same pill chrome.
        chromeHeightsMatch: !!repoFieldRect && Math.abs(Math.round(repoFieldRect.height) - Math.round(branchRect.height)) <= 1,
        repoFieldHeight: repoFieldRect ? Math.round(repoFieldRect.height) : 0,
        branchHeight: Math.round(branchRect.height),
        bodyToggleHasNoTitle: !!bodyButton && !bodyButton.hasAttribute('title'),
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  const commitsBodyTogglePlacement = (await send("Runtime.evaluate", {
    expression: `(() => {
      const line = Array.from(document.querySelectorAll('.commits-page .commit-title-line'))
        .find((el) => el.querySelector('.commit-body-toggle'));
      if (!line) return { rendered: false, sameLine: false, hugsTitle: false };
      const message = line.querySelector('.commit-message-link');
      const button = line.querySelector('.commit-body-toggle');
      const main = line.closest('.commit-row-main');
      if (!message || !button || !main) return { rendered: false, sameLine: false, hugsTitle: false };
      const lineRect = line.getBoundingClientRect();
      const messageRect = message.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      const mainRect = main.getBoundingClientRect();
      return {
        rendered: true,
        sameLine: Math.abs((messageRect.top + messageRect.bottom) / 2 - (buttonRect.top + buttonRect.bottom) / 2) <= 8,
        hugsTitle: mainRect.width - lineRect.width >= 80,
        lineWidth: Math.round(lineRect.width),
        mainWidth: Math.round(mainRect.width),
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  const commitsRowBodyGap = (await send("Runtime.evaluate", {
    expression: `(() => {
      const rows = Array.from(document.querySelectorAll('.commits-page .commit-row-body'))
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom };
        })
        .sort((a, b) => a.top - b.top);
      const gaps = [];
      for (let i = 1; i < rows.length; i += 1) gaps.push(Math.round(rows[i].top - rows[i - 1].bottom));
      return {
        count: gaps.length,
        minGap: gaps.length ? Math.min(...gaps) : null,
        gaps,
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await send("Runtime.evaluate", {
    expression: "document.querySelector('.commits-page button[aria-label^=\"Show commit body\"]')?.click()",
  });
  await sleep(350);
  const commitsBodyExpanded = (await send("Runtime.evaluate", {
    expression: `(() => {
      const panel = document.querySelector('.commits-page .commit-body-panel');
      return !!panel && (panel.textContent || '').includes('Rendered commit body details.');
    })()`,
    returnByValue: true,
  })).result.value || false;
  const commitsExpandedBodyLayout = (await send("Runtime.evaluate", {
    expression: `(() => {
      const panel = document.querySelector('.commits-page .commit-body-panel');
      const row = panel?.closest('.commit-row');
      const body = row?.querySelector('.commit-row-body');
      const main = row?.querySelector('.commit-row-main');
      const actions = row?.querySelector('.commit-row-actions');
      const panelRect = panel?.getBoundingClientRect();
      const rowRect = row?.getBoundingClientRect();
      const bodyRect = body?.getBoundingClientRect();
      const mainRect = main?.getBoundingClientRect();
      const actionsRect = actions?.getBoundingClientRect();
      const contentBottom = Math.max(mainRect?.bottom ?? 0, actionsRect?.bottom ?? 0);
      const bodies = Array.from(document.querySelectorAll('.commits-page .commit-row-body'))
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return { el, top: rect.top, bottom: rect.bottom };
        })
        .sort((a, b) => a.top - b.top);
      const index = body ? bodies.findIndex((entry) => entry.el === body) : -1;
      const afterGap = index >= 0 && bodies[index + 1] ? Math.round(bodies[index + 1].top - bodies[index].bottom) : null;
      const panelStyle = panel ? getComputedStyle(panel) : null;
      return {
        afterGap,
        bodyTrailingGap: bodyRect && panelRect ? Math.round(bodyRect.bottom - panelRect.bottom) : null,
        bodyContentTrailingGap: bodyRect && contentBottom > 0 ? Math.round(bodyRect.bottom - contentBottom) : null,
        mainTrailingGap: mainRect && panelRect ? Math.round(mainRect.bottom - panelRect.bottom) : null,
        rowTrailingGap: rowRect && bodyRect ? Math.round(rowRect.bottom - bodyRect.bottom) : null,
        overflowY: panelStyle?.overflowY || null,
        scrollHeight: panel?.scrollHeight || null,
        clientHeight: panel?.clientHeight || null,
        scrollsInternally: panel ? panel.scrollHeight > panel.clientHeight + 1 && ['auto', 'scroll'].includes(panelStyle?.overflowY || '') : null,
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  const commitsBranchControl = (await send("Runtime.evaluate", {
    expression: `(() => {
      const select = document.querySelector('.commit-branch-select select');
      return {
        rendered: !!select,
        enabled: !!select && !select.disabled,
        options: select ? select.options.length : 0,
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  const commitsNoDatalist = (await send("Runtime.evaluate", {
    expression: "document.querySelectorAll('datalist, #commit-repo-options').length === 0",
    returnByValue: true,
  })).result.value || false;
  // Open the combobox (focus + click both set it open) and inspect the styled list.
  await send("Runtime.evaluate", {
    expression: "(() => { const i = Array.from(document.querySelectorAll('.commits-filter input.search')).find((el) => getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0); if (i) { i.focus(); i.click(); } })()",
  });
  await sleep(250);
  const commitsCombo = (await send("Runtime.evaluate", {
    expression: `(() => ({
      styledList: !!document.querySelector('.repo-combobox-list'),
      options: document.querySelectorAll('.repo-combobox-option').length,
    }))()`,
    returnByValue: true,
  })).result.value || {};
  // Pick the GitLab repo by mouse-down on its option (commit fires before blur).
  await send("Runtime.evaluate", {
    expression: `(() => {
      const opt = Array.from(document.querySelectorAll('.repo-combobox-option'))
        .find((el) => (el.textContent || '').includes('example-group/symphony-board-fixture'));
      if (opt) opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    })()`,
  });
  await sleep(250);
  const commitsFiltered = (await send("Runtime.evaluate", {
    expression: `(() => ({
      hash: location.hash,
      rows: document.querySelectorAll('.commits-page .commit-row').length,
      inputValue: (Array.from(document.querySelectorAll('.commits-filter input.search')).find((el) => getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0))?.value || '',
      onlyPicked: Array.from(document.querySelectorAll('.commits-page .commit-row-meta'))
        .every((el) => (el.textContent || '').includes('example-group/symphony-board-fixture')),
    }))()`,
    returnByValue: true,
  })).result.value || {};
  // Page 4 — Repo Analytics: the per-repo contract metrics table and trends.
  await send("Runtime.evaluate", { expression: "location.hash = '#/repo-analytics'" });
  await sleep(300);
  const repoHtml = await waitHtml("document.querySelector('.repo-table tbody tr')");
  await captureTitleLinkHitTarget("metrics repo", ".repo-analytics-page .repo-provider-link[href]", ".repo-name-main");
  const repoRangeButtons = await rangeButtonLabels();
  const repoCountText = await textOf(".repo-analytics-head .count");
  const repoQualityBadgeLayout = (await send("Runtime.evaluate", {
    expression: `(() => {
      const badges = Array.from(document.querySelectorAll('.repo-table td:nth-child(13) .badge'));
      const widths = badges.map((el) => Math.round(el.getBoundingClientRect().width));
      // Tolerance, not pixel-identity: the quality verdicts (active / partial /
      // idle / no data) are different proportional-font strings, so their compact
      // badges differ by a few px. The real guard is "no badge sprawls to the
      // column width", anchored by the maxWidth <= 56 check below; this only
      // rejects a gross outlier (~8px covers the verdict-text spread; sprawl 30px+).
      const min = widths.length ? Math.min(...widths) : 0;
      const max = widths.length ? Math.max(...widths) : 0;
      return {
        count: badges.length,
        maxWidth: max,
        sameWidth: max - min <= 8,
        texts: badges.map((el) => el.textContent?.trim() || ''),
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  const repoLinks = (await send("Runtime.evaluate", {
    expression: `(() => {
      const providerLinks = Array.from(document.querySelectorAll('.repo-provider-link'))
        .map((el) => el.getAttribute('href') || '');
      const metricLinks = Array.from(document.querySelectorAll('.repo-metric-link'))
        .map((el) => el.getAttribute('href') || '');
      return { providerLinks, metricLinks };
    })()`,
    returnByValue: true,
  })).result.value || { providerLinks: [], metricLinks: [] };
  await send("Emulation.setDeviceMetricsOverride", { width: 3440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await sleep(100);
  const repoTableLayout = (await send("Runtime.evaluate", {
    expression: `(() => {
      const table = document.querySelector('.repo-table');
      const wrap = document.querySelector('.repo-table-wrap');
      const headers = Array.from(document.querySelectorAll('.repo-table thead th'));
      const widthOf = (idx) => Math.round(headers[idx]?.getBoundingClientRect().width || 0);
      const numericWidths = headers.slice(2, 12).map((el) => Math.round(el.getBoundingClientRect().width));
      const tableWidth = Math.round(table?.getBoundingClientRect().width || 0);
      const wrapWidth = Math.round(wrap?.getBoundingClientRect().width || 0);
      const repoWidth = widthOf(0);
      const actorsWidth = widthOf(13);
      return {
        tableWidth,
        wrapWidth,
        repoWidth,
        trendWidth: widthOf(1),
        actorsWidth,
        numericMin: numericWidths.length ? Math.min(...numericWidths) : 0,
        numericMax: numericWidths.length ? Math.max(...numericWidths) : 0,
        repoShare: tableWidth ? Math.round((repoWidth / tableWidth) * 1000) / 1000 : 0,
        actorsShare: tableWidth ? Math.round((actorsWidth / tableWidth) * 1000) / 1000 : 0,
        scrolls: wrap ? wrap.scrollWidth > wrap.clientWidth : false,
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  // Page 5 — Reviews: provider review-thread inbox as a master-detail (thread
  // list left, selected thread's full comment chain right), mirroring the Live
  // tab. Each row is one thread's live resolution state; selecting a row swaps
  // the detail pane to that thread. Keep this after Repo Analytics so the threads
  // metric is validated independently.
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(100);
  await send("Runtime.evaluate", { expression: "location.hash = '#/reviews?ireview=unresolved'" });
  await sleep(300);
  const reviewsHtml = await waitHtml("document.querySelector('.reviews-page .live-feed .live-event')");
  await captureTitleLinkHitTarget("reviews detail", ".reviews-page .live-detail-title-link", ".live-detail-title");
  const reviewsRangeButtons = await rangeButtonLabels();
  const reviewsCountText = await textOf(".reviews-head .count");
  const reviewsSummary = (await send("Runtime.evaluate", {
    expression: `(() => {
      const detail = document.querySelector('.reviews-page .live-detail');
      const card = detail?.querySelector('.live-detail-card') || null;
      const nav = detail?.querySelector('.live-detail-nav') || null;
      const feedRect = document.querySelector('.reviews-page .live-feed')?.getBoundingClientRect();
      const detailRect = detail?.getBoundingClientRect();
      const cardRect = card?.getBoundingClientRect();
      return {
        rows: document.querySelectorAll('.reviews-page .live-feed .live-event').length,
        statuses: Array.from(document.querySelectorAll('.reviews-page .live-feed .live-event .badge')).map((el) => (el.textContent || '').trim()),
        previews: Array.from(document.querySelectorAll('.reviews-page .live-feed .live-event-preview')).map((el) => el.textContent || ''),
        detailLink: document.querySelector('.reviews-page .live-detail .live-detail-title-link')?.getAttribute('href') || '',
        detailComments: document.querySelectorAll('.reviews-page .live-detail .review-comment-card').length,
        // Avatars appear ONLY inside the thread (comment cards), not on rows or
        // the detail header. The first comment renders the provider photo from
        // avatar_url (4.2.0) — assert the <img> src like the Live tab does.
        rowAvatars: document.querySelectorAll('.reviews-page .live-feed .live-event .live-avatar').length,
        commentAvatarSrc: document.querySelector('.reviews-page .live-detail .review-comment-card .review-comment-avatar img')?.getAttribute('src') || '',
        commentAvatarLayout: (() => {
          const card = document.querySelector('.reviews-page .live-detail .review-comment-card');
          const avatar = card?.querySelector('.review-comment-avatar') || null;
          const main = card?.querySelector('.review-comment-main') || null;
          const avatarRect = avatar?.getBoundingClientRect();
          const mainRect = main?.getBoundingClientRect();
          return {
            avatarIsCardChild: !!(card && avatar && avatar.parentElement === card),
            mainStartsAfterAvatar: !!(avatarRect && mainRect && mainRect.left >= avatarRect.right + 6),
          };
        })(),
        // The prev/next nav must be a SIBLING of the card (a direct child of
        // .live-detail), not nested inside it — that is what lets the shared
        // narrow-overlay flex rules pin it as the footer (mirrors the Live tab).
        navInsideCard: !!(card && nav && card.contains(nav)),
        navIsDetailChild: !!(detail && nav && nav.parentElement === detail),
        feedHeight: Math.round(feedRect?.height || 0),
        detailHeight: Math.round(detailRect?.height || 0),
        detailCardHeight: Math.round(cardRect?.height || 0),
        detailMatchesFeed: !!(feedRect && detailRect) && Math.abs(feedRect.height - detailRect.height) <= 2,
        detailCardFillsPane: !!(detailRect && cardRect) && cardRect.height >= detailRect.height - 2,
      };
    })()`,
    returnByValue: true,
  })).result.value || { rows: 0, statuses: [], previews: [], detailLink: "", detailComments: 0, navInsideCard: true, navIsDetailChild: false };
  // Selecting a different thread row swaps the detail pane to that thread's chain.
  const reviewsRowClick = (await send("Runtime.evaluate", {
    expression: `(() => {
      const rows = Array.from(document.querySelectorAll('.reviews-page .live-feed .live-event'));
      const row = rows[1] || rows[0];
      if (!row) return { rowTitle: '' };
      const rowTitle = row.querySelector('.live-event-title')?.textContent?.trim() || '';
      row.click();
      return { rowTitle };
    })()`,
    returnByValue: true,
  })).result.value || { rowTitle: "" };
  const reviewsSelect = (await waitValue(`(() => {
    const sel = document.querySelector('.reviews-page .live-feed .live-event-selected');
    const detailTitle = document.querySelector('.reviews-page .live-detail .live-detail-title')?.textContent?.trim() || '';
    if (!sel || !detailTitle) return null;
    return {
      selectedTitle: sel.querySelector('.live-event-title')?.textContent?.trim() || '',
      detailTitle,
      comments: document.querySelectorAll('.reviews-page .live-detail .review-comment-card').length,
    };
  })()`)) || { selectedTitle: "", detailTitle: "", comments: 0 };
  // Page 6 — the Settings display filter: a per-repo checkbox list with bulk
  // controls (the sample contract spans two repos across two sources).
  await send("Runtime.evaluate", { expression: "location.hash = '#/settings'" });
  await sleep(300);
  const settingsHtml = await waitHtml("document.querySelector('.settings-page .settings-repo')");
  const colorModeBefore = (await send("Runtime.evaluate", {
    expression: `(() => {
      const prefs = Array.from(document.querySelectorAll('.settings-page .settings-pref'));
      const colorMode = prefs.find((el) => el.querySelector('h3')?.textContent?.trim() === 'Color mode');
      const select = colorMode?.querySelector('select');
      return {
	        found: !!select,
	        before: document.documentElement.dataset.theme || '',
	        colorScheme: document.documentElement.style.colorScheme || '',
	        themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') || '',
	        value: select?.value || '',
	        options: select ? Array.from(select.options).map((option) => option.value) : [],
	        labels: select ? Array.from(select.options).map((option) => option.textContent?.trim() || '') : [],
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await send("Runtime.evaluate", {
    expression: `(() => {
      const prefs = Array.from(document.querySelectorAll('.settings-page .settings-pref'));
      const colorMode = prefs.find((el) => el.querySelector('h3')?.textContent?.trim() === 'Color mode');
      const select = colorMode?.querySelector('select');
      if (!select) return false;
      select.value = 'light';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`,
    returnByValue: true,
  });
  await sleep(150);
  const themeAfter = (await send("Runtime.evaluate", {
    expression: `(() => ({
      root: document.documentElement.dataset.theme || '',
      stored: localStorage.getItem('symphony-board:theme') || '',
      bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
    }))()`,
    returnByValue: true,
  })).result.value || {};
  const settingsDisplayModel = (await send("Runtime.evaluate", {
    expression: `(() => {
      const prefs = Array.from(document.querySelectorAll('.settings-page .settings-pref'));
      const prefByTitle = (title) => prefs.find((el) => el.querySelector('h3')?.textContent?.trim() === title) || null;
      const board = prefByTitle('Board data');
      const boardBox = board?.querySelector('input[type="checkbox"]');
      const liveBox = prefByTitle('Live tab')?.querySelector('input[type="checkbox"]');
      return {
        headings: Array.from(document.querySelectorAll('.settings-page h3')).map((el) => el.textContent?.trim() || ''),
        boardControl: boardBox?.type || '',
        boardChecked: !!boardBox?.checked,
        liveControl: liveBox?.type || '',
        boardHelp: board?.querySelector('.muted')?.textContent?.replace(/\\s+/g, ' ').trim() || '',
      };
    })()`,
    returnByValue: true,
  })).result.value || { headings: [], boardControl: "", liveControl: "", boardHelp: "" };
  const tabOrderBefore = (await send("Runtime.evaluate", {
    expression: `(() => Array.from(document.querySelectorAll('.page-tabs .tab')).map((el) => el.textContent?.replace(/\\s+/g, ' ').trim() || ''))()`,
    returnByValue: true,
  })).result.value || [];
  const tabOrderClick = (await send("Runtime.evaluate", {
    expression: `(() => {
      const prefs = Array.from(document.querySelectorAll('.settings-page .settings-pref'));
      const tabOrder = prefs.find((el) => el.querySelector('h3')?.textContent?.trim() === 'Tab order');
      const button = tabOrder?.querySelector('button[aria-label="Move Graph earlier"]');
      if (!button || button.disabled) return { clicked: false };
      button.click();
      return { clicked: true };
    })()`,
    returnByValue: true,
  })).result.value || { clicked: false };
  await sleep(150);
  const tabOrderAfterMove = (await send("Runtime.evaluate", {
    expression: `(() => {
      const labels = Array.from(document.querySelectorAll('.page-tabs .tab')).map((el) => el.textContent?.replace(/\\s+/g, ' ').trim() || '');
      const rows = Array.from(document.querySelectorAll('.settings-tab-order-list li')).map((el) => el.querySelector('span')?.textContent?.trim() || '');
      return {
        labels,
        rows,
        stored: localStorage.getItem('symphony-board:content-tab-order') || '',
      };
    })()`,
    returnByValue: true,
  })).result.value || { labels: [], rows: [], stored: "" };
  const liveOnlySettings = (await send("Runtime.evaluate", {
    expression: `(() => {
      const prefs = Array.from(document.querySelectorAll('.settings-page .settings-pref'));
      const prefByTitle = (title) => prefs.find((el) => el.querySelector('h3')?.textContent?.trim() === title) || null;
      const board = prefByTitle('Board data');
      const boardBox = board?.querySelector('input[type="checkbox"]');
      const liveBox = prefByTitle('Live tab')?.querySelector('input[type="checkbox"]');
      if (boardBox?.checked) boardBox.click();
      return {
        boardChecked: !!boardBox?.checked,
        liveChecked: !!liveBox?.checked,
        hasPreview: !!prefByTitle('Live feed preview'),
        hasTypes: !!prefByTitle('Live event types'),
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await sleep(200);
  await send("Runtime.evaluate", {
    expression: `(() => {
      const prefs = Array.from(document.querySelectorAll('.settings-page .settings-pref'));
      const board = prefs.find((el) => el.querySelector('h3')?.textContent?.trim() === 'Board data');
      const boardBox = board?.querySelector('input[type="checkbox"]');
      if (boardBox && !boardBox.checked) boardBox.click();
    })()`,
  });
  await sleep(200);
  const boardDataOnlyReenabledTabs = (await send("Runtime.evaluate", {
    expression: `(() => {
      const prefs = Array.from(document.querySelectorAll('.settings-page .settings-pref'));
      const prefByTitle = (title) => prefs.find((el) => el.querySelector('h3')?.textContent?.trim() === title) || null;
      const liveChecked = !!prefByTitle('Live tab')?.querySelector('input[type="checkbox"]')?.checked;
      const nav = document.querySelector('.page-tabs');
      const tabs = Array.from(document.querySelectorAll('.page-tabs .tab')).map((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          label: el.textContent?.replace(/\\s+/g, ' ').trim() || '',
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
        };
      });
      return {
        boardData: nav?.getAttribute('data-board-data') || '',
        liveChecked,
        labels: tabs.map((tab) => tab.label),
        visibleLabels: tabs.filter((tab) => tab.width > 0 && tab.height > 0 && tab.display !== 'none' && tab.visibility !== 'hidden' && tab.opacity !== '0').map((tab) => tab.label),
      };
    })()`,
    returnByValue: true,
  })).result.value || { boardData: "", liveChecked: false, labels: [], visibleLabels: [] };
  await send("Runtime.evaluate", {
    expression: `(() => {
      const prefs = Array.from(document.querySelectorAll('.settings-page .settings-pref'));
      const board = prefs.find((el) => el.querySelector('h3')?.textContent?.trim() === 'Board data');
      const boardBox = board?.querySelector('input[type="checkbox"]');
      if (boardBox && boardBox.checked) boardBox.click();
    })()`,
  });
  await sleep(200);
  await send("Runtime.evaluate", {
    expression: `(() => {
      const prefs = Array.from(document.querySelectorAll('.settings-page .settings-pref'));
      const live = prefs.find((el) => el.querySelector('h3')?.textContent?.trim() === 'Live tab');
      const box = live?.querySelector('input[type="checkbox"]');
      if (box && box.checked) box.click();
      location.hash = '#/activity';
    })()`,
  });
  await sleep(250);
  const bothOffGuardHtml = await waitHtml("document.querySelector('.state-msg')");
  const bothOffGuard = (await send("Runtime.evaluate", {
    expression: `(() => {
      const msg = document.querySelector('.state-msg');
      const header = document.querySelector('.app-header');
      const title = header?.querySelector('h1')?.textContent?.trim() || '';
      const icon = header?.querySelector('.brand-refresh-app-icon');
      const sourceChips = header?.querySelectorAll('.source-chip').length || 0;
      const syncButton = !!header?.querySelector('.sync-button');
      const enable = Array.from(msg?.querySelectorAll('button, a') || [])
        .find((el) => /Enable Live/i.test(el.textContent || ''));
      return {
        text: msg?.textContent?.replace(/\\s+/g, ' ').trim() || '',
        title,
        hasBrandIcon: !!icon,
        sourceChips,
        syncButton,
        hasEnableLive: !!enable,
        enableTag: enable?.tagName?.toLowerCase() || '',
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await send("Runtime.evaluate", {
    expression: `(() => {
      location.hash = '#/settings';
    })()`,
  });
  await sleep(250);
  await waitHtml("document.querySelector('.settings-page')");
  await send("Runtime.evaluate", {
    expression: `(() => {
      const prefs = Array.from(document.querySelectorAll('.settings-page .settings-pref'));
      const prefByTitle = (title) => prefs.find((el) => el.querySelector('h3')?.textContent?.trim() === title) || null;
      const boardBox = prefByTitle('Board data')?.querySelector('input[type="checkbox"]');
      if (boardBox && !boardBox.checked) boardBox.click();
      const liveBox = prefByTitle('Live tab')?.querySelector('input[type="checkbox"]');
      if (liveBox && !liveBox.checked) liveBox.click();
    })()`,
  });
  await sleep(200);
  // Deep link — a board card's "focus in graph" link (#/graph?focus=<ref>) opens
  // the graph ALREADY in that item's focus view (not the plain list); the canvas
  // shows the focus subgraph, so the global search bar stays EMPTY (it is a
  // cross-tab filter, not a navigation channel). Back on the board, confirm the
  // affordance renders, click it, then confirm the focus view (back button) +
  // canvas mounted, the search box untouched, and the default range kept.
  await send("Runtime.evaluate", { expression: "location.hash = '#/board'" });
  await sleep(300);
  const board2Html = await waitHtml("document.querySelector('.board-7 .card')");
  await captureTitleLinkHitTarget("board card", ".board-7 .card-title[href]", ".card");
  await send("Runtime.evaluate", { expression: "document.querySelector('.card-graph')?.click()" });
  await sleep(500);
  const deepLinkHtml = await waitHtml("document.querySelector('.graph-list-back')");
  const deepLinkSearch = (await send("Runtime.evaluate", { expression: "document.querySelector('.search')?.value || ''", returnByValue: true })).result.value || "";
  // A canvas node's title is a real anchor to the provider issue/PR page (not
  // just the whole-node click handler): new tab + noopener, and `nodrag` so
  // grabbing the title never starts a React Flow node drag.
  const nodeTitleLink = (await send("Runtime.evaluate", {
    expression: `(() => {
      const t = document.querySelector('.react-flow__node .rf-node-title');
      if (!t) return { found: false };
      return {
        found: true,
        isAnchor: t.tagName === 'A',
        href: t.getAttribute('href') || '',
        newTab: t.getAttribute('target') === '_blank' && (t.getAttribute('rel') || '').includes('noopener'),
        noDrag: t.classList.contains('nodrag'),
      };
    })()`,
    returnByValue: true,
  })).result.value || { found: false };
  const deepLinkGeometry = (await send("Runtime.evaluate", {
    expression: `(() => {
      const rects = (selector) => Array.from(document.querySelectorAll(selector)).map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      });
      const nodes = rects('.react-flow__node');
      const labels = rects('.rf-edge-label');
      const gap = (a, b) => {
        const dx = Math.max(0, Math.max(a.left - b.right, b.left - a.right));
        const dy = Math.max(0, Math.max(a.top - b.bottom, b.top - a.bottom));
        return Math.hypot(dx, dy);
      };
      const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      let minNodeGap = Infinity;
      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) minNodeGap = Math.min(minNodeGap, gap(nodes[i], nodes[j]));
      }
      return {
        nodeCount: nodes.length,
        labelCount: labels.length,
        minNodeGap: Number.isFinite(minNodeGap) ? Math.round(minNodeGap) : null,
        labelsClearNodes: labels.every((label) => nodes.every((node) => !intersects(label, node))),
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  const deepLinkRange = (await send("Runtime.evaluate", {
    expression: `(() => {
      const rangeInputs = Array.from(document.querySelectorAll('.time-range-controls .date-input'));
      const pickerButtons = Array.from(document.querySelectorAll('.time-range-controls .date-picker-button'));
      const active = Array.from(document.querySelectorAll('.time-range-controls .toggle-on'))
        .map((el) => el.textContent?.trim())
        .filter(Boolean);
      return {
        from: rangeInputs[0]?.value || '',
        to: rangeInputs[1]?.value || '',
        types: rangeInputs.map((input) => input.type),
        placeholders: rangeInputs.map((input) => input.getAttribute('placeholder') || ''),
        pickerButtons: pickerButtons.length,
        active,
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  // URL-backed focus: the deep-link arrival carries "?focus="; "← all items"
  // clears it from the hash; clicking a canvas NODE focuses that node and
  // writes "?focus=" back (the title anchor owns the external link, so the
  // node-body click is free to mean focus); history.back() steps back to the
  // unfocused state. Each step asserts the hash AND the visible view together.
  const urlFocus = { arrival: "", afterBack: "", afterBackFlatList: false, afterNode: "", afterNodeFocusView: false, afterHistory: "", afterHistoryFlatList: false };
  urlFocus.arrival = (await send("Runtime.evaluate", { expression: "location.hash", returnByValue: true })).result.value || "";
  await send("Runtime.evaluate", { expression: "document.querySelector('.graph-list-back')?.click()" });
  await sleep(400);
  urlFocus.afterBack = (await send("Runtime.evaluate", { expression: "location.hash", returnByValue: true })).result.value || "";
  urlFocus.afterBackFlatList = !!(await send("Runtime.evaluate", { expression: "document.querySelector('.graph-list-search') ? 1 : 0", returnByValue: true })).result.value;
  await send("Runtime.evaluate", { expression: "document.querySelector('.react-flow__node')?.click()" });
  await sleep(400);
  urlFocus.afterNode = (await send("Runtime.evaluate", { expression: "location.hash", returnByValue: true })).result.value || "";
  urlFocus.afterNodeFocusView = !!(await send("Runtime.evaluate", { expression: "document.querySelector('.graph-list-back') ? 1 : 0", returnByValue: true })).result.value;
  await send("Runtime.evaluate", { expression: "history.back()" });
  await sleep(400);
  urlFocus.afterHistory = (await send("Runtime.evaluate", { expression: "location.hash", returnByValue: true })).result.value || "";
  urlFocus.afterHistoryFlatList = !!(await send("Runtime.evaluate", { expression: "document.querySelector('.graph-list-search') ? 1 : 0", returnByValue: true })).result.value;
  // Manual sync control: the Header exposes the writer-owned Sync action when the
  // daemon control surface is available (mocked above). Confirm it renders
  // enabled, enters the running (disabled) state on click, then completes and
  // shows the reloaded status. The "disabled" state is the run-active button;
  // the "unavailable" state (no control surface) is covered by the unit tests.
  await waitValue("document.querySelector('.header-aside .sync-button') ? 1 : null");
  const syncInitial = (await send("Runtime.evaluate", {
    expression: `(() => {
      const btn = document.querySelector('.header-aside .sync-button');
      return { rendered: !!btn, enabled: !!btn && !btn.disabled, label: btn?.textContent?.trim() || '' };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await send("Runtime.evaluate", { expression: "document.querySelector('.header-aside .sync-button')?.click()" });
  await sleep(150);
  const syncRunning = (await send("Runtime.evaluate", {
    expression: `(() => {
      const btn = document.querySelector('.header-aside .sync-button');
      const status = document.querySelector('.header-aside .sync-status');
      return { disabled: !!btn && btn.disabled, label: btn?.textContent?.trim() || '', status: status?.textContent?.trim() || '' };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await waitValue(`(() => {
    const status = document.querySelector('.header-aside .sync-status');
    return status && /Synced|reloaded/.test(status.textContent || '') ? 1 : null;
  })()`);
  const syncDone = (await send("Runtime.evaluate", {
    expression: `(() => {
      const btn = document.querySelector('.header-aside .sync-button');
      const status = document.querySelector('.header-aside .sync-status');
      return { enabled: !!btn && !btn.disabled, label: btn?.textContent?.trim() || '', status: status?.textContent?.trim() || '' };
    })()`,
    returnByValue: true,
  })).result.value || {};
  // Settings advanced sync controls: mode, source scope, dry-run, run button.
  await send("Runtime.evaluate", { expression: "location.hash = '#/settings'" });
  await sleep(300);
  const settingsSyncHtml = await waitHtml("document.querySelector('.settings-sync')");
  // With the config capability mocked, Settings renders the sub-tab bar; the
  // Sources editor lives behind the URL-backed "sources" tab.
  const settingsTabsHtml = await waitHtml("document.querySelector('.settings-tabs')");
  await send("Runtime.evaluate", { expression: "location.hash = '#/settings?tab=sources'" });
  await sleep(300);
  const settingsConfigHtml = await waitHtml("document.querySelector('.settings-config')");
  const sourcesTabDisplayGone = (await send("Runtime.evaluate", {
    expression: "document.querySelector('.settings-repo') === null && document.querySelector('.settings-sync') === null",
    returnByValue: true,
  })).result.value === true;

  // The board/graph/repo-analytics item-facet lens is route-backed and shared:
  // clicking a board kind chip must write `ikind=` into the URL, light the chip,
  // and PERSIST when hopping to the Graph tab (the sticky lens travels across a
  // tab hop via nav.tabHref). This locks the cross-tab single-track behaviour.
  await send("Runtime.evaluate", { expression: "location.hash = '#/board'" });
  await sleep(350);
  await waitHtml("document.querySelector('.board-7 .card') && document.querySelector('.controls .toggle-group')");
  const itemKindGroupExpr = `Array.from(document.querySelectorAll('.controls .toggle-group')).find((g) => g.querySelector('.toggle-label')?.textContent === 'kind')`;
  const boardFacetInitial = (await send("Runtime.evaluate", {
    expression: `(() => { const g = ${itemKindGroupExpr}; const c = g?.querySelector('.toggle'); return { hasGroup: !!g, value: c?.textContent?.trim() || null, anyOn: !!g?.querySelector('.toggle.toggle-on'), hashHasIkind: location.hash.includes('ikind=') }; })()`,
    returnByValue: true,
  })).result.value || {};
  await send("Runtime.evaluate", { expression: `(() => { ${itemKindGroupExpr}?.querySelector('.toggle')?.click(); })()` });
  await sleep(300);
  const boardFacetOn = (await send("Runtime.evaluate", {
    expression: `(() => { const g = ${itemKindGroupExpr}; const on = g?.querySelector('.toggle.toggle-on'); return { hash: location.hash, chipOn: !!on, chipText: on?.textContent?.trim() || null, onCount: g?.querySelectorAll('.toggle.toggle-on').length || 0 }; })()`,
    returnByValue: true,
  })).result.value || {};
  // Hop to the Graph tab via the real tab anchor (routeHref -> nav.tabHref).
  await send("Runtime.evaluate", { expression: `(() => { Array.from(document.querySelectorAll('.page-tabs a')).find((a) => (a.textContent || '').trim() === 'Graph')?.click(); })()` });
  await sleep(400);
  await waitHtml("location.hash.startsWith('#/graph') && document.querySelector('.controls .toggle-group')");
  const graphFacetCarry = (await send("Runtime.evaluate", {
    expression: `(() => { const g = ${itemKindGroupExpr}; const on = g?.querySelector('.toggle.toggle-on'); return { hash: location.hash, chipOn: !!on, chipText: on?.textContent?.trim() || null }; })()`,
    returnByValue: true,
  })).result.value || {};
  // The review-thread lens is a route-backed item facet too: clicking the
  // "unresolved" chip must write ?ireview=unresolved AND light the chip. This
  // guards the chip<->route<->filter wiring (a missing useMemo dep on the route
  // field silently breaks the toggle — chip never lights, data never filters).
  await send("Runtime.evaluate", { expression: "location.hash = '#/board'" });
  await sleep(350);
  await waitHtml("document.querySelector('.board-7 .card') && document.querySelector('.controls .toggle-group')");
  const reviewGroupExpr = `Array.from(document.querySelectorAll('.controls .toggle-group')).find((g) => g.querySelector('.toggle-label')?.textContent === 'review')`;
  const boardReviewInitial = (await send("Runtime.evaluate", {
    expression: `(() => { const g = ${reviewGroupExpr}; const chips = Array.from(g?.querySelectorAll('.toggle') || []).map((c) => c.textContent?.trim()); return { hasGroup: !!g, chips, anyOn: !!g?.querySelector('.toggle.toggle-on'), hashHasIreview: location.hash.includes('ireview=') }; })()`,
    returnByValue: true,
  })).result.value || {};
  await send("Runtime.evaluate", { expression: `(() => { Array.from(${reviewGroupExpr}?.querySelectorAll('.toggle') || []).find((c) => c.textContent?.trim() === 'unresolved')?.click(); })()` });
  await sleep(300);
  const boardReviewOn = (await send("Runtime.evaluate", {
    expression: `(() => { const g = ${reviewGroupExpr}; const on = g?.querySelector('.toggle.toggle-on'); return { hash: location.hash, chipOn: !!on, chipText: on?.textContent?.trim() || null }; })()`,
    returnByValue: true,
  })).result.value || {};
  // Live page — the realtime webhook feed. It seeds from /api/live-snapshot
  // (mocked above), so the smoke exercises the seed -> render path and the
  // event-link precision (an event-level comment url vs a parent target url),
  // plus confirms the receiver probe surfaces the Live nav tab. Mock Tauri for
  // this section so the Live hook chooses polling, matching the desktop/mobile
  // app path that cannot hold an SSE stream.
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(100);
  await send("Runtime.evaluate", {
    expression: "Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true }); location.hash = '#/live'",
  });
  await sleep(300);
  const liveHtml = await waitHtml("document.querySelector('.live-page .live-feed')");
  await sleep(120); // let the auto-select effect populate the detail pane
  await captureTitleLinkHitTarget("live detail", ".live-page .live-detail-title-link", ".live-detail-title");
  const live = (await send("Runtime.evaluate", {
    expression: `(() => {
      const page = document.querySelector('.live-page');
      const rows = Array.from(document.querySelectorAll('.live-feed .live-event'));
      // master-detail: the precise permalink now lives on the selected event's
      // detail TITLE link (auto-followed newest = the comment row).
      const detailLink = document.querySelector('.live-detail .live-detail-title-link')?.getAttribute('href') || '';
      const detailAvatar = document.querySelector('.live-detail .live-avatar');
      const detailAvatarImg = detailAvatar?.querySelector('img');
      const feedRect = document.querySelector('.live-feed')?.getBoundingClientRect();
      const detailPaneRect = document.querySelector('.live-detail')?.getBoundingClientRect();
      const detailCardRect = document.querySelector('.live-detail-card')?.getBoundingClientRect();
      const firstRowRect = rows[0]?.getBoundingClientRect();
      const status = document.querySelector('.live-status');
      const avatar = rows[0]?.querySelector('.live-avatar');
      const avatarImg = avatar?.querySelector('img');
      const selectedRow = rows.find((row) => row.classList.contains('live-event-selected')) || rows[0] || null;
      const unselectedRow = rows.find((row) => !row.classList.contains('live-event-selected')) || null;
      const accent = (row) => {
        if (!row) return { width: 0, opacity: 0, background: '', expectedBackground: '', rowBackground: '', category: '', matchesCategory: false };
        const before = getComputedStyle(row, '::before');
        const base = getComputedStyle(row);
        const category = row.dataset.category || '';
        const probe = document.createElement('span');
        probe.style.backgroundColor = 'var(--cat-' + category + ')';
        row.appendChild(probe);
        const expectedBackground = getComputedStyle(probe).backgroundColor || '';
        probe.remove();
        const background = before.backgroundColor || '';
        return {
          width: parseFloat(before.width || '0') || 0,
          opacity: Number(before.opacity || '0') || 0,
          background,
          expectedBackground,
          category,
          matchesCategory: background === expectedBackground,
          rowBackground: base.backgroundColor || '',
        };
      };
      const selectedAccent = accent(selectedRow);
      const unselectedAccent = accent(unselectedRow);
      return {
        rendered: !!page,
        rows: rows.length,
        rowText: rows.map((row) => row.textContent || ''),
        detailLink,
        avatarHref: avatar?.getAttribute('href') || '',
        avatarImgSrc: avatarImg?.getAttribute('src') || '',
        avatarLabel: avatar?.getAttribute('aria-label') || avatar?.getAttribute('title') || '',
        avatarDotContent: avatar ? getComputedStyle(avatar, '::after').content : '',
        detailAvatarHref: detailAvatar?.getAttribute('href') || '',
        detailAvatarImgSrc: detailAvatarImg?.getAttribute('src') || '',
        detailAvatarLabel: detailAvatar?.getAttribute('aria-label') || detailAvatar?.getAttribute('title') || '',
        detailAvatarDotContent: detailAvatar ? getComputedStyle(detailAvatar, '::after').content : '',
        selectedAccent,
        unselectedAccent,
        feedHeight: feedRect?.height || 0,
        feedTop: feedRect?.top || 0,
        feedBottom: feedRect?.bottom || 0,
        detailPaneHeight: detailPaneRect?.height || 0,
        detailCardHeight: detailCardRect?.height || 0,
        detailCardFillsPane: !!(detailPaneRect && detailCardRect) && detailCardRect.height >= detailPaneRect.height - 2,
        firstRowTop: firstRowRect?.top || 0,
        firstRowBottom: firstRowRect?.bottom || 0,
        documentScrollHeight: document.documentElement.scrollHeight,
        documentClientHeight: document.documentElement.clientHeight,
        activityText: document.querySelector('.live-card-rate .live-figure')?.textContent?.replace(/\\s+/g, '') || '',
        bufferText: Array.from(document.querySelectorAll('.live-card'))
          .find((card) => card.querySelector('.live-card-label')?.textContent?.trim() === 'Buffer')
          ?.querySelector('.live-figure')?.textContent?.replace(/\\s+/g, '') || '',
        bufferRanks: Array.from((Array.from(document.querySelectorAll('.live-card'))
          .find((card) => card.querySelector('.live-card-label')?.textContent?.trim() === 'Buffer'))
          ?.querySelectorAll('.live-rank-item') || [])
          .map((node) => node.getAttribute('aria-label') || ''),
        repoRanks: Array.from((Array.from(document.querySelectorAll('.live-card'))
          .find((card) => card.querySelector('.live-card-label')?.textContent?.trim() === 'Active now'))
          ?.querySelectorAll('.live-rank-item') || [])
          .map((node) => node.getAttribute('aria-label') || ''),
        statusText: status?.textContent?.trim() || '',
        statusUnavailable: (status?.textContent || '').includes('Unavailable'),
        statusHasTransport: /\\(polling\\)|\\bPOLL\\b/.test(status?.textContent || ''),
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await sleep(3300);
  const liveSnapshotAfterPoll = await liveSnapshotState();
  // #356 review regression: tapping a sparkline bar must SELECT it on the FIRST
  // activation. The button focuses before the click fires, so a toggle-on-click
  // would clear it (first tap a no-op). Drive focus()+click() — the touch/keyboard
  // sequence — on one bar, then read the rate caption: it must show that bucket's
  // window, not the default "events per 10m · last 5h".
  await send("Runtime.evaluate", {
    expression: `(() => {
      const bars = document.querySelectorAll('.live-card-rate .live-spark-bar');
      const bar = bars[bars.length - 2] || bars[0];
      if (bar) { bar.focus(); bar.click(); }
    })()`,
  });
  await sleep(120);
  const sparkTap = (await send("Runtime.evaluate", {
    expression: `(() => {
      const caption = document.querySelector('.live-card-rate .live-card-sub')?.textContent?.trim() || '';
      const bars = document.querySelectorAll('.live-card-rate .live-spark-bar').length;
      return JSON.stringify({ bars, caption, isDefault: caption === 'events per 10m · last 5h' });
    })()`,
    returnByValue: true,
  })).result.value || null;
  // Select the second feed row (the change-request event carrying only a target
  // url) and confirm its detail shows the /pull/ fallback link.
  await send("Runtime.evaluate", { expression: "document.querySelectorAll('.live-feed .live-event')[1] && document.querySelectorAll('.live-feed .live-event')[1].click()" });
  await sleep(150);
  const liveFallbackLink = (await send("Runtime.evaluate", {
    expression: "document.querySelector('.live-detail .live-detail-title-link')?.getAttribute('href') || ''",
    returnByValue: true,
  })).result.value || "";
  // Settings -> Live event types: hide the comment category through the real UI,
  // then confirm Live drops the comment row/chip while the raw pulse still counts
  // the full 5h stream. Restore it before the mobile Live checks below.
  await send("Runtime.evaluate", { expression: "location.hash = '#/settings'" });
  await sleep(300);
  await waitHtml("document.querySelector('.settings-page .settings-type')");
  const hideCommentType = await waitValue(`(() => {
    const row = Array.from(document.querySelectorAll('.settings-type')).find((el) => el.textContent?.trim() === 'comment');
    const box = row?.querySelector('input');
    if (!box || !box.checked) return null;
    box.click();
    return true;
  })()`);
  await sleep(200);
  await send("Runtime.evaluate", { expression: "location.hash = '#/live'" });
  await sleep(300);
  await waitHtml("document.querySelector('.live-page .live-feed')");
  const liveHiddenType = (await send("Runtime.evaluate", {
    expression: `(() => {
      const cardValue = (label) => Array.from(document.querySelectorAll('.live-card'))
        .find((card) => card.querySelector('.live-card-label')?.textContent?.trim() === label)
        ?.querySelector('.live-figure')?.textContent?.replace(/\\s+/g, '') || '';
      const catLabels = Array.from(document.querySelectorAll('.live-cats .live-cat'))
        .map((el) => el.textContent?.replace(/\\d+$/, '').trim().toLowerCase() || '');
      const rowCategories = Array.from(document.querySelectorAll('.live-feed .live-event-category'))
        .map((el) => el.textContent?.trim().toLowerCase() || '');
      return {
        toggled: ${hideCommentType ? "true" : "false"},
        rows: document.querySelectorAll('.live-feed .live-event').length,
        allCount: document.querySelector('.live-cat-all .live-cat-n')?.textContent?.trim() || '',
        hasCommentChip: catLabels.includes('comment'),
        hasCommentRow: rowCategories.includes('comment'),
        activityText: cardValue('Activity'),
        bufferText: cardValue('Buffer'),
        bufferRanks: Array.from((Array.from(document.querySelectorAll('.live-card'))
          .find((card) => card.querySelector('.live-card-label')?.textContent?.trim() === 'Buffer'))
          ?.querySelectorAll('.live-rank-item') || [])
          .map((node) => node.getAttribute('aria-label') || ''),
        repoRanks: Array.from((Array.from(document.querySelectorAll('.live-card'))
          .find((card) => card.querySelector('.live-card-label')?.textContent?.trim() === 'Active now'))
          ?.querySelectorAll('.live-rank-item') || [])
          .map((node) => node.getAttribute('aria-label') || ''),
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await send("Runtime.evaluate", { expression: "location.hash = '#/settings'" });
  await sleep(300);
  await waitHtml("document.querySelector('.settings-page .settings-type')");
  await send("Runtime.evaluate", {
    expression: `(() => {
      const row = Array.from(document.querySelectorAll('.settings-type')).find((el) => el.textContent?.trim() === 'comment');
      const box = row?.querySelector('input');
      if (box && !box.checked) box.click();
    })()`,
  });
  await sleep(200);
  await send("Runtime.evaluate", { expression: "location.hash = '#/live'" });
  await sleep(300);
  await waitHtml("document.querySelectorAll('.live-feed .live-event').length >= 2");
  liveSnapshotRankFit = true;
  await send("Runtime.evaluate", { expression: "location.hash = '#/activity'" });
  await sleep(200);
  await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(120);
  await send("Runtime.evaluate", { expression: "location.hash = '#/live'" });
  await sleep(500);
  await waitHtml("document.querySelectorAll('.live-rank-item').length >= 6");
  const liveRankFit = (await send("Runtime.evaluate", {
    expression: `(() => {
      const pulse = document.querySelector('.live-pulse');
      const pulseStyle = pulse ? getComputedStyle(pulse) : null;
      const charts = Array.from(document.querySelectorAll('.live-rank-chart'));
      const chartFits = charts.map((chart) => ({
        label: chart.closest('.live-card')?.querySelector('.live-card-label')?.textContent?.trim() || '',
        clientWidth: chart.clientWidth,
        scrollWidth: chart.scrollWidth,
        display: getComputedStyle(chart).display,
      }));
      return {
        columns: pulseStyle?.gridTemplateColumns || '',
        chartFits,
        allFit: chartFits.length >= 2 && chartFits.every((chart) => chart.display !== 'none' && chart.scrollWidth <= chart.clientWidth + 1),
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await send("Emulation.setDeviceMetricsOverride", { width: 384, height: 854, deviceScaleFactor: 3, mobile: true });
  await sleep(150);
  await send("Runtime.evaluate", { expression: "location.hash = '#/live'" });
  await sleep(300);
  await waitHtml("document.querySelector('.live-page .live-feed .live-event')");
  const liveMobileCards = (await send("Runtime.evaluate", {
    expression: `(() => {
      const card = (label) => Array.from(document.querySelectorAll('.live-card'))
        .find((node) => node.querySelector('.live-card-label')?.textContent?.trim() === label);
      const buffer = card('Buffer');
      const active = card('Active now');
      const visible = (node) => !!node && getComputedStyle(node).display !== 'none';
      return {
        bufferChartHidden: !visible(buffer?.querySelector('.live-rank-chart')),
        activeChartHidden: !visible(active?.querySelector('.live-rank-chart')),
        bufferMobileSub: buffer?.querySelector('.live-card-sub-mobile')?.textContent?.trim() || '',
        activeMobileSub: active?.querySelector('.live-card-sub-mobile')?.textContent?.trim() || '',
        bufferMobileSubVisible: visible(buffer?.querySelector('.live-card-sub-mobile')),
        activeMobileSubVisible: visible(active?.querySelector('.live-card-sub-mobile')),
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await send("Runtime.evaluate", {
    expression: `(() => {
      const repo = Array.from(document.querySelectorAll('.live-selects .ms-button'))
        .find((button) => /Repo/.test(button.textContent || ''));
      repo?.click();
    })()`,
  });
  await sleep(120);
  const liveMobileFilterMenu = (await send("Runtime.evaluate", {
    expression: `(() => {
      const button = Array.from(document.querySelectorAll('.live-selects .ms-button'))
        .find((candidate) => /Repo/.test(candidate.textContent || ''));
      const menu = document.querySelector('.live-selects .ms-menu');
      const rect = menu?.getBoundingClientRect();
      const buttonRect = button?.getBoundingClientRect();
      return {
        buttonEnabled: !!button && !button.disabled,
        menuPresent: !!menu,
        left: rect?.left ?? null,
        right: rect?.right ?? null,
        viewportWidth: window.innerWidth,
        buttonLeft: buttonRect?.left ?? null,
        buttonRight: buttonRect?.right ?? null,
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await send("Runtime.evaluate", { expression: "document.body.click()" });
  await sleep(80);
  await send("Runtime.evaluate", { expression: "document.querySelector('.live-feed .live-event')?.click()" });
  await sleep(180);
  const liveMobileOpen = (await send("Runtime.evaluate", {
    expression: `(() => {
      const split = document.querySelector('.live-split');
      const detail = document.querySelector('.live-detail');
      const back = document.querySelector('.live-detail-back');
      const feed = document.querySelector('.live-feed');
      return {
        detailOpen: split?.getAttribute('data-detail-open') || '',
        detailDisplay: detail ? getComputedStyle(detail).display : '',
        detailPosition: detail ? getComputedStyle(detail).position : '',
        backVisible: back ? getComputedStyle(back).display !== 'none' : false,
        feedRows: feed?.querySelectorAll('.live-event').length || 0,
        hash: location.hash,
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  const liveMobileDetailState = async (extra = {}) => (await send("Runtime.evaluate", {
    expression: `(() => {
      const selected = document.querySelector('.live-feed .live-event-selected');
      const detailTitle = document.querySelector('.live-detail-title')?.textContent || '';
      const detailLabel = detailTitle.replace('↗', '').trim();
      const shell = document.querySelector('.live-detail-shell');
      const newer = document.querySelector('.live-detail-nav-button[aria-label="Show newer event"]');
      const older = document.querySelector('.live-detail-nav-button[aria-label="Show older event"]');
      const card = document.querySelector('.live-detail-card');
      const nav = document.querySelector('.live-detail-nav');
      const detail = document.querySelector('.live-detail');
      const selectedText = selected?.textContent || '';
      const cardRect = card?.getBoundingClientRect();
      const navRect = nav?.getBoundingClientRect();
      const detailRect = detail?.getBoundingClientRect();
      return Object.assign({
        detailTitle,
        selectedText,
        selectedMatchesDetail: detailLabel.length > 0 && selectedText.includes(detailLabel),
        selectedIndex: selected?.getAttribute('data-feed-index') || '',
        count: document.querySelector('.live-detail-nav-count')?.textContent?.replace(/\\s+/g, ' ').trim() || '',
        motion: shell?.getAttribute('data-motion') || '',
        navButtons: document.querySelectorAll('.live-detail-nav-button').length,
        newerDisabled: newer?.disabled === true,
        olderDisabled: older?.disabled === true,
        navInsideCard: !!(card && nav && card.contains(nav)),
        navTop: Math.round(navRect?.top || 0),
        navBottom: Math.round(navRect?.bottom || 0),
        navViewportBottomGap: Math.round(window.innerHeight - (navRect?.bottom || 0)),
        viewportHeight: window.innerHeight,
        cardBottom: Math.round(cardRect?.bottom || 0),
        cardHeight: Math.round(cardRect?.height || 0),
        cardClientHeight: card?.clientHeight || 0,
        cardScrollHeight: card?.scrollHeight || 0,
        cardScrollable: !!card && card.scrollHeight > card.clientHeight + 4,
        detailHeight: Math.round(detailRect?.height || 0),
        detailClientHeight: detail?.clientHeight || 0,
        detailScrollHeight: detail?.scrollHeight || 0,
      }, ${JSON.stringify(extra)});
    })()`,
    returnByValue: true,
  })).result.value || {};
  const dispatchLiveMobileSwipe = async ({ dx, dy = 4, selector = ".live-detail-card", xRatio = 0.32, yRatio = 0.58, scrollX = null }) => (await send("Runtime.evaluate", {
    expression: `(({ dx, dy, selector, xRatio, yRatio, scrollX }) => {
      const card = document.querySelector('.live-detail-card');
      if (!card) return { dispatched: false, reason: 'missing-card' };
      const target = document.querySelector(selector);
      if (!target) return { dispatched: false, reason: 'missing-target', selector };
      if (scrollX && target instanceof HTMLElement) {
        const maxScrollLeft = Math.max(0, target.scrollWidth - target.clientWidth);
        if (scrollX === 'end') target.scrollLeft = maxScrollLeft;
        else if (scrollX === 'middle') target.scrollLeft = Math.max(0, Math.round(maxScrollLeft / 2));
        else if (scrollX === 'start') target.scrollLeft = 0;
      }
      const rect = target.getBoundingClientRect();
      const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
      const startX = Math.round(clamp(rect.left + Math.min(96, rect.width * xRatio), rect.left + 4, rect.right - 4));
      const startY = Math.round(clamp(rect.top + Math.max(4, Math.min(rect.height - 4, Math.max(24, rect.height * yRatio))), rect.top + 4, rect.bottom - 4));
      const endX = startX + dx;
      const endY = startY + dy;
      const scrollInfo = target instanceof HTMLElement
        ? {
            scrollLeft: Math.round(target.scrollLeft),
            scrollWidth: target.scrollWidth,
            clientWidth: target.clientWidth,
            maxScrollLeft: Math.max(0, Math.round(target.scrollWidth - target.clientWidth)),
          }
        : {};
      try {
        const makeTouch = (x, y) => new Touch({
          identifier: 7,
          target,
          clientX: x,
          clientY: y,
          screenX: x,
          screenY: y,
          pageX: x,
          pageY: y,
          radiusX: 1,
          radiusY: 1,
        });
        const start = makeTouch(startX, startY);
        const end = makeTouch(endX, endY);
        target.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [start], targetTouches: [start], changedTouches: [start] }));
        target.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [end] }));
        return { dispatched: true, method: 'TouchEvent', selector, x: startX, y: startY, dx, dy, ...scrollInfo };
      } catch (error) {
        try {
          const touch = (x, y) => ({ identifier: 7, target, clientX: x, clientY: y, screenX: x, screenY: y, pageX: x, pageY: y });
          const makeEvent = (type, touches, changedTouches) => {
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperties(event, {
              touches: { value: touches },
              targetTouches: { value: touches },
              changedTouches: { value: changedTouches },
            });
            return event;
          };
          const start = touch(startX, startY);
          const end = touch(endX, endY);
          target.dispatchEvent(makeEvent('touchstart', [start], [start]));
          target.dispatchEvent(makeEvent('touchend', [], [end]));
          return { dispatched: true, method: 'event-props', selector, x: startX, y: startY, dx, dy, ...scrollInfo };
        } catch (fallbackError) {
          return {
            dispatched: false,
            selector,
            reason: String(error?.message || error),
            fallback: String(fallbackError?.message || fallbackError),
          };
        }
      }
    })(${JSON.stringify({ dx, dy, selector, xRatio, yRatio, scrollX })})`,
    returnByValue: true,
  })).result.value || {};
  const tapLiveMobileNavButton = async (label) => (await send("Runtime.evaluate", {
    expression: `((label) => {
        const button = document.querySelector(\`.live-detail-nav-button[aria-label="\${label}"]\`);
        if (!button) return { clicked: false, reason: 'missing-button', label };
        const rect = button.getBoundingClientRect();
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);
        const point = {
          clicked: false,
          label,
          disabled: button.disabled === true,
          x,
          y,
          hit: document.elementFromPoint(x, y)?.className || null,
        };
        if (point.disabled) return point;
        try {
          const makeTouch = (target) => new Touch({
            identifier: 11,
            target,
            clientX: x,
            clientY: y,
            screenX: x,
            screenY: y,
            pageX: x,
            pageY: y,
            radiusX: 1,
            radiusY: 1,
          });
          const touch = makeTouch(button);
          button.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] }));
          button.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [touch] }));
          return { ...point, clicked: true, method: 'TouchEvent' };
        } catch (error) {
          const touch = { identifier: 11, target: button, clientX: x, clientY: y, screenX: x, screenY: y, pageX: x, pageY: y };
          const makeEvent = (type, touches, changedTouches) => {
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperties(event, {
              touches: { value: touches },
              targetTouches: { value: touches },
              changedTouches: { value: changedTouches },
            });
            return event;
          };
          button.dispatchEvent(makeEvent('touchstart', [touch], [touch]));
          button.dispatchEvent(makeEvent('touchend', [], [touch]));
          return { ...point, clicked: true, method: 'event-props', reason: String(error?.message || error) };
        }
      })(${JSON.stringify(label)})`,
    returnByValue: true,
  })).result.value || {};
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await sleep(120);
  const liveMobileOlderClick = await tapLiveMobileNavButton("Show older event");
  await sleep(300);
  const liveMobileNav = await liveMobileDetailState({ click: liveMobileOlderClick });
  const liveMobileReducedMotion = (await send("Runtime.evaluate", {
    expression: `(() => {
      const shell = document.querySelector('.live-detail-shell');
      const style = shell ? getComputedStyle(shell) : null;
      return {
        matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
        motion: shell?.getAttribute('data-motion') || '',
        animationName: style?.animationName || '',
        animationDuration: style?.animationDuration || '',
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  await sleep(120);
  const liveMobileSwipeDispatch = await dispatchLiveMobileSwipe({ dx: 112 });
  await sleep(300);
  const liveMobileSwipe = await liveMobileDetailState({ dispatch: liveMobileSwipeDispatch });
  const liveMobileLeftSwipeDispatch = await dispatchLiveMobileSwipe({ dx: -112 });
  await sleep(300);
  const liveMobileLeftSwipe = await liveMobileDetailState({ dispatch: liveMobileLeftSwipeDispatch });
  const liveMobileTableMidSwipeDispatch = await dispatchLiveMobileSwipe({ dx: -112, selector: ".live-detail-body table", yRatio: 0.08, scrollX: "middle" });
  await sleep(300);
  const liveMobileTableMidSwipe = await liveMobileDetailState({ dispatch: liveMobileTableMidSwipeDispatch });
  const liveMobileTableEdgeSwipeDispatch = await dispatchLiveMobileSwipe({ dx: -112, selector: ".live-detail-body table", yRatio: 0.08, scrollX: "end" });
  await sleep(300);
  const liveMobileTableEdgeSwipe = await liveMobileDetailState({ dispatch: liveMobileTableEdgeSwipeDispatch });
  const liveMobileAfterTableReturnDispatch = await dispatchLiveMobileSwipe({ dx: 112 });
  await sleep(300);
  const liveMobileAfterTableReturn = await liveMobileDetailState({ dispatch: liveMobileAfterTableReturnDispatch });
  const liveMobileIgnoredLinkSwipeDispatch = await dispatchLiveMobileSwipe({ dx: 112, selector: ".live-detail-title-link" });
  await sleep(300);
  const liveMobileIgnoredLinkSwipe = await liveMobileDetailState({ dispatch: liveMobileIgnoredLinkSwipeDispatch });
  const liveMobileOverlaySwipeDispatch = await dispatchLiveMobileSwipe({ dx: 112, selector: ".live-detail", yRatio: 0.86 });
  await sleep(300);
  const liveMobileOverlaySwipe = await liveMobileDetailState({ dispatch: liveMobileOverlaySwipeDispatch });
  await send("Runtime.evaluate", { expression: "location.hash = '#/activity'" });
  await sleep(250);
  const liveMobileAway = (await send("Runtime.evaluate", {
    expression: `(() => ({
      hash: location.hash,
      activityVisible: !!document.querySelector('.activity-page'),
    }))()`,
    returnByValue: true,
  })).result.value || {};
  await send("Runtime.evaluate", { expression: "history.back()" });
  await sleep(300);
  const liveMobileReturnDetail = (await send("Runtime.evaluate", {
    expression: `(() => {
      const split = document.querySelector('.live-split');
      const detail = document.querySelector('.live-detail');
      const feed = document.querySelector('.live-feed');
      return {
        detailOpen: split?.getAttribute('data-detail-open') || '',
        detailDisplay: detail ? getComputedStyle(detail).display : '',
        feedRows: feed?.querySelectorAll('.live-event').length || 0,
        hash: location.hash,
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await send("Runtime.evaluate", { expression: "history.back()" });
  await sleep(250);
  const liveMobileBack = (await send("Runtime.evaluate", {
    expression: `(() => {
      const split = document.querySelector('.live-split');
      const detail = document.querySelector('.live-detail');
      const feed = document.querySelector('.live-feed');
      return {
        detailOpen: split?.getAttribute('data-detail-open') || '',
        detailDisplay: detail ? getComputedStyle(detail).display : '',
        feedRows: feed?.querySelectorAll('.live-event').length || 0,
        hash: location.hash,
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await send("Runtime.evaluate", { expression: "location.hash = '#/commits'" });
  await sleep(250);
  await waitHtml("document.querySelector('.commits-page')");
  await send("Emulation.setDeviceMetricsOverride", { width: 384, height: 854, deviceScaleFactor: 3, mobile: true });
  await sleep(120);
  await send("Runtime.evaluate", { expression: "location.hash = '#/live'" });
  await sleep(300);
  await waitHtml("document.querySelector('.live-page .live-feed .live-event')");
  await send("Runtime.evaluate", { expression: "document.querySelector('.live-feed .live-event')?.click()" });
  await sleep(180);
  await send("Emulation.setDeviceMetricsOverride", { width: 930, height: 854, deviceScaleFactor: 2, mobile: true });
  await sleep(300);
  const liveBreakpointClear = (await send("Runtime.evaluate", {
    expression: `(() => {
      const split = document.querySelector('.live-split');
      const detail = document.querySelector('.live-detail');
      return {
        detailOpen: split?.getAttribute('data-detail-open') || '',
        detailDisplay: detail ? getComputedStyle(detail).display : '',
        hash: location.hash,
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await send("Runtime.evaluate", { expression: "location.hash = '#/activity'" });
  await sleep(250);
  await send("Runtime.evaluate", { expression: "history.back()" });
  await sleep(250);
  const liveBreakpointBackToLive = (await send("Runtime.evaluate", {
    expression: `(() => ({
      hash: location.hash,
      liveVisible: !!document.querySelector('.live-page'),
    }))()`,
    returnByValue: true,
  })).result.value || {};
  await send("Runtime.evaluate", { expression: "history.back()" });
  await sleep(250);
  const liveBreakpointBackToSentinel = (await send("Runtime.evaluate", {
    expression: `(() => ({
      hash: location.hash,
      commitsVisible: !!document.querySelector('.commits-page'),
    }))()`,
    returnByValue: true,
  })).result.value || {};
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Runtime.evaluate", { expression: "location.hash = '#/settings'" });
  await sleep(250);
  await waitHtml("document.querySelector('.settings-page .settings-type')");
  await send("Runtime.evaluate", {
    expression: `(() => {
      for (const box of document.querySelectorAll('.settings-type input')) {
        if (!box.checked) box.click();
      }
    })()`,
  });
  await sleep(200);
  liveSnapshotRankFit = false;
  await send("Runtime.evaluate", { expression: "fetch('/__smoke/live-large?enabled=1').then(() => { location.hash = '#/live'; location.reload(); })", awaitPromise: true });
  await sleep(800);
  await waitHtml("document.querySelector('.live-page .live-feed .live-event')");
  await sleep(3200);
  const liveLargeBuffer = (await send("Runtime.evaluate", {
    expression: `(() => {
      const rows = Array.from(document.querySelectorAll('.live-feed .live-event'));
      const allCount = document.querySelector('.live-cat-all .live-cat-n')?.textContent?.trim() || '';
      const bufferText = Array.from(document.querySelectorAll('.live-card'))
        .find((card) => card.querySelector('.live-card-label')?.textContent?.trim() === 'Buffer')
        ?.querySelector('.live-figure')?.textContent?.replace(/\\s+/g, '') || '';
      const indexes = rows.map((row) => Number(row.getAttribute('data-feed-index'))).filter((n) => Number.isFinite(n));
      return {
        allCount,
        bufferText,
        rows: rows.length,
        firstIndex: indexes.length ? Math.min(...indexes) : null,
        lastIndex: indexes.length ? Math.max(...indexes) : null,
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await send("Runtime.evaluate", { expression: "delete window.__TAURI_INTERNALS__" });
  const portraitPresets = [
    { name: "phone-portrait", width: 384, height: 854, dpr: 3 },
    { name: "tablet-portrait", width: 930, height: 1240, dpr: 2 },
  ];
  const portraitPages = [
    { page: "board", hash: "#/board", selector: ".board-7" },
    { page: "graph", hash: "#/graph", selector: ".graph-body" },
    { page: "activity", hash: "#/activity", selector: ".activity-page" },
    { page: "items", hash: "#/items", selector: ".items-page" },
    { page: "commits", hash: "#/commits", selector: ".commits-page" },
    { page: "reviews", hash: "#/reviews", selector: ".reviews-page" },
    { page: "repo-analytics", hash: "#/repo-analytics", selector: ".repo-analytics-page" },
    { page: "settings", hash: "#/settings", selector: ".settings-page" },
    { page: "debug", hash: "#/debug", selector: ".debug-page" },
  ];
  const portraitResults = [];
  for (const preset of portraitPresets) {
    await send("Emulation.setDeviceMetricsOverride", { width: preset.width, height: preset.height, deviceScaleFactor: preset.dpr, mobile: true });
    await sleep(150);
    for (const page of portraitPages) {
      await send("Runtime.evaluate", { expression: `location.hash = ${JSON.stringify(page.hash)}` });
      await sleep(300);
      await waitHtml(`document.querySelector(${JSON.stringify(page.selector)})`);
      const result = (await send("Runtime.evaluate", {
        expression: `(() => {
          const doc = document.documentElement;
          const root = document.querySelector(${JSON.stringify(page.selector)});
          const boardSelector = document.querySelector('.board-mobile-selector');
          const cols = Array.from(document.querySelectorAll('.board-7 .col'));
          const graphBody = document.querySelector('.graph-body');
          const graphListRect = document.querySelector('.graph-list')?.getBoundingClientRect();
          const graphCanvasRect = document.querySelector('.graph-canvas')?.getBoundingClientRect();
          const graphKindToggles = Array.from(document.querySelectorAll('.graph-list-kinds .toggle'));
          const repoTable = document.querySelector('.repo-table');
          const controls = document.querySelector('.controls');
          const filterToggle = controls?.querySelector('.filter-disclosure');
          const filterToggleRect = filterToggle?.getBoundingClientRect();
          const filterToggleSummary = filterToggle?.querySelector('.filter-summary-disclosure-summary');
          const filterGroups = controls?.querySelector('.filter-groups');
          const localFile = controls?.querySelector('.file-load');
          const localFileSummary = localFile?.querySelector('summary');
          const localFileInput = localFile?.querySelector('input[type="file"]');
          const localFileSummaryStyle = localFileSummary ? getComputedStyle(localFileSummary) : null;
          const rangeControls = document.querySelector('.time-range-controls');
          const rangeDisclosure = document.querySelector('.time-range-controls .range-disclosure');
          const rangeDateFilter = document.querySelector('.time-range-controls .date-filter');
          const commitsFilterDisclosure = document.querySelector('.commits-filter-disclosure');
          const commitsToolbar = document.querySelector('.commits-toolbar');
          const statsDisclosure = document.querySelector('.stats-disclosure');
          const statsBody = document.querySelector('.stats-body');
          const tuckedGraphLegend = document.querySelector('.stats-body .graph-legend');
          const activityHeatmap = document.querySelector('.activity-heatmap');
          const heatmapScroll = activityHeatmap?.querySelector('.hm-calendar-scroll');
          const activityList = document.querySelector('.activity-list');
          const heatmapRect = activityHeatmap?.getBoundingClientRect();
          const listRect = activityList?.getBoundingClientRect();
          const activityRows = Array.from(document.querySelectorAll('.activity-row'));
          const commitRows = Array.from(document.querySelectorAll('.commit-row'));
          const commitRefChips = Array.from(document.querySelectorAll('.commit-ref-chip'));
          const activityChips = document.querySelector('.activity-chips');
          const activityChipsStyle = activityChips ? getComputedStyle(activityChips) : null;
          const sources = document.querySelector('.app-header .sources');
          const sourceChips = Array.from(document.querySelectorAll('.app-header .source-chip'));
          const sourceChipTops = sourceChips.map((chip) => Math.round(chip.getBoundingClientRect().top));
          const sourcesRect = sources?.getBoundingClientRect();
          const pageName = ${JSON.stringify(page.page)};
          const primarySurface = pageName === 'activity'
            ? document.querySelector('.activity-list')
            : pageName === 'items'
              ? document.querySelector('.items-list')
            : pageName === 'commits'
              ? document.querySelector('.commit-list')
              : pageName === 'board'
                ? document.querySelector('.board-7')
                : pageName === 'graph'
                  ? document.querySelector('.graph-list')
                  : pageName === 'repo-analytics'
                    ? document.querySelector('.repo-table-wrap')
                    : pageName === 'reviews'
                      ? document.querySelector('.reviews-page .live-feed')
                    : null;
          const primarySurfaceRect = primarySurface?.getBoundingClientRect();
          const heatmapMaxScroll = heatmapScroll ? Math.max(0, heatmapScroll.scrollWidth - heatmapScroll.clientWidth) : 0;
          return {
            ready: !!root,
            overflow: Math.max(0, doc.scrollWidth - doc.clientWidth),
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            dpr: window.devicePixelRatio,
            primarySurfaceTop: primarySurfaceRect ? Math.round(primarySurfaceRect.top) : 0,
            boardSelectorVisible: !!boardSelector && getComputedStyle(boardSelector).display !== 'none',
            visibleBoardColumns: cols.filter((el) => getComputedStyle(el).display !== 'none').length,
            graphStacked: !!(graphListRect && graphCanvasRect)
              ? graphCanvasRect.top > graphListRect.bottom - 2
              : !graphBody || getComputedStyle(graphBody).flexDirection === 'column',
            // The narrow-viewport List/Graph segmented toggle and which single
            // coupled pane it currently shows (default: the list, canvas absent).
            graphViewTogglePresent: !!document.querySelector('.graph-view-toggle'),
            graphViewActiveTab: (document.querySelector('.graph-view-toggle [role="tab"][aria-selected="true"]')?.textContent || '').trim() || null,
            graphCanvasPresent: !!document.querySelector('.graph-canvas'),
            graphListPresent: !!document.querySelector('.graph-list'),
            graphKindToggleCount: graphKindToggles.length,
            graphKindToggleMaxHeight: Math.max(0, ...graphKindToggles.map((el) => Math.round(el.getBoundingClientRect().height))),
            graphKindToggleMaxWidth: Math.max(0, ...graphKindToggles.map((el) => Math.round(el.getBoundingClientRect().width))),
            repoCompact: !repoTable || getComputedStyle(repoTable).display === 'block',
            filterButtonVisible: !controls || (!!filterToggle && getComputedStyle(filterToggle).display !== 'none'),
            filterGroupsCollapsed: !controls || (!!filterGroups && getComputedStyle(filterGroups).display === 'none'),
            // The facet disclosure sits in the shared compact mobile toolbar:
            // same summary chrome, but no longer a full-width row.
            filterDisclosureCompact: !controls || (!!filterToggle
              && filterToggle.classList.contains('filter-summary-disclosure')
              && !!filterToggleSummary
              && (filterToggleRect?.width ?? 0) >= 70
              && (filterToggleRect?.width ?? 0) <= window.innerWidth * 0.45),
            // The local-file contract loader is a desktop dev affordance; on a
            // phone it is hidden entirely so it doesn't spend a row.
            fileLoadHidden: !controls || !localFile || getComputedStyle(localFile).display === 'none',
            rangeControlsVisible: !rangeControls || getComputedStyle(rangeControls).display !== 'none',
            rangeDisclosureVisible: !!rangeDisclosure && getComputedStyle(rangeDisclosure).display !== 'none',
            rangeFieldsCollapsed: !rangeDateFilter || getComputedStyle(rangeDateFilter).display === 'none',
            commitsFilterDisclosureVisible: !!commitsFilterDisclosure && getComputedStyle(commitsFilterDisclosure).display !== 'none',
            commitsToolbarCollapsed: !commitsToolbar || getComputedStyle(commitsToolbar).display === 'none',
            // The read-only stat summary collapses behind a 'stats · …' disclosure on
            // narrow so the data shows first; the graph legend rides inside it.
            statsDisclosureVisible: !!statsDisclosure && getComputedStyle(statsDisclosure).display !== 'none',
            statsBodyCollapsed: !!statsBody && getComputedStyle(statsBody).display === 'none',
            graphLegendTucked: !!tuckedGraphLegend,
            activityHeatmapAboveFeed: !activityHeatmap || !activityList || (heatmapRect?.top ?? 0) <= (listRect?.top ?? 0),
            activityHeatmapScrolledToLatest: !heatmapScroll || heatmapMaxScroll === 0 || Math.abs(heatmapMaxScroll - heatmapScroll.scrollLeft) <= 2,
            activityListHeight: activityList ? Math.round(activityList.getBoundingClientRect().height) : 0,
            // The narrow-viewport Feed/Overview segmented toggle and which single
            // pane it currently shows (default: the records feed, heatmap absent).
            activityViewTogglePresent: !!document.querySelector('.activity-view-toggle'),
            activityViewActiveTab: (document.querySelector('.activity-view-toggle [role="tab"][aria-selected="true"]')?.textContent || '').trim() || null,
            activityHeatmapPresent: !!activityHeatmap,
            activityListPresent: !!activityList,
            activityChipsWrap: !activityChips || (activityChipsStyle?.whiteSpace === 'normal' && activityChipsStyle?.flexWrap === 'wrap'),
            activityRowsNotClipped: activityRows.every((row) => row.scrollHeight <= row.clientHeight + 1),
            commitRowsWithinSlot: commitRows.every((row) => {
              const body = row.querySelector('.commit-row-body');
              if (!body) return true;
              return Math.round(body.getBoundingClientRect().height) <= Math.round(row.getBoundingClientRect().height) + 1;
            }),
            commitRefChipsSingleLine: commitRefChips.every((chip) => Math.round(chip.getBoundingClientRect().height) <= 24),
            commitRowCount: commitRows.length,
            commitMaxBodyHeight: Math.max(0, ...commitRows.map((row) => { const b = row.querySelector('.commit-row-body'); return b ? Math.round(b.getBoundingClientRect().height) : 0; })),
            commitMinSlotHeight: commitRows.length ? Math.min(...commitRows.map((row) => Math.round(row.getBoundingClientRect().height))) : 0,
            headerSourcesCount: sourceChips.length,
            headerSourcesHeight: Math.round(sourcesRect?.height || 0),
            headerSourcesOneLine: sourceChipTops.length > 0 && new Set(sourceChipTops).size === 1,
            headerSourceChipFlexGrow: sourceChips[0] ? getComputedStyle(sourceChips[0]).flexGrow : null,
          };
        })()`,
        returnByValue: true,
      })).result.value || {};
      portraitResults.push({ preset: preset.name, page: page.page, ...result });
    }
  }
  await send("Emulation.setDeviceMetricsOverride", { width: 384, height: 854, deviceScaleFactor: 3, mobile: true });
  await sleep(150);
  await send("Runtime.evaluate", { expression: "location.hash = '#/activity?kind=commit'" });
  await sleep(300);
  await waitHtml("document.querySelector('.activity-page')");
  const phoneActiveFilterDisclosureBefore = (await send("Runtime.evaluate", {
    expression: `(() => {
      const controls = document.querySelector('.controls');
      const button = controls?.querySelector('.filter-disclosure');
      const groups = controls?.querySelector('.filter-groups');
      const activeChip = groups?.querySelector('.toggle.toggle-on');
      const primarySurface = document.querySelector('.activity-list');
      const primaryRect = primarySurface?.getBoundingClientRect();
      return {
        hasButton: !!button,
        buttonVisible: !!button && getComputedStyle(button).display !== 'none',
        buttonText: button?.textContent?.trim() || '',
        groupsHidden: !!groups && getComputedStyle(groups).display === 'none',
        rangeVisible: !!document.querySelector('.time-range-controls') && getComputedStyle(document.querySelector('.time-range-controls')).display !== 'none',
        activeChipText: activeChip?.textContent?.trim() || null,
        primaryTopBefore: Math.round(primaryRect?.top || 0),
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await send("Runtime.evaluate", { expression: "document.querySelector('.controls .search-disclosure')?.click();" });
  await sleep(150);
  const phoneSearchDisclosure = (await send("Runtime.evaluate", {
    expression: `(() => {
      const sheet = document.querySelector('.mobile-control-sheet[data-panel="search"]');
      const input = sheet?.querySelector('.mobile-control-search');
      const sheetTitle = sheet?.querySelector('.mobile-control-sheet-title');
      const sheetRect = sheet?.getBoundingClientRect();
      const inputRect = input?.getBoundingClientRect();
      const primarySurface = document.querySelector('.activity-list');
      const primaryRect = primarySurface?.getBoundingClientRect();
      return {
        sheetVisible: !!sheet && getComputedStyle(sheet).display !== 'none',
        sheetTitle: sheetTitle?.textContent?.trim() || null,
        inputVisible: !!input && getComputedStyle(input).display !== 'none',
        inputHeight: Math.round(inputRect?.height || 0),
        inputWidth: Math.round(inputRect?.width || 0),
        sheetHeight: Math.round(sheetRect?.height || 0),
        primaryTopDuring: Math.round(primaryRect?.top || 0),
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await send("Runtime.evaluate", { expression: "document.querySelector('.mobile-control-backdrop')?.click()" });
  await sleep(100);
  await send("Runtime.evaluate", {
    expression: "document.querySelector('.controls .search-disclosure')?.click(); document.querySelector('.controls .filter-disclosure')?.click();",
  });
  await sleep(150);
  const phoneActiveFilterDisclosureAfter = (await send("Runtime.evaluate", {
    expression: `(() => {
      const groups = Array.from(document.querySelectorAll('.controls .filter-groups'))
        .find((candidate) => getComputedStyle(candidate).display !== 'none');
      const activeChip = groups?.querySelector('.toggle.toggle-on');
      const search = document.querySelector('.controls .search');
      const rangeDisclosure = document.querySelector('.time-range-controls .range-disclosure');
      const sheet = document.querySelector('.mobile-control-sheet');
      const sheets = Array.from(document.querySelectorAll('.mobile-control-sheet'));
      const primarySurface = document.querySelector('.activity-list');
      const sheetTitle = sheet?.querySelector('.mobile-control-sheet-title');
      const rangeRect = rangeDisclosure?.getBoundingClientRect();
      const primaryRect = primarySurface?.getBoundingClientRect();
      return {
        groupsVisible: !!groups && getComputedStyle(groups).display !== 'none',
        activeChipVisible: !!activeChip && getComputedStyle(activeChip).display !== 'none',
        searchVisible: !!search && getComputedStyle(search).display !== 'none',
        rangeDisclosureHeight: Math.round(rangeRect?.height || 0),
        sheetVisible: !!sheet && getComputedStyle(sheet).display !== 'none',
        sheetCount: sheets.length,
        sheetTitle: sheetTitle?.textContent?.trim() || null,
        primaryTopAfter: Math.round(primaryRect?.top || 0),
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  const phoneActiveFilterDisclosure = {
    ...phoneActiveFilterDisclosureBefore,
    ...phoneActiveFilterDisclosureAfter,
  };
  await send("Runtime.evaluate", { expression: "document.querySelector('.mobile-control-backdrop')?.click()" });
  await sleep(100);
  await send("Runtime.evaluate", { expression: "location.hash = '#/commits'" });
  await sleep(300);
  await waitHtml("document.querySelector('.commits-page .commit-list')");
  const phoneCommitsFilterDisclosureBefore = (await send("Runtime.evaluate", {
    expression: `(() => {
      const button = document.querySelector('.commits-filter-disclosure');
      const toolbar = document.querySelector('.commits-toolbar-inline');
      const primarySurface = document.querySelector('.commit-list');
      const primaryRect = primarySurface?.getBoundingClientRect();
      return {
        hasButton: !!button,
        buttonVisible: !!button && getComputedStyle(button).display !== 'none',
        toolbarHidden: !toolbar || getComputedStyle(toolbar).display === 'none',
        primaryTopBefore: Math.round(primaryRect?.top || 0),
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await send("Runtime.evaluate", { expression: "document.querySelector('.commits-filter-disclosure')?.click()" });
  await sleep(150);
  const phoneCommitsFilterDisclosureAfter = (await send("Runtime.evaluate", {
    expression: `(() => {
      const sheet = document.querySelector('.mobile-control-sheet[data-panel="commits-filters"]');
      const sheets = Array.from(document.querySelectorAll('.mobile-control-sheet'));
      const sheetTitle = sheet?.querySelector('.mobile-control-sheet-title');
      const repoInput = sheet?.querySelector('.commits-filter input.search');
      const branchSelect = sheet?.querySelector('.commit-branch-select select');
      const repoOptions = sheet?.querySelectorAll('.commit-filter-option[data-kind="repo"]').length || 0;
      const branchOptions = sheet?.querySelectorAll('.commit-filter-option[data-kind="branch"]').length || 0;
      const activeTab = sheet?.querySelector('.commit-filter-sheet-tab[aria-selected="true"]');
      const primarySurface = document.querySelector('.commit-list');
      const primaryRect = primarySurface?.getBoundingClientRect();
      const sheetRect = sheet?.getBoundingClientRect();
      const visibleRepoOptions = sheet && sheetRect ? Array.from(sheet.querySelectorAll('.commit-filter-option[data-kind="repo"]'))
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return style.display !== 'none' && rect.height >= 30 && rect.bottom > sheetRect.top && rect.top < sheetRect.bottom;
        }).length : 0;
      const visibleBranchOptions = sheet && sheetRect ? Array.from(sheet.querySelectorAll('.commit-filter-option[data-kind="branch"]'))
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return style.display !== 'none' && rect.height >= 30 && rect.bottom > sheetRect.top && rect.top < sheetRect.bottom;
        }).length : 0;
      return {
        sheetVisible: !!sheet && getComputedStyle(sheet).display !== 'none',
        sheetCount: sheets.length,
        sheetTitle: sheetTitle?.textContent?.trim() || null,
        activeTab: activeTab?.textContent?.trim() || null,
        tabCount: sheet?.querySelectorAll('.commit-filter-sheet-tab').length || 0,
        repoInputVisible: !!repoInput && getComputedStyle(repoInput).display !== 'none',
        repoInputFocused: !!repoInput && document.activeElement === repoInput,
        branchSelectVisible: !!branchSelect && getComputedStyle(branchSelect).display !== 'none',
        repoOptions,
        branchOptions,
        visibleRepoOptions,
        visibleBranchOptions,
        sheetHeight: Math.round(sheetRect?.height || 0),
        viewportHeight: window.innerHeight,
        primaryTopAfter: Math.round(primaryRect?.top || 0),
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await send("Runtime.evaluate", {
    expression: `(() => {
      const tab = Array.from(document.querySelectorAll('.mobile-control-sheet[data-panel="commits-filters"] .commit-filter-sheet-tab'))
        .find((el) => el.textContent?.trim() === 'Branch');
      tab?.click();
    })()`,
  });
  await sleep(120);
  const phoneCommitsBranchTab = (await send("Runtime.evaluate", {
    expression: `(() => {
      const sheet = document.querySelector('.mobile-control-sheet[data-panel="commits-filters"]');
      const sheetRect = sheet?.getBoundingClientRect();
      const visibleBranchOptions = sheet && sheetRect ? Array.from(sheet.querySelectorAll('.commit-filter-option[data-kind="branch"]'))
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return style.display !== 'none' && rect.height >= 30 && rect.bottom > sheetRect.top && rect.top < sheetRect.bottom;
        }).length : 0;
      return {
        activeTab: sheet?.querySelector('.commit-filter-sheet-tab[aria-selected="true"]')?.textContent?.trim() || null,
        visibleBranchOptions,
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await send("Runtime.evaluate", {
    expression: `(() => {
      const tab = Array.from(document.querySelectorAll('.mobile-control-sheet[data-panel="commits-filters"] .commit-filter-sheet-tab'))
        .find((el) => el.textContent?.trim() === 'Repo');
      tab?.click();
    })()`,
  });
  await sleep(120);
  await send("Runtime.evaluate", {
    expression: `(() => {
      const sheet = document.querySelector('.mobile-control-sheet[data-panel="commits-filters"]');
      const sheetRect = sheet?.getBoundingClientRect();
      const option = sheet && sheetRect ? Array.from(sheet.querySelectorAll('.commit-filter-option[data-kind="repo"]'))
        .find((el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return style.display !== 'none' && rect.height >= 30 && rect.bottom > sheetRect.top && rect.top < sheetRect.bottom;
        }) : null;
      option?.click();
    })()`,
  });
  await sleep(150);
  const phoneCommitsRepoPick = (await send("Runtime.evaluate", {
    expression: `(() => ({
      hash: location.hash,
      summary: document.querySelector('.commits-filter-disclosure .filter-summary-disclosure-summary')?.textContent?.trim() || null,
      selectedRepoRows: document.querySelectorAll('.mobile-control-sheet[data-panel="commits-filters"] .commit-filter-option[data-kind="repo"].is-selected').length,
    }))()`,
    returnByValue: true,
  })).result.value || {};
  const phoneCommitsFilterDisclosure = {
    ...phoneCommitsFilterDisclosureBefore,
    ...phoneCommitsFilterDisclosureAfter,
    branchTabActive: phoneCommitsBranchTab.activeTab || null,
    branchTabVisibleBranchOptions: phoneCommitsBranchTab.visibleBranchOptions || 0,
    repoPickHashHasRepo: /[?&]repo=/.test(phoneCommitsRepoPick.hash || ""),
    repoPickSelectedRows: phoneCommitsRepoPick.selectedRepoRows || 0,
    repoPickSummary: phoneCommitsRepoPick.summary || null,
  };
  await send("Runtime.evaluate", { expression: "document.querySelector('.mobile-control-backdrop')?.click(); location.hash = '#/activity?kind=commit'" });
  await sleep(300);
  await waitHtml("document.querySelector('.activity-page')");
  // Flip the mobile toggle to Overview and confirm the single visible pane swaps
  // from the feed to the rhythm heatmap (which now only mounts in this view) and
  // that it still opens scrolled to the latest dates.
  await send("Runtime.evaluate", {
    expression: `(() => {
      const tab = Array.from(document.querySelectorAll('.activity-view-tab')).find((b) => b.textContent.trim() === 'Overview');
      tab?.click();
    })()`,
  });
  await sleep(300);
  await waitHtml("document.querySelector('.activity-heatmap')");
  const phoneActivityOverview = (await send("Runtime.evaluate", {
    expression: `(() => {
      const active = document.querySelector('.activity-view-toggle [role="tab"][aria-selected="true"]');
      const heatmap = document.querySelector('.activity-heatmap');
      const heatmapScroll = heatmap?.querySelector('.hm-calendar-scroll');
      const list = document.querySelector('.activity-list');
      const maxScroll = heatmapScroll ? Math.max(0, heatmapScroll.scrollWidth - heatmapScroll.clientWidth) : 0;
      return {
        activeTab: (active?.textContent || '').trim() || null,
        heatmapPresent: !!heatmap,
        listPresent: !!list,
        heatmapScrolledToLatest: !heatmapScroll || maxScroll === 0 || Math.abs(maxScroll - heatmapScroll.scrollLeft) <= 2,
        hashHasOverview: /[?&]tab=overview/.test(location.hash),
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  // Graph page on a phone: the List/Graph toggle shows one coupled pane at a
  // time, defaulting to the list. Confirm switching to Graph swaps in the canvas
  // (and drops the list), then that focusing an item from the list shows its
  // related items WITHOUT leaving the list (Option A — the canvas stays opt-in).
  await send("Runtime.evaluate", { expression: "location.hash = '#/graph'" });
  await sleep(300);
  await waitHtml("document.querySelector('.graph-view-toggle')");
  await send("Runtime.evaluate", {
    expression: `(() => {
      const tab = Array.from(document.querySelectorAll('.graph-view-tab')).find((b) => b.textContent.trim() === 'Graph');
      tab?.click();
    })()`,
  });
  await sleep(300);
  await waitHtml("document.querySelector('.graph-canvas')");
  const phoneGraphCanvas = (await send("Runtime.evaluate", {
    expression: `(() => {
      const active = document.querySelector('.graph-view-toggle [role="tab"][aria-selected="true"]');
      return {
        activeTab: (active?.textContent || '').trim() || null,
        canvasPresent: !!document.querySelector('.graph-canvas'),
        listPresent: !!document.querySelector('.graph-list'),
        hashHasGraph: /[?&]tab=graph/.test(location.hash),
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await send("Runtime.evaluate", {
    expression: `(() => {
      const tab = Array.from(document.querySelectorAll('.graph-view-tab')).find((b) => b.textContent.trim() === 'List');
      tab?.click();
    })()`,
  });
  await sleep(200);
  await waitHtml("document.querySelector('.graph-list-card')");
  await send("Runtime.evaluate", { expression: "document.querySelector('.graph-list-card')?.click()" });
  await sleep(300);
  const phoneGraphFocusInList = (await send("Runtime.evaluate", {
    expression: `(() => {
      const active = document.querySelector('.graph-view-toggle [role="tab"][aria-selected="true"]');
      return {
        activeTab: (active?.textContent || '').trim() || null,
        inFocusView: !!document.querySelector('.graph-list-back'),
        relatedShown: !!document.querySelector('.glc-rel-type'),
        listPresent: !!document.querySelector('.graph-list'),
        canvasPresent: !!document.querySelector('.graph-canvas'),
        hashHasFocus: /[?&]focus=/.test(location.hash),
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  await send("Runtime.evaluate", { expression: "location.hash = '#/repo-analytics'" });
  await sleep(300);
  await waitHtml("document.querySelector('.repo-analytics-page')");
  const phoneRepoAnalyticsLayout = (await send("Runtime.evaluate", {
    expression: `(() => {
      const row = document.querySelector('.repo-table tbody tr');
      const style = row ? getComputedStyle(row) : null;
      const columns = (style?.gridTemplateColumns || '').split(' ').filter(Boolean);
      const primary = Array.from(row?.querySelectorAll('.repo-metric-primary') || []);
      const secondary = Array.from(row?.querySelectorAll('.repo-metric-secondary') || []);
      const trendHeight = Math.round(row?.querySelector('.repo-trend-cell')?.getBoundingClientRect().height || 0);
      const qualityCell = row?.querySelector('.repo-quality-cell');
      const firstPrimaryTops = primary.slice(0, 4).map((cell) => Math.round(cell.getBoundingClientRect().top));
      const secondaryWidths = secondary.map((cell) => Math.round(cell.getBoundingClientRect().width));
      const primaryCentered = primary.length >= 4 && primary.every((cell) => {
        const s = getComputedStyle(cell);
        return s.alignItems === 'center' && s.justifyContent === 'center' && s.textAlign === 'center';
      });
      const secondaryGrouped = secondary.length === 6 && secondary.every((cell) => {
        const s = getComputedStyle(cell);
        return s.justifyContent === 'center' && s.textAlign === 'center';
      });
      return {
        found: !!row,
        gridColumns: columns.length,
        rowHeight: Math.round(row?.getBoundingClientRect().height || 0),
        primaryCount: primary.length,
        secondaryCount: secondary.length,
        primarySameRow: firstPrimaryTops.length === 4 && new Set(firstPrimaryTops).size === 1,
        primaryCentered,
        secondaryCompact: secondary.length === 6 && secondary.every((cell) => cell.getBoundingClientRect().height <= 38),
        secondaryReadable: secondaryWidths.length === 6 && Math.min(...secondaryWidths) >= 84,
        secondaryTight: secondaryWidths.length === 6 && Math.max(...secondaryWidths) <= 108,
        secondaryMinWidth: secondaryWidths.length ? Math.min(...secondaryWidths) : 0,
        secondaryMaxWidth: secondaryWidths.length ? Math.max(...secondaryWidths) : 0,
        secondaryGrouped,
        trendReadable: trendHeight >= 36 && trendHeight <= 48,
        trendHeight,
        actorsCompact: !row?.querySelector('.repo-actors-cell') || row.querySelector('.repo-actors-cell').getBoundingClientRect().height <= 42,
        qualityInHeader: !!row?.querySelector('.repo-mobile-quality .badge'),
        qualityCellHidden: !qualityCell || getComputedStyle(qualityCell).display === 'none',
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  // The range collapses by default on a phone now, so expand it before measuring
  // the date-input row layout (it is hidden while collapsed).
  await send("Runtime.evaluate", {
    expression: "(() => { const d = document.querySelector('.time-range-controls .range-disclosure'); if (d && getComputedStyle(d).display !== 'none' && d.getAttribute('aria-expanded') !== 'true') { d.click(); return 'expanded'; } return 'already-visible'; })()",
  });
  await sleep(150);
  const phoneRangeLayout = (await send("Runtime.evaluate", {
    expression: `(() => {
      const controls = document.querySelector('.time-range-controls');
      const labels = Array.from(controls?.querySelectorAll('.date-filter') || [])
        .filter((label) => getComputedStyle(label).display !== 'none');
      const container = document.querySelector('.mobile-control-sheet[data-panel="range"] .time-range-sheet-body') || controls;
      const wraps = labels.map((label) => label.querySelector('.date-input-wrap'));
      const controlRect = container?.getBoundingClientRect();
      const labelRects = labels.map((label) => label.getBoundingClientRect());
      const wrapRects = wraps.map((wrap) => wrap?.getBoundingClientRect());
      return {
        found: labels.length === 2 && wraps.length === 2,
        controlWidth: Math.round(controlRect?.width || 0),
        labelWidths: labelRects.map((rect) => Math.round(rect.width)),
        wrapWidths: wrapRects.map((rect) => Math.round(rect?.width || 0)),
        labelLefts: labelRects.map((rect) => Math.round(rect.left)),
        sameWrapWidth: wrapRects.length === 2 && Math.abs((wrapRects[0]?.width || 0) - (wrapRects[1]?.width || 0)) <= 1,
        fullWidthRows: labelRects.length === 2 && labelRects.every((rect) => controlRect && rect.width >= controlRect.width - 2),
      };
    })()`,
    returnByValue: true,
  })).result.value || {};
  // --- Diagnostics fill-height tabs (Sync runs, Daemon log) ----------------
  // These two #/debug tabs size to the viewport and scroll INTERNALLY (the log
  // no longer caps at 420px; a short runs table no longer leaves dead space).
  // The fill height derives from the real box, so it must hold under the
  // narrower mobile .app-wide padding AND the Android safe-area insets — check a
  // desktop viewport, a phone, and a simulated bottom inset, asserting the
  // document itself never scrolls (the panel absorbs the overflow) and the
  // runs-table header stays pinned.
  const debugFillResults = [];
  const debugFillCases = [
    { name: "desktop", width: 1440, height: 900, dpr: 1, mobile: false, insetBottom: "0px" },
    { name: "phone", width: 384, height: 854, dpr: 3, mobile: true, insetBottom: "0px" },
    { name: "phone-inset", width: 384, height: 854, dpr: 3, mobile: true, insetBottom: "48px" },
  ];
  const debugFillTabs = [
    { id: "sync", scroller: ".debug-runs-wrap", sticky: true },
    { id: "log", scroller: ".debug-log", sticky: false },
  ];
  for (const c of debugFillCases) {
    await send("Emulation.setDeviceMetricsOverride", { width: c.width, height: c.height, deviceScaleFactor: c.dpr, mobile: c.mobile });
    await send("Runtime.evaluate", { expression: `document.documentElement.style.setProperty('--android-safe-area-bottom', ${JSON.stringify(c.insetBottom)})` });
    for (const tab of debugFillTabs) {
      await send("Runtime.evaluate", { expression: `location.hash = '#/debug?tab=${tab.id}'` });
      await sleep(250);
      await waitHtml(`document.querySelector(${JSON.stringify(tab.scroller)})`);
      const r = (await send("Runtime.evaluate", {
        expression: `(() => {
          const doc = document.documentElement;
          const page = document.querySelector('.debug-page-fill');
          const scroller = document.querySelector(${JSON.stringify(tab.scroller)});
          if (!page || !scroller) return { found: false };
          const pr = page.getBoundingClientRect();
          const th = ${tab.sticky} ? document.querySelector(${JSON.stringify(tab.scroller + " thead th")}) : null;
          return {
            found: true,
            pageBottomGap: Math.round(window.innerHeight - pr.bottom),
            docOverflowY: Math.max(0, doc.scrollHeight - doc.clientHeight),
            scrollerScrolls: scroller.scrollHeight > scroller.clientHeight + 2,
            scrollerOverflowY: getComputedStyle(scroller).overflowY,
            stickyHeader: th ? getComputedStyle(th).position : 'n/a',
          };
        })()`,
        returnByValue: true,
      })).result.value || { found: false };
      debugFillResults.push({ case: c.name, tab: tab.id, ...r });
    }
  }
  await send("Runtime.evaluate", { expression: "document.documentElement.style.removeProperty('--android-safe-area-bottom')" });

  await send("Emulation.clearDeviceMetricsOverride");
  ws.close();

  // --- assertions ---
  const has = (h, s) => h.includes(s);
  const m = (h, re) => (h.match(re) || []).length;
  const classBlocks = (h, className) => [...h.matchAll(new RegExp(`class="${className}"[^>]*>([\\s\\S]*?)<\\/div>`, "g"))].map((x) => x[1] || "");
  const updatedBeforeCreated = (h, className) => {
    const blocks = classBlocks(h, className).filter((block) => block.includes("updated ") && block.includes("created "));
    return { count: blocks.length, ok: blocks.every((block) => block.indexOf("updated ") < block.indexOf("created ")) };
  };
  const boardCols = m(boardHtml, /class="col /g);
  // card root = `class="card"` OR `class="card …"` (e.g. the repo-highlight
  // `card card-accent`); match card followed by a space or the closing quote so
  // a modifier class doesn't drop the count. (Avoids matching card-head etc.)
  const boardCards = m(boardHtml, /class="card[ "]/g);
  const boardKindIcons = m(boardHtml, /icon-item-kind/g);
  const settingsRepos = m(settingsHtml, /class="settings-repo"/g);
  const settingIndex = (title) => (settingsDisplayModel.headings || []).indexOf(title);
  const expectedTabOrderBeforeMove = ["Live", "Activity", "Metrics", "Board", "Graph", "Items", "Reviews", "Commits", "Settings"];
  const expectedTabOrderAfterMove = ["Live", "Activity", "Metrics", "Graph", "Board", "Items", "Reviews", "Commits", "Settings"];
  const expectedContentRowsAfterMove = ["Activity", "Metrics", "Graph", "Board", "Items", "Reviews", "Commits"];
  const expectedStoredTabOrderAfterMove = JSON.stringify({ order: ["activity", "repo-analytics", "graph", "board", "items", "reviews", "commits"] });
  const graphCards = m(graphListHtml, /class="graph-list-card/g);
  const graphListKindIcons = m(graphListHtml, /icon-item-kind/g);
  const activityRows = activityDomRows || m(activityHtml, /class="activity-row/g);
  const repoRows = m(repoHtml, /class="repo-name-main/g);
  const boardGraphLinks = m(board2Html, /class="card-graph"/g);
  const boardRelationCounts = m(board2Html, /class="[^"]*\bitem-metric-related\b[^"]*"/g);
  const graphListRelationCounts = m(graphListHtml, /class="[^"]*\bitem-metric-related\b[^"]*"/g);
  const graphListGraphLinks = m(graphListHtml, /class="card-graph"/g);
  const graphNodeRelationCounts = m(graphHtml, /class="rf-related"/g);
  const boardTimeOrder = updatedBeforeCreated(boardHtml, "card-times muted");
  const graphNodeTimeOrder = updatedBeforeCreated(graphHtml, "rf-node-times muted");
  const graphListTimeOrder = updatedBeforeCreated(graphListHtml, "card-times muted");
  const normalizedStats = (text) => text.replace(/\s+/g, " ").trim();
  const hasStatText = (text, phrase) => normalizedStats(text).toLowerCase().includes(phrase);
  const statTotal = (text, label) => Number(new RegExp(`${label}\\s+total\\s+(\\d+)`, "i").exec(normalizedStats(text))?.[1] ?? Number.NaN);
  const boardInitialTotal = statTotal(boardInitialStats, "items");
  const boardNarrowTotal = statTotal(boardNarrowStats, "items");
  const graphInitialTotal = statTotal(graphInitialStats, "nodes");
  const graphNarrowTotal = statTotal(graphNarrowStats, "nodes");
  const expectedRangeButtons = ["today", "yesterday", "this week", "last week", "1w", "1mo", "3mo", "6mo", "1y"];
  const sameRangeButtons = (labels) => JSON.stringify(labels) === JSON.stringify(expectedRangeButtons);
  const portraitMissing = portraitResults.filter((r) => !r.ready);
  const portraitOverflow = portraitResults.filter((r) => r.overflow > 2);
  const phoneBoard = portraitResults.find((r) => r.preset === "phone-portrait" && r.page === "board") || {};
  const tabletBoard = portraitResults.find((r) => r.preset === "tablet-portrait" && r.page === "board") || {};
  const portraitRepos = portraitResults.filter((r) => r.page === "repo-analytics");
  const phoneFilterPages = portraitResults.filter((r) => r.preset === "phone-portrait" && !["commits", "settings", "debug"].includes(r.page));
  // Board + Graph carry the read-only StatsBar; on a phone it collapses by default.
  const phoneStatsPages = portraitResults.filter((r) => r.preset === "phone-portrait" && ["board", "graph"].includes(r.page));
  const phoneGraph = portraitResults.find((r) => r.preset === "phone-portrait" && r.page === "graph") || {};
  const tabletGraph = portraitResults.find((r) => r.preset === "tablet-portrait" && r.page === "graph") || {};
  const phoneHeaderPages = portraitResults.filter((r) => r.preset === "phone-portrait" && r.page !== "debug");
  const phoneContentPages = portraitResults.filter((r) => r.preset === "phone-portrait" && ["activity", "items", "commits", "reviews", "board", "graph", "repo-analytics"].includes(r.page));
  const phoneRangePages = portraitResults.filter((r) => r.preset === "phone-portrait" && r.page !== "settings");
  // Every content page (not Settings, not the chrome-less Debug page) renders the
  // shared date range, so every one of them collapses it behind a disclosure on a
  // phone — the first screen is content, not date pickers.
  const phoneRangeCollapsePages = portraitResults.filter((r) => r.preset === "phone-portrait" && !["settings", "debug"].includes(r.page));
  const liveSnapshotUrlsAfterPoll = Array.isArray(liveSnapshotAfterPoll.liveSnapshotUrls)
    ? liveSnapshotAfterPoll.liveSnapshotUrls
    : [];
  const hasLiveSnapshotUrl = (predicate) =>
    liveSnapshotUrlsAfterPoll.some((raw) => {
      try {
        return predicate(new URL(String(raw), "http://smoke.local"));
      } catch {
        return false;
      }
    });
  const phoneActivity = portraitResults.find((r) => r.preset === "phone-portrait" && r.page === "activity") || {};
  const portraitCommits = portraitResults.filter((r) => r.page === "commits");
  const phoneCommits = portraitCommits.filter((r) => r.preset === "phone-portrait");
  // Each fill case/tab must: render the page + scroller, keep the document from
  // scrolling (the panel absorbs the overflow), scroll the panel internally, and
  // reach near the viewport bottom (the gap is just the page margin + .app-wide
  // padding + any bottom inset, so allow up to ~90px for the inset case).
  const debugFillChecks = debugFillResults.flatMap((r) => {
    const where = `debug fill ${r.case}/${r.tab}`;
    return [
      [r.found, `${where}: page + scroller rendered`],
      [r.found && r.docOverflowY <= 2, `${where}: document does not scroll (overflow ${r.docOverflowY ?? "?"}px)`],
      [r.found && r.scrollerScrolls, `${where}: scroller scrolls internally`],
      [r.found && ["auto", "scroll"].includes(r.scrollerOverflowY), `${where}: scroller overflowY=${r.scrollerOverflowY}`],
      [r.found && r.pageBottomGap >= 0 && r.pageBottomGap <= 90, `${where}: fills near viewport bottom (gap ${r.pageBottomGap}px)`],
    ];
  });
  const debugSync = debugFillResults.find((r) => r.tab === "sync" && r.found);
  const debugStickyCheck = [!!debugSync && debugSync.stickyHeader === "sticky", `debug fill: Sync runs header sticky (${debugSync ? debugSync.stickyHeader : "n/a"})`];
  const badTitleLinkHitTargets = titleLinkHitTargets.filter((target) => !target.ok);
  const checks = [
    ...debugFillChecks,
    debugStickyCheck,
    [badTitleLinkHitTargets.length === 0, `app: provider title links only use their rendered text as the hit target (${JSON.stringify(titleLinkHitTargets)})`],
    // Live tab OFF by default: a hashless first open falls back to Activity with no Live tab in the bar.
    [(() => { try { const o = JSON.parse(liveOffLanding || "null"); return !!o && o.hasLiveTab === false && (o.hash || "").startsWith("#/activity") && liveSnapshotRequestsBeforeEnable === 0; } catch { return false; } })(), `app: Live tab is off by default — no Live tab, lands on Activity, no live snapshot probe (${liveOffLanding}, liveSnapshotRequests=${liveSnapshotRequestsBeforeEnable})`],
    // default entry: with Live enabled and pinned as the default, opening with no hash lands on Live.
    [has(defaultLandingHtml, "live-page") && has(defaultLandingHtml, "tab-on") && has(defaultLandingHtml, "Live"), "app: default route opens the configured default tab (Live, once enabled)"],
    [bootSplashServed && bootSplashRemoved === "gone", `app: cold-start boot splash renders in served HTML then is removed once ready (served=${bootSplashServed}, ${bootSplashRemoved})`],
    [scrollAutoHide.restHidden === true && scrollAutoHide.shownOnPageScroll === true && (scrollAutoHide.hasInner === false || scrollAutoHide.shownOnInnerScroll === true), `app: scrollbars stay hidden at rest and reveal the scroller on scroll (${JSON.stringify(scrollAutoHide)})`],
    [colorSchemeHints.colorScheme === "dark light" && colorSchemeHints.supportedColorSchemes === "dark light", `app: declares supported color schemes for mobile browsers (${JSON.stringify(colorSchemeHints)})`],
    [headerRefresh.title === "Symphony Board", `app: header uses product title (${headerRefresh.title || "empty"})`],
    [headerRefresh.hasButton === true && headerRefresh.label === "Refresh data", `app: header exposes a touch refresh button (${JSON.stringify(headerRefresh)})`],
    [headerRefresh.hasIdleAppIcon === true && headerRefresh.idleIconTag === "svg" && headerRefresh.idleIconViewBox === "0 0 1024 1024", `app: header refresh idles as the app SVG mark (${JSON.stringify(headerRefresh)})`],
    [headerRefresh.hasBusyRefreshGlyph === true && headerRefresh.restoredAppIcon === true, `app: header refresh shows glyph while loading then restores app icon (${JSON.stringify(headerRefresh)})`],
    [headerRefresh.clicked === true && headerRefresh.requestsAfter > headerRefresh.requestsBefore && headerRefresh.hashAfter === headerRefresh.hashBefore, `app: header refresh reloads data in place (${JSON.stringify(headerRefresh)})`],
    // page 1: the primary board fuses 4 status + 3 spotlight lanes into 7 columns
    [boardCards >= 5, `board: item cards rendered (${boardCards} >= 5)`],
    [boardKindIcons >= boardCards, `board: item kind renders as shared SVG icons (${boardKindIcons} icons for ${boardCards} cards)`],
    [has(boardHtml, "board-7"), "board: 7-column board rendered"],
    [boardCols >= 7, `board: >= 7 columns rendered (${boardCols})`],
    [has(boardHtml, "col-in_progress"), "board: In Progress status column present"],
    [has(boardHtml, "col-lane-pr"), "board: PR spotlight lane present"],
    [boardPaneLayout.fillsViewport === true, `board: lane height fills to the same viewport bottom gutter as list tabs (${JSON.stringify(boardPaneLayout)})`],
    [boardCardChrome.found === true && boardCardChrome.badgeStartsAfterIcon === true && boardCardChrome.titleStartsAfterIcon === true, `board: card SVG kind icon sits in the same fixed rail as list rows (${JSON.stringify(boardCardChrome)})`],
    [sameRangeButtons(boardRangeButtons), `board: shared range quick presets rendered without all (${boardRangeButtons.join(", ")})`],
    [initialRangePending?.header && initialRangePending?.tabs && initialRangePending?.rangeControls && initialRangePending?.contentRetained, `board: a range refetch keeps app chrome + loaded content mounted, no full-screen reload (${JSON.stringify(initialRangePending)})`],
    [rangeFailureRetained?.header && rangeFailureRetained?.tabs && rangeFailureRetained?.rangeControls && rangeFailureRetained?.contentRetained && /Could not load selected range/.test(rangeFailureRetained.error || ""), `board: a failed range refetch keeps stale content mounted with an inline error (${JSON.stringify(rangeFailureRetained)})`],
    [fileAuthorityUpload.input === true && fileAuthorityVisible?.sentinel === true && fileAuthorityAfterPending.sentinel === true && fileAuthorityAfterPending.hasBoardCard === true, `board: uploaded file env stays authoritative over a pending server reload (${JSON.stringify({ fileAuthorityUpload, fileAuthorityVisible, fileAuthorityAfterPending })})`],
    [activityDailyAfterFileUpload === activityDailyBeforeFileUpload, `board: uploaded range contract does not fetch server /api/activity-daily (${activityDailyBeforeFileUpload} -> ${activityDailyAfterFileUpload})`],
    [boardThisWeekClick.hash?.includes("preset=this-week") && JSON.stringify(boardThisWeekClick.active) === JSON.stringify(["this week"]), `board: clicking this week preserves this week as the only active preset (${boardThisWeekClick.hash || "empty"})`],
    [has(boardNarrowHtml, "range 2026-06-10 to 2026-06-10"), "board: custom range label rendered after API projection"],
    [hasStatText(boardInitialStats, "scope board window"), "board: stats are labelled as board-window scoped"],
    [Number.isFinite(boardInitialTotal) && boardNarrowTotal < boardInitialTotal, `board: scoped stats change when range narrows (${boardInitialTotal} -> ${boardNarrowTotal})`],
    // provider source marks: the sample contract carries both github + gitlab
    [has(boardHtml, 'aria-label="GitHub"'), "board: GitHub source mark rendered"],
    [has(boardHtml, 'aria-label="GitLab"'), "board: GitLab source mark rendered"],
    // repo/source highlight color: the sample carries a source color + a repo
    // color, so coloured repos render the left-bar `card-accent`
    [has(boardHtml, "card-accent"), "board: repo/source highlight bar rendered (card-accent)"],
    [boardTimeOrder.count >= 1 && boardTimeOrder.ok, `board: timestamps render updated before created (${boardTimeOrder.count})`],
    [boardFacetInitial.hasGroup === true, "board: route-backed facet Controls render a kind group"],
    [boardFacetInitial.anyOn === false && boardFacetInitial.hashHasIkind === false, "board: no kind chip is active before selection"],
    [boardFacetOn.chipOn === true && boardFacetOn.chipText === boardFacetInitial.value && boardFacetOn.onCount === 1 && /[?&]ikind=/.test(boardFacetOn.hash || ""), `board: a kind chip lights up and writes ikind to the route (${boardFacetOn.hash})`],
    [graphFacetCarry.hash.startsWith("#/graph") && /[?&]ikind=/.test(graphFacetCarry.hash || "") && graphFacetCarry.chipOn === true && graphFacetCarry.chipText === boardFacetInitial.value, `board: the shared item lens carries across the tab hop to graph (${graphFacetCarry.hash})`],
    [boardReviewInitial.hasGroup === true && (boardReviewInitial.chips || []).includes("unresolved") && (boardReviewInitial.chips || []).includes("has threads") && boardReviewInitial.anyOn === false && boardReviewInitial.hashHasIreview === false, `board: review-thread lens renders its chips, none active on a fresh board (${(boardReviewInitial.chips || []).join(", ")})`],
    [boardReviewOn.chipOn === true && boardReviewOn.chipText === "unresolved" && /[?&]ireview=unresolved/.test(boardReviewOn.hash || ""), `board: the 'unresolved' review chip lights up and writes ireview to the route (${boardReviewOn.hash})`],
    [portraitMissing.length === 0, `portrait: all page roots render at phone/tablet presets (${portraitMissing.map((r) => `${r.preset}:${r.page}`).join(", ") || "ok"})`],
    [portraitOverflow.length === 0, `portrait: app shell avoids page-level horizontal overflow (${portraitOverflow.map((r) => `${r.preset}:${r.page}+${r.overflow}px`).join(", ") || "ok"})`],
    [phoneBoard.boardSelectorVisible === true && phoneBoard.visibleBoardColumns === 1, `portrait: phone board uses one selected lane (${phoneBoard.visibleBoardColumns || 0} visible, selector=${phoneBoard.boardSelectorVisible})`],
    [tabletBoard.boardSelectorVisible === false && tabletBoard.visibleBoardColumns >= 4, `portrait: tablet board keeps multi-lane access without the phone selector (${tabletBoard.visibleBoardColumns || 0} columns)`],
    [tabletGraph.graphStacked === true && tabletGraph.graphListPresent === true && tabletGraph.graphCanvasPresent === true, `portrait: tablet graph stacks both the list and the canvas (stacked=${tabletGraph.graphStacked}, list=${tabletGraph.graphListPresent}, canvas=${tabletGraph.graphCanvasPresent})`],
    [phoneGraph.graphViewTogglePresent === true && phoneGraph.graphViewActiveTab === "List" && phoneGraph.graphListPresent === true && phoneGraph.graphCanvasPresent === false, `portrait: phone graph defaults to the list behind a List/Graph toggle (active=${phoneGraph.graphViewActiveTab}, list=${phoneGraph.graphListPresent}, canvas=${phoneGraph.graphCanvasPresent})`],
    [phoneGraph.graphKindToggleCount === 3 && phoneGraph.graphKindToggleMaxHeight > 0 && phoneGraph.graphKindToggleMaxHeight <= 31, `portrait: phone graph side-list kind toggles stay compact (${JSON.stringify({ count: phoneGraph.graphKindToggleCount, height: phoneGraph.graphKindToggleMaxHeight, width: phoneGraph.graphKindToggleMaxWidth })})`],
    [phoneGraphCanvas.activeTab === "Graph" && phoneGraphCanvas.canvasPresent === true && phoneGraphCanvas.listPresent === false && phoneGraphCanvas.hashHasGraph === true, `portrait: phone graph Graph tab swaps in the canvas and drops the list (${JSON.stringify(phoneGraphCanvas)})`],
    [phoneGraphFocusInList.activeTab === "List" && phoneGraphFocusInList.inFocusView === true && phoneGraphFocusInList.relatedShown === true && phoneGraphFocusInList.canvasPresent === false && phoneGraphFocusInList.hashHasFocus === true, `portrait: phone graph focusing an item stays in the list's focus view, no auto-switch to canvas (${JSON.stringify(phoneGraphFocusInList)})`],
    [portraitRepos.every((r) => r.repoCompact === true), "portrait: repo analytics switches away from the wide table"],
    [phoneRepoAnalyticsLayout.found === true && phoneRepoAnalyticsLayout.gridColumns >= 4 && phoneRepoAnalyticsLayout.primaryCount === 4 && phoneRepoAnalyticsLayout.secondaryCount === 6 && phoneRepoAnalyticsLayout.primarySameRow === true && phoneRepoAnalyticsLayout.primaryCentered === true && phoneRepoAnalyticsLayout.secondaryCompact === true && phoneRepoAnalyticsLayout.secondaryReadable === true && phoneRepoAnalyticsLayout.secondaryTight === true && phoneRepoAnalyticsLayout.secondaryGrouped === true && phoneRepoAnalyticsLayout.trendReadable === true && phoneRepoAnalyticsLayout.actorsCompact === true && phoneRepoAnalyticsLayout.qualityInHeader === true && phoneRepoAnalyticsLayout.qualityCellHidden === true && phoneRepoAnalyticsLayout.rowHeight <= 290, `portrait: repo analytics uses compact mobile cards (${JSON.stringify(phoneRepoAnalyticsLayout)})`],
    [phoneFilterPages.every((r) => r.filterButtonVisible === true && r.filterGroupsCollapsed === true), `portrait: phone facet filters start collapsed behind a button (${phoneFilterPages.map((r) => `${r.page}:button=${r.filterButtonVisible},collapsed=${r.filterGroupsCollapsed}`).join("; ")})`],
    [phoneFilterPages.length > 0 && phoneFilterPages.every((r) => r.fileLoadHidden === true), `portrait: phone hides the rarely-used local file loader (${phoneFilterPages.map((r) => `${r.page}:hidden=${r.fileLoadHidden}`).join("; ")})`],
    [phoneHeaderPages.every((r) => r.headerSourcesCount >= 3 && r.headerSourcesOneLine === true && r.headerSourcesHeight <= 32 && r.headerSourceChipFlexGrow === "0"), `portrait: phone source health strip stays compact and content-sized (${phoneHeaderPages.map((r) => `${r.page}:count=${r.headerSourcesCount},oneLine=${r.headerSourcesOneLine},height=${r.headerSourcesHeight},grow=${r.headerSourceChipFlexGrow}`).join("; ")})`],
    [phoneContentPages.every((r) => r.primarySurfaceTop > 0 && r.primarySurfaceTop <= 360), `portrait: phone primary content starts in the first screen (${phoneContentPages.map((r) => `${r.page}:top=${r.primarySurfaceTop}`).join("; ")})`],
    [phoneRangePages.every((r) => r.rangeControlsVisible === true), "portrait: phone keeps date range controls visible"],
    [phoneRangeLayout.found === true && phoneRangeLayout.sameWrapWidth === true && phoneRangeLayout.fullWidthRows === true, `portrait: phone date range inputs use equal full-width rows (${JSON.stringify(phoneRangeLayout)})`],
    [phoneSearchDisclosure.sheetVisible === true && phoneSearchDisclosure.sheetTitle === "Search" && phoneSearchDisclosure.inputVisible === true && phoneSearchDisclosure.inputHeight >= 34 && phoneSearchDisclosure.inputHeight <= 52 && phoneSearchDisclosure.sheetHeight <= 150 && Math.abs((phoneSearchDisclosure.primaryTopDuring || 0) - (phoneActiveFilterDisclosureBefore.primaryTopBefore || 0)) <= 4, `portrait: mobile search sheet uses one compact input without pushing feed (${JSON.stringify(phoneSearchDisclosure)})`],
    [phoneActiveFilterDisclosure.hasButton === true && phoneActiveFilterDisclosure.buttonVisible === true && /1 active/.test(phoneActiveFilterDisclosure.buttonText || "") && phoneActiveFilterDisclosure.groupsHidden === true && phoneActiveFilterDisclosure.rangeVisible === true && phoneActiveFilterDisclosure.searchVisible === false && phoneActiveFilterDisclosure.groupsVisible === true && phoneActiveFilterDisclosure.activeChipVisible === true && phoneActiveFilterDisclosure.rangeDisclosureHeight > 0 && phoneActiveFilterDisclosure.rangeDisclosureHeight <= 48, `portrait: active phone filters open without keeping search inline (${JSON.stringify(phoneActiveFilterDisclosure)})`],
    [phoneActiveFilterDisclosure.sheetVisible === true && phoneActiveFilterDisclosure.sheetCount === 1 && phoneActiveFilterDisclosure.sheetTitle === "Filters" && Math.abs((phoneActiveFilterDisclosure.primaryTopAfter || 0) - (phoneActiveFilterDisclosure.primaryTopBefore || 0)) <= 4, `portrait: mobile search/filter expansion opens one filter overlay sheet without pushing feed (${JSON.stringify(phoneActiveFilterDisclosure)})`],
    [phoneCommitsFilterDisclosure.hasButton === true && phoneCommitsFilterDisclosure.buttonVisible === true && phoneCommitsFilterDisclosure.toolbarHidden === true && phoneCommitsFilterDisclosure.sheetVisible === true && phoneCommitsFilterDisclosure.sheetCount === 1 && phoneCommitsFilterDisclosure.sheetTitle === "Filters" && phoneCommitsFilterDisclosure.tabCount === 2 && phoneCommitsFilterDisclosure.activeTab === "Repo" && phoneCommitsFilterDisclosure.branchTabActive === "Branch" && phoneCommitsFilterDisclosure.repoInputVisible === false && phoneCommitsFilterDisclosure.repoInputFocused === false && phoneCommitsFilterDisclosure.branchSelectVisible === false && phoneCommitsFilterDisclosure.repoOptions >= 2 && phoneCommitsFilterDisclosure.visibleRepoOptions >= 1 && phoneCommitsFilterDisclosure.branchTabVisibleBranchOptions >= 3 && phoneCommitsFilterDisclosure.visibleBranchOptions === 0 && phoneCommitsFilterDisclosure.repoPickHashHasRepo === true && phoneCommitsFilterDisclosure.repoPickSelectedRows === 1 && phoneCommitsFilterDisclosure.sheetHeight >= Math.round((phoneCommitsFilterDisclosure.viewportHeight || 0) * 0.45) && Math.abs((phoneCommitsFilterDisclosure.primaryTopAfter || 0) - (phoneCommitsFilterDisclosure.primaryTopBefore || 0)) <= 4, `portrait: mobile commits filters open a repo-first sheet mode without keyboard/native popups or pushing feed (${JSON.stringify(phoneCommitsFilterDisclosure)})`],
    [phoneActivity.activityViewTogglePresent === true && phoneActivity.activityViewActiveTab === "Feed" && phoneActivity.activityListPresent === true && phoneActivity.activityHeatmapPresent === false && phoneActivity.activityListHeight > Math.round(phoneActivity.viewportHeight * 0.6), `portrait: phone activity defaults to a tall records feed behind a Feed/Overview toggle (active=${phoneActivity.activityViewActiveTab}, feed=${phoneActivity.activityListHeight || 0}px/${phoneActivity.viewportHeight || 0}px, heatmap=${phoneActivity.activityHeatmapPresent})`],
    [phoneActivityOverview.activeTab === "Overview" && phoneActivityOverview.heatmapPresent === true && phoneActivityOverview.listPresent === false && phoneActivityOverview.heatmapScrolledToLatest === true && phoneActivityOverview.hashHasOverview === true, `portrait: phone activity Overview tab swaps in the rhythm heatmap, scrolled to the latest dates (${JSON.stringify(phoneActivityOverview)})`],
    [phoneActivity.activityChipsWrap === true && phoneActivity.activityRowsNotClipped === true, `portrait: phone activity chips wrap without clipping (wrap=${phoneActivity.activityChipsWrap}, rows=${phoneActivity.activityRowsNotClipped})`],
    [portraitCommits.length > 0 && portraitCommits.every((r) => r.commitRowCount > 0 && r.commitRowsWithinSlot === true && r.commitRefChipsSingleLine === true), `portrait: commit rows stay within their virtualized slot with a long branch chip (${portraitCommits.map((r) => `${r.preset}:rows=${r.commitRowCount},withinSlot=${r.commitRowsWithinSlot},chip1line=${r.commitRefChipsSingleLine},maxBody=${r.commitMaxBodyHeight},minSlot=${r.commitMinSlotHeight}`).join("; ")})`],
    [phoneRangeCollapsePages.length > 0 && phoneRangeCollapsePages.every((r) => r.rangeDisclosureVisible === true && r.rangeFieldsCollapsed === true), `portrait: phone collapses the date range behind a disclosure on every content page (${phoneRangeCollapsePages.map((r) => `${r.page}:disclosure=${r.rangeDisclosureVisible},collapsed=${r.rangeFieldsCollapsed}`).join("; ")})`],
    [phoneFilterPages.length > 0 && phoneFilterPages.every((r) => r.filterDisclosureCompact === true), `portrait: phone facet disclosure uses the compact toolbar summary chrome (${phoneFilterPages.map((r) => `${r.page}:compact=${r.filterDisclosureCompact}`).join("; ")})`],
    [phoneStatsPages.length > 0 && phoneStatsPages.every((r) => r.statsDisclosureVisible === true && r.statsBodyCollapsed === true), `portrait: phone collapses the read-only stat summary behind a disclosure by default (${phoneStatsPages.map((r) => `${r.page}:disclosure=${r.statsDisclosureVisible},collapsed=${r.statsBodyCollapsed}`).join("; ")})`],
    [phoneGraph.graphLegendTucked === true && phoneGraph.statsBodyCollapsed === true, `portrait: phone graph tucks the legend + hint inside the collapsed stats disclosure (tucked=${phoneGraph.graphLegendTucked}, collapsed=${phoneGraph.statsBodyCollapsed})`],
    [phoneCommits.length > 0 && phoneCommits.every((r) => r.commitsFilterDisclosureVisible === true && r.commitsToolbarCollapsed === true), `portrait: phone commits collapses the repo + branch filters behind a disclosure by default (${phoneCommits.map((r) => `disclosure=${r.commitsFilterDisclosureVisible},collapsed=${r.commitsToolbarCollapsed}`).join("; ")})`],
    // page 2: the relationship graph mounts and the lazy chunk loads
    [has(graphHtml, "graph-page"), "graph: page rendered"],
    [/showing \d+ nodes/.test(graphHtml), "graph: node/link count shown"],
    [/react-flow__node/.test(graphHtml), "graph: React Flow card nodes rendered (DOM)"],
    [graphNodeTimeOrder.count >= 1 && graphNodeTimeOrder.ok, `graph: node timestamps render updated before created (${graphNodeTimeOrder.count})`],
    [sameRangeButtons(graphRangeButtons), `graph: shared range quick presets rendered without all (${graphRangeButtons.join(", ")})`],
    [hasStatText(graphInitialStats, "scope graph window"), "graph: stats are labelled as graph-window scoped"],
    [Number.isFinite(graphInitialTotal) && graphNarrowTotal < graphInitialTotal, `graph: scoped stats change when range narrows (${graphInitialTotal} -> ${graphNarrowTotal})`],
    [graphPaneLayout.found === true && graphPaneLayout.heightsMatch === true && graphPaneLayout.masterDetailShare === true && graphPaneLayout.fillsViewport === true, `graph: list/canvas use the shared master-detail proportion and viewport height (${JSON.stringify(graphPaneLayout)})`],
    // graph side list: enriched cards + click-to-focus related view
    [graphCards >= 2, `graph: side-list cards rendered (${graphCards} >= 2)`],
    [graphListKindIcons >= graphCards, `graph: side-list item kind renders as shared SVG icons (${graphListKindIcons} icons for ${graphCards} cards)`],
    [graphListTimeOrder.count >= 1 && graphListTimeOrder.ok, `graph: side-list timestamps render updated before created (${graphListTimeOrder.count})`],
    [graphCardChrome.found === true && graphCardChrome.badgeStartsAfterIcon === true && graphCardChrome.titleStartsAfterIcon === true, `graph: side-list card SVG kind icon sits in the same fixed rail as list rows (${JSON.stringify(graphCardChrome)})`],
    [has(focusHtml, "graph-list-back"), "graph: focus view back button present"],
    [hasStatText(focusStats, "scope focus"), "graph: focus stats are labelled separately from overview"],
    [/\d+ related item/.test(focusHtml), "graph: focus view related-items header shown"],
    [/glc-rel-type/.test(focusHtml), "graph: focus view lists related items (relation tag)"],
    [has(toggleOffHtml, "graph-list-search") && !has(toggleOffHtml, "graph-list-back"), "graph: re-clicking the focused card toggles focus off (back to the searchable list)"],
    [has(backHtml, "graph-list-search"), "graph: back returns to the searchable list"],
    // graph side-list cards reuse the board card, so they pick up the highlight bar too
    [has(graphListHtml, "card-accent"), "graph: side-list highlight bar rendered (card-accent)"],
    // ...and the chain-link relation count, but NOT the focus-in-graph head link
    // (the card body IS the focus target on this page).
    [graphListRelationCounts >= 1, `graph: side-list cards render the relation count (${graphListRelationCounts} >= 1)`],
    [graphListGraphLinks === 0, `graph: side-list cards do not render the focus-in-graph link (${graphListGraphLinks} === 0)`],
    // canvas nodes carry the chain-link count too — the FULL relation count
    // (what focusing reveals), not the windowed drawn-edge degree.
    [graphNodeRelationCounts >= 1, `graph: canvas nodes render the relation count (${graphNodeRelationCounts} >= 1)`],
    [graphNodeOverflows.length === 0, `graph: node content fits inside the node box (${graphNodeOverflows.length} overflowing: ${graphNodeOverflow})`],
    [graphCanvasPaneBg === "rgb(1, 22, 39)", `graph: canvas pane paints the --bg theme token, not ReactFlow's default grey (${graphCanvasPaneBg})`],
    // focusing suspends the time-range controls (the range is not a condition in
    // focus view); leaving focus re-enables them. The selection itself is kept —
    // only the styling/interactivity flips.
    [has(deepLinkHtml, "range-suspended"), "graph: focus suspends the time-range controls (range-suspended)"],
    [!has(backHtml, "range-suspended"), "graph: leaving focus re-enables the time-range controls"],
    // page 3: activity feed renders activity rows and shared filtering surfaces
    [has(activityHtml, "activity-page"), "activity: page rendered"],
    [activityFacetInitial.hasGroup === true, "activity: route-backed facet Controls render a kind group"],
    [activityFacetInitial.anyOn === false && activityFacetInitial.hashHasKind === false, "activity: no kind chip is active before any drill-down"],
    [activityFacetOn.chipOn === true && activityFacetOn.chipText === activityFacetInitial.value && activityFacetOn.onCount === 1, `activity: clicking a kind chip lights up that chip (${activityFacetOn.chipText})`],
    [/[?&]kind=/.test(activityFacetOn.hash || ""), `activity: the lit kind chip is written into the route (${activityFacetOn.hash})`],
    [activityFacetCleared.hashHasKind === false && activityFacetCleared.anyOn === false, "activity: clicking the active kind chip clears it from both route and chips"],
    [sameRangeButtons(activityRangeButtons), `activity: shared range quick presets rendered without all (${activityRangeButtons.join(", ")})`],
    [JSON.stringify(activityRangeInputs.types) === JSON.stringify(["text", "text"]) && JSON.stringify(activityRangeInputs.placeholders) === JSON.stringify(["YYYY/MM/DD", "YYYY/MM/DD"]) && /^\d{4}\/\d{2}\/\d{2}$/.test(activityRangeInputs.from || "") && /^\d{4}\/\d{2}\/\d{2}$/.test(activityRangeInputs.to || ""), `activity: range dates render as fixed YYYY/MM/DD text (${activityRangeInputs.from || "empty"} to ${activityRangeInputs.to || "empty"})`],
    [(activityRangeInputs.wrapWidths || []).length === 2 && activityRangeInputs.wrapWidths.every((width) => width >= 120 && width <= 150), `activity: range date fields stay compact (${(activityRangeInputs.wrapWidths || []).join(", ") || "none"}px)`],
    [activityRangeInputs.pickerButtons === 2 && activityDatePicker.open === true && activityDatePicker.days >= 28, `activity: range dates keep an app-rendered calendar picker (${activityRangeInputs.pickerButtons || 0} buttons, ${activityDatePicker.days || 0} days)`],
    [activityRows >= 4, `activity: rows rendered (${activityRows} >= 4)`],
    [/1200 in range/.test(activityCountText), `activity: large smoke feed count rendered (${activityCountText})`],
    [activityRows < 80, `activity: virtualized rows stay bounded (${activityRows} < 80)`],
    [has(activityHtml, "committed") && has(activityHtml, "merged") && has(activityHtml, "closed"), "activity: action badges rendered"],
    [has(activityHtml, "commit abc1234") && has(activityHtml, "Ship activity feed"), "activity: commit headline shows short sha and title"],
    [has(activityHtml, "change request #13") && has(activityHtml, "Fix flaky sync-engine test"), "activity: change request headline shows iid and title"],
    [has(activityHtml, "ref main") && has(activityHtml, "from 111") && has(activityHtml, "to 222"), "activity: push row shows ref and commit range chips"],
    [has(activityHtml, "card-accent"), "activity: repo/source highlight bar rendered (card-accent)"],
    [!activityHeatmap.present || activityHeatmap.summary === true, "activity: rhythm summary row rendered"],
    [!activityHeatmap.present || JSON.stringify(activityHeatmap.overviewLabels) === JSON.stringify(["events", "busiest day", "active days", "commit", "change request", "review"]), `activity: overview summary keeps rhythm metrics above kind counts (${(activityHeatmap.overviewLabels || []).join(", ")})`],
    [!activityHeatmap.present || activityHeatmap.scope === true, "activity: rhythm section shows its 12-month date range"],
    [!activityHeatmap.present || activityHeatmap.columns === 53, `activity: rhythm heatmap renders one 53-week grid (${activityHeatmap.columns})`],
    [!activityHeatmap.present || activityHeatmap.trend === true, "activity: selected-range trend line rendered"],
    [!activityHeatmap.present || activityHeatmap.trendBucket === "day", `activity: this-week trend uses daily buckets (${activityHeatmap.trendBucket})`],
    [!activityHeatmap.present || activityHeatmap.trendScope === true, "activity: selected-range trend shows its date range"],
    [!activityHeatmap.present || activityHeatmap.rangeSummary === true, "activity: selected-range summary rendered below the trend"],
    [!activityHeatmap.present || JSON.stringify(activityHeatmap.rangeLabels) === JSON.stringify(["events", "busiest day", "active days", "commit", "change request", "review"]), `activity: selected range summary keeps rhythm metrics above kind counts (${(activityHeatmap.rangeLabels || []).join(", ")})`],
    [!activityHeatmap.present || activityHeatmap.rangeRepos >= 1, `activity: selected-range repo summary rendered (${activityHeatmap.rangeRepos || 0} rows)`],
    [!activityHeatmap.present || activityHeatmap.rangeReposSorted === true, "activity: selected-range repo summary sorted by events desc"],
    [!activityHeatmap.present || trendHover.hits > 0, `activity: trend hover hit bands rendered (${trendHover.hits})`],
    [!activityHeatmap.present || trendHover.legend >= 1, `activity: trend legend toggles rendered (${trendHover.legend})`],
    [!activityHeatmap.present || trendHover.lines >= 1, `activity: trend overlay lines rendered (${trendHover.lines})`],
    [!activityHeatmap.present || trendHover.tip === true, "activity: hovering a trend point shows the per-line counts tooltip"],
    [!activityHeatmap.present || trendHover.focus === true, "activity: hovering a trend point enlarges it (focus dot)"],
    [!activityHeatmap.present || activityHeatmap.balancedHeight === true, `activity: feed height balances rhythm panel on wide layout (${activityHeatmap.listHeight}px/${activityHeatmap.panelHeight}px)`],
    [activityBreakpoint["1450"]?.stacked === true && activityBreakpoint["1451"]?.sideBySide === true && activityBreakpoint["1451"]?.gap === "4px", `activity: desktop rhythm split changes at the 1451px breakpoint (${JSON.stringify(activityBreakpoint)})`],
    [!activityHeatmap.present || (activityHeatmap.inRange >= 1 && activityHeatmap.inRange < activityHeatmap.total), `activity: selected range tints a scoped subset of heatmap cells (${activityHeatmap.inRange}/${activityHeatmap.total} in range, present=${activityHeatmap.present})`],
    // page 3b: Items renders issues and PR/MRs in one chronological lookup surface
    [has(itemsHtml, "items-page"), "items: page rendered"],
    [sameRangeButtons(itemsRangeButtons), `items: shared range quick presets rendered without all (${itemsRangeButtons.join(", ")})`],
    [itemsSummary.rows >= 2, `items: rows rendered (${itemsSummary.rows || 0} >= 2)`],
    [itemsSummary.providerLinks >= 1, `items: provider title links rendered (${itemsSummary.providerLinks || 0} >= 1)`],
    [itemsSummary.graphLinks >= 1, `items: related rows keep a focus-in-graph affordance (${itemsSummary.graphLinks || 0} >= 1)`],
    [itemsSummary.detailMetricGraphLinks >= 1, `items: detail related metric remains a focus-in-graph link (${itemsSummary.detailMetricGraphLinks || 0} >= 1)`],
    [/updated \d/.test(itemsSummary.firstUpdated || ""), `items: newest row exposes the updated timestamp first (${itemsSummary.firstUpdated || "empty"})`],
    [itemsSummary.hasKindGroup === true && (itemsSummary.kindChips || []).includes("issue") && (itemsSummary.kindChips || []).includes("PR/MR") && !(itemsSummary.kindChips || []).includes("change_request") && !(itemsSummary.kindChips || []).includes("all"), `items: reuses the shared kind chips with PR/MR display and no separate all control (${(itemsSummary.kindChips || []).join(", ") || "none"})`],
    [itemsSummary.split === true && itemsSummary.detail === true && itemsSummary.listLeftOfDetail === true, `items: renders a left list with a right detail pane (${JSON.stringify({ split: itemsSummary.split, detail: itemsSummary.detail, listLeftOfDetail: itemsSummary.listLeftOfDetail })})`],
    [itemsSummary.initialDetailTitle.includes(itemsSummary.firstTitle || "__missing__"), `items: defaults the detail pane to the newest row (${JSON.stringify({ row: itemsSummary.firstTitle, detail: itemsSummary.initialDetailTitle })})`],
    [itemsSummary.afterClickDetailTitle.includes(itemsSummary.secondTitle || "__missing__"), `items: selecting a row updates the detail pane (${JSON.stringify({ row: itemsSummary.secondTitle, detail: itemsSummary.afterClickDetailTitle })})`],
    [itemsSummary.selectedRows === 1, `items: exactly one row is marked selected (${itemsSummary.selectedRows || 0})`],
    [(itemsSummary.detailBodyText || "").includes("Provider body"), `items: detail pane renders the synced provider body (${itemsSummary.detailBodyText || "empty"})`],
    [itemsSummary.detailFillsListHeight === true && itemsSummary.detailCardFillsPane === true && itemsSummary.fillsViewport === true, `items: detail pane stretches to list height, fills the viewport gutter, and its card fills the pane (${JSON.stringify({ list: itemsSummary.listHeight, detail: itemsSummary.detailHeight, card: itemsSummary.detailCardHeight, bottomGap: itemsSummary.bottomGap })})`],
    [/\d+ in range|\d+ of \d+/.test(itemsCountText || ""), `items: in-range count rendered (${itemsCountText || "empty"})`],
    // live: the realtime feed seeds from the snapshot and renders precise links
    [has(liveHtml, "live-page"), "live: page rendered"],
    [(() => { try { const o = JSON.parse(sparkTap || "null"); return !!o && o.bars > 0 && o.isDefault === false && /\d\d:\d\d.\d\d:\d\d/.test(o.caption); } catch { return false; } })(), `live: a sparkline bar selects on the first tap (focus+click), showing its bucket window (${sparkTap})`],
    [live.rendered === true && live.rows === 3, `live: snapshot seeds every retained feed row (${live.rows || 0} === 3)`],
    [(live.firstRowTop || 0) >= (live.feedTop || 0) - 1 && (live.firstRowBottom || 0) <= (live.feedBottom || 0) + 1, `live: first virtualized feed row is visible inside the feed viewport (${JSON.stringify({ firstRowTop: live.firstRowTop, firstRowBottom: live.firstRowBottom, feedTop: live.feedTop, feedBottom: live.feedBottom })})`],
    [(live.documentScrollHeight || 0) <= (live.documentClientHeight || 0) + 2, `live: desktop Live page does not grow taller than the viewport (${JSON.stringify({ scrollHeight: live.documentScrollHeight, clientHeight: live.documentClientHeight })})`],
    [live.avatarHref === "https://github.com/octocat" && /avatars\.githubusercontent\.com\/u\/583231/.test(live.avatarImgSrc || "") && /Octocat/.test(live.avatarLabel || ""), `live: newest row renders a linked profile avatar (${JSON.stringify({ href: live.avatarHref, src: live.avatarImgSrc, label: live.avatarLabel })})`],
    [(live.rowText || []).some((text) => text.includes("Old widget note")), `live: row outside the 5h pulse remains retained in the 1000-event buffer (${JSON.stringify(live.rowText || [])})`],
    [live.avatarDotContent === "none", `live: feed avatars render without a lower-right category dot (${live.avatarDotContent || "empty"})`],
    [(live.unselectedAccent?.width || 0) >= 3 && (live.unselectedAccent?.opacity || 0) > 0.4 && live.unselectedAccent?.matchesCategory === true && !/rgba\\(0, 0, 0, 0\\)/.test(live.unselectedAccent?.background || ""), `live: non-selected rows show the category-colored left accent line (${JSON.stringify(live.unselectedAccent || {})})`],
    [live.selectedAccent?.matchesCategory === true && live.selectedAccent?.category !== live.unselectedAccent?.category && live.selectedAccent?.background !== live.unselectedAccent?.background, `live: distinct event categories render distinct left accent colours (${JSON.stringify({ selected: live.selectedAccent, unselected: live.unselectedAccent })})`],
    [(live.selectedAccent?.opacity || 0) > (live.unselectedAccent?.opacity || 0) && live.selectedAccent?.rowBackground !== live.unselectedAccent?.rowBackground, `live: selected row keeps stronger accent/background emphasis (${JSON.stringify({ selected: live.selectedAccent, unselected: live.unselectedAccent })})`],
    [live.detailAvatarHref === "https://github.com/octocat" && /avatars\.githubusercontent\.com\/u\/583231/.test(live.detailAvatarImgSrc || "") && /Octocat/.test(live.detailAvatarLabel || "") && live.detailAvatarDotContent === "none", `live: detail pane renders the selected actor avatar without a dot (${JSON.stringify({ href: live.detailAvatarHref, src: live.detailAvatarImgSrc, label: live.detailAvatarLabel, dot: live.detailAvatarDotContent })})`],
    [/^2\/5h$/.test(live.activityText || ""), `live: Activity headline counts the full sparkline window, including the outside-hour event (${live.activityText || "empty"})`],
    [/^3\/1000$/.test(live.bufferText || ""), `live: Buffer headline shows retained rows over the memory cap (${live.bufferText || "empty"})`],
    [(live.bufferRanks || [])[0] === "The Octocat · 2 events" && (live.bufferRanks || [])[1] === "hubot · 1 event", `live: Buffer ranks people by retained activity (${JSON.stringify(live.bufferRanks || [])})`],
    [(live.repoRanks || [])[0] === "acme/widgets · 3 events", `live: Active now ranks repos by retained activity (${JSON.stringify(live.repoRanks || [])})`],
    [Math.abs((live.detailPaneHeight || 0) - (live.feedHeight || 0)) <= 2 && (live.detailPaneHeight || 0) > 0, `live: detail pane height matches the feed height (${live.detailPaneHeight || 0}px vs ${live.feedHeight || 0}px)`],
    [live.detailCardFillsPane === true, `live: short detail card fills the pane (${JSON.stringify({ pane: live.detailPaneHeight, card: live.detailCardHeight })})`],
    // The cold-start seed requests the SMALL seed limit (LIVE_SEED_LIMIT=200), not
    // the buffer cap, so the first paint isn't a ~26MB download; the poll-since
    // request still uses the buffer cap (it returns only rows after the cursor).
    [hasLiveSnapshotUrl((url) => url.pathname === "/api/live-snapshot" && url.searchParams.get("limit") === String(LIVE_SEED_LIMIT) && !url.searchParams.has("since")), `live: cold-start seed requests the small seed limit (${liveSnapshotUrlsAfterPoll.join(", ") || "none"})`],
    [hasLiveSnapshotUrl((url) => url.pathname === "/api/live-snapshot" && url.searchParams.get("limit") === String(LIVE_EVENT_BUFFER_LIMIT) && url.searchParams.get("since") === "3"), `live: polling fallback requests only rows after the cursor (${liveSnapshotUrlsAfterPoll.join(", ") || "none"})`],
    [live.statusUnavailable === false, `live: a seeded feed never reads Unavailable (${live.statusText || "empty"})`],
    [live.statusText === "Streaming" && live.statusHasTransport === false, `live: polling status pill renders only Streaming (${live.statusText || "empty"})`],
    [liveHiddenType.toggled === true && liveHiddenType.rows === 1 && liveHiddenType.allCount === "1" && liveHiddenType.hasCommentChip === false && liveHiddenType.hasCommentRow === false && /^2\/5h$/.test(liveHiddenType.activityText || "") && /^3\/1000$/.test(liveHiddenType.bufferText || ""), `live: Settings event-type checkbox hides the comment feed/chip while pulse remains raw (${JSON.stringify(liveHiddenType)})`],
    [(liveHiddenType.bufferRanks || [])[0] === "The Octocat · 2 events" && (liveHiddenType.bufferRanks || [])[1] === "hubot · 1 event" && (liveHiddenType.repoRanks || [])[0] === "acme/widgets · 3 events", `live: hidden event types keep rank charts scoped to the raw retained buffer (${JSON.stringify({ bufferRanks: liveHiddenType.bufferRanks, repoRanks: liveHiddenType.repoRanks })})`],
    [liveRankFit.allFit === true && / /.test(liveRankFit.columns || ""), `live: six-rank charts fit without horizontal overflow at 1024px (${JSON.stringify(liveRankFit)})`],
    // event-link precision: the auto-selected newest event (a comment) shows the
    // exact ev.url permalink (#issuecomment-…) in its detail pane …
    [live.detailLink.includes("#issuecomment-"), `live: the newest event's detail links to the exact event permalink (${live.detailLink || "none"})`],
    // … and selecting a row without an event url falls back to the target url.
    [/\/pull\/\d+$/.test(liveFallbackLink), `live: a selected row without an event url falls back to the target url (${liveFallbackLink || "none"})`],
    [liveMobileCards.bufferChartHidden === true && liveMobileCards.activeChartHidden === true && liveMobileCards.bufferMobileSubVisible === true && liveMobileCards.activeMobileSubVisible === true && liveMobileCards.bufferMobileSub === "retained events · memory cap", `live: phone hides rank charts and shows compact summaries (${JSON.stringify(liveMobileCards)})`],
    [liveMobileFilterMenu.buttonEnabled === true && liveMobileFilterMenu.menuPresent === true && liveMobileFilterMenu.left >= 0 && liveMobileFilterMenu.right <= liveMobileFilterMenu.viewportWidth, `live: phone repo filter menu stays inside the viewport (${JSON.stringify(liveMobileFilterMenu)})`],
    [liveMobileOpen.detailOpen === "true" && liveMobileOpen.detailDisplay !== "none" && liveMobileOpen.detailPosition === "fixed" && liveMobileOpen.backVisible === true && /[?&]liveDetail=1/.test(liveMobileOpen.hash || ""), `live: phone row opens a fixed detail overlay (${JSON.stringify(liveMobileOpen)})`],
    [liveMobileNav.navButtons === 2 && liveMobileNav.motion === "next" && liveMobileNav.selectedIndex === "1" && /2\s*\/\s*\d+/.test(liveMobileNav.count || "") && liveMobileNav.selectedMatchesDetail === true && liveMobileNav.newerDisabled === false && liveMobileNav.olderDisabled === false, `live: phone detail Older button advances detail and selected feed row together (${JSON.stringify(liveMobileNav)})`],
    [liveMobileNav.navInsideCard === false && liveMobileNav.navTop >= liveMobileNav.cardBottom, `live: phone detail navigation sits below the detail card (${JSON.stringify(liveMobileNav)})`],
    [liveMobileNav.cardScrollable === true && liveMobileNav.navBottom <= liveMobileNav.viewportHeight && liveMobileNav.navViewportBottomGap >= 8 && liveMobileNav.navViewportBottomGap <= 48 && liveMobileNav.detailScrollHeight <= liveMobileNav.detailClientHeight + 4, `live: phone long detail body scrolls inside a fixed-height card while navigation stays pinned (${JSON.stringify(liveMobileNav)})`],
    [liveMobileReducedMotion.matches === true && liveMobileReducedMotion.motion === "next" && liveMobileReducedMotion.animationName === "none", `live: phone detail directional motion respects reduced-motion (${JSON.stringify(liveMobileReducedMotion)})`],
    [liveMobileSwipe.dispatch?.dispatched === true && liveMobileSwipe.motion === "previous" && liveMobileSwipe.selectedIndex === "0" && /1\s*\/\s*\d+/.test(liveMobileSwipe.count || "") && liveMobileSwipe.selectedMatchesDetail === true && liveMobileSwipe.newerDisabled === true && liveMobileSwipe.olderDisabled === false, `live: phone detail right-swipe returns to the newer event and selected feed row (${JSON.stringify(liveMobileSwipe)})`],
    [liveMobileLeftSwipe.dispatch?.dispatched === true && liveMobileLeftSwipe.motion === "next" && liveMobileLeftSwipe.selectedIndex === "1" && /2\s*\/\s*\d+/.test(liveMobileLeftSwipe.count || "") && liveMobileLeftSwipe.selectedMatchesDetail === true && liveMobileLeftSwipe.newerDisabled === false && liveMobileLeftSwipe.olderDisabled === false, `live: phone detail left-swipe advances to the older event and selected feed row (${JSON.stringify(liveMobileLeftSwipe)})`],
    [liveMobileTableMidSwipe.dispatch?.dispatched === true && liveMobileTableMidSwipe.dispatch.scrollLeft > 0 && liveMobileTableMidSwipe.dispatch.scrollLeft < liveMobileTableMidSwipe.dispatch.maxScrollLeft && liveMobileTableMidSwipe.motion === "next" && liveMobileTableMidSwipe.selectedIndex === "1" && /2\s*\/\s*\d+/.test(liveMobileTableMidSwipe.count || "") && liveMobileTableMidSwipe.selectedMatchesDetail === true, `live: phone detail lets a horizontally scrollable markdown table consume swipes before its edge (${JSON.stringify(liveMobileTableMidSwipe)})`],
    [liveMobileTableEdgeSwipe.dispatch?.dispatched === true && liveMobileTableEdgeSwipe.dispatch.maxScrollLeft > 0 && liveMobileTableEdgeSwipe.dispatch.scrollLeft === liveMobileTableEdgeSwipe.dispatch.maxScrollLeft && liveMobileTableEdgeSwipe.motion === "next" && liveMobileTableEdgeSwipe.selectedIndex === "2" && /3\s*\/\s*\d+/.test(liveMobileTableEdgeSwipe.count || "") && liveMobileTableEdgeSwipe.selectedMatchesDetail === true, `live: phone detail changes page from a markdown table once the horizontal edge is reached (${JSON.stringify(liveMobileTableEdgeSwipe)})`],
    [liveMobileAfterTableReturn.dispatch?.dispatched === true && liveMobileAfterTableReturn.motion === "previous" && liveMobileAfterTableReturn.selectedIndex === "1" && /2\s*\/\s*\d+/.test(liveMobileAfterTableReturn.count || "") && liveMobileAfterTableReturn.selectedMatchesDetail === true, `live: phone detail returns from the table-edge page for subsequent gesture checks (${JSON.stringify(liveMobileAfterTableReturn)})`],
    [liveMobileIgnoredLinkSwipe.dispatch?.dispatched === true && liveMobileIgnoredLinkSwipe.motion === liveMobileAfterTableReturn.motion && liveMobileIgnoredLinkSwipe.selectedIndex === "1" && /2\s*\/\s*\d+/.test(liveMobileIgnoredLinkSwipe.count || "") && liveMobileIgnoredLinkSwipe.selectedMatchesDetail === true && liveMobileIgnoredLinkSwipe.newerDisabled === false && liveMobileIgnoredLinkSwipe.olderDisabled === false, `live: phone detail ignores swipes that start on the title link (${JSON.stringify(liveMobileIgnoredLinkSwipe)})`],
    [liveMobileOverlaySwipe.dispatch?.dispatched === true && liveMobileOverlaySwipe.motion === "previous" && liveMobileOverlaySwipe.selectedIndex === "0" && /1\s*\/\s*\d+/.test(liveMobileOverlaySwipe.count || "") && liveMobileOverlaySwipe.selectedMatchesDetail === true && liveMobileOverlaySwipe.newerDisabled === true && liveMobileOverlaySwipe.olderDisabled === false, `live: phone detail accepts swipe gestures from the full overlay surface (${JSON.stringify(liveMobileOverlaySwipe)})`],
    [liveMobileAway.hash === "#/activity" && liveMobileAway.activityVisible === true, `live: phone can leave Live while detail is open (${JSON.stringify(liveMobileAway)})`],
    [liveMobileReturnDetail.detailOpen === "true" && liveMobileReturnDetail.detailDisplay !== "none" && liveMobileReturnDetail.feedRows >= 2 && /[?&]liveDetail=1/.test(liveMobileReturnDetail.hash || ""), `live: phone history.back from another tab returns to the route-backed detail overlay (${JSON.stringify(liveMobileReturnDetail)})`],
    [liveMobileBack.detailOpen === "false" && liveMobileBack.detailDisplay === "none" && liveMobileBack.feedRows >= 2 && liveMobileBack.hash === "#/live", `live: phone history.back returns from detail overlay to the feed (${JSON.stringify(liveMobileBack)})`],
    [liveBreakpointClear.detailOpen === "false" && liveBreakpointClear.hash === "#/live", `live: widening past the phone overlay breakpoint clears the detail route (${JSON.stringify(liveBreakpointClear)})`],
    [liveBreakpointBackToLive.hash === "#/live" && liveBreakpointBackToLive.liveVisible === true, `live: after breakpoint cleanup, one Back from another tab returns to Live (${JSON.stringify(liveBreakpointBackToLive)})`],
    [liveBreakpointBackToSentinel.hash === "#/commits" && liveBreakpointBackToSentinel.commitsVisible === true, `live: breakpoint cleanup does not leave a duplicate Live history entry (${JSON.stringify(liveBreakpointBackToSentinel)})`],
    [/^1000\/1000$/.test(liveLargeBuffer.bufferText || "") && liveLargeBuffer.rows > 0 && liveLargeBuffer.rows < 80 && liveLargeBuffer.firstIndex === 0 && liveLargeBuffer.lastIndex < 80, `live: 1000 retained events render a bounded virtual row window (${JSON.stringify(liveLargeBuffer)})`],
    // page 3b: commits log — commit-only projection with SCM filters
    [has(commitsHtml, "commits-page"), "commits: page rendered"],
    [sameRangeButtons(commitsRangeButtons), `commits: shared range quick presets rendered without all (${commitsRangeButtons.join(", ")})`],
    [commitsRowsAll >= 4, `commits: commit rows rendered (${commitsRowsAll} >= 4)`],
    [commitsRowsAll < 80, `commits: virtualized rows stay bounded (${commitsRowsAll} < 80)`],
    [!has(commitsHtml, 'class="controls"'), "commits: shared facet Controls are not rendered (SCM filters are page-local)"],
    [commitsNoDatalist === true, "commits: native <datalist> is gone (replaced by the self-styled combobox)"],
    [commitsCombo.styledList === true, "commits: opening the filter renders the self-styled suggestion list"],
    [commitsCombo.options >= 2, `commits: combobox offers each repo with commits (${commitsCombo.options || 0} >= 2)`],
    [commitsToolbarLayout.repoBeforeBranch === true, "commits: repo filter renders before the branch selector"],
    [commitsToolbarLayout.chromeHeightsMatch === true, `commits: repo combobox and branch picker share the same pill height (${commitsToolbarLayout.repoFieldHeight ?? "n/a"}px vs ${commitsToolbarLayout.branchHeight ?? "n/a"}px)`],
    [commitsToolbarLayout.topAligned === true, `commits: repo and branch filters ${commitsToolbarLayout.stacked ? "stack compactly" : "align at the top"} (${commitsToolbarLayout.topDelta ?? "n/a"}px)`],
    [commitsHasCommitLink === true, "commits: commit row title links to the provider commit page"],
    [commitsHasCopyHash === true, "commits: commit hash copy buttons rendered"],
    [commitsBranchControl.rendered === true && commitsBranchControl.enabled === true && commitsBranchControl.options >= 3, `commits: branch selector renders all plus synthetic branches (${commitsBranchControl.options || 0} options)`],
    [commitsBodyButtons >= 1, `commits: body toggle renders for commits with details.body (${commitsBodyButtons} >= 1)`],
    [commitsToolbarLayout.bodyToggleHasNoTitle === true, "commits: body toggle has no hover title"],
    [commitsBodyTogglePlacement.rendered === true && commitsBodyTogglePlacement.sameLine === true && commitsBodyTogglePlacement.hugsTitle === true, `commits: body toggle sits at the title tail (${commitsBodyTogglePlacement.lineWidth || 0}px of ${commitsBodyTogglePlacement.mainWidth || 0}px)`],
    [commitsBodyExpanded === true, "commits: clicking body toggle expands the commit body inline"],
    [commitsExpandedBodyLayout.scrollsInternally === false, `commits: expanded commit body renders without an inner scroller (${commitsExpandedBodyLayout.overflowY || "unknown"})`],
    [commitsExpandedBodyLayout.mainTrailingGap >= 0 && commitsExpandedBodyLayout.mainTrailingGap <= 2, `commits: expanded body panel is the last main-column item (${commitsExpandedBodyLayout.mainTrailingGap}px)`],
    [commitsExpandedBodyLayout.bodyContentTrailingGap >= 8 && commitsExpandedBodyLayout.bodyContentTrailingGap <= 18, `commits: expanded card shrinks to rendered content (${commitsExpandedBodyLayout.bodyContentTrailingGap}px)`],
    [commitsExpandedBodyLayout.afterGap >= 6 && commitsExpandedBodyLayout.afterGap <= 14, `commits: expanded row keeps compact spacing before the next row (${commitsExpandedBodyLayout.afterGap}px)`],
    [commitsExpandedBodyLayout.rowTrailingGap >= 6 && commitsExpandedBodyLayout.rowTrailingGap <= 14, `commits: expanded virtual row reserves only the row gap (${commitsExpandedBodyLayout.rowTrailingGap}px)`],
    [commitsDateSlotsHaveLabels === true, "commits: date separator slots only render with date labels"],
    [commitsDateSlotsAreGrouped === true, "commits: rows without a date heading do not render standalone separators"],
    [commitsRowBodyGap.count >= 1 && commitsRowBodyGap.minGap >= 6, `commits: row cards keep visible spacing without separator glyphs (${commitsRowBodyGap.minGap}px >= 6px)`],
    [has(commitsHtml, "Commits on") && has(commitsHtml, "abc1234"), "commits: date grouping and short hash rendered"],
    [/\d+ in range/.test(commitsCountText), `commits: in-range count rendered (${commitsCountText})`],
    [!!commitsFiltered.hash && commitsFiltered.hash.includes("repo=example-group"), `commits: picking an option writes ?repo= to the URL (${commitsFiltered.hash || "empty"})`],
    [commitsFiltered.inputValue.includes("example-group/symphony-board-fixture"), `commits: picked repo fills the combobox input (${commitsFiltered.inputValue || "empty"})`],
    [commitsFiltered.rows >= 1 && commitsFiltered.onlyPicked === true, `commits: feed narrows to the picked repo (${commitsFiltered.rows || 0} rows, onlyPicked=${commitsFiltered.onlyPicked})`],
    // page 4: repo analytics uses the contract's repo_metrics rows
    [has(repoHtml, "repo-analytics-page"), "repo analytics: page rendered"],
    [sameRangeButtons(repoRangeButtons), `repo analytics: shared range quick presets rendered without all (${repoRangeButtons.join(", ")})`],
    [repoRows >= 2, `repo analytics: repo rows rendered (${repoRows} >= 2)`],
    [/repos/.test(repoCountText), `repo analytics: repo count rendered (${repoCountText})`],
    [has(repoHtml, "Activity") && has(repoHtml, "Commits") && has(repoHtml, "Comments"), "repo analytics: activity, commits, and comments columns rendered"],
    [has(repoHtml, "repo-trend-bar"), "repo analytics: trend bars rendered"],
    [repoLinks.providerLinks.some((href) => href.startsWith("https://")), "repo analytics: repo names link to provider repo pages"],
    [repoLinks.metricLinks.some((href) => href.startsWith("#/activity") && href.includes("source=") && href.includes("repo=")), "repo analytics: activity metric links are source-aware"],
    [repoLinks.metricLinks.some((href) => href.startsWith("#/commits") && href.includes("source=") && href.includes("repo=")), "repo analytics: commit metric links are source-aware"],
    [repoLinks.metricLinks.some((href) => href.startsWith("#/activity") && href.includes("action=commented") && href.includes("source=") && href.includes("repo=")), "repo analytics: Comments metric links to commented Activity drilldown"],
    [repoLinks.metricLinks.some((href) => href.startsWith("#/activity") && href.includes("kind=review") && href.includes("source=") && href.includes("repo=")), "repo analytics: Reviews activity metric keeps a review Activity drilldown"],
    [repoLinks.metricLinks.some((href) => href.startsWith("#/reviews") && href.includes("ireview=unresolved") && href.includes("isource=") && href.includes("irepo=")), "repo analytics: Threads metric links to the Reviews unresolved-thread inbox"],
    [has(repoHtml, "activity") || has(repoHtml, "limited"), "repo analytics: data-quality badge rendered"],
    [repoQualityBadgeLayout.count >= 1 && repoQualityBadgeLayout.sameWidth === true && repoQualityBadgeLayout.maxWidth <= 56, `repo analytics: quality badges use one compact active-sized width (${repoQualityBadgeLayout.maxWidth || 0}px, ${repoQualityBadgeLayout.texts?.join(", ") || "none"})`],
    [repoTableLayout.tableWidth >= 3200 && Math.abs((repoTableLayout.tableWidth || 0) - (repoTableLayout.wrapWidth || 0)) <= 24 && repoTableLayout.repoWidth >= 300 && repoTableLayout.repoWidth <= 400 && repoTableLayout.trendWidth >= 210 && repoTableLayout.actorsWidth >= 1500 && repoTableLayout.numericMin >= 104 && repoTableLayout.numericMax <= 112 && repoTableLayout.repoShare <= 0.12 && repoTableLayout.actorsShare >= 0.45, `repo analytics: ultra-wide layout caps repo width and gives surplus width to actors (table=${repoTableLayout.tableWidth || 0}px wrap=${repoTableLayout.wrapWidth || 0}px repo=${repoTableLayout.repoWidth || 0}px trend=${repoTableLayout.trendWidth || 0}px actors=${repoTableLayout.actorsWidth || 0}px numeric=${repoTableLayout.numericMin || 0}-${repoTableLayout.numericMax || 0}px shares=${repoTableLayout.repoShare || 0}/${repoTableLayout.actorsShare || 0})`],
    [has(repoHtml, "card-accent") || has(repoHtml, "repo-row-accent"), "repo analytics: repo/source highlight accent rendered"],
    // the repo-name meta renders the new `last_activity_at` as "· active <relative>"
    // (2.5.0) rather than the old earliest-observed "since" timestamp.
    [/active \d/.test(repoHtml), "repo analytics: repo row renders the 'last active' timestamp label"],
    // page 5: Reviews is a master-detail thread inbox (list + detail), like Live.
    [has(reviewsHtml, "reviews-page"), "reviews: page rendered"],
    [sameRangeButtons(reviewsRangeButtons), `reviews: shared range quick presets rendered without all (${reviewsRangeButtons.join(", ")})`],
    [reviewsSummary.rows >= 1 && /open threads/.test(reviewsCountText), `reviews: unresolved thread rows rendered (${reviewsSummary.rows || 0}, ${reviewsCountText || "empty"})`],
    [reviewsSummary.detailLink.includes("/pull/15#discussion_"), `reviews: detail title links to provider discussion (${reviewsSummary.detailLink || "none"})`],
    [reviewsSummary.statuses.includes("unresolved"), `reviews: unresolved status badge rendered (${reviewsSummary.statuses.join(", ") || "none"})`],
    [reviewsSummary.previews.some((text) => text.includes("Cache the compiled pattern")), "reviews: comment preview text rendered inline"],
    [reviewsSummary.detailComments >= 1, `reviews: detail pane renders the selected thread's comment chain (${reviewsSummary.detailComments || 0})`],
    [reviewsSummary.detailMatchesFeed === true && reviewsSummary.detailCardFillsPane === true, `reviews: detail pane matches feed height and its card fills the pane (${JSON.stringify({ feed: reviewsSummary.feedHeight, detail: reviewsSummary.detailHeight, card: reviewsSummary.detailCardHeight })})`],
    [reviewsSummary.rowAvatars === 0, `reviews: list rows carry no avatar — avatars live only in the thread (${reviewsSummary.rowAvatars})`],
    [/avatars\.githubusercontent\.com/.test(reviewsSummary.commentAvatarSrc), `reviews: thread comment renders the author photo from avatar_url (${reviewsSummary.commentAvatarSrc || "none"})`],
    [reviewsSummary.commentAvatarLayout?.avatarIsCardChild === true && reviewsSummary.commentAvatarLayout?.mainStartsAfterAvatar === true, `reviews: thread comment avatar leads the comment body like Live detail rows (${JSON.stringify(reviewsSummary.commentAvatarLayout || {})})`],
    [reviewsSummary.navInsideCard === false && reviewsSummary.navIsDetailChild === true, `reviews: detail nav is a card sibling so the shared overlay pins it (${JSON.stringify({ navInsideCard: reviewsSummary.navInsideCard, navIsDetailChild: reviewsSummary.navIsDetailChild })})`],
    [reviewsRowClick.rowTitle !== "" && reviewsSelect.detailTitle.includes(reviewsRowClick.rowTitle) && reviewsSelect.comments >= 1, `reviews: selecting a thread row swaps the detail pane (${JSON.stringify(reviewsSelect)})`],
    // deep link: a board card's focus link opens the graph in the focus view
    [boardGraphLinks >= 1, `board: "focus in graph" links rendered (${boardGraphLinks} >= 1)`],
    // every linked card also shows its relation count in the meta row — the two
    // affordances come from the same relationCounts map, so they must agree.
    [boardRelationCounts === boardGraphLinks, `board: relation counts rendered on every linked card (${boardRelationCounts} === ${boardGraphLinks})`],
    [has(deepLinkHtml, "graph-list-back"), "deep link: board card opens the graph in the focus view"],
    [/react-flow__node/.test(deepLinkHtml), "deep link: focused graph canvas mounted"],
    // the focused item has >=1 edge (the "focus in graph" link only shows for
    // linked items), so the focus subgraph must DRAW that relationship as an edge
    // path — guards the "1 link counted but no line visible" class of bug.
    [/react-flow__edge-path/.test(deepLinkHtml), "deep link: focus view draws the relationship edge (path)"],
    [/rf-edge-label/.test(deepLinkHtml), "deep link: focus view labels the relationship edge"],
    [deepLinkGeometry.labelCount >= 1, `deep link: relationship labels measured (${deepLinkGeometry.labelCount || 0} >= 1)`],
    [deepLinkGeometry.labelsClearNodes === true, "deep link: relationship labels do not overlap node cards"],
    [deepLinkGeometry.nodeCount < 2 || deepLinkGeometry.minNodeGap >= 48, `deep link: focused node cards keep readable spacing (${deepLinkGeometry.minNodeGap}px >= 48px)`],
    [deepLinkSearch === "", `deep link: the global search bar stays empty ("${deepLinkSearch}")`],
    [JSON.stringify(deepLinkRange.types) === JSON.stringify(["text", "text"]) && JSON.stringify(deepLinkRange.placeholders) === JSON.stringify(["YYYY/MM/DD", "YYYY/MM/DD"]) && /^\d{4}\/\d{2}\/\d{2}$/.test(deepLinkRange.from || "") && /^\d{4}\/\d{2}\/\d{2}$/.test(deepLinkRange.to || ""), `deep link: range dates render as fixed YYYY/MM/DD text (${deepLinkRange.from || "empty"} to ${deepLinkRange.to || "empty"})`],
    [deepLinkRange.pickerButtons === 2, `deep link: range date picker buttons stay rendered while focus suspends controls (${deepLinkRange.pickerButtons || 0})`],
    [deepLinkRange.from !== "" && deepLinkRange.to !== "" && JSON.stringify(deepLinkRange.active) === JSON.stringify(["this week"]), `deep link: arrival keeps the default this week range (${deepLinkRange.from || "empty"} to ${deepLinkRange.to || "empty"})`],
    // canvas node title = a real provider link (anchor, new tab, drag-safe)
    [nodeTitleLink.found === true, "graph node: title element present on the focused canvas"],
    [nodeTitleLink.isAnchor === true && /^https?:\/\//.test(nodeTitleLink.href), `graph node: title is a real link to the provider page (${nodeTitleLink.href || "none"})`],
    [nodeTitleLink.newTab === true, "graph node: title link opens a new tab with noopener"],
    [nodeTitleLink.noDrag === true, "graph node: title link opts out of node drag (nodrag)"],
    // focus is two-way URL-backed (deep-link in, side-list/canvas/back out)
    [urlFocus.arrival.includes("focus="), `url focus: deep-link arrival carries ?focus= (${urlFocus.arrival})`],
    [!urlFocus.afterBack.includes("focus=") && urlFocus.afterBackFlatList === true, `url focus: "all items" clears ?focus= and returns the flat list (${urlFocus.afterBack})`],
    [urlFocus.afterNode.includes("focus=") && urlFocus.afterNodeFocusView === true, `url focus: clicking a canvas node focuses it and writes ?focus= (${urlFocus.afterNode})`],
    [!urlFocus.afterHistory.includes("focus=") && urlFocus.afterHistoryFlatList === true, `url focus: history.back() steps back to the unfocused list (${urlFocus.afterHistory})`],
    // manual sync control plane: Header affordance + running/done states
    [syncInitial.rendered === true, "sync: Header Sync action rendered when control is available"],
    [syncInitial.enabled === true, "sync: Sync action is enabled before a run"],
    [syncRunning.disabled === true && /Sync/i.test(syncRunning.label), `sync: clicking Sync disables the button into the running state (${syncRunning.label})`],
    [/Synced|reloaded/.test(syncDone.status), `sync: a completed run shows the reloaded status (${syncDone.status})`],
    [syncDone.enabled === true, "sync: the Sync action re-enables after the run completes"],
    [has(settingsSyncHtml, "settings-sync"), "sync: Settings exposes the advanced manual-sync section"],
    [has(settingsSyncHtml, "sync-mode") && has(settingsSyncHtml, "sync-source") && has(settingsSyncHtml, "sync-dry-run") && has(settingsSyncHtml, "sync-run-button"), "sync: Settings advanced controls render mode, source, dry-run, and run button"],
    // Settings -> Sources editor (writer-owned producer config, mocked capability)
    [has(settingsTabsHtml, "settings-tab") && has(settingsTabsHtml, "Display") && has(settingsTabsHtml, "Sources"), "config: Settings renders the Display/Sources sub-tab bar when the capability answers"],
    [sourcesTabDisplayGone, "config: the Sources tab replaces the display preferences instead of stacking under them"],
    [has(settingsConfigHtml, "Sources (producer config)"), "config: Settings exposes the Sources editor on the sources tab"],
    [m(settingsConfigHtml, /class="config-source"/g) >= 1, "config: the editor lists the configured sources"],
    [has(settingsConfigHtml, "credentials set") && has(settingsConfigHtml, "credentials missing"), "config: credential status renders as set/missing badges, never values"],
    [has(settingsConfigHtml, "config-add-source") && has(settingsConfigHtml, "config-save-button"), "config: add-source form and explicit save render"],
    // page 5: the settings repo filter renders its checkboxes + count
	    [has(settingsHtml, "settings-page"), "settings: page rendered"],
	    [settingsRepos >= 2, `settings: repo checkboxes rendered (${settingsRepos} >= 2)`],
	    [/repos shown/.test(settingsHtml), "settings: repo count shown"],
	    // settings: source hide toggle, the read-only source color swatch, and the
	    // per-repo color picker (the new display controls)
	    [has(settingsHtml, "settings-source-show"), "settings: per-source show/hide toggle rendered"],
	    [firstPaintSystemDark?.theme === "night-owl" && firstPaintSystemDark?.colorScheme === "dark" && firstPaintSystemDark?.themeColor === "#030b22", `settings: first-paint System follows dark system mode (${JSON.stringify(firstPaintSystemDark)})`],
	    [firstPaintStorageBlockedLight?.theme === "paper" && firstPaintStorageBlockedLight?.colorScheme === "light" && firstPaintStorageBlockedLight?.themeColor === "#f4f3ed", `settings: first-paint System still follows light mode when storage is blocked (${JSON.stringify(firstPaintStorageBlockedLight)})`],
	    [firstPaintStoredLight?.theme === "paper" && firstPaintStoredLight?.colorScheme === "light" && firstPaintStoredLight?.themeColor === "#f4f3ed", `settings: first-paint stored Light wins over dark system mode (${JSON.stringify(firstPaintStoredLight)})`],
	    [firstPaintStoredDark?.theme === "night-owl" && firstPaintStoredDark?.colorScheme === "dark" && firstPaintStoredDark?.themeColor === "#030b22", `settings: first-paint stored Dark wins over light system mode (${JSON.stringify(firstPaintStoredDark)})`],
	    [firstPaintLegacyPaper?.theme === "paper" && firstPaintLegacyPaper?.colorScheme === "light" && firstPaintLegacyPaper?.themeColor === "#f4f3ed", `settings: first-paint legacy Paper storage maps to Light (${JSON.stringify(firstPaintLegacyPaper)})`],
	    [firstPaintLegacyNightOwl?.theme === "night-owl" && firstPaintLegacyNightOwl?.colorScheme === "dark" && firstPaintLegacyNightOwl?.themeColor === "#030b22", `settings: first-paint legacy Night Owl storage maps to Dark (${JSON.stringify(firstPaintLegacyNightOwl)})`],
	    [has(settingsHtml, "Color mode") && colorModeBefore.found === true && colorModeBefore.before === "night-owl" && colorModeBefore.colorScheme === "dark" && colorModeBefore.themeColor === "#030b22" && colorModeBefore.value === "system" && JSON.stringify(colorModeBefore.options) === JSON.stringify(["system", "dark", "light"]) && JSON.stringify(colorModeBefore.labels) === JSON.stringify(["System", "Dark", "Light"]), `settings: color mode selector defaults to System and resolves dark (${JSON.stringify(colorModeBefore)})`],
	    [themeAfter.root === "paper" && themeAfter.stored === "light" && themeAfter.bg === "#f4f3ed", `settings: Light mode applies and persists (${JSON.stringify(themeAfter)})`],
    [settingsDisplayModel.boardControl === "checkbox" && settingsDisplayModel.liveControl === "checkbox" && settingsDisplayModel.boardChecked === true && !/Live feed only/i.test(settingsDisplayModel.boardHelp), `settings: Board data and Live tab use matching binary controls (${JSON.stringify(settingsDisplayModel)})`],
    [settingIndex("Board data") > settingIndex("Color mode") && settingIndex("Default range") > settingIndex("Board data") && settingIndex("Default tab") > settingIndex("Default range") && settingIndex("Tab order") > settingIndex("Default tab") && settingIndex("Live tab") > settingIndex("Tab order") && settingIndex("Server") > settingIndex("Live event types"), `settings: Display preferences are ordered board-first, then Live, then Connection (${(settingsDisplayModel.headings || []).join(" > ")})`],
    [tabOrderClick.clicked === true && JSON.stringify(tabOrderBefore) === JSON.stringify(expectedTabOrderBeforeMove) && JSON.stringify(tabOrderAfterMove.labels) === JSON.stringify(expectedTabOrderAfterMove) && JSON.stringify(tabOrderAfterMove.rows) === JSON.stringify(expectedContentRowsAfterMove) && tabOrderAfterMove.stored === expectedStoredTabOrderAfterMove, `settings: tab order control moves Graph before Board while Live/Settings stay anchored (${JSON.stringify(tabOrderAfterMove)})`],
    [liveOnlySettings.boardChecked === false && liveOnlySettings.hasPreview === true && liveOnlySettings.hasTypes === true, `settings: Live-only mode still renders Live sub-settings (${JSON.stringify(liveOnlySettings)})`],
    [bothOffGuard.hasEnableLive === true && /Board data is turned off/.test(bothOffGuardHtml), `settings: both-off board route exposes an Enable Live affordance (${JSON.stringify(bothOffGuard)})`],
    [bothOffGuard.title === "Symphony Board" && bothOffGuard.hasBrandIcon === true && bothOffGuard.sourceChips === 0 && bothOffGuard.syncButton === false, `settings: both-off board route keeps brand-only header (${JSON.stringify(bothOffGuard)})`],
    [liveOnlySettings.liveChecked === true && boardDataOnlyReenabledTabs.liveChecked === true && boardDataOnlyReenabledTabs.boardData === "on" && JSON.stringify(boardDataOnlyReenabledTabs.visibleLabels) === JSON.stringify(expectedTabOrderAfterMove), `settings: turning only Board data off then on restores the saved tab order (${JSON.stringify(boardDataOnlyReenabledTabs)})`],
    [has(settingsHtml, "Default range") && has(settingsHtml, "settings-select"), "settings: default range selector rendered"],
    [has(settingsHtml, "color-swatch"), "settings: configured source color swatch rendered"],
    [has(settingsHtml, "color-input"), "settings: per-repo color override picker rendered"],
    [consoleErrors.length === 0, `no console errors (${consoleErrors.length})`],
    [exceptions.length === 0, `no uncaught exceptions (${exceptions.length})`],
  ];
  let ok = true;
  for (const [pass, label] of checks) {
    console.log(`  ${pass ? "✓" : "✗"} ${label}`);
    if (!pass) ok = false;
  }
  consoleErrors.slice(0, 5).forEach((e) => console.error("    console.error:", e.slice(0, 200)));
  exceptions.slice(0, 5).forEach((e) => console.error("    exception:", e.slice(0, 200)));
  if (!ok) fail("one or more render assertions failed");
  else console.log("render-smoke PASS: board rendered cleanly");
} catch (err) {
  fail(err.message);
} finally {
  cleanup();
}
process.exit(process.exitCode || 0);
