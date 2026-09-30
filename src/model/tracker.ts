// Program tracker phase table -> rows -> `parent` / `blocks` edges.
//
// A program tracker is an issue whose body has a `## Phase table` section with
// at least one valid row. The row grammar is normative in `agent-runtime-kit`
// (`core/skills/issue/issue-follow-up/references/tracker-row-grammar.md`) and
// its conformance corpus is vendored under test/fixtures/tracker-row-grammar/.
//
// This is a lenient CONSUMER of that grammar, not a linter: it never throws, a
// malformed row contributes nothing, and it reports no findings. Provider
// neutral and pure (no network/IO) — a source resolves row refs during `fetch`
// and hands the result to `trackerEdges` from its pure `normalize`.

import type { CanonicalEdge, ItemEndpoint, ItemState } from "./types.ts";

// `owner/repo#N`; `owner` and `repo` are both null for `#N`, which names the
// tracker's own repository.
export interface TrackerRef {
  owner: string | null;
  repo: string | null;
  number: number;
}

// One phase-table row. A row without a ref is a GATE (a release, a deploy, a
// decision) — it takes part in the dependency order but is no item.
export interface TrackerRow {
  id: string;
  title: string;
  ref: TrackerRef | null;
  notes: string | null;
  after: string[];
  done: boolean;
  phase: string | null;
}

// An upper-case ASCII letter, then ASCII letters or digits. Anything else in
// the bold token, or in an `after` list, makes the row malformed.
const ID = "[A-Z][A-Za-z0-9]*";
const NAME = "[A-Za-z0-9._-]+";
// `s` (dotAll) so that `.` spans anything left on a line: lines are split on
// line feeds only, and a title may contain any other character.
const ROW = new RegExp(`^- \\[([ xX])\\] \\*\\*(${ID})\\*\\*( .*)$`, "s");
// Greedy head: the LAST ` · after` (the mark is U+00B7 MIDDLE DOT) that is
// followed by a space or ends the line.
const AFTER = /^(.*) · after(?: (.*))?$/s;
const AFTER_LIST = new RegExp(`^${ID}(?:[ \\t]*,[ \\t]*${ID})*$`);
// One to fifteen digits, no leading zero; a longer number is not a ref.
const REF = new RegExp(`^(.*): (?:(${NAME})/(${NAME}))?#([1-9][0-9]{0,14})$`, "s");
const ROW_MARKS = ["- [ ]", "- [x]", "- [X]"];

// Hard bounds on what ONE tracker may produce. A body is text that anyone who
// can write an issue in a tracked repository controls, and gate contraction
// multiplies: K issue rows, one gate after all of them, and D rows after that
// gate is K x D `blocks` edges — over a million from a single 64 KB body, each
// one a store row and a contract entry on every sweep. Real trackers are tens
// of rows, so the bounds sit far above them. Both cut in table order and
// silently: this is a consumer, not a linter.
//
// Rows of a phase table that are read; later rows contribute nothing.
export const TRACKER_MAX_ROWS = 500;
// `blocks` edges one tracker emits; later dependencies contribute nothing.
export const TRACKER_MAX_BLOCKS_EDGES = 1000;

// The grammar's only whitespace is space and tab (plus a carriage return at a
// line end). `String.prototype.trim` would also eat a no-break space, which the
// grammar keeps as title text. Plain scans, not `/[ \t]+$/`: that regex is
// quadratic on a long blank run that does not end the text, and every issue
// body of every sweep passes through here.
function trimBlanks(text: string, lineEnd: boolean): string {
  const blank = (c: string | undefined): boolean => c === " " || c === "\t" || (lineEnd && c === "\r");
  let end = text.length;
  while (end > 0 && blank(text[end - 1])) end--;
  let start = 0;
  while (!lineEnd && start < end && blank(text[start])) start++;
  return text.slice(start, end);
}
const trim = (text: string): string => trimBlanks(text, false);
const asciiLower = (text: string): string => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

function parseRow(line: string): Omit<TrackerRow, "phase"> | null {
  const row = ROW.exec(line);
  if (!row) return null;
  let text = row[3]!;
  let after: string[] = [];

  // Parsed right to left so a title may contain anything: dependencies, then
  // notes, then the ref.
  const clause = AFTER.exec(text);
  if (clause) {
    const listed = trim(clause[2] ?? "");
    if (!AFTER_LIST.test(listed)) return null;
    after = listed.split(",").map(trim);
    if (new Set(after).size !== after.length) return null;
    text = clause[1]!;
  }
  text = trim(text);

  let notes: string | null = null;
  if (text.endsWith(")")) {
    let depth = 0;
    let opening = -1;
    for (let i = text.length - 1; i >= 0; i--) {
      if (text[i] === ")") depth++;
      else if (text[i] === "(") depth--;
      if (depth === 0) {
        opening = i;
        break;
      }
    }
    const inner = opening < 0 ? "" : trim(text.slice(opening + 1, -1));
    if (opening > 0 && text[opening - 1] === " " && inner) {
      notes = inner;
      text = trim(text.slice(0, opening));
    }
  }

  let ref: TrackerRef | null = null;
  const target = REF.exec(text);
  if (target) {
    text = trim(target[1]!);
    ref = { owner: target[2] ?? null, repo: target[3] ?? null, number: Number(target[4]) };
  }
  if (!text) return null;
  return { id: row[2]!, title: text, ref, notes, after, done: row[1] !== " " };
}

