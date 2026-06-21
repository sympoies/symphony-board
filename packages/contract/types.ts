// symphony-board contract types (LAYER 3) — the mirror of contract.schema.json.
//
// The JSON Schema (contract.schema.json) is the NORMATIVE artifact; these types
// are the TypeScript mirror that producers and consumers share. Keep them in
// lock-step: a change here is a contract change and must follow the versioning
// rules in docs/CONTRACT.md.
//
// This package is self-contained on purpose — it imports nothing from the
// backend (src/), so a consumer (the UI, an external tool) can depend on the
// contract WITHOUT dragging in LAYER 2 (the canonical model) or the providers.
// It is also type-only at runtime: there are no runtime values here, so a
// consumer running under Node's type-stripping never has to resolve this
// package at runtime (the imports erase). The producer constants (CONTRACT_VERSION,
// GENERATOR) and the validator live with the producer (the backend).
//
// A composite ref is "<source_id>|<external_id>"; split on the FIRST '|' only
// (source_id never contains '|'; an external_id may, e.g. a GitLab gid).

export type Ref = string; // "<source_id>|<external_id>"

// ---- Shared enum vocabularies (encoded as schema `enum`s) -------------------
// These are the closed value sets the contract commits to. LAYER 2 re-exports
// them so the canonical model and the contract speak the same words.

// Normalized item lifecycle. `merged` applies only to a change request.
export type ItemState = "open" | "closed" | "merged";

// Optional extension signals (all nullable; provider derivation differs).
export type ReviewState = "approved" | "changes_requested" | "review_required";
export type CiState = "passing" | "failing" | "pending" | "none";
export type MergeState = "mergeable" | "conflicting" | "blocked" | "unknown";

// Derived state of a `closes` edge.
export type EdgeLifecycle = "declared" | "fulfilled" | "broken";

// Named aggregate scopes. These intentionally mirror the UI view-scope
// vocabulary so contract-provided totals cannot silently mean a different
// window than the summary beside them.
export type AggregateScope = "global" | "boardWindow" | "graphWindow" | "focus";

// How an aggregate's row set was selected. `focus` is schema-supported for
// consumers that compute/persist focus-local aggregates, but the backend does
// not emit focus rows because focus is viewer-local.
export type AggregateWindowKind = "full" | "active_since" | "focus";
export type AggregateBasis =
  | "full_contract"
  | "item_updated_at"
  | "edge_endpoint_updated_at"
  | "focus_neighborhood";
export type AggregateEdgeFilter = "all" | "no_mentions";
export type ItemWindowReason = "primary" | "edge_endpoint";

export interface TimeRangeDTO {
  from: string;
  to: string;
}

export interface RangeQueryDTO extends TimeRangeDTO {
  kind: "time_range";
  // The IANA timezone the producer used to bucket calendar days (e.g. "UTC" or
  // "Asia/Taipei"). Comes from config; "UTC" when unset. Relaxed from the literal
  // "UTC" in 3.1.0 — the same value as the envelope-level `timezone`. The `from`
  // and `to` instants below are already expanded at this zone's day boundaries.
  timezone: string;
}

export interface AggregateStatsDTO {
  items: number;
  by_state: Record<string, number>;
  by_kind: Record<string, number>;
  by_lifecycle: Record<string, number>;
}

export interface AggregateWindowDTO {
  kind: AggregateWindowKind;
  basis: AggregateBasis;
  since: string | null;
  days: number | null;
  edge_filter: AggregateEdgeFilter | null;
}

export interface AggregateDTO {
  scope: AggregateScope;
  window: AggregateWindowDTO;
  stats: AggregateStatsDTO;
}

export interface ItemWindowDTO {
  scope: Extract<AggregateScope, "boardWindow">;
  window: AggregateWindowDTO;
  primary_items: number;
  edge_endpoint_items: number;
  total_items: number;
  truncated: boolean;
}

export interface RepoStatsDTO {
  source_id: string;
  project_path: string | null;
  items: number;
  by_state: Record<string, number>;
  by_kind: Record<string, number>;
}

export type RepoMetricWindowKind = "time_range" | "active_since";
export type RepoMetricBasis = "repo_activity";
// Sub-day widths (`2h`/`4h`/`6h`, added in 3.5.0) tile a 1-3 day window for the
// Repo Analytics TREND sparkline; `day`/`week`/`month` cover longer windows.
export type RepoMetricBucket = "2h" | "4h" | "6h" | "day" | "week" | "month";

