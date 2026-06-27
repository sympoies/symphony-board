import { test } from "node:test";
import assert from "node:assert/strict";
import type { ItemDTO } from "@symphony-board/contract";
import { parseHashRoute, buildHashRoute, itemSortFromRoute, reviewSortFromRoute } from "../src/model.ts";
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
  ITEM_REVIEW_VALUES,
  activityDrilldownHref,
  commitsDrilldownHref,
  reviewThreadsHref,
  tabHref,
  graphFocusHref,
  activityView,
  activityViewTab,
  graphView,
  graphViewTab,
  reviewRepoSearchHref,
  clearFiltersHref,
  startupRouteHash,
  resolveDefaultTab,
  liveTabVisible,
  parseDebugTab,
  debugTabField,
  DEBUG_TAB_IDS,
  DEFAULT_DEBUG_TAB,
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
    repo: "dev-a/agent-runtime-kit",
    range: { from: "2026-06-08", to: "2026-06-13" },
    kind: "review",
  });
  const route = parseHashRoute(href);
  assert.equal(route.page, "activity");
  const f = activityFacets(route);
  assert.deepEqual([...f.kinds], ["review"], "the kind chip is active on arrival");
  assert.deepEqual([...f.sources], ["github:github.com"]);
  assert.deepEqual([...f.repos], ["dev-a/agent-runtime-kit"]);
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
    tabHref("items", {
      q: "flaky",
      range: { from: "2026-06-01", to: "2026-06-07", preset: "this-week" },
      item: { isource: "github:github.com", istate: "open", ikind: "issue", irepo: "o/r" },
    }),
  );
  assert.equal(route.page, "items");
  assert.equal(route.q, "flaky");
  assert.equal(route.from, "2026-06-01");
  assert.equal(route.to, "2026-06-07");
  assert.equal(route.preset, "this-week");
  // the shared item lens travels...
  assert.deepEqual([...itemFacets(route).sources], ["github:github.com"]);
  assert.deepEqual([...itemFacets(route).states], ["open"]);
  assert.deepEqual([...itemFacets(route).kinds], ["issue"]);
  assert.deepEqual([...itemFacets(route).repos], ["o/r"], "the exact-repo pin rides the tab hop");
  assert.equal(route.irepo, "o/r");
  // ...but page-local drill-down state does not.
  for (const dropped of ["source", "repo", "kind", "action", "focus", "branch"] as const) {
    assert.equal(route[dropped], null, `${dropped} does not carry across a tab hop`);
  }

  const bare = parseHashRoute(tabHref("activity", {}));
  assert.equal(bare.page, "activity");
  assert.equal(bare.q, null);
  assert.equal(bare.isource, null, "no item lens when none is supplied");
});

test("clearFiltersHref drops search and page filters while preserving range and view state", () => {
  const activity = parseHashRoute(
    clearFiltersHref(parseHashRoute(
      "#/activity?q=review&source=github%3Agithub.com&repo=sympoies%2Fsymphony-board&kind=review&action=commented&unresolved=1&isource=github%3Agithub.com&istate=open&ikind=issue&ireview=unresolved&irepo=sympoies%2Fsymphony-board&from=2026-06-15&to=2026-06-21&preset=1w&tab=overview",
    )),
  );
  assert.equal(activity.page, "activity");
  assert.equal(activity.q, null);
  assert.equal(activity.source, null);
  assert.equal(activity.repo, null);
  assert.equal(activity.kind, null);
  assert.equal(activity.action, null);
  assert.equal(activity.unresolved, null);
  assert.equal(activity.isource, null);
  assert.equal(activity.istate, null);
  assert.equal(activity.ikind, null);
  assert.equal(activity.ireview, null);
  assert.equal(activity.irepo, null);
  assert.equal(activity.from, "2026-06-15");
  assert.equal(activity.to, "2026-06-21");
  assert.equal(activity.preset, "1w");
  assert.equal(activity.tab, "overview", "sub-view state is not a filter");

  const graph = parseHashRoute(
    clearFiltersHref(parseHashRoute("#/graph?focus=github%3Agithub.com%7Cissue-1&q=issue&isource=github%3Agithub.com&from=2026-06-15&to=2026-06-21&tab=graph")),
  );
  assert.equal(graph.page, "graph");
  assert.equal(graph.focus, "github:github.com|issue-1", "focused graph item is preserved");
  assert.equal(graph.q, null);
  assert.equal(graph.isource, null);
  assert.equal(graph.from, "2026-06-15");
  assert.equal(graph.to, "2026-06-21");
  assert.equal(graph.tab, "graph");
});

