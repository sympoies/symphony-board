import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { waitDeadline, DEFAULT_WAIT_MS } from "../scripts/smoke-wait.mjs";

// render-smoke used to compute ONE wall-clock deadline at startup and have every
// waitHtml / waitValue close over it. The suite has long since grown past that
// budget, so every wait after the first minute returned on its first check: the
// later half of the run stopped waiting for anything and only passed when the
// machine happened to be fast enough for the fixed sleeps between steps. That is
// silent — a probe reports `found: false`, which reads like a layout defect on
// the page it names rather than a harness that stopped waiting.

test("each wait gets its own budget, however late in the run it happens", () => {
  const runDeadline = 900_000;

  // The first wait, at the start of the run.
  assert.equal(waitDeadline(0, 10_000, runDeadline), 10_000);

  // The same wait two minutes in. Under the old shared-deadline shape this had
  // already expired and the helper returned immediately; it must still get its
  // full budget.
  assert.equal(waitDeadline(120_000, 10_000, runDeadline), 130_000);

  // And five minutes in, well past any plausible single run-wide budget.
  assert.equal(waitDeadline(300_000, 10_000, runDeadline), 310_000);
});

test("no wait may outlive the run-wide cap", () => {
  const runDeadline = 900_000;

  // A wait starting near the cap is truncated to it rather than extending past,
  // so a pathological hang still ends the run instead of blocking forever.
  assert.equal(waitDeadline(895_000, 10_000, runDeadline), runDeadline);

  // Already past the cap: no budget at all, so the caller stops immediately.
  assert.equal(waitDeadline(900_001, 10_000, runDeadline), 900_001);
});

test("the default per-wait budget is a wait, not a formality", () => {
  // Small enough that a genuinely broken page fails the run in reasonable time,
  // large enough to absorb a loaded machine — which is the case that exposed
  // this, where probes on a busy box found nothing and reported it as a defect.
  assert.ok(DEFAULT_WAIT_MS >= 5_000, `too short to absorb a loaded machine (${DEFAULT_WAIT_MS}ms)`);
  assert.ok(DEFAULT_WAIT_MS <= 30_000, `too long to fail a broken page promptly (${DEFAULT_WAIT_MS}ms)`);
});

test("render-smoke's wait helpers do not share one run-wide deadline", () => {
  const source = readFileSync(new URL("../scripts/render-smoke.mjs", import.meta.url), "utf8");

  // The structural half of the regression: the helpers must derive a deadline
  // per call. A helper that closes over a single outer `deadline` reintroduces
  // the defect without failing any of the unit assertions above.
  for (const helper of ["waitHtml", "waitValue", "waitForCapabilitiesRequests"]) {
    const body = new RegExp(`const ${helper} = async \\([^)]*\\) => \\{([\\s\\S]*?)\\n  \\};`).exec(source)?.[1];
    assert.ok(body, `${helper} must still be a helper this test can read`);
    assert.doesNotMatch(
      body,
      /Date\.now\(\) < deadline\b/,
      `${helper} must not close over the run-wide deadline`,
    );
    assert.match(body, /waitDeadline\(/, `${helper} must take its own budget from waitDeadline`);
  }
});

test("the timeout diagnostic prints in the summary that actually runs", () => {
  const source = readFileSync(new URL("../scripts/render-smoke.mjs", import.meta.url), "utf8");

  // render-smoke has two summary blocks: a standalone-setup one and the board
  // one that normal runs reach. An earlier revision put the detail print in the
  // standalone branch by accident, so a failing run showed "no waits timed out
  // (68)" and not one of the 68. That is the same shape of defect the timeouts
  // themselves are: a diagnostic that reads as present while doing nothing.
  const check = source.indexOf("no waits timed out (");
  const detail = source.indexOf("wait timed out:");
  assert.ok(check > 0, "the summary must still count timed-out waits");
  assert.ok(detail > 0, "the summary must still be able to print which waits timed out");
  assert.ok(
    detail > check,
    "the detail print must sit in the same summary block as the count, not in the standalone branch above it",
  );
});
