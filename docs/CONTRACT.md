# Contract Versioning

The contract is LAYER 3: the serialized projection consumed by the UI and any
external reader. It is not the SQLite schema and not the stored truth. It is
derived from raw/canonical data whenever `emit` runs.

Definition files:

- `packages/contract/contract.schema.json`: normative JSON Schema
- `packages/contract/types.ts`: TypeScript DTO mirror
- `src/contract/version.ts`: `CONTRACT_VERSION` and `GENERATOR`
- `src/contract/validate.ts`: dependency-free producer validator

Current emitted version: `1.3.0`.

The private workspace package version in `packages/contract/package.json` is
package metadata. Consumers must use the envelope's `contract_version`, not the
package version, to decide compatibility.

## Envelope

```jsonc
{
  "contract_version": "1.3.0",
  "generated_at": "2026-06-08T00:00:00.000Z",
  "generator": "symphony-board/0.1.0",
  "sources": [
    {
      "source_id": "github:github.com",
      "kind": "github",
      "host": "github.com",
      "display_name": "GitHub",
      "last_success_at": "2026-06-08T00:00:00.000Z",
      "last_status": "ok",
      "color": "#1f6feb"
    }
  ],
  "items": [],
  "edges": [],
  "activities": [],
  "repos": [
    {
      "source_id": "github:github.com",
      "project_path": "sympoies/symphony-board",
      "color": "#e0af68"
    }
  ],
  "aggregates": [
    {
      "scope": "boardWindow",
      "window": {
        "kind": "active_since",
        "basis": "item_updated_at",
        "since": "2026-03-10T00:00:00.000Z",
        "days": 90,
        "edge_filter": null
      },
      "stats": {
        "items": 42,
        "by_state": { "open": 10, "closed": 32 },
        "by_kind": { "issue": 36, "change_request": 6 },
        "by_lifecycle": { "fulfilled": 5, "declared": 1 }
      }
    }
  ]
}
```

Top-level fields:

- `contract_version`: semver. Consumers branch on major.
- `generated_at`: emit time.
- `generator`: producer name and version.
- `sources`: source health and source display metadata.
- `items`: normalized work items.
- `edges`: typed relationships between items.
- `activities`: optional developer-significant event feed, added in `1.2.0`.
- `repos`: optional sparse per-repo display metadata, added in `1.1.0`.
- `aggregates`: optional scope/windowed totals, added in `1.3.0`.

The producer currently emits `activities`, `repos`, and `aggregates` every time,
usually as empty arrays when no rows apply. They are optional in the schema so
old v1 readers are not broken by minor additions. Consumers should read them as
`env.activities ?? []`, `env.repos ?? []`, and `env.aggregates ?? []`.

## Refs

Item and edge endpoints use a composite ref:

```text
<source_id>|<external_id>
```

Rules:

- `source_id` must not contain `|`.
- split on the first `|` only.
- do not parse `external_id`; GitLab ids contain characters such as `:` and `/`.

## Items

`items[]` contains the provider-agnostic item core plus nullable extension
fields. Known `kind` values are `issue` and `change_request`, but the contract
keeps `kind` as an open string.

Important fields:

- `id`: composite ref.
- `source_id` / `external_id`: immutable source identity.
- `project_path` / `iid`: mutable human metadata for display and search.
- `state`: normalized `open`, `closed`, or `merged`.
- `state_raw`: provider state string for debugging/escape hatch.
- `labels`: verbatim provider labels plus parsed `scope` for `scope::value`.
- `review_state`, `ci_state`, `merge_state`: nullable provider-derived signals.
- `demand`: comments plus reactions/upvotes.
- `last_seen_at`: latest successful observation in the canonical store.

The TypeScript DTOs describe what the producer emits. The JSON Schema is the
normative validation surface.

## Edges

`edges[]` contains typed relationships. For `closes`:

- `from`: change request ref.
- `to`: issue ref.
- `from_state` and `to_state`: endpoint states observed/reconciled by sync.
- `lifecycle`: `declared`, `fulfilled`, or `broken`.

Non-`closes` edge types, such as `mentions` and `relates`, have
`lifecycle: null`.

Edge type is an open string so providers can add relationship vocabulary without
changing the major version when the shape stays the same.

## Activities

`activities[]` is a newest-first feed of developer-significant records. It is
separate from `items[]`: an item is current state, while an activity row is
something that happened.

Important fields:

- `id`: composite ref for this activity record.
- `source_id` / `external_id`: stable source identity for the record.
- `kind`: open string such as `issue`, `change_request`, `commit`, `branch`,
  `tag`, or `repository`.
- `action`: open string such as `opened`, `closed`, `merged`, `committed`,
  `pushed`, `force_pushed`, `created`, or `deleted`.
