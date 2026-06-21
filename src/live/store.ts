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
const LIVE_SCHEMA_VERSION = 2;
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

export interface LiveActorProfileInput {
  source_id: string;
  provider: string;
  login: string;
  display_name?: string | null;
  avatar_url?: string | null;
  profile_url?: string | null;
  fetched_at: string;
  expires_at: string;
  last_error?: string | null;
}

interface LiveActorProfileRow {
  display_name: string | null;
  avatar_url: string | null;
  profile_url: string | null;
  expires_at: string;
  last_error: string | null;
}

// node:sqlite forbids binding `undefined`; coerce nullable text to null and
// strip any NUL byte so a raw 0x00 never lands in a TEXT column.
const text = (v: string | null | undefined): string | null => stripNul(v ?? null);

const jsonOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : JSON.stringify(v);

function loginKey(login: string | null | undefined): string | null {
  const value = text(login)?.trim();
  return value ? value.toLowerCase() : null;
}

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

// Build the persisted LiveEvent view from a freshly-appended input plus its
// store-assigned seq, applying the SAME text normalization the columns store, so
// a just-appended event broadcast over SSE is identical to the same event later
// read back via since()/recent() — letting the receiver fan out without a
// re-query. JSON fields round-trip structurally (parseJson(jsonOrNull(x)) ≡ x).
function inputToEvent(input: LiveEventInput, seq: number): LiveEvent {
  return {
    schema: LIVE_EVENT_SCHEMA,
    seq,
    event_id: text(input.event_id) ?? "",
    source_id: text(input.source_id) ?? "",
    provider: text(input.provider) ?? "",
    received_at: text(input.received_at) ?? "",
    occurred_at: text(input.occurred_at),
    event_type: text(input.event_type) ?? "",
    action: text(input.action),
    category: text(input.category) ?? "",
    actor: input.actor ?? null,
    target: input.target ?? null,
    title: text(input.title),
    body: text(input.body),
    url: text(input.url),
    review_state: text(input.review_state),
    delivery: input.delivery,
    provider_details: input.provider_details ?? null,
    raw: input.raw ?? null,
  };
}

const SELECT_COLUMNS = `seq, source_id, event_id, provider, received_at,
  occurred_at, event_type, action, category, actor_json, target_json, title,
  body, url, review_state, delivery_json, provider_details_json, raw_json`;

interface LiveActorProfileKey {
  sourceId: string;
  provider: string;
  login: string;
}

interface LiveActorProfileLookupRow extends LiveActorProfileRow {
  source_id: string;
  provider: string;
  login: string;
}

function actorNeedsHydration(actor: LiveActor | null | undefined): actor is LiveActor {
  return !!actor?.login && (!actor.display_name || !actor.avatar_url || !actor.profile_url);
}

