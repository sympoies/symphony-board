// Sprint 2 acceptance for the pure GitHub WebhookProvider adapter. Replayable
// against recorded payload fixtures (no network): (event, action) routing,
// issue_comment PR-vs-issue disambiguation, PR merge detection, review verdict,
// graceful ignore of unknown events/actions, ping as a control event, and
// secret-field scrubbing of `raw`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { GithubWebhookProvider, GITHUB_SOURCE_ID } from "../src/live/github.ts";
import type { AdaptCtx } from "../src/live/provider.ts";
import { isLiveEvent } from "../src/live/types.ts";
import type { LiveEventInput } from "../src/live/types.ts";

const FIX = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "github");
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(FIX, `${name}.json`), "utf8")) as unknown;
}

const provider = new GithubWebhookProvider();

function ctx(eventHeader: string, over: Partial<AdaptCtx> = {}): AdaptCtx {
  return {
    sourceId: GITHUB_SOURCE_ID,
    deliveryId: "delivery-guid-1",
    receivedAt: "2026-06-20T10:00:00Z",
    eventHeader,
    hookId: "hook-1",
    ...over,
  };
}

function one(events: LiveEventInput[]): LiveEventInput {
  assert.equal(events.length, 1, `expected exactly one event, got ${events.length}`);
  const ev = events[0];
  assert.ok(ev);
  return ev;
}

test("provider id is github", () => {
  assert.equal(provider.id, "github");
});

test("issues opened maps to a neutral issue event", () => {
  const ev = one(provider.toLiveEvents(fixture("issues.opened"), ctx("issues")));
  assert.equal(ev.category, "issue");
  assert.equal(ev.event_type, "issues");
  assert.equal(ev.action, "opened");
  assert.equal(ev.source_id, GITHUB_SOURCE_ID);
  assert.equal(ev.provider, "github");
  assert.equal(ev.event_id, "delivery-guid-1");
  assert.equal(ev.received_at, "2026-06-20T10:00:00Z");
  assert.equal(ev.target?.kind, "issue");
  assert.equal(ev.target?.number, 42);
  assert.equal(ev.target?.project_path, "sympoies/symphony-board");
  assert.equal(ev.target?.external_id, "I_kwDOissue42");
  assert.equal(ev.body, "Steps to reproduce...");
  assert.equal(ev.actor?.login, "reporter");
  assert.equal(ev.delivery.delivery_id, "delivery-guid-1");
  assert.equal(ev.delivery.event_header, "issues");
  assert.equal(ev.delivery.hook_id, "hook-1");
  assert.equal(ev.delivery.signature_status, "verified");
  assert.ok(ev.title && ev.title.includes("42"));
});

test("issue_comment on a PR is categorized as a PR comment", () => {
  const ev = one(
    provider.toLiveEvents(fixture("issue_comment.on_pr"), ctx("issue_comment")),
  );
  assert.equal(ev.category, "comment");
  assert.equal(ev.target?.kind, "change_request");
  assert.equal(ev.target?.number, 305);
  assert.equal(ev.body, "Looks good, merging soon.");
  assert.equal(
    ev.url,
    "https://github.com/sympoies/symphony-board/pull/305#issuecomment-1",
  );
});

test("issue_comment on an issue keeps the issue target kind", () => {
  const payload = {
    action: "created",
    issue: {
      number: 7,
      title: "An issue",
      html_url: "https://github.com/sympoies/symphony-board/issues/7",
    },
    comment: {
      body: "a plain issue comment",
      html_url: "https://github.com/sympoies/symphony-board/issues/7#c1",
      user: { login: "alice", html_url: "https://github.com/alice" },
    },
    repository: { full_name: "sympoies/symphony-board" },
    sender: { login: "alice", html_url: "https://github.com/alice" },
  };
  const ev = one(provider.toLiveEvents(payload, ctx("issue_comment")));
  assert.equal(ev.category, "comment");
  assert.equal(ev.target?.kind, "issue");
  assert.equal(ev.target?.number, 7);
});

test("a merged PR (closed + merged:true) is categorized as a change_request merge", () => {
  const ev = one(
    provider.toLiveEvents(fixture("pull_request.merged"), ctx("pull_request")),
  );
  assert.equal(ev.category, "change_request");
  assert.equal(ev.action, "closed");
  assert.equal(ev.target?.kind, "change_request");
  assert.equal(ev.target?.number, 305);
  assert.equal(ev.provider_details?.merged, true);
  assert.ok(ev.title && /merg/i.test(ev.title), `title should note the merge: ${ev.title}`);
});

