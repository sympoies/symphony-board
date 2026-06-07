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

  // Page 1 — the default full-bleed 7-column board.
  const boardHtml = await waitHtml("document.querySelector('.board-7 .card')");
  // Page 2 — the relationship graph (React Flow renders DOM card nodes; assert
  // the page, count label, and at least one node mount cleanly and the lazy
  // chunk loads without errors).
  await send("Runtime.evaluate", { expression: "location.hash = '#/graph'" });
  await sleep(400);
  const graphHtml = await waitHtml("document.querySelector('.react-flow__node')");
  ws.close();

  // --- assertions ---
  const has = (h, s) => h.includes(s);
  const m = (h, re) => (h.match(re) || []).length;
  const boardCols = m(boardHtml, /class="col /g);
  const boardCards = m(boardHtml, /class="card"/g);
  const checks = [
    // page 1: the primary board fuses 4 status + 3 spotlight lanes into 7 columns
    [boardCards >= 5, `board: item cards rendered (${boardCards} >= 5)`],
    [has(boardHtml, "board-7"), "board: 7-column board rendered"],
    [boardCols >= 7, `board: >= 7 columns rendered (${boardCols})`],
    [has(boardHtml, "col-in_progress"), "board: In Progress status column present"],
    [has(boardHtml, "col-lane-pr"), "board: PR spotlight lane present"],
    // provider source marks: the sample contract carries both github + gitlab
    [has(boardHtml, 'aria-label="GitHub"'), "board: GitHub source mark rendered"],
    [has(boardHtml, 'aria-label="GitLab"'), "board: GitLab source mark rendered"],
    // page 2: the relationship graph mounts and the lazy chunk loads
    [has(graphHtml, "graph-page"), "graph: page rendered"],
    [/showing \d+ items/.test(graphHtml), "graph: node/link count shown"],
    [/react-flow__node/.test(graphHtml), "graph: React Flow card nodes rendered (DOM)"],
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
