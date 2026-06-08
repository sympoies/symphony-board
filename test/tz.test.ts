import { test } from "node:test";
import assert from "node:assert/strict";
import { isValidTimezone, zonedDayStartIso, zonedDayEndIso } from "../src/lib/tz.ts";

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
