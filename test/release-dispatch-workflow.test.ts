import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

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
  assert.match(publishWorkflow, /DEPLOY_DISPATCH_WORKFLOW: \$\{\{ vars\.DEPLOY_DISPATCH_WORKFLOW \}\}/);
  assert.match(publishWorkflow, /DEPLOY_DISPATCH_TOKEN: \$\{\{ secrets\.DEPLOY_DISPATCH_TOKEN \}\}/);
  assert.match(publishWorkflow, /--arg run_id "\$GITHUB_RUN_ID"/);
  assert.match(publishWorkflow, /--arg run_attempt "\$GITHUB_RUN_ATTEMPT"/);
  assert.match(
    publishWorkflow,
    /DISPATCH_EXPECT_WORKFLOW="\$DEPLOY_DISPATCH_WORKFLOW" \\\n\s*DISPATCH_EXPECT_RUN_NAME="\$DEPLOY_DISPATCH_EVENT_TYPE \$version from \$GITHUB_RUN_ID\.\$GITHUB_RUN_ATTEMPT"/,
  );
  // The POST itself lives in scripts/ci/dispatch-release.sh, which asserts the
  // response status. Both dispatch paths must go through it: an inline curl
  // gets neither shellcheck nor the status gate below.
  assert.match(
    publishWorkflow,
    /DISPATCH_TOKEN="\$DEPLOY_DISPATCH_TOKEN" \\\n\s*DISPATCH_EXPECT_WORKFLOW="\$DEPLOY_DISPATCH_WORKFLOW" \\\n\s*DISPATCH_EXPECT_RUN_NAME="\$DEPLOY_DISPATCH_EVENT_TYPE \$version from \$GITHUB_RUN_ID\.\$GITHUB_RUN_ATTEMPT" \\\n\s*scripts\/ci\/dispatch-release\.sh "\$DEPLOY_DISPATCH_REPOSITORY"/,
  );
  assert.match(
    publishWorkflow,
    /DISPATCH_TOKEN="\$HOMEBREW_TAP_DISPATCH_TOKEN" \\\n\s*scripts\/ci\/dispatch-release\.sh "\$HOMEBREW_TAP_DISPATCH_REPOSITORY"/,
  );
  assert.doesNotMatch(publishWorkflow, /api\.github\.com\/repos\/[^\n]*\/dispatches/);
  assert.doesNotMatch(publishWorkflow, /DEPLOY_DISPATCH_REPOSITORY:\s*[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+/);
});

// `curl -f` fails only on 4xx and 5xx, so the 307 GitHub returns for a renamed
// or transferred repository used to exit 0 and drop the dispatch silently.
// These run the real script against a stubbed curl, so the status gate is
// enforced offline rather than trusted.
function runDispatch(curlStdout: string, curlExit: number) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-release-test-"));
  try {
    const stub = join(dir, "curl");
    writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s' '${curlStdout}'\nexit ${curlExit}\n`);
    chmodSync(stub, 0o755);
    return spawnSync(
      fileURLToPath(new URL("../scripts/ci/dispatch-release.sh", import.meta.url)),
      ["owner/repo"],
      {
        input: '{"event_type":"probe"}',
        encoding: "utf8",
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DISPATCH_TOKEN: "stub" },
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runObservedDispatch(workflowRuns: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-release-observation-test-"));
  try {
    const stub = join(dir, "curl");
    writeFileSync(
      stub,
      `#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
while (( $# > 0 )); do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
if [[ "$url" == */dispatches ]]; then
  printf '204'
  exit 0
fi
test -n "$output"
printf '%s' "$CURL_WORKFLOW_RUNS" >"$output"
printf '200'
`,
    );
    chmodSync(stub, 0o755);
    return spawnSync(
      fileURLToPath(new URL("../scripts/ci/dispatch-release.sh", import.meta.url)),
      ["owner/repo"],
      {
        input: '{"event_type":"probe"}',
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          CURL_WORKFLOW_RUNS: JSON.stringify(workflowRuns),
          DISPATCH_TOKEN: "stub",
          DISPATCH_EXPECT_WORKFLOW: "symphony-board-bump.yml",
          DISPATCH_EXPECT_RUN_NAME: "probe 1.13.3 from 42.1",
          DISPATCH_EXPECT_TIMEOUT_SECONDS: "0",
          DISPATCH_EXPECT_POLL_SECONDS: "0",
        },
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a dispatch is only reported delivered when GitHub answers 204", () => {
  const accepted = runDispatch("204", 0);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /HTTP 204/);
});

test("a configured downstream workflow must be observed through successful completion", () => {
  const result = runObservedDispatch({
    workflow_runs: [
      {
        id: 123,
        event: "repository_dispatch",
        display_title: "probe 1.13.3 from 42.1",
        status: "completed",
        conclusion: "success",
        html_url: "https://example.invalid/runs/123",
      },
    ],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /downstream workflow completed successfully/);
});

test("an accepted dispatch fails when its correlated downstream run never appears", () => {
  const result = runObservedDispatch({ workflow_runs: [] });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /matching downstream workflow run was not observed/);
});

test("a correlated downstream workflow failure fails the dispatch", () => {
  const result = runObservedDispatch({
    workflow_runs: [
      {
        id: 124,
        event: "repository_dispatch",
        display_title: "probe 1.13.3 from 42.1",
        status: "completed",
        conclusion: "failure",
        html_url: "https://example.invalid/runs/124",
      },
    ],
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /downstream workflow concluded failure/);
});

test("a redirect from a transferred repository fails instead of passing silently", () => {
  const moved = runDispatch("307", 0);
  assert.equal(moved.status, 1, "a 3xx must fail: the dispatch was never delivered");
  assert.match(moved.stderr, /returned HTTP 307, expected 204/);
  assert.match(moved.stderr, /renamed or transferred/);
});

test("a rejected token and an unreachable API each fail with their own cause", () => {
  const forbidden = runDispatch("403", 0);
  assert.equal(forbidden.status, 1);
  assert.match(forbidden.stderr, /write access/);

  // curl prints 000 and exits non-zero when it never connects; the script must
  // not concatenate a second fallback onto that.
  const unreachable = runDispatch("000", 7);
  assert.equal(unreachable.status, 1);
  assert.match(unreachable.stderr, /returned HTTP 000, expected 204/);
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
