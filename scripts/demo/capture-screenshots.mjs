import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../../", import.meta.url));
const out = join(root, "site/screenshots");
const origin = "https://demo.invalid";
const shots = [
  { name: "activity", tab: "Activity", ready: ".activity-list [role=listitem]", width: 1512, height: 945 },
  { name: "commits", tab: "Commits", ready: ".commit-row", width: 1512, height: 945 },
  { name: "board", tab: "Board", ready: ".board-lanes", width: 2320, height: 1080 },
  { name: "graph", tab: "Graph", ready: ".react-flow__node", width: 1512, height: 945 },
  { name: "work-activity", tab: "Activity", ready: ".activity-list [role=listitem]", width: 1400, height: 875 },
];

// Use only the checked-in synthetic UI sample, never the real-data Pages
// snapshot or a local contract. Remove external identities and remap both
// source/repo keys and their encoded references together.
async function screenshotContract() {
  const sample = JSON.parse(await readFile(join(root, "packages/ui/public/contract.json"), "utf8"));
  let json = JSON.stringify(sample, (key, value) =>
    key === "avatar_url" || key === "profile_url" ? null : value);
  const repos = [...new Set([...sample.items, ...sample.activities].map(row => row.project_path))].sort();
  const actors = [...new Set([
    ...sample.items.map(row => row.author),
    ...sample.activities.map(row => row.actor),
  ].filter(Boolean))].sort();
  for (const [from, to] of [
    ...repos.map((path, index) => [path, `demo-fixtures/project-${index + 1}`]),
    ...sample.sources.map(({ host, kind }) => [host, `demo-${kind}`]),
  ]) {
    json = json.replaceAll(from, to)
      .replaceAll(encodeURIComponent(from), encodeURIComponent(to));
  }
  // Exact identity values and composite actor keys, without altering labels or titles.
  for (const [index, actor] of actors.entries()) {
    const label = `demo-user-${index + 1}`;
    json = json.replaceAll(JSON.stringify(actor), JSON.stringify(label))
      .replaceAll(`:${actor}"`, `:${label}"`);
  }
  return { json, generatedAt: new Date(sample.generated_at) };
}

const temp = await mkdtemp(join(tmpdir(), "board-screenshots-"));
try {
  const dist = join(temp, "demo");
  execFileSync("pnpm", ["--filter", "@symphony-board/ui", "run", "build", "--outDir", dist, "--emptyOutDir"], {
    cwd: root, env: { ...process.env, VITE_SYMPHONY_BOARD_STATIC: "1" }, stdio: "inherit",
  });
  const { json, generatedAt } = await screenshotContract();
  const browser = await chromium.launch();
  const captured = [];
  try {
    for (const scheme of ["light", "dark"]) {
      for (const { name, tab, ready, width, height } of shots) {
        const page = await browser.newPage({
          viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 2,
          locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce", serviceWorkers: "block",
        });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        // Fulfil the static build in-process. No browser request can reach a
        // provider, a configured backend, or a developer's machine.
        await page.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== origin || !url.pathname.startsWith("/demo/")) return route.abort();
          const path = url.pathname.slice("/demo/".length);
          if (path === "contract.json") return route.fulfill({ body: json, contentType: "application/json" });
          if (path === "" || path === "favicon.svg" || path.startsWith("assets/")) {
            return route.fulfill({ path: join(dist, path || "index.html") });
          }
          return route.abort();
        });
        await page.clock.setFixedTime(generatedAt);
        await page.goto(`${origin}/demo/`);
        await page.locator("#boot-splash").waitFor({ state: "hidden" });
        if (tab !== "Activity") {
          await page.locator(".page-tabs").getByRole("link", { name: tab, exact: true }).click();
        }
        if (tab === "Graph") {
          await page.getByRole("button", { name: "Hierarchy", exact: true }).click();
        }
        await page.locator(ready).first().waitFor({ state: "visible" });
        await page.mouse.move(0, 0);
        if (tab === "Board") {
          assert.ok(await page.locator(".board-lanes").evaluate(lanes => lanes.scrollWidth <= lanes.clientWidth),
            "all Board lanes must fit in the preview");
        }
        await page.waitForFunction((expected) =>
          getComputedStyle(document.documentElement).colorScheme === expected, scheme);
        await page.evaluate(() => document.fonts.ready);
        const png = join(temp, "capture.png");
        await page.screenshot({ path: png, animations: "disabled", caret: "hide" });
        assert.deepEqual(errors, [], `${name} (${scheme}) raised a browser error`);
        const filename = `${name}-${scheme}.webp`;
        execFileSync("cwebp", ["-quiet", "-z", "6", "-metadata", "none", png, "-o", join(temp, filename)]);
        captured.push(filename);
        console.log(`${filename} (${width * 2}×${height * 2})`);
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  await mkdir(out, { recursive: true });
  for (const file of captured) await cp(join(temp, file), join(out, file));
} finally {
  await rm(temp, { recursive: true, force: true });
}
