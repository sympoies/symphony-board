// Provider-adapter interface for the live receiver. A pure, network-free adapter
// per provider keeps the receiver provider-agnostic (GitHub lands first; GitLab
// implements the same contract later) and replayable against captured payloads,
// mirroring the repo's pure-`normalize` discipline. Divergence from the source
// sketch: `verify` takes a secret LIST (current + previous, for rotation) and
// `toLiveEvents` returns `LiveEventInput[]` (the store assigns `seq`/`schema`).
import type { IncomingHttpHeaders } from "node:http";
import type { LiveEventInput } from "./types.ts";
import type { VerifyResult } from "./verify.ts";

export interface AdaptCtx {
  // Canonical source vocabulary, e.g. "github:github.com".
  sourceId: string;
  // Stable per-delivery dedupe key (X-GitHub-Delivery / GitLab webhook-id).
  deliveryId: string;
  // ISO-8601 UTC instant the receiver accepted the delivery.
  receivedAt: string;
  // Raw provider event header (X-GitHub-Event / X-Gitlab-Event).
  eventHeader: string;
  // Provider hook id when present (X-GitHub-Hook-ID), for delivery metadata.
  hookId?: string | null;
}

export interface WebhookProvider {
  readonly id: "github" | "gitlab";

  // Header carrying the provider's event name (X-GitHub-Event / X-Gitlab-Event).
  // The receiver reads it to fill AdaptCtx.eventHeader (toLiveEvents is pure and
  // never sees raw headers).
  readonly eventHeaderName: string;

  // Header carrying the provider's hook id, or null when the provider has none.
  readonly hookIdHeaderName: string | null;

  // Verify the delivery over the RAW request bytes. Verdict only; no parsing, no
  // side effects. Constant-time compare; no permissive fallback.
  verify(
    rawBody: Buffer,
    headers: IncomingHttpHeaders,
    secrets: readonly string[],
  ): VerifyResult;

  // Stable per-delivery dedupe key from headers, or null when absent.
  deliveryId(headers: IncomingHttpHeaders): string | null;

  // True for non-domain control deliveries that must be acked but not stored
  // (GitHub `ping`, etc.).
  isControlEvent(headers: IncomingHttpHeaders, parsed: unknown): boolean;

  // Pure transform of a verified, parsed payload into 0..n provider-neutral
  // events. Returns [] for events the Live feed does not surface (ignore
  // gracefully). The store assigns `seq`; the receiver assigns the per-delivery
  // ordinal for multi-event deliveries.
  toLiveEvents(parsed: unknown, ctx: AdaptCtx): LiveEventInput[];
}

// Read a single header value (first of a repeated header).
export function headerValue(
  headers: IncomingHttpHeaders,
  name: string,
): string | null {
  const v = headers[name.toLowerCase()];
  if (v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

const SECRET_KEY_TOKENS = [
  "token",
  "secret",
  "signature",
  "password",
  "passwd",
  "private_key",
  "authorization",
];

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  return SECRET_KEY_TOKENS.some((t) => k.includes(t));
}

// Deep-clone a parsed payload, redacting values under secret-bearing keys. Used
// to scrub `raw` before persist (Decision 7). Over-redaction is preferred over
// leaking; the live feed never needs a token or signature value.
export function scrubSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => scrubSecrets(v));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? "[redacted]" : scrubSecrets(v);
    }
    return out;
  }
  return value;
}
