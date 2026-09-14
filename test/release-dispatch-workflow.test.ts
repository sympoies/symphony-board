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
const releaseScript = readFileSync(new URL("../scripts/release.sh", import.meta.url), "utf8");
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
  // `github.event_name == 'release'` is load-bearing, not decoration: on a
  // manual run `github.event.release` is absent, so `!…prerelease` reads as
  // true and a build-only run would deploy to production.
  assert.match(
    publishWorkflow,
    /if: \$\{\{ github\.event_name == 'release' && !github\.event\.release\.prerelease && vars\.DEPLOY_DISPATCH_REPOSITORY != '' \}\}/,
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

function runObservedDispatch(
  workflowRuns: unknown,
  envOverrides: Record<string, string> = {},
  lookupDelaySeconds = 0,
) {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-release-observation-test-"));
  try {
    const stub = join(dir, "curl");
    writeFileSync(
      stub,
      `#!/usr/bin/env bash
set -euo pipefail
output=""
url=""
max_time=""
while (( $# > 0 )); do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    --max-time) max_time="$2"; shift 2 ;;
    --connect-timeout) shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
if [[ "$url" == */dispatches ]]; then
  printf '204'
  exit 0
fi
test -n "$output"
if (( ${lookupDelaySeconds} > 0 )); then
  test -n "$max_time"
  sleep "$max_time"
fi
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
          DISPATCH_EXPECT_TIMEOUT_SECONDS: "1",
          DISPATCH_EXPECT_POLL_SECONDS: "1",
          ...envOverrides,
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

test("downstream observation remains bounded when lookup and poll exceed the deadline", () => {
  const startedAt = Date.now();
  const result = runObservedDispatch(
    { workflow_runs: [] },
    {
      DISPATCH_EXPECT_TIMEOUT_SECONDS: "1",
      DISPATCH_EXPECT_POLL_SECONDS: "30",
    },
    30,
  );
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.status, 1);
  assert.match(result.stderr, /matching downstream workflow run was not observed/);
  assert.ok(elapsedMs < 3000, `observation exceeded its deadline: ${elapsedMs}ms`);
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

// publish-image.yml only ran on `release: published`, so every edit to it
// shipped unverified -- an arm64 build that died under QEMU cost v1.22.0 its
// images. `workflow_dispatch` makes the file testable, and these guard the
// property that makes a manual run safe to fire: by default it must change
// nothing that outlives the run.
test("a manual run builds without publishing anything", () => {
  assert.match(publishWorkflow, /^  workflow_dispatch:$/m);
  assert.match(publishWorkflow, /^      tag:\n        description: "Existing release tag/m);
  // Defaulting `push` to false is the whole safety property.
  assert.match(publishWorkflow, /^      push:\n(?:.*\n)*?        default: false$/m);

  // Nothing pushes unconditionally: every image push reads PUBLISH, which is
  // true for a release and only true for a manual run that opted in.
  assert.doesNotMatch(publishWorkflow, /^\s+push: true$/m);
  assert.equal(publishWorkflow.match(/^\s+push: \$\{\{ env\.PUBLISH == 'true' \}\}$/gm)?.length, 2);
  assert.match(
    publishWorkflow,
    /PUBLISH: \$\{\{ github\.event_name != 'workflow_dispatch' \|\| inputs\.push \}\}/,
  );

  // RELEASE_TAG is the half that makes a manual run build the tag it was asked
  // for. Reverting any of these to the trigger ref leaves the guards above
  // intact while the run builds the wrong thing: the version gate would compare
  // a branch name to itself, the desktop assets would be named after the
  // branch, and the image tags would lose their semver value entirely.
  assert.match(
    publishWorkflow,
    /RELEASE_TAG: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.tag \|\| github\.event\.release\.tag_name \}\}/,
  );
  assert.match(publishWorkflow, /run: scripts\/check-release-version\.sh "\$RELEASE_TAG"/);
  assert.equal(
    publishWorkflow.match(/type=semver,pattern=\{\{version\}\},value=\$\{\{ env\.RELEASE_TAG \}\}/g)?.length,
    2,
  );
  assert.match(publishWorkflow, /gh release upload "\$RELEASE_TAG"/);
  // Every job that checks out must check out the requested tag, counted as a
  // set so a job added later cannot quietly check out the triggering ref.
  const checkouts = publishWorkflow.match(/uses: actions\/checkout@/g)?.length ?? 0;
  assert.ok(checkouts > 0, "no checkouts found; the ref guard is not guarding");
  assert.equal(
    publishWorkflow.match(/ref: refs\/tags\/\$\{\{ env\.RELEASE_TAG \}\}/g)?.length,
    checkouts,
    "a checkout does not pin refs/tags/\${{ env.RELEASE_TAG }}",
  );
  // `tag` is free text. Fully qualifying the ref is what stops it naming a
  // BRANCH -- a collaborator could otherwise push `v9.9.9` with a matching
  // package.json and have its Dockerfile built and published as a release.
  assert.doesNotMatch(publishWorkflow, /ref: \$\{\{ env\.RELEASE_TAG \}\}/);
  assert.match(publishWorkflow, /git ls-remote --exit-code --tags origin "refs\/tags\/\$RELEASE_TAG"/);

  // RELEASE_TAG is the single resolver: nothing may derive the tag from the ref
  // that happened to trigger the run.
  assert.doesNotMatch(publishWorkflow, /GITHUB_REF_NAME/);

  // The concurrency group has to name the tag, not the triggering ref, or a
  // publishing manual run and the release run for the same tag land in
  // different groups and race each other's GHCR tags and release assets.
  assert.match(
    publishWorkflow,
    /group: publish-image-\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.tag \|\| github\.event\.release\.tag_name \}\}/,
  );

  // `latest` is the tag a bad manual run would do the most damage to, so it
  // needs both a real non-prerelease AND permission to publish.
  assert.equal(
    publishWorkflow.match(
      /type=raw,value=latest,enable=\$\{\{ env\.MOVE_LATEST == 'true' && env\.PUBLISH == 'true' \}\}/g,
    )?.length,
    2,
  );
  assert.match(
    publishWorkflow,
    /MOVE_LATEST: \$\{\{ github\.event_name == 'release' && !github\.event\.release\.prerelease \}\}/,
  );

  // A manual run builds the desktop apps to prove packaging still works, but
  // must not clobber a live release's assets with them.
  assert.match(
    publishWorkflow,
    /- name: Upload desktop release assets\n(?:\s*#[^\n]*\n)*\s+if: \$\{\{ env\.PUBLISH == 'true' \}\}/,
  );

  // Both dispatches fire only for a real release, checked as a set rather than
  // one by one so a future third one cannot quietly skip the guard.
  const dispatchConditions = publishWorkflow
    .split("\n")
    .filter((line) => /if:.*DISPATCH_REPOSITORY != ''/.test(line));
  assert.equal(dispatchConditions.length, 2, "expected a guarded condition per dispatch target");
  for (const line of dispatchConditions) {
    assert.match(line, /github\.event_name == 'release' &&/, `dispatch is not release-only: ${line.trim()}`);
  }
});

test("the release is verified complete by CI rather than by whoever cut it", () => {
  // release.sh --execute no longer waits, so this job is the only thing that
  // checks the desktop assets reached the Release.
  assert.match(publishWorkflow, /^  release-complete:$/m);
  assert.match(publishWorkflow, /^    needs: \[publish, desktop\]$/m);

  // Inverting or deleting this condition skips the job on every real release
  // while looking correct, and `release.sh --execute` no longer verifies
  // anything, so nothing anywhere would check the assets. Asserted positively;
  // the env-context test below only says what it must NOT be.
  assert.match(
    publishWorkflow,
    /^  release-complete:\n(?:.*\n)*?    if: \$\{\{ github\.event_name != 'workflow_dispatch' \|\| inputs\.push \}\}$/m,
  );
  // That condition is a hand-copy of PUBLISH, because the env context is not
  // available in a job-level `if`. Copies drift; this pins them equal.
  const publishExpression = /PUBLISH: \$\{\{ (.+) \}\}/.exec(publishWorkflow)?.[1];
  assert.ok(publishExpression, "could not read the PUBLISH expression");
  const releaseCompleteCondition = /^  release-complete:\n(?:.*\n)*?    if: \$\{\{ (.+) \}\}$/m.exec(
    publishWorkflow,
  )?.[1];
  assert.equal(releaseCompleteCondition, publishExpression);

  // The failure path is the job. Without an exact-match grep a truncated or
  // renamed asset satisfies the check by substring; without the non-zero exit
  // the job prints MISSING and still goes green.
  assert.match(publishWorkflow, /grep -Fxq -- "\$asset"/);
  assert.match(publishWorkflow, /missing=1/);
  assert.match(publishWorkflow, /test "\$missing" -eq 0 \|\| \{\n(?:.*\n)*?\s+exit 1\n/);
  for (const asset of [
    "Symphony-Board-v\${version}-macos-arm64-unsigned.zip",
    "Symphony-Board-Standalone-v\${version}-macos-arm64-unsigned.zip",
    "SHA256SUMS-v\${version}-macos-arm64.txt",
  ]) {
    assert.ok(publishWorkflow.includes(asset), `release-complete does not check ${asset}`);
    // release.sh keeps its own copy for --wait/--resume/--verify-only. It is no
    // longer on the default path, so nothing would notice it drifting.
    assert.ok(releaseScript.includes(asset), `scripts/release.sh no longer checks ${asset}`);
  }
});

test("no job-level condition reads the env context", () => {
  // GitHub does not expose `env` in `jobs.<id>.if`; it evaluates to empty, so
  // `env.PUBLISH == 'true'` is silently false and the job never runs. Steps
  // may use it, jobs may not -- and the difference is four spaces of
  // indentation, which is exactly the kind of thing that survives review.
  // Both this guard and the dispatch-set guard read one line at a time, so a
  // condition written as a folded scalar would slip past the very check meant
  // to catch it. Enforce the assumption instead of resting on it.
  assert.doesNotMatch(publishWorkflow, /^\s*if: [>|]/m);

  const jobLevelConditions = publishWorkflow
    .split("\n")
    .filter((line) => /^ {4}if:/.test(line));
  assert.ok(jobLevelConditions.length > 0, "no job-level conditions found; the guard is not guarding");
  for (const line of jobLevelConditions) {
    assert.doesNotMatch(line, /\benv\./, `job-level condition reads env: ${line.trim()}`);
  }
});
