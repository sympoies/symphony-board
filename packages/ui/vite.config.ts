import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

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
  ...(smokeDev
    ? { define: { "process.env.NODE_ENV": JSON.stringify("development") } }
    : {}),
});
