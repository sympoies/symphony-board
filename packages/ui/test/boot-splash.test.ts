import { test } from "node:test";
import assert from "node:assert/strict";
import { bootSplashReady } from "../src/boot-splash.ts";

// The cold-start splash must KEEP COVERING the live route until the page has real
// CONTENT to show — never the blank/"Connecting…" gap. Dismissing immediately
// (the earlier regression) tore the splash off into a still-connecting Live feed.
// Content can arrive two ways: the per-server cache paints last-known events
// instantly (warm launch -> dismiss at once), or the (now small + bounded) probe
// resolves the connection. A hard timeout still prevents stranding.
test("bootSplashReady holds the live route until it has content or the probe resolves", () => {
  // Cold launch, no cache, still connecting -> HOLD (this is the fix).
  assert.equal(
    bootSplashReady({ routePage: "live", loading: true, hasContent: false, liveConnected: null, liveHasContent: false, timedOut: false }),
    false,
    "live + connecting + no content -> keep the splash covering the blank gap",
  );
  // Cache painted last-known events -> dismiss at once (warm launch).
  assert.equal(
    bootSplashReady({ routePage: "live", loading: true, hasContent: false, liveConnected: null, liveHasContent: true, timedOut: false }),
    true,
    "live + cached content present -> dismiss into real content immediately",
  );
  // Connection resolved up -> ready feed.
  assert.equal(
    bootSplashReady({ routePage: "live", loading: false, hasContent: false, liveConnected: true, liveHasContent: false, timedOut: false }),
    true,
    "live + connected -> dismiss into the seeded feed",
  );
  // Probe resolved unavailable -> the page shows its status (and the app may bounce).
  assert.equal(
    bootSplashReady({ routePage: "live", loading: false, hasContent: false, liveConnected: false, liveHasContent: false, timedOut: false }),
    true,
    "live + unavailable -> dismiss; the page renders its Offline state / redirect fires",
  );

  // Contract-backed pages: dismiss as soon as there is CONTENT (warm cache) or
  // the load resolves; never gated on Live.
  assert.equal(
    bootSplashReady({ routePage: "activity", loading: true, hasContent: false, liveConnected: null, liveHasContent: false, timedOut: false }),
    false,
    "contract page cold + still loading + no cache -> keep the splash",
  );
  assert.equal(
    bootSplashReady({ routePage: "activity", loading: true, hasContent: true, liveConnected: null, liveHasContent: false, timedOut: false }),
    true,
    "contract page with a cached (stale) board painted -> dismiss while the fetch revalidates behind it",
  );
  assert.equal(
    bootSplashReady({ routePage: "activity", loading: false, hasContent: false, liveConnected: null, liveHasContent: false, timedOut: false }),
    true,
    "contract page load resolved -> dismiss regardless of Live",
  );
  assert.equal(
    bootSplashReady({ routePage: "board", loading: false, hasContent: false, liveConnected: null, liveHasContent: false, timedOut: false }),
    true,
  );

  // Debug is self-contained.
  assert.equal(
    bootSplashReady({ routePage: "debug", loading: true, hasContent: false, liveConnected: null, liveHasContent: false, timedOut: false }),
    true,
    "debug renders immediately regardless of load state",
  );

  // The hard timeout overrides everything so a never-arriving signal cannot strand.
  assert.equal(
    bootSplashReady({ routePage: "live", loading: true, hasContent: false, liveConnected: null, liveHasContent: false, timedOut: true }),
    true,
    "timeout dismisses even while live is still connecting",
  );
  assert.equal(
    bootSplashReady({ routePage: "activity", loading: true, hasContent: false, liveConnected: null, liveHasContent: false, timedOut: true }),
    true,
    "timeout dismisses even while the contract is still loading",
  );
});
