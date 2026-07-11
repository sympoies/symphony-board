import assert from "node:assert/strict";
import test from "node:test";
import { resetDetailScroll } from "../src/detail-scroll.ts";

class FakeScrollTarget {
  scrollTop: number;
  descendants: FakeScrollTarget[];

  constructor(scrollTop: number, descendants: FakeScrollTarget[] = []) {
    this.scrollTop = scrollTop;
    this.descendants = descendants;
  }

  querySelectorAll(selector: string): FakeScrollTarget[] {
    assert.equal(selector, "[data-detail-scroll]");
    return this.descendants;
  }
}

test("detail identity changes reset both desktop and mobile scroll containers", () => {
  const mobileCard = new FakeScrollTarget(640);
  const root = new FakeScrollTarget(320, [mobileCard]);

  resetDetailScroll(root as unknown as HTMLElement);

  assert.equal(root.scrollTop, 0);
  assert.equal(mobileCard.scrollTop, 0);
});

test("detail scroll reset tolerates an absent detail root", () => {
  assert.doesNotThrow(() => resetDetailScroll(null));
});
