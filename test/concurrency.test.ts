import { test } from "node:test";
import assert from "node:assert/strict";
import { mapWithConcurrency, resolveConcurrency, DEFAULT_RESOLVE_CONCURRENCY } from "../src/lib/concurrency.ts";

// A barrier-free deferred so a task can park until the test releases it; lets a
// test hold N tasks open at once and observe how many ran concurrently.
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// Drain the macrotask queue so all pending microtasks (worker resumptions)
// settle — lets a test observe the pool's steady state deterministically.
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// Save/restore an env var around a test body so a setting can't leak across tests.
async function withEnv(name: string, value: string | undefined, fn: () => void | Promise<void>): Promise<void> {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
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

test("saturates to exactly `limit` in-flight and never exceeds it", async () => {
  const LIMIT = 3;
  const TOTAL = 12;
  const gates = Array.from({ length: TOTAL }, () => deferred<void>());
  const started: number[] = [];
  let inFlight = 0;
  let peak = 0;
  const p = mapWithConcurrency(Array.from({ length: TOTAL }, (_, i) => i), LIMIT, async (i) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    started.push(i);
    await gates[i]!.promise; // park until released, holding the slot
    inFlight--;
    return i;
  });

  // With every task parked, the pool must hold exactly LIMIT slots open — no
  // more (bounded) and no fewer (no idle workers) — and claim them in input order.
  await flush();
  assert.equal(inFlight, LIMIT, `pool should saturate to ${LIMIT}, saw ${inFlight}`);
  assert.deepEqual(started, [0, 1, 2], "the first `limit` items start, in input order");

  // Release one at a time: each freed slot is immediately refilled, peak holds at LIMIT.
  for (let i = 0; i < TOTAL; i++) {
    gates[i]!.resolve();
    await flush();
  }
  assert.deepEqual(await p, Array.from({ length: TOTAL }, (_, i) => i));
  assert.equal(peak, LIMIT, `peak in-flight ${peak} must equal the limit ${LIMIT}`);
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

test("resolveConcurrency falls back to the default when unset or invalid", async () => {
  await withEnv("SYNC_RESOLVE_CONCURRENCY", undefined, () => {
    assert.equal(resolveConcurrency(), DEFAULT_RESOLVE_CONCURRENCY);
  });
  for (const bad of ["", "abc", "0", "-1", "1.5", "NaN"]) {
    await withEnv("SYNC_RESOLVE_CONCURRENCY", bad, () => {
      assert.equal(resolveConcurrency(), DEFAULT_RESOLVE_CONCURRENCY, `"${bad}" must fall back to the default`);
    });
  }
});

test("resolveConcurrency honors a valid positive integer override", async () => {
  await withEnv("SYNC_RESOLVE_CONCURRENCY", "1", () => assert.equal(resolveConcurrency(), 1));
  await withEnv("SYNC_RESOLVE_CONCURRENCY", "8", () => assert.equal(resolveConcurrency(), 8));
});
