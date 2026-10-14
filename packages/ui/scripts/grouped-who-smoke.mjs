// Render the real Activity page with linked provider identities. Unlike a CSS
// source assertion, this catches a disclosure that paints outside its rank row.
// Optional captures/geometry go to SYMPHONY_BOARD_LAYOUT_OUT (outside the repo).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "../dist");
const out = process.env.SYMPHONY_BOARD_LAYOUT_OUT;
if (out) await mkdir(out, { recursive: true });
const fixture = JSON.parse(await readFile(join(dist, "contract.json"), "utf8"));
const now = new Date().toISOString();
const group = "linked-contributor-with-a-long-name";
const actors = ["contributor-primary", "contributor-secondary", "another-long-contributor-login", "dev-a"];
fixture.generated_at = now;
fixture.generator = "symphony-board (layout fixture)";
for (const key of ["items", "edges", "repo_metrics", "repo_stats", "repos"]) fixture[key] = [];
delete fixture.activity_daily;
fixture.actor_directory = { identities: [
  { name: group, actors: actors.slice(0, 2), bot: false },
  ...actors.slice(2).map(name => ({ name, actors: [name], bot: false })),
] };
fixture.activities = actors.flatMap((actor, index) => Array.from({ length: 4 - index }, (_, n) => ({
  source_id: index === 1 ? "gitlab:gitlab.com" : "github:github.com",
  external_id: `layout-${index}-${n}`, kind: "issue", action: "opened",
  project_path: "example/widgets", target_kind: "issue", target_ref: null, target_iid: n + 1,
  title: "Synthetic layout activity", url: null, actor, occurred_at: now,
  details: null, first_seen_at: now, last_seen_at: now,
})));

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
const profile = await mkdtemp("/tmp/sb-w-");
const chromeBin = process.env.CHROME_BIN ?? (platform() === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
const chrome = spawn(chromeBin, ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
  `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], {
  env: { ...process.env, TMPDIR: profile, TMP: profile, TEMP: profile }, stdio: ["ignore", "ignore", "inherit"],
});
let launchError;
const exited = new Promise(resolve => {
  chrome.once("error", error => { launchError = error; resolve(); });
  chrome.once("exit", resolve);
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const bounded = (promise, label, ms = 10000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  })]).finally(() => clearTimeout(timer));
};
let ws;
const observations = [];
try {
  console.log("grouped-who-smoke: starting Chrome (10s startup deadline)");
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    if (launchError) throw new Error(`Chrome failed to launch (${launchError.code})`);
    if (chrome.exitCode !== null || chrome.signalCode !== null) {
      throw new Error(`Chrome exited before startup (${chrome.signalCode ?? chrome.exitCode})`);
    }
    try { port = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); }
    catch { await sleep(100); }
  }
  assert.ok(port, "Chrome startup timed out after 10000ms: no DevTools port");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(10000) })).json();
  ws = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
  await bounded(new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; }), "Chrome DevTools connection");
  let seq = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (!request) return;
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => {
    const id = ++seq;
    return bounded(new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    }), `Chrome ${method}`).finally(() => pending.delete(id));
  };
  const evaluate = async expression => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    assert.equal(result.exceptionDetails, undefined, "layout probe must evaluate");
    return result.result.value;
  };
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1512, height: 945, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/#/activity` });
  // Include both sides of the pane breakpoints and the native acceptance size.
  for (const [width, height] of [[1512, 945], [1800, 1169], [1440, 960], [1400, 900], [2200, 1100], [2479, 1100], [2480, 1100], [3008, 1200]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    let ready = false;
    const readyDeadline = Date.now() + 10000;
    while (!ready && Date.now() < readyDeadline) {
      ready = await evaluate("document.querySelectorAll('.activity-panes-rail .rank-cols-people .live-rank-item').length === 3");
      if (!ready) await sleep(100);
    }
    assert.ok(ready, "Activity navigation timed out after 10000ms: linked identities must render three WHO rows");
    await sleep(150);
    for (const open of [false, true, false]) {
      await evaluate(`document.querySelector('.activity-panes-rail .rank-cols-people .live-rank-footer > details').open = ${open}`);
      await sleep(100);
      const geometry = await evaluate(`(() => {
        const box = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
        const chart = document.querySelector('.activity-panes-rail .rank-cols-people.live-rank-chart');
        const rows = [...chart.querySelectorAll('.live-rank-item')].map(row => ({
          row: box(row), name: box(row.querySelector('.activity-rank-actor-name')),
          title: row.querySelector('.activity-rank-actor-name').title,
          ellipsis: getComputedStyle(row.querySelector('.activity-rank-actor-name')).textOverflow,
          count: box(row.querySelector('.live-rank-tooltip')),
          facts: [...row.querySelectorAll('.live-rank-extra > *')].filter(el => el.getBoundingClientRect().width).map(box),
        }));
        const menu = chart.querySelector('.live-rank-footer > details');
        const links = [...menu.querySelectorAll('.rank-entity-destinations > a')].map(link => ({ ...box(link), visible: link.checkVisibility() }));
        return { rows, links, open: menu.open, summary: box(menu.querySelector('summary')) };
      })()`);
      observations.push({ width, height, ...geometry });
      console.log(`grouped-who-smoke: ${width}px ${open ? "open" : "closed"} layout ${observations.length}/24`);
      // Capture before asserting so RED retains the same-size broken layout.
      if (out && [1512, 1800].includes(width)) {
        const png = await send("Page.captureScreenshot", { format: "png" });
        await writeFile(join(out, `who-${width}-${open ? "open" : "closed"}.png`), Buffer.from(png.data, "base64"));
      }
    }
  }
  // Collect all widths/states before reporting failures, including both captures.
  for (const g of observations) {
    const context = `${g.width}px ${g.open ? "open" : "closed"}`;
    for (const [index, item] of g.rows.entries()) {
      const next = g.rows[index + 1];
      assert.equal(item.row.height, g.width >= 2480 ? 28 : 26, `${context}: each WHO row keeps its own slot`);
      if (next) assert.ok(item.row.bottom <= next.row.y + 0.5, `${context}: rank rows must stack`);
      for (const cell of [item.name, item.count, ...item.facts]) {
        assert.ok(cell.y >= item.row.y - 0.5 && cell.bottom <= item.row.bottom + 0.5,
          `${context}: label and numbers must stay inside their own row (${JSON.stringify(item)})`);
      }
      assert.equal(item.ellipsis, "ellipsis", `${context}: preserve long-name truncation`);
      assert.equal(item.title, [group, ...actors.slice(2)][index], `${context}: preserve the complete name in the title`);
    }
    assert.ok(g.summary.y >= g.rows[0].row.y - 0.5 && g.summary.bottom <= g.rows[0].row.bottom + 0.5,
      `${context}: linked-identity header must fit its own row`);
    if (g.open) {
      assert.equal(g.links.length, 2, `${context}: linked identities retain both destinations`);
      assert.ok(g.links[0].bottom <= g.links[1].y, `${context}: destination members must stack`);
    } else assert.ok(g.links.every(link => !link.visible), `${context}: collapsed members must not paint`);
  }
  // Below the pane floor Activity omits WHO rather than squeezing it into bars.
  // The disclosure fix is scoped to data-panes so shared vertical charts keep
  // their existing avatar-sized summaries.
  for (const width of [360, 412, 760, 1024, 1212, 1399]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(150);
    assert.equal(await evaluate("!!document.querySelector('.activity-panes-rail')"), false,
      `${width}px: WHO must remain absent below the row pane floor`);
  }
  assert.deepEqual(errors, [], "Activity must render without runtime exceptions");
} finally {
  if (out) await writeFile(join(out, "geometry.json"), JSON.stringify(observations, null, 2));
  ws?.close();
  chrome.kill();
  const forceKill = setTimeout(() => chrome.kill("SIGKILL"), 2000);
  try {
    await bounded(exited, "Chrome shutdown", 5000);
  } finally {
    clearTimeout(forceKill);
    server.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
console.log(`grouped-who-smoke PASS: ${observations.length} width/disclosure layouts; temporary profile removed`);
