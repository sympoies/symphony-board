import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const publishWorkflow = readFileSync(
  new URL("../.github/workflows/publish-image.yml", import.meta.url),
  "utf8",
);
const oldPrivateWorkflowName = ["deploy", ["g", "14"].join("")].join("-");
const privateHostLabel = ["g", "14"].join("");

test("public repo does not carry a private self-hosted deploy workflow", () => {
  assert.equal(
    existsSync(new URL(`../.github/workflows/${oldPrivateWorkflowName}.yml`, import.meta.url)),
    false,
    "direct private deploy workflow should live outside the public app repo",
  );
  assert.doesNotMatch(publishWorkflow, /runs-on:\s*\[[^\]]*self-hosted/i);
  assert.equal(publishWorkflow.includes(privateHostLabel), false);
  assert.doesNotMatch(publishWorkflow, /Project\/[^"'\s]+\/secrets|make -C "\$infra"/);
  assert.doesNotMatch(publishWorkflow, /deploy-meta/);
});

test("stable releases can dispatch to a neutral downstream repo", () => {
  assert.match(publishWorkflow, /name: Dispatch downstream release/);
  assert.match(
    publishWorkflow,
    /if: \$\{\{ !github\.event\.release\.prerelease && vars\.DEPLOY_DISPATCH_REPOSITORY != '' \}\}/,
  );
  assert.match(publishWorkflow, /DEPLOY_DISPATCH_REPOSITORY: \$\{\{ vars\.DEPLOY_DISPATCH_REPOSITORY \}\}/);
  assert.match(publishWorkflow, /DEPLOY_DISPATCH_TOKEN: \$\{\{ secrets\.DEPLOY_DISPATCH_TOKEN \}\}/);
  assert.match(publishWorkflow, /https:\/\/api\.github\.com\/repos\/\$\{DEPLOY_DISPATCH_REPOSITORY\}\/dispatches/);
  assert.doesNotMatch(publishWorkflow, /DEPLOY_DISPATCH_REPOSITORY:\s*[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+/);
});
