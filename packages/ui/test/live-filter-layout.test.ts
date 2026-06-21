import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const multiSelectSrc = readFileSync(
  new URL("../src/components/MultiSelect.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

function mobileLiveFilterCss(): string {
  const start = styles.indexOf("@media (max-width: 760px)");
  const end = styles.indexOf("@media (prefers-reduced-motion", start);
  assert.ok(start >= 0, "mobile live filter media query exists");
  assert.ok(end > start, "mobile live filter media query has a bounded block");
  return styles.slice(start, end);
}

test("MultiSelect stays enabled when a stale active selection has no available options", () => {
  assert.doesNotMatch(
    multiSelectSrc,
    /const disabled = available === 0;/,
    "available=0 alone must not disable the clear path",
  );
  assert.match(
    multiSelectSrc,
    /const disabled = available === 0 && count === 0;/,
    "only an empty selection with no options is disabled",
  );
});

test("mobile Live filters do not reorder focusable groups with flex order", () => {
  const mobile = mobileLiveFilterCss();
  assert.doesNotMatch(
    mobile,
    /\.live-(selects|cats)\s*\{[^}]*\border\s*:/,
    "visual order must follow DOM focus order",
  );
});

test("mobile Live multi-select menus are constrained to the filter bar width", () => {
  const mobile = mobileLiveFilterCss();
  assert.match(
    mobile,
    /\.live-filters\s*\{[^}]*\bposition:\s*relative\b[^}]*\}/,
    "the filter bar anchors full-width mobile dropdowns",
  );
  assert.match(
    mobile,
    /\.live-selects \.ms\s*\{[^}]*\bposition:\s*static\b[^}]*\}/,
    "mobile dropdowns should be positioned against the filter bar, not an inboard trigger",
  );
  assert.match(
    mobile,
    /\.live-selects \.ms-menu\s*\{[^}]*\bleft:\s*0;[^}]*\bright:\s*0;[^}]*\bmax-width:\s*none\b[^}]*\}/,
    "mobile dropdowns should not extend off either viewport edge",
  );
});
