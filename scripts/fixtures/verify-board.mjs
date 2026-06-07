// Throwaway: headless-render an already-served board URL and report what drew.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
const URL_ = process.env.URL || "http://localhost:4321/";
const CDP = 9344;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chromeBin = process.env.CHROME_BIN || (platform() === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
const udd = mkdtempSync(join(tmpdir(), "vb-"));
const chrome = spawn(chromeBin, ["--headless=new", "--disable-gpu", "--no-sandbox", `--user-data-dir=${udd}`, `--remote-debugging-port=${CDP}`, "--remote-allow-origins=*", URL_], { stdio: "ignore" });
const cleanup = () => { try { chrome.kill("SIGKILL"); } catch {} try { rmSync(udd, { recursive: true, force: true }); } catch {} };
try {
  const deadline = Date.now() + 25000;
  let ws = null;
  while (Date.now() < deadline && !ws) {
    try { const l = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json(); ws = l.find((t) => t.type === "page" && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl; } catch {}
    if (!ws) await sleep(200);
  }
  const sock = new WebSocket(ws);
  let id = 0; const pend = new Map(); const cerr = []; const exc = [];
  const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); sock.send(JSON.stringify({ id: i, method: m, params: p })); });
  sock.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const x = pend.get(m.id); pend.delete(m.id); m.error ? x.rej(new Error(JSON.stringify(m.error))) : x.res(m.result); return; } if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") cerr.push((m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ")); if (m.method === "Runtime.exceptionThrown") exc.push(m.params.exceptionDetails?.exception?.description || "exc"); });
  await new Promise((res, rej) => { sock.addEventListener("open", res); sock.addEventListener("error", () => rej(new Error("ws err"))); });
  await send("Runtime.enable"); await send("Page.enable");
  let html = "";
  while (Date.now() < deadline) { const r = await send("Runtime.evaluate", { expression: "document.querySelector('.card')?document.body.innerHTML:''", returnByValue: true }); html = r.result.value || ""; if (html.length > 200) break; await sleep(250); }
  // Board page: the 7 columns (4 status + 3 spotlight) must be equal height.
  const heights = (await send("Runtime.evaluate", { expression: "JSON.stringify([...document.querySelectorAll('.board-7 > .col')].map(c=>Math.round(c.getBoundingClientRect().height)))", returnByValue: true })).result.value;
  // Night Owl theme evidence: body bg #011627 and links teal #7fdbca.
  const bg = (await send("Runtime.evaluate", { expression: "getComputedStyle(document.body).backgroundColor", returnByValue: true })).result.value;
  const linkColor = (await send("Runtime.evaluate", { expression: "(()=>{const a=document.querySelector('a.card-title');return a?getComputedStyle(a).color:''})()", returnByValue: true })).result.value;
  // audit: any external (http) anchor that would navigate the current page instead of a new tab
  const badAnchors = (await send("Runtime.evaluate", { expression: "JSON.stringify([...document.querySelectorAll('a[href^=\"http\"]')].filter(a => a.target !== '_blank').map(a => a.href).slice(0, 8))", returnByValue: true })).result.value;
  // Debug page: a Relationships endpoint must link to an external http(s) URL.
  await send("Runtime.evaluate", { expression: "location.hash = '#/debug'" });
  await sleep(400);
  const endpointHref = (await send("Runtime.evaluate", { expression: "document.querySelector('.relationships a.endpoint')?.getAttribute('href') || ''", returnByValue: true })).result.value;
  // Graph page: confirm the relationship graph populated from the fixture.
  await send("Runtime.evaluate", { expression: "location.hash = '#/graph'" });
  await sleep(700);
  const graphCount = (await send("Runtime.evaluate", { expression: "document.querySelector('.graph-controls .muted')?.textContent || ''", returnByValue: true })).result.value;
  const graphNodes = (await send("Runtime.evaluate", { expression: "document.querySelectorAll('.react-flow__node').length", returnByValue: true })).result.value;
  const repoShown = (await send("Runtime.evaluate", { expression: "!!document.querySelector('.rf-node-repo')", returnByValue: true })).result.value;
  // toggle "+ mentions" and re-read the count to confirm mentions flow in
  await send("Runtime.evaluate", { expression: "[...document.querySelectorAll('.graph-controls .toggle')].find(b=>/mentions/.test(b.textContent))?.click()" });
  await sleep(900);
  const graphMentions = (await send("Runtime.evaluate", { expression: "document.querySelector('.graph-controls .muted')?.textContent || ''", returnByValue: true })).result.value;
  sock.close();
  const count = (re) => (html.match(re) || []).length;
  console.log("cards:", count(/class="card"/g));
  console.log("source chips:", count(/class="source-chip"/g));
  console.log("lifecycle buckets:", ["declared", "fulfilled", "broken"].filter((b) => html.includes(`badge-lifecycle-${b}`)).join(", "));
  console.log("scoped label chips:", count(/chip-scoped/g));
  console.log("draft badges:", count(/badge-draft/g));
  console.log("created-time labels:", count(/>created /g), "| updated-time labels:", count(/>updated /g));
  console.log("demand icons:", count(/icon-demand/g), "| legacy ▲ glyphs:", count(/▲/g));
  const hs = JSON.parse(heights);
  const uniform = hs.length >= 7 && new Set(hs).size === 1;
  console.log(`board-7 column heights (${hs.length} cols): ${heights} -> ${uniform ? "UNIFORM ✓" : "RAGGED ✗"}`);
  console.log(`endpoint href: ${endpointHref.slice(0, 60)} -> ${/^https?:\/\//.test(endpointHref) ? "external ✓" : "in-page/empty ✗"}`);
  console.log(`graph page (closes only): "${graphCount.trim()}" | RF nodes in DOM: ${graphNodes} | repo shown: ${repoShown ? "yes ✓" : "no ✗"}`);
  console.log(`graph + mentions:        "${graphMentions.trim()}"`);
  console.log(`body bg: ${bg} -> ${bg === "rgb(1, 22, 39)" ? "Night Owl navy ✓" : "✗"}`);
  console.log(`link color: ${linkColor} -> ${linkColor === "rgb(127, 219, 202)" ? "teal #7fdbca ✓" : "✗"}`);
  console.log(`same-page http anchors (want []): ${badAnchors}`);
  console.log("console errors:", cerr.length, "| exceptions:", exc.length);
  cerr.slice(0, 5).forEach((e) => console.log("  CE:", e.slice(0, 160)));
} catch (e) { console.log("verify error:", e.message); } finally { cleanup(); }
process.exit(0);
