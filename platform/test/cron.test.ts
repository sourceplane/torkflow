import { describe, expect, it } from "vitest";
import { CronParseError, nextRunAt, parseCron } from "../src/triggers/cron.js";

const at = (iso: string) => new Date(iso).getTime();
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe("cron parsing", () => {
  it("parses the standard fields", () => {
    const fields = parseCron("*/15 9-17 * * 1-5");
    expect([...fields.minutes]).toEqual([0, 15, 30, 45]);
    expect([...fields.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...fields.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
  });

  it("accepts month and day names", () => {
    expect([...parseCron("0 0 1 jan,jul *").months]).toEqual([1, 7]);
    expect([...parseCron("0 0 * * mon,fri").daysOfWeek]).toEqual([1, 5]);
  });

  it("treats both 0 and 7 as Sunday", () => {
    expect([...parseCron("0 0 * * 7").daysOfWeek]).toEqual([0]);
  });

  it("expands shorthand aliases", () => {
    expect([...parseCron("@daily").hours]).toEqual([0]);
    expect([...parseCron("@hourly").minutes]).toEqual([0]);
  });

  it("rejects malformed expressions", () => {
    expect(() => parseCron("* * *")).toThrow(CronParseError);
    expect(() => parseCron("60 * * * *")).toThrow(CronParseError);
    expect(() => parseCron("* 25 * * *")).toThrow(CronParseError);
    expect(() => parseCron("* * * * abc")).toThrow(CronParseError);
  });
});

describe("next occurrence", () => {
  it("finds the next matching minute", () => {
    expect(iso(nextRunAt("*/15 * * * *", at("2026-08-21T10:07:00Z")))).toBe("2026-08-21T10:15:00.000Z");
  });

  it("rolls over to the next day", () => {
    expect(iso(nextRunAt("0 9 * * *", at("2026-08-21T10:00:00Z")))).toBe("2026-08-22T09:00:00.000Z");
  });

  it("skips to the next weekday for a weekday schedule", () => {
    // 2026-08-21 is a Friday; the next weekday 09:00 is Monday the 24th.
    expect(iso(nextRunAt("0 9 * * 1-5", at("2026-08-21T09:30:00Z")))).toBe("2026-08-24T09:00:00.000Z");
  });

  it("rolls over to the next month", () => {
    expect(iso(nextRunAt("0 0 1 * *", at("2026-08-21T10:00:00Z")))).toBe("2026-09-01T00:00:00.000Z");
  });

  it("handles a once-a-year schedule", () => {
    expect(iso(nextRunAt("30 3 1 1 *", at("2026-08-21T10:00:00Z")))).toBe("2027-01-01T03:30:00.000Z");
  });

  it("ORs day-of-month with day-of-week when both are restricted", () => {
    // Standard cron: fires on the 15th OR on any Monday, whichever is sooner.
    // 2026-08-21 is a Friday, so the next Monday is the 24th, before the 15th
    // of September.
    expect(iso(nextRunAt("0 0 15 * 1", at("2026-08-21T10:00:00Z")))).toBe("2026-08-24T00:00:00.000Z");
  });

  it("evaluates the schedule in the requested timezone", () => {
    // 09:00 in New York during daylight saving is 13:00 UTC.
    expect(iso(nextRunAt("0 9 * * *", at("2026-08-21T14:00:00Z"), "America/New_York"))).toBe(
      "2026-08-22T13:00:00.000Z",
    );
  });

  it("keeps local wall-clock time across a DST transition", () => {
    // US DST ends 2026-11-01. A 09:00 New York schedule is 13:00 UTC before the
    // change and 14:00 UTC after it — the local hour is what stays fixed.
    const before = nextRunAt("0 9 * * *", at("2026-10-30T14:00:00Z"), "America/New_York");
    expect(iso(before)).toBe("2026-10-31T13:00:00.000Z");
    const after = nextRunAt("0 9 * * *", at("2026-11-01T14:00:00Z"), "America/New_York");
    expect(iso(after)).toBe("2026-11-02T14:00:00.000Z");
  });

  it("never returns a time in the past", () => {
    const now = at("2026-08-21T10:07:33Z");
    const next = nextRunAt("* * * * *", now);
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(now);
  });
});
