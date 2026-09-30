import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {
  TRACKER_MAX_BLOCKS_EDGES,
  TRACKER_MAX_ROWS,
  parseTrackerRows,
  trackerEdges,
  trackerRefKey,
  type TrackerRef,
  type TrackerRow,
  type TrackerTarget,
} from "../src/model/tracker.ts";
import type { CanonicalEdge, ItemState } from "../src/model/types.ts";

// The corpus under test/fixtures/tracker-row-grammar/ is vendored unchanged from
// agent-runtime-kit (see its README). Bodies are read as bytes and decoded as
// UTF-8, never through a text-mode helper: two rows depend on a U+00A0 and one
// on a literal tab.
const CORPUS = new URL("./fixtures/tracker-row-grammar/", import.meta.url);

function fixtures(kind: "valid" | "invalid"): string[] {
  return readdirSync(new URL(`${kind}/`, CORPUS))
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -".md".length))
    .sort();
}

function body(kind: string, stem: string): string {
  return readFileSync(new URL(`${kind}/${stem}.md`, CORPUS)).toString("utf8");
}

function expectation(kind: string, stem: string): any {
  return JSON.parse(readFileSync(new URL(`${kind}/${stem}.json`, CORPUS), "utf8"));
}

test("the tracker row parser reproduces the rows of every valid corpus body", () => {
  const stems = fixtures("valid");
  assert.ok(stems.length >= 5, "the vendored corpus is present");
  for (const stem of stems) {
    assert.deepEqual(parseTrackerRows(body("valid", stem)), expectation("valid", stem).rows, `valid/${stem}.md`);
  }
});

test("the tracker row parser never throws on the invalid corpus and drops malformed rows", () => {
  const stems = fixtures("invalid");
  assert.ok(stems.length >= 10, "the vendored corpus is present");
  let malformedLines = 0;
  for (const stem of stems) {
    const text = body("invalid", stem);
    let rows: TrackerRow[] = [];
    assert.doesNotThrow(() => {
      rows = parseTrackerRows(text);
    }, `invalid/${stem}.md`);
    const lines = text.split("\n");
    const malformed = new Set<number>(
      expectation("invalid", stem)
        .findings.filter((f: any) => f.code === "malformed-row")
        .map((f: any) => f.line),
    );
    malformedLines += malformed.size;
    // Every row line of the phase table is either reported malformed or parsed:
    // the parsed rows are exactly the row lines the expectation does not mark.
    const phaseTable = lines.findIndex((line) => line.toLowerCase() === "## phase table");
    let wellFormed = 0;
    for (let i = phaseTable + 1; phaseTable >= 0 && i < lines.length && !lines[i]!.startsWith("## "); i++) {
      if (/^- \[[ xX]\]/.test(lines[i]!) && !malformed.has(i + 1)) wellFormed++;
    }
    assert.equal(rows.length, wellFormed, `invalid/${stem}.md keeps only its well-formed rows`);
  }
  assert.ok(malformedLines >= 16, "the corpus exercises malformed rows");
  assert.deepEqual(
    parseTrackerRows(body("invalid", "malformed-row")).map((row) => row.id),
    ["A1"],
    "only the one valid row of malformed-row.md survives",
  );
});

test("the tracker row parser tolerates non-text bodies and removes line-end whitespace itself", () => {
  for (const input of [null, undefined, 42, {}, ""]) assert.deepEqual(parseTrackerRows(input), []);
  // The corpus cannot carry a carriage return or trailing blanks (see its README).
  const rows = parseTrackerRows("## Phase table\r\n\r\n### Phase 1 \t\r\n- [x] **A** First: o/r#1 (PR #2) \t\r\n- [ ] **B** Gate · after A\r\n");
  assert.deepEqual(rows, [
    { id: "A", title: "First", ref: { owner: "o", repo: "r", number: 1 }, notes: "PR #2", after: [], done: true, phase: "Phase 1" },
    { id: "B", title: "Gate", ref: null, notes: null, after: ["A"], done: false, phase: "Phase 1" },
  ]);
});

test("the tracker row parser stays linear on a long run of blanks", () => {
  // Every issue body of every sweep goes through the parser, in fetch and in
  // normalize. A blank run that does not end its line is the quadratic case of
  // a regex trim: seconds for one 65k-character body, against about a
  // millisecond when trimming is a plain scan.
  const blanks = " ".repeat(65_000);
  const started = performance.now();
  assert.deepEqual(parseTrackerRows(`${blanks}x\n## Phase table\n- [ ] **A** First: #1`).map((row) => row.id), ["A"]);
  const padded = parseTrackerRows(`## Phase table\n### ${blanks}Phase${blanks}\n- [ ] **A** ${blanks}x: #1 · after${blanks}A`);
  assert.deepEqual(padded, [
    { id: "A", title: "x", ref: { owner: null, repo: null, number: 1 }, notes: null, after: ["A"], done: false, phase: "Phase" },
  ]);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1000, `parsing two 65k-blank bodies took ${Math.round(elapsed)}ms`);
});

