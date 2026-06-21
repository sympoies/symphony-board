import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../.github/workflows/deploy-g14.yml", import.meta.url),
  "utf8",
);
const workflowLines = workflow.split(/\r?\n/);

function topLevelBlock(name: string): string {
  const start = workflowLines.findIndex((line) => line === `${name}:`);
  assert.notEqual(start, -1, `workflow has top-level ${name}: block`);
  const block: string[] = [];
  for (const line of workflowLines.slice(start + 1)) {
    if (/^[^\s#]/.test(line)) break;
    block.push(line);
  }
  return block.join("\n");
}

function deployRunScript(): string {
  const start = workflowLines.findIndex(
    (line) => line === "      - name: Pull deploy inputs and run the g14-infra health gate",
  );
  assert.notEqual(start, -1, "workflow has the smoke-gated deploy step");
  const run = workflowLines.findIndex(
    (line, index) => index > start && line === "        run: |",
  );
  assert.notEqual(run, -1, "deploy step has a run block");
  const script: string[] = [];
  for (const line of workflowLines.slice(run + 1)) {
    if (line !== "" && !line.startsWith("          ")) break;
    script.push(line.replace(/^          /, ""));
  }
  return script.join("\n");
}

function executableLines(script: string): string[] {
  return script
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

test("deploy-g14 delegates deployment to the g14-infra health gate", () => {
  const lines = executableLines(deployRunScript());
  const infraRefresh = lines.findIndex((line) =>
    /^git -C "\$infra"\s+fetch --quiet origin main && git -C "\$infra"\s+reset --hard origin\/main$/.test(
      line,
    ),
  );
  const secretsRefresh = lines.findIndex((line) =>
    /^git -C "\$secrets"\s+fetch --quiet origin main && git -C "\$secrets"\s+reset --hard origin\/main$/.test(
      line,
    ),
  );
  const deploy = lines.indexOf('make -C "$infra" deploy STACK=symphony-board');

  assert.notEqual(infraRefresh, -1, "the deploy runner refreshes the trusted g14-infra checkout");
  assert.notEqual(secretsRefresh, -1, "the deploy runner refreshes the trusted secrets checkout");
  assert.notEqual(deploy, -1, "the app workflow calls the g14-infra deploy gate");
  assert.ok(infraRefresh < deploy, "g14-infra is refreshed before calling the deploy gate");
  assert.ok(secretsRefresh < deploy, "secrets are refreshed before calling the deploy gate");
});

test("deploy-g14 does not duplicate the infra deploy implementation", () => {
  const script = deployRunScript();
  assert.doesNotMatch(
    script,
    /render\.sh" symphony-board/,
    "rendering secrets is owned by g14-infra make deploy",
  );
  assert.doesNotMatch(
    script,
    /live-allowlist\.sh/,
    "Live allowlist derivation is owned by g14-infra make deploy",
  );
  assert.doesNotMatch(
    script,
    /resolve_live_config_basename/,
    "source config basename parsing is owned by g14-infra make deploy",
  );
  assert.doesNotMatch(
    script,
    /docker compose --env-file \.env up -d/,
    "compose reconciliation is owned by the smoke-gated g14-infra make deploy target",
  );
});

test("deploy-g14 remains release/manual only and never runs PR-provided code on g14", () => {
  const triggers = topLevelBlock("on");
  assert.match(triggers, /^  workflow_run:\n    workflows: \["publish-image"\]\n    types: \[completed\]/m);
  assert.match(triggers, /^  workflow_dispatch:/m);
  assert.doesNotMatch(triggers, /^  pull_request:/m);
  assert.doesNotMatch(triggers, /^  pull_request_target:/m);
  assert.doesNotMatch(workflow, /uses:\s*actions\/checkout(?:@|$)/);
});