// The board / graph / repo-analytics shared lens. Distinct route fields from the
// Activity facets so the two never collide when both ride a URL across a tab hop.
test("itemFacetField maps every dim to a distinct route field; ITEM_FACET_DIMS is the full set", () => {
  assert.deepEqual(ITEM_FACET_DIMS, ["sources", "states", "kinds", "reviews", "repos"]);
  assert.equal(itemFacetField("sources"), "isource");
  assert.equal(itemFacetField("states"), "istate");
  assert.equal(itemFacetField("kinds"), "ikind");
  assert.equal(itemFacetField("reviews"), "ireview");
  assert.equal(itemFacetField("repos"), "irepo");
});

// The exact-repo pin (irepo). A single-value lens dimension, rendered as a pinned
// chip; distinct from the Activity feed's substring `repo` so the two never bleed.
test("repos item facet maps to irepo and round-trips exact project_paths", () => {
  const facets = itemFacets({ isource: null, istate: null, ikind: null, ireview: null, irepo: "a/b,c/d" });
  assert.deepEqual([...facets.repos].sort(), ["a/b", "c/d"]);
  // serialize back to the irepo route field
  assert.equal(itemFacetFields(facets).irepo, "a/b,c/d");
  // toggle adds then clears the field
  const empty = itemFacets({ isource: null, istate: null, ikind: null, ireview: null, irepo: null });
  const pinned = toggleItemFacet(empty, "repos", "o/r");
  assert.deepEqual([...pinned.repos], ["o/r"]);
  assert.equal(itemFacetFields(pinned).irepo, "o/r");
  assert.equal(itemFacetFields(toggleItemFacet(pinned, "repos", "o/r")).irepo, null, "re-toggle clears the pin");
});

test("item facets parse, toggle, and round-trip through the hash without colliding with Activity facets", () => {
  const empty = itemFacets({ isource: null, istate: null, ikind: null, ireview: null, irepo: null });
  assert.equal(empty.sources.size + empty.states.size + empty.kinds.size + empty.reviews.size + empty.repos.size, 0);

  const withKind = toggleItemFacet(empty, "kinds", "issue");
  assert.deepEqual([...withKind.kinds], ["issue"]);
  assert.equal(itemFacetFields(withKind).ikind, "issue");
  assert.equal(itemFacetFields(toggleItemFacet(withKind, "kinds", "issue")).ikind, null, "re-toggle clears the field");

  const facets = itemFacets({ isource: "github:github.com,gitlab:gitlab.com", istate: "open", ikind: "issue,change_request", ireview: "unresolved", irepo: null });
  const hash = buildHashRoute({ page: "board", ...itemFacetFields(facets) });
  const route = parseHashRoute(hash);
  const parsed = itemFacets(route);
  assert.deepEqual([...parsed.sources].sort(), ["github:github.com", "gitlab:gitlab.com"]);
  assert.deepEqual([...parsed.states], ["open"]);
  assert.deepEqual([...parsed.kinds].sort(), ["change_request", "issue"]);
  assert.deepEqual([...parsed.reviews], ["unresolved"], "the review lens round-trips through ?ireview=");
  // the item lens uses isource/istate/ikind/ireview, leaving the Activity fields free
  assert.equal(route.source, null);
  assert.equal(route.kind, null);
  assert.deepEqual([...activityFacets(route).sources], [], "Activity facets are untouched by the item lens");
});

