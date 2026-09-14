import { describe, expect, it } from "vitest";
import { IcsParseError } from "../../ics/errors.js";
import { parseIcsFreeBusy } from "../../ics/parse-freebusy.js";

const REPLY = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//server//EN",
  "BEGIN:VFREEBUSY",
  "DTSTAMP:20260301T000000Z",
  "DTSTART:20260301T000000Z",
  "DTEND:20260302T000000Z",
  "FREEBUSY;FBTYPE=BUSY-TENTATIVE:20260301T100000Z/20260301T110000Z",
  "FREEBUSY:20260301T150000Z/20260301T160000Z,20260301T120000Z/PT1H",
  "FREEBUSY;FBTYPE=BUSY-UNAVAILABLE:20260301T180000Z/20260301T190000Z",
  "FREEBUSY;FBTYPE=FREE:20260301T170000Z/20260301T180000Z",
  "FREEBUSY;FBTYPE=X-VACATION:20260301T200000Z/20260301T210000Z",
  "END:VFREEBUSY",
  "END:VCALENDAR",
].join("\r\n");

describe("parseIcsFreeBusy", () => {
  it("reads every busy period, typed, sorted, with durations resolved to ends", () => {
    expect(parseIcsFreeBusy(REPLY)).toEqual([
      { start: "2026-03-01T10:00:00.000Z", end: "2026-03-01T11:00:00.000Z", type: "tentative" },
      { start: "2026-03-01T12:00:00.000Z", end: "2026-03-01T13:00:00.000Z", type: "busy" },
      { start: "2026-03-01T15:00:00.000Z", end: "2026-03-01T16:00:00.000Z", type: "busy" },
      { start: "2026-03-01T18:00:00.000Z", end: "2026-03-01T19:00:00.000Z", type: "unavailable" },
      { start: "2026-03-01T20:00:00.000Z", end: "2026-03-01T21:00:00.000Z", type: "busy" },
    ]);
  });

  it("returns nothing for an empty reply or one without VFREEBUSY", () => {
    expect(parseIcsFreeBusy("")).toEqual([]);
    expect(
      parseIcsFreeBusy("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//x//EN\r\nEND:VCALENDAR"),
    ).toEqual([]);
  });

  it("rejects content that is not iCalendar", () => {
    expect(() => parseIcsFreeBusy("<html>Forbidden</html>")).toThrow(IcsParseError);
  });
});
