// Exercise ranking disclosures on real pages with synthetic over-limit data.
// Optional captures go to SYMPHONY_BOARD_LAYOUT_OUT (outside the repo).
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
// More than every layout cap, including the wide pane's fifty rows.
const count = 60;
const metricTemplate = structuredClone(fixture.repo_metrics[0]);
for (const key of ["items", "edges", "repo_metrics", "repo_stats", "repos"]) fixture[key] = [];
delete fixture.activity_daily;
fixture.generated_at = now;
fixture.generator = "symphony-board (ranking fixture)";
fixture.actor_directory = { identities: [] };
fixture.activities = Array.from({ length: count }, (_, i) => {
  const suffix = String(i).padStart(2, "0");
  const type = `type${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + i % 26)}`;
  const common = { source_id: "github:github.com", project_path: `example/repo-${suffix}`,
    actor: `contributor-${suffix}`, occurred_at: now, first_seen_at: now, last_seen_at: now, url: null };
  return [{ ...common, external_id: `commit-${i}`, kind: "commit", action: "created",
    target_kind: "commit", target_ref: null, target_iid: null, title: `${type}(scope-${suffix}): synthetic change`,
    details: { sha: i.toString(16).padStart(40, "0"), message: `${type}(scope-${suffix}): synthetic change`,
      refs: [`refs/heads/feature-${suffix}`], additions: i + 1, deletions: 1,
      change_request: { ref: `github:github.com|request-${i}`, iid: i + 1 } } },
    { ...common, external_id: `comment-${i}`, kind: "issue", action: i === 0 ? "created" : `action-${suffix}`,
      target_kind: "issue", target_ref: `github:github.com|issue-${i}`, target_iid: i + 1,
      title: "Synthetic issue activity", details: null }];
}).flat();
fixture.repo_metrics = [{ ...metricTemplate, source_id: "github:github.com", project_path: "example/repo-00",
  top_actors: Array.from({ length: 6 }, (_, i) => ({ actor: `contributor-${i}`, actor_key: `actor-${i}`,
    display_name: `contributor-${i}`, activities: 6 - i, commits: 1, items_opened: 0, change_requests_merged: 0 })) }];
