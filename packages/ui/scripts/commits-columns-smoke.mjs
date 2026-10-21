// Scroll the production Commits page across every column tier: the columns
// that sit side by side must never paint over one another, whatever the width.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

// The tracked sample contract is dated; pin its range instead of using the clock.
const dist = join(dirname(fileURLToPath(import.meta.url)), "../dist");
const contract = await readFile(join(dist, "contract.json"), "utf8");

const server = createServer(async (req, res) => {
  const path = new URL(req.url, "http://localhost").pathname;
  if (path === "/contract.json" || path === "/api/range") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(contract);
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
try {
  console.log("commits-columns-smoke: starting Chrome (10s startup deadline)");
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
  await send("Emulation.setDeviceMetricsOverride", { width: 1470, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/#/commits?from=2026-03-12&to=2026-06-10` });
  const startupDeadline = Date.now() + 10000;
  while (!(await evaluate("!!document.querySelector('.activity-page, .commits-page')")) && Date.now() < startupDeadline) await sleep(100);
  await evaluate("location.hash = '#/commits?from=2026-03-12&to=2026-06-10'");
  while (!(await evaluate("!!document.querySelector('.commits-split > .commit-list')")) && Date.now() < startupDeadline) await sleep(100);
  console.log(`Browser: ${(await send("Browser.getVersion")).product}`);
  // Widths straddle every Commits column tier: stacked, two-pane (with and
  // without a rail), three-column, stack and wide.
  const widths = [1211, 1212, 1250, 1279, 1280, 1300, 1399, 1400, 1470, 1960, 2200, 2480];
  const failures = [];
  const columns = [".commit-list", ".commits-context", ".commits-rail", ".commits-compact-support"];
  for (const width of widths) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(200);
    const result = await evaluate(`(async () => {
      const columns = ${JSON.stringify(columns)};
      const nodes = columns.map(selector => document.querySelector('.commits-split > ' + selector));
      const present = columns.filter((_, i) => nodes[i]);
      const range = document.documentElement.scrollHeight - innerHeight;
      const hits = [];
      for (let step = 0; step <= 20; step++) {
        scrollTo(0, Math.round(range * step / 20));
        await new Promise(resolve => setTimeout(resolve, 40));
        const boxes = nodes.map(el => el && el.getBoundingClientRect());
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i], b = boxes[j];
          if (!a || !b || !a.width || !b.width) continue;
          const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (x > 1 && y > 1) hits.push({ step, pair: columns[i] + ' x ' + columns[j], x: Math.round(x), y: Math.round(y) });
        }
      }
      scrollTo(0, 0);
      return { present, range, hits };
    })()`);
    assert.ok(result.present.includes(".commit-list"), `${width}px: the Commits list must render`);
    // The stacked support column is the one that can slide: it must have room to.
    if (width >= 1212 && width <= 1399) assert.ok(result.range > 200, `${width}px: the page must scroll far enough for the check to mean anything (${result.range}px)`);
    console.log(`commits-columns-smoke: ${width}px ${result.present.length} columns, ${result.range}px scroll, ${result.hits.length} overlapping samples`);
    if (result.hits.length) failures.push(`${width}px: ${JSON.stringify(result.hits.slice(0, 3))}`);
  }
  assert.deepEqual(failures, [], "Commits columns must never overlap while the page scrolls");
  assert.deepEqual(errors, [], "Commits must render without runtime exceptions");
} finally {
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
console.log("commits-columns-smoke PASS");
