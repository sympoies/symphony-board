import assert from "node:assert/strict";
import test from "node:test";
import { serialPoll } from "../src/serial-poll.ts";

const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test("slow polls and wake triggers never overlap; cadence starts after completion", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish!: () => void;
  let calls = 0;
  let signal!: AbortSignal;
  const poll = serialPoll(async (nextSignal) => {
    calls++;
    signal = nextSignal;
    await new Promise<void>((resolve) => { finish = resolve; });
  }, 100, true);
  assert.equal(calls, 1);
  t.mock.timers.tick(1000);
  poll.trigger();
  assert.equal(calls, 1);
  finish();
  await settle();
  t.mock.timers.tick(99);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  assert.equal(calls, 2);
  poll.stop();
  assert.equal(signal.aborted, true);
  finish();
  await settle();
  t.mock.timers.tick(1000);
  poll.trigger();
  assert.equal(calls, 2);
});

test("a failed tick retries at the same cadence and cleanup cancels a scheduled tick", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const poll = serialPoll(async () => { calls++; throw new Error("offline"); }, 100);
  assert.equal(calls, 0);
  t.mock.timers.tick(100);
  await settle();
  assert.equal(calls, 1);
  t.mock.timers.tick(100);
  await settle();
  assert.equal(calls, 2);
  poll.stop();
  t.mock.timers.tick(100);
  assert.equal(calls, 2);
});
