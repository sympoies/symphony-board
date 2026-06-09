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

Version `2.1.0` added optional range-query metadata:

- top-level `range_query`
- `TimeRangeDTO`
- `RangeQueryDTO`

Static emits usually omit `range_query`. Read-only `/api/range` responses set it
and return a windowed envelope for the requested date range, expanded at the
contract's configured timezone.

Version `2.2.0` added optional repo analytics rows:

- top-level `repo_metrics[]`
- `RepoMetricDTO`, `RepoMetricWindowDTO`, `RepoMetricStatsDTO`,
  `RepoMetricSeriesPointDTO`, `RepoMetricActorDTO`, and
  `RepoMetricDataQualityDTO`

`repo_metrics[]` is range-scoped and powers the Repo Analytics UI. It is
separate from `repo_stats[]`, which remains the full repo inventory/count
surface.

Version `2.2.1` clarified and enabled review activity ingestion without changing
shape:

- `ActivityDTO.kind` can be `review`.
- `RepoMetricStatsDTO.reviews` and `RepoMetricStatsDTO.approvals` are activity
  event counts, not current item-state counts.

Version `2.3.0` added a canonical actor identity to `RepoMetricActorDTO`:
`actor_key` (a stable, non-PII key — provider username, hashed commit email, or
normalized name), `display_name`, and optional `aliases`. `top_actors[]` groups
by `actor_key` so one human is one row; `actor` stays as a backward-compatible
display field.

Version `2.4.0` added optional `RepoMetricStatsDTO.activity_score`, a weighted
decimal activity signal used for Repo Analytics sorting and rounded UI display.

Version `2.5.0` added `RepoMetricDataQualityDTO.last_activity_at`, the most recent
observed activity instant per repo (counterpart to the earliest `observed_since`),
rendered as "last active" in Repo Analytics.

Version `3.0.0` removed `RepoMetricDataQualityDTO.truncated`. Repo metrics are
derived from the full canonical store, so per-repo metric rows are not truncated;
the truncation signal remains top-level `item_window.truncated`. Consumers should
derive coverage from `activity_available`, `observed_since`, and
`last_activity_at`.

Version `3.1.0` added optional envelope-level `ContractEnvelope.timezone` and
relaxed `RangeQueryDTO.timezone` from the `"UTC"` literal to the configured IANA
timezone. Consumers reading older contracts should treat a missing timezone as
`"UTC"`.

Version `3.1.1` aligned `RepoMetricSeriesPointDTO` day / week / month buckets to
the configured timezone. The shape did not change.

Version `3.2.0` added optional nullable `RepoMetricDTO.repo_url` for provider repo
navigation. Activity provider destinations continue to use `ActivityDTO.url`;
there is no separate `target_url`.

When the contract changes, update `contract.schema.json`, `types.ts`,
`src/contract/version.ts`, producer validation tests, and any UI consumer logic
in the same change set.
