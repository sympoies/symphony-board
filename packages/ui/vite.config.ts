import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Resolve metadata once, while building the artifact. Runtime clients never
// inspect a checkout. Docker builds receive the source revision explicitly.
const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
let commit = process.env.SYMPHONY_BOARD_BUILD_COMMIT ?? "";
if (!commit) {
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: new URL("../..", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    // Source archives without injected metadata have an explicit unavailable build.
  }
}

// SYMPHONY_BOARD_SMOKE_DEV=1 builds React's *development* bundle into dist-dev/
// so the render-smoke can exercise dev-only behavior the production build
// strips — above all React StrictMode's deliberate double-invoke of mount +
// effects, which surfaces non-idempotent effects (unbalanced subscriptions,
// missing cleanup) that React 19 tightened. `vite build` forces
// NODE_ENV=production regardless of --mode, so we override the define directly;
// this artifact is smoke-only and never shipped.
const smokeDev = process.env.SYMPHONY_BOARD_SMOKE_DEV === "1";

// Relative base so the built dist/ can be served from any path (or opened
// alongside a contract.json the loop daemon emitted). The app fetches
// ./contract.json by default.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: smokeDev ? "dist-dev" : "dist",
    target: "es2022",
    // Keep the dev bundle readable and un-stripped so the dev React runtime
    // (with its invariant checks) is what actually executes.
    ...(smokeDev ? { minify: false } : {}),
  },
  define: {
    __SYMPHONY_BOARD_BUILD__: JSON.stringify({ version, commit }),
    ...(smokeDev ? { "process.env.NODE_ENV": JSON.stringify("development") } : {}),
  },
});
