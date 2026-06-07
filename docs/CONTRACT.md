# Contract versioning

The contract — the `@symphony-board/contract` package
(`packages/contract/contract.schema.json`, mirrored by `packages/contract/types.ts`)
— is LAYER 3: the serialized projection consumers (the UI, external tools) read. It
is **never** the DB schema and **never** the stored truth — it is re-derived from
the canonical store on every emit. That decoupling is what lets the schema evolve
without breaking old data: a new contract version is produced by re-running
`buildContract` (and, if needed, `normalize`) over the raw/canonical data that is
already stored — no re-fetch from providers.

## The envelope

```jsonc
{
  "contract_version": "1.0.0",     // semver; the UI branches on MAJOR
  "generated_at": "…Z",
  "generator": "symphony-board/0.1.0",
  "sources": [ /* per-source health: last_success_at, last_status */ ],
  "items":   [ /* canonical core + nullable extension */ ],
  "edges":   [ /* typed issue<->PR/MR links with lifecycle */ ]
}
```

Item/edge endpoints use a composite ref string `"<source_id>|<external_id>"`.
`source_id` never contains `|`; split on the **first** `|` only (a GitLab
`external_id` may contain `:` and `/`).

## Rules

- **patch** (`1.0.x`): clarification, no shape change.
- **minor** (`1.x.0`): **additive only** — a new OPTIONAL/nullable field. Old
  consumers keep working untouched.
- **major** (`x.0.0`): **breaking** — a removed/renamed/repurposed field, or a
  changed `required` set. Bump the major; the UI gates on it.

Two hard rules behind the above:

1. **Never repurpose or remove a field within a major.** Add a new one instead.
2. **Consumers must ignore unknown fields** (be liberal in what you accept), so a
   minor addition never breaks an old reader. Producers validate strictly
   against the JSON Schema; the strictness is a producer-side guard, not a
   consumer contract.

## When you change the contract

1. Edit `packages/contract/contract.schema.json` (normative) and
   `packages/contract/types.ts` (mirror) together.
2. Bump `CONTRACT_VERSION` in `src/contract/version.ts` per the rules.
3. Add/adjust a `test/contract.test.ts` case (and `test/validate.test.ts` if the
   schema gained a construct the validator doesn't yet cover).
4. For a major bump, plan a transition: keep emitting the old major (or ship a
   transformer) until consumers move.

## Validation (producer-side guard)

The schema is enforced, not just documentation: `emit` validates the envelope
against `packages/contract/contract.schema.json` before writing and **refuses to emit** an
invalid contract (override with `--no-validate`). `pnpm run validate -- --in
<file>` checks an existing contract on demand, and `test/validate.test.ts`
exercises the validator in CI. The validator (`src/contract/validate.ts`) is a
dependency-free JSON-Schema subset matching exactly what this schema uses, so it
preserves the backend's zero-runtime-dependency posture. Producers validate
strictly; consumers stay liberal (ignore unknown fields) so a minor (additive)
field never breaks an old reader.

Because the source of truth is the stored raw + canonical data, you can always
regenerate any current contract version on demand with `pnpm run emit`.