function actorProfileKey(sourceId: string, provider: string, login: string): string {
  return `${sourceId}\x1f${provider}\x1f${login}`;
}

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

  upsertActorProfile(profile: LiveActorProfileInput): void {
    const sourceId = text(profile.source_id);
    const provider = text(profile.provider);
    const login = loginKey(profile.login);
    const fetchedAt = text(profile.fetched_at);
    const expiresAt = text(profile.expires_at);
    if (!sourceId || !provider || !login || !fetchedAt || !expiresAt) return;
    this.#db
      .prepare(
        `INSERT INTO live_actor_profile (
           source_id, provider, login, display_name, avatar_url, profile_url,
           fetched_at, expires_at, last_error
         ) VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(source_id, provider, login) DO UPDATE SET
           display_name=CASE
             WHEN excluded.last_error IS NOT NULL THEN excluded.display_name
             ELSE COALESCE(excluded.display_name, live_actor_profile.display_name)
           END,
           avatar_url=CASE
             WHEN excluded.last_error IS NOT NULL THEN excluded.avatar_url
             ELSE COALESCE(excluded.avatar_url, live_actor_profile.avatar_url)
           END,
           profile_url=CASE
             WHEN excluded.last_error IS NOT NULL THEN excluded.profile_url
             ELSE COALESCE(excluded.profile_url, live_actor_profile.profile_url)
           END,
           fetched_at=excluded.fetched_at,
           expires_at=excluded.expires_at,
           last_error=excluded.last_error`,
      )
      .run(
        sourceId,
        provider,
        login,
        text(profile.display_name),
        text(profile.avatar_url),
        text(profile.profile_url),
        fetchedAt,
        expiresAt,
        text(profile.last_error),
      );
  }

  hasFreshResolvedActorProfile(
    sourceId: string,
    provider: string,
    login: string,
    now: Date = new Date(),
  ): boolean {
    const profile = this.#actorProfile(sourceId, provider, login, now.toISOString());
    return profile !== null && (profile.last_error !== null || profile.avatar_url !== null);
  }

  #actorProfile(
    sourceId: string,
    provider: string,
    login: string,
    nowIso: string,
  ): LiveActorProfileRow | null {
    const source = text(sourceId);
    const providerText = text(provider);
    const loginText = loginKey(login);
    if (!source || !providerText || !loginText) return null;
    const row = this.#db
      .prepare(
        `SELECT display_name, avatar_url, profile_url, expires_at, last_error
         FROM live_actor_profile
         WHERE source_id = ? AND provider = ? AND login = ? AND expires_at >= ?`,
      )
      .get(source, providerText, loginText, nowIso) as LiveActorProfileRow | undefined;
    return row ?? null;
  }

  #actorProfiles(
    keys: LiveActorProfileKey[],
    nowIso: string,
  ): Map<string, LiveActorProfileRow> {
    const profiles = new Map<string, LiveActorProfileRow>();
    const chunkSize = 200;
    for (let i = 0; i < keys.length; i += chunkSize) {
      const chunk = keys.slice(i, i + chunkSize);
      const tuples = chunk.map(() => "(?,?,?)").join(",");
      const params: string[] = [nowIso];
      for (const key of chunk) params.push(key.sourceId, key.provider, key.login);
      const rows = this.#db
        .prepare(
          `SELECT source_id, provider, login, display_name, avatar_url, profile_url, expires_at, last_error
           FROM live_actor_profile
           WHERE expires_at >= ? AND (source_id, provider, login) IN (${tuples})`,
        )
        .all(...params) as unknown as LiveActorProfileLookupRow[];
      for (const row of rows) {
        profiles.set(actorProfileKey(row.source_id, row.provider, row.login), row);
      }
    }
    return profiles;
  }

  #hydrateEventFromProfiles(
    ev: LiveEvent,
    profiles: Map<string, LiveActorProfileRow>,
  ): LiveEvent {
    const actor = ev.actor;
    const login = actor?.login;
    const loginText = loginKey(login);
    if (!actor || !loginText) return ev;
    const profile = profiles.get(actorProfileKey(ev.source_id, ev.provider, loginText));
    if (!profile) return ev;
    const next: LiveActor = {
      ...actor,
      display_name: actor.display_name ?? profile.display_name,
      avatar_url: actor.avatar_url ?? profile.avatar_url,
      profile_url: actor.profile_url ?? profile.profile_url,
    };
    if (
      next.display_name === actor.display_name &&
      next.avatar_url === actor.avatar_url &&
      next.profile_url === actor.profile_url
    ) {
      return ev;
    }
    return { ...ev, actor: next };
  }

  hydrateEvents(events: LiveEvent[], now: Date = new Date()): LiveEvent[] {
    if (events.length === 0) return events;
    const keys = new Map<string, LiveActorProfileKey>();
    for (const ev of events) {
      if (!actorNeedsHydration(ev.actor)) continue;
      const sourceId = text(ev.source_id);
      const provider = text(ev.provider);
      const login = loginKey(ev.actor.login);
      if (!sourceId || !provider || !login) continue;
      keys.set(actorProfileKey(sourceId, provider, login), { sourceId, provider, login });
    }
    if (keys.size === 0) return events;
    const profiles = this.#actorProfiles([...keys.values()], now.toISOString());
    if (profiles.size === 0) return events;
    return events.map((ev) => this.#hydrateEventFromProfiles(ev, profiles));
  }

  // Insert-or-ignore on (source_id, event_id, ordinal). Returns the persisted
  // LiveEvent for a NEW row, or null for a redelivery (append-only: the first
  // write wins, never an in-place update). The null return is what makes a
  // redelivery non-rebroadcast at the receiver. `ordinal` lets one delivery
  // produce several rows; it defaults to 0 for the common single-event case.
  append(input: LiveEventInput, ordinal = 0): LiveEvent | null {
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
    // Redelivery: the (source_id, event_id, ordinal) row already exists. Signal
    // "nothing new" so the receiver does not rebroadcast a duplicate.
    if (!inserted) return null;
    return inputToEvent(input, inserted.seq);
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
    return this.hydrateEvents(rows.map(rowToEvent));
  }

  // Snapshot delta: rows strictly after `seq`, newest-first, bounded by limit.
  // This keeps polling snapshots cheap when the UI already has a cursor.
  sinceDesc(seq: number, limit = DEFAULT_SINCE_LIMIT): LiveEvent[] {
    const rows = this.#db
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM live_event
         WHERE seq > ? ORDER BY seq DESC LIMIT ?`,
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
    return this.hydrateEvents(rows.map(rowToEvent));
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
    // received_at is always ISO-8601 UTC (Z), so a lexical compare is
    // instant-correct AND uses the live_event_received_at index — julianday()
    // wrapped the column and forced a full scan.
    const byTtl = this.#db
      .prepare(`DELETE FROM live_event WHERE received_at < ?`)
      .run(cutoff);
    const byProfileTtl = this.#db
      .prepare(`DELETE FROM live_actor_profile WHERE expires_at < ?`)
      .run(now.toISOString());
    // Row cap: find the seq of the (maxRows+1)-th newest row via one indexed
    // range over the seq primary key, then delete at/below it — instead of a
    // whole-table NOT IN anti-join.
    const cutoffRow = this.#db
      .prepare(`SELECT seq FROM live_event ORDER BY seq DESC LIMIT 1 OFFSET ?`)
      .get(maxRows) as { seq: number } | undefined;
    let byCapChanges = 0;
    if (cutoffRow) {
      byCapChanges = Number(
        this.#db
          .prepare(`DELETE FROM live_event WHERE seq <= ?`)
          .run(cutoffRow.seq).changes,
      );
    }
    return Number(byTtl.changes) + byCapChanges + Number(byProfileTtl.changes);
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
