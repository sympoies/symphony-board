// Wait budgeting for render-smoke.
//
// This exists as its own module because the bug it fixes was invisible in the
// script: render-smoke computed ONE wall-clock deadline at startup and every
// `waitHtml` / `waitValue` closed over it. The suite has long since grown past
// that budget, so every wait after the first minute returned on its first check.
// The later half of the run stopped waiting for anything and passed only when
// the machine happened to be fast enough for the fixed `sleep()`s between steps.
//
// The failure mode is what makes it worth a module and a test. A wait that
// stops waiting does not report a timeout — the probe just reads an unrendered
// page and returns `found: false`, which looks exactly like a layout defect on
// whatever page it names. On a loaded machine this produced ~77 interleaved
// failures across pages a change had never touched, and reads as a real
// regression until you notice the same probes pass on an idle box.

// Per-wait budget. Long enough to absorb a loaded machine, short enough that a
// genuinely broken page still fails the run promptly.
export const DEFAULT_WAIT_MS = 15_000;

// Whole-run cap, so a pathological hang ends rather than blocking forever. Much
// larger than any single wait: it is a backstop, not a budget.
export const DEFAULT_RUN_MS = 900_000;

/**
 * The wall-clock instant a wait starting now should give up at.
 *
 * Each call gets its own budget, so a wait late in the run is as patient as the
 * first one. The run-wide cap still truncates it, and a run already past the cap
 * gets no budget at all (the returned instant is `nowMs`, so the caller's
 * `while (Date.now() < deadline)` exits immediately).
 */
export function waitDeadline(nowMs, waitMs = DEFAULT_WAIT_MS, runDeadlineMs = Infinity) {
  if (nowMs >= runDeadlineMs) return nowMs;
  return Math.min(nowMs + waitMs, runDeadlineMs);
}
