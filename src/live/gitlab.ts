// GitLab WebhookProvider — INTERFACE STUB (v1). Designed against the same
// WebhookProvider contract as the GitHub adapter so a later session can
// implement it without re-litigating the shape; `verify` and `toLiveEvents`
// throw "not implemented" and the stub is NOT registered in the receiver.
// Enabling it is gated on Decision 11 (see below).
//
// GitLab specifics the real adapter must encode (verified 2026-06-20):
//
// - Verification: prefer the SIGNING TOKEN — HMAC-SHA256 in the lowercase
//   `webhook-signature` header, value `v1,{base64}`, signed over
//   `{message_id}.{timestamp}.{body}` (GA in GitLab 19.1). The legacy plaintext
//   `X-Gitlab-Token` is weaker and not recommended for new webhooks. Verify over
//   the RAW bytes, constant-time, no permissive fallback (as for GitHub).
// - Dedupe on the `webhook-id` header (stable across retries) — NOT
//   `X-Gitlab-Event-UUID`, which is shared by recursive webhooks.
// - Event typing: the `X-Gitlab-Event` header (`Note Hook`, `Merge Request
//   Hook`, `Issue Hook`, `Push Hook`, `Pipeline Hook`, `Job Hook`, …) plus
//   `object_kind` in the body; `object_kind` does NOT always match the header
//   (e.g. `Job Hook` -> `build`). Map header/object_kind to the neutral category
//   (Note -> comment, Merge Request -> change_request, Issue -> issue, Push ->
//   push, Pipeline -> pipeline). A Push carries multiple commits, so it yields
//   0..n events (use the per-delivery ordinal, see LiveStore.append).
// - Work items (Tasks/Incidents/Epics/OKRs) arrive on the `Issue Hook` with
//   `object_kind: "work_item"` (not `"issue"`); branch on that under Issue Hook.
// - Reliability: GitLab retries then auto-disables a webhook after 4 consecutive
//   failures (temporary) and permanently after 40; operators must monitor this
//   when the adapter ships. Group webhooks require a paid tier.
//
// Prerequisites before this adapter is ENABLED (rollout gate, not interface):
// - A self-managed/internal GitLab (e.g. gitlab.gamania.com behind VPN) can only
//   deliver if the GitLab host has OUTBOUND reachability to the public receiver
//   URL (webhooks are server-initiated outbound POSTs; GitLab also blocks
//   private/local targets by default, which a public receiver URL sidesteps).
// - Decision 11: confirm company policy permits mirroring internal
//   issue/MR/comment text off the GitLab host onto the deployment host BEFORE
//   enabling this for an internal instance, and decide whether per-client authz
//   / per-source visibility filtering on the SSE stream is then required. v1 is
//   GitHub-only, so this gates the GitLab adapter's ROLLOUT, not its interface.
import type { IncomingHttpHeaders } from "node:http";
import type { LiveEventInput } from "./types.ts";
import { headerValue, type AdaptCtx, type WebhookProvider } from "./provider.ts";
import type { VerifyResult } from "./verify.ts";

// Source ids follow `gitlab:<host>` (e.g. "gitlab:gitlab.com",
// "gitlab:gitlab.gamania.com"), matching the canonical source vocabulary.
export const GITLAB_SOURCE_ID_PREFIX = "gitlab:";

const NOT_IMPLEMENTED =
  "GitLab webhook adapter is a v1 interface stub (not implemented); " +
  "enabling it is gated on Decision 11 (company clearance to mirror private " +
  "GitLab content) and self-managed outbound reachability.";

export class GitlabWebhookProvider implements WebhookProvider {
  readonly id = "gitlab" as const;
  readonly eventHeaderName = "x-gitlab-event";
  // GitLab dedupes on `webhook-id` (stable across retries).
  readonly hookIdHeaderName = "webhook-id";

  // Stub: the real impl verifies the `webhook-signature` signing token (HMAC over
  // {message_id}.{timestamp}.{body}) over the raw bytes, constant-time.
  verify(
    _rawBody: Buffer,
    _headers: IncomingHttpHeaders,
    _secrets: readonly string[],
  ): VerifyResult {
    throw new Error(NOT_IMPLEMENTED);
  }

  // Implemented: the dedupe key is the `webhook-id` header.
  deliveryId(headers: IncomingHttpHeaders): string | null {
    return headerValue(headers, "webhook-id");
  }

  // GitLab has no `ping`-style control delivery analog.
  isControlEvent(_headers: IncomingHttpHeaders, _parsed: unknown): boolean {
    return false;
  }

  // Stub: the real impl maps (X-Gitlab-Event / object_kind) to neutral events,
  // branching on object_kind "work_item" under the Issue Hook, and expands a
  // Push into one event per commit (ordinals).
  toLiveEvents(_parsed: unknown, _ctx: AdaptCtx): LiveEventInput[] {
    throw new Error(NOT_IMPLEMENTED);
  }
}
