# @symphony-board/contract

Layer 3 of `symphony-board`: the versioned JSON contract definition. The UI and
external consumers depend on this package instead of reaching into backend DB or
source modules.

Current contract version emitted by the backend: `2.0.0`.

The package's private `package.json` version is workspace metadata. Runtime
compatibility is governed by the emitted envelope's `contract_version`.

## Contents

- `contract.schema.json`: normative JSON Schema for the envelope.
- `types.ts`: TypeScript DTO mirror of the schema.
- `index.ts`: type-only re-export surface.

The shared closed vocabularies live here:

- `ItemState`
- `ReviewState`
- `CiState`
- `MergeState`
- `EdgeLifecycle`
- `Ref`

`kind` and edge `type` remain open strings in the contract.

## Importing

```ts
import type { ActivityDTO, ContractEnvelope, ItemDTO, EdgeDTO } from "@symphony-board/contract";
import schema from "@symphony-board/contract/schema.json" with { type: "json" };
```

The package exposes types and the schema file. It does not expose producer
runtime constants such as `CONTRACT_VERSION` or `GENERATOR`; those belong to
`src/contract/version.ts` in the backend.

## Runtime Boundary

The backend imports this package with `import type`, so those imports erase under
Node 24 type stripping. The backend Docker image can run without installing
workspace packages or resolving this package as runtime code.

Bundled consumers such as `packages/ui` resolve this package normally during
their build.

## Versioning

See [../../docs/CONTRACT.md](../../docs/CONTRACT.md).

Summary:

- patch: clarification, no shape change
- minor: additive optional/nullable fields only
- major: breaking shape or semantic change

Version `1.1.0` added display metadata:

- `sources[].color`
- top-level sparse `repos[]`

Version `1.2.0` added:

- top-level optional `activities[]`
- `ActivityDTO`

Version `1.3.0` added optional scope/window aggregate rows:

- top-level `aggregates[]`
- shared `AggregateScope`, `AggregateWindowDTO`, `AggregateStatsDTO`, and
  `AggregateDTO` types

Aggregates are emitted-contract totals, not viewer-local totals. A consumer
should use one only when its scope/window/filter exactly matches the visible
view; otherwise compute locally from `items[]` and `edges[]`.

Version `2.0.0` changed payload semantics:

- `items[]` is a windowed set, not every live item.
- `ItemDTO.window_reasons` explains whether a loaded row is in the primary
  Board window, included as an edge endpoint, or both.
- required top-level `item_window` describes the loaded primary item window.
- required top-level `repo_stats[]` carries full repo inventory/counts for
  Settings and external consumers.

Use `aggregates[]` and `repo_stats[]` for full totals. Use `items[]` and
`edges[]` only for the loaded window unless a future API provides more rows.

When the contract changes, update `contract.schema.json`, `types.ts`,
`src/contract/version.ts`, producer validation tests, and any UI consumer logic
in the same change set.
