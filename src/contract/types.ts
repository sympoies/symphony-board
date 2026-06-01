// Contract DTOs (LAYER 3). These mirror schema/contract.schema.json — the JSON
// Schema is the normative artifact; these types are the producer-side mirror.
// Keep them in lock-step: a change here is a contract change and must follow the
// versioning rules (docs/CONTRACT.md).
//
// A composite ref is "<source_id>|<external_id>"; see refOf()/parseRef().

import type {
  ItemState,
  ReviewState,
  CiState,
  MergeState,
  EdgeLifecycle,
} from "../model/types.ts";

export type Ref = string; // "<source_id>|<external_id>"

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
