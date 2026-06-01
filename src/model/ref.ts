// Composite item reference: "<source_id>|<external_id>".
//
// source_id is a controlled handle that never contains '|'. external_id may
// contain anything (a GitLab gid is "gid://gitlab/Issue/123" — colons AND
// slashes), so we split on the FIRST '|' only. This keeps refs as plain strings
// (easy to key a Map by, easy to put in JSON) without an ambiguous delimiter.

import type { ItemEndpoint } from "./types.ts";
import type { Ref } from "../contract/types.ts";

export function refOf(sourceId: string, externalId: string): Ref {
  if (sourceId.includes("|")) {
    throw new Error(`source_id must not contain '|': ${sourceId}`);
  }
  return `${sourceId}|${externalId}`;
}

export function refOfEndpoint(e: ItemEndpoint): Ref {
  return refOf(e.sourceId, e.externalId);
}

// Inverse of refOf. Splits on the first '|'; everything after is the external_id.
export function parseRef(ref: Ref): ItemEndpoint {
  const i = ref.indexOf("|");
  if (i < 0) throw new Error(`malformed ref (no '|'): ${ref}`);
  return { sourceId: ref.slice(0, i), externalId: ref.slice(i + 1) };
}