export interface RepoMetricWindowDTO {
  kind: RepoMetricWindowKind;
  basis: RepoMetricBasis;
  from: string;
  to: string;
  bucket: RepoMetricBucket;
}

export interface RepoMetricStatsDTO {
  items_active: number;
  items_opened: number;
  items_closed: number;
  change_requests_opened: number;
  change_requests_closed: number;
  change_requests_merged: number;
  activities: number;
  activity_score?: number;
  commits: number;
  pushes: number;
  comments: number;
  reviews: number;
  approvals: number;
  // Sum of open review threads across active change_requests in the window
  // (item-level `review_threads.open`). Added in 3.3.0; optional so pre-3.3.0
  // consumers stay valid.
  unresolved_review_threads?: number;
  edge_declared: number;
  edge_fulfilled: number;
  edge_broken: number;
  by_item_state: Record<string, number>;
  by_item_kind: Record<string, number>;
  by_activity_kind: Record<string, number>;
  by_activity_action: Record<string, number>;
  by_edge_type: Record<string, number>;
  by_edge_lifecycle: Record<string, number>;
  by_review_state: Record<string, number>;
  by_ci_state: Record<string, number>;
  by_merge_state: Record<string, number>;
  by_label_scope: Record<string, number>;
}

export interface RepoMetricSeriesPointDTO {
  bucket_start: string;
  bucket_end: string;
  stats: RepoMetricStatsDTO;
}

export interface RepoMetricActorDTO {
  // Backward-compatible display field (added before actor identity); equals
  // `display_name`. Kept so pre-2.3.0 consumers keep rendering.
  actor: string;
  // Stable, non-PII actor identity key (added in 2.3.0). Scheme-prefixed:
  // `provider-user:<source_id>:<username>`, `email:<hash>` (the raw address is
  // never exposed), or `name:<normalized>`. Use it as the row's stable key.
  actor_key: string;
  // Deterministically chosen display name for the identity (added in 2.3.0).
  display_name: string;
  // Other display names observed for the identity, sorted; omitted when none.
  aliases?: string[];
  // Canonical provider profile page for this actor (added in 3.4.0) —
  // `https://<host>/<username>` on a supported GitHub/GitLab source. Emitted for
  // a `provider-user:<source_id>:<username>` identity, and for a config-merged
  // `person:<slug>` identity via the provider username observed on this source
  // (a `person` row is per-source). Omitted when no username was observed here
  // (email/name-keyed authorship) and for unsupported sources — config-declared
  // usernames are host-agnostic, so they are never guessed onto a source. A
  // display/navigation convenience, not identity.
  profile_url?: string | null;
  activities: number;
  commits: number;
  items_opened: number;
  change_requests_merged: number;
}

export interface RepoMetricDataQualityDTO {
  // Whether any activity row was observed for the repo at all. False means the
  // commit/push/comment/review metrics are unreliable (only item lifecycle is
  // trustworthy); the Repo Analytics badge renders this as "no activity".
  activity_available: boolean;
  // The earliest and latest activity instants observed for the repo, across ALL
  // activity rows (not just the window) — so they can sit outside `window`. The
  // Repo Analytics row renders `last_activity_at` as "last active", and derives
  // its coverage badge by comparing both bounds to the window (see repoCoverage
  // in the UI model). Both are null when no activity row carries a parseable
  // timestamp.
  observed_since: string | null;
  last_activity_at: string | null;
  notes: string[];
}

export interface RepoMetricDTO {
  source_id: string;
  project_path: string | null;
  // Canonical provider repository page for this row, when the source kind/host
  // and project_path make it deterministic. null/absent when unknown or
  // malformed. Added in 3.2.0.
  repo_url?: string | null;
  window: RepoMetricWindowDTO;
  totals: RepoMetricStatsDTO;
  series: RepoMetricSeriesPointDTO[];
  top_actors?: RepoMetricActorDTO[];
  data_quality: RepoMetricDataQualityDTO;
}

// ---- DTOs (the serialized envelope shape) -----------------------------------

export interface SourceDTO {
  source_id: string;
  kind: string;
  host: string;
  display_name: string | null;
  last_success_at: string | null;
  last_status: "ok" | "partial" | "error" | null;
  // Optional source-level highlight color (hex), from config. A repo with no
  // color of its own inherits it. null when unset. (added in 1.1.0)
  color: string | null;
}

