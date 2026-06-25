import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The GitHub Pages demo derives its default range from item_window.window.since
// (staticContractTimeRange in packages/ui). A snapshot refresh once silently
// re-widened that window from 30 to 90 days (#451). build-demo-contract.sh now
// re-narrows it via scripts/demo/narrow-landing-window.mjs; these guard the
// COMMITTED artifact so a future refresh that skips that step fails CI instead of
// shipping a 90-day demo — independent of the script itself, which CI never runs.

const contract = JSON.parse(
  readFileSync(fileURLToPath(new URL("../site/demo-contract.json", import.meta.url)), "utf8"),
);

test("demo contract lands on a trailing month, not the 90-day product window", () => {
  const win = contract.item_window?.window;
  assert.ok(win, "site/demo-contract.json has item_window.window");
  assert.equal(win.kind, "active_since");
  assert.ok(
    Number.isInteger(win.days) && win.days > 0 && win.days <= 30,
    `demo landing window must be a positive month-or-less, got days=${win.days}`,
  );
});

test("demo contract item_window.since is consistent with its days + generated_at", () => {
  const win = contract.item_window.window;
  // Mirrors cutoffIso() in src/contract/build.ts and narrow-landing-window.mjs.
  const expected = new Date(Date.parse(contract.generated_at) - win.days * 86_400_000).toISOString();
  assert.equal(win.since, expected);
});

test("narrowing the landing window leaves activity_daily full history intact", () => {
  // activity_daily powers the trailing-12-month Activity Overview and is emitted
  // unwindowed; narrowing item_window must never touch it, so it spans far more
  // than the landing window.
  const ad = contract.activity_daily;
  assert.ok(ad?.from && ad?.to, "contract has activity_daily with from/to");
  const spanDays = (Date.parse(ad.to) - Date.parse(ad.from)) / 86_400_000;
  assert.ok(spanDays > 90, `activity_daily must keep full history, spans only ${spanDays} days`);
});
