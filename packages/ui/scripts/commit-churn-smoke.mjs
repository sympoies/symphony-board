// Render the production Commits chart: every day must paint in its own slot.
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
// Fixed calendar fixture; the route pins the range rather than using the clock.
const dates = Array.from({ length: 7 }, (_, i) => `2020-01-${String(6 + i).padStart(2, "0")}`);
fixture.generated_at = `${dates.at(-1)}T23:59:59Z`;
fixture.generator = "symphony-board (chart fixture)";
fixture.timezone = "UTC";
for (const key of ["items", "edges", "repo_metrics", "repo_stats", "repos"]) fixture[key] = [];
delete fixture.activity_daily;
fixture.activities = dates.flatMap((date, index) => [false, true].map(missing => ({
  source_id: "github:github.com", external_id: `chart-${index}-${missing}`,
  kind: "commit", action: "committed", project_path: "example/widgets",
  target_kind: null, target_ref: null, target_iid: null, title: "fix: synthetic chart commit",
  url: null, actor: "contributor", occurred_at: `${date}T12:00:00Z`,
  details: { sha: `${index}${missing ? "b" : "a"}`.padEnd(40, "0"),
    ...(missing ? {} : { additions: (index + 1) * 100, deletions: (index + 1) * 40 }) },
  first_seen_at: null, last_seen_at: null,
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
  console.log("commit-churn-smoke: starting Chrome (10s startup deadline)");
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
  await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/#/commits?from=${dates[0]}&to=${dates.at(-1)}` });
  const startupDeadline = Date.now() + 10000;
  while (!(await evaluate("!!document.querySelector('.activity-page, .commits-page')")) && Date.now() < startupDeadline) await sleep(100);
  await evaluate(`location.hash = '#/commits?from=${dates[0]}&to=${dates.at(-1)}'`);
  console.log(`Browser: ${(await send("Browser.getVersion")).product}`);
  // Both sides of the stack tier, plus a typical desktop width.
  for (const width of [1400, 1470, 2479, 2480]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 1080, deviceScaleFactor: 1, mobile: false });
    const deadline = Date.now() + 10000;
    while (!(await evaluate("document.querySelectorAll('.churn-col').length === 7")) && Date.now() < deadline) await sleep(100);
    assert.equal(await evaluate("document.querySelectorAll('.churn-col').length"), 7, await evaluate("document.body.innerText.slice(0, 5000)"));
    await sleep(150);
    await evaluate("document.querySelector('.commit-churn').scrollIntoView({block: 'center'})");
    const g = await evaluate(`(() => {
      const box = el => { const r = el.getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, bottom: r.bottom, width: r.width, height: r.height, center: r.x + r.width / 2 }; };
      const chart = document.querySelector('.commit-churn');
      return { tier: chart.closest('[data-panes]').dataset.panes, plot: box(chart.querySelector('.churn-cols')),
        days: [...chart.querySelectorAll('.churn-col')].map((col, i) => ({
          col: box(col), tip: col.querySelector('.rail-daybar-tip').textContent,
          bars: [...col.querySelectorAll('.churn-add, .churn-del')].map(box),
          partial: col.querySelector('.churn-partial') ? box(col.querySelector('.churn-partial')) : null,
          axis: box(chart.querySelectorAll('.rail-days-axis > i')[i]),
          label: chart.querySelectorAll('.rail-days-axis > i')[i].textContent,
        })) };
    })()`);
    for (const index of [0, 3, 6]) {
      const day = g.days[index].col;
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: day.center, y: day.y + day.height / 2 });
      await sleep(200);
      const tip = await evaluate(`(() => {
        const el = document.querySelectorAll('.churn-col')[${index}].querySelector('.rail-daybar-tip');
        const r = el.getBoundingClientRect();
        return { opacity: Number(getComputedStyle(el).opacity), x: r.x, right: r.right };
      })()`);
      assert.equal(tip.opacity, 1, "day tooltip must remain hoverable");
      if (g.tier === "stack") assert.ok(tip.x >= g.plot.x - 1 && tip.right <= g.plot.right + 1, "stack tooltip must stay within plot");
    }
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
    await sleep(200);
    observations.push({ width, ...g });
    if (out) {
      const png = await send("Page.captureScreenshot", { format: "png" });
      await writeFile(join(out, `churn-${width}.png`), Buffer.from(png.data, "base64"));
    }
  }
  for (const g of observations) {
    console.log(`commit-churn-smoke: ${g.width}px ${g.tier}, seven aligned bar pairs with partial markers`);
    for (const [index, day] of g.days.entries()) {
      assert.match(day.tip, new RegExp(dates[index]), "tooltip must name its own day");
      assert.match(day.tip, /1 of 2 commits counted/, "partial stats must retain known counts");
      assert.equal(day.label, ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][index]);
      assert.equal(day.bars.length, 2, "each day retains its additions and deletions");
      for (const bar of day.bars) {
        assert.ok(Math.abs(bar.center - day.axis.center) < 1,
          `${g.width}px day ${index}: bar center ${bar.center} must align with day slot ${day.axis.center}`);
        assert.ok(bar.width > 0 && bar.height > 0, "known partial stats must paint");
      }
      assert.ok(day.partial?.width > 0 && day.partial?.height > 0, "incomplete day must carry a visible partial marker");
      assert.ok(Math.abs(day.partial.center - day.axis.center) < 1, "partial marker must align with its day");
    }
  }
  await send("Emulation.setDeviceMetricsOverride", { width: 1399, height: 1080, deviceScaleFactor: 1, mobile: false });
  await sleep(200);
  assert.equal(await evaluate("!!document.querySelector('.commit-churn')"), false, "compact tier keeps its existing summary");
  assert.deepEqual(errors, [], "Commits must render without runtime exceptions");
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
console.log(`commit-churn-smoke PASS: ${observations.length} multi-day layouts`);