test("review lens: toggleItemFacet round-trips ireview; reviewThreadsHref pins source + review + repo search", () => {
  assert.deepEqual([...ITEM_REVIEW_VALUES], ["threads", "unresolved"]);
  const empty = itemFacets({ isource: null, istate: null, ikind: null, ireview: null, irepo: null });
  const withReview = toggleItemFacet(empty, "reviews", "unresolved");
  assert.deepEqual([...withReview.reviews], ["unresolved"]);
  assert.equal(itemFacetFields(withReview).ireview, "unresolved");
  assert.equal(itemFacetFields(toggleItemFacet(withReview, "reviews", "unresolved")).ireview, null, "re-toggle clears it");

  const href = reviewThreadsHref({ source: "github:github.com", repo: "o/r", range: { from: null, to: null, preset: null }, value: "unresolved" });
  const route = parseHashRoute(href!);
  assert.equal(route.page, "reviews");
  assert.equal(route.isource, "github:github.com");
  assert.equal(route.ireview, "unresolved");
  // the exact repo is pinned via irepo (NOT the free-text q substring, which
  // collided on shared path prefixes).
  assert.equal(route.irepo, "o/r", "repo path pins the exact-repo lens");
  assert.equal(route.q, null, "no free-text q substring on the review threads link");
  assert.ok(href!.includes("irepo=o%2Fr"), `hash carries the encoded irepo pin (${href})`);
  assert.ok(!href!.includes("q="), "hash carries no q= field");
  const allThreadsRoute = parseHashRoute(reviewThreadsHref({ source: "github:github.com", repo: "o/r", range: {}, value: "threads" })!);
  assert.equal(allThreadsRoute.page, "reviews");
  assert.equal(allThreadsRoute.ireview, "threads", "all-thread links use the Reviews thread lens");
  assert.equal(reviewThreadsHref({ source: "s", repo: null, range: { from: null, to: null, preset: null }, value: "unresolved" }), null, "null repo -> no link");
});

test("reviewRepoSearchHref drives the Reviews search bar for repo breakdown clicks", () => {
  const href = reviewRepoSearchHref({
    source: "github:github.com",
    repo: "sympoies/symphony-board",
    range: { from: "2026-05-23", to: "2026-06-21", preset: "1mo" },
    review: "unresolved",
  });
  const route = parseHashRoute(href!);
  assert.equal(route.page, "reviews");
  assert.equal(route.q, "sympoies/symphony-board");
  assert.equal(route.isource, "github:github.com");
  assert.equal(route.ireview, "unresolved");
  assert.equal(route.irepo, "sympoies/symphony-board");
  assert.equal(route.from, "2026-05-23");
  assert.equal(route.to, "2026-06-21");
  assert.equal(route.preset, "1mo");
  assert.equal(
    startupRouteHash(href!, "live"),
    href,
    "repo breakdown links survive cold-start default-tab resolution because exact review facets are present",
  );
  assert.equal(reviewRepoSearchHref({ source: "s", repo: null, range: {} }), null, "unknown repo -> no link");
});

// The lens (incl. irepo) threads through the Repo Analytics drill-downs so a
// round-trip back to the board/graph preserves the active facets.
test("activityDrilldownHref / commitsDrilldownHref thread the item lens (isource/irepo)", () => {
  const lens = { isource: "github:github.com", istate: null, ikind: "issue", ireview: null, irepo: "o/r" };
  const aHref = activityDrilldownHref({ source: "github:github.com", repo: "o/r", range: {}, kind: "review", item: lens });
  assert.ok(aHref.includes("isource=github%3Agithub.com"), `activity drill-down carries isource (${aHref})`);
  assert.ok(aHref.includes("irepo=o%2Fr"), `activity drill-down carries irepo (${aHref})`);
  const aRoute = parseHashRoute(aHref);
  assert.equal(aRoute.isource, "github:github.com");
  assert.equal(aRoute.irepo, "o/r");
  assert.equal(aRoute.ikind, "issue");

  const cHref = commitsDrilldownHref({ source: "github:github.com", repo: "o/r", range: {}, item: lens });
  assert.ok(cHref.includes("isource=github%3Agithub.com"), `commits drill-down carries isource (${cHref})`);
  assert.ok(cHref.includes("irepo=o%2Fr"), `commits drill-down carries irepo (${cHref})`);
  // no item lens supplied -> drill-down carries no lens fields
  const bare = parseHashRoute(commitsDrilldownHref({ source: "s", repo: "r", range: {} }));
  assert.equal(bare.isource, null);
  assert.equal(bare.irepo, null);
});

test("graphFocusHref is re-exported from nav and builds a graph focus link", () => {
  const route = parseHashRoute(graphFocusHref({ id: "github:github.com|42" } as unknown as ItemDTO));
  assert.equal(route.page, "graph");
  assert.equal(route.focus, "github:github.com|42");
});

// The Activity tab's mobile sub-view: the records feed (default) or the summary
// "overview" panel. Route-backed via the shared `tab` field so reload and share
// links agree, and — because a top-nav tab hop drops `tab` — a fresh visit always
// lands on the feed (the latest records), which is the whole point of the toggle.
test("activityView defaults to the feed and reads `overview` from the route", () => {
  assert.equal(activityView({ tab: null }), "feed", "no tab -> the records feed by default");
  assert.equal(activityView({ tab: "overview" }), "overview");
  assert.equal(activityView({ tab: "sources" }), "feed", "an unrelated tab value falls back to the feed");
});

