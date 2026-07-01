# Development log

A time-ordered narrative of notable work on symphony-board: what shipped, *why*,
the evidence, and external links worth keeping. It **complements — never
duplicates** the other records:

- **Commit messages** say *what changed*. The devlog says *why*, and keeps the
  external context (URLs, API observations, run numbers) that a diff can't.
- **`docs/DESIGN.md`** is the normative decision record (revised over time). The
  devlog is append-only session narrative; when a decision is settled, record it
  in `DESIGN.md` and link to it from here.

## When to add an entry

Add one when a session produces a **durable outcome worth future lookup**: a
shipped feature, a validated milestone, a decision, or an external link/ref
you'll want again. Skip trivial, transient, or same-turn fixes — the log is
signal, not a changelog. Not every session earns an entry.

## Conventions

- **One file per month**: `docs/devlog/YYYY-MM.md`. **Newest entry on top.**
- **English**, like all repo content.
- **Public repo — no personal records.** Never write personal identifiers (real
  names, personal handles, emails), internal hostnames (e.g. a company GitLab
  host), or personal deploy topology (specific machines, Tailscale/tailnet
  names, private IPs). Use neutral placeholders (`dev-a`, `gitlab.internal`, "a
  dedicated host") and keep the engineering signal, not the personal specifics.
- Commit each entry on its own: `docs(devlog): <month> — <subject>`.
- Search past entries with `scripts/devlog-search.sh <term> [YYYY-MM]`.

### Entry template

```
## YYYY-MM-DD — <short title>

**Result** — what shipped (1–3 bullets).
**Why / context** — the non-obvious reasoning.
**Evidence** — commands run + key numbers.
**Links** — commits, issues/PRs, external refs, DESIGN.md sections.
**Follow-ups** — optional.
```

## Months

- [2026-07](2026-07.md)
- [2026-06](2026-06.md)
