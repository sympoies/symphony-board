// Guard against the "clock-relative time-bomb" fixture class: a hardcoded FUTURE
// date literal assigned to a TTL/timestamp key (e.g. `expires_at`) that a real
// `Date.now()` comparison flips to expired once that calendar date passes —
// silently reddening CI with no code change (see #527 / docs/devlog 2026-06-30).
// Two halves: unit tests for the pure scanner, then a sweep asserting the
// test/fixture tree carries no such literal today.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { scanTimeBombFixtures, TTL_KEYS } from "./helpers/time-bomb-scan.ts";
import { relativeExpiry } from "./helpers/clock.ts";

// Fixed reference "now" so the unit cases never themselves go stale.
const NOW = Date.parse("2026-06-30T00:00:00.000Z");
const iso = (deltaDays: number): string => new Date(NOW + deltaDays * 86400000).toISOString();

test("scanTimeBombFixtures flags a near-future TTL-key date literal (JS and JSON forms)", () => {
  const js = scanTimeBombFixtures(`      expires_at: "${iso(30)}",`, { now: NOW });
  assert.equal(js.length, 1, "JS object literal");
  const hit = js[0];
  assert.ok(hit);
  assert.equal(hit.key, "expires_at");
  assert.equal(hit.line, 1);
  const json = scanTimeBombFixtures(`  "expires_at": "${iso(30)}"`, { now: NOW });
  assert.equal(json.length, 1, "JSON form with quoted key");
});

test("scanTimeBombFixtures ignores clearly-past and far-future literals", () => {
  assert.equal(scanTimeBombFixtures(`expires_at: "${iso(-10)}"`, { now: NOW }).length, 0, "10d past");
  assert.equal(scanTimeBombFixtures(`expires_at: "${iso(-1000)}"`, { now: NOW }).length, 0, "long past");
  assert.equal(scanTimeBombFixtures(`expires_at: "9999-01-01T00:00:00.000Z"`, { now: NOW }).length, 0, "far-future sentinel");
});

test("scanTimeBombFixtures only matches TTL-key ASSIGNMENTS, not other dates or assertions", () => {
  assert.equal(scanTimeBombFixtures(`receivedSomething: "${iso(30)}"`, { now: NOW }).length, 0, "non-TTL key");
  assert.equal(scanTimeBombFixtures(`const when = "${iso(30)}";`, { now: NOW }).length, 0, "bare literal");
  // An assertion reads `obj.expires_at` (no `:`/`=` after the key) — never flagged.
  assert.equal(scanTimeBombFixtures(`assert.match(profile.expires_at, /^${iso(30).slice(0, 10)}/);`, { now: NOW }).length, 0, "assertion, not assignment");
});

test("scanTimeBombFixtures honors the // fixed-clock: opt-out", () => {
  const line = `      expires_at: "${iso(30)}", // fixed-clock: prune test injects a 2026-06-21 clock`;
  assert.equal(scanTimeBombFixtures(line, { now: NOW }).length, 0);
});

test("scanTimeBombFixtures covers every documented TTL key", () => {
  for (const key of TTL_KEYS) {
    assert.equal(scanTimeBombFixtures(`${key}: "${iso(30)}"`, { now: NOW }).length, 1, key);
  }
});

test("relativeExpiry returns a future ISO timestamp (the literal-free replacement for a hardcoded expiry)", () => {
  const exp = relativeExpiry(365);
  assert.match(exp, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.ok(Date.parse(exp) > Date.now(), "is in the future");
});

// --- Repo sweep: no time-bomb literal anywhere in the test/fixture tree today ---
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const SCAN_DIRS = ["test", "scripts/fixtures", "packages/ui/test"];
// This guard's own files contain near-future example dates by design.
const SELF = new Set(["test/helpers/time-bomb-scan.ts", "test/no-time-bomb-fixtures.test.ts"]);

function walk(dir: string, acc: string[] = []): string[] {
  // withFileTypes avoids a second statSync() per entry — no TOCTOU race and no
  // crash on a broken symlink / permission error, so the sweep degrades to
  // skipping an unreadable dir rather than reddening all of CI with an opaque FS error.
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else if (entry.isFile() && /\.(ts|tsx|mjs|cjs|js|json)$/.test(entry.name)) acc.push(p);
  }
  return acc;
}

test("no clock-relative time-bomb date literals in test/fixture files", () => {
  const offenders: string[] = [];
  for (const d of SCAN_DIRS) {
    for (const file of walk(join(REPO, d))) {
      const rel = relative(REPO, file);
      if (SELF.has(rel)) continue;
      for (const v of scanTimeBombFixtures(readFileSync(file, "utf8"))) {
        offenders.push(`${rel}:${v.line}  ${v.key}="${v.date}"`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Hardcoded near/future TTL date literal(s) found — these expire against the real clock and will redden CI on a future date. ` +
      `Use relativeExpiry() (test/helpers/clock.ts) or inject a fixed clock; add '// fixed-clock: <reason>' to exempt a legitimate fixed-clock fixture:\n${offenders.join("\n")}`,
  );
});
