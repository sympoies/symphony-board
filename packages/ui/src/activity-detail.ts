import type { ActivityDTO, ItemDTO, ReviewThreadDTO } from "@symphony-board/contract";
import { activityKey, reviewThreadsLabel } from "./model.ts";

// What the Activity page says about ONE event: the compact list row and the
// detail pane. Pure, over the rows and items the page already holds, so it is
// testable without a DOM and can never disagree with the feed beside it.
//
// The contract carries little per event beyond its kind, action, target and an
// open `details` object. What makes a row worth reading is the item it is
// about (title, state, labels; contract 4.9.1 named it for comment rows too),
// and, for a few kinds, one fact of their own: a review's verdict, a review
// comment's file and line, a commit's line counts, a push's from -> to.

export type ActivityRowState = ItemDTO["state"] | "draft";

export interface ActivityRowView {
  // "#36" for an issue / GitHub PR, "!12" for a GitLab merge request, a short
  // sha for a commit; null when the event has no handle of its own.
  label: string | null;
  // The headline: the target's title, the commit subject, "branch main".
  title: string;
  // The target item's current state, when it is loaded. An open draft reads
  // as draft.
  state: ActivityRowState | null;
  // A review's verdict in words.
  verdict: string | null;
  // A commit's line counts, or `merge` for a merge commit (no counts by design).
  diff: { additions: number; deletions: number } | null;
  merge: boolean;
  // Short facts for the meta line: path:line, reply, a branch, from -> to.
  chips: string[];
  // What the row's copy control copies.
  copy: { value: string; label: string } | null;
}

const VERDICTS: Record<string, string> = {
  approved: "approved",
  changes_requested: "changes requested",
  reviewed: "commented",
  dismissed: "dismissed",
};

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function detail(a: ActivityDTO, key: string): unknown {
  return a.details && typeof a.details === "object" ? a.details[key] : undefined;
}

