// Cold-start boot splash control. The splash markup + styles live in index.html
// so they paint on the very FIRST frame — before this bundle (and styles.css)
// load — covering the otherwise-blank cold start (bundle parse + React mount +
// the first contract fetch) with a themed loading hint. React owns its REMOVAL:
// App dismisses it once the first real view is ready (board / error / onboarding
// / live / debug), so the overlay never lingers over a usable app.
//
// All DOM access is guarded, so importing or calling this in a non-browser test
// environment (the node:test unit suite) is a safe no-op.

const SPLASH_ID = "boot-splash";
const STATUS_ID = "boot-splash-status";
// Matches the opacity transition declared on #boot-splash in index.html.
const FADE_MS = 400;

let dismissed = false;

// Hard ceiling for how long the cold-start splash may stay up before it is
// dismissed regardless of readiness, so a signal that never arrives (e.g. a dead
// network on the Live tab) can't leave the splash covering the app forever.
export const BOOT_SPLASH_MAX_MS = 12_000;

// Whether the cold-start splash may be dismissed. The splash covers only the
// SHELL — bounded work (the contract load) — never the open-ended live stream.
// Pure + unit-tested (boot-splash.test.ts) so the readiness rule can't silently
// regress.
//   - debug: self-contained, renders immediately.
//   - live: contract-INDEPENDENT and renders its OWN connecting skeleton on
//     mount, so the splash dismisses INTO it. It must NOT wait for the live
//     connection: that connect time is unbounded (snapshot probe + SSE/poll over
//     a possibly-cold link), and holding for it is exactly what stranded the
//     splash on its 12s cap and then revealed a Live page still "Connecting…" for
//     ~a minute. The Live page owns its loading/connecting/offline states.
//   - every other (contract-backed) page: until the contract load resolves.
//   - timedOut: a hard ceiling so a never-arriving signal can't strand the splash.
export function bootSplashReady(opts: {
  routePage: string;
  loading: boolean;
  timedOut: boolean;
}): boolean {
  if (opts.timedOut) return true;
  if (opts.routePage === "debug") return true;
  if (opts.routePage === "live") return true;
  return !opts.loading;
}

// Update the splash's status line (e.g. "Loading…" -> "Reconnecting…"). No-op
// once the splash has been dismissed or outside the browser.
export function setBootSplashStatus(text: string): void {
  if (dismissed || typeof document === "undefined") return;
  const status = document.getElementById(STATUS_ID);
  if (status) status.textContent = text;
}

// Fade the splash out and remove it from the DOM. Idempotent — safe to call from
// an effect that may run more than once (and the first call wins, so a later
// re-entry does nothing).
export function dismissBootSplash(): void {
  if (dismissed) return;
  dismissed = true;
  if (typeof document === "undefined") return;
  const el = document.getElementById(SPLASH_ID);
  if (!el) return;
  el.setAttribute("data-hiding", "true");
  const remove = (): void => el.remove();
  if (typeof window !== "undefined" && typeof window.setTimeout === "function") {
    window.setTimeout(remove, FADE_MS);
  } else {
    remove();
  }
}
