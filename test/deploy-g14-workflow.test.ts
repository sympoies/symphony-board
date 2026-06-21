import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../.github/workflows/deploy-g14.yml", import.meta.url),
  "utf8",
);

test("deploy-g14 derives the Live allowlist from the configured source basename", () => {
  assert.match(
    workflow,
    /SYMPHONY_CONFIG_BASENAME/,
    "the deploy must honor the stack's configured source basename",
  );
  assert.doesNotMatch(
    workflow,
    /live-allowlist\.sh" "\$infra\/stacks\/symphony-board\/config\/sources\.pg\.json"/,
    "the allowlist command must not hard-code the default pg source file",
  );
  assert.match(
    workflow,
    /config\/\$config_basename/,
    "the allowlist command should read config/$SYMPHONY_CONFIG_BASENAME",
  );
});
