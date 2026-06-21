// Contract-independent Live tab. Renders the realtime webhook feed from the
// `LiveState` App owns (the `useLive` stream lives at the always-mounted shell so
// the buffer survives tab switches); depends on no loaded contract (it renders
// inside App's live branch, which keeps the shell tab bar so Live switches like
// any other tab).
// Layout is master-detail: a "pulse" strip on top (activity rate + a rolling
// histogram, last-event freshness, buffer depth, who/what is active), a filter
// bar (category pills + multi-select repo / people), then a two-pane split — a
// compact feed on the left (each row a markdown preview clamped to the
// Settings-controlled line count) and the selected event's full markdown body on
// the right. Bodies are rendered as markdown (lazy-loaded, untrusted-safe); the
// feed is labelled best-effort with the board as the source of truth.
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { MAX_EVENTS, type LiveState } from "../useLive.ts";
import { useMediaQuery } from "../useMediaQuery.ts";
import { safeHref } from "../url.ts";
import {
  actorKey,
  bucketRange,
  categoryCounts,
  countInWindow,
  distinctCount,
  distinctValues,
  eventInstant,
  eventMatchesFilters,
  eventRepo,
  humanizeCategory,
  LIVE_CATEGORY_ORDER,
  rateBuckets,
  relativeAge,
  visibleByCategory,
} from "../live-stats.ts";
import { ACTION_KIND } from "../activity-action-style.ts";
import { liveAvatarModel } from "../live-avatar.ts";
import { Badge } from "./Badge.tsx";
import { MultiSelect } from "./MultiSelect.tsx";
import type { LiveEvent, LiveEventActor } from "../model.ts";

// react-markdown + remark-gfm are lazy-loaded so they form their own chunk and
// stay out of the board/graph bundles — only the Live tab pays for them.
const Markdown = lazy(() => import("./Markdown.tsx"));

// Memoized so the 1s relative-time tick (which re-renders the feed) never
// re-parses an unchanged body. Falls back to the plain text while the markdown
// chunk loads, so a row never flashes empty.
const MarkdownBody = memo(function MarkdownBody({ text, className }: { text: string; className?: string }) {
  return (
    <Suspense fallback={<div className={className}><div className="live-md-fallback">{text}</div></div>}>
      <Markdown className={className}>{text}</Markdown>
    </Suspense>
  );
});

const SPARK_BUCKET_MS = 600_000; // one histogram bar per 10 minutes
const SPARK_BUCKETS = 30; // 30 bars → last 5 hours
// The Activity headline counts EVERYTHING in the sparkline's full window (not a
// trailing hour), so the figure summarizes the same span the histogram shows and
// the unit names that span ("/5h"). A trailing-hour rate over-read a recent burst
// and ignored the rest of the visible window.
const SPARK_WINDOW_MS = SPARK_BUCKET_MS * SPARK_BUCKETS; // 5 hours
const SPARK_WINDOW_HOURS = SPARK_WINDOW_MS / 3_600_000; // 5 — drives the "/5h" unit
// Keep this in sync with the CSS breakpoint where .live-detail becomes a fixed
// overlay.
const LIVE_DETAIL_OVERLAY_QUERY = "(max-width: 900px)";

// A custom property carrying an event's category hue; consumers fall back to
// --muted, so an unforeseen category still renders (its var resolves invalid).
const catStyle = (category: string): CSSProperties =>
  ({ "--cat": `var(--cat-${category})` }) as CSSProperties;

const shortRepo = (repo: string | null): string => (repo ? (repo.split("/").pop() ?? repo) : "—");

function liveAction(ev: LiveEvent): string {
  if (ev.category === "commit" && !ev.action) return "committed";
  if (ev.category === "change_request" && ev.action === "closed" && ev.provider_details?.merged === true) return "merged";
  if ((ev.category === "comment" || ev.category === "review_comment") && ev.action === "created") return "commented";
  if (ev.category === "review" && (ev.action === "submitted" || !ev.action)) {
    if (ev.review_state === "approved") return "approved";
    if (ev.review_state === "changes_requested") return "changes_requested";
    if (ev.review_state === "dismissed") return "dismissed";
    return "reviewed";
  }
  return ev.action ?? ev.category;
}

