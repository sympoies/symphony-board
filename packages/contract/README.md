# @symphony-board/contract

Layer 3 of `symphony-board`: the versioned JSON contract definition. The UI and
external consumers depend on this package instead of reaching into backend DB or
source modules.

Current contract version emitted by the backend: `3.2.0`.

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

The full schema rules, field semantics, and version history live in
[../../docs/CONTRACT.md](../../docs/CONTRACT.md). Keep this package README as a
consumer entrypoint, not a duplicate changelog.

Summary:

- patch: clarification, no shape change
- minor: additive optional/nullable fields only
- major: breaking shape or semantic change

The current emitted contract is `3.2.0`. Important compatibility milestones:

- v2 made `items[]` a windowed payload and added `item_window`, `repo_stats[]`,
  `range_query`, and `repo_metrics[]` so consumers do not derive full inventory
  or analytics from the loaded Board rows.
- v3 removed `RepoMetricDataQualityDTO.truncated`; use top-level
  `item_window.truncated` for payload truncation and repo metric coverage fields
  (`activity_available`, `observed_since`, `last_activity_at`) for analytics
  quality.
- The current v3 surface includes `ContractEnvelope.timezone`,
  `RepoMetricDTO.repo_url`, and producer-filled `ActivityDTO.url` destinations.

When the contract changes, update `contract.schema.json`, `types.ts`,
`src/contract/version.ts`, producer validation tests, `../../docs/CONTRACT.md`,
and any UI consumer logic in the same change set. Update this README only when
the package-facing summary or import boundary changes.
