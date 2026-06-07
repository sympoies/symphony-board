import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Guard against a recurring bug: a source file saved with a literal NUL (0x00)
// byte where a JS string escape (backslash-zero) was intended — seen in composite
// Map-key builders (edge keyOf, GitLab indexKey, UI relatedItems). A NUL inside a
// JS/TS string is valid, so tsc / the runtime / behaviour tests never catch it,
// but it makes the file read as "binary" to git/grep and can corrupt diffs. No
// tracked file in this repo is a real binary, so the invariant is simply: zero
// NUL bytes in any tracked file. Prefer a JSON-tuple key (see model.ts repoKey)
// over a separator byte so there is no escape to mis-save in the first place.
const NUL = String.fromCharCode(0);

test("no tracked file contains a NUL (0x00) byte", () => {
  const out = execFileSync("git", ["ls-files", "-z"], { encoding: "buffer" }).toString("utf8");
  const files = out.split(NUL).filter(Boolean);
  const offenders: string[] = [];
  for (const f of files) {
    let buf: Buffer;
    try {
      buf = readFileSync(f);
    } catch {
      continue; // skip an ls-files entry that is not a readable regular file
    }
    if (buf.includes(0)) offenders.push(f);
  }
  assert.deepEqual(
    offenders,
    [],
    `tracked files contain a raw NUL byte (a backslash-zero escape likely saved as 0x00): ${offenders.join(", ")}`,
  );
});
