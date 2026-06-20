// Contract-independent Live page. Renders the realtime webhook feed from the
// `useLive` hook; depends on no loaded contract (it renders via App's early
// return, like the Diagnostics page). Per Decision 10 it shows the full event
// body by default and the raw payload behind an expand affordance, and labels
// the feed as best-effort with the board as the source of truth.
import { useLive } from "../useLive.ts";
import type { LiveEvent } from "../model.ts";

function timeLabel(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function statusLabel(
  connected: boolean | null,
  transport: "sse" | "poll" | null,
): string {
  if (connected === null) return "Connecting…";
  if (connected === false) return "Unavailable";
  return transport === "poll" ? "Live (polling)" : "Live";
}

function targetLabel(target: LiveEvent["target"]): string {
  if (!target) return "";
  const repo = target.project_path ?? target.source_id;
  const num = target.number != null ? ` #${target.number}` : "";
  const title = target.title ? ` — ${target.title}` : "";
  return `${repo}${num}${title}`;
}

function LiveRow({ ev }: { ev: LiveEvent }) {
  const when = timeLabel(ev.occurred_at ?? ev.received_at);
  const actor = ev.actor?.login ?? "someone";
  return (
    <li className="live-event" data-category={ev.category}>
      <div className="live-event-head">
        <span className="live-event-category">{ev.category}</span>
        <span className="live-event-title">
          {ev.title ?? `${actor} · ${ev.event_type}`}
        </span>
        {when ? <time className="live-event-time">{when}</time> : null}
      </div>
      {ev.target?.url ? (
        <a
          className="live-event-target"
          href={ev.target.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {targetLabel(ev.target)}
        </a>
      ) : null}
      {ev.body ? <p className="live-event-body">{ev.body}</p> : null}
      {ev.raw ? (
        <details className="live-event-raw">
          <summary>raw payload</summary>
          <pre>{JSON.stringify(ev.raw, null, 2)}</pre>
        </details>
      ) : null}
    </li>
  );
}

export function LivePage({
  serverBaseUrl,
  onClose,
}: {
  serverBaseUrl: string | null;
  onClose: () => void;
}) {
  const { events, connected, transport } = useLive(serverBaseUrl);
  const statusKind =
    connected === null ? "connecting" : connected ? "up" : "down";
  return (
    <div className="live-page">
      <header className="live-header">
        <div className="live-header-main">
          <a
            className="live-back"
            href="#/activity"
            onClick={(e) => {
              e.preventDefault();
              onClose();
            }}
          >
            ← Back
          </a>
          <h1>Live</h1>
          <span className={`live-status live-status-${statusKind}`}>
            {statusLabel(connected, transport)}
          </span>
        </div>
        <p className="live-note">
          A best-effort live feed of incoming webhook activity. It may have gaps
          (the receiver does not retry missed deliveries); the board (periodic
          sync) remains the source of truth.
        </p>
      </header>
      {events.length === 0 ? (
        <p className="empty">
          {connected === false
            ? "Live stream unavailable on this deployment."
            : connected === null
              ? "Connecting…"
              : "No live events yet. New webhook activity will appear here in real time."}
        </p>
      ) : (
        <ul className="live-feed">
          {events.map((ev) => (
            <LiveRow key={`${ev.source_id}:${ev.event_id}:${ev.seq}`} ev={ev} />
          ))}
        </ul>
      )}
    </div>
  );
}
