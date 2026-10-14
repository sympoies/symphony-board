import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ui = dirname(dirname(fileURLToPath(import.meta.url)));

test("rank header smoke uses a short profile with long TMPDIR and cleans up a signal exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "header-harness-"));
  try {
    await mkdir(join(root, "scripts"));
    await mkdir(join(root, "dist"));
    const longTemp = join(root, "x".repeat(80), "y".repeat(80));
    await mkdir(longTemp, { recursive: true });
    await writeFile(join(root, "scripts/rank-header-smoke.mjs"), await readFile(join(ui, "scripts/rank-header-smoke.mjs")));
    await writeFile(join(root, "dist/contract.json"), await readFile(join(ui, "public/contract.json")));
    const browser = join(root, "chrome");
    const argsFile = join(root, "chrome-args");
    await writeFile(browser, '#!/bin/sh\nprintf "%s\\n" "$@" > "$CHROME_ARGS_FILE"\nkill -TERM "$$"\n', { mode: 0o755 });
    const child = spawn(process.execPath, [join(root, "scripts/rank-header-smoke.mjs")], {
      env: { ...process.env, CHROME_BIN: browser, CHROME_ARGS_FILE: argsFile, TMPDIR: longTemp, SYMPHONY_BOARD_HEADER_OUT: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 13000);
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    }).finally(() => clearTimeout(timer));
    assert.equal(result.signal, null, "the harness must terminate itself, without the test deadline killing it");
    assert.equal(result.code, 1, output);
    assert.match(output, /Chrome.*SIGTERM/, "report the browser termination instead of hiding it in cleanup");
    const args = (await readFile(argsFile, "utf8")).trim().split("\n");
    const profile = args.find(arg => arg.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
    assert.ok(profile.length < 80, "a long TMPDIR must not produce a long Chrome socket path");
    await assert.rejects(access(profile), { code: "ENOENT" }, "failed startup must remove the temporary profile");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