test("activityViewTab maps the view to a `tab` value; the feed is the clean default (null)", () => {
  assert.equal(activityViewTab("feed"), null, "feed is the default -> no tab field, so the URL stays clean");
  assert.equal(activityViewTab("overview"), "overview");
});

test("Activity view round-trips through the hash, and a fresh tab hop resets to the feed", () => {
  const overview = buildHashRoute({ page: "activity", tab: activityViewTab("overview") });
  assert.equal(activityView(parseHashRoute(overview)), "overview", "overview survives reload / a shared link");
  // a top-nav hop drops page-local `tab` -> back to the feed (default = latest records)
  assert.equal(activityView(parseHashRoute(tabHref("activity", {}))), "feed");
});

// The Graph page's mobile sub-view: the searchable/focus LIST (default) or the
// relationship CANVAS. Same route-backed `tab` mechanism as the Activity view
// (`tab=graph`); the list is the default because, once an item is focused, the
// list itself surfaces that item's related issues and change requests — so selecting never
// forces the canvas, which stays opt-in. A fresh tab hop resets to the list.
test("graphView defaults to the list and reads `graph` from the route", () => {
  assert.equal(graphView({ tab: null }), "list", "no tab -> the searchable/focus list by default");
  assert.equal(graphView({ tab: "graph" }), "graph");
  assert.equal(graphView({ tab: "overview" }), "list", "another page's tab value falls back to the list");
});

test("graphViewTab maps the view to a `tab` value; the list is the clean default (null)", () => {
  assert.equal(graphViewTab("list"), null, "list is the default -> no tab field, so the URL stays clean");
  assert.equal(graphViewTab("graph"), "graph");
});

test("Graph view round-trips through the hash, and a fresh tab hop resets to the list", () => {
  const canvas = buildHashRoute({ page: "graph", tab: graphViewTab("graph") });
  assert.equal(graphView(parseHashRoute(canvas)), "graph", "the canvas view survives reload / a shared link");
  // a top-nav hop drops page-local `tab` -> back to the list (the default browse surface)
  assert.equal(graphView(parseHashRoute(tabHref("graph", {}))), "list");
});

// The Reviews sort toggle is route-backed (?reviewSort=grouped) so a reload and a
// shared link preserve the choice; recency is the default, so the URL stays clean
// for it (the App maps "recent" -> null before building the hash).
test("Reviews sort round-trips through the hash; recency is the clean default", () => {
  assert.equal(buildHashRoute({ page: "reviews", reviewSort: null }), "#/reviews", "recency default -> no reviewSort field");
  const grouped = buildHashRoute({ page: "reviews", reviewSort: "grouped" });
  assert.equal(grouped, "#/reviews?reviewSort=grouped");
  assert.equal(
    reviewSortFromRoute(parseHashRoute(grouped).reviewSort),
    "grouped",
    "the chosen sort survives reload / a shared link",
  );
  assert.equal(reviewSortFromRoute(parseHashRoute("#/reviews").reviewSort), "recent");
});

// The Items sort toggle is route-backed like Reviews. Recent is the default
// lookup order, while "open" is an explicit view preference for active work.
test("Items sort round-trips through the hash; recent is the clean default", () => {
  assert.equal(buildHashRoute({ page: "items", itemSort: null }), "#/items", "recent default -> no itemSort field");
  const open = buildHashRoute({ page: "items", itemSort: "open" });
  assert.equal(open, "#/items?itemSort=open");
  assert.equal(itemSortFromRoute(parseHashRoute(open).itemSort), "open", "the chosen sort survives reload / a shared link");
  assert.equal(itemSortFromRoute(parseHashRoute("#/items").itemSort), "recent");
});

