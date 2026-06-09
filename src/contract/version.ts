// The contract version (LAYER 3). Bump per the rules in
// packages/contract/contract.schema.json and docs/CONTRACT.md:
//   patch -> clarification, no shape change
//   minor -> additive (new OPTIONAL field); old consumers keep working
//   major -> breaking (removed/repurposed field, changed required set)
// The UI branches on the MAJOR. Old DB records stay compatible because the
// contract is re-derived from stored raw/canonical data, never stored as-is.
export const CONTRACT_VERSION = "3.2.0";

// Generator tag embedded in the envelope: "<name>/<package version>".
export const GENERATOR = "symphony-board/0.1.0";
