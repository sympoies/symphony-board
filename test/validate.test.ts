import { test } from "node:test";
import assert from "node:assert/strict";
import { validateContract, loadContractSchema } from "../src/contract/validate.ts";
import { buildContract } from "../src/contract/build.ts";
import { CONTRACT_VERSION } from "../src/contract/version.ts";
import type { ItemRow, LabelRow, EdgeRow, SourceRow } from "../src/db/repo.ts";

// A representative, schema-valid envelope built the same way emit does, so the
// validator is exercised against the real schema + the real builder output.
function validEnvelope() {
  const sources: SourceRow[] = [
    { source_id: "github:github.com", kind: "github", host: "github.com", display_name: "GitHub", last_success_at: "2026-06-01T00:00:00Z", last_status: "ok" },
  ];
  const items: ItemRow[] = [
    {
      item_id: 1, source_id: "github:github.com", external_id: "ISSUE_abc", kind: "issue",
      project_path: "graysurf/repo", iid: 7, url: "https://github.com/graysurf/repo/issues/7",
      title: "An issue", state: "open", state_raw: "OPEN", state_reason: null, is_draft: null,
      author: "graysurf", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z",
      closed_at: null, merged_at: null, review_state: null, ci_state: null, merge_state: null,
      milestone: null, demand: 3, last_seen_at: "2026-06-01T00:00:00Z",
    },
    {
      item_id: 2, source_id: "github:github.com", external_id: "PR_xyz", kind: "change_request",
      project_path: "graysurf/repo", iid: 8, url: "https://github.com/graysurf/repo/pull/8",
      title: "A PR", state: "merged", state_raw: "MERGED", state_reason: null, is_draft: 0,
      author: "graysurf", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z",
      closed_at: "2026-01-03T00:00:00Z", merged_at: "2026-01-03T00:00:00Z", review_state: "approved",
      ci_state: "passing", merge_state: "mergeable", milestone: null, demand: 1, last_seen_at: "2026-06-01T00:00:00Z",
    },
  ];
  const labels: LabelRow[] = [{ item_id: 1, name: "priority::high", scope: "priority", color: "red" }];
  const edges: EdgeRow[] = [
    { type: "closes", from_source_id: "github:github.com", from_external_id: "PR_xyz", to_source_id: "github:github.com", to_external_id: "ISSUE_abc", from_state: "merged", to_state: "open", lifecycle: "declared" },
  ];
  return buildContract({ sources, items, labels, edges, generatedAt: "2026-06-02T00:00:00Z" });
}

test("a freshly built envelope passes the schema clean", () => {
  assert.deepEqual(validateContract(validEnvelope()), []);
});

test("loadContractSchema reads the normative schema with the expected $id", () => {
  const schema = loadContractSchema();
  const major = CONTRACT_VERSION.split(".")[0];
  assert.equal(schema.$id, `https://sympoies.dev/symphony-board/contract/v${major}.json`);
});

test("a missing required envelope field is rejected", () => {
  const env: any = validEnvelope();
  delete env.contract_version;
  const errors = validateContract(env);
  assert.ok(errors.some((e) => e.path === "/contract_version" && /required/.test(e.message)));
});

test("a bad contract_version pattern is rejected", () => {
  const env: any = validEnvelope();
  env.contract_version = "v1";
  const errors = validateContract(env);
  assert.ok(errors.some((e) => e.path === "/contract_version" && /pattern/.test(e.message)));
});

test("an unknown extra property is rejected (additionalProperties:false)", () => {
  const env: any = validEnvelope();
  env.items[0].surprise = true;
  const errors = validateContract(env);
  assert.ok(errors.some((e) => e.path === "/items/0/surprise" && /additional property/.test(e.message)));
});

test("an out-of-enum item state is rejected", () => {
  const env: any = validEnvelope();
  env.items[0].state = "reopened";
  const errors = validateContract(env);
  assert.ok(errors.some((e) => e.path === "/items/0/state" && /enum/.test(e.message)));
});

test("a wrong-typed field is rejected", () => {
  const env: any = validEnvelope();
  env.items[0].iid = "seven"; // schema: integer | null
  const errors = validateContract(env);
  assert.ok(errors.some((e) => e.path === "/items/0/iid" && /expected type/.test(e.message)));
});

