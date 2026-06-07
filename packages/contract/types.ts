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

// ---- DTOs (the serialized envelope shape) -----------------------------------

export interface SourceDTO {
  source_id: string;
  kind: string;
  host: string;
  display_name: string | null;
  last_success_at: string | null;
  last_status: "ok" | "partial" | "error" | null;
}

export interface LabelDTO {
  name: string;
  scope: string | null;
  color: string | null;
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
  milestone: string | null;
  demand: number | null;
  last_seen_at: string | null;
}

export interface EdgeDTO {
  type: string;
  from: Ref;
  to: Ref;
  from_state: ItemState | null;
  to_state: ItemState | null;
  lifecycle: EdgeLifecycle | null;
}

export interface ContractEnvelope {
  contract_version: string;
  generated_at: string;
  generator: string;
  sources: SourceDTO[];
  items: ItemDTO[];
  edges: EdgeDTO[];
}
