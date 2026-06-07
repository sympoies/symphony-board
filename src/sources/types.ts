// The Source interface. A record source is anything that can yield raw
// records and normalize them into the canonical model. GitHub and GitLab are the
// first two; a new source (a tracker, a CSV, another forge) implements this and
// the DB + contract are unchanged because they were designed provider-agnostic.
//
// The split is deliberate: `fetch` is the ONLY part that does network/IO and is
// allowed to be impure; `normalize` is a PURE function (raw -> canonical) so it
// can be unit-tested and, crucially, REPLAYED offline against stored raw when
// normalization rules change (this is what makes contract migration not require
// re-fetching — see DESIGN.md).

import type { NormalizedBundle } from "../model/types.ts";

export interface SourceDescriptor {
  sourceId: string; // stable handle, e.g. "github:github.com" (no '|')
  kind: string; // github | gitlab | ...
  host: string;
  displayName: string | null;
}

export interface FetchOptions {
  // Incremental watermark: only fetch records updated at/after this ISO instant.
  // null => no lower bound (used on the first run or a forced full sync).
  since: string | null;
  // full = exhaustive sweep of every tracked project (enables the soft-delete
  // sweep). incremental = only changed-since records (never soft-deletes).
  full: boolean;
}

// One opaque provider record (LAYER 1). `payload` is stored verbatim as JSON.
export interface RawRecord {
  entityKind: string; // issue | change_request | ...
  externalId: string; // provider immutable global id
  apiVersion: string | null;
  fetchedAt: string; // ISO-8601 UTC
  payload: unknown; // serialized as-is into raw.payload
  contentHash: string | null; // optional: lets the engine skip unchanged rows
}

export interface FetchResult {
  records: RawRecord[];
  // New watermark to persist for the next incremental run (e.g. max updatedAt
  // seen). null => leave the stored watermark unchanged.
  watermark: string | null;
  // false => this was a partial/failed sweep (rate-limited, VPN drop, auth
  // loss). The engine MUST NOT soft-delete unseen items on a partial result.
  complete: boolean;
  // First error encountered on a partial sweep (recorded to sync_state), or null.
  error: string | null;
}

export interface Source {
  readonly descriptor: SourceDescriptor;
  // Impure: network/IO allowed. Returns raw records + watermark + completeness.
  fetch(opts: FetchOptions): Promise<FetchResult>;
  // Pure: raw record -> canonical bundle. Returns null to drop a record the
  // source recognizes but does not map (e.g. an entity kind we ignore). MUST be
  // deterministic and side-effect-free so it is replayable.
  normalize(raw: RawRecord): NormalizedBundle | null;
  // The normalizer version stamped onto produced items (`item.normalized_with`).
  // Bump when normalization logic changes so a replay sweep can target stale rows.
  readonly normalizerVersion: string;
}
