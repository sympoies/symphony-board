import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../.github/workflows/deploy-g14.yml", import.meta.url),
  "utf8",
);

test("deploy-g14 delegates deployment to the g14-infra health gate", () => {
  assert.match(
    workflow,
    /make\s+-C "\$infra"\s+deploy STACK=symphony-board/,
    "the app workflow must call the g14-infra deploy gate",
  );
  assert.match(
    workflow,
    /git -C "\$infra"\s+fetch --quiet origin main && git -C "\$infra"\s+reset --hard origin\/main/,
    "the deploy runner should refresh the trusted g14-infra checkout before calling the gate",
  );
  assert.match(
    workflow,
    /git -C "\$secrets" fetch --quiet origin main && git -C "\$secrets" reset --hard origin\/main/,
    "the deploy runner should refresh the trusted secrets checkout before rendering",
  );
});

test("deploy-g14 does not duplicate the infra deploy implementation", () => {
  assert.doesNotMatch(
    workflow,
    /render\.sh" symphony-board/,
    "rendering secrets is owned by g14-infra make deploy",
  );
  assert.doesNotMatch(
    workflow,
    /live-allowlist\.sh/,
    "Live allowlist derivation is owned by g14-infra make deploy",
  );
  assert.doesNotMatch(
    workflow,
    /resolve_live_config_basename/,
    "source config basename parsing is owned by g14-infra make deploy",
  );
  assert.doesNotMatch(
    workflow,
    /docker compose --env-file \.env up -d/,
    "compose reconciliation is owned by the smoke-gated g14-infra make deploy target",
  );
});