// Per-repo display metadata. Sparse: a repo appears here ONLY when it has a
// configured highlight color, so most repos are absent. Keyed by the same
// (source_id, project_path) a consumer derives from items. (added in 1.1.0)
export interface RepoDTO {
  source_id: string;
  project_path: string;
  color: string;
}

export interface LabelDTO {
  name: string;
  scope: string | null;
  color: string | null;
}

// Unresolved/total review-discussion threads on a change_request. `open` is the
// count still awaiting resolution; `total` is every resolvable thread. A
// point-in-time snapshot as of the owning item's last sync (like `ci_state`),
// NOT the state at any one review event's time.
export interface ReviewThreadsDTO {
  open: number;
  total: number;
}

export interface ItemDTO {
  id: Ref;
  source_id: string;
  external_id: string;
  kind: string;
  project_path: string | null;
  iid: number | null;
  url: string;
  title: string | null;
  state: ItemState;
  state_raw: string | null;
  state_reason: string | null;
  is_draft: boolean | null;
  author: string | null;
  created_at: string | null;
  updated_at: string | null;
  closed_at: string | null;
  merged_at: string | null;
  labels: LabelDTO[];
  review_state: ReviewState | null;
  ci_state: CiState | null;
  merge_state: MergeState | null;
  // Open/total review threads for a change_request, or null for issues and when
  // a provider did not report it. Added in 3.3.0 as an optional additive field
  // (absent in pre-3.3 payloads and not in the schema's item `required`), so it
  // is optional here like the other additive fields. See ReviewThreadsDTO.
  review_threads?: ReviewThreadsDTO | null;
  milestone: string | null;
  demand: number | null;
  last_seen_at: string | null;
  // Present in contract v2 windowed payloads. `primary` means the item is part
  // of the contract's primary Board item window; `edge_endpoint` means the item
  // is included so emitted edges resolve to concrete nodes instead of anonymous
  // refs. Consumers reading old v1 payloads should treat a missing value as
  // "primary".
  window_reasons?: ItemWindowReason[];
}

export interface EdgeDTO {
  type: string;
  from: Ref;
  to: Ref;
  from_state: ItemState | null;
  to_state: ItemState | null;
  lifecycle: EdgeLifecycle | null;
}