// The "default tab" setting decides where the app LANDS on a cold start (a fresh
// open OR a reload). The bug it fixes: a restored hash (the browser keeps
// `#/activity?...` across a reopen; the desktop launcher used to hardcode
// `#/activity`) used to win, so the setting never took effect. startupRouteHash
// resolves the landing hash: a PLAIN tab landing (bare, or carrying only
// transient view state like a range) yields to the configured default; an
// INTENTIONAL destination — debug, settings, a graph focus, or any identity /
// drill-down field that a plain tab hop does NOT carry (a graph focus, or an
// Activity/Commits page-local source/repo/branch/kind/action/unresolved) — is
// kept verbatim. The shared item lens (isource/…/irepo), the search `q`, the
// range, and a mobile sub-tab DO ride a tab hop, so they are transient and a
// reopen carrying them STILL falls to the default.
test("startupRouteHash lands a plain cold start on the configured default tab", () => {
  // A bare restored tab yields to the default.
  assert.equal(startupRouteHash("#/activity", "live"), "#/live");
  assert.equal(startupRouteHash("#/items", "live"), "#/live");
  assert.equal(startupRouteHash("#/board", "live"), "#/live");
  // Transient state rides a plain tab hop, so a reopen carrying ONLY it STILL
  // falls to the default — defeating it would re-break the default-tab fix:
  //   range (the exact original bug)…
  assert.equal(startupRouteHash("#/activity?from=2026-06-15&to=2026-06-21&preset=1w", "live"), "#/live");
  //   …the board/graph item lens (tabHref carries it across hops)…
  assert.equal(startupRouteHash("#/board?istate=open&irepo=o%2Fr", "live"), "#/live");
  //   …a search token…
  assert.equal(startupRouteHash("#/graph?q=flaky", "live"), "#/live");
  //   …and a mobile sub-tab.
  assert.equal(startupRouteHash("#/activity?tab=overview", "live"), "#/live");
  // An empty / hashless open also lands on the default.
  assert.equal(startupRouteHash("", "live"), "#/live");
  assert.equal(startupRouteHash("#/", "activity"), "#/activity");
  // The default is honored whatever it is set to.
  assert.equal(startupRouteHash("#/live", "activity"), "#/activity");
});

test("startupRouteHash preserves parameterized shared links and intentional destinations", () => {
  // Page-local drill-down fields (NOT carried by a plain tab hop) mark an
  // intentional deep-link — keep the whole hash.
  assert.equal(startupRouteHash("#/commits?source=gh&repo=o%2Fr", "live"), "#/commits?source=gh&repo=o%2Fr");
  assert.equal(startupRouteHash("#/activity?source=github.com&kind=review", "live"), "#/activity?source=github.com&kind=review");
  assert.equal(startupRouteHash("#/commits?branch=main", "live"), "#/commits?branch=main");
  assert.equal(startupRouteHash("#/activity?action=merged", "live"), "#/activity?action=merged");
  assert.equal(startupRouteHash("#/activity?unresolved=1", "live"), "#/activity?unresolved=1");
  assert.equal(startupRouteHash("#/graph?focus=gh%3A1", "live"), "#/graph?focus=gh%3A1");
  // A drill-down field present alongside a range still preserves the whole hash.
  assert.equal(
    startupRouteHash("#/activity?source=gh&from=2026-06-15&to=2026-06-21", "live"),
    "#/activity?source=gh&from=2026-06-15&to=2026-06-21",
  );
  // Settings and the hidden debug console are always intentional destinations.
  assert.equal(startupRouteHash("#/settings?tab=sources", "live"), "#/settings?tab=sources");
  assert.equal(startupRouteHash("#/debug", "live"), "#/debug");
  // Already on the default tab: keep the restored hash (its range/search survive).
  assert.equal(startupRouteHash("#/activity?preset=1mo", "activity"), "#/activity?preset=1mo");
  assert.equal(startupRouteHash("#/items?istate=open", "items"), "#/items?istate=open");
  assert.equal(startupRouteHash("#/live", "live"), "#/live");
});

// The Reviews Recent/Grouped toggle is route-backed (?reviewSort=grouped) so a
// reload AND a shared link must keep the choice — including a cold start when the
// configured default tab is not Reviews. Recency is the clean default (no param),
// so a bare #/reviews stays transient and yields to the default like any tab hop.
test("startupRouteHash keeps a bare ?reviewSort cold start on Reviews", () => {
  assert.equal(startupRouteHash("#/reviews?reviewSort=grouped", "activity"), "#/reviews?reviewSort=grouped");
  assert.equal(startupRouteHash("#/reviews?reviewSort=grouped", "live"), "#/reviews?reviewSort=grouped");
  // recency default carries no param -> transient -> yields to the default tab
  assert.equal(startupRouteHash("#/reviews", "activity"), "#/activity");
});

// The Items Open sort is also a deliberate view preference, so cold-starting a
// shared URL keeps Items instead of yielding to the configured default tab.
test("startupRouteHash keeps a bare ?itemSort cold start on Items", () => {
  assert.equal(startupRouteHash("#/items?itemSort=open", "activity"), "#/items?itemSort=open");
  assert.equal(startupRouteHash("#/items?itemSort=open", "live"), "#/items?itemSort=open");
  assert.equal(startupRouteHash("#/items", "activity"), "#/activity");
});

