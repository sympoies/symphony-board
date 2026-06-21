import { test } from "node:test";
import assert from "node:assert/strict";
import { bootSplashReady } from "../src/boot-splash.ts";

// The cold-start splash must stay up until the first view has CONTENT, never the
// blank gap between mount and content (the reported Live cold-start regression).
test("bootSplashReady holds the splash until the first view has content", () => {
  // Live page: contract-independent but blank until its snapshot probe resolves.
  assert.equal(
    bootSplashReady({ routePage: "live", loading: true, liveConnected: null, timedOut: false }),
    false,
    "live + still probing (connected null) -> keep the splash over the blank gap",
  );
  assert.equal(
    bootSplashReady({ routePage: "live", loading: true, liveConnected: true, timedOut: false }),
    true,
    "live + connected -> feed has content, dismiss",
  );
  assert.equal(
    bootSplashReady({ routePage: "live", loading: false, liveConnected: false, timedOut: false }),
    true,
    "live + probe resolved unavailable -> the page shows its status, dismiss",
  );

  // Contract-backed pages: hold until the contract load resolves.
  assert.equal(
    bootSplashReady({ routePage: "activity", loading: true, liveConnected: null, timedOut: false }),
    false,
    "contract page still loading -> keep the splash",
  );
  assert.equal(
    bootSplashReady({ routePage: "activity", loading: false, liveConnected: null, timedOut: false }),
    true,
    "contract page loaded -> dismiss",
  );
  assert.equal(
    bootSplashReady({ routePage: "board", loading: false, liveConnected: null, timedOut: false }),
    true,
  );

  // The hidden diagnostics page is self-contained — never gate it on data.
  assert.equal(
    bootSplashReady({ routePage: "debug", loading: true, liveConnected: null, timedOut: false }),
    true,
    "debug renders immediately regardless of load state",
  );

  // The hard timeout overrides everything so a never-arriving signal cannot
  // strand the splash over the app.
  assert.equal(
    bootSplashReady({ routePage: "live", loading: true, liveConnected: null, timedOut: true }),
    true,
    "timeout dismisses even while live is still probing",
  );
  assert.equal(
    bootSplashReady({ routePage: "activity", loading: true, liveConnected: null, timedOut: true }),
    true,
    "timeout dismisses even while the contract is still loading",
  );
});
