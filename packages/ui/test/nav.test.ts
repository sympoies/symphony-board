import { test } from "node:test";
import assert from "node:assert/strict";
import type { ItemDTO } from "@symphony-board/contract";
import { parseHashRoute, buildHashRoute } from "../src/model.ts";
import {
  ACTIVITY_FACET_DIMS,
  activityFacets,
  activityFacetField,
  activityFacetFields,
  toggleActivityFacet,
  ITEM_FACET_DIMS,
  itemFacets,
  itemFacetField,
  itemFacetFields,
  toggleItemFacet,
  activityDrilldownHref,
  commitsDrilldownHref,
  tabHref,
  graphFocusHref,
} from "../src/nav.ts";

// The Activity feed reads its facets from these route fields; the chips and the
// content filter share this mapping, so a mismatch here is the exact divergence
// the module exists to prevent.
test("activityFacetField maps every dim to a route field; ACTIVITY_FACET_DIMS is the full set", () => {
  assert.deepEqual(ACTIVITY_FACET_DIMS, ["sources", "repos", "kinds", "actions"]);
  assert.equal(activityFacetField("sources"), "source");
  assert.equal(activityFacetField("repos"), "repo");
  assert.equal(activityFacetField("kinds"), "kind");
  assert.equal(activityFacetField("actions"), "action");
});

test("activityFacets parses single values and comma lists into multi-value sets", () => {
  const f = activityFacets({ source: "github:github.com", repo: null, kind: "issue,change_request", action: null });
  assert.deepEqual([...f.sources], ["github:github.com"]);
  assert.deepEqual([...f.kinds].sort(), ["change_request", "issue"]);
  assert.equal(f.repos.size, 0);
  assert.equal(f.actions.size, 0);
});

test("toggleActivityFacet adds then removes; activityFacetFields serializes back", () => {
  const empty = activityFacets({ source: null, repo: null, kind: null, action: null });
  const withReview = toggleActivityFacet(empty, "kinds", "review");
  assert.deepEqual([...withReview.kinds], ["review"]);
  assert.equal(activityFacetFields(withReview).kind, "review");
  const cleared = toggleActivityFacet(withReview, "kinds", "review");
  assert.equal(cleared.kinds.size, 0);
  assert.equal(activityFacetFields(cleared).kind, null, "an empty dim drops its route field");
  // toggling one dim leaves the others untouched
  const multi = toggleActivityFacet(toggleActivityFacet(empty, "kinds", "issue"), "sources", "s1");
  assert.deepEqual([...multi.kinds], ["issue"]);
  assert.deepEqual([...multi.sources], ["s1"]);
});

test("Activity facets round-trip through the hash (link -> route -> chips agree)", () => {
  const facets = activityFacets({ source: "github:github.com,gitlab:gitlab.com", repo: "o/r", kind: "review", action: "opened,merged" });
  const hash = buildHashRoute({ page: "activity", ...activityFacetFields(facets) });
  const parsed = activityFacets(parseHashRoute(hash));
  assert.deepEqual([...parsed.sources].sort(), [...facets.sources].sort());
  assert.deepEqual([...parsed.repos], [...facets.repos]);
  assert.deepEqual([...parsed.kinds], [...facets.kinds]);
  assert.deepEqual([...parsed.actions].sort(), [...facets.actions].sort());
});

// The bug this fixes: a Repo Analytics "reviews" cell linked to the feed and
// narrowed it, but the kind chip never lit up. Asserting the link lands with the
// facet active locks that contract.
test("activityDrilldownHref lands with kind/action/source/repo as ACTIVE facets", () => {
  const href = activityDrilldownHref({
    source: "github:github.com",
    repo: "graysurf/agent-runtime-kit",
    range: { from: "2026-06-08", to: "2026-06-13" },
    kind: "review",
  });
  const route = parseHashRoute(href);
  assert.equal(route.page, "activity");
  const f = activityFacets(route);
  assert.deepEqual([...f.kinds], ["review"], "the kind chip is active on arrival");
  assert.deepEqual([...f.sources], ["github:github.com"]);
  assert.deepEqual([...f.repos], ["graysurf/agent-runtime-kit"]);
  assert.equal(route.from, "2026-06-08");
  assert.equal(route.to, "2026-06-13");

  const closed = activityDrilldownHref({ source: "s", repo: "r", range: {}, action: "closed,merged" });
  assert.deepEqual([...activityFacets(parseHashRoute(closed)).actions].sort(), ["closed", "merged"]);
});