const liveEvents = fixture.activities.filter(a => a.kind === "commit").map((a, i) => ({
  schema: "live-event/1", seq: i + 1, source_id: a.source_id, received_at: now, occurred_at: now,
  event_type: "push", action: "committed", category: "commit", actor: { login: a.actor },
  target: { kind: "commit", source_id: a.source_id, project_path: a.project_path }, title: a.title,
}));
const fileStats = { repos: fixture.activities.filter(a => a.kind === "commit").map(a => ({
  source_id: a.source_id, project_path: a.project_path, commits: 1, scanned: 1, truncated: 0, files: 1,
  top_files: [{ path: "src/main.ts", commits: 1, additions: 1, deletions: 0, authors: 1, shas: [a.details.sha] }],
  top_dirs: [{ path: "src/", commits: 1, additions: 1, deletions: 0, authors: 1, shas: [a.details.sha] }],
})) };

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url, "http://localhost");
  const path = requestUrl.pathname;
  if (path === "/api/capabilities") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      schema: "symphony-board-capabilities/1", generated_at: now, server: { contract: true, range: true },
      live: { reads: true, snapshot: true, stream: false, transport: [], status: "ready" },
    }));
    return;
  }
  if (path === "/api/live-snapshot") {
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
      schema: "live-snapshot/1", generated_at: now, max_seq: count, events: liveEvents,
    }));
    return;
  }
  if (path === "/contract.json" || path === "/api/range") {
    const body = path === "/api/range" ? { ...fixture, range_query: {
      from: requestUrl.searchParams.get("from"), to: requestUrl.searchParams.get("to"),
    } } : fixture;
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
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
  console.log("ranking-controls-smoke: starting Chrome (10s startup deadline)");
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
  // Pass probe values as protocol arguments, never as JavaScript source.
  const evaluate = async (fn, ...args) => {
    const scope = await send("Runtime.evaluate", { expression: "globalThis" });
    const objectId = scope.result.objectId;
    try {
      const result = await send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: fn.toString(),
        arguments: args.map(value => ({ value })),
        returnByValue: true,
        awaitPromise: true,
      });
      assert.equal(result.exceptionDetails, undefined, "layout probe must evaluate");
      return result.result.value;
    } finally {
      await send("Runtime.releaseObject", { objectId });
    }
  };
  await send("Runtime.enable");
  await send("Page.enable");
  const failures = [];
  // A caller may retain the broken base screenshots before asserting RED.
  for (const [page, widths] of [["commits", [1512, 412, 1399, 1400, 2479, 2480]], ["activity", [1512, 2480]]]) {
    for (const width of widths) {
      await send("Emulation.setDeviceMetricsOverride", { width, height: 945, deviceScaleFactor: 1, mobile: false });
      await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/#/${page}` });
      await sleep(300);
      await evaluate(page => { location.hash = `#/${page}`; }, page);
      let ready = false;
      for (let n = 0; n < 100 && !ready; n++) {
        ready = await evaluate(page => !!document.querySelector(`.${page}-page`) && document.querySelectorAll('.live-rank-item').length > 0, page);
        if (!ready) await sleep(100);
      }
      assert.ok(ready, `${page} ${width}: fixture must render: ${await evaluate(() => location.hash + " " + document.body.innerText.slice(0, 500))} errors=${JSON.stringify(errors)}`);
      await sleep(150);
      if (out && page === "commits" && [1512, 412].includes(width)) {
        const png = await send("Page.captureScreenshot", { format: "png" });
        await writeFile(join(out, `commits-${width}.png`), Buffer.from(png.data, "base64"));
      }
      const expected = page === "commits"
        ? ["Top authors", "Top repos", "Top branches", "Commit types", "Commit scopes", "Largest commits", "Change requests"]
        : ["Who", "Where", "Branches", "What", "How", "Busiest items"];
      const results = await evaluate(expected => {
        return [...document.querySelectorAll('.rail-block')].filter(block => expected.includes(block.querySelector('.rail-block-title')?.textContent))
          .map(block => {
            const title = block.querySelector('.rail-block-title').textContent;
            const rows = block.querySelectorAll('.live-rank-item, .pane-rows > li').length;
            const button = block.querySelector('button.rank-more');
            return { title, rows, button: button?.textContent, expanded: button?.getAttribute('aria-expanded') };
          });
      }, expected);
      assert.ok(results.length >= (page === "commits" ? 4 : 5), `${page} ${width}: rankings must be present`);
      for (const result of results) {
        const total = result.title === "Busiest items" ? count * 2 : result.title === "What" ? 2 : count;
        if (result.rows < total) {
          if (result.button !== `Show all ${total}` || result.expanded !== "false") {
            failures.push(`${page} ${width} ${result.title}: ${result.rows}/${total} rows, shared control=${result.button}`);
            continue;
          }
          await evaluate(title => {
            const block = [...document.querySelectorAll('.rail-block')].find(b => b.querySelector('.rail-block-title')?.textContent === title);
            block.querySelector('.rank-more').click();
          }, result.title);
          await sleep(50);
          const opened = await evaluate(title => {
            const block = [...document.querySelectorAll('.rail-block')].find(b => b.querySelector('.rail-block-title')?.textContent === title);
            return { rows: block.querySelectorAll('.live-rank-item, .pane-rows > li').length, label: block.querySelector('.rank-more').textContent, expanded: block.querySelector('.rank-more').getAttribute('aria-expanded') };
          }, result.title);
          assert.deepEqual(opened, { rows: total, label: "Show fewer", expanded: "true" }, `${page} ${width} ${result.title}: all rows accessible, including beyond fifty`);
          assert.equal(await evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${page} ${width} ${result.title}: expanded rankings must not overflow the page`);
          await evaluate(title => {
            const block = [...document.querySelectorAll('.rail-block')].find(b => b.querySelector('.rail-block-title')?.textContent === title);
            block.querySelector('.rank-more').click();
          }, result.title);
          await sleep(50);
          assert.equal(await evaluate(title => {
            const block = [...document.querySelectorAll('.rail-block')].find(b => b.querySelector('.rail-block-title')?.textContent === title);
            return block.querySelectorAll('.live-rank-item, .pane-rows > li').length;
          }, result.title), result.rows, `${result.title}: collapse restores tier limit`);
        } else assert.equal(result.button, undefined, `${result.title}: untruncated rankings have no control`);
      }
      assert.equal(await evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${page} ${width}: no horizontal page overflow`);
      console.log(`ranking-controls: ${page} ${width}px checked ${results.length} rankings`);
    }
  }
  // Audit consumers outside the two rails, including lists with lower caps.
  const navigate = async (page, selector) => {
    await evaluate(page => { location.hash = `#/${page}`; }, page);
    for (let n = 0; n < 100; n++) {
      if (await evaluate(selector => !!document.querySelector(selector), selector)) return;
      await sleep(100);
    }
    assert.fail(`${page}: ${selector} must render`);
  };
  const checkList = async (selector, rowSelector, total, limit) => {
    const inspect = () => evaluate((selector, rowSelector) => {
      const panel = document.querySelector(selector);
      const button = panel.querySelector('.rank-more');
      return { rows: panel.querySelectorAll(rowSelector).length, label: button?.textContent, expanded: button?.getAttribute('aria-expanded') };
    }, selector, rowSelector);
    const click = () => evaluate(selector => {
      document.querySelector(selector).querySelector('.rank-more').click();
    }, selector);
    assert.deepEqual(await inspect(), { rows: limit, label: `Show all ${total}`, expanded: "false" }, `${selector}: truncated ranking uses the shared control`);
    const visibleControl = () => evaluate(selector => {
      const panel = document.querySelector(selector);
      const button = panel.querySelector('.rank-more');
      const b = button.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      return b.width > 0 && b.height > 0 && b.bottom <= p.bottom + 1 && b.right <= p.right + 1;
    }, selector);
    assert.equal(await visibleControl(), true, `${selector}: collapsed control is not clipped`);
    await click(); await sleep(50);
    assert.equal(await visibleControl(), true, `${selector}: expanded control is not clipped`);
    assert.deepEqual(await inspect(), { rows: total, label: "Show fewer", expanded: "true" }, `${selector}: expands to all rows`);
    await click(); await sleep(50);
    assert.deepEqual(await inspect(), { rows: limit, label: `Show all ${total}`, expanded: "false" }, `${selector}: collapses`);
  };
  await send("Emulation.setDeviceMetricsOverride", { width: 1399, height: 945, deviceScaleFactor: 1, mobile: false });
  await navigate("activity", ".hm-top-repos li");
  await checkList(".hm-top-repos", "li", count, 5);
  await navigate("repo-analytics", ".repo-actors");
  for (const width of [1399, 412]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height: 945, deviceScaleFactor: 1, mobile: false });
    await sleep(50);
    await checkList(".repo-actors", ":scope > span:not(.rank-more)", 6, 3);
  }
  await send("Emulation.setDeviceMetricsOverride", { width: 1399, height: 945, deviceScaleFactor: 1, mobile: false });
  await evaluate(() => { localStorage.setItem("symphony-board:live-tab-enabled", "true"); });
  await send("Page.reload");
  await sleep(300);
  await navigate("live", ".live-card-ranked .live-rank-item");
  for (const selector of ['.live-card-ranked:has([aria-label="Top people in the retained Live buffer"])', ".live-card-ranked:has(.live-rank-chart-repos)"]) {
    await checkList(selector, ".live-rank-item", count, 6);
  }
  // Hot files/directories use the same panel with independent full-data totals.
  fixture.commit_file_stats = fileStats;
  await send("Emulation.setDeviceMetricsOverride", { width: 1512, height: 945, deviceScaleFactor: 1, mobile: false });
  await send("Page.reload");
  await sleep(300);
  await navigate("commits", ".commit-where .pane-seg-option");
  for (const option of ["files", "dirs", "scopes"]) {
    await evaluate(option => {
      [...document.querySelectorAll('.commit-where .pane-seg-option')].find(b => b.textContent === option).click();
    }, option);
    await sleep(50);
    await checkList(".commit-where", ".live-rank-item", count, 8);
  }
  assert.deepEqual(errors, [], "rankings render without runtime errors");
  assert.deepEqual(failures, [], "every truncated ranking panel must render the shared Show all N control");
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
console.log("ranking-controls-smoke PASS");
