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
import type { GqlClient } from "./graphql.ts";
import type { RestClient } from "./rest.ts";

export interface SourceDescriptor {
  sourceId: string; // stable handle, e.g. "github:github.com" (no '|')
  kind: string; // github | gitlab | ...
  host: string;
  displayName: string | null;
}

// Per-source fetch tuning shared by the provider implementations (mapped from
// the snake_case SourceConfig fields by the registry).
export interface SourceOptions {
  // "all" (default) also labels commits on live side branches, discovered from
  // push events and fetched as branch-unique compare sets; "default" keeps the
  // commit feed restricted to the default branch (the pre-expansion behavior).
  commitBranches?: "all" | "default";
  // Optional per-project clients. Providers that do not need repo-level token
  // routing ignore it; projects not present here use source-level default clients.
  projectClients?: ReadonlyMap<string, { gql: GqlClient; rest: RestClient | null }>;
  // If auth resolution forced the registry to omit configured projects from this
  // source, the provider fetch can still run for covered projects but must
  // report an incomplete sweep so full runs never tombstone the omitted repos.
  partialReason?: string | null;
}

export interface SourceRunTelemetry {
  graphqlRequests: number;
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

// One source's per-item resolve result, collected from a bounded-concurrency
// pass (see lib/concurrency.ts) and reduced afterwards. `record` is null when
// the item yielded nothing to store (e.g. a refresh candidate that 404'd or a
// malformed path); `error` is non-null when the per-item resolve failed. The
// reduction folds `error` into the sweep's `complete`/`firstError` in input
// order so a single bad item degrades the run instead of aborting it, and
// always guards `record` with a null check before pushing.
export interface ResolveOutcome {
  record: RawRecord | null;
  error: string | null;
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

export interface RefreshCandidate {
  externalId: string;
  projectPath: string;
  iid: number;
  reason: "ci_unresolved" | "open_change_request" | "recent_change_request";
}

export interface Source {
  readonly descriptor: SourceDescriptor;
  // Impure: network/IO allowed. Returns raw records + watermark + completeness.
  fetch(opts: FetchOptions): Promise<FetchResult>;
  // Optional impure freshness repair for provider state that changes without
  // bumping the provider's item-updated watermark, such as GitHub CI rollups.
  fetchRefresh?(candidates: RefreshCandidate[], opts: FetchOptions): Promise<FetchResult>;
  // Pure: raw record -> canonical bundle. Returns null to drop a record the
  // source recognizes but does not map (e.g. an entity kind we ignore). MUST be
  // deterministic and side-effect-free so it is replayable.
  normalize(raw: RawRecord): NormalizedBundle | null;
  // The normalizer version stamped onto produced items (`item.normalized_with`).
  // Bump when normalization logic changes so a replay sweep can target stale rows.
  readonly normalizerVersion: string;
}