// Dropped in 4.0.0: the activity `id` (always `source_id|external_id`, a pure
// duplicate of those two fields — reconstruct with refOf/`${source_id}|${external_id}`
// when a composite key is needed) and `summary` (producer-authored display prose
// that the UI rebuilds from action/kind/target/title/details, so it carried no
// information the consumer cannot derive). Both removals fold into the 4.0.0
// reshape rather than a later major.
export interface ActivityDTO {
  source_id: string;
  external_id: string;
  kind: string;
  action: string;
  project_path: string | null;
  target_kind: string | null;
  target_ref: Ref | null;
  target_iid: number | null;
  title: string | null;
  url: string | null;
  actor: string | null;
  occurred_at: string;
  details: Record<string, unknown> | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

export interface ReviewThreadCommentDTO {
  id: string;
  author: string | null;
  // The comment author's avatar URL when the provider reported it, else null.
  // Added in 4.2.0; the producer always emits the key (null when absent), so the
  // schema keeps it required-but-nullable like the sibling comment fields.
  avatar_url: string | null;
  body: string | null;
  url: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface ReviewThreadDTO {
  id: Ref;
  source_id: string;
  external_id: string;
  project_path: string | null;
  target_ref: Ref;
  target_iid: number | null;
  title: string | null;
  url: string | null;
  is_resolved: boolean;
  is_outdated: boolean | null;
  resolved_by: string | null;
  path: string | null;
  line: number | null;
  start_line: number | null;
  comments_total: number;
  comments: ReviewThreadCommentDTO[];
  last_seen_at: string | null;
}

// One calendar day's activity counts (LAYER 3). Part of activity_daily.
export interface ActivityDailyBucketDTO {
  // Calendar day "YYYY-MM-DD" in the envelope `timezone`.
  date: string;
  // Total activity events on this day (== sum of by_kind values).
  count: number;
  // Per activity `kind` counts for this day (open vocabulary: commit, review, …).
  by_kind: Record<string, number>;
}

// Pre-computed per-day / per-kind activity counts spanning the FULL canonical
// activity history (added in 4.0.0). The Activity Overview (trailing-12-month
// block, heatmap, by-kind totals, busiest day, active days) reads this instead
// of the raw `activities[]` feed, which 4.0.0 windows to 30 days. Anchored to
// the contract `generated_at`: `to` is its calendar day in `timezone`, and the
// bucket totals reconcile with the full canonical activity set (so the overview
// numbers are unchanged by the raw-activity windowing). Optional: the static
// `contract.json` always emits it, but the `/api/range` projection does not.
export interface ActivityDailyDTO {
  // IANA timezone the days are bucketed in (equals the envelope `timezone`).
  timezone: string;
  // Earliest and latest covered calendar days, "YYYY-MM-DD". `to` is the
  // `generated_at` calendar day; `from` is the earliest day with activity (==
  // `to` when there is no activity at all).
  from: string;
  to: string;
  // Total events across every bucket; reconciles with the full canonical count.
  total: number;
  // Aggregate per-kind totals across every bucket (== sum of days[].by_kind).
  by_kind: Record<string, number>;
  // Ascending by date, SPARSE: only days with at least one event appear, so a
  // consumer fills gaps with zero. Keeps the payload small (the whole point).
  days: ActivityDailyBucketDTO[];
}

export interface ContractEnvelope {
  contract_version: string;
  generated_at: string;
  generator: string;
  // IANA timezone the producer uses to bucket calendar days, from config
  // (`timezone` in config/sources.json). "UTC" when unset. The UI reads it to
  // align its `today` / `this week` preset boundaries and the activity-heatmap
  // day cells to the configured zone instead of UTC. The producer always emits
  // it; OPTIONAL in the type so a consumer reading a pre-3.1.0 contract (no
  // `timezone` key) still type-checks — read it as `env.timezone ?? "UTC"`.
  // (added in 3.1.0)
  timezone?: string;
  sources: SourceDTO[];
  items: ItemDTO[];
  edges: EdgeDTO[];
  // Developer-significant activity records. Optional so pre-1.2.0 v1 contracts
  // remain readable; consumers should read it as `env.activities ?? []`. As of
  // 4.0.0 the static `contract.json` WINDOWS this to the last 30 days (anchored
  // to `generated_at`) — a breaking narrowing of an emitted row collection, like
  // the 2.0.0 `items[]` windowing. For trailing-12-month activity views read
  // `activity_daily`; for a wider raw feed fetch `/api/range` (which is NOT
  // windowed). The range API still returns the full requested span here.
  activities?: ActivityDTO[];
  // Current provider review-thread detail rows for the emitted item projection.
  // This is the thread inbox surface: current resolution state, location, and a
  // small synced comment preview. Added in 4.1.0. Optional so older v4 payloads
  // stay readable.
  review_threads?: ReviewThreadDTO[];
  // Pre-computed per-day / per-kind activity counts over the FULL canonical
  // activity history (added in 4.0.0), so the Activity Overview no longer needs
  // the full raw `activities[]`. Optional: the static `contract.json` always
  // emits it; the `/api/range` projection omits it. Read as `env.activity_daily`.
  activity_daily?: ActivityDailyDTO;
  // Per-repo display metadata (currently: highlight color). Sparse — only
  // configured repos appear. The producer always emits it (possibly empty);
  // OPTIONAL in the type so a consumer reading a pre-1.1.0 contract (no `repos`
  // key) still type-checks — read it as `env.repos ?? []`. (added in 1.1.0)
  repos?: RepoDTO[];
  // Optional server-provided totals aligned to the explicit view-scope
  // vocabulary. Added in 1.3.0; consumers fall back to local computation when a
  // local filter/window is not represented by a compatible aggregate row.
  aggregates?: AggregateDTO[];
  // Contract v2 metadata for the bounded item projection. `items[]` is complete
  // for this primary window, plus any extra edge endpoints needed by `edges[]`.
  item_window?: ItemWindowDTO;
  // Full canonical repo counts for Settings and external consumers. This stays
  // separate from `items[]` because v2 no longer ships every item row.
  repo_stats?: RepoStatsDTO[];
  // Window-scoped per-repo analytics rows. This is separate from `repo_stats[]`:
  // repo_stats is full inventory, while repo_metrics is a selected time window
  // with activity/lifecycle trends and data-quality metadata. Added in 2.2.0.
  repo_metrics?: RepoMetricDTO[];
  // Present on dynamic read-only range-query API responses, not on the static
  // daemon-emitted `contract.json`. The UI uses it to label explicit historical
  // windows without changing the static v2 payload contract.
  range_query?: RangeQueryDTO;
}
