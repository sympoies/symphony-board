// Contract-independent Live tab. Renders the realtime webhook feed from the
// `useLive` hook; depends on no loaded contract (it renders inside App's live
// branch, which keeps the shell tab bar so Live switches like any other tab).
// Above the feed sits a "pulse" strip — activity rate + a rolling histogram,
// last-event freshness, buffer depth, and who/what is active — all derived from
// the in-memory buffer by the pure helpers in live-stats.ts. Per Decision 10 a
// row shows the full event body by default with the raw payload behind an
// expander, and the feed is labelled best-effort with the board as the truth.
import { useEffect, useState, type CSSProperties } from "react";
import { useLive, MAX_EVENTS } from "../useLive.ts";
import { safeHref } from "../url.ts";
import {
  categoryCounts,
  countInWindow,
  distinctCount,
  eventInstant,
  eventRepo,
  rateBuckets,
  relativeAge,
} from "../live-stats.ts";
import type { LiveEvent } from "../model.ts";

// Provider-neutral category order for the filter strip (see LiveEvent.category
// in model.ts); any category not listed is appended by categoryCounts.
const CATEGORY_ORDER = [
  "push",
  "change_request",
  "issue",
  "review",
  "review_comment",
  "review_thread",
  "comment",
  "pipeline",
] as const;

const RATE_WINDOW_MS = 60_000; // the "/min" figure
const SPARK_BUCKET_MS = 30_000; // one histogram bar per 30s
const SPARK_BUCKETS = 30; // 30 bars → last 15 minutes

// A custom property carrying an event's category hue; consumers fall back to
// --muted, so an unforeseen category still renders (its var resolves invalid).
const catStyle = (category: string): CSSProperties =>
  ({ "--cat": `var(--cat-${category})` }) as CSSProperties;

const humanizeCategory = (c: string): string => c.replace(/_/g, " ");
const shortRepo = (repo: string | null): string => (repo ? (repo.split("/").pop() ?? repo) : "—");

function statusLabel(
  connected: boolean | null,
  reconnecting: boolean,
  transport: "sse" | "poll" | null,
): string {
  if (connected === null) return "Connecting…";
  if (connected === false) return "Offline";
  // A drop that follows a successful open is transient: EventSource auto-
  // reconnects (poll retries on its own tick), so say so rather than "Live".
  if (reconnecting) return "Reconnecting…";
  return transport === "poll" ? "Streaming (polling)" : "Streaming";
}

function Sparkline({ values }: { values: number[] }) {
  // Floor the scale so a quiet feed (a few events) does not paint full-height
  // bars and read as a storm.
  const max = Math.max(4, ...values);
  return (
    <div className="live-spark" aria-hidden="true">
      {values.map((v, i) => (
        <span
          key={i}
          className={`live-spark-bar${i === values.length - 1 ? " live-spark-bar-now" : ""}`}
          style={{ height: `${Math.max(6, Math.round((v / max) * 100))}%` }}
        />
      ))}
    </div>
  );
}

function LiveRow({ ev, now }: { ev: LiveEvent; now: number }) {
  const instant = eventInstant(ev);
  const age = instant != null ? relativeAge(instant, now) : "";
  const actor = ev.actor?.login ?? "someone";
  const repo = eventRepo(ev);
  // The event's own url is the precise permalink (e.g. the exact issue_comment /
  // review-comment anchor); fall back to the parent target's url so a row
  // without an event-level link still links to the issue/PR. Scheme-guarded so
  // only http/https/mailto can become a clickable link.
  const linkUrl = safeHref(ev.url ?? ev.target?.url);
  const num = ev.target?.number != null ? `#${ev.target.number}` : "";
  return (
    <li className="live-event" data-category={ev.category} style={catStyle(ev.category)}>
      <span className="live-event-dot" aria-hidden="true" />
      <div className="live-event-main">
        <div className="live-event-head">
          <span className="live-event-category">{humanizeCategory(ev.category)}</span>
          <span className="live-event-title">{ev.title ?? `${actor} · ${ev.event_type}`}</span>
        </div>
        {linkUrl ? (
          <a className="live-event-target" href={linkUrl} target="_blank" rel="noopener noreferrer">
            {repo ?? ev.source_id}
            {num ? <span className="live-event-num"> {num}</span> : null}
          </a>
        ) : null}
        {ev.body ? <p className="live-event-body">{ev.body}</p> : null}
        {ev.raw ? (
          <details className="live-event-raw">
            <summary>raw payload</summary>
            <pre>{JSON.stringify(ev.raw, null, 2)}</pre>
          </details>
        ) : null}
      </div>
      {age ? (
        <time
          className="live-event-time"
          title={instant != null ? new Date(instant).toLocaleString() : undefined}
        >
          {age}
        </time>
      ) : null}
    </li>
  );
}

