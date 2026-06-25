#!/usr/bin/env node
// Narrow the FROZEN demo contract's landing window to a trailing N-day window,
// offline (no re-sync). The Pages demo derives its default range from
// item_window.window.since/days (see staticContractTimeRange in packages/ui), so
// this is what makes the demo land on the last N days.
//
// Why this exists as a post-step instead of an emit flag: emit-contract.ts always
// projects the 90-day board payload (CONTRACT_ITEM_WINDOW_DAYS) the real product
// ships, and the demo must NOT change that. The narrower landing window is a
// demo-only concern, so build-demo-contract.sh runs this as its last step. That
// also keeps the preference from being silently widened back to 90 days the next
// time someone refreshes the frozen snapshot (this previously regressed: a manual
// 30-day edit was clobbered by a refresh — see #451).
//
// Only item_window.window is rewritten; the payload (items/edges/activities/
// activity_daily) is left untouched, exactly as the manual edit did, so the
// trailing-12-month Activity Overview (activity_daily, full history) stays
// complete and a viewer can still widen the range to the full payload extent.
//
// Idempotent: `since` is derived from the contract's own generated_at (mirroring
// cutoffIso in src/contract/build.ts), so re-running yields the same result.
//
//   node scripts/demo/narrow-landing-window.mjs [contract.json] [days]
import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2] ?? "site/demo-contract.json";
const days = Number(process.argv[3] ?? 30);
if (!Number.isInteger(days) || days <= 0) {
  console.error(`narrow-landing-window: days must be a positive integer, got "${process.argv[3]}"`);
  process.exit(1);
}

let contract;
try {
  contract = JSON.parse(readFileSync(path, "utf8"));
} catch (err) {
  console.error(`narrow-landing-window: cannot read/parse ${path}: ${err.message}`);
  process.exit(1);
}
const win = contract.item_window?.window;
if (!win) {
  console.error(`narrow-landing-window: ${path} has no item_window.window to narrow`);
  process.exit(1);
}

const generatedAtMs = Date.parse(contract.generated_at);
if (!Number.isFinite(generatedAtMs)) {
  console.error(`narrow-landing-window: ${path} has invalid generated_at "${contract.generated_at}"`);
  process.exit(1);
}

// Mirror cutoffIso() in src/contract/build.ts so the value is byte-identical to a
// native emit at this window.
const since = new Date(generatedAtMs - days * 86_400_000).toISOString();

// Only window.* is rewritten. The sibling counts (primary_items /
// edge_endpoint_items / total_items / truncated) intentionally stay scoped to the
// emitted 90-day payload, because that payload is NOT narrowed — only the landing
// range is. Don't "fix" them to the N-day count without also trimming the
// items/edges arrays, or the demo loses its widenable data. No schema check or
// consumer cross-checks these against window.days (only the debug panel reads
// them), so the relabel is safe.
win.kind = "active_since";
win.basis = "item_updated_at";
win.since = since;
win.days = days;
win.edge_filter = null;

// emit-contract.ts writes JSON.stringify(envelope, null, 2) + "\n"; round-trip in
// the same shape so the diff is just the rewritten item_window fields.
writeFileSync(path, JSON.stringify(contract, null, 2) + "\n");
console.error(`narrow-landing-window: ${path} -> last ${days}d (since ${since}, to ${contract.generated_at})`);