test("secret-bearing fields are scrubbed from raw", () => {
  const ev = one(
    provider.toLiveEvents(fixture("pull_request.merged"), ctx("pull_request")),
  );
  const installation = (ev.raw as Record<string, unknown> | null)?.installation as
    | Record<string, unknown>
    | undefined;
  assert.ok(installation, "raw retains the installation object");
  assert.equal(installation.access_token, "[redacted]");
  assert.equal(installation.id, 141220539, "non-secret fields are retained");
});

test("pull_request_review carries the verdict in review_state", () => {
  const ev = one(
    provider.toLiveEvents(
      fixture("pull_request_review.approved"),
      ctx("pull_request_review"),
    ),
  );
  assert.equal(ev.category, "review");
  assert.equal(ev.action, "submitted");
  assert.equal(ev.review_state, "approved");
  assert.equal(ev.target?.kind, "change_request");
  assert.equal(ev.body, "LGTM!");
});

test("pull_request_review_comment maps to review_comment", () => {
  const payload = {
    action: "created",
    comment: {
      body: "nit: rename this",
      html_url: "https://github.com/sympoies/symphony-board/pull/305#discussion_r1",
      user: { login: "rev", html_url: "https://github.com/rev" },
    },
    pull_request: {
      number: 305,
      title: "feat: live",
      html_url: "https://github.com/sympoies/symphony-board/pull/305",
    },
    repository: { full_name: "sympoies/symphony-board" },
    sender: { login: "rev", html_url: "https://github.com/rev" },
  };
  const ev = one(provider.toLiveEvents(payload, ctx("pull_request_review_comment")));
  assert.equal(ev.category, "review_comment");
  assert.equal(ev.target?.kind, "change_request");
  assert.equal(ev.body, "nit: rename this");
});

test("pull_request_review_thread maps to review_thread with resolved action", () => {
  const payload = {
    action: "resolved",
    pull_request: {
      number: 305,
      title: "feat: live",
      html_url: "https://github.com/sympoies/symphony-board/pull/305",
    },
    repository: { full_name: "sympoies/symphony-board" },
    sender: { login: "rev", html_url: "https://github.com/rev" },
  };
  const ev = one(provider.toLiveEvents(payload, ctx("pull_request_review_thread")));
  assert.equal(ev.category, "review_thread");
  assert.equal(ev.action, "resolved");
  assert.equal(ev.target?.kind, "change_request");
});

test("an unknown action on a known event yields an empty list", () => {
  const payload = {
    action: "assigned",
    issue: { number: 1, title: "x", html_url: "https://github.com/x/y/issues/1" },
    repository: { full_name: "x/y" },
    sender: { login: "a" },
  };
  assert.deepEqual(provider.toLiveEvents(payload, ctx("issues")), []);
});

test("an unknown event yields an empty list without throwing", () => {
  assert.deepEqual(provider.toLiveEvents({ action: "created" }, ctx("star")), []);
});

test("a malformed payload does not throw, returns an empty list", () => {
  assert.deepEqual(provider.toLiveEvents(null, ctx("issues")), []);
  assert.deepEqual(provider.toLiveEvents("not an object", ctx("issues")), []);
});

test("isControlEvent recognizes ping and nothing else", () => {
  assert.equal(provider.isControlEvent({ "x-github-event": "ping" }, {}), true);
  assert.equal(provider.isControlEvent({ "x-github-event": "issues" }, {}), false);
  assert.equal(provider.isControlEvent({}, {}), false);
});

test("deliveryId reads X-GitHub-Delivery", () => {
  assert.equal(
    provider.deliveryId({ "x-github-delivery": "abc-123" }),
    "abc-123",
  );
  assert.equal(provider.deliveryId({}), null);
});

test("verify delegates to the sha256 HMAC over raw bytes", () => {
  const body = Buffer.from('{"zen":"ok"}');
  const secret = "s3cr3t";
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  assert.deepEqual(
    provider.verify(body, { "x-hub-signature-256": sig }, [secret]),
    { ok: true },
  );
  assert.equal(
    provider.verify(body, { "x-hub-signature-256": sig }, ["wrong"]).ok,
    false,
  );
});

test("the adapter is pure: repeated calls match and the input is not mutated", () => {
  const payload = fixture("pull_request.merged") as Record<string, unknown>;
  const before = JSON.stringify(payload);
  const a = provider.toLiveEvents(payload, ctx("pull_request"));
  const b = provider.toLiveEvents(payload, ctx("pull_request"));
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(payload), before, "input payload must not be mutated");
});

test("adapter output validates as a live-event/1 record once seq is assigned", () => {
  const ev = one(provider.toLiveEvents(fixture("issues.opened"), ctx("issues")));
  assert.ok(isLiveEvent({ ...ev, schema: "live-event/1", seq: 1 }));
});