test("a row id starts with an upper-case ASCII letter, in the bold token and in an after list", () => {
  const rows = parseTrackerRows(
    [
      "## Phase table",
      "- [ ] **A** Upper-case id: #1",
      "- [ ] **a** Lower-case id is malformed: #2",
      "- [ ] **b2** Lower-case id is malformed: #3",
      "- [ ] **Ab9** Later characters may be lower-case or digits: #4 · after A",
      "- [ ] **C** A lower-case token in the list makes the row malformed: #5 · after A, a",
      "- [ ] **D** So does a lone lower-case token: #6 · after end",
    ].join("\n"),
  );
  assert.deepEqual(rows.map((row) => row.id), ["A", "Ab9"]);
  assert.deepEqual(rows[1]!.after, ["A"]);
});

test("trackerRefKey canonicalizes a ref against the tracker's own repository", () => {
  assert.equal(trackerRefKey({ owner: "o", repo: "r", number: 3 }, "x/y"), "o/r#3");
  assert.equal(trackerRefKey({ owner: null, repo: null, number: 3 }, "x/y"), "x/y#3");
  assert.equal(trackerRefKey({ owner: null, repo: null, number: 3 }, null), null, "an own-repository ref needs the repository");
});

// --- edge derivation ---------------------------------------------------------

const SOURCE = "github:github.com";
const TRACKER = { sourceId: SOURCE, externalId: "I_tracker" };

// Resolve `#N` to the issue id `I_<N>` with the given states (default open);
// numbers listed in `missing` do not resolve.
function resolver(states: Record<number, ItemState> = {}, missing: number[] = []) {
  return (ref: TrackerRef): TrackerTarget | null =>
    missing.includes(ref.number) ? null : { externalId: `I_${ref.number}`, state: states[ref.number] ?? "open" };
}

function edgesOf(table: string, resolve = resolver()): CanonicalEdge[] {
  return trackerEdges(parseTrackerRows(`## Phase table\n${table}`), TRACKER, "open", resolve);
}

function pairs(edges: CanonicalEdge[], type: string): string[] {
  return edges.filter((e) => e.type === type).map((e) => `${e.from.externalId}>${e.to.externalId}`);
}

test("tracker rows become parent edges from the tracker and blocks edges between row issues", () => {
  const edges = edgesOf(
    ["- [x] **A** First: #1", "- [ ] **B** Second: #2 · after A", "- [ ] **C** Third: o/r#3 · after A, B"].join("\n"),
    resolver({ 1: "closed" }),
  );
  assert.deepEqual(pairs(edges, "parent"), ["I_tracker>I_1", "I_tracker>I_2", "I_tracker>I_3"]);
  assert.deepEqual(pairs(edges, "blocks"), ["I_1>I_2", "I_1>I_3", "I_2>I_3"], "prerequisite -> dependent");
  assert.deepEqual(new Set(edges.map((e) => e.type)), new Set(["parent", "blocks"]), "one canonical direction only");
  for (const e of edges) {
    assert.equal(e.from.sourceId, SOURCE);
    assert.equal(e.to.sourceId, SOURCE, "tracker edges are intra-source");
  }
  const parent = edges.find((e) => e.type === "parent" && e.to.externalId === "I_1")!;
  assert.deepEqual([parent.fromState, parent.toState], ["open", "closed"], "parent carries tracker and child states");
  const blocks = edges.find((e) => e.type === "blocks" && e.to.externalId === "I_2")!;
  assert.deepEqual([blocks.fromState, blocks.toState], ["closed", "open"], "blocks carries both row issue states");
});

test("a gate is contracted: its dependents depend on the gate's own prerequisites", () => {
  const edges = edgesOf(
    [
      "- [ ] **A** First: #1",
      "- [ ] **B** Second: #2",
      "- [ ] **REL** Release · after A, B",
      "- [ ] **C** Adopt: #3 · after REL",
    ].join("\n"),
  );
  assert.deepEqual(pairs(edges, "parent"), ["I_tracker>I_1", "I_tracker>I_2", "I_tracker>I_3"], "a gate has no parent edge");
  assert.deepEqual(pairs(edges, "blocks"), ["I_1>I_3", "I_2>I_3"], "the gate as a dependent emits nothing itself");
});

