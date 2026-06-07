# @symphony-board/contract

LAYER 3 of symphony-board: the **versioned contract** — the product surface a UI
and other consumers read. This package is the contract's definition, extracted
so the three-layer boundary (raw → canonical DB → contract) is *structural*: a
consumer depends on this package and **cannot reach past it** into the backend's
`src/db` / `src/sources`.

## Contents

- `contract.schema.json` — the **normative** JSON Schema (draft 2020-12) for the
  envelope. The source of truth.
- `types.ts` — the TypeScript **mirror** of the schema (DTOs + the shared enum
  vocabularies `ItemState` / `ReviewState` / `CiState` / `MergeState` /
  `EdgeLifecycle` and the composite `Ref`). Kept in lock-step with the schema.
- `index.ts` — `export type *` of `types.ts`.

## Importing

```ts
import type { ContractEnvelope, ItemDTO, EdgeDTO } from "@symphony-board/contract";
// the normative schema, for a consumer that wants to validate what it received:
import schema from "@symphony-board/contract/schema.json" with { type: "json" };
```

## Properties

- **Type-only at runtime.** There are no runtime values here — only types and a
  JSON file. A consumer running under Node's TypeScript stripping never resolves
  this package at runtime (the `import type` erases); a bundler (the UI) resolves
  it normally. This is why the backend can depend on it and still ship with no
  build step and zero third-party runtime dependencies.
- **Producer constants live with the producer.** `CONTRACT_VERSION` / `GENERATOR`
  and the dependency-free validator (`src/contract/`) stay in the backend — they
  are how the producer *stamps and guards* the contract, not part of its shape.

## Versioning

See [`../../docs/CONTRACT.md`](../../docs/CONTRACT.md). In short: additive-only
within a major (new fields optional/nullable, never repurpose/remove); a breaking
change bumps the major and the UI gates on it. When you change the schema, change
`types.ts` in the same commit and bump `CONTRACT_VERSION` in
`src/contract/version.ts`.
