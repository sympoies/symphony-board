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

  // Android can cold-start on Activity/Board while Live is enabled. In that
  // case the first usable app frame still includes Live readiness, so do not
  // drop the splash before the Live snapshot has either seeded or failed.
  assert.equal(
    bootSplashReady({ routePage: "activity", loading: false, liveConnected: null, liveEnabled: true, timedOut: false }),
    false,
    "non-Live landing + Live enabled + Live still unknown -> keep the splash",
  );
  assert.equal(
    bootSplashReady({ routePage: "activity", loading: false, liveConnected: true, liveEnabled: true, timedOut: false }),
    true,
    "non-Live landing + Live enabled + Live seeded -> dismiss",
  );
  assert.equal(
    bootSplashReady({ routePage: "activity", loading: false, liveConnected: false, liveEnabled: true, timedOut: false }),
    true,
    "non-Live landing + Live enabled + Live unavailable -> dismiss with the visible app",
  );
  assert.equal(
    bootSplashReady({ routePage: "activity", loading: false, liveConnected: null, liveEnabled: false, timedOut: false }),
    true,
    "Live disabled in Settings -> never wait on Live readiness",
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
