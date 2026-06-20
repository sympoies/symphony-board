// Sprint 2 acceptance for the raw-body Buffer reader. It returns exact bytes
// (so HMAC verification can run before any JSON parse), caps the size, and times
// out a stalled body — the gap the string `readBody` in sync-daemon leaves open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { readBodyBytes, BodyTooLargeError } from "../src/live/http-body.ts";

function fakeReq(chunks: Buffer[]): IncomingMessage {
  return Readable.from(chunks) as unknown as IncomingMessage;
}

test("readBodyBytes returns the exact raw bytes as a Buffer", async () => {
  const data = Buffer.from("hello world");
  const buf = await readBodyBytes(fakeReq([data]));
  assert.ok(Buffer.isBuffer(buf));
  assert.deepEqual(buf, data);
});

test("readBodyBytes preserves non-UTF-8 bytes", async () => {
  const data = Buffer.from([0x00, 0xff, 0xfe, 0x41]);
  const buf = await readBodyBytes(fakeReq([data]));
  assert.deepEqual(buf, data);
});

test("readBodyBytes concatenates multiple chunks in order", async () => {
  const buf = await readBodyBytes(
    fakeReq([Buffer.from("ab"), Buffer.from("cd"), Buffer.from("ef")]),
  );
  assert.equal(buf.toString("utf8"), "abcdef");
});

test("readBodyBytes rejects an oversized body with BodyTooLargeError", async () => {
  const data = Buffer.alloc(100, 0x61);
  await assert.rejects(() => readBodyBytes(fakeReq([data]), 10), BodyTooLargeError);
});

test("readBodyBytes times out a stalled body", async () => {
  const stalled = new Readable({ read() {} }) as unknown as IncomingMessage;
  await assert.rejects(
    () => readBodyBytes(stalled, 1024, 20),
    /timed out/,
  );
});

test("a runaway body past 4x the cap settles as 413, not a timeout (#316 item 5)", async () => {
  // The first chunk trips tooLarge; a second chunk past 4x the cap triggers
  // req.destroy(), which emits `close` (not `end`). Without the close handler the
  // promise would hang until the idle timeout and surface as a 408. The generous
  // timeout below must NOT be hit — settlement is via `close`.
  const req = new Readable({ read() {} });
  const p = readBodyBytes(req as unknown as IncomingMessage, 10, 5000);
  req.push(Buffer.alloc(15, 0x61)); // over the cap -> tooLarge
  req.push(Buffer.alloc(40, 0x61)); // over 4x the cap -> destroy -> close
  await assert.rejects(() => p, BodyTooLargeError);
});