export function LivePage({ serverBaseUrl }: { serverBaseUrl: string | null }) {
  const { events, connected, reconnecting, transport } = useLive(serverBaseUrl);
  // A 1s tick keeps the relative ages ("9s ago") and the rate window live even
  // between event arrivals.
  const [now, setNow] = useState(() => Date.now());
  const [category, setCategory] = useState<string | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const statusKind =
    connected === null
      ? "connecting"
      : connected === false
        ? "down"
        : reconnecting
          ? "reconnecting"
          : "up";

  const rate = countInWindow(events, now, RATE_WINDOW_MS);
  const buckets = rateBuckets(events, now, SPARK_BUCKET_MS, SPARK_BUCKETS);
  const cats = categoryCounts(events, CATEGORY_ORDER);
  const repos = distinctCount(events, eventRepo);
  const people = distinctCount(events, (e) => e.actor?.login);
  const latest = events[0];
  const latestInstant = latest ? eventInstant(latest) : null;
  const shown = category ? events.filter((e) => e.category === category) : events;

  return (
    <div className="live-page">
      <header className="live-header">
        <div className="live-header-main">
          <h1>Live</h1>
          <span className={`live-status live-status-${statusKind}`}>
            <span className="live-status-dot" aria-hidden="true" />
            {statusLabel(connected, reconnecting, transport)}
            {transport ? <span className="live-status-tx">{transport}</span> : null}
          </span>
        </div>
        <p className="live-note">
          Activity appears the moment a webhook arrives. Live can miss events during a
          reconnect — the board&apos;s periodic sync stays the source of truth.
        </p>
      </header>

      <div className="live-pulse">
        <div className="live-card live-card-rate">
          <div className="live-card-label">Activity</div>
          <div className="live-figure">
            {rate}
            <span className="live-unit">/min</span>
          </div>
          <Sparkline values={buckets} />
          <div className="live-card-sub">events per 30s · last 15 min</div>
        </div>
        <div className="live-card">
          <div className="live-card-label">Last event</div>
          <div className="live-figure">
            {latestInstant != null ? `${relativeAge(latestInstant, now)} ago` : "—"}
          </div>
          <div className="live-card-sub">
            {latest ? `${humanizeCategory(latest.category)} · ${shortRepo(eventRepo(latest))}` : "waiting…"}
          </div>
        </div>
        <div className="live-card">
          <div className="live-card-label">Buffer</div>
          <div className="live-figure">
            {events.length}
            <span className="live-unit">/ {MAX_EVENTS}</span>
          </div>
          <div className="live-card-sub">events kept in memory</div>
        </div>
        <div className="live-card">
          <div className="live-card-label">Active now</div>
          <div className="live-figure">
            {repos}
            <span className="live-unit">repos</span>
          </div>
          <div className="live-card-sub">
            {people} {people === 1 ? "person" : "people"} · in this buffer
          </div>
        </div>
      </div>

      {events.length > 0 ? (
        <div className="live-cats" role="group" aria-label="Filter the feed by category">
          <button
            type="button"
            className={`live-cat live-cat-all${category === null ? " live-cat-on" : ""}`}
            aria-pressed={category === null}
            onClick={() => setCategory(null)}
          >
            All<span className="live-cat-n">{events.length}</span>
          </button>
          {cats.map((c) => (
            <button
              key={c.category}
              type="button"
              className={`live-cat${category === c.category ? " live-cat-on" : ""}`}
              style={catStyle(c.category)}
              aria-pressed={category === c.category}
              onClick={() => setCategory((prev) => (prev === c.category ? null : c.category))}
            >
              <span className="live-cat-dot" aria-hidden="true" />
              {humanizeCategory(c.category)}
              <span className="live-cat-n">{c.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {shown.length === 0 ? (
        <p className="empty">
          {connected === false
            ? "Live stream unavailable on this deployment."
            : connected === null
              ? "Connecting…"
              : category
                ? `No ${humanizeCategory(category)} events in the buffer yet.`
                : "Waiting for activity. New pushes, pull requests, reviews and comments appear here the moment they land."}
        </p>
      ) : (
        <ul className="live-feed">
          {shown.map((ev) => (
            <LiveRow key={`${ev.source_id}:${ev.event_id}:${ev.seq}`} ev={ev} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
}