test("a chain of gates is expanded transitively and a gate cycle terminates", () => {
  const chain = edgesOf(
    [
      "- [ ] **A** First: #1",
      "- [ ] **G1** Deploy · after A",
      "- [ ] **G2** Decide · after G1",
      "- [ ] **C** Adopt: #3 · after G2",
    ].join("\n"),
  );
  assert.deepEqual(pairs(chain, "blocks"), ["I_1>I_3"]);

  const cycle = edgesOf(
    [
      "- [ ] **A** First: #1",
      "- [ ] **G1** Deploy · after G2, A",
      "- [ ] **G2** Decide · after G1",
      "- [ ] **C** Adopt: #3 · after G2",
    ].join("\n"),
  );
  assert.deepEqual(pairs(cycle, "blocks"), ["I_1>I_3"], "a gate cycle is walked once, not forever");
});

test("self, same-issue, and duplicate tracker edges are dropped", () => {
  const edges = edgesOf(
    [
      "- [x] **A1** Step 1: #1",
      "- [ ] **A2** Step 2 of the same issue: #1 · after A1",
      "- [ ] **B** Depends on both steps: #2 · after A1, A2",
      "- [ ] **S** Names itself: #3 · after S",
    ].join("\n"),
  );
  assert.deepEqual(pairs(edges, "parent"), ["I_tracker>I_1", "I_tracker>I_2", "I_tracker>I_3"], "two rows of one issue give one parent edge");
  assert.deepEqual(pairs(edges, "blocks"), ["I_1>I_2"], "no I_1>I_1 self-edge, no repeated I_1>I_2, no I_3>I_3");

  const own = trackerEdges(parseTrackerRows("## Phase table\n- [ ] **T** The tracker itself: #9"), TRACKER, "open", () => ({
    externalId: TRACKER.externalId,
    state: "open",
  }));
  assert.deepEqual(own, [], "a row naming the tracker does not make it its own parent");
});

test("unknown ids are ignored and a duplicated id resolves to its first row", () => {
  const edges = edgesOf(
    [
      "- [ ] **A** First: #1",
      "- [ ] **A** Reuses the id: #2",
      "- [ ] **B** Depends on A and a missing id: #3 · after A, Z9",
    ].join("\n"),
  );
  assert.deepEqual(pairs(edges, "parent"), ["I_tracker>I_1", "I_tracker>I_2", "I_tracker>I_3"]);
  assert.deepEqual(pairs(edges, "blocks"), ["I_1>I_3"]);
});

test("an unresolved ref produces no edge and is not contracted like a gate", () => {
  const edges = edgesOf(
    [
      "- [ ] **A** First: #1",
      "- [ ] **B** Inaccessible: #2 · after A",
      "- [ ] **C** Third: #3 · after B",
    ].join("\n"),
    resolver({}, [2]),
  );
  assert.deepEqual(pairs(edges, "parent"), ["I_tracker>I_1", "I_tracker>I_3"]);
  assert.deepEqual(pairs(edges, "blocks"), [], "neither endpoint of a dependency may be unresolved");
});

test("the full corpus tracker derives the expected program structure", () => {
  const ids: Record<string, string> = { "#10": "P0", "example/alpha#12": "A0", "example/alpha#14": "A", "#21": "B1", "example/beta#7": "C1" };
  const edges = trackerEdges(parseTrackerRows(body("valid", "full")), TRACKER, "open", (ref) => {
    const id = ids[trackerRefKey(ref, null) ?? `#${ref.number}`];
    return id ? { externalId: id, state: "open" } : null;
  });
  assert.deepEqual(pairs(edges, "parent"), ["I_tracker>P0", "I_tracker>A0", "I_tracker>A", "I_tracker>B1", "I_tracker>C1"]);
  // A1 and A2 are two steps of example/alpha#14; REL (a gate) contracts to A2.
  assert.deepEqual(pairs(edges, "blocks"), ["A0>A", "A>B1", "P0>B1", "A>C1", "B1>C1"]);
});

// --- per-tracker bounds ------------------------------------------------------
//
// An issue body is text anyone who can write to a tracked repository controls.
// Gate contraction multiplies: K issue rows, one gate after all of them, and D
// rows after the gate is K x D `blocks` edges from one 64 KB body.

function issueRow(id: string, number: number, after: string[] = []): TrackerRow {
  return { id, title: "t", ref: { owner: null, repo: null, number }, notes: null, after, done: false, phase: null };
}

