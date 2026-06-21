// Pure, IO-free rendering of a `live-event/1` record into a Telegram message.
// The live→Telegram bridge (src/cli/live-telegram-bridge.ts) is a read-only
// consumer of the Live SSE stream (GET /api/live): it forwards EVERY event the
// receiver emits, 1:1, with no category filtering — the channel is a faithful
// mirror of what Live captures, kept detailed so an occasional glance carries
// the full context (deeper digging happens in the web UI). Everything here is a
// pure function so the formatting is unit-testable without a socket or a token.
import type { LiveEvent } from "./types.ts";

// Telegram's hard per-message ceiling (sendMessage). We render at most this many
// characters; an over-long body is truncated with an ellipsis marker.
export const TELEGRAM_MESSAGE_LIMIT = 4096;

// Default body preview cap: keep firehose messages short. Beyond this many lines
// the body is cut with a "…" and the reader follows the header link for the rest.
export const MAX_BODY_LINES = 10;

// Escape for Bot API "HTML" parse_mode. We send arbitrary provider text
// (issue/PR/comment bodies, and URLs inside href attributes) so every
// interpolated field is escaped — the message structure is the only markup.
// The double-quote escape is load-bearing: a URL is placed inside
// `<a href="...">`, so an unescaped `"` in a crafted URL would break out of the
// attribute (HTML injection / a 400 that poisons the whole message).
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Slice already-escaped HTML to a length WITHOUT leaving a half-written entity
// (e.g. "&am" or "&quot") at the cut: Telegram rejects a truncated entity with
// a 400 that drops the entire message. Our entities are &amp; &lt; &gt; &quot;
// (≤5 chars after the `&`), so a trailing `&` + up-to-5 letters with no closing
// `;` is a partial entity and is dropped; a complete entity ends in `;` and is
// preserved.
export function clampHtml(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit).replace(/&[a-z]{0,5}$/i, "");
}

// A glyph per neutral category (open vocabulary: an unknown category still
// renders with the default rather than dropping the event).
const CATEGORY_EMOJI: Record<string, string> = {
  issue: "📌",
  change_request: "🔀",
  comment: "💬",
  review: "🔍",
  review_comment: "💬",
  review_thread: "🧵",
  push: "⬆️",
  pipeline: "⚙️",
};

export function eventEmoji(event: LiveEvent): string {
  return CATEGORY_EMOJI[event.category] ?? "📣";
}

// A merged PR/MR arrives as action "closed" + a `merged` flag in the curated
// provider details; surface "merged" so the firehose does not mislabel it as a
// plain close. Otherwise the provider action is shown verbatim.
function effectiveAction(event: LiveEvent): string | null {
  const merged = event.provider_details?.["merged"];
  if (event.category === "change_request" && event.action === "closed" && merged === true) {
    return "merged";
  }
  return event.action ?? null;
}

// Repo/grouping label: the per-repo bucket when present, else the source id.
function repoLabel(event: LiveEvent): string {
  return event.target?.project_path ?? event.source_id;
}

function actorLabel(event: LiveEvent): string | null {
  const actor = event.actor;
  if (!actor) return null;
  return actor.display_name ?? actor.login ?? null;
}

function numberLabel(event: LiveEvent): string | null {
  const n = event.target?.number;
  if (n === null || n === undefined) return null;
  return `#${n}`;
}

// Render one event into a Telegram-ready HTML message (parse_mode: HTML). Pure
// and total: tolerates any nullable field. The header carries actor/category/
// action/number, an optional linked title, a meta line, then the full body
// (escaped), with the whole message capped at TELEGRAM_MESSAGE_LIMIT.
export function formatLiveEvent(event: LiveEvent, bodyLines = MAX_BODY_LINES): string {
  const repo = escapeHtml(repoLabel(event));
  const action = effectiveAction(event);
  const num = numberLabel(event);
  const headerBits = [event.category, action].filter(Boolean).join(" ");
  const header =
    `${eventEmoji(event)} <b>${repo}</b> · ${escapeHtml(headerBits)}` +
    (num ? ` ${escapeHtml(num)}` : "");

  // Linked title: prefer the work-item title, fall back to the event summary.
  // A commit is the exception: its target.title is the bare subject, while the
  // event title is the disambiguating "<author> committed <short-sha>". Prefer
  // the event title for commits so repeated/generic subjects keep their SHA in
  // the mirror instead of collapsing to indistinguishable lines.
  const titleText =
    event.category === "commit"
      ? (event.title ?? event.target?.title ?? null)
      : (event.target?.title ?? event.title ?? null);
  // Prefer the event's own permalink (e.g. a comment/review anchor) over the
  // parent target URL, so the link points at the specific activity being
  // mirrored — same precedence the UI's eventLink uses. Fall back to target.url.
  const url = event.url ?? event.target?.url ?? null;
  let titleLine = "";
  if (titleText) {
    const safeTitle = escapeHtml(titleText);
    titleLine = url
      ? `\n<a href="${escapeHtml(url)}">${safeTitle}</a>`
      : `\n${safeTitle}`;
  } else if (url) {
    titleLine = `\n${escapeHtml(url)}`;
  }

  const actor = actorLabel(event);
  const when = event.occurred_at ?? event.received_at;
  const metaBits = [
    actor ? `👤 ${escapeHtml(actor)}` : null,
    when ? `🕒 ${escapeHtml(when)}` : null,
  ].filter(Boolean);
  const metaLine = metaBits.length ? `\n${metaBits.join(" · ")}` : "";

  const head = header + titleLine + metaLine;

  // Append a SHORT body preview — at most MAX_BODY_LINES lines, still under the
  // message ceiling. The header already links the item, so a truncated body
  // ends with "…" and the reader clicks through for the full content.
  const rawBody = event.body?.trim();
  if (!rawBody) return head;

  const ELLIPSIS = "\n…";
  const room = TELEGRAM_MESSAGE_LIMIT - head.length - 2; // 2 for the "\n\n" gap
  if (room <= ELLIPSIS.length) return head;

  const lineCap = Number.isInteger(bodyLines) && bodyLines > 0 ? bodyLines : MAX_BODY_LINES;
  const lines = rawBody.split("\n");
  let truncated = lines.length > lineCap;
  let escapedBody = escapeHtml(lines.slice(0, lineCap).join("\n"));
  if (escapedBody.length > room - ELLIPSIS.length) {
    escapedBody = clampHtml(escapedBody, room - ELLIPSIS.length);
    truncated = true;
  }
  return `${head}\n\n${escapedBody}${truncated ? ELLIPSIS : ""}`;
}
