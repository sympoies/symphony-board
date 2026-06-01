// Label scope parsing. A "scope::value" label (GitLab scoped label, or a GitHub
// label that merely uses "::" as characters) is split into its scope prefix.
//
// IMPORTANT semantic caveat preserved for the consumer: in GitLab, labels
// sharing a scope are MUTUALLY EXCLUSIVE (only one "priority::*" at a time); in
// GitHub the "::" carries no such meaning. We only PARSE the scope here; we do
// not enforce exclusivity. The contract carries both `name` (verbatim) and
// `scope`, and the consumer decides what the scope means for that source.

import type { CanonicalLabel } from "./types.ts";

// Returns the scope (text before the first "::") or null when the label is not
// scoped. "priority::high" -> "priority"; "bug" -> null; "::weird" -> null
// (empty scope is treated as unscoped).
export function parseScope(name: string): string | null {
  const i = name.indexOf("::");
  if (i <= 0) return null;
  return name.slice(0, i);
}

export function toLabel(name: string, color: string | null = null): CanonicalLabel {
  return { name, scope: parseScope(name), color };
}