export function detailText(a: ActivityDTO, key: string): string | null {
  return cleanText(detail(a, key));
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

// A review comment's line, when the producer wrote a whole one.
export function detailLine(a: ActivityDTO): number | null {
  return count(detail(a, "line"));
}

function shortSha(sha: string | null): string | null {
  if (!sha) return null;
  return sha.length > 8 ? sha.slice(0, 8) : sha;
}

// An all-zero sha is a ref that did not exist on that side of the push.
export function realSha(sha: string | null): string | null {
  return sha && !/^0+$/.test(sha) ? sha : null;
}

function shortRef(ref: string | null): string | null {
  return ref ? ref.replace(/^refs\/heads\//, "").replace(/^refs\/tags\//, "") : null;
}

const WORK_ITEM_KINDS = new Set(["issue", "change_request"]);
const REF_KINDS = new Set(["branch", "tag", "push", "repository"]);

function isCommit(a: ActivityDTO): boolean {
  return a.kind === "commit" || a.target_kind === "commit";
}

function isRefEvent(a: ActivityDTO): boolean {
  return REF_KINDS.has(a.kind) || REF_KINDS.has(a.target_kind ?? "");
}

// The item an event is about, by ref: its own target, or for a commit the
// change request it belongs to (contract 4.8.2).
export function activityTargetRef(a: ActivityDTO): string | null {
  if (a.target_ref) return a.target_ref;
  if (isCommit(a)) {
    const link = detail(a, "change_request") as { ref?: unknown } | null | undefined;
    return typeof link?.ref === "string" && link.ref.length > 0 ? link.ref : null;
  }
  return null;
}

export function activityTargetItem(a: ActivityDTO, itemsById: ReadonlyMap<string, ItemDTO> | undefined): ItemDTO | undefined {
  const ref = activityTargetRef(a);
  return ref ? itemsById?.get(ref) : undefined;
}

// The kind of work item the event points at: the loaded item's, else the row's
// own target or kind when that names one.
function workItemKind(a: ActivityDTO, item: ItemDTO | undefined): "issue" | "change_request" | null {
  if (item) return item.kind === "change_request" ? "change_request" : "issue";
  if (isCommit(a)) return null;
  if (WORK_ITEM_KINDS.has(a.target_kind ?? "")) return a.target_kind as "issue" | "change_request";
  if (WORK_ITEM_KINDS.has(a.kind)) return a.kind as "issue" | "change_request";
  // A GitLab note names its target kind "comment"; its URL says which.
  if (a.kind === "comment" && a.url) {
    if (a.url.includes("/merge_requests/")) return "change_request";
    if (a.url.includes("/issues/")) return "issue";
  }
  return null;
}

// "#36" / "!12": GitLab writes a merge request as !N, everything else as #N.
export function workItemLabel(kind: "issue" | "change_request", iid: number, providerKind: string | undefined): string {
  return `${kind === "change_request" && providerKind === "gitlab" ? "!" : "#"}${iid}`;
}

export function itemRowState(item: ItemDTO | undefined): ActivityRowState | null {
  if (!item) return null;
  return item.state === "open" && item.is_draft === true ? "draft" : item.state;
}

export function activityRowView(a: ActivityDTO, item: ItemDTO | undefined, providerKind: string | undefined): ActivityRowView {
  const chips: string[] = [];
  const verdict = a.kind === "review" ? (VERDICTS[a.action] ?? a.action.replace(/_/g, " ")) : null;

  if (isCommit(a)) {
    const sha = detailText(a, "sha");
    const branch = detailText(a, "branch");
    if (branch) chips.push(branch);
    const additions = count(detail(a, "additions"));
    const deletions = count(detail(a, "deletions"));
    return {
      label: shortSha(sha),
      title: cleanText(a.title) ?? detailText(a, "message") ?? "commit",
      state: null,
      verdict: null,
      diff: additions !== null && deletions !== null ? { additions, deletions } : null,
      merge: detail(a, "merge") === true,
      chips,
      copy: sha ? { value: sha, label: "commit hash" } : null,
    };
  }

  const kind = workItemKind(a, item);
  if (kind) {
    const iid = item?.iid ?? a.target_iid;
    const path = detailText(a, "path");
    if (path) {
      const line = detailLine(a);
      chips.push(line !== null ? `${path}:${line}` : path);
    }
    if (detail(a, "in_reply_to_id") != null) chips.push("reply");
    // A review row says whether its change request's threads are resolved now.
    if (a.kind === "review") {
      const threads = reviewThreadsLabel(item?.review_threads);
      if (threads) chips.push(threads);
    }
    return {
      label: iid != null ? workItemLabel(kind, iid, providerKind) : null,
      title: cleanText(item?.title) ?? cleanText(a.title) ?? (kind === "change_request" ? "change request" : "issue"),
      state: itemRowState(item),
      verdict,
      diff: null,
      merge: false,
      chips,
      copy: null,
    };
  }

  if (isRefEvent(a)) {
    const rawRef = detailText(a, "ref");
    const ref = shortRef(rawRef) ?? cleanText(a.title);
    const refKind = a.kind === "tag" || a.target_kind === "tag" || rawRef?.startsWith("refs/tags/") ? "tag" : a.kind === "repository" ? "repository" : "branch";
    const from = realSha(detailText(a, "before") ?? detailText(a, "commit_from"));
    const to = realSha(detailText(a, "after") ?? detailText(a, "commit_to"));
    if (from && to) chips.push(`${shortSha(from)} → ${shortSha(to)}`);
    else if (to) chips.push(`→ ${shortSha(to)}`);
    else if (from) chips.push(`${shortSha(from)} →`);
    return {
      label: null,
      title: ref ? `${refKind} ${ref}` : `${a.action.replace(/_/g, " ")} ${a.kind}`,
      state: null,
      verdict: null,
      diff: null,
      merge: false,
      chips,
      copy: to ? { value: to, label: "head commit" } : null,
    };
  }

  return {
    label: null,
    title: cleanText(a.title) ?? `${a.action.replace(/_/g, " ")} ${a.kind.replace(/_/g, " ")}`,
    state: null,
    verdict,
    diff: null,
    merge: false,
    chips,
    copy: null,
  };
}

// --- comment excerpts ---------------------------------------------------------
//
// The contract deliberately carries no comment text on activity rows. The only
// comment words it does carry are review-thread comments (`review_threads[]`),
// which the Reviews page already shows. A comment row whose comment IS one of
// those may quote it; any other comment (an issue comment, a plain PR
// conversation comment) shows no text, because the board shows it nowhere.

export const COMMENT_EXCERPT_CHARS = 600;

export interface CommentExcerpt {
  body: string;
  truncated: boolean;
  author: string | null;
  path: string | null;
  line: number | null;
  resolved: boolean;
  threadUrl: string | null;
}

export type CommentExcerptIndex = ReadonlyMap<string, { thread: ReviewThreadDTO; comment: ReviewThreadDTO["comments"][number] }>;

function excerptKey(sourceId: string, commentId: string): string {
  return `${sourceId}\u0000${commentId}`;
}

export function commentExcerptIndex(threads: readonly ReviewThreadDTO[] | null | undefined): CommentExcerptIndex {
  const index = new Map<string, { thread: ReviewThreadDTO; comment: ReviewThreadDTO["comments"][number] }>();
  for (const thread of threads ?? []) {
    for (const comment of thread.comments) index.set(excerptKey(thread.source_id, comment.id), { thread, comment });
  }
  return index;
}

// The comment id a row names: a GitHub comment's GraphQL node id (the same id
// a review-thread comment carries), else a GitLab note's `#note_<id>` anchor.
function commentIdOf(a: ActivityDTO): string | null {
  const nodeId = detailText(a, "node_id");
  if (nodeId) return nodeId;
  const anchor = a.url ? /#note_(\d+)$/.exec(a.url) : null;
  return anchor ? anchor[1]! : null;
}

export function commentExcerptOf(a: ActivityDTO, index: CommentExcerptIndex): CommentExcerpt | null {
  if (a.kind !== "comment") return null;
  const id = commentIdOf(a);
  const hit = id ? index.get(excerptKey(a.source_id, id)) : undefined;
  if (!hit) return null;
  const text = textExcerpt(hit.comment.body, COMMENT_EXCERPT_CHARS);
  if (!text) return null;
  return {
    body: text.text,
    truncated: text.truncated,
    author: hit.comment.author,
    path: hit.thread.path,
    line: hit.thread.line,
    resolved: hit.thread.is_resolved,
    threadUrl: hit.comment.url ?? hit.thread.url,
  };
}

// Trimmed text capped at `max` characters, cut back to the last word boundary
// when there is one in the second half; null when there is nothing to show.
export function textExcerpt(text: string | null | undefined, max: number): { text: string; truncated: boolean } | null {
  const trimmed = cleanText(text);
  if (!trimmed) return null;
  if (trimmed.length <= max) return { text: trimmed, truncated: false };
  const cut = trimmed.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return { text: (space > max / 2 ? cut.slice(0, space) : cut).trimEnd(), truncated: true };
}

// --- related rows -------------------------------------------------------------

// The other loaded rows about the same item, newest first: the item's thread
// as this range saw it (opened, comments, reviews, commits, merged).
export function eventsOnTarget(activities: readonly ActivityDTO[], a: ActivityDTO, limit: number): { rows: ActivityDTO[]; total: number } {
  const ref = activityTargetRef(a);
  if (!ref) return { rows: [], total: 0 };
  const others = activities.filter((row) => row !== a && !(row.source_id === a.source_id && row.external_id === a.external_id) && activityTargetRef(row) === ref);
  others.sort((x, y) => Date.parse(y.occurred_at) - Date.parse(x.occurred_at));
  return { rows: others.slice(0, limit), total: others.length };
}

// The loaded commit a push moved its ref to, so the detail can name it.
export function pushHeadCommit(activities: readonly ActivityDTO[], a: ActivityDTO): ActivityDTO | undefined {
  if (!isRefEvent(a)) return undefined;
  const to = realSha(detailText(a, "after") ?? detailText(a, "commit_to"));
  if (!to) return undefined;
  return activities.find((row) => isCommit(row) && row.source_id === a.source_id && detailText(row, "sha") === to);
}

// --- selection ----------------------------------------------------------------
//
// The detail pane follows the newest row, is pinned to one row by its key, or is
// closed. The page holds the mode; these are its rules, kept here so they are
// tested rather than buried in the component.

export type ActivityDetailMode = { kind: "closed" } | { kind: "following" } | { kind: "pinned"; key: string };

export function selectedActivity(activities: readonly ActivityDTO[], mode: ActivityDetailMode): ActivityDTO | null {
  if (mode.kind === "following") return activities[0] ?? null;
  if (mode.kind === "pinned") return activities.find((a) => activityKey(a) === mode.key) ?? null;
  return null;
}

// A pin whose row a filter or a reload removed falls back to following the
// newest row on a wide screen, or closes when nothing is left to follow. In the
// reader it closes: a reader that swapped to another event would show
// something the viewer never opened.
export function reconcileDetailMode(mode: ActivityDetailMode, activities: readonly ActivityDTO[], readerMode = false): ActivityDetailMode {
  if (mode.kind !== "pinned" || selectedActivity(activities, mode)) return mode;
  return activities.length > 0 && !readerMode ? { kind: "following" } : { kind: "closed" };
}

// Where the pane starts. A wide screen opens on the newest row, PINNED: an
// in-place reload (a sync, a refresh) must not swap the event under someone
// reading it, so following is the reader's choice, as on Commits. The reader
// tier starts closed and opens on a tap.
export function initialDetailMode(activities: readonly ActivityDTO[], readerMode: boolean): ActivityDetailMode {
  if (readerMode) return { kind: "closed" };
  const newest = activities[0];
  return newest ? { kind: "pinned", key: activityKey(newest) } : { kind: "following" };
}

// A click on a wide screen: the pinned row closes the pane, any other row pins.
export function modeAfterRowClick(mode: ActivityDetailMode, key: string, selectedKey: string | null): ActivityDetailMode {
  return mode.kind === "pinned" && key === selectedKey ? { kind: "closed" } : { kind: "pinned", key };
}

// The reader's route flag outlives it only by mistake: leaving the reader tier
// (a wider window) or losing the selection must clear it, or Back would reopen
// nothing and the flag would sit in a shared link.
export function shouldClearDetailRoute(routeOpen: boolean, readerMode: boolean, hasSelection: boolean): boolean {
  return routeOpen && (!readerMode || !hasSelection);
}
