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
