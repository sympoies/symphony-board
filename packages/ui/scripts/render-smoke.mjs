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

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const HTTP_PORT = 4399;
const CDP_PORT = 9333;
const DEADLINE_MS = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png" };
const ACTIVITY_SMOKE_ROWS = 1200;
let rangeResponseDelayMs = 500;

// A minimal in-process mock of the board daemon's sync control surface, so the
// headless render exercises the writer-owned manual-sync affordance (the static
// dist has no daemon). A POST starts a "running" run that completes shortly after
// (current -> last), so the UI shows running, then reloaded.
const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const syncMock = { current: null, last: null, seq: 0 };
let cachedSyncSources = null;
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
  const env = JSON.parse(body.toString("utf8"));
  if (!Array.isArray(env.activities) || env.activities.length === 0) return body;

  const baseTime = Date.parse(env.activities[0].occurred_at) || Date.parse(env.generated_at) || Date.now();
  const activities = Array.from({ length: ACTIVITY_SMOKE_ROWS }, (_, i) => {
    const a = env.activities[i % env.activities.length];
    const summary = a.summary || a.title || `${a.action} ${a.kind}`;
    return {
      ...a,
      id: `${a.id}|smoke-${i}`,
      external_id: `${a.external_id}:smoke:${i}`,
      occurred_at: new Date(baseTime - i * 60_000).toISOString(),
      summary: `${summary} smoke ${i}`,
      details: {
        ...(a.details && typeof a.details === "object" && !Array.isArray(a.details) ? a.details : {}),
        ...(a.kind === "commit"
          ? {
              refs: [i % 2 === 0 ? "refs/heads/main" : "refs/heads/release"],
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
  const emittedIds = new Set([...primaryIds, ...endpointIds]);
  const items = env.items
    .filter((item) => emittedIds.has(item.id))
    .map((item) => {
      const window_reasons = [];
      if (primaryIds.has(item.id)) window_reasons.push("primary");
      if (endpointIds.has(item.id)) window_reasons.push("edge_endpoint");
      return { ...item, window_reasons };
    });
  const edgeEndpointItems = items.filter((item) => item.window_reasons.includes("edge_endpoint") && !item.window_reasons.includes("primary")).length;
  return {
    status: 200,
    body: JSON.stringify({
      ...env,
      items,
      edges: [...selectedEdges.values()],
      activities: (env.activities || []).filter((activity) => inRange(activity.occurred_at, fromMs, toMs)),
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
      const delayMs = rangeResponseDelayMs;
      if (delayMs > 0) await sleep(delayMs);
      const rawBody = await readFile(join(DIST, "contract.json"));
      const response = rangeProjection(rawBody, req.url || "/api/range");
      res.writeHead(response.status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(response.body);
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
    if (p === "/") p = "/index.html";
    const file = normalize(join(DIST, p));
    if (!file.startsWith(DIST)) {
      res.writeHead(403).end();
      return;
    }
    const rawBody = await readFile(file);
    const body = file === join(DIST, "contract.json") ? inflateActivityContract(rawBody) : rawBody;
    const ext = file.slice(file.lastIndexOf("."));
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(HTTP_PORT, "127.0.0.1", r));

// --- launch headless Chrome ---
const userDataDir = mkdtempSync(join(tmpdir(), "sb-render-"));
const chrome = spawn(
  chromeBinary(),
  [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${CDP_PORT}`, "--remote-allow-origins=*",
    `http://127.0.0.1:${HTTP_PORT}/`,
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
  const textOf = async (selector) =>
    (await send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})?.innerText || ''`, returnByValue: true })).result.value || "";
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

  // Page 1 — the default full-bleed 7-column board.
  const initialRangePending = await waitValue(`(() => {
    if (!document.body.innerText.includes('Loading range')) return null;
    return {
      header: !!document.querySelector('.app-header'),
      tabs: !!document.querySelector('.page-tabs'),
      rangeControls: !!document.querySelector('.time-range-controls'),
      inlineLoading: !!document.querySelector('.state-msg-inline'),
    };
  })()`);
  rangeResponseDelayMs = 0;
  const boardHtml = await waitHtml("document.querySelector('.board-7 .card')");
  const boardRangeButtons = await rangeButtonLabels();
  const boardInitialStats = await textOf(".stats");
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
  await setControlledInput(".time-range-controls label:nth-of-type(1) input", "2026-06-07");
  const boardNarrowHtml = await waitHtml("document.querySelector('.board-7 .card') && !document.body.innerText.includes('Loading range')");
  const boardNarrowStats = await textOf(".stats");
  // Page 2 — the relationship graph (React Flow renders DOM card nodes; assert
  // the page, count label, and at least one node mount cleanly and the lazy
  // chunk loads without errors).
  await send("Runtime.evaluate", { expression: "location.hash = '#/graph'" });
  await sleep(400);
  const graphHtml = await waitHtml("document.querySelector('.react-flow__node')");
  const graphRangeButtons = await rangeButtonLabels();
  const graphInitialStats = await textOf(".stats");
  await setControlledInput(".time-range-controls label:nth-of-type(1) input", "2026-06-07");
  await waitHtml("document.querySelector('.react-flow__node') && !document.body.innerText.includes('Loading range')");
  const graphNarrowStats = await textOf(".stats");
  await setControlledInput(".time-range-controls label:nth-of-type(1) input", "2026-03-01");
  await waitHtml("document.querySelector('.react-flow__node') && !document.body.innerText.includes('Loading range')");
  // Graph side list: capture the (enriched) list cards, then click one to enter
  // the focus view and confirm the back button + related-items header render.
  await waitHtml("document.querySelector('.graph-list-card')");
  const graphListHtml = (await send("Runtime.evaluate", { expression: "document.body.innerHTML", returnByValue: true })).result.value || "";
  await send("Runtime.evaluate", { expression: "document.querySelector('.graph-list-card')?.click()" });
  await sleep(400);
  const focusHtml = (await send("Runtime.evaluate", { expression: "document.body.innerHTML", returnByValue: true })).result.value || "";
  const focusStats = await textOf(".stats");
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
  await send("Runtime.evaluate", { expression: "location.hash = '#/activity'" });
  await sleep(300);
  const activityHtml = await waitHtml("document.querySelector('.activity-row')");
  const activityRangeButtons = await rangeButtonLabels();
  const activityCountText = await textOf(".activity-head .count");
  const activityDomRows = (await send("Runtime.evaluate", {
    expression: "document.querySelectorAll('.activity-row').length",
    returnByValue: true,
  })).result.value || 0;
  // The rhythm heatmap tints the cells inside the feed's selected range (default
  // "this week") a distinct blue over the green density ramp. Count grid cells
  // (excluding the legend) vs the in-range subset to prove the overlay renders and
  // stays scoped to the range — not the whole grid. Guarded by `present` so this
  // no-ops if the sample contract ever ages past the trailing-12-month window.
  const activityHeatmap = (await send("Runtime.evaluate", {
    expression: `(() => {
      const heatmap = document.querySelector('.activity-heatmap');
      if (!heatmap) return { present: false, total: 0, inRange: 0 };
      return {
        present: true,
        total: heatmap.querySelectorAll('.hm-grid .hm-cell:not(.hm-cell-empty)').length,
        inRange: heatmap.querySelectorAll('.hm-grid .hm-cell[data-in-range]').length,
      };
    })()`,
    returnByValue: true,
  })).result.value || { present: false, total: 0, inRange: 0 };
  // Page 3b — Commits: a focused, GitHub-like commit log with SCM filters. Repo
  // uses the self-styled combobox; branch uses optional commit ref details when
  // present. The smoke inflation above adds synthetic refs to exercise that path
  // without changing the tracked sample contract.
  await send("Runtime.evaluate", { expression: "location.hash = '#/commits'" });
  await sleep(300);
  const commitsHtml = await waitHtml("document.querySelector('.commits-page .commit-row')");
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
      const toolbar = document.querySelector('.commits-page .commits-toolbar');
      const repoFilter = toolbar?.querySelector(':scope > .commits-filter');
      const repoInput = repoFilter?.querySelector('input.search');
      const branch = toolbar?.querySelector(':scope > .commit-branch-select');
      const bodyButton = document.querySelector('.commits-page button[aria-label^="Show commit body"], .commits-page button[aria-label^="Hide commit body"]');
      if (!repoFilter || !repoInput || !branch) return { repoBeforeBranch: false, topAligned: false, bodyToggleHasNoTitle: false };
      const repoRect = repoInput.getBoundingClientRect();
      const filterRect = repoFilter.getBoundingClientRect();
      const branchRect = branch.getBoundingClientRect();
      const stacked = getComputedStyle(toolbar).flexDirection === 'column';
      const stackedGap = branchRect.top - filterRect.bottom;
      return {
        repoBeforeBranch: !!(repoFilter.compareDocumentPosition(branch) & Node.DOCUMENT_POSITION_FOLLOWING),
        topAligned: stacked ? stackedGap >= 8 && stackedGap <= 14 : Math.abs(repoRect.top - branchRect.top) <= 2,
        topDelta: Math.round((stacked ? stackedGap : repoRect.top - branchRect.top) * 10) / 10,
        stacked,
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
    expression: "(() => { const i = document.querySelector('.commits-filter input.search'); if (i) { i.focus(); i.click(); } })()",
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
      inputValue: document.querySelector('.commits-filter input.search')?.value || '',
      onlyPicked: Array.from(document.querySelectorAll('.commits-page .commit-row-meta'))
        .every((el) => (el.textContent || '').includes('example-group/symphony-board-fixture')),
    }))()`,
    returnByValue: true,
  })).result.value || {};
  // Page 4 — Repo Analytics: the per-repo contract metrics table and trends.
  await send("Runtime.evaluate", { expression: "location.hash = '#/repo-analytics'" });
  await sleep(300);
  const repoHtml = await waitHtml("document.querySelector('.repo-table tbody tr')");
  const repoRangeButtons = await rangeButtonLabels();
  const repoCountText = await textOf(".repo-analytics-head .count");
  const repoQualityBadgeLayout = (await send("Runtime.evaluate", {
    expression: `(() => {
      const badges = Array.from(document.querySelectorAll('.repo-table td:nth-child(11) .badge'));
      const widths = badges.map((el) => Math.round(el.getBoundingClientRect().width));
      return {
        count: badges.length,
        maxWidth: widths.length ? Math.max(...widths) : 0,
        sameWidth: widths.every((width) => Math.abs(width - widths[0]) <= 1),
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
      const numericWidths = headers.slice(2, 10).map((el) => Math.round(el.getBoundingClientRect().width));
      const tableWidth = Math.round(table?.getBoundingClientRect().width || 0);
      const wrapWidth = Math.round(wrap?.getBoundingClientRect().width || 0);
      const repoWidth = widthOf(0);
      const actorsWidth = widthOf(11);
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
  // Page 5 — the Settings display filter: a per-repo checkbox list with bulk
  // controls (the sample contract spans two repos across two sources).
  await send("Runtime.evaluate", { expression: "location.hash = '#/settings'" });
  await sleep(300);
  const settingsHtml = await waitHtml("document.querySelector('.settings-page .settings-repo')");
  // Deep link — a board card's "focus in graph" link (#/graph?focus=<ref>) opens
  // the graph ALREADY in that item's focus view (not the plain list) AND seeds the
  // search bar with the item's "repo #iid" token so the canvas narrows to it. Back
  // on the board, confirm the affordance renders, click it, then confirm the focus
  // view (back button) + canvas mounted and the search box got the seed token.
  await send("Runtime.evaluate", { expression: "location.hash = '#/'" });
  await sleep(300);
  const board2Html = await waitHtml("document.querySelector('.board-7 .card')");
  await send("Runtime.evaluate", { expression: "document.querySelector('.card-graph')?.click()" });
  await sleep(500);
  const deepLinkHtml = await waitHtml("document.querySelector('.graph-list-back')");
  const deepLinkSearch = (await send("Runtime.evaluate", { expression: "document.querySelector('.search')?.value || ''", returnByValue: true })).result.value || "";
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
  const clearedDeepLink = (await send("Runtime.evaluate", {
    expression: `(() => {
      const search = document.querySelector('.search');
      if (!search) return { search: null, from: null, to: null, active: null };
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, '');
      search.dispatchEvent(new Event('input', { bubbles: true }));
      search.dispatchEvent(new Event('change', { bubbles: true }));
      const rangeInputs = Array.from(document.querySelectorAll('.time-range-controls input[type="date"]'));
      const active = Array.from(document.querySelectorAll('.time-range-controls .toggle-on'))
        .map((el) => el.textContent?.trim())
        .filter(Boolean);
      return { search: search.value, from: rangeInputs[0]?.value || '', to: rangeInputs[1]?.value || '', active };
    })()`,
    returnByValue: true,
  })).result.value || {};
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
  const settingsRepos = m(settingsHtml, /class="settings-repo"/g);
  const graphCards = m(graphListHtml, /class="graph-list-card/g);
  const activityRows = activityDomRows || m(activityHtml, /class="activity-row/g);
  const repoRows = m(repoHtml, /class="repo-name-main/g);
  const boardGraphLinks = m(board2Html, /class="card-graph"/g);
  const boardTimeOrder = updatedBeforeCreated(boardHtml, "card-times muted");
  const graphNodeTimeOrder = updatedBeforeCreated(graphHtml, "rf-node-meta muted");
  const graphListTimeOrder = updatedBeforeCreated(graphListHtml, "card-times muted");
  const normalizedStats = (text) => text.replace(/\s+/g, " ").trim();
  const hasStatText = (text, phrase) => normalizedStats(text).toLowerCase().includes(phrase);
  const statTotal = (text, label) => Number(new RegExp(`${label}\\s+total\\s+(\\d+)`, "i").exec(normalizedStats(text))?.[1] ?? Number.NaN);
  const boardInitialTotal = statTotal(boardInitialStats, "items");
  const boardNarrowTotal = statTotal(boardNarrowStats, "items");
  const graphInitialTotal = statTotal(graphInitialStats, "nodes");
  const graphNarrowTotal = statTotal(graphNarrowStats, "nodes");
  const expectedRangeButtons = ["today", "this week", "1w", "2w", "1mo", "3mo"];
  const sameRangeButtons = (labels) => JSON.stringify(labels) === JSON.stringify(expectedRangeButtons);
  const checks = [
    // page 1: the primary board fuses 4 status + 3 spotlight lanes into 7 columns
    [boardCards >= 5, `board: item cards rendered (${boardCards} >= 5)`],
    [has(boardHtml, "board-7"), "board: 7-column board rendered"],
    [boardCols >= 7, `board: >= 7 columns rendered (${boardCols})`],
    [has(boardHtml, "col-in_progress"), "board: In Progress status column present"],
    [has(boardHtml, "col-lane-pr"), "board: PR spotlight lane present"],
    [sameRangeButtons(boardRangeButtons), `board: shared range quick presets rendered without all (${boardRangeButtons.join(", ")})`],
    [initialRangePending?.header && initialRangePending?.tabs && initialRangePending?.rangeControls && initialRangePending?.inlineLoading, "board: initial range loading keeps app chrome mounted"],
    [boardThisWeekClick.hash?.includes("preset=this-week") && JSON.stringify(boardThisWeekClick.active) === JSON.stringify(["this week"]), `board: clicking this week preserves this week as the only active preset (${boardThisWeekClick.hash || "empty"})`],
    [has(boardNarrowHtml, "range 2026-06-07 to 2026-06-07"), "board: custom range label rendered after API projection"],
    [hasStatText(boardInitialStats, "scope board window"), "board: stats are labelled as board-window scoped"],
    [Number.isFinite(boardInitialTotal) && boardNarrowTotal < boardInitialTotal, `board: scoped stats change when range narrows (${boardInitialTotal} -> ${boardNarrowTotal})`],
    // provider source marks: the sample contract carries both github + gitlab
    [has(boardHtml, 'aria-label="GitHub"'), "board: GitHub source mark rendered"],
    [has(boardHtml, 'aria-label="GitLab"'), "board: GitLab source mark rendered"],
    // repo/source highlight color: the sample carries a source color + a repo
    // color, so coloured repos render the left-bar `card-accent`
    [has(boardHtml, "card-accent"), "board: repo/source highlight bar rendered (card-accent)"],
    [boardTimeOrder.count >= 1 && boardTimeOrder.ok, `board: timestamps render updated before created (${boardTimeOrder.count})`],
    // page 2: the relationship graph mounts and the lazy chunk loads
    [has(graphHtml, "graph-page"), "graph: page rendered"],
    [/showing \d+ nodes/.test(graphHtml), "graph: node/link count shown"],
    [/react-flow__node/.test(graphHtml), "graph: React Flow card nodes rendered (DOM)"],
    [graphNodeTimeOrder.count >= 1 && graphNodeTimeOrder.ok, `graph: node timestamps render updated before created (${graphNodeTimeOrder.count})`],
    [sameRangeButtons(graphRangeButtons), `graph: shared range quick presets rendered without all (${graphRangeButtons.join(", ")})`],
    [hasStatText(graphInitialStats, "scope graph window"), "graph: stats are labelled as graph-window scoped"],
    [Number.isFinite(graphInitialTotal) && graphNarrowTotal < graphInitialTotal, `graph: scoped stats change when range narrows (${graphInitialTotal} -> ${graphNarrowTotal})`],
    // graph side list: enriched cards + click-to-focus related view
    [graphCards >= 2, `graph: side-list cards rendered (${graphCards} >= 2)`],
    [graphListTimeOrder.count >= 1 && graphListTimeOrder.ok, `graph: side-list timestamps render updated before created (${graphListTimeOrder.count})`],
    [has(focusHtml, "graph-list-back"), "graph: focus view back button present"],
    [hasStatText(focusStats, "scope focus"), "graph: focus stats are labelled separately from overview"],
    [/\d+ related item/.test(focusHtml), "graph: focus view related-items header shown"],
    [/glc-rel-type/.test(focusHtml), "graph: focus view lists related items (relation tag)"],
    [has(toggleOffHtml, "graph-list-search") && !has(toggleOffHtml, "graph-list-back"), "graph: re-clicking the focused card toggles focus off (back to the searchable list)"],
    [has(backHtml, "graph-list-search"), "graph: back returns to the searchable list"],
    // graph side-list cards reuse the board card, so they pick up the highlight bar too
    [has(graphListHtml, "card-accent"), "graph: side-list highlight bar rendered (card-accent)"],
    // page 3: activity feed renders activity rows and shared filtering surfaces
    [has(activityHtml, "activity-page"), "activity: page rendered"],
    [sameRangeButtons(activityRangeButtons), `activity: shared range quick presets rendered without all (${activityRangeButtons.join(", ")})`],
    [activityRows >= 4, `activity: rows rendered (${activityRows} >= 4)`],
    [/1200 in range/.test(activityCountText), `activity: large smoke feed count rendered (${activityCountText})`],
    [activityRows < 80, `activity: virtualized rows stay bounded (${activityRows} < 80)`],
    [has(activityHtml, "committed") && has(activityHtml, "merged") && has(activityHtml, "closed"), "activity: action badges rendered"],
    [has(activityHtml, "commit abc1234") && has(activityHtml, "Ship activity feed"), "activity: commit headline shows short sha and title"],
    [has(activityHtml, "change request #13") && has(activityHtml, "Fix flaky sync-engine test"), "activity: change request headline shows iid and title"],
    [has(activityHtml, "ref main") && has(activityHtml, "from 111") && has(activityHtml, "to 222"), "activity: push row shows ref and commit range chips"],
    [has(activityHtml, "card-accent"), "activity: repo/source highlight bar rendered (card-accent)"],
    [!activityHeatmap.present || (activityHeatmap.inRange >= 1 && activityHeatmap.inRange < activityHeatmap.total), `activity: selected range tints a scoped subset of heatmap cells (${activityHeatmap.inRange}/${activityHeatmap.total} in range, present=${activityHeatmap.present})`],
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
    [has(repoHtml, "Activity") && has(repoHtml, "Commits"), "repo analytics: activity and commits columns rendered"],
    [has(repoHtml, "repo-trend-bar"), "repo analytics: trend bars rendered"],
    [repoLinks.providerLinks.some((href) => href.startsWith("https://")), "repo analytics: repo names link to provider repo pages"],
    [repoLinks.metricLinks.some((href) => href.startsWith("#/activity") && href.includes("source=") && href.includes("repo=")), "repo analytics: activity metric links are source-aware"],
    [repoLinks.metricLinks.some((href) => href.startsWith("#/commits") && href.includes("source=") && href.includes("repo=")), "repo analytics: commit metric links are source-aware"],
    [has(repoHtml, "activity") || has(repoHtml, "limited"), "repo analytics: data-quality badge rendered"],
    [repoQualityBadgeLayout.count >= 1 && repoQualityBadgeLayout.sameWidth === true && repoQualityBadgeLayout.maxWidth <= 56, `repo analytics: quality badges use one compact active-sized width (${repoQualityBadgeLayout.maxWidth || 0}px, ${repoQualityBadgeLayout.texts?.join(", ") || "none"})`],
    [repoTableLayout.tableWidth >= 3200 && Math.abs((repoTableLayout.tableWidth || 0) - (repoTableLayout.wrapWidth || 0)) <= 24 && repoTableLayout.repoWidth >= 300 && repoTableLayout.repoWidth <= 400 && repoTableLayout.trendWidth >= 210 && repoTableLayout.actorsWidth >= 1600 && repoTableLayout.numericMin >= 104 && repoTableLayout.numericMax <= 112 && repoTableLayout.repoShare <= 0.12 && repoTableLayout.actorsShare >= 0.48, `repo analytics: ultra-wide layout caps repo width and gives surplus width to actors (table=${repoTableLayout.tableWidth || 0}px wrap=${repoTableLayout.wrapWidth || 0}px repo=${repoTableLayout.repoWidth || 0}px trend=${repoTableLayout.trendWidth || 0}px actors=${repoTableLayout.actorsWidth || 0}px numeric=${repoTableLayout.numericMin || 0}-${repoTableLayout.numericMax || 0}px shares=${repoTableLayout.repoShare || 0}/${repoTableLayout.actorsShare || 0})`],
    [has(repoHtml, "card-accent") || has(repoHtml, "repo-row-accent"), "repo analytics: repo/source highlight accent rendered"],
    // the repo-name meta renders the new `last_activity_at` as "· active <relative>"
    // (2.5.0) rather than the old earliest-observed "since" timestamp.
    [/active \d/.test(repoHtml), "repo analytics: repo row renders the 'last active' timestamp label"],
    // deep link: a board card's focus link opens the graph in the focus view
    [boardGraphLinks >= 1, `board: "focus in graph" links rendered (${boardGraphLinks} >= 1)`],
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
    [/ #\d+$/.test(deepLinkSearch), `deep link: search bar seeded with the "repo #iid" token ("${deepLinkSearch}")`],
    [clearedDeepLink.search === "" && clearedDeepLink.from !== "" && clearedDeepLink.to !== "" && JSON.stringify(clearedDeepLink.active) === JSON.stringify(["this week"]), `deep link: clearing search keeps the default this week range (${clearedDeepLink.from || "empty"} to ${clearedDeepLink.to || "empty"})`],
    // manual sync control plane: Header affordance + running/done states
    [syncInitial.rendered === true, "sync: Header Sync action rendered when control is available"],
    [syncInitial.enabled === true, "sync: Sync action is enabled before a run"],
    [syncRunning.disabled === true && /Sync/i.test(syncRunning.label), `sync: clicking Sync disables the button into the running state (${syncRunning.label})`],
    [/Synced|reloaded/.test(syncDone.status), `sync: a completed run shows the reloaded status (${syncDone.status})`],
    [syncDone.enabled === true, "sync: the Sync action re-enables after the run completes"],
    [has(settingsSyncHtml, "settings-sync"), "sync: Settings exposes the advanced manual-sync section"],
    [has(settingsSyncHtml, "sync-mode") && has(settingsSyncHtml, "sync-source") && has(settingsSyncHtml, "sync-dry-run") && has(settingsSyncHtml, "sync-run-button"), "sync: Settings advanced controls render mode, source, dry-run, and run button"],
    // page 5: the settings repo filter renders its checkboxes + count
    [has(settingsHtml, "settings-page"), "settings: page rendered"],
    [settingsRepos >= 2, `settings: repo checkboxes rendered (${settingsRepos} >= 2)`],
    [/repos shown/.test(settingsHtml), "settings: repo count shown"],
    // settings: source hide toggle, the read-only source color swatch, and the
    // per-repo color picker (the new display controls)
    [has(settingsHtml, "settings-source-show"), "settings: per-source show/hide toggle rendered"],
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
