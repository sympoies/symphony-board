// Sprint 6 acceptance for the GitLab WebhookProvider interface stub: it
// satisfies the shared interface and documents the GitLab specifics + the
// Decision 11 rollout gate, but its verify/adapt throw "not implemented" and it
// is NOT registered in the receiver (enabling it is out of v1 scope).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { GitlabWebhookProvider } from "../src/live/gitlab.ts";
import type { WebhookProvider } from "../src/live/provider.ts";

const provider: WebhookProvider = new GitlabWebhookProvider();
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the GitLab stub satisfies the WebhookProvider shape", () => {
  assert.equal(provider.id, "gitlab");
  assert.equal(provider.eventHeaderName, "x-gitlab-event");
  // hookIdHeaderName is the webhook IDENTITY header, distinct from the dedupe
  // key (#316 item 12): setting it to webhook-id too would persist the dedupe id
  // twice and lose the webhook identifier.
  assert.equal(provider.hookIdHeaderName, "x-gitlab-webhook-uuid");
});

test("deliveryId reads the webhook-id header (the GitLab dedupe key)", () => {
  assert.equal(provider.deliveryId({ "webhook-id": "wh-1" }), "wh-1");
  // The dedupe key stays webhook-id even though hookIdHeaderName is the uuid.
  assert.equal(provider.deliveryId({ "x-gitlab-webhook-uuid": "u-1" }), null);
  // Not X-Gitlab-Event-UUID (shared by recursive webhooks).
  assert.equal(provider.deliveryId({ "x-gitlab-event-uuid": "u-1" }), null);
  assert.equal(provider.deliveryId({}), null);
});

test("isControlEvent is false (GitLab has no ping analog)", () => {
  assert.equal(
    provider.isControlEvent({ "x-gitlab-event": "Push Hook" }, {}),
    false,
  );
});

test("verify is a documented stub that throws not-implemented", () => {
  assert.throws(
    () => provider.verify(Buffer.from("x"), {}, ["s"]),
    /not implemented/i,
  );
});

test("toLiveEvents is a documented stub that throws not-implemented", () => {
  assert.throws(
    () =>
      provider.toLiveEvents(
        { object_kind: "issue" },
        {
          sourceId: "gitlab:gitlab.com",
          deliveryId: "wh-1",
          receivedAt: "2026-06-20T00:00:00Z",
          eventHeader: "Issue Hook",
        },
      ),
    /not implemented/i,
  );
});

test("the GitLab stub is NOT wired into the receiver in v1", () => {
  for (const f of ["src/live/receiver.ts", "src/cli/live-receiver.ts"]) {
    const src = readFileSync(resolve(root, f), "utf8");
    assert.ok(
      !/GitlabWebhookProvider|gitlab\.ts/.test(src),
      `${f} must not register the GitLab stub in v1`,
    );
  }
});

test("the stub documents the GitLab specifics and the Decision 11 rollout gate", () => {
  const src = readFileSync(resolve(root, "src", "live", "gitlab.ts"), "utf8");
  assert.match(src, /webhook-signature/i, "signing-token header");
  assert.match(src, /webhook-id/i, "dedupe key");
  assert.match(src, /object_kind/i, "header-to-object_kind mapping");
  assert.match(src, /work_item/i, "work-item branch under Issue Hook");
  assert.match(
    src,
    /whsec_/,
    "the signing key must have its whsec_ prefix stripped + be base64-decoded (#316 item 13)",
  );
  assert.match(
    src,
    /x-gitlab-webhook-uuid/i,
    "the webhook identity header distinct from the dedupe key (#316 item 12)",
  );
  assert.match(
    src,
    /Decision 11|company|clearance/i,
    "the private-content rollout gate",
  );
});
