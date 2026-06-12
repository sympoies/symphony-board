import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidTimezone, zonedDayStartIso, zonedDayEndIso, zonedDateOnly, shiftDateOnly } from "../src/lib/tz.ts";

test("isValidTimezone accepts UTC, IANA names, and offset strings, rejects junk", () => {
  assert.equal(isValidTimezone("UTC"), true);
  assert.equal(isValidTimezone("Asia/Taipei"), true);
  assert.equal(isValidTimezone("America/New_York"), true);
  assert.equal(isValidTimezone("+08:00"), true); // Intl also accepts fixed-offset zones
  assert.equal(isValidTimezone("Not/AZone"), false);
  assert.equal(isValidTimezone("nonsense"), false);
});

test("UTC day boundaries are the plain midnight instants", () => {
  assert.equal(zonedDayStartIso("2026-06-09", "UTC"), "2026-06-09T00:00:00.000Z");
  assert.equal(zonedDayEndIso("2026-06-09", "UTC"), "2026-06-09T23:59:59.999Z");
});

test("Asia/Taipei day boundaries shift the UTC instants back 8 hours", () => {
  // 2026-06-09 00:00 +08:00 == 2026-06-08 16:00 UTC; no DST in Taipei.
  assert.equal(zonedDayStartIso("2026-06-09", "Asia/Taipei"), "2026-06-08T16:00:00.000Z");
  assert.equal(zonedDayEndIso("2026-06-09", "Asia/Taipei"), "2026-06-09T15:59:59.999Z");
});

test("a DST zone resolves day boundaries at its local offset", () => {
  // America/New_York is UTC-4 in June (EDT): local midnight == 04:00 UTC.
  assert.equal(zonedDayStartIso("2026-06-09", "America/New_York"), "2026-06-09T04:00:00.000Z");
  // ...and UTC-5 in January (EST): local midnight == 05:00 UTC.
  assert.equal(zonedDayStartIso("2026-01-09", "America/New_York"), "2026-01-09T05:00:00.000Z");
});

// zonedDateOnly + shiftDateOnly feed the repo-metric series bucketing
// (src/contract/build.ts); an off-by-one here silently shifts every bucket.
test("zonedDateOnly maps an instant to the calendar date of the configured zone, exact at midnight", () => {
  assert.equal(zonedDateOnly(Date.parse("2026-06-08T00:00:00.000Z"), "UTC"), "2026-06-08");
  assert.equal(zonedDateOnly(Date.parse("2026-06-08T23:59:59.999Z"), "UTC"), "2026-06-08");
  // Taipei is UTC+8: the local day flips at 16:00 UTC.
  assert.equal(zonedDateOnly(Date.parse("2026-06-07T15:59:59.999Z"), "Asia/Taipei"), "2026-06-07");
  assert.equal(zonedDateOnly(Date.parse("2026-06-07T16:00:00.000Z"), "Asia/Taipei"), "2026-06-08");
  // New York in June is UTC-4: the local day flips at 04:00 UTC.
  assert.equal(zonedDateOnly(Date.parse("2026-06-08T03:59:59.999Z"), "America/New_York"), "2026-06-07");
  assert.equal(zonedDateOnly(Date.parse("2026-06-08T04:00:00.000Z"), "America/New_York"), "2026-06-08");
});

test("shiftDateOnly does whole-day calendar arithmetic with month/year/leap roll-over", () => {
  assert.equal(shiftDateOnly("2026-06-08", 1), "2026-06-09");
  assert.equal(shiftDateOnly("2026-06-08", 7), "2026-06-15");
  assert.equal(shiftDateOnly("2026-01-31", 1), "2026-02-01");
  assert.equal(shiftDateOnly("2025-12-31", 1), "2026-01-01");
  assert.equal(shiftDateOnly("2026-01-01", -1), "2025-12-31");
  assert.equal(shiftDateOnly("2024-02-28", 1), "2024-02-29", "leap year keeps Feb 29");
  assert.equal(shiftDateOnly("2026-02-28", 1), "2026-03-01", "non-leap year rolls into March");
});
