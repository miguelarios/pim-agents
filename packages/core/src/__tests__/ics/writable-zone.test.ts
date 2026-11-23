import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../ics/_tz-init.js";
import { isWritableTimezone, parseIcsEvents, updateMasterEventIcs } from "../../ics/index.js";

describe("isWritableTimezone", () => {
  it("accepts IANA zones the bundled data matches, and UTC", () => {
    for (const z of [
      "America/Chicago",
      "Europe/London",
      "Asia/Tokyo",
      "US/Central",
      "UTC",
      "Etc/UTC",
    ]) {
      expect(isWritableTimezone(z), z).toBe(true);
    }
  });

  it("rejects names the bundled data gets wrong or lacks", () => {
    for (const z of [
      "Central Standard Time", // Windows name: a fixed offset in the bundled data
      "GMT Standard Time",
      "EST", // bundled as Halifax time, not fixed −05:00
      "Etc/GMT+5", // bundled with the sign inverted
      "Europe/Kyiv", // valid IANA, not in the bundled data
      "europe/london", // Intl ignores case, the bundled lookup doesn't
      "Customized Time Zone",
      "Foo/Bar",
      "",
    ]) {
      expect(isWritableTimezone(z), z).toBe(false);
    }
  });
});

describe("updateMasterEventIcs writes UTC aliases as UTC", () => {
  const event = (tzid: string, extra = "") =>
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:u1",
      "DTSTAMP:20260101T000000Z",
      `DTSTART;TZID=${tzid}:20270104T150000`,
      `DTEND;TZID=${tzid}:20270104T160000`,
      "RRULE:FREQ=WEEKLY;COUNT=20",
      extra,
      "SUMMARY:x",
      "END:VEVENT",
      "END:VCALENDAR",
    ]
      .filter(Boolean)
      .join("\r\n");
  const lines = (ics: string) =>
    ics.split(/\r?\n/).filter((l) => /^(DTSTART|DTEND|EXDATE)[;:]/.test(l));

  it.each(["UTC", "Etc/UTC", "Etc/GMT", "Zulu"])("%s", (tzid) => {
    const out = updateMasterEventIcs(event(tzid, `EXDATE;TZID=${tzid}:20270111T150000`), {
      start: "2027-01-04T16:00:00.000Z",
      end: "2027-01-04T17:00:00.000Z",
    });
    expect(lines(out)).toEqual([
      "DTSTART:20270104T160000Z",
      "DTEND:20270104T170000Z",
      "EXDATE:20270111T160000Z",
    ]);
    const occ = parseIcsEvents(
      out,
      { start: "2027-01-01T00:00:00Z", end: "2027-12-31T00:00:00Z" },
      "America/Chicago",
    );
    expect(occ[0].start).toBe("2027-01-04T16:00:00.000Z");
    expect(occ).toHaveLength(19);
  });
});

describe("moveSeriesSlots on a zone change with no change of time", () => {
  // The host in TZ's zone: then a floating start already sits at the new instant.
  beforeEach(() => vi.stubEnv("TZ", "America/Chicago"));
  afterEach(() => vi.unstubAllEnvs());

  it("still moves the exclusions into the new zone", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:z2",
      "DTSTAMP:20260101T000000Z",
      "DTSTART;TZID=Foo/Bar:20270104T090000",
      "DTEND;TZID=Foo/Bar:20270104T100000",
      "RRULE:FREQ=WEEKLY;COUNT=30",
      "EXDATE;TZID=Foo/Bar:20270524T090000",
      "SUMMARY:x",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    // 09:00 Chicago, the same wall time the floating start had: only the zone changes.
    const out = updateMasterEventIcs(ics, {
      start: "2027-01-04T15:00:00.000Z",
      end: "2027-01-04T17:00:00.000Z",
      timezone: "America/Chicago",
    });
    expect(out).toContain("EXDATE;TZID=America/Chicago:20270524T090000");
    const occ = parseIcsEvents(
      out,
      { start: "2027-01-01T00:00:00Z", end: "2027-12-31T00:00:00Z" },
      "America/Chicago",
    );
    expect(occ).toHaveLength(29);
  });
});

describe("isWritableTimezone, stricter (#176 third review)", () => {
  it("rejects zones whose bundled rules differ from Intl outside winter and summer", () => {
    // The bundled Jerusalem rule (-1FR) misses some years' spring change.
    expect(isWritableTimezone("Asia/Jerusalem")).toBe(false);
  });

  it("rejects a zone whose embedded definition disagrees with Intl", () => {
    const outdatedMoscow = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VTIMEZONE",
      "TZID:Europe/Moscow",
      "BEGIN:STANDARD",
      "DTSTART:19701025T030000",
      "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10",
      "TZOFFSETFROM:+0400",
      "TZOFFSETTO:+0300",
      "END:STANDARD",
      "BEGIN:DAYLIGHT",
      "DTSTART:19700329T020000",
      "RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3",
      "TZOFFSETFROM:+0300",
      "TZOFFSETTO:+0400",
      "END:DAYLIGHT",
      "END:VTIMEZONE",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(isWritableTimezone("Europe/Moscow")).toBe(true);
    expect(isWritableTimezone("Europe/Moscow", outdatedMoscow)).toBe(false);
  });

  it("accepts an embedded definition that agrees", () => {
    const ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR";
    expect(isWritableTimezone("America/Chicago", ics)).toBe(true);
  });
});

describe("moveSeriesSlots across zones, UTC and UTC-named slots (#176 third review)", () => {
  const RANGE = { start: "2027-01-01T00:00:00Z", end: "2027-12-31T00:00:00Z" };

  it("moves a UTC series' UTC exclusions with its occurrences into a zone with DST", () => {
    // A UTC series at 15:00Z weekly, excluding May 10 (still 15:00Z), moved to 10:00 Chicago.
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:u2",
      "DTSTAMP:20260101T000000Z",
      "DTSTART:20270301T150000Z",
      "DTEND:20270301T160000Z",
      "RRULE:FREQ=WEEKLY;COUNT=20",
      "EXDATE:20270510T150000Z",
      "SUMMARY:x",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const out = updateMasterEventIcs(ics, {
      start: "2027-03-01T16:00:00.000Z",
      end: "2027-03-01T17:00:00.000Z",
      timezone: "America/Chicago",
    });
    const occ = parseIcsEvents(out, RANGE);
    expect(occ).toHaveLength(19);
    expect(occ.some((e) => e.start.startsWith("2027-05-10"))).toBe(false);
  });

  it("never writes a series TZID on a UTC time when a UTC-named slot moves into a zone", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:u3",
      "DTSTAMP:20260101T000000Z",
      "DTSTART;TZID=Etc/UTC:20270104T160000",
      "DTEND;TZID=Etc/UTC:20270104T170000",
      "RRULE:FREQ=WEEKLY;COUNT=10",
      "EXDATE;TZID=Etc/UTC:20270111T160000",
      "SUMMARY:x",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const out = updateMasterEventIcs(ics, {
      start: "2027-01-04T16:00:00.000Z",
      end: "2027-01-04T17:00:00.000Z",
      timezone: "America/Chicago",
    });
    expect(out).not.toMatch(/TZID=[^:]+:\d{8}T\d{6}Z/);
    expect(out).toContain("EXDATE;TZID=America/Chicago:20270111T100000");
    expect(parseIcsEvents(out, RANGE)).toHaveLength(9);
  });
});