function statusLabel(
  connected: boolean | null,
  reconnecting: boolean,
): string {
  if (connected === null) return "Connecting…";
  if (connected === false) return "Offline";
  // A drop that follows a successful open is transient: EventSource auto-
  // reconnects (poll retries on its own tick), so say so rather than "Live".
  if (reconnecting) return "Reconnecting…";
  return "Streaming";
}

function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function Sparkline({ values, now, bucketMs }: { values: number[]; now: number; bucketMs: number }) {
  // Floor the scale so a quiet feed (a few events) does not paint full-height
  // bars and read as a storm.
  const max = Math.max(4, ...values);
  const count = values.length;
  // The hovered / focused / tapped bar. A native `title` covers desktop hover;
  // this also drives a text readout so touch (no hover) and screen readers get
  // the same window + count.
  const [sel, setSel] = useState<number | null>(null);
  const bucketText = (i: number): string => {
    const { start, end } = bucketRange(now, bucketMs, count, i);
    const n = values[i] ?? 0;
    return `${fmtClock(start)}–${fmtClock(end)} · ${n} ${n === 1 ? "event" : "events"}`;
  };
  const caption = sel != null ? bucketText(sel) : "events per 10m · last 5h";
  // Clear only when leaving the bar that is currently selected (so moving the
  // pointer between bars does not flicker the readout to the default).
  const clearIf = (i: number) => setSel((cur) => (cur === i ? null : cur));
  return (
    <>
      <div
        className="live-spark"
        role="group"
        aria-label="Activity — events per 10 minutes over the last 5 hours; focus a bar for its window"
      >
        {values.map((v, i) => {
          const label = bucketText(i);
          return (
            <button
              key={i}
              type="button"
              className={`live-spark-bar${i === count - 1 ? " live-spark-bar-now" : ""}${sel === i ? " live-spark-bar-sel" : ""}`}
              style={{ height: `${Math.max(6, Math.round((v / max) * 100))}%` }}
              title={label}
              aria-label={label}
              onMouseEnter={() => setSel(i)}
              onMouseLeave={() => clearIf(i)}
              onFocus={() => setSel(i)}
              onBlur={() => clearIf(i)}
              // Tap / Enter / Space SELECTS this bar — never toggles. The button
              // takes focus before the click fires, so onFocus has already set
              // sel=i; a toggle would then read cur===i and immediately clear it,
              // making the first touch/keyboard activation a no-op (#356 review).
              // Clearing is owned by blur / mouseleave.
              onClick={() => setSel(i)}
            />
          );
        })}
      </div>
      <div className="live-card-sub" aria-live="polite">{caption}</div>
    </>
  );
}

// The precise permalink (event url, else the parent target url), scheme-guarded.
function eventLink(ev: LiveEvent): string | null {
  return safeHref(ev.url ?? ev.target?.url);
}
function targetText(ev: LiveEvent): { repo: string; num: string } {
  const repo = eventRepo(ev) ?? ev.source_id;
  const num = ev.target?.number != null ? `#${ev.target.number}` : "";
  return { repo, num };
}

function LiveAvatar({ actor }: { actor: LiveEventActor | null | undefined }) {
  const model = liveAvatarModel(actor);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [model.imageUrl]);
  const body = model.imageUrl && !failed ? (
    <img
      src={model.imageUrl}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  ) : (
    <span className="live-avatar-fallback" aria-hidden="true">{model.initials}</span>
  );
  const className = `live-avatar${model.imageUrl && !failed ? " live-avatar-image" : " live-avatar-text"}`;
  if (!model.profileUrl) {
    return <span className={className} title={model.label} aria-label={model.label}>{body}</span>;
  }
  return (
    <a
      className={className}
      href={model.profileUrl}
      title={model.label}
      aria-label={`Open ${model.label} profile on provider`}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {body}
    </a>
  );
}

