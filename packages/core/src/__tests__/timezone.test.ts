import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatInTimezone,
  getLocalDateParts,
  getTimezone,
  parseInTimezone,
  parseTimestamp,
  zonedTimeToUtc,
} from "../timezone.js";

describe("getTimezone", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns OS timezone by default", () => {
    const tz = getTimezone();
    // IANA timezone: "Area/Location" (e.g., "America/Chicago") or bare "UTC"
    expect(tz).toMatch(/^([A-Za-z]+\/[A-Za-z_]+|UTC)$/);
  });

  it("returns PIM_TIMEZONE env var when set", () => {
    vi.stubEnv("PIM_TIMEZONE", "America/New_York");
    expect(getTimezone()).toBe("America/New_York");
  });

  it("falls back to OS timezone when PIM_TIMEZONE is empty", () => {
    vi.stubEnv("PIM_TIMEZONE", "");
    const tz = getTimezone();
    expect(tz).toMatch(/^([A-Za-z]+\/[A-Za-z_]+|UTC)$/);
  });
});

describe("formatInTimezone", () => {
  it("converts UTC date to timezone offset string", () => {
    const result = formatInTimezone("2026-03-14T15:00:00.000Z", "America/Chicago");
    expect(result).toBe("2026-03-14T10:00:00-05:00");
  });

  it("handles DST transitions correctly", () => {
    const winter = formatInTimezone("2026-01-15T18:00:00.000Z", "America/Chicago");
    expect(winter).toBe("2026-01-15T12:00:00-06:00");

    const summer = formatInTimezone("2026-07-15T17:00:00.000Z", "America/Chicago");
    expect(summer).toBe("2026-07-15T12:00:00-05:00");
  });

  it("works with non-US timezones", () => {
    const result = formatInTimezone("2026-03-14T15:00:00.000Z", "Europe/Berlin");
    expect(result).toBe("2026-03-14T16:00:00+01:00");
  });
});

describe("parseTimestamp", () => {
  it("detects UTC timestamp", () => {
    const result = parseTimestamp("2026-03-14T15:00:00Z");
    expect(result.isUTC).toBe(true);
    expect(result.hasExplicitTimezone).toBe(false);
    expect(result.date.toISOString()).toBe("2026-03-14T15:00:00.000Z");
  });

  it("detects timestamp with timezone offset", () => {
    const result = parseTimestamp("2026-03-14T10:00:00-05:00");
    expect(result.isUTC).toBe(false);
    expect(result.hasExplicitTimezone).toBe(true);
    expect(result.date.toISOString()).toBe("2026-03-14T15:00:00.000Z");
    expect(result.offsetMinutes).toBe(-300);
  });

  it("treats bare timestamp as local (no timezone info)", () => {
    const result = parseTimestamp("2026-03-14T10:00:00");
    expect(result.isUTC).toBe(false);
    expect(result.hasExplicitTimezone).toBe(false);
  });
});

describe("zonedTimeToUtc", () => {
  it("converts Chicago local time to the correct UTC instant (CST, UTC-6)", () => {
    expect(zonedTimeToUtc(2026, 1, 15, 9, 0, "America/Chicago").toISOString()).toBe(
      "2026-01-15T15:00:00.000Z",
    );
  });
  it("handles the spring-forward DST transition (CDT, UTC-5)", () => {
    expect(zonedTimeToUtc(2026, 3, 9, 9, 0, "America/Chicago").toISOString()).toBe(
      "2026-03-09T14:00:00.000Z",
    );
  });
  it("rolls over month boundaries via day overflow", () => {
    expect(zonedTimeToUtc(2026, 1, 32, 0, 0, "UTC").toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });
});

describe("getLocalDateParts", () => {
  it("returns the calendar date in the target zone, not the host zone", () => {
    // 2026-07-10T03:00Z is still 2026-07-09 in Chicago (UTC-5)
    expect(getLocalDateParts(new Date("2026-07-10T03:00:00Z"), "America/Chicago")).toEqual({
      year: 2026,
      month: 7,
      day: 9,
    });
  });
});

describe("parseInTimezone", () => {
  const tz = "America/Chicago";
  it("reads a date as midnight in the zone", () => {
    expect(parseInTimezone("2026-11-16", tz).toISOString()).toBe("2026-11-16T06:00:00.000Z");
  });
  it("reads a date-time with no offset as wall-clock time in the zone", () => {
    expect(parseInTimezone("2026-11-16T08:30", tz).toISOString()).toBe("2026-11-16T14:30:00.000Z");
    expect(parseInTimezone("2026-07-16T08:30:15", tz).toISOString()).toBe(
      "2026-07-16T13:30:15.000Z",
    );
  });
  it("keeps an explicit offset or Z", () => {
    expect(parseInTimezone("2026-11-16T08:30:00Z", tz).toISOString()).toBe(
      "2026-11-16T08:30:00.000Z",
    );
    expect(parseInTimezone("2026-11-16T08:30:00+01:00", tz).toISOString()).toBe(
      "2026-11-16T07:30:00.000Z",
    );
  });
  it("is an Invalid Date for nonsense", () => {
    expect(Number.isNaN(parseInTimezone("next tuesday", tz).getTime())).toBe(true);
    expect(Number.isNaN(parseInTimezone("2026-13-45", tz).getTime())).toBe(true);
  });
  it("falls back to UTC for a zone Intl does not know", () => {
    expect(parseInTimezone("2026-11-16", "Not/AZone").toISOString()).toBe(
      "2026-11-16T00:00:00.000Z",
    );
  });
});
