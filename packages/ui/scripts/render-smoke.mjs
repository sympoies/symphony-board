// Headless render smoke for the UI. The unit tests cover the pure model, and
// `vite build` covers the type/bundle layer — but neither RENDERS the React
// tree, so a render-only crash (e.g. a reserved `ref` prop) slips through. This
// script actually renders the built app in headless Chrome against the bundled
// sample contract and asserts the board drew (item cards + all three edge
// lifecycle buckets) with ZERO console errors / uncaught exceptions.
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

if (!existsSync(join(DIST, "index.html"))) {
  fail(`dist not built (${DIST}/index.html missing) — run \`vite build\` first`);
  process.exit(1);
}

// --- in-process static server for dist/ ---
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent((req.url || "/").split("?")[0]);
    if (p === "/") p = "/index.html";
    const file = normalize(join(DIST, p));
    if (!file.startsWith(DIST)) {
      res.writeHead(403).end();
      return;
    }
    const body = await readFile(file);
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
  const textOf = async (selector) =>
    (await send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(selector)})?.innerText || ''`, returnByValue: true })).result.value || "";
  const setControlledInput = async (selector, value) => {
    await send("Runtime.evaluate", {
      expression: `(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        if (!input) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`,
      returnByValue: true,
    });
    await sleep(300);
  };

  // Page 1 — the default full-bleed 7-column board.
  const boardHtml = await waitHtml("document.querySelector('.board-7 .card')");
  const boardInitialStats = await textOf(".stats");
  await setControlledInput(".board-since input", "2026-06-07");
  const boardNarrowStats = await textOf(".stats");
  // Page 2 — the relationship graph (React Flow renders DOM card nodes; assert
  // the page, count label, and at least one node mount cleanly and the lazy
  // chunk loads without errors).
  await send("Runtime.evaluate", { expression: "location.hash = '#/graph'" });
  await sleep(400);
  const graphHtml = await waitHtml("document.querySelector('.react-flow__node')");
  const graphInitialStats = await textOf(".stats");
  await setControlledInput(".graph-since input", "2026-06-07");
  const graphNarrowStats = await textOf(".stats");
  await setControlledInput(".graph-since input", "2026-03-01");
  // Graph side list: capture the (enriched) list cards, then click one to enter
  // the focus view and confirm the back button + related-items header render.
  await waitHtml("document.querySelector('.graph-list-card')");
  const graphListHtml = (await send("Runtime.evaluate", { expression: "document.body.innerHTML", returnByValue: true })).result.value || "";
  await send("Runtime.evaluate", { expression: "document.querySelector('.graph-list-card')?.click()" });
  await sleep(400);
  const focusHtml = (await send("Runtime.evaluate", { expression: "document.body.innerHTML", returnByValue: true })).result.value || "";
  const focusStats = await textOf(".stats");
  // Click "← all items" and confirm the searchable list returns.
  await send("Runtime.evaluate", { expression: "document.querySelector('.graph-list-back')?.click()" });
  await sleep(300);
  const backHtml = (await send("Runtime.evaluate", { expression: "document.body.innerHTML", returnByValue: true })).result.value || "";
  // Page 3 — the Settings display filter: a per-repo checkbox list with bulk
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
      if (!search) return { search: null, since: null, active: null };
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, '');
      search.dispatchEvent(new Event('input', { bubbles: true }));
      const since = document.querySelector('.graph-since input')?.value || '';
      const active = Array.from(document.querySelectorAll('.graph-controls .toggle-on'))
        .map((el) => el.textContent?.trim())
        .find((txt) => txt === '3mo' || txt === 'all') || '';
      return { search: search.value, since, active };
    })()`,
    returnByValue: true,
  })).result.value || {};
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
  const checks = [
    // page 1: the primary board fuses 4 status + 3 spotlight lanes into 7 columns
    [boardCards >= 5, `board: item cards rendered (${boardCards} >= 5)`],
    [has(boardHtml, "board-7"), "board: 7-column board rendered"],
    [boardCols >= 7, `board: >= 7 columns rendered (${boardCols})`],
    [has(boardHtml, "col-in_progress"), "board: In Progress status column present"],
    [has(boardHtml, "col-lane-pr"), "board: PR spotlight lane present"],
    [has(boardHtml, "board-controls") && has(boardHtml, ">1w<") && has(boardHtml, ">2w<") && has(boardHtml, ">all<"), "board: active-since quick presets rendered"],
    [hasStatText(boardInitialStats, "scope board window"), "board: stats are labelled as board-window scoped"],
    [Number.isFinite(boardInitialTotal) && boardNarrowTotal < boardInitialTotal, `board: scoped stats change when active-since narrows (${boardInitialTotal} -> ${boardNarrowTotal})`],
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
    [has(graphHtml, ">1w<") && has(graphHtml, ">all<"), "graph: active-since quick presets rendered"],
    [hasStatText(graphInitialStats, "scope graph window"), "graph: stats are labelled as graph-window scoped"],
    [Number.isFinite(graphInitialTotal) && graphNarrowTotal < graphInitialTotal, `graph: scoped stats change when active-since narrows (${graphInitialTotal} -> ${graphNarrowTotal})`],
    // graph side list: enriched cards + click-to-focus related view
    [graphCards >= 2, `graph: side-list cards rendered (${graphCards} >= 2)`],
    [graphListTimeOrder.count >= 1 && graphListTimeOrder.ok, `graph: side-list timestamps render updated before created (${graphListTimeOrder.count})`],
    [has(focusHtml, "graph-list-back"), "graph: focus view back button present"],
    [hasStatText(focusStats, "scope focus"), "graph: focus stats are labelled separately from overview"],
    [/\d+ related item/.test(focusHtml), "graph: focus view related-items header shown"],
    [/glc-rel-type/.test(focusHtml), "graph: focus view lists related items (relation tag)"],
    [has(backHtml, "graph-list-search"), "graph: back returns to the searchable list"],
    // graph side-list cards reuse the board card, so they pick up the highlight bar too
    [has(graphListHtml, "card-accent"), "graph: side-list highlight bar rendered (card-accent)"],
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
    [clearedDeepLink.search === "" && clearedDeepLink.since !== "" && clearedDeepLink.active === "3mo", `deep link: clearing search immediately restores the 3mo window (${clearedDeepLink.since || "empty"})`],
    // page 3: the settings repo filter renders its checkboxes + count
    [has(settingsHtml, "settings-page"), "settings: page rendered"],
    [settingsRepos >= 2, `settings: repo checkboxes rendered (${settingsRepos} >= 2)`],
    [/repos shown/.test(settingsHtml), "settings: repo count shown"],
    // settings: source hide toggle, the read-only source color swatch, and the
    // per-repo color picker (the new display controls)
    [has(settingsHtml, "settings-source-show"), "settings: per-source show/hide toggle rendered"],
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
