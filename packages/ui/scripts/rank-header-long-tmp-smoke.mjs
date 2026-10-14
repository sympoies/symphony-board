// Run the real Chrome layout fixture with deliberately long parent temp roots.
// This catches browser socket paths that ignore a short --user-data-dir.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = await mkdtemp(join(tmpdir(), "header-long-tmp-"));
try {
  const longTemp = join(root, "x".repeat(80), "y".repeat(80));
  await mkdir(longTemp, { recursive: true });
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning",
    fileURLToPath(new URL("./rank-header-smoke.mjs", import.meta.url))], {
    env: { ...process.env, TMPDIR: longTemp, TMP: longTemp, TEMP: longTemp }, stdio: "inherit",
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => resolve(code ?? 1));
  });
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