// The Live tab is opt-in (off by default). When it is disabled the configured
// default landing tab cannot be Live — it must fall back to Activity (the next
// content tab) so a fresh open never lands on a hidden tab. Every other default
// is honored unchanged, and when Live is enabled "live" stays the default.
test("resolveDefaultTab falls back off Live only when the Live tab is disabled", () => {
  assert.equal(resolveDefaultTab("live", false), "activity", "Live disabled -> land on Activity");
  assert.equal(resolveDefaultTab("live", true), "live", "Live enabled -> keep Live as the default");
  assert.equal(resolveDefaultTab("board", false), "board", "a non-Live default is never rewritten");
  assert.equal(resolveDefaultTab("items", false), "items");
  assert.equal(resolveDefaultTab("activity", false), "activity");
  assert.equal(resolveDefaultTab("commits", true), "commits");
});

test("liveTabVisible shows the Live tab while connecting, hides it only when definitively unavailable", () => {
  // Connecting (null) keeps the tab visible so a slow seed never strands the user
  // with no way into Live (the chicken-and-egg fix).
  assert.equal(liveTabVisible(true, null), true, "enabled + connecting -> tab shown");
  assert.equal(liveTabVisible(true, true), true, "enabled + connected -> tab shown");
  // connected === false is the definitive "unavailable" (disabled / no server URL /
  // a 4xx no-receiver deploy) -> hide.
  assert.equal(liveTabVisible(true, false), false, "enabled + definitively unavailable -> hidden");
  // The opt-in must be on regardless of the connection state.
  assert.equal(liveTabVisible(false, null), false, "disabled -> hidden even while a stale probe is pending");
  assert.equal(liveTabVisible(false, true), false, "disabled -> hidden even if connected");
});

// The hidden Diagnostics console is split into sub-tabs, URL-backed through the
// shared `tab` field. The first id is the default landing tab and Live leads.
test("DEBUG_TAB_IDS lists every diagnostics tab with Live first as the default", () => {
  assert.deepEqual([...DEBUG_TAB_IDS], ["live", "contract", "store", "sync", "ratelimit", "log"]);
  assert.equal(DEFAULT_DEBUG_TAB, "live", "Live is first, so it is the default landing tab");
  assert.equal(DEBUG_TAB_IDS[0], DEFAULT_DEBUG_TAB);
});

// parseDebugTab is total: a known id round-trips, and anything else (absent,
// stale, hand-typed, or another page's `tab` value) falls to the default so the
// page never blanks.
test("parseDebugTab maps known ids and falls back to the default otherwise", () => {
  for (const id of DEBUG_TAB_IDS) assert.equal(parseDebugTab(id), id);
  assert.equal(parseDebugTab(null), DEFAULT_DEBUG_TAB);
  assert.equal(parseDebugTab(""), DEFAULT_DEBUG_TAB);
  assert.equal(parseDebugTab("nope"), DEFAULT_DEBUG_TAB);
  assert.equal(parseDebugTab("sources"), DEFAULT_DEBUG_TAB, "another page's tab value is not a debug tab");
});

// The default tab carries no `tab` param (clean #/debug); every other tab does.
// Together with parseDebugTab this is a lossless round-trip through the hash.
test("debugTabField drops the default and round-trips every other debug tab through the hash", () => {
  assert.equal(debugTabField(DEFAULT_DEBUG_TAB), null);
  for (const id of DEBUG_TAB_IDS) {
    const hash = buildHashRoute({ page: "debug", tab: debugTabField(id) });
    assert.equal(parseDebugTab(parseHashRoute(hash).tab), id, `#/debug round-trips ${id}`);
  }
  assert.equal(buildHashRoute({ page: "debug", tab: debugTabField(DEFAULT_DEBUG_TAB) }), "#/debug", "default tab keeps #/debug clean");
  assert.equal(buildHashRoute({ page: "debug", tab: debugTabField("store") }), "#/debug?tab=store");
});

// A restored #/debug hash is always an intentional destination — its sub-tab
// must survive a cold start (reload / reopen), not snap back to a default tab.
test("startupRouteHash keeps a debug sub-tab verbatim across a cold start", () => {
  assert.equal(startupRouteHash("#/debug?tab=store", "activity"), "#/debug?tab=store");
  assert.equal(startupRouteHash("#/debug?tab=log", "live"), "#/debug?tab=log");
});
