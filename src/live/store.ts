// Dedicated append-only live-event store. SQLite-only by Decision 3 (a
// freshness buffer, not a system of record), so unlike the canonical `Store` it
// is a plain synchronous class — no async-over-sync driver-parity wrapper, no
// Postgres driver, and crucially NO writer lease: it is not the canonical sync
// writer and must never contend on the canonical single-writer guarantee. It
// imports neither the canonical store, the product contract, a provider token,
// nor config. WAL lets a reader tail the stream while the single receiver
// appends. See docs/plans/2026-06-20-live-event-stream.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  LIVE_EVENT_SCHEMA,
  stripNul,
  type LiveActor,
  type LiveDelivery,
  type LiveEvent,
  type LiveEventInput,
  type LiveTarget,
} from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = resolve(__dirname, "schema.sql");

// The live store owns its own version cursor (PRAGMA user_version), independent
// of the canonical store's schema version.
const LIVE_SCHEMA_VERSION = 1;

export const DEFAULT_RECENT_LIMIT = 200;
export const DEFAULT_SINCE_LIMIT = 1000;

interface LiveEventRow {
  seq: number;
  source_id: string;
  event_id: string;
  provider: string;
  received_at: string;
  occurred_at: string | null;
  event_type: string;
  action: string | null;
  category: string;
  actor_json: string | null;
  target_json: string | null;
  title: string | null;
  body: string | null;
  url: string | null;
  review_state: string | null;
  delivery_json: string | null;
  provider_details_json: string | null;
  raw_json: string | null;
}

// node:sqlite forbids binding `undefined`; coerce nullable text to null and
// strip any NUL byte so a raw 0x00 never lands in a TEXT column.
const text = (v: string | null | undefined): string | null => stripNul(v ?? null);

const jsonOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : JSON.stringify(v);

function parseJson<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function rowToEvent(row: LiveEventRow): LiveEvent {
  return {
    schema: LIVE_EVENT_SCHEMA,
    seq: row.seq,
    event_id: row.event_id,
    source_id: row.source_id,
    provider: row.provider,
    received_at: row.received_at,
    occurred_at: row.occurred_at,
    event_type: row.event_type,
    action: row.action,
    category: row.category,
    actor: parseJson<LiveActor>(row.actor_json),
    target: parseJson<LiveTarget>(row.target_json),
    title: row.title,
    body: row.body,
    url: row.url,
    review_state: row.review_state,
    // Only verified deliveries are persisted; fall back to a minimal verified
    // descriptor if an older row predates the delivery column.
    delivery: parseJson<LiveDelivery>(row.delivery_json) ?? {
      delivery_id: row.event_id,
      event_header: row.event_type,
      signature_status: "verified",
    },
    provider_details: parseJson<Record<string, unknown>>(row.provider_details_json),
    raw: parseJson<Record<string, unknown>>(row.raw_json),
  };
}

const SELECT_COLUMNS = `seq, source_id, event_id, provider, received_at,
  occurred_at, event_type, action, category, actor_json, target_json, title,
  body, url, review_state, delivery_json, provider_details_json, raw_json`;

export class LiveStore {
  readonly #db: DatabaseSync;
  readonly #path: string;

  constructor(db: DatabaseSync, path: string) {
    this.#db = db;
    this.#path = path;
  }

  get path(): string {
    return this.#path;
  }

  // Insert-or-ignore on (source_id, event_id, ordinal). Returns the assigned
  // seq for a new row, or the existing seq for a redelivery (append-only: the
  // first write wins, never an in-place update). `ordinal` lets one delivery
  // produce several rows; it defaults to 0 for the common single-event case.
  append(input: LiveEventInput, ordinal = 0): number {
    const sourceId = text(input.source_id);
    const eventId = text(input.event_id);
    const inserted = this.#db
      .prepare(
        `INSERT INTO live_event (
           source_id, event_id, ordinal, provider, received_at, occurred_at,
           event_type, action, category, actor_json, target_json, title, body,
           url, review_state, delivery_json, provider_details_json, raw_json,
           created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(source_id, event_id, ordinal) DO NOTHING
         RETURNING seq`,
      )
      .get(
        sourceId,
        eventId,
        ordinal,
        text(input.provider),
        text(input.received_at),
        text(input.occurred_at),
        text(input.event_type),
        text(input.action),
        text(input.category),
        jsonOrNull(input.actor),
        jsonOrNull(input.target),
        text(input.title),
        text(input.body),
        text(input.url),
        text(input.review_state),
        jsonOrNull(input.delivery),
        jsonOrNull(input.provider_details),
        jsonOrNull(input.raw),
        new Date().toISOString(),
      ) as { seq: number } | undefined;
    if (inserted) return inserted.seq;
    const existing = this.#db
      .prepare(
        `SELECT seq FROM live_event
         WHERE source_id=? AND event_id=? AND ordinal=?`,
      )
      .get(sourceId, eventId, ordinal) as { seq: number };
    return existing.seq;
  }

  // Replay backlog: rows strictly after `seq`, oldest-first, bounded by limit.
  // The SSE `Last-Event-ID` cursor reads from here.
  since(seq: number, limit = DEFAULT_SINCE_LIMIT): LiveEvent[] {
    const rows = this.#db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM live_event
         WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(seq, limit) as unknown as LiveEventRow[];
    return rows.map(rowToEvent);
  }

  // Snapshot: most recent rows, newest-first, bounded by limit.
  recent(limit = DEFAULT_RECENT_LIMIT): LiveEvent[] {
    const rows = this.#db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM live_event ORDER BY seq DESC LIMIT ?`,
      )
      .all(limit) as unknown as LiveEventRow[];
    return rows.map(rowToEvent);
  }

  // Highest seq currently retained, or 0 when empty. Served alongside the
  // snapshot so a client can seed its `since` cursor.
  maxSeq(): number {
    const row = this.#db
      .prepare(`SELECT MAX(seq) AS m FROM live_event`)
      .get() as { m: number | null };
    return row.m ?? 0;
  }

  // Drop rows older than the TTL, then trim to the row cap (oldest first).
  // Returns the number of rows deleted. Bounds the SSE replay backlog as a
  // side effect. `now` is injectable for deterministic tests.
  prune(ttlDays: number, maxRows: number, now: Date = new Date()): number {
    const cutoff = new Date(now.getTime() - ttlDays * 86_400_000).toISOString();
    const byTtl = this.#db
      .prepare(
        `DELETE FROM live_event WHERE julianday(received_at) < julianday(?)`,
      )
      .run(cutoff);
    const byCap = this.#db
      .prepare(
        `DELETE FROM live_event
         WHERE seq NOT IN (SELECT seq FROM live_event ORDER BY seq DESC LIMIT ?)`,
      )
      .run(maxRows);
    return Number(byTtl.changes) + Number(byCap.changes);
  }

  close(): void {
    this.#db.close();
  }
}

export function openLiveStore(path: string): LiveStore {
  if (path !== ":memory:") {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(readFileSync(SCHEMA_FILE, "utf8"));
  // user_version takes an integer literal; LIVE_SCHEMA_VERSION is a constant.
  db.exec(`PRAGMA user_version = ${LIVE_SCHEMA_VERSION}`);
  return new LiveStore(db, path);
}
