import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScope, toLabel } from "../src/model/labels.ts";

test("parseScope extracts the prefix before '::'", () => {
  assert.equal(parseScope("priority::high"), "priority");
  assert.equal(parseScope("workflow::follow-up"), "workflow");
});

test("parseScope returns null for unscoped or empty-scope labels", () => {
  assert.equal(parseScope("bug"), null);
  assert.equal(parseScope("::weird"), null);
});

test("toLabel carries the verbatim name and parsed scope", () => {
  const l = toLabel("priority::high", "FF0000");
  assert.equal(l.name, "priority::high");
  assert.equal(l.scope, "priority");
  assert.equal(l.color, "FF0000");
});
