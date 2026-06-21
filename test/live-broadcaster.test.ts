// Unit coverage for the in-process SSE broadcaster: connection cap, seq dedupe
// across multiple subscribers, the idle heartbeat, closeAll, slow-subscriber
// backpressure eviction (#313), and per-subscriber write-error isolation (#313).
// Uses a fake ServerResponse so no socket is bound.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import {
  Broadcaster,
  MAX_SUBSCRIBER_BUFFER_BYTES,
  formatSseFrame,
} from "../src/live/broadcaster.ts";
import { LIVE_EVENT_SCHEMA, type LiveEvent } from "../src/live/types.ts";

class FakeRes {
  writes: string[] = [];
  ended = false;
  writableLength = 0;
  throwOnWrite = false;
  write(chunk: string): boolean {
    if (this.throwOnWrite) throw new Error("socket write failed");
    this.writes.push(chunk);
    return true;
  }
  end(): void {
    this.ended = true;
  }
}

function res(): FakeRes {
  return new FakeRes();
}
function asRes(r: FakeRes): ServerResponse {
  return r as unknown as ServerResponse;
}

function event(seq: number): LiveEvent {
  return {
    schema: LIVE_EVENT_SCHEMA,
    seq,
    event_id: `d-${seq}`,
    source_id: "github:github.com",
    provider: "github",
    received_at: "2026-06-20T00:00:00Z",
    event_type: "issues",
    category: "issue",
    delivery: {
      delivery_id: `d-${seq}`,
      event_header: "issues",
      signature_status: "verified",
    },
  };
}

async function until(
  predicate: () => boolean,
  attempts = 200,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition not met in time");
}

test("hasCapacity reflects the connection cap", () => {
  const b = new Broadcaster(2);
  const a = b.add(asRes(res()), 0);
  assert.equal(b.hasCapacity(), true);
  b.add(asRes(res()), 0);
  assert.equal(b.size, 2);
  assert.equal(b.hasCapacity(), false, "at the cap, no more capacity");
  b.remove(a.id);
  assert.equal(b.hasCapacity(), true);
});

test("send writes a frame once and dedupes anything at or below the high-water seq", () => {
  const b = new Broadcaster();
  const r = res();
  const sub = b.add(asRes(r), 0);
  b.send(sub, event(1));
  b.send(sub, event(1)); // duplicate seq -> skipped
  b.send(sub, event(2));
  const dataFrames = r.writes.filter((w) => w.includes("event: live"));
  assert.equal(dataFrames.length, 2);
  assert.equal(dataFrames[0], formatSseFrame(event(1)));
  assert.equal(dataFrames[1], formatSseFrame(event(2)));
});

test("send can write a same-seq replacement without moving the cursor backwards", () => {
  const b = new Broadcaster();
  const r = res();
  const sub = b.add(asRes(r), 0);
  b.send(sub, event(2));
  b.send(sub, { ...event(2), title: "enriched" }, { replace: true });
  b.send(sub, event(1), { replace: true });
  const dataFrames = r.writes.filter((w) => w.includes("event: live"));
  assert.equal(dataFrames.length, 2);
  assert.match(dataFrames[1] ?? "", /"title":"enriched"/);
  assert.equal(sub.lastSentSeq, 2);
});

test("broadcast replacement fans same-seq updates to subscribers at that cursor", () => {
  const b = new Broadcaster();
  const r = res();
  b.add(asRes(r), 5);
  b.broadcast({ ...event(5), title: "profile update" }, { replace: true });
  const dataFrames = r.writes.filter((w) => w.includes("event: live"));
  assert.equal(dataFrames.length, 1);
  assert.match(dataFrames[0] ?? "", /"title":"profile update"/);
});

test("broadcast fans to every subscriber, each deduping by its own cursor", () => {
  const b = new Broadcaster();
  const behind = res();
  const ahead = res();
  b.add(asRes(behind), 0);
  b.add(asRes(ahead), 5); // already past seq 3
  b.broadcast(event(3));
  b.broadcast(event(6));
  const behindSeqs = behind.writes
    .filter((w) => w.includes("event: live"))
    .map((w) => Number(/id: (\d+)/.exec(w)?.[1]));
  const aheadSeqs = ahead.writes
    .filter((w) => w.includes("event: live"))
    .map((w) => Number(/id: (\d+)/.exec(w)?.[1]));
  assert.deepEqual(behindSeqs, [3, 6]);
  assert.deepEqual(aheadSeqs, [6], "the ahead subscriber skips seq 3 (<= its cursor)");
});

test("closeAll ends every subscriber and empties the set", () => {
  const b = new Broadcaster();
  const r1 = res();
  const r2 = res();
  b.add(asRes(r1), 0);
  b.add(asRes(r2), 0);
  b.closeAll();
  assert.equal(r1.ended, true);
  assert.equal(r2.ended, true);
  assert.equal(b.size, 0);
});

test("a subscriber whose buffer is over the cap is evicted instead of buffered", () => {
  const b = new Broadcaster(10, MAX_SUBSCRIBER_BUFFER_BYTES);
  const slow = res();
  slow.writableLength = MAX_SUBSCRIBER_BUFFER_BYTES + 1; // backed up past the cap
  const sub = b.add(asRes(slow), 0);
  b.send(sub, event(1));
  assert.equal(slow.writes.length, 0, "no frame written to the over-cap subscriber");
  assert.equal(slow.ended, true, "the slow subscriber is ended");
  assert.equal(b.size, 0, "and removed");
});

test("a write that throws evicts only that subscriber, not the rest of the fan-out", () => {
  const b = new Broadcaster();
  const bad = res();
  bad.throwOnWrite = true;
  const good = res();
  b.add(asRes(bad), 0);
  b.add(asRes(good), 0);
  b.broadcast(event(1));
  assert.equal(bad.ended, true, "the throwing subscriber is evicted");
  assert.equal(b.size, 1, "the healthy subscriber survives");
  assert.equal(
    good.writes.filter((w) => w.includes("event: live")).length,
    1,
    "the healthy subscriber still received the event",
  );
});

test("the heartbeat writes to subscribers on its interval and stops when empty", async () => {
  const b = new Broadcaster(10, MAX_SUBSCRIBER_BUFFER_BYTES, 5);
  const r = res();
  const sub = b.add(asRes(r), 0);
  await until(() => r.writes.some((w) => w.includes(": heartbeat")));
  b.remove(sub.id); // last subscriber gone -> heartbeat stops, no further writes
  const after = r.writes.length;
  await new Promise((res2) => setTimeout(res2, 20));
  assert.equal(r.writes.length, after, "no heartbeat writes after the set empties");
});

test("the heartbeat evicts a subscriber that has backed up past the cap", async () => {
  const b = new Broadcaster(10, 100, 5);
  const slow = res();
  slow.writableLength = 1000; // over the 100-byte cap
  b.add(asRes(slow), 0);
  await until(() => slow.ended);
  assert.equal(b.size, 0, "the heartbeat evicted the stalled subscriber");
});
