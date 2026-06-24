import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const publishWorkflow = readFileSync(
  new URL("../.github/workflows/publish-image.yml", import.meta.url),
  "utf8",
);
const repoRoot = new URL("..", import.meta.url);
const oldPrivateWorkflowName = ["deploy", ["g", "14"].join("")].join("-");
const privateHostLabel = ["g", "14"].join("");
const publicSurfaceRoots = [
  ".env.example",
  "README.md",
  "config",
  "docker",
  "docs",
  "src/live/receiver.ts",
];
// Markers stay focused on PRIVATE deployment topology and secrets. The sibling
// public repos (nils-cli, nils-alfredworkflow) are intentionally NOT guarded:
// the Pages demo aggregates them as a public source and renders their data, so
// pretending to hide their names here would only let the codebase drift out of
// step with what the demo already shows.
const privateDeployMarkers = [
  /\bg14\b/i,
  /g14-infra/i,
  /deploy-g14/i,
  /Tailscale Funnel/i,
  /\bfunnel(?:ed|ing|s)?\b/i,
  /tail841b2e/i,
  /serve\.sh/i,
  /GITHUB_TOKEN_SYMPOIES/,
];

function publicSurfaceFiles(): string[] {
  const out: string[] = [];
  const visit = (path: string) => {
    const abs = new URL(`../${path}`, import.meta.url);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(abs)) {
        visit(join(path, entry));
      }
      return;
    }
    if (/\.(md|json|ya?ml|conf|example|ts)$/.test(path)) {
      out.push(path);
    }
  };
  publicSurfaceRoots.forEach(visit);
  return out.sort();
}

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

test("public docs, examples, and deploy templates avoid private deployment details", () => {
  const hits: string[] = [];
  for (const path of publicSurfaceFiles()) {
    const content = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    for (const marker of privateDeployMarkers) {
      if (marker.test(content)) {
        hits.push(`${relative(repoRoot.pathname, new URL(`../${path}`, import.meta.url).pathname)}: ${marker}`);
      }
    }
  }
  assert.deepEqual(hits, []);
});