function gateRow(id: string, after: string[]): TrackerRow {
  return { id, title: "t", ref: null, notes: null, after, done: false, phase: null };
}

function tableOf(rows: readonly TrackerRow[]): string {
  const lines = rows.map((row) => {
    const ref = row.ref ? `: #${row.ref.number}` : "";
    const after = row.after.length > 0 ? ` · after ${row.after.join(",")}` : "";
    return `- [ ] **${row.id}** ${row.title}${ref}${after}`;
  });
  return ["## Phase table", ...lines].join("\n");
}

test("a crafted gate fan-out stays within the per-tracker bounds", () => {
  const K = 1300;
  const D = 800;
  const prerequisites = Array.from({ length: K }, (_, i) => issueRow(`K${i}`, i + 1));
  const crafted = [
    ...prerequisites,
    gateRow("G", prerequisites.map((row) => row.id)),
    ...Array.from({ length: D }, (_, i) => issueRow(`D${i}`, K + 1 + i, ["G"])),
  ];
  const text = tableOf(crafted);
  assert.ok(text.length < 65_536, "the crafted table fits one provider issue body");

  const started = performance.now();
  // Through the parser: only the first rows of the table are read.
  const rows = parseTrackerRows(text);
  assert.equal(rows.length, TRACKER_MAX_ROWS);
  assert.deepEqual(rows.map((row) => row.id), crafted.slice(0, TRACKER_MAX_ROWS).map((row) => row.id), "the FIRST rows, in table order");
  const parsed = trackerEdges(rows, TRACKER, "open", resolver());
  assert.equal(pairs(parsed, "parent").length, TRACKER_MAX_ROWS);
  assert.ok(pairs(parsed, "blocks").length <= TRACKER_MAX_BLOCKS_EDGES);

  // Handed every row regardless (K x D = 1,040,000 candidate edges): the edge
  // derivation bounds its own output.
  const direct = pairs(trackerEdges(crafted, TRACKER, "open", resolver()), "blocks");
  assert.equal(direct.length, TRACKER_MAX_BLOCKS_EDGES);
  assert.equal(direct[0], "I_1>I_1301");
  assert.equal(direct.at(-1), "I_1000>I_1301", "the first edges in table order, then none");
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1000, `deriving the crafted tracker took ${Math.round(elapsed)}ms`);
});

test("dense gate structures expand each prerequisite once and stay fast", () => {
  // 100 issue rows, 60 gates that each wait on all of them, 120 rows that each
  // wait on all 60 gates: 720,000 (gate, prerequisite) visits for 12,000
  // distinct candidate edges.
  const issues = Array.from({ length: 100 }, (_, i) => issueRow(`K${i}`, i + 1));
  const gates = Array.from({ length: 60 }, (_, i) => gateRow(`G${i}`, issues.map((row) => row.id)));
  const dependents = Array.from({ length: 120 }, (_, i) => issueRow(`D${i}`, 1000 + i, gates.map((row) => row.id)));
  const resolved: number[] = [];
  const counting = (ref: TrackerRef): TrackerTarget => {
    resolved.push(ref.number);
    return { externalId: `I_${ref.number}`, state: "open" };
  };

  const started = performance.now();
  const rows = parseTrackerRows(tableOf([...issues, ...gates, ...dependents]));
  assert.equal(rows.length, 280, "an ordinary-sized table is read whole");
  const edges = trackerEdges(rows, TRACKER, "open", counting);
  const elapsed = performance.now() - started;

  assert.equal(pairs(edges, "parent").length, 220);
  const blocks = pairs(edges, "blocks");
  assert.equal(blocks.length, TRACKER_MAX_BLOCKS_EDGES);
  assert.deepEqual([blocks[0], blocks[99], blocks[100], blocks.at(-1)], ["I_1>I_1000", "I_100>I_1000", "I_1>I_1001", "I_100>I_1009"]);
  assert.ok(resolved.length <= rows.length, `each row ref is resolved once (${resolved.length} calls)`);
  assert.ok(elapsed < 1000, `deriving the dense tracker took ${Math.round(elapsed)}ms`);
});

test("a tracker below the bounds keeps every row and every dependency", () => {
  const issues = Array.from({ length: 40 }, (_, i) => issueRow(`K${i}`, i + 1, i === 0 ? [] : [`K${i - 1}`]));
  const last = issueRow("Z", 99, issues.map((row) => row.id));
  const edges = trackerEdges(parseTrackerRows(tableOf([...issues, last])), TRACKER, "open", resolver());
  assert.equal(pairs(edges, "parent").length, 41);
  assert.equal(pairs(edges, "blocks").length, 39 + 40);
});
