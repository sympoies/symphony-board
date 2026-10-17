// Unit coverage for the in-process SSE broadcaster: connection cap, seq dedupe
// across multiple subscribers, the idle heartbeat, closeAll, slow-subscriber
// backpressure eviction (#313), per-subscriber write-error isolation (#313), and
// write-after-end safety (#851). Uses a fake ServerResponse so no socket is bound.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, request, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  Broadcaster,
  MAX_SUBSCRIBER_BUFFER_BYTES,
  formatSseFrame,
  formatSseUpdateFrame,
} from "../src/live/broadcaster.ts";
import { LIVE_EVENT_SCHEMA, type LiveEvent } from "../src/live/types.ts";

// Mirrors node:http's ServerResponse where it matters: a write after end() does
// not throw, it emits ERR_STREAM_WRITE_AFTER_END as an async 'error' event, which
// crashes the process when no listener is attached (#851).
class FakeRes extends EventEmitter {
  writes: string[] = [];
  ended = false;
  destroyed = false;
  writableLength = 0;
  throwOnWrite = false;
  get writableEnded(): boolean {
    return this.ended;
  }
  write(chunk: string): boolean {
    if (this.ended) {
      const err = Object.assign(new Error("write after end"), {
        code: "ERR_STREAM_WRITE_AFTER_END",
      });
      process.nextTick(() => this.emit("error", err));
      return false;
    }
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
  const update = { ...event(2), title: "enriched" };
  b.send(sub, event(2));
  b.send(sub, update, { replace: true });
  const dataFrames = r.writes.filter((w) => w.includes("event: live"));
  assert.equal(dataFrames.length, 2);
  assert.equal(dataFrames[1], formatSseUpdateFrame(update));
  assert.doesNotMatch(dataFrames[1] ?? "", /^id:/m);
  assert.equal(sub.lastSentSeq, 2);
});

test("send writes older replacement updates without regressing the resume cursor", () => {
  const b = new Broadcaster();
  const r = res();
  const sub = b.add(asRes(r), 0);
  const update = { ...event(1), title: "late profile update" };
  b.send(sub, event(1));
  b.send(sub, event(2));
  b.send(sub, update, { replace: true });
  const dataFrames = r.writes.filter((w) => w.includes("event: live"));
  assert.equal(dataFrames.length, 3);
  assert.equal(dataFrames[2], formatSseUpdateFrame(update));
  assert.doesNotMatch(dataFrames[2] ?? "", /^id:/m);
  assert.equal(sub.lastSentSeq, 2);
});

test("broadcast replacement fans same-seq updates to subscribers at that cursor", () => {
  const b = new Broadcaster();
  const r = res();
  const update = { ...event(5), title: "profile update" };
  b.add(asRes(r), 5);
  b.broadcast(update, { replace: true });
  const dataFrames = r.writes.filter((w) => w.includes("event: live-update"));
  assert.equal(dataFrames.length, 1);
  assert.equal(dataFrames[0], formatSseUpdateFrame(update));
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

// A tick for any async 'error' emitted by a write-after-end to surface; an
// unhandled one fails the test as an uncaught exception.
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

test("send to a subscriber whose response already ended evicts it without writing (#851)", async () => {
  const b = new Broadcaster();
  const r = res();
  const sub = b.add(asRes(r), 0);
  r.end(); // client gone before the send
  b.send(sub, event(1));
  await settle();
  assert.equal(r.writes.length, 0, "nothing written after end");
  assert.equal(sub.lastSentSeq, 0, "an unsent event does not advance the cursor");
  assert.equal(b.size, 0, "the ended subscriber is evicted");
});

test("send to a destroyed response evicts it without writing (#851)", async () => {
  const b = new Broadcaster();
  const r = res();
  const sub = b.add(asRes(r), 0);
  r.destroyed = true;
  b.send(sub, event(1));
  await settle();
  assert.equal(r.writes.length, 0);
  assert.equal(b.size, 0);
});

test("a subscriber evicted mid-replay is never written again in that replay (#851)", async () => {
  // handleSse registers then replays its backlog through send(). An eviction
  // part-way (here: over the buffer cap) ends the response; the remaining replay
  // sends must not write after end, even once the buffered bytes drain away.
  const b = new Broadcaster(10, 100);
  const r = res();
  const sub = b.add(asRes(r), 0);
  b.send(sub, event(1));
  r.writableLength = 1000; // backed up past the cap -> next send evicts
  b.send(sub, event(2));
  assert.equal(r.ended, true, "evicted mid-replay");
  r.writableLength = 0; // buffer flushed/detached after end
  b.send(sub, event(3));
  await settle();
  assert.equal(r.writes.filter((w) => w.includes("event: live")).length, 1);
  assert.equal(sub.lastSentSeq, 1);
});

test("a stray response error is handled and evicts the subscriber, not the process (#851)", async () => {
  const b = new Broadcaster();
  const r = res();
  const other = res();
  b.add(asRes(r), 0);
  b.add(asRes(other), 0);
  r.emit("error", new Error("socket hang up"));
  await settle();
  assert.equal(r.ended, true, "the erroring subscriber is evicted");
  assert.equal(b.size, 1, "other subscribers survive");
});

test("the heartbeat skips and evicts a subscriber whose response ended (#851)", async () => {
  const b = new Broadcaster(10, MAX_SUBSCRIBER_BUFFER_BYTES, 5);
  const r = res();
  b.add(asRes(r), 0);
  r.end();
  await until(() => b.size === 0);
  await settle();
  assert.equal(r.writes.length, 0);
});

test("a real ended ServerResponse is evicted, not written after end (#851)", async () => {
  const b = new Broadcaster();
  let resolveSent!: () => void;
  const sent = new Promise<void>((r) => (resolveSent = r));
  const server = createServer((_req, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const sub = b.add(response, 0);
    response.end(); // ended before the initial replay send
    b.send(sub, event(1));
    b.broadcast(event(2));
    setImmediate(resolveSent);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { port } = server.address() as AddressInfo;
    const body = await new Promise<string>((resolve, reject) => {
      request({ port, host: "127.0.0.1", path: "/" }, (incoming) => {
        let data = "";
        incoming.on("data", (c: Buffer) => (data += c.toString()));
        incoming.on("end", () => resolve(data));
      })
        .on("error", reject)
        .end();
    });
    await sent;
    await settle();
    assert.equal(body, "", "no frame written after end");
    assert.equal(b.size, 0, "the ended subscriber is evicted");
  } finally {
    b.closeAll();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
