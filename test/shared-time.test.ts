import assert from "node:assert/strict";
import test from "node:test";
import * as producer from "../src/lib/tz.ts";
import * as consumer from "../packages/ui/src/tz.ts";
import { compareTimestampDesc, timestampInRange } from "../shared/time.ts";

for (const [name, calendar] of [["producer", producer], ["consumer", consumer]] as const) {
  for (const [date, start, end] of [
    ["2026-03-08", "2026-03-08T05:00:00.000Z", "2026-03-09T03:59:59.999Z"],
    ["2026-11-01", "2026-11-01T04:00:00.000Z", "2026-11-02T04:59:59.999Z"],
  ] as const) {
    test(`${name} preserves the DST transition day ${date}`, () => {
      assert.equal(calendar.zonedDayStartIso(date, "America/New_York"), start);
      assert.equal(calendar.zonedDayEndIso(date, "America/New_York"), end);
      assert.equal(calendar.zonedDateOnly(Date.parse(end), "America/New_York"), date);
    });
  }
}

test("timestamp ordering and inclusive ranges compare instants across offsets", () => {
  const range = { from: "2026-06-08T16:00:00Z", to: "2026-06-09T15:59:59.999Z" };
  assert.equal(timestampInRange("2026-06-09T00:00:00+08:00", range), true);
  assert.equal(timestampInRange("2026-06-09T23:59:59.999+08:00", range), true);
  assert.equal(timestampInRange("2026-06-10T00:00:00+08:00", range), false);
  assert.equal(timestampInRange("invalid", range), false);
  assert.equal(compareTimestampDesc("2026-06-09T00:00:00+08:00", "2026-06-08T16:00:00Z"), 0);
  assert.equal(compareTimestampDesc(null, range.from), 1);
  assert.equal(compareTimestampDesc(range.from, "invalid"), -1);
});
