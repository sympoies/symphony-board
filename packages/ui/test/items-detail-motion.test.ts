import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const stylesSource = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const itemsPageSource = readFileSync(new URL("../src/components/ItemsPage.tsx", import.meta.url), "utf8");

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = stylesSource.match(new RegExp(`${escaped}\\s*{[^}]*}`, "s"));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[0];
}

function cssRuleContaining(selector: string, pattern: RegExp, message: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...stylesSource.matchAll(new RegExp(`${escaped}\\s*{[^}]*}`, "gs"))].map((match) => match[0]);
  const rule = matches.find((candidate) => pattern.test(candidate));
  assert.ok(rule, message);
  return rule;
}

function jsxTagWithClass(className: string): string {
  const match = itemsPageSource.match(new RegExp(`<[A-Za-z][^>]*className="${className}"[^>]*>`, "s"));
  assert.ok(match, `missing JSX tag with className="${className}"`);
  return match[0];
}

test("Items detail remounts selected content so the detail accent replays", () => {
  const shellTag = jsxTagWithClass("items-detail-shell");
  assert.match(shellTag, /\bkey={item\.id}/, "the selected item detail shell should remount when a different item is selected");
});

test("Items detail reuses the Live detail reveal and accent frame", () => {
  assert.match(
    cssRule(".items-detail-shell"),
    /animation: live-detail-in 360ms/,
    "item detail content should use the same deliberate reveal as Live and Reviews detail",
  );
  assert.match(
    cssRule(".items-detail-shell::before"),
    /animation: live-detail-accent 1600ms/,
    "item detail swaps should include the same fading accent frame as Live and Reviews detail",
  );
  assert.match(
    stylesSource,
    /\.items-detail-shell::before\s*{ animation: none; }/,
    "reduced-motion should disable the item detail accent animation",
  );
});

test("Items detail uses a neutral detail accent variable", () => {
  assert.match(
    jsxTagWithClass("items-detail-shell"),
    /"--detail-accent": accentColor/,
    "the selected repo/source color should feed the detail-frame accent variable",
  );
  assert.match(
    cssRule(".items-detail-shell::before"),
    /var\(--detail-accent, var\(--accent\)\)/,
    "items detail frame should use the neutral detail accent variable",
  );
  assert.match(
    cssRuleContaining(
      ".live-detail-shell",
      /--detail-accent: var\(--cat, var\(--live\)\)/,
      "Live and Reviews detail should map their existing category/status color into the neutral detail accent variable",
    ),
    /--detail-accent: var\(--cat, var\(--live\)\)/,
    "Live and Reviews detail should map their existing category/status color into the neutral detail accent variable",
  );
});