- `project_path`: mutable repo/project display path, when known.
- `target_kind`, `target_ref`, `target_iid`: optional target metadata. Only set
  `target_ref` when the producer can identify the tracked item by provider
  immutable id.
- `occurred_at`: provider event timestamp.
- `summary`: producer-readable text for UI display.
- `details`: provider-specific JSON object for debugging and later consumers.

Current sources derive item transition activities from canonical item timestamps
and fetch provider REST activity surfaces for commits and repository/project
events.

## Aggregates

Version `1.3.0` added optional `aggregates[]`. These rows provide
server-computed totals for named scopes and windows while the contract still
emits the full `items[]` and `edges[]` sets for v1 compatibility.

Scopes use the same vocabulary as the UI:

| Scope | Meaning |
| --- | --- |
| `global` | full emitted contract totals for all live items and edges |
| `boardWindow` | Board item-window totals; items are selected by `updated_at` |
| `graphWindow` | Graph overview totals; edges are selected by endpoint activity, and item total means rendered graph nodes |
| `focus` | focus-local subgraph totals; schema-supported but not backend-emitted because focus target is viewer-local |

Each aggregate has:

- `scope`: one of the scope values above.
- `window.kind`: `full`, `active_since`, or `focus`.
- `window.basis`: the selection rule, such as `item_updated_at` for Board or
  `edge_endpoint_updated_at` for Graph.
- `window.since`: inclusive UTC cutoff for `active_since`, otherwise `null`.
- `window.days`: preset length used to derive `since` from `generated_at`, or
  `null` for full/custom rows.
- `window.edge_filter`: `no_mentions`, `all`, or `null` when no edge filter
  applies.
- `stats`: total plus open string-keyed count maps:
  `by_state`, `by_kind`, and `by_lifecycle`.

The backend currently emits:

- `global` full aggregate over all emitted items and edges.
- `boardWindow` full plus `1w`, `2w`, `1mo`, and `3mo` active-since aggregates.
- `graphWindow` full plus `1w`, `2w`, `1mo`, and `3mo` active-since aggregates
  for the default overview edge filter (`edge_filter: "no_mentions"`).

Viewer-local choices are not represented by backend aggregates. Source/repo
visibility, search, facet filters, Graph mention toggles, and focus targets are
client display state; consumers should use a contract aggregate only when its
scope/window/filter exactly matches the view, otherwise compute locally from
`items[]` and `edges[]`.

## Display Metadata

Version `1.1.0` added display colors:

- `sources[].color`: optional source-level highlight color or `null`.
- `repos[]`: sparse per-repo highlight colors keyed by
  `(source_id, project_path)`.

Colors are config-derived display metadata:

- accepted forms are `#rgb` and `#rrggbb`
- read by `emit` from `config/sources.json`
- not stored in SQLite
- safe to change by re-emitting the contract; no provider re-fetch is required

The UI resolves colors in this order:

```text
browser repo override -> repos[] color -> sources[].color -> no highlight
```

The UI validates colors again before using them in CSS.

Version `1.2.0` added optional top-level `activities[]`.

## Version Rules

- **patch** (`1.3.x`): clarification only; no shape or semantic change.
- **minor** (`1.x.0`): additive only. New fields must be optional and/or
  nullable. Old consumers must keep working.
- **major** (`x.0.0`): breaking shape or semantic change, including removed
  fields, renamed fields, repurposed fields, or changed required sets.

Hard rules:

1. Do not remove or repurpose a field within a major.
2. Consumers must ignore unknown fields within a supported major.
3. Producers validate strictly against the JSON Schema before emitting.

## Changing The Contract

1. Edit `packages/contract/contract.schema.json`.
2. Edit `packages/contract/types.ts` in the same commit.
3. Bump `CONTRACT_VERSION` in `src/contract/version.ts`.
4. Update `test/contract.test.ts`.
5. Update `test/validate.test.ts` if the schema uses a new validator feature.
6. Update UI model/loading behavior when the UI consumes the new field.
7. Run:

```sh
pnpm run typecheck
pnpm test
pnpm --filter @symphony-board/ui run build
pnpm --filter @symphony-board/ui run test
pnpm --filter @symphony-board/ui run smoke
pnpm run emit -- --out data/contract.json
pnpm run validate -- --in data/contract.json
```

For a major bump, plan a transition. The UI currently supports contract major
v1 and warns on any other major.

## Validation

`emit` validates the envelope before writing. It refuses to emit invalid JSON:

```sh
pnpm run emit -- --out data/contract.json
```

Validate an existing file:

```sh
pnpm run validate -- --in data/contract.json
```

`--no-validate` exists on `emit` as an emergency escape hatch for a validator
bug. It should not be used as a normal workflow.
