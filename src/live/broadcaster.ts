// In-process SSE broadcaster. Holds the set of open `/api/live` connections and
// fans verified events to them. Each subscriber tracks a high-water `seq`, so
// the replay-then-live handoff dedupes by seq: a subscriber is registered BEFORE
// its backlog replay (closing the replay-to-subscribe gap), and any event it has
// already been sent is skipped. Bounded connection count; an idle heartbeat
// keeps intermediaries from dropping the connection. A slow/stalled subscriber
// whose outbound socket buffer grows past a cap is evicted rather than buffered
// unbounded (which would OOM-restart the receiver), and a write that throws
// evicts only that one subscriber instead of breaking the whole fan-out loop.
// Never imports the canonical store.
import type { ServerResponse } from "node:http";
import type { LiveEvent } from "./types.ts";

export const DEFAULT_MAX_CONNECTIONS = 100;
export const HEARTBEAT_MS = 15_000;
// Per-subscriber outbound buffer cap. A consumer that cannot keep up (stalled
// socket, suspended tab) backs frames up in res.writableLength; past this we
// evict it so one slow reader cannot grow process memory without bound.
export const MAX_SUBSCRIBER_BUFFER_BYTES = 4 * 1024 * 1024; // 4 MiB

export interface Subscriber {
  id: number;
  res: ServerResponse;
  // Highest seq already written to this subscriber (replay + live dedupe).
  lastSentSeq: number;
}

// SSE wire frame: `id: <seq>` (the Last-Event-ID cursor) + `event: live` +
// `data: <json>`, terminated by a blank line.
export function formatSseFrame(event: LiveEvent): string {
  return `id: ${event.seq}\nevent: live\ndata: ${JSON.stringify(event)}\n\n`;
}

export class Broadcaster {
  readonly #subs = new Map<number, Subscriber>();
  readonly #maxConnections: number;
  readonly #maxBufferBytes: number;
  readonly #heartbeatMs: number;
  #nextId = 1;
  #heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(
    maxConnections: number = DEFAULT_MAX_CONNECTIONS,
    maxBufferBytes: number = MAX_SUBSCRIBER_BUFFER_BYTES,
    heartbeatMs: number = HEARTBEAT_MS,
  ) {
    this.#maxConnections = maxConnections;
    this.#maxBufferBytes = maxBufferBytes;
    this.#heartbeatMs = heartbeatMs;
  }

  get size(): number {
    return this.#subs.size;
  }

  get maxConnections(): number {
    return this.#maxConnections;
  }

  hasCapacity(): boolean {
    return this.#subs.size < this.#maxConnections;
  }

  // Register a connection with its initial high-water mark (Last-Event-ID /
  // ?since cursor). Call BEFORE replaying the backlog.
  add(res: ServerResponse, lastSentSeq: number): Subscriber {
    const sub: Subscriber = { id: this.#nextId++, res, lastSentSeq };
    this.#subs.set(sub.id, sub);
    this.#ensureHeartbeat();
    return sub;
  }

  remove(id: number): void {
    this.#subs.delete(id);
    if (this.#subs.size === 0) this.#stopHeartbeat();
  }

  // Send one event to a single subscriber, skipping anything it has already seen
  // and evicting it when its buffer is over the cap or the write throws. Used
  // both for backlog replay and live broadcast.
  send(sub: Subscriber, event: LiveEvent): void {
    if (event.seq <= sub.lastSentSeq) return;
    // Advance the high-water mark only on a successful write, so an evicted
    // subscriber is never recorded as having "seen" an event it did not get.
    if (this.#writeOrEvict(sub, formatSseFrame(event))) {
      sub.lastSentSeq = event.seq;
    }
  }

  // Fan an event to every subscriber (each dedupes by its own high-water mark).
  // Iterate a snapshot of the values: a failed write may evict mid-loop.
  broadcast(event: LiveEvent): void {
    for (const sub of [...this.#subs.values()]) this.send(sub, event);
  }

  closeAll(): void {
    for (const sub of this.#subs.values()) {
      try {
        sub.res.end();
      } catch {
        /* already closed */
      }
    }
    this.#subs.clear();
    this.#stopHeartbeat();
  }

  // Write a chunk to a subscriber, evicting (and returning false) when its
  // outbound buffer is over the cap or the write throws. Isolates one bad
  // subscriber from the rest of the fan-out / heartbeat loop.
  #writeOrEvict(sub: Subscriber, chunk: string): boolean {
    if (sub.res.writableLength > this.#maxBufferBytes) {
      this.#evict(sub.id);
      return false;
    }
    try {
      sub.res.write(chunk);
      return true;
    } catch {
      this.#evict(sub.id);
      return false;
    }
  }

  #evict(id: number): void {
    const sub = this.#subs.get(id);
    if (!sub) return;
    try {
      sub.res.end();
    } catch {
      /* already closed */
    }
    this.remove(id);
  }

  #ensureHeartbeat(): void {
    if (this.#heartbeat) return;
    this.#heartbeat = setInterval(() => {
      for (const sub of [...this.#subs.values()]) {
        this.#writeOrEvict(sub, ": heartbeat\n\n");
      }
    }, this.#heartbeatMs);
    this.#heartbeat.unref();
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
  }
}