test("commitsDrilldownHref targets commits with source/repo and no facet fields", () => {
  const route = parseHashRoute(
    commitsDrilldownHref({ source: "github:github.com", repo: "o/r", range: { from: "2026-06-01", to: "2026-06-07" } }),
  );
  assert.equal(route.page, "commits");
  assert.equal(route.source, "github:github.com");
  assert.equal(route.repo, "o/r");
  assert.equal(route.kind, null);
  assert.equal(route.action, null);
});

// One rule for what carries across a tab hop: search + range travel; page-local
// drill-down state (facets, graph focus, commit branch) does NOT.
test("tabHref carries search, range, and the shared item lens but drops drill-down state", () => {
  const route = parseHashRoute(
    tabHref("board", {
      q: "flaky",
      range: { from: "2026-06-01", to: "2026-06-07", preset: "this-week" },
      item: { isource: "github:github.com", istate: "open", ikind: "issue" },
    }),
  );
  assert.equal(route.page, "board");
  assert.equal(route.q, "flaky");
  assert.equal(route.from, "2026-06-01");
  assert.equal(route.to, "2026-06-07");
  assert.equal(route.preset, "this-week");
  // the shared item lens travels...
  assert.deepEqual([...itemFacets(route).sources], ["github:github.com"]);
  assert.deepEqual([...itemFacets(route).states], ["open"]);
  assert.deepEqual([...itemFacets(route).kinds], ["issue"]);
  // ...but page-local drill-down state does not.
  for (const dropped of ["source", "repo", "kind", "action", "focus", "branch"] as const) {
    assert.equal(route[dropped], null, `${dropped} does not carry across a tab hop`);
  }

  const bare = parseHashRoute(tabHref("activity", {}));
  assert.equal(bare.page, "activity");
  assert.equal(bare.q, null);
  assert.equal(bare.isource, null, "no item lens when none is supplied");
});

// The board / graph / repo-analytics shared lens. Distinct route fields from the
// Activity facets so the two never collide when both ride a URL across a tab hop.
test("itemFacetField maps every dim to a distinct route field; ITEM_FACET_DIMS is the full set", () => {
  assert.deepEqual(ITEM_FACET_DIMS, ["sources", "states", "kinds"]);
  assert.equal(itemFacetField("sources"), "isource");
  assert.equal(itemFacetField("states"), "istate");
  assert.equal(itemFacetField("kinds"), "ikind");
});

test("item facets parse, toggle, and round-trip through the hash without colliding with Activity facets", () => {
  const empty = itemFacets({ isource: null, istate: null, ikind: null });
  assert.equal(empty.sources.size + empty.states.size + empty.kinds.size, 0);

  const withKind = toggleItemFacet(empty, "kinds", "issue");
  assert.deepEqual([...withKind.kinds], ["issue"]);
  assert.equal(itemFacetFields(withKind).ikind, "issue");
  assert.equal(itemFacetFields(toggleItemFacet(withKind, "kinds", "issue")).ikind, null, "re-toggle clears the field");

  const facets = itemFacets({ isource: "github:github.com,gitlab:gitlab.com", istate: "open", ikind: "issue,change_request" });
  const hash = buildHashRoute({ page: "board", ...itemFacetFields(facets) });
  const route = parseHashRoute(hash);
  const parsed = itemFacets(route);
  assert.deepEqual([...parsed.sources].sort(), ["github:github.com", "gitlab:gitlab.com"]);
  assert.deepEqual([...parsed.states], ["open"]);
  assert.deepEqual([...parsed.kinds].sort(), ["change_request", "issue"]);
  // the item lens uses isource/istate/ikind, leaving the Activity fields free
  assert.equal(route.source, null);
  assert.equal(route.kind, null);
  assert.deepEqual([...activityFacets(route).sources], [], "Activity facets are untouched by the item lens");
});

test("graphFocusHref is re-exported from nav and builds a graph focus link", () => {
  const route = parseHashRoute(graphFocusHref({ id: "github:github.com|42" } as unknown as ItemDTO));
  assert.equal(route.page, "graph");
  assert.equal(route.focus, "github:github.com|42");
});
