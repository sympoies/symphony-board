import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const skillPath = fileURLToPath(
  new URL("../.agents/skills/project-review-cleanup/SKILL.md", import.meta.url),
);
const skill = readFileSync(skillPath, "utf8");

test("project-review-cleanup has no dependency on the retired shared cleanup skill", () => {
  assert.doesNotMatch(skill, /`(?:pr:)?review-thread-cleanup`/);
  assert.doesNotMatch(skill, /shared[^\n]*review-thread-cleanup/i);
});

test("project-review-cleanup owns a runnable discovery-to-convergence contract", () => {
  const requiredContracts = [
    "pnpm review-candidates --json",
    "forge-cli --provider github --repo <repo> --format json pr review-threads list <pr>",
    "core/policies/review-thread-convergence.md",
    "code-review-specialists",
    "pr:deliver-pr",
    "pr review-threads reply",
    "pr review-threads resolve",
    "data.unresolved == 0",
  ];

  for (const contract of requiredContracts) {
    assert.ok(skill.includes(contract), `missing canonical cleanup contract: ${contract}`);
  }
});

test("project-review-cleanup keeps provider writes on released forge-cli surfaces", () => {
  assert.doesNotMatch(skill, /gh\s+pr\s+(?:comment|review|merge)/);
  assert.doesNotMatch(skill, /gh\s+api[^\n]*(?:--method|-X)\s+(?:POST|PUT|PATCH|DELETE)/i);
  assert.doesNotMatch(skill, /glab\s+mr\s+(?:note|approve|merge)/);
});