// The rows of a tracker body, in table order, up to TRACKER_MAX_ROWS. Anything
// that is not text, has no phase table, or has no valid row yields `[]` — so
// "is this a tracker?" is `parseTrackerRows(body).length > 0`.
export function parseTrackerRows(body: unknown): TrackerRow[] {
  if (typeof body !== "string") return [];
  const rows: TrackerRow[] = [];
  let inTable = false;
  let phase: string | null = null;
  for (const raw of body.split("\n")) {
    const line = trimBlanks(raw, true);
    if (!inTable) {
      // Only the first `## Phase table` section is read.
      inTable = asciiLower(line) === "## phase table";
      continue;
    }
    if (line.startsWith("## ")) break;
    if (line.startsWith("### ")) {
      phase = trim(line.slice(4)) || phase;
    } else if (ROW_MARKS.some((mark) => line.startsWith(mark))) {
      const row = parseRow(line);
      if (row && rows.push({ ...row, phase }) === TRACKER_MAX_ROWS) break;
    }
  }
  return rows;
}

// The canonical text of a row ref, `owner/repo#N`, with `#N` resolved against
// the tracker's own repository. A source keys its resolved-ref map by this, so
// the impure lookup and the pure normalizer agree on one spelling. Null when an
// own-repository ref has no repository to resolve against.
export function trackerRefKey(ref: TrackerRef, ownProject: string | null): string | null {
  const project = ref.owner !== null && ref.repo !== null ? `${ref.owner}/${ref.repo}` : ownProject;
  return project ? `${project}#${ref.number}` : null;
}

// What a source resolved a row ref to: the target's immutable id and its state
// at lookup time (null when the source did not report one).
export interface TrackerTarget {
  externalId: string;
  state: ItemState | null;
}

// The edges a tracker reports, in table order:
//   parent : tracker -> each row's issue
//   blocks : prerequisite row's issue -> dependent row's issue, per ` · after`
// One canonical direction only (never `child` / `blocked_by`), both endpoints in
// the tracker's source. `resolve` returns null for a ref the source could not
// resolve; such a row produces no edge.
//
// GATES ARE CONTRACTED: a dependency on a gate becomes a dependency on that
// gate's own prerequisites, transitively, so the issues on either side of a
// release stay ordered. A gate as the dependent emits nothing itself. Unknown
// ids are ignored, an id used twice means its first row, and self-edges (two
// rows of one issue included) and repeats are dropped.
//
// At most TRACKER_MAX_BLOCKS_EDGES `blocks` edges are emitted: the first ones
// in table order, then none. `parent` edges are one per row at most and are
// not cut.
export function trackerEdges(
  rows: readonly TrackerRow[],
  tracker: ItemEndpoint,
  trackerState: ItemState | null,
  resolve: (ref: TrackerRef) => TrackerTarget | null,
): CanonicalEdge[] {
  const byId = new Map<string, TrackerRow>();
  for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row);

  // Each row's ref is resolved once, however many dependents reach it.
  const targets = new Map<TrackerRow, TrackerTarget | null>();
  const targetOf = (row: TrackerRow): TrackerTarget | null => {
    let target = targets.get(row);
    if (target === undefined) {
      target = row.ref ? resolve(row.ref) : null;
      targets.set(row, target);
    }
    return target;
  };

  // The issue rows a row waits on, looking through gates, each once and in
  // first-reached order. `gates` holds the gates already expanded for this
  // dependent, which is what ends a gate cycle; `out` being a set keeps many
  // gates over the same rows from repeating them.
  const prerequisites = (row: TrackerRow, gates: Set<TrackerRow>, out: Set<TrackerRow>): Set<TrackerRow> => {
    for (const id of row.after) {
      const dep = byId.get(id);
      if (!dep) continue;
      if (dep.ref !== null) out.add(dep);
      else if (!gates.has(dep)) prerequisites(dep, gates.add(dep), out);
    }
    return out;
  };

  const edges: CanonicalEdge[] = [];
  const seen = new Set<string>();
  const push = (type: "parent" | "blocks", from: string, fromState: ItemState | null, to: TrackerTarget): boolean => {
    const key = JSON.stringify([type, from, to.externalId]);
    if (from === to.externalId || seen.has(key)) return false;
    seen.add(key);
    edges.push({
      type,
      from: { sourceId: tracker.sourceId, externalId: from },
      to: { sourceId: tracker.sourceId, externalId: to.externalId },
      fromState,
      toState: to.state,
    });
    return true;
  };

  let blocks = 0;
  for (const row of rows) {
    const target = targetOf(row);
    if (!target) continue;
    push("parent", tracker.externalId, trackerState, target);
    // Once the bound is reached no later row is expanded at all.
    if (blocks >= TRACKER_MAX_BLOCKS_EDGES) continue;
    for (const dep of prerequisites(row, new Set(), new Set())) {
      const blocker = targetOf(dep);
      if (blocker && push("blocks", blocker.externalId, blocker.state, target) && ++blocks >= TRACKER_MAX_BLOCKS_EDGES) break;
    }
  }
  return edges;
}
