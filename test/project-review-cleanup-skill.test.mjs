import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const skillPath = fileURLToPath(
  new URL("../.agents/skills/project-review-cleanup/SKILL.md", import.meta.url),
);
const skill = readFileSync(skillPath, "utf8");

const rawProviderWriteFixtures = [
  "gh api graphql -f query='mutation { resolveReviewThread(input: {}) { clientMutationId } }'",
  String.raw`gh api graphql \
    -f query=@resolve-thread.graphql`,
  "glab api projects/1/merge_requests/2/notes --method POST",
];

const arbitraryThreadFixture = {
  total: 250,
  unresolved: 0,
  completeness: { threads: true, comments: true },
  threads: Array.from({ length: 250 }, (_, index) => ({
    id: `thread-${index + 1}`,
    resolved: true,
  })),
};

const replySucceededResolveFailedFixture = {
  dispositionReplyUrl: "https://github.com/example/repo/pull/1#discussion_r1",
  recoveryTrace: [
    { operation: "read-full-context", replies: [], resolved: false },
    { operation: "reply", result: "pass" },
    {
      operation: "read-full-context",
      replies: ["https://github.com/example/repo/pull/1#discussion_r1"],
      resolved: false,
    },
    { operation: "resolve", result: "ambiguous" },
    {
      operation: "read-full-context",
      replies: ["https://github.com/example/repo/pull/1#discussion_r1"],
      resolved: false,
    },
    { operation: "resolve", result: "pass" },
  ],
  changedContextRecovery: [
    { operation: "read-full-context", participantContextChanged: true },
    { operation: "triage" },
  ],
};

function assertNoRawProviderWrites(text) {
  assert.doesNotMatch(text, /\bgh\s+api\b/i);
  assert.doesNotMatch(text, /\bglab\s+api\b/i);
  assert.doesNotMatch(text, /\bgh\s+pr\s+(?:comment|review|merge)\b/i);
  assert.doesNotMatch(text, /\bglab\s+mr\s+(?:note|approve|merge)\b/i);
}

function workflowSection(startHeading, endHeading) {
  const start = skill.indexOf(startHeading);
  const end = skill.indexOf(endHeading, start + startHeading.length);
  assert.notEqual(start, -1, `missing workflow heading: ${startHeading}`);
  assert.notEqual(end, -1, `missing workflow heading: ${endHeading}`);
  return skill.slice(start, end);
}

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
  assertNoRawProviderWrites(skill);

  for (const fixture of rawProviderWriteFixtures) {
    assert.throws(
      () => assertNoRawProviderWrites(fixture),
      assert.AssertionError,
      `raw provider mutation fixture bypassed the guard: ${fixture}`,
    );
  }
});

test("project-review-cleanup separates reply and resolve with re-read-before-retry recovery", () => {
  const mutationWorkflow = workflowSection(
    "### 5. Reply and resolve through forge-cli",
    "### 6. Prove live convergence",
  );

  assert.match(mutationWorkflow, /full thread\/reply context/i);
  assert.match(mutationWorkflow, /exactly one disposition reply/i);
  assert.match(mutationWorkflow, /retain[^\n]*(?:comment|reply)[^\n]*(?:id|URL)/i);
  assert.match(mutationWorkflow, /re-read[^\n]*before[^\n]*retry/i);
  assert.match(mutationWorkflow, /skip[^\n]*reply[^\n]*already exists/i);
  assert.match(mutationWorkflow, /resolve[^\n]*without (?:a )?note/i);
  assert.match(
    mutationWorkflow,
    /return to triage[\s\S]{0,80}context[\s\S]{0,30}changed/i,
  );
  assert.doesNotMatch(
    mutationWorkflow,
    /pr review-threads resolve[^\n]*(?:--note|--note-file)/,
  );

  const operations = replySucceededResolveFailedFixture.recoveryTrace.map(
    ({ operation }) => operation,
  );
  assert.deepEqual(operations, [
    "read-full-context",
    "reply",
    "read-full-context",
    "resolve",
    "read-full-context",
    "resolve",
  ]);
  assert.equal(operations.filter((operation) => operation === "reply").length, 1);
  assert.equal(operations.filter((operation) => operation === "resolve").length, 2);
  assert.deepEqual(
    replySucceededResolveFailedFixture.recoveryTrace[4].replies,
    [replySucceededResolveFailedFixture.dispositionReplyUrl],
  );
  assert.deepEqual(
    replySucceededResolveFailedFixture.changedContextRecovery.map(
      ({ operation }) => operation,
    ),
    ["read-full-context", "triage"],
  );
});

test("project-review-cleanup accepts arbitrary thread counts only with explicit completeness", () => {
  assert.equal(arbitraryThreadFixture.total, 250);
  assert.equal(arbitraryThreadFixture.threads.length, 250);
  assert.equal(arbitraryThreadFixture.unresolved, 0);
  assert.deepEqual(arbitraryThreadFixture.completeness, {
    threads: true,
    comments: true,
  });

  const refreshEvidence = workflowSection(
    "### 2. Refresh live provider evidence",
    "### 3. Triage every unresolved thread",
  );
  const finalConvergence = workflowSection(
    "### 6. Prove live convergence",
    "## Output",
  );

  assert.doesNotMatch(skill, /data\.total\s*(?:>=|<)\s*100/);
  for (const section of [refreshEvidence, finalConvergence]) {
    assert.match(section, /data\.completeness\.threads\s*==\s*true/);
    assert.match(section, /data\.completeness\.comments\s*==\s*true/);
    assert.match(section, /missing, false, or non-boolean/);
    assert.match(section, /(?:incomplete|partial)[^\n]*evidence/i);
    assert.match(section, /data\.unresolved\s*==\s*0/);
  }
  assert.match(refreshEvidence, /arbitrary[^\n]*review threads/);
  assert.match(refreshEvidence, /threads\[\*\]\.comments/);
  assert.match(finalConvergence, /no fixed[^\n]*limit/i);
});
