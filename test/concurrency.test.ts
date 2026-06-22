import { test } from "node:test";
import assert from "node:assert/strict";
import { mapWithConcurrency } from "../src/lib/concurrency.ts";

// A barrier-free deferred so a task can park until the test releases it; lets a
// test hold N tasks open at once and observe how many ran concurrently.
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

test("results are returned in input order regardless of completion order", async () => {
  // Later items resolve first, so completion order is the reverse of input order.
  const gates = [0, 1, 2, 3, 4].map(() => deferred<void>());
  const p = mapWithConcurrency([0, 1, 2, 3, 4], 5, async (n) => {
    await gates[n]!.promise;
    return n * 10;
  });
  for (let i = 4; i >= 0; i--) gates[i]!.resolve();
  assert.deepEqual(await p, [0, 10, 20, 30, 40]);
});

test("never runs more than `limit` tasks concurrently", async () => {
  const LIMIT = 3;
  const TOTAL = 12;
  let inFlight = 0;
  let peak = 0;
  await mapWithConcurrency(Array.from({ length: TOTAL }, (_, i) => i), LIMIT, async (i) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    // Yield across a microtask so concurrent tasks actually overlap.
    await Promise.resolve();
    await Promise.resolve();
    inFlight--;
    return i;
  });
  assert.ok(peak > 1, `expected real overlap, peak was ${peak}`);
  assert.ok(peak <= LIMIT, `peak in-flight ${peak} exceeded limit ${LIMIT}`);
});

test("processes every item exactly once", async () => {
  const seen: number[] = [];
  const out = await mapWithConcurrency([10, 20, 30], 2, async (n) => {
    seen.push(n);
    return n + 1;
  });
  assert.deepEqual(out, [11, 21, 31]);
  assert.deepEqual(seen.sort((a, b) => a - b), [10, 20, 30]);
});

test("empty input resolves to an empty array without running the worker", async () => {
  let calls = 0;
  const out = await mapWithConcurrency([], 4, async () => {
    calls++;
    return 1;
  });
  assert.deepEqual(out, []);
  assert.equal(calls, 0);
});

test("a limit at or above the item count runs all items at once", async () => {
  let inFlight = 0;
  let peak = 0;
  await mapWithConcurrency([1, 2, 3], 99, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await Promise.resolve();
    inFlight--;
    return n;
  });
  assert.equal(peak, 3);
});

test("a limit below 1 is clamped to sequential execution", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapWithConcurrency([1, 2, 3], 0, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await Promise.resolve();
    inFlight--;
    return n;
  });
  assert.deepEqual(out, [1, 2, 3]);
  assert.equal(peak, 1);
});