test("a malformed edge ref (no '|') is rejected", () => {
  const env: any = validEnvelope();
  env.edges[0].from = "no-pipe-here";
  const errors = validateContract(env);
  assert.ok(errors.some((e) => e.path === "/edges/0/from" && /pattern/.test(e.message)));
});

test("null is accepted where the type union and enum allow it", () => {
  const env: any = validEnvelope();
  env.sources[0].last_status = null; // enum includes null
  env.items[0].review_state = null; // enum includes null
  assert.deepEqual(validateContract(env), []);
});

test("an envelope carrying source + repo colors validates clean", () => {
  const env: any = validEnvelope();
  env.sources[0].color = "#1f6feb";
  env.repos = [{ source_id: "github:github.com", project_path: "graysurf/repo", color: "#e0af68" }];
  assert.deepEqual(validateContract(env), []);
});

test("a repo entry missing its required color is rejected", () => {
  const env: any = validEnvelope();
  env.repos = [{ source_id: "github:github.com", project_path: "graysurf/repo" }];
  const errors = validateContract(env);
  assert.ok(errors.some((e) => e.path === "/repos/0/color" && /required/.test(e.message)));
});

test("an unknown property on a repo entry is rejected", () => {
  const env: any = validEnvelope();
  env.repos = [{ source_id: "x", project_path: "y", color: "#fff", surprise: true }];
  const errors = validateContract(env);
  assert.ok(errors.some((e) => e.path === "/repos/0/surprise" && /additional property/.test(e.message)));
});

test("activity records validate and reject malformed timestamps", () => {
  const env: any = validEnvelope();
  env.activities = [
    {
      id: "github:github.com|activity-1",
      source_id: "github:github.com",
      external_id: "activity-1",
      kind: "issue",
      action: "opened",
      project_path: "graysurf/repo",
      target_kind: "issue",
      target_ref: "github:github.com|ISSUE_abc",
      target_iid: 7,
      title: "An issue",
      url: "https://github.com/graysurf/repo/issues/7",
      actor: "graysurf",
      occurred_at: "2026-01-01T00:00:00Z",
      summary: "Opened issue #7",
      details: { source: "test" },
      first_seen_at: "2026-06-01T00:00:00Z",
      last_seen_at: "2026-06-01T00:00:00Z",
    },
  ];
  assert.deepEqual(validateContract(env), []);
  env.activities[0].occurred_at = "not-a-date";
  const errors = validateContract(env);
  assert.ok(errors.some((e) => e.path === "/activities/0/occurred_at" && /date-time/.test(e.message)));
});

test("aggregate rows validate their scope, window, and open count maps", () => {
  const env: any = validEnvelope();
  const global = env.aggregates.find((a: any) => a.scope === "global");
  assert.equal(global.window.kind, "full");
  assert.equal(global.stats.items, 2);
  assert.deepEqual(validateContract(env), []);
});

test("an aggregate with an out-of-vocabulary scope is rejected", () => {
  const env: any = validEnvelope();
  env.aggregates[0].scope = "sidebar";
  const errors = validateContract(env);
  assert.ok(errors.some((e) => e.path === "/aggregates/0/scope" && /enum/.test(e.message)));
});

test("aggregate count-map values must be integers", () => {
  const env: any = validEnvelope();
  env.aggregates[0].stats.by_state.open = "one";
  const errors = validateContract(env);
  assert.ok(errors.some((e) => e.path === "/aggregates/0/stats/by_state/open" && /expected type integer/.test(e.message)));
});

test("aggregate counts must be non-negative", () => {
  const env: any = validEnvelope();
  env.aggregates[0].stats.by_state.open = -1;
  const errors = validateContract(env);
  assert.ok(errors.some((e) => e.path === "/aggregates/0/stats/by_state/open" && /minimum 0/.test(e.message)));
});

test("repo metric repo_url validates as an optional nullable provider link", () => {
  const env: any = validEnvelope();
  const metric = env.repo_metrics[0];
  metric.repo_url = "https://github.com/graysurf/repo";
  assert.deepEqual(validateContract(env), []);
  metric.repo_url = null;
  assert.deepEqual(validateContract(env), []);
});

test("window metadata and repo stats are required in contract v2", () => {
  const env: any = validEnvelope();
  delete env.item_window;
  delete env.repo_stats;
  const errors = validateContract(env);
  assert.ok(errors.some((e) => e.path === "/item_window" && /required/.test(e.message)));
  assert.ok(errors.some((e) => e.path === "/repo_stats" && /required/.test(e.message)));
});
