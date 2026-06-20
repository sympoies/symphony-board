// Unit coverage for the live-event trust-boundary guard. isLiveEvent validates
// untrusted snapshot/SSE JSON and stored rows, so it must reject anything whose
// delivery is not verified (the pipeline persists verified-only deliveries, and
// LiveDelivery.signature_status is the literal "verified"). stripNul /
// toProviderNumber are covered in live-store.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isLiveEvent, LIVE_EVENT_SCHEMA } from "../src/live/types.ts";

function validEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: LIVE_EVENT_SCHEMA,
    seq: 1,
    event_id: "d-1",
    source_id: "github:github.com",
    provider: "github",
    received_at: "2026-06-20T00:00:00Z",
    event_type: "issues",
    category: "issue",
    delivery: {
      delivery_id: "d-1",
      event_header: "issues",
      signature_status: "verified",
    },
    ...overrides,
  };
}

test("isLiveEvent accepts a well-formed verified record", () => {
  assert.equal(isLiveEvent(validEvent()), true);
});

test("isLiveEvent rejects a record whose delivery is not verified", () => {
  const unverified = validEvent({
    delivery: {
      delivery_id: "d-1",
      event_header: "issues",
      signature_status: "unverified",
    },
  });
  assert.equal(isLiveEvent(unverified), false);
});

test("isLiveEvent rejects a record missing delivery.signature_status", () => {
  const noStatus = validEvent({
    delivery: { delivery_id: "d-1", event_header: "issues" },
  });
  assert.equal(isLiveEvent(noStatus), false);
});

test("isLiveEvent rejects non-objects and a wrong schema tag", () => {
  assert.equal(isLiveEvent(null), false);
  assert.equal(isLiveEvent("nope"), false);
  assert.equal(isLiveEvent(validEvent({ schema: "live-event/2" })), false);
});

test("isLiveEvent rejects records missing a required top-level field", () => {
  assert.equal(isLiveEvent(validEvent({ event_id: 123 })), false);
  assert.equal(isLiveEvent(validEvent({ delivery: undefined })), false);
  assert.equal(isLiveEvent(validEvent({ category: undefined })), false);
});
