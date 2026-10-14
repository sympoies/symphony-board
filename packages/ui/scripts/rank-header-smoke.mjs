// Render Commits and Activity rank headers against real scrollable lists.
// Exercise zero, native and custom gutters instead of assuming a scrollbar width.
// Optional captures/geometry go to SYMPHONY_BOARD_HEADER_OUT (outside the repo).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../dist");
const out = process.env.SYMPHONY_BOARD_HEADER_OUT;
if (out) await mkdir(out, { recursive: true });
const fixture = JSON.parse(await readFile(join(dist, "contract.json"), "utf8"));
const now = new Date().toISOString();
fixture.generated_at = now;
fixture.generator = "symphony-board (rank header fixture)";
for (const key of ["items", "edges", "repo_metrics", "repo_stats", "repos"]) fixture[key] = [];
delete fixture.activity_daily;
fixture.actor_directory = { identities: [] };
fixture.activities = Array.from({ length: 80 }, (_, n) => ({
  source_id: "github:github.com", external_id: `header-${n}`, kind: "commit", action: "committed",
  project_path: `example/widgets-${n % 32}`, target_kind: "commit", target_ref: null, target_iid: null,
  title: "fix(ui): synthetic rank fixture", url: null, actor: `dev-${n % 4}`,
  occurred_at: now, first_seen_at: now, last_seen_at: now,
  details: { sha: n.toString(16).padStart(40, "0"), branches: [`branch-${n % 32}`], additions: 4, deletions: 1 },
}));

const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === "/contract.json" || path === "/api/range") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(fixture));
    return;
  }
  if (path.startsWith("/api/")) { res.writeHead(404).end(); return; }
  try {
    const file = join(dist, path === "/" ? "index.html" : path);
    if (!file.startsWith(dist + "/")) { res.writeHead(403).end(); return; }
    const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
    res.writeHead(200, { "Content-Type": mime[extname(file)] ?? "application/octet-stream" }).end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const profile = await mkdtemp(join(tmpdir(), "board-layout-"));
const chromeBin = process.env.CHROME_BIN ?? (platform() === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
const chrome = spawn(chromeBin, ["--headless=new", "--disable-gpu", "--disable-dev-shm-usage",
  `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws;
const observations = [];
try {
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); }
    catch { await sleep(100); }
  }
  assert.ok(port, "headless Chrome must start");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    assert.equal(result.exceptionDetails, undefined, "layout probe must evaluate");
    return result.result.value;
  };
  await send("Runtime.enable");
  await send("Page.enable");
  for (const page of ["commits", "activity"]) {
    await send("Emulation.setDeviceMetricsOverride", { width: 3008, height: 1200, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/#/${page}` });
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      await evaluate(`location.hash = '#/${page}'`);
      ready = await evaluate(`!!document.querySelector('.${page === "commits" ? "commits" : "activity"}-page') && document.querySelectorAll('.commits-rail[data-panes=wide] > .pane-fill > .rank-head').length === 2`);
      if (!ready) await sleep(100);
    }
    assert.ok(ready, `${page}: both scrolling rank lists must render`);
    for (const width of [2480, 3008]) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 1200, deviceScaleFactor: 1, mobile: false });
      for (const mode of ["native", "none", "custom"]) {
        await evaluate(`(() => {
          document.getElementById('header-gutter-fixture')?.remove();
          const style = document.createElement('style');
          style.id = 'header-gutter-fixture';
          const targets = '.commits-rail[data-panes=wide] > .pane-fill > .rank-head, .commits-rail[data-panes=wide] > .pane-fill > .live-rank-chart';
          const mode = ${JSON.stringify(mode)};
          style.textContent = mode === 'none' ? targets + '{scrollbar-width:none!important}' :
            mode === 'custom' ? targets + '{scrollbar-width:auto!important;scrollbar-color:auto!important}' +
              targets.split(',').map(s => s + '::-webkit-scrollbar{width:12px!important}').join('') : '';
          document.head.append(style);
        })()`);
        await sleep(150);
        const lists = await evaluate(`(() => {
          return [...document.querySelectorAll('.commits-rail[data-panes=wide] > .pane-fill')].map(block => {
            const head = block.querySelector(':scope > .rank-head');
            const chart = block.querySelector(':scope > .live-rank-chart');
            const heads = [...head.querySelectorAll(':scope > span')].filter(el => el.getBoundingClientRect().width);
            const rows = [...chart.querySelectorAll('.live-rank-item')];
            const last = heads.at(-1).getBoundingClientRect();
            const edge = heads.at(-1).classList.contains('rank-head-start') ? 'left' : 'right';
            const gutter = el => el.offsetWidth - el.clientWidth;
            return { title: block.querySelector('.rail-block-title').textContent,
              headGutter: gutter(head), rowGutter: gutter(chart), rows: rows.length,
              headWidth: getComputedStyle(head).scrollbarWidth, rowWidth: getComputedStyle(chart).scrollbarWidth,
              scrolls: chart.scrollHeight > chart.clientHeight,
              drift: rows.map(row => {
                const cell = row.querySelector('.live-rank-extra > :last-child').getBoundingClientRect();
                return Math.abs(last[edge] - cell[edge]);
              }) };
          });
        })()`);
        observations.push({ page, width, mode, lists });
        if (out) {
          const png = await send("Page.captureScreenshot", { format: "png" });
          await writeFile(join(out, `${page}-${width}-${mode}.png`), Buffer.from(png.data, "base64"));
        }
      }
    }
  }
  // Collect both modes before asserting, preserving complete before/after geometry.
  for (const probe of observations) {
    assert.equal(probe.lists.length, 2, 'both scrolling panes must be checked');
    for (const list of probe.lists) {
      const context = `${probe.page} ${probe.width}px ${probe.mode} ${list.title}`;
      assert.equal(list.headWidth, list.rowWidth, `${context}: header and chart must share the scrollbar-width policy`);
      assert.ok(list.rows >= 16 && list.scrolls, `${context}: the fixture must exercise a scrolling list`);
      if (probe.mode === 'none') assert.equal(list.rowGutter, 0, `${context}: the zero-gutter precondition must hold`);
      if (probe.mode === 'custom') assert.ok(list.rowGutter >= 10, `${context}: the reserved-gutter precondition must hold`);
      assert.ok(list.drift.every(px => px <= 1), `${context}: header and every row must align (${JSON.stringify(list)})`);
    }
  }
  assert.deepEqual(errors, [], 'rank fixture must render without runtime exceptions');
  console.log(`rank-header-smoke PASS: ${observations.length} page/width/gutter layouts`);

} finally {
  if (out) await writeFile(join(out, "geometry.json"), JSON.stringify(observations, null, 2));
  ws?.close();
  chrome.kill();
  await new Promise(resolve => chrome.exitCode !== null ? resolve() : chrome.once("exit", resolve));
  server.close();
  await rm(profile, { recursive: true, force: true });
}
