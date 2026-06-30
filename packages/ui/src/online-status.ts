// Device online/offline awareness for the degraded-data banner. The banner uses
// it to tell "you're offline" from "the server is unreachable", and App uses the
// offline->online edge to retry immediately instead of waiting out the backoff.
//
// navigator.onLine is a best-effort HINT — in the Android Tauri WebView it can
// report online with no route to the server (a Tailscale peer being down), and
// the events may not fire — so this only refines copy and accelerates recovery;
// the auto-backoff retry loop stays the recovery floor and is never gated on it.
import { useEffect, useState } from "react";

export type OnlineEvent = "online" | "offline";

// Pure reducer: the event IS the new value (a duplicate event is idempotent, so
// it never spuriously flips the state). Exported so it can be unit-tested without
// a DOM — the hook below must never be imported under bare `node --test`.
export function onlineReducer(_state: boolean, event: OnlineEvent): boolean {
  return event === "online";
}

// SSR-/test-safe: navigator and window are touched ONLY inside the lazy useState
// initializer and the effect, never at module scope, so importing this module
// under `node --test` (no jsdom) cannot throw a ReferenceError. Defaults to
// online when the API is absent (the optimistic default — a wrong "offline" would
// be more misleading than a wrong "online").
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator !== "undefined" && typeof navigator.onLine === "boolean" ? navigator.onLine : true,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onOnline = () => setOnline((s) => onlineReducer(s, "online"));
    const onOffline = () => setOnline((s) => onlineReducer(s, "offline"));
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    // Re-sync after the listeners attach: connectivity may have flipped between
    // the initial render (lazy initializer) and this effect. Mirrors useMediaQuery.
    if (typeof navigator !== "undefined" && typeof navigator.onLine === "boolean") {
      setOnline(navigator.onLine);
    }
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);
  return online;
}
