# Contract Versioning

The contract is LAYER 3: the serialized projection consumed by the UI and any
external reader. It is not the SQLite schema and not the stored truth. It is
derived from raw/canonical data whenever `emit` runs.

Definition files:

- `packages/contract/contract.schema.json`: normative JSON Schema
- `packages/contract/types.ts`: TypeScript DTO mirror
- `src/contract/version.ts`: `CONTRACT_VERSION` and `GENERATOR`
- `src/contract/validate.ts`: dependency-free producer validator

Current emitted version: `1.1.0`.

The private workspace package version in `packages/contract/package.json` is
package metadata. Consumers must use the envelope's `contract_version`, not the
package version, to decide compatibility.

## Envelope

```jsonc
{
  "contract_version": "1.1.0",
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
  "repos": [
    {
      "source_id": "github:github.com",
      "project_path": "sympoies/symphony-board",
      "color": "#e0af68"
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
- `repos`: optional sparse per-repo display metadata, added in `1.1.0`.

The producer currently emits `repos` every time, usually as an empty array. It is
optional in the schema so old v1 readers are not broken by the minor addition.
Consumers should read it as `env.repos ?? []`.

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

## Version Rules

- **patch** (`1.1.x`): clarification only; no shape or semantic change.
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
