// Edge reconciliation — the workflow spine.
//
// An issue<->PR/MR link is RECONCILED, not merely stored: it can be reported by
// the change request ("Closes #5") and/or by the issue ("closed by !12"), at
// different times with different freshness. We merge by (type, from, to), prefer
// the most recently known endpoint state, record which side(s) we heard it from,
// and DERIVE the edge lifecycle. All pure: no network, caller supplies any clock.

import type {
  CanonicalEdge,
  EdgeLifecycle,
  EdgeType,
  ItemState,
} from "./types.ts";
import { refOfEndpoint } from "./ref.ts";

// Derive the lifecycle of a `closes` edge from its endpoint states.
//   from = change request, to = issue.
//   fulfilled : the change request merged AND the issue is closed -> work landed
//   broken    : the change request was closed WITHOUT merging -> link abandoned
//   declared  : anything else (still open / in flight) -> work in progress
// For non-`closes` types (relates/blocks/...) there is no fulfil semantics, so
// lifecycle is null.
export function deriveLifecycle(
  type: EdgeType,
  fromState: ItemState | null,
  toState: ItemState | null,
): EdgeLifecycle | null {
  if (type !== "closes") return null;
  if (fromState === "merged" && toState === "closed") return "fulfilled";
  if (fromState === "closed") return "broken";
  return "declared";
}

// A reconciled edge plus bookkeeping the DB layer needs.
export interface ReconciledEdge extends CanonicalEdge {
  lifecycle: EdgeLifecycle | null;
  discoveredFrom: "from" | "to" | "both";
}

// Collision-proof composite key as a JSON tuple (the same convention as the UI
// model's repoKey) rather than a separator string — no delimiter assumption and
// plain ASCII (an earlier `\0`-separator form kept being saved as a raw NUL byte).
const keyOf = (e: CanonicalEdge): string =>
  JSON.stringify([e.type, refOfEndpoint(e.from), refOfEndpoint(e.to)]);

// Merge a batch of edges discovered this run (from any number of endpoints) into
// one reconciled edge per (type, from, to). `sideOf` tells us which endpoint
// reported a given edge, so we can record provenance and converge endpoint
// states: a non-null state always wins over null; when both sides report a
// state, the later one (by the endpoint's own item) is resolved by the caller —
// here we take the first non-null and let a second non-null override only if the
// first was null. (The DB upsert refreshes states from the item table too.)
export function reconcileEdges(
  discovered: Array<{ edge: CanonicalEdge; side: "from" | "to" }>,
): ReconciledEdge[] {
  const byKey = new Map<string, ReconciledEdge>();
  for (const { edge, side } of discovered) {
    const k = keyOf(edge);
    const existing = byKey.get(k);
    if (!existing) {
      byKey.set(k, {
        ...edge,
        lifecycle: deriveLifecycle(edge.type, edge.fromState, edge.toState),
        discoveredFrom: side,
      });
      continue;
    }
    // Converge endpoint states: fill nulls, keep known values.
    const fromState = existing.fromState ?? edge.fromState;
    const toState = existing.toState ?? edge.toState;
    existing.fromState = fromState;
    existing.toState = toState;
    existing.lifecycle = deriveLifecycle(existing.type, fromState, toState);
    if (existing.discoveredFrom !== side) existing.discoveredFrom = "both";
  }
  return [...byKey.values()];
}
