import { test } from "node:test";
import assert from "node:assert/strict";
import { bootSplashReady } from "../src/boot-splash.ts";

// The cold-start splash covers only the SHELL — bounded work (the contract
// load) — never the open-ended live stream. The Live page renders its own
// connecting skeleton, so the splash dismisses INTO it rather than holding for a
// network stream whose connect time is unbounded. Holding for the stream is what
// produced the reported regression: a 12s splash cap that timed out and revealed
// a Live page still stuck on "Connecting…" for ~a minute.
test("bootSplashReady covers only the shell, never the live stream", () => {
  // Live page: contract-independent and renders its own skeleton immediately, so
  // the splash never waits on the live connection — dismiss as soon as the shell
  // can paint, whatever the contract/stream state.
  assert.equal(
    bootSplashReady({ routePage: "live", loading: true, timedOut: false }),
    true,
    "live renders its own connecting skeleton -> never gate the splash on the stream",
  );
  assert.equal(
    bootSplashReady({ routePage: "live", loading: false, timedOut: false }),
    true,
  );

  // Contract-backed pages: hold until the contract load resolves (bounded work).
  assert.equal(
    bootSplashReady({ routePage: "activity", loading: true, timedOut: false }),
    false,
    "contract page still loading -> keep the splash over the blank gap",
  );
  assert.equal(
    bootSplashReady({ routePage: "activity", loading: false, timedOut: false }),
    true,
    "contract page loaded -> dismiss",
  );
  assert.equal(
    bootSplashReady({ routePage: "board", loading: false, timedOut: false }),
    true,
  );

  // A non-Live landing is NEVER held hostage to Live readiness anymore: the
  // contract-backed page has its own content and Live prewarms in the background.
  assert.equal(
    bootSplashReady({ routePage: "activity", loading: false, timedOut: false }),
    true,
    "non-Live landing dismisses on contract readiness regardless of Live prewarm",
  );

  // The hidden diagnostics page is self-contained — never gate it on data.
  assert.equal(
    bootSplashReady({ routePage: "debug", loading: true, timedOut: false }),
    true,
    "debug renders immediately regardless of load state",
  );

  // The hard timeout overrides everything so a never-arriving signal cannot
  // strand the splash over the app.
  assert.equal(
    bootSplashReady({ routePage: "activity", loading: true, timedOut: true }),
    true,
    "timeout dismisses even while the contract is still loading",
  );
  assert.equal(
    bootSplashReady({ routePage: "live", loading: true, timedOut: true }),
    true,
  );
});
