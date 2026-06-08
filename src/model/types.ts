// Canonical model (LAYER 2). Provider-agnostic shapes that the normalized DB
// rows map to. Nothing here may bake in a single provider's vocabulary — `kind`
// and edge `type` are open string unions with the known members listed.

// The contract's CLOSED enum vocabularies (ItemState, the extension signals, and
// the edge lifecycle) live in @symphony-board/contract (LAYER 3). We import them
// for use in the shapes below and re-export them so the canonical model speaks
// the same words as the contract — one definition, not two that can drift.
// `ItemKind` and `EdgeType` stay LAYER-2-local: the contract carries them as
// open `string`s, not enums.
import type { ItemState, ReviewState, CiState, MergeState, EdgeLifecycle } from "@symphony-board/contract";
export type { ItemState, ReviewState, CiState, MergeState, EdgeLifecycle };

// What an item is. Open vocabulary: a future source may add kinds. The two we
// model today:
export type ItemKind = "issue" | "change_request";

// Edge relationship types. `closes` is the workflow-bearing issue<->PR/MR link.
// Open vocabulary; the listed members are what we reconcile today.
export type EdgeType =
  | "closes"
  | "relates"
  | "mentions"
  | "blocks"
  | "blocked_by"
  | "parent"
  | "child";

export interface CanonicalLabel {
  name: string; // verbatim provider label
  scope: string | null; // parsed "scope::value" prefix, or null
  color: string | null;
}

// An endpoint reference: the immutable identity of an item. Stored on edges so a
// link survives even when one endpoint is in an untracked project.
export interface ItemEndpoint {
  sourceId: string;
  externalId: string;
}

export interface CanonicalEdge {
  type: EdgeType;
  from: ItemEndpoint; // asserting side (for `closes`, the change request)
  to: ItemEndpoint; // target side (for `closes`, the issue)
  // Endpoint states the source reported at discovery; reconciliation refines
  // these and derives lifecycle. Null when the source did not report it.
  fromState: ItemState | null;
  toState: ItemState | null;
}

// The normalized item, before it is written to the `item` table. `sourceId` is
// filled by the engine from the owning Source; the normalizer fills the rest.
export interface CanonicalItem {
  sourceId: string;
  externalId: string;
  kind: ItemKind;
  projectPath: string | null;
  iid: number | null;
  url: string;
  title: string | null;
  state: ItemState;
  stateRaw: string | null;
  stateReason: string | null;
  isDraft: boolean | null;
  author: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  mergedAt: string | null;
  // extension layer
  reviewState: ReviewState | null;
  ciState: CiState | null;
  mergeState: MergeState | null;
  milestone: string | null;
  demand: number | null;
}

export interface CanonicalActivity {
  sourceId: string;
  externalId: string;
  kind: string;
  action: string;
  projectPath: string | null;
  targetKind: string | null;
  target: ItemEndpoint | null;
  targetIid: number | null;
  title: string | null;
  url: string | null;
  actor: string | null;
  occurredAt: string;
  summary: string | null;
  details: Record<string, unknown> | null;
}

// What normalizing one raw record yields: the item, its labels, and any edges
// it asserts (from either endpoint's point of view), plus any activity records
// derived from that raw. Activity-only raw records set item to null.
export interface NormalizedBundle {
  item: CanonicalItem | null;
  labels: CanonicalLabel[];
  edges: CanonicalEdge[];
  activities: CanonicalActivity[];
}
