// Build the contract envelope (LAYER 3) from canonical DB rows. Pure mapping:
// given rows + a `generatedAt` instant, produce the versioned envelope. No DB
// access here, so it is unit-testable with fabricated rows.

import type { ItemRow, LabelRow, EdgeRow, SourceRow } from "../db/repo.ts";
import type {
  ContractEnvelope,
  ItemDTO,
  EdgeDTO,
  SourceDTO,
  LabelDTO,
} from "./types.ts";
import type { ItemState, ReviewState, CiState, MergeState, EdgeLifecycle } from "../model/types.ts";
import { refOf } from "../model/ref.ts";
import { CONTRACT_VERSION, GENERATOR } from "./version.ts";

const asState = (s: string): ItemState => s as ItemState;
const orNull = <T extends string>(s: string | null): T | null => (s === null ? null : (s as T));

function toLabelDTO(l: LabelRow): LabelDTO {
  return { name: l.name, scope: l.scope, color: l.color };
}

function toItemDTO(row: ItemRow, labels: LabelRow[]): ItemDTO {
  return {
    id: refOf(row.source_id, row.external_id),
    source_id: row.source_id,
    external_id: row.external_id,
    kind: row.kind,
    project_path: row.project_path,
    iid: row.iid,
    url: row.url ?? "",
    title: row.title,
    state: asState(row.state),
    state_raw: row.state_raw,
    state_reason: row.state_reason,
    is_draft: row.is_draft === null ? null : row.is_draft !== 0,
    author: row.author,
    created_at: row.created_at,
    updated_at: row.updated_at,
    closed_at: row.closed_at,
    merged_at: row.merged_at,
    labels: labels.map(toLabelDTO),
    review_state: orNull<ReviewState>(row.review_state),
    ci_state: orNull<CiState>(row.ci_state),
    merge_state: orNull<MergeState>(row.merge_state),
    milestone: row.milestone,
    demand: row.demand,
    last_seen_at: row.last_seen_at,
  };
}

function toEdgeDTO(row: EdgeRow): EdgeDTO {
  return {
    type: row.type,
    from: refOf(row.from_source_id, row.from_external_id),
    to: refOf(row.to_source_id, row.to_external_id),
    from_state: orNull<ItemState>(row.from_state),
    to_state: orNull<ItemState>(row.to_state),
    lifecycle: orNull<EdgeLifecycle>(row.lifecycle),
  };
}

function toSourceDTO(row: SourceRow): SourceDTO {
  return {
    source_id: row.source_id,
    kind: row.kind,
    host: row.host,
    display_name: row.display_name,
    last_success_at: row.last_success_at,
    last_status: orNull<"ok" | "partial" | "error">(row.last_status),
  };
}

export interface BuildInput {
  sources: SourceRow[];
  items: ItemRow[];
  labels: LabelRow[];
  edges: EdgeRow[];
  generatedAt: string;
}

export function buildContract(input: BuildInput): ContractEnvelope {
  const labelsByItem = new Map<number, LabelRow[]>();
  for (const l of input.labels) {
    const arr = labelsByItem.get(l.item_id) ?? [];
    arr.push(l);
    labelsByItem.set(l.item_id, arr);
  }
  return {
    contract_version: CONTRACT_VERSION,
    generated_at: input.generatedAt,
    generator: GENERATOR,
    sources: input.sources.map(toSourceDTO),
    items: input.items.map((it) => toItemDTO(it, labelsByItem.get(it.item_id) ?? [])),
    edges: input.edges.map(toEdgeDTO),
  };
}
