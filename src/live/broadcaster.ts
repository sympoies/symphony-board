// In-process SSE broadcaster. Holds the set of open `/api/live` connections and
// fans verified events to them. Each subscriber tracks a high-water `seq`, so
// the replay-then-live handoff dedupes by seq: a subscriber is registered BEFORE
// its backlog replay (closing the replay-to-subscribe gap), and any event it has
// already been sent is skipped. Bounded connection count; an idle heartbeat
// keeps intermediaries from dropping the connection. Never imports the canonical
// store.
import type { ServerResponse } from "node:http";
import type { LiveEvent } from "./types.ts";

export const DEFAULT_MAX_CONNECTIONS = 100;
export const HEARTBEAT_MS = 15_000;

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
  #nextId = 1;
  #heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(maxConnections: number = DEFAULT_MAX_CONNECTIONS) {
    this.#maxConnections = maxConnections;
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

  // Send one event to a single subscriber, skipping anything it has already
  // seen. Used both for backlog replay and live broadcast.
  send(sub: Subscriber, event: LiveEvent): void {
    if (event.seq <= sub.lastSentSeq) return;
    sub.lastSentSeq = event.seq;
    sub.res.write(formatSseFrame(event));
  }

  // Fan an event to every subscriber (each dedupes by its own high-water mark).
  broadcast(event: LiveEvent): void {
    for (const sub of this.#subs.values()) this.send(sub, event);
  }

  closeAll(): void {
    for (const sub of this.#subs.values()) sub.res.end();
    this.#subs.clear();
    this.#stopHeartbeat();
  }

  #ensureHeartbeat(): void {
    if (this.#heartbeat) return;
    this.#heartbeat = setInterval(() => {
      for (const sub of this.#subs.values()) sub.res.write(": heartbeat\n\n");
    }, HEARTBEAT_MS);
    this.#heartbeat.unref();
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = null;
    }
  }
}
