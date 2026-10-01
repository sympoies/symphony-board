import assert from "node:assert/strict";
import test from "node:test";
import { formatAxisValue, labelClipped, labelShortened, nameTipText, niceAxisMax, rankBarHeight, rankMoreLabel, showsNameTip } from "../src/rank-scale.ts";

test("niceAxisMax rounds up to a 1 / 2 / 5 step so axis ticks stay readable", () => {
  assert.equal(niceAxisMax(1), 1);
  assert.equal(niceAxisMax(7), 10);
  assert.equal(niceAxisMax(12), 20);
  assert.equal(niceAxisMax(37), 50);
  assert.equal(niceAxisMax(412), 500);
  assert.equal(niceAxisMax(981), 1000);
  // An exact step is already nice and must not jump to the next one, or every
  // chart whose leader is a round number would draw with half its plot empty.
  assert.equal(niceAxisMax(500), 500);
  assert.equal(niceAxisMax(1000), 1000);
});

test("niceAxisMax never returns a zero or negative ceiling", () => {
  // The caller divides by this, so a 0 would produce Infinity bar heights. An
  // all-zero rank set is reachable: a range with rows but no counted events.
  assert.equal(niceAxisMax(0), 1);
  assert.equal(niceAxisMax(-5), 1);
});

test("formatAxisValue abbreviates so a tick fits a narrow rail column", () => {
  assert.equal(formatAxisValue(0), "0");
  assert.equal(formatAxisValue(500), "500");
  assert.equal(formatAxisValue(1000), "1k");
  assert.equal(formatAxisValue(16_526), "16.5k");
  assert.equal(formatAxisValue(1_000_000), "1m");
  assert.equal(formatAxisValue(2_450_000), "2.5m");
});

test("rankBarHeight keeps a non-zero count visible against a large leader", () => {
  assert.equal(rankBarHeight(1000, 1000), "100%");
  assert.equal(rankBarHeight(500, 1000), "50%");
  // 1 against 1000 rounds to 0%, which would render an invisible — and so
  // unclickable — row. The floor is what keeps a long tail reachable.
  assert.equal(rankBarHeight(1, 1000), "3%");
  assert.equal(rankBarHeight(0, 1000), "3%");
});

test("rankBarHeight tolerates a zero axis instead of dividing by it", () => {
  assert.equal(rankBarHeight(0, 0), "3%");
  assert.equal(rankBarHeight(5, 0), "3%");
});

test("labelClipped reads a clip on either axis, and a missing name as clipped", () => {
  // Fully visible: the tip would only repeat what the row already shows.
  assert.equal(labelClipped({ scrollWidth: 80, clientWidth: 80, scrollHeight: 16, clientHeight: 16 }), false);
  // A one-pixel rounding difference is not a clip.
  assert.equal(labelClipped({ scrollWidth: 81, clientWidth: 80, scrollHeight: 16, clientHeight: 16 }), false);
  // An ellipsis clips by width...
  assert.equal(labelClipped({ scrollWidth: 240, clientWidth: 120, scrollHeight: 16, clientHeight: 16 }), true);
  // ...a line clamp by height.
  assert.equal(labelClipped({ scrollWidth: 120, clientWidth: 120, scrollHeight: 32, clientHeight: 16 }), true);
  // A footer that draws no name at all (an avatar) leaves the tip as the only
  // place the name can be read.
  assert.equal(labelClipped(null), true);
  assert.equal(labelClipped({ scrollWidth: 0, clientWidth: 0, scrollHeight: 0, clientHeight: 0 }), true);
});

test("labelShortened sees a short form of the name, not a tag beside it", () => {
  assert.equal(labelShortened("nils-cli", "sympoies/nils-cli"), true);
  assert.equal(labelShortened("guard", "feat/overflow-guard"), true);
  assert.equal(labelShortened("maindefault", "main"), false);
  assert.equal(labelShortened("commented", "commented"), false);
});

test("showsNameTip only when the tip says something the row does not", () => {
  assert.equal(showsNameTip({ clipped: false, selectable: false }), false);
  assert.equal(showsNameTip({ clipped: true, selectable: false }), true);
  // A filter row says what a click does even when its name fits.
  assert.equal(showsNameTip({ clipped: false, selectable: true }), true);
});

test("nameTipText names the row and, on a filter row, what a click does", () => {
  assert.equal(nameTipText("sympoies/symphony-board", { selectable: false, selected: false }), "sympoies/symphony-board");
  assert.equal(nameTipText("commented", { selectable: true, selected: false }), "commented · click to filter");
  assert.equal(nameTipText("commented", { selectable: true, selected: true }), "commented · click to clear the filter");
});

test("rankMoreLabel offers every row, or the cap when there are more", () => {
  assert.equal(rankMoreLabel(37, 50), "Show all 37");
  assert.equal(rankMoreLabel(50, 50), "Show all 50");
  assert.equal(rankMoreLabel(817, 50), "Show top 50 of 817");
});
