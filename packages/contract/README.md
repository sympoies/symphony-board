# @symphony-board/contract

Layer 3 of `symphony-board`: the versioned JSON contract definition. The UI and
external consumers depend on this package instead of reaching into backend DB or
source modules.

Current contract version emitted by the backend: `4.2.1`.

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

The current emitted contract is `4.2.1`. Important compatibility milestones:

- v2 made `items[]` a windowed payload and added `item_window`, `repo_stats[]`,
  `range_query`, and `repo_metrics[]` so consumers do not derive full inventory
  or analytics from the loaded Board rows.
- v3 removed `RepoMetricDataQualityDTO.truncated`; use top-level
  `item_window.truncated` for payload truncation and repo metric coverage fields
  (`activity_available`, `observed_since`, `last_activity_at`) for analytics
  quality.
- The current v3 surface includes `ContractEnvelope.timezone`,
  `RepoMetricDTO.repo_url`, and producer-filled `ActivityDTO.url` destinations.
- 3.3.0 added optional `ItemDTO.review_threads` (`{ open, total }` resolvable
  review threads for a change_request) and the `unresolved_review_threads` repo
  metric.
- 3.4.0 added optional `RepoMetricActorDTO.profile_url`, the per-actor
  counterpart to `repo_url`: a provider profile link
  (`https://<host>/<username>`) emitted only for `provider-user`-keyed actors on
  supported GitHub/GitLab sources.
- 3.5.0 added sub-day `RepoMetricBucket` widths (`2h`/`4h`/`6h`) so a 1-3 day
  window tiles its `series[]` into ~12 intraday points; a new enum member on the
  existing `bucket` field, `series[]` shape unchanged. Treat an unknown width as
  an opaque series point.
- 4.0.0 (major) windows the static contract's `activities[]` to the trailing 30
  days and adds the optional top-level `ActivityDailyDTO` (`activity_daily`):
  pre-computed per-day/per-kind counts over the full history, anchored to
  `generated_at`, that the Activity Overview reads instead of the raw feed.
  Narrowing an emitted row collection is breaking (like the v2 `items[]`
  windowing); `/api/range` stays un-windowed for wider raw feeds. 4.0.0 also
  drops the redundant activity `id` (= `source_id|external_id`) and `summary`
  (producer prose the UI rebuilds from the structured fields).
- 4.1.0 adds optional top-level `ReviewThreadDTO[]` (`review_threads`) with
  current provider review-thread status, file/line metadata, and compact
  comment previews for loaded change requests. The existing item-level
  `review_threads {open,total}` summary is unchanged.
- 4.2.0 adds `ReviewThreadCommentDTO.avatar_url`: the comment author's avatar URL
  when the provider reports it, else `null`. Additive on the 4.1.0 comment object;
  the producer always emits the key. The Reviews UI renders it as the author's
  photo with an initials fallback.
- 4.2.1 makes config the source of truth for the projection: a source or repo
  absent from `config/sources.json` is omitted from every emitted collection
  (`sources[]`, `repo_stats[]`, `repo_metrics[]`, `items[]`, `edges[]`,
  `activities[]`). Patch, not a shape change — same envelope, fewer rows when
  config is narrowed. Gating is emit-time only; the store keeps the data, so
  re-adding to config restores it without a re-sync. See docs/CONTRACT.md
  "Config-Gated Projection".

When the contract changes, update `contract.schema.json`, `types.ts`,
`src/contract/version.ts`, producer validation tests, `../../docs/CONTRACT.md`,
and any UI consumer logic in the same change set. Update this README only when
the package-facing summary or import boundary changes.
