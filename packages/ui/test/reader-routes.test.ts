import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHashRoute, parseHashRoute } from "../src/model.ts";
import { inPageHref } from "../src/nav.ts";
import { detailRouteController } from "../src/detail-route.ts";
import { detailNavigation, detailSwipeMove, scrollCanConsumeSwipe } from "../src/detail-navigation.ts";

test("Commits phone reader state survives route serialization for Back navigation", () => {
  const hash = "#/commits?repo=team%2Frepo&commitDetail=1";
  assert.equal(buildHashRoute(parseHashRoute(hash)), hash);
});

test("same-page facet, search and range edits keep mobile view, reader and sort", () => {
  for (const hash of [
    "#/graph?focus=issue&depth=3&tab=graph",
    "#/activity?source=github&kind=review&unresolved=1&tab=overview",
    "#/commits?repo=team%2Frepo&branch=main&author=terry&commitDetail=1",
    "#/items?itemDetail=1&itemSort=open",
    "#/reviews?reviewDetail=1&reviewSort=grouped",
    "#/live?liveDetail=1",
  ]) {
    const route = parseHashRoute(hash);
    const edited = parseHashRoute(inPageHref(route, { q: "needle", isource: "github", from: "2026-09-01", to: "2026-09-30", preset: "1m" }));
    assert.deepEqual({ ...edited, q: null, isource: null, from: null, to: null, preset: null }, route);
  }
});

test("each reader owns one history entry; restored flags close without leaving the page", () => {
  for (const [page, field] of [["live", "liveDetail"], ["reviews", "reviewDetail"], ["items", "itemDetail"], ["commits", "commitDetail"]]) {
    let hash = "#/" + page + "?q=needle";
    let state: unknown = { unrelated: true };
    const entries: string[] = [hash];
    let back = 0;
    const controller = detailRouteController(page as "live" | "reviews" | "items" | "commits", {
      readHash: () => hash,
      setHash: (next) => { hash = next; },
      history: {
        get state() { return state; },
        pushState(data, _unused, url) { state = data; entries.push(String(url)); },
        replaceState(data, _unused, url) { state = data; entries[entries.length - 1] = String(url); },
        back() { back++; entries.pop(); },
      },
    });
    controller.open();
    assert.equal(new URLSearchParams(hash.split("?")[1]).get(field), "1");
    controller.open();
    assert.equal(entries.length, 2, "repeated selection has one overlay entry");
    controller.close();
    assert.equal(back, 1);
    assert.equal(hash, "#/" + page + "?q=needle");
    hash += "&" + field + "=1";
    state = { unrelated: true };
    controller.close();
    assert.equal(back, 1, "shared/restored flag is replaced");
    assert.deepEqual(state, { unrelated: true });
    assert.equal(hash, "#/" + page + "?q=needle");
  }
});

test("reader boundaries and gestures keep scrollable content in control", () => {
  assert.deepEqual(detailNavigation(["new", "old"], 0), { index: 0, position: 1, total: 2, previous: null, next: "old" });
  assert.equal(detailNavigation(["new", "old"], 1).next, null);
  assert.equal(detailNavigation(["new", "old"], -1).next, null);
  assert.equal(detailSwipeMove(-80, 10, 300), "next");
  assert.equal(detailSwipeMove(80, 10, 300), "previous");
  assert.equal(detailSwipeMove(40, 10, 300), null);
  assert.equal(detailSwipeMove(80, 80, 300), null);
  assert.equal(detailSwipeMove(80, 10, 1200), null);
  assert.equal(scrollCanConsumeSwipe(500, 200, 0, -80), true);
  assert.equal(scrollCanConsumeSwipe(500, 200, 300, -80), false);
  assert.equal(scrollCanConsumeSwipe(500, 200, 300, 80), true);
  assert.equal(scrollCanConsumeSwipe(200, 200, 0, -80), false);
});