function LiveRow({
  ev,
  now,
  previewLines,
  selected,
  onSelect,
}: {
  ev: LiveEvent;
  now: number;
  previewLines: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const instant = eventInstant(ev);
  const age = instant != null ? relativeAge(instant, now) : "";
  const actor = ev.actor?.login ?? "someone";
  const { repo, num } = targetText(ev);
  const action = liveAction(ev);
  const previewRef = useRef<HTMLDivElement>(null);
  const [clamped, setClamped] = useState(false);
  // Fade the preview's bottom edge ONLY when the body actually overflows the
  // clamp. Measured with a ResizeObserver so it re-checks once the lazy markdown
  // finishes loading (and on resize); a short body that fits shows no fade.
  useEffect(() => {
    const el = previewRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setClamped(el.scrollHeight - el.clientHeight > 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ev.body, previewLines]);
  return (
    <li
      className={`live-event${selected ? " live-event-selected" : ""}`}
      data-category={ev.category}
      style={catStyle(ev.category)}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <LiveAvatar actor={ev.actor} />
      <div className="live-event-main">
        <div className="live-event-head">
          <Badge text={action} kind={ACTION_KIND[action] ?? "status-unknown"} />
          <span className="live-event-title">{ev.title ?? `${actor} · ${ev.event_type}`}</span>
        </div>
        <div className="live-event-repo">
          {repo}
          {num ? <span className="live-event-num"> {num}</span> : null}
        </div>
        {ev.body ? (
          <div
            ref={previewRef}
            className={`live-event-preview${clamped ? " is-clamped" : ""}`}
            style={{ "--preview-lines": previewLines } as CSSProperties}
          >
            <MarkdownBody text={ev.body} className="live-md live-md-preview" />
          </div>
        ) : null}
      </div>
      {age ? (
        <time
          className="live-event-time"
          title={instant != null ? new Date(instant).toLocaleString([], { hour12: false }) : undefined}
        >
          {age}
        </time>
      ) : null}
    </li>
  );
}

function LiveDetail({ ev, now, following, onFollowLatest, onClose }: { ev: LiveEvent; now: number; following: boolean; onFollowLatest: () => void; onClose: () => void }) {
  const instant = eventInstant(ev);
  const age = instant != null ? relativeAge(instant, now) : "";
  const actor = ev.actor?.login ?? "someone";
  const { repo, num } = targetText(ev);
  const link = eventLink(ev);
  const action = liveAction(ev);
  return (
    <article className="live-detail-card">
      <button type="button" className="live-detail-back" onClick={onClose}>
        ← Back to feed
      </button>
      <div className="live-mode">
        {following ? (
          <span className="live-mode-following">
            <span className="live-mode-dot" aria-hidden="true" /> Following latest
          </span>
        ) : (
          <button type="button" className="live-mode-release" onClick={onFollowLatest}>
            Pinned · follow latest
          </button>
        )}
      </div>
      <div className="live-detail-head" style={catStyle(ev.category)}>
        <Badge text={action} kind={ACTION_KIND[action] ?? "status-unknown"} />
        {age ? (
          <time title={instant != null ? new Date(instant).toLocaleString([], { hour12: false }) : undefined}>{age} ago</time>
        ) : null}
      </div>
      {/* The link goes on the TITLE (which names the actual event) — its target can
          be a comment permalink, so hanging it off "repo #num" read as wrong. The
          repo + number stays as a plain reference line below. */}
      <h2 className="live-detail-title">
        {link ? (
          <a className="live-detail-title-link" href={link} target="_blank" rel="noopener noreferrer">
            {ev.title ?? `${actor} · ${ev.event_type}`}
            <span className="live-detail-title-arrow" aria-hidden="true"> ↗</span>
          </a>
        ) : (
          (ev.title ?? `${actor} · ${ev.event_type}`)
        )}
      </h2>
      <div className="live-detail-ref">
        {repo}
        {num ? <span className="live-event-num"> {num}</span> : null}
      </div>
      {ev.body ? (
        <MarkdownBody text={ev.body} className="live-md live-detail-body" />
      ) : (
        <p className="muted">This event carries no body.</p>
      )}
      {ev.raw ? (
        <details className="live-event-raw">
          <summary>raw payload</summary>
          <pre>{JSON.stringify(ev.raw, null, 2)}</pre>
        </details>
      ) : null}
    </article>
  );
}

export function LivePage({
  live,
  previewLines,
  hiddenEventTypes,
  detailRouteOpen,
  onOpenDetailRoute,
  onCloseDetailRoute,
  onClearDetailRoute,
}: {
  live: LiveState;
  previewLines: number;
  hiddenEventTypes: ReadonlySet<string>; // Live categories the viewer hid in Settings
  detailRouteOpen: boolean;
  onOpenDetailRoute: () => void;
  onCloseDetailRoute: () => void;
  onClearDetailRoute: () => void;
}) {
  // The stream is owned by App (always mounted) so the buffer persists across tab
  // switches; LivePage only renders it.
  const { events, connected, reconnecting } = live;
  // A 1s tick keeps the relative ages ("9s ago") and the rate window live even
  // between event arrivals.
  const [now, setNow] = useState(() => Date.now());
  const [category, setCategory] = useState<string | null>(null);
  const [repos, setRepos] = useState<Set<string>>(() => new Set());
  const [people, setPeople] = useState<Set<string>>(() => new Set());
  // The explicitly pinned event, or null = auto-follow the newest. Clicking a row
  // pins it (the detail stays put as new events stream in); clicking it again — or
  // the "follow latest" control in the detail — releases back to auto-follow.
  const [pinned, setPinned] = useState<LiveEvent | null>(null);
  const isDetailOverlay = useMediaQuery(LIVE_DETAIL_OVERLAY_QUERY);
  // Drives the NARROW-screen detail overlay; route-backed so Android/browser
  // Back closes detail before leaving the Live tab.
  const detailOpen = isDetailOverlay && detailRouteOpen;
  // Mobile-only: the category pills are collapsed behind a disclosure by default
  // (they're shown inline on desktop). Tap the summary to reveal them.
  const [catsOpen, setCatsOpen] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  // If the viewer hides (in Settings) the very category they had focused, the
  // transient focus would filter the feed to nothing and its chip is gone — clear
  // it so the feed falls back to "all visible".
  useEffect(() => {
    if (category && hiddenEventTypes.has(category)) setCategory(null);
  }, [category, hiddenEventTypes]);

  const statusKind =
    connected === null
      ? "connecting"
      : connected === false
        ? "down"
        : reconnecting
          ? "reconnecting"
          : "up";

  // The pulse cards (Activity, sparkline, Last event, Buffer, Active now) read the
  // RAW stream — they are stream/memory telemetry, so the persistent event-type
  // filter does not touch them (matching how the transient focus filters already
  // leave the pulse alone). The chip strip, the "All" count, the feed, and the
  // filter option lists read `visibleEvents` so hiding a type removes it tab-wide
  // from what you browse.
  const visibleEvents = useMemo(
    () => visibleByCategory(events, hiddenEventTypes),
    [events, hiddenEventTypes],
  );
  const windowTotal = countInWindow(events, now, SPARK_WINDOW_MS);
  const buckets = rateBuckets(events, now, SPARK_BUCKET_MS, SPARK_BUCKETS);
  const cats = useMemo(() => categoryCounts(visibleEvents, LIVE_CATEGORY_ORDER), [visibleEvents]);
  const repoCount = useMemo(() => distinctCount(events, eventRepo), [events]);
  const peopleCount = useMemo(() => distinctCount(events, actorKey), [events]);
  const repoOptions = useMemo(() => distinctValues(visibleEvents, eventRepo), [visibleEvents]);
  const peopleOptions = useMemo(() => distinctValues(visibleEvents, actorKey), [visibleEvents]);
  const latest = events[0];
  const latestInstant = latest ? eventInstant(latest) : null;
  const shown = useMemo(
    () => visibleEvents.filter((e) => eventMatchesFilters(e, { category, repos, people })),
    [visibleEvents, category, repos, people],
  );

  const keyOf = (ev: LiveEvent): string => `${ev.source_id}:${ev.event_id}:${ev.seq}`;
  // The detail shows the pinned event; with nothing pinned it auto-follows the
  // newest matching event, so the right pane updates as new data streams in (and
  // is never empty once an event exists).
  const following = pinned === null;
  const detail = pinned ?? shown[0] ?? null;
  const detailKey = detail ? keyOf(detail) : null;
  const feedRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!isDetailOverlay && detailRouteOpen) onClearDetailRoute();
  }, [detailRouteOpen, isDetailOverlay, onClearDetailRoute]);
  const openDetail = useCallback(() => {
    if (!isDetailOverlay) return;
    if (!detailRouteOpen) onOpenDetailRoute();
  }, [detailRouteOpen, isDetailOverlay, onOpenDetailRoute]);
  const closeDetail = useCallback(() => {
    if (detailRouteOpen) onCloseDetailRoute();
  }, [detailRouteOpen, onCloseDetailRoute]);
  // Releasing the pin resumes auto-follow; bring the newest event (now shown in
  // the detail) back into view at the top of the feed.
  const followLatest = () => {
    setPinned(null);
    feedRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className="live-page">
      <header className="live-header">
        <div className="live-header-main">
          <h1>Live</h1>
          <span className={`live-status live-status-${statusKind}`}>
            {statusLabel(connected, reconnecting)}
          </span>
        </div>
      </header>

      <div className="live-pulse">
        <div className="live-card live-card-rate">
          <div className="live-card-label">Activity</div>
          <div className="live-figure">
            {windowTotal}
            <span className="live-unit">/{SPARK_WINDOW_HOURS}h</span>
          </div>
          <Sparkline values={buckets} now={now} bucketMs={SPARK_BUCKET_MS} />
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
            {repoCount}
            <span className="live-unit">repos</span>
          </div>
          <div className="live-card-sub">
            {peopleCount} {peopleCount === 1 ? "person" : "people"} · in this buffer
          </div>
        </div>
      </div>

      {events.length > 0 ? (
        <div className="live-filters">
          {/* Mobile-only summary: the category pills below collapse behind this on a
              phone (shared filter chrome); desktop hides it and shows the pills inline. */}
          <button
            type="button"
            className="filter-summary-disclosure live-cats-disclosure"
            aria-expanded={catsOpen}
            aria-controls="live-cats-pills"
            onClick={() => setCatsOpen((o) => !o)}
          >
            <span className="filter-summary-disclosure-label">category</span>
            <span className="filter-summary-disclosure-summary">{category === null ? "all" : humanizeCategory(category)}</span>
            <span className="filter-summary-disclosure-caret" aria-hidden="true" />
          </button>
          <div className="live-cats" id="live-cats-pills" data-open={catsOpen ? "true" : "false"} role="group" aria-label="Filter the feed by category">
            <button
              type="button"
              className={`live-cat live-cat-all${category === null ? " live-cat-on" : ""}`}
              aria-pressed={category === null}
              onClick={() => setCategory(null)}
            >
              All<span className="live-cat-n">{visibleEvents.length}</span>
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
          <div className="live-selects">
            <MultiSelect label="Repo" options={repoOptions} selected={repos} onChange={setRepos} />
            <MultiSelect label="People" options={peopleOptions} selected={people} onChange={setPeople} />
          </div>
        </div>
      ) : null}

      {events.length === 0 ? (
        <p className="empty">
          {connected === false
            ? "Live stream unavailable on this deployment."
            : connected === null
              ? "Connecting…"
              : "Waiting for activity. New commits, pull requests, reviews and comments appear here the moment they land."}
        </p>
      ) : (
        <div
          className="live-split"
          data-detail-open={detailOpen ? "true" : "false"}
          onClick={(e) => {
            // Click blank space (not a row, not the detail card) to release the
            // pin and resume auto-following the newest event. The "follow latest"
            // pill in the detail is the keyboard-accessible equivalent.
            if (!pinned) return;
            const el = e.target instanceof Element ? e.target : null;
            if (el && !el.closest(".live-event") && !el.closest(".live-detail-card")) followLatest();
          }}
        >
          {shown.length === 0 ? (
            <p className="empty live-feed-empty">
              {visibleEvents.length === 0
                ? "Every event type is hidden — re-enable some under Settings → Live event types."
                : "No events match these filters."}
            </p>
          ) : (
            <ul className="live-feed" ref={feedRef}>
              {shown.map((ev) => (
                <LiveRow
                  key={keyOf(ev)}
                  ev={ev}
                  now={now}
                  previewLines={previewLines}
                  selected={keyOf(ev) === detailKey}
                  onSelect={() => {
                    // Toggle: click pins this row; click the pinned row again to
                    // release back to auto-follow (and scroll the feed to newest).
                    if (pinned && keyOf(pinned) === keyOf(ev)) followLatest();
                    else {
                      setPinned(ev);
                      openDetail();
                    }
                  }}
                />
              ))}
            </ul>
          )}
          <div className="live-detail">
            {detail ? (
              <LiveDetail
                ev={detail}
                now={now}
                following={following}
                onFollowLatest={followLatest}
                onClose={closeDetail}
              />
            ) : (
              <div className="live-detail-empty">Waiting for the first event…</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
