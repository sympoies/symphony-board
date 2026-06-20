// Provider-neutral live-event record (`live-event/1`). This is the live
// subsystem's OWN schema, versioned independently of the product contract — it
// MUST NOT import `@symphony-board/contract` or reference `contract_version`.
// It carries the neutral summary plus the full body, raw payload, and delivery
// metadata (secret fields scrubbed by the adapter). The store assigns `seq`
// (the SSE `id:` cursor) on append; adapters produce `LiveEventInput` records
// without one. See docs/plans/2026-06-20-live-event-stream.

export const LIVE_EVENT_SCHEMA = "live-event/1" as const;

// Neutral event category. Open vocabulary: providers grow new event kinds, so a
// later adapter may emit a value not listed here. The literals document the v1
// GitHub set while `(string & {})` keeps the type open without losing
// autocomplete on the known members.
export type LiveCategory =
  | "issue"
  | "change_request"
  | "comment"
  | "review"
  | "review_comment"
  | "review_thread"
  | "push"
  | "pipeline"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {});

export interface LiveActor {
  login: string | null;
  display_name?: string | null;
  avatar_url?: string | null;
  profile_url?: string | null;
}

export interface LiveTarget {
  // issue | change_request | repo | commit ...
  kind: string;
  source_id: string;
  project_path?: string | null;
  // Provider number/iid. 64-bit safe: string-encoded when it exceeds the JS
  // safe-integer range (see `toProviderNumber`).
  number?: number | string | null;
  external_id?: string | null;
  title?: string | null;
  url?: string | null;
}

export interface LiveDelivery {
  // Provider delivery GUID (X-GitHub-Delivery / GitLab webhook-id).
  delivery_id: string;
  // Raw provider event header (X-GitHub-Event / X-Gitlab-Event).
  event_header: string;
  hook_id?: string | null;
  // Only verified deliveries are ever persisted, so this is always "verified";
  // kept as a field so a stored record is self-describing.
  signature_status: "verified";
}

// What an adapter produces and the store accepts. No `seq` (store-assigned) and
// no `schema` tag (added on read / serialization).
export interface LiveEventInput {
  event_id: string;
  source_id: string;
  provider: string;
  // ISO-8601 UTC (Z) — the instant the receiver accepted the delivery.
  received_at: string;
  // Provider event time when available; may carry a non-UTC offset.
  occurred_at?: string | null;
  // Provider event name (e.g. "pull_request_review").
  event_type: string;
  // Provider action/sub-action (e.g. "submitted").
  action?: string | null;
  category: LiveCategory;
  actor?: LiveActor | null;
  target?: LiveTarget | null;
  // Human one-line summary.
  title?: string | null;
  // Full comment/review/issue/MR body.
  body?: string | null;
  url?: string | null;
  // Provider-specific verdict (e.g. review state), nullable.
  review_state?: string | null;
  delivery: LiveDelivery;
  // Small curated provider-specific extras.
  provider_details?: Record<string, unknown> | null;
  // Full raw provider payload with secret-bearing fields scrubbed (TTL-pruned).
  raw?: Record<string, unknown> | null;
}

// A persisted record as returned by the store / serialized over SSE/snapshot.
export type LiveEvent = LiveEventInput & {
  schema: typeof LIVE_EVENT_SCHEMA;
  // Monotonic append id; the SSE `id:` / `Last-Event-ID` cursor. NUL-free by
  // construction (an integer).
  seq: number;
};

// Remove only NUL bytes — a raw 0x00 in a TEXT column corrupts downstream
// consumers and the source-tree NUL guard. Other whitespace (tab, newline,
// carriage return) is legitimate in a comment body and is preserved.
export function stripNul(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.replace(/\u0000/g, "");
}

// Honor the 64-bit-safe provider-number rule: keep small integers as numbers,
// string-encode anything outside the JS safe-integer range so precision is
// never silently lost. A value already supplied as a string is trusted as-is.
export function toProviderNumber(
  value: number | string | bigint | null | undefined,
): number | string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "bigint") {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
      value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  return Number.isSafeInteger(value) ? value : String(value);
}

// Self-contained validator for the `live-event/1` tag and required fields. No
// dependency on the product contract's validator.
export function isLiveEvent(value: unknown): value is LiveEvent {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.schema !== LIVE_EVENT_SCHEMA) return false;
  if (typeof v.seq !== "number") return false;
  if (typeof v.event_id !== "string") return false;
  if (typeof v.source_id !== "string") return false;
  if (typeof v.provider !== "string") return false;
  if (typeof v.received_at !== "string") return false;
  if (typeof v.event_type !== "string") return false;
  if (typeof v.category !== "string") return false;
  const d = v.delivery;
  if (d === null || typeof d !== "object") return false;
  const delivery = d as Record<string, unknown>;
  if (typeof delivery.delivery_id !== "string") return false;
  if (typeof delivery.event_header !== "string") return false;
  // Verified-only persistence is a pipeline invariant: a record whose delivery
  // is not the literal "verified" must never narrow to LiveEvent, even when it
  // arrives via untrusted snapshot/SSE JSON or an older stored row.
  if (delivery.signature_status !== "verified") return false;
  return true;
}
