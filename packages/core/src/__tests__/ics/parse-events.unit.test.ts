// packages/core/src/__tests__/ics/parse-events.unit.test.ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import "../../ics/_tz-init.js";
import { parseIcsEvents } from "../../ics/parse-events.js";

const FIXTURES = path.join(__dirname, "fixtures");

describe("parseIcsEvents — DST correctness (item 1)", () => {
  it("produces 09:00 wall-clock occurrences across the spring-forward boundary", () => {
    const ics = fs.readFileSync(path.join(FIXTURES, "dst_transition.ics"), "utf-8");
    // Range covers all 4 occurrences across DST.
    const result = parseIcsEvents(ics, {
      start: "2026-02-25T00:00:00Z",
      end: "2026-04-15T00:00:00Z",
    });
    expect(result.length).toBe(4);
    // US DST 2026 starts 2nd Sunday of March = Mar 8 at 02:00 local. The fixture
    // fires at 09:00 wall-clock weekly starting Mar 1, so:
    //   Mar 1 09:00 EST  (UTC-5) → 14:00 UTC  (pre-transition)
    //   Mar 8 09:00 EDT  (UTC-4) → 13:00 UTC  (DST already active by 09:00)
    //   Mar 15 09:00 EDT (UTC-4) → 13:00 UTC
    //   Mar 22 09:00 EDT (UTC-4) → 13:00 UTC
    // Wall-clock 09:00 is preserved across the boundary; the UTC offset shifts
    // by one hour, which is exactly the DST-correctness invariant we want.
    expect(result[0].start).toBe("2026-03-01T14:00:00.000Z");
    expect(result[1].start).toBe("2026-03-08T13:00:00.000Z");
    expect(result[2].start).toBe("2026-03-15T13:00:00.000Z");
    expect(result[3].start).toBe("2026-03-22T13:00:00.000Z");
  });
});

describe("parseIcsEvents — floating time (item 6)", () => {
  it("interprets floating DTSTART in the viewer timezone, not as UTC", () => {
    const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//pim-core//test//EN\r\nBEGIN:VEVENT\r\nUID:floating-test@pim-core\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260601T090000\r\nDTEND:20260601T100000\r\nSUMMARY:Floating-time event\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    const result = parseIcsEvents(ics, undefined, "America/Chicago");
    // 9am Chicago in June (CDT, UTC-5) → 14:00 UTC, NOT 09:00 UTC.
    expect(result[0].start).toBe("2026-06-01T14:00:00.000Z");
  });
});

describe("parseIcsEvents — multiple RRULEs (item 5)", () => {
  it("expands occurrences from all RRULEs in a VEVENT, not just the first", () => {
    const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//pim-core//test//EN\r\nBEGIN:VEVENT\r\nUID:multi-rrule-test@pim-core\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260101T090000Z\r\nDTEND:20260101T100000Z\r\nSUMMARY:Multi-RRULE\r\nRRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3\r\nRRULE:FREQ=WEEKLY;BYDAY=FR;COUNT=3\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    const result = parseIcsEvents(ics, {
      start: "2026-01-01T00:00:00Z",
      end: "2026-02-01T00:00:00Z",
    });
    expect(result.length).toBe(6); // 3 Mondays + 3 Fridays
  });
});

describe("parseIcsEvents — week-duration alarm trigger (RFC 5545 §3.3.6)", () => {
  it("decodes -P1W into -604800 seconds, not 0", () => {
    const ics = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//pim-core//test//EN\r\nBEGIN:VEVENT\r\nUID:week-trigger@pim-core\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20260601T090000Z\r\nDTEND:20260601T100000Z\r\nSUMMARY:Event with week-before alarm\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER:-P1W\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    const result = parseIcsEvents(ics);
    expect(result[0].alarms.length).toBe(1);
    expect(result[0].alarms[0]).toEqual({
      type: "relative",
      trigger: -604800,
      triggerHuman: "7 days before",
    });
  });
});

describe("recurrence of a stored object read without a range (#99 review)", () => {
  const cal = (...vevents: string[]) =>
    ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", ...vevents, "END:VCALENDAR"].join(
      "\r\n",
    );
  const MASTER = [
    "BEGIN:VEVENT",
    "UID:s1@example.com",
    "DTSTAMP:20261018T000000Z",
    "DTSTART:20261019T140000Z",
    "DTEND:20261019T143000Z",
    "RRULE:FREQ=DAILY;COUNT=3",
    "SUMMARY:Series",
    "END:VEVENT",
  ].join("\r\n");
  const OVERRIDE = [
    "BEGIN:VEVENT",
    "UID:s1@example.com",
    "DTSTAMP:20261018T000000Z",
    "RECURRENCE-ID:20261020T140000Z",
    "DTSTART:20261020T160000Z",
    "DTEND:20261020T163000Z",
    "SUMMARY:Moved",
    "END:VEVENT",
  ].join("\r\n");

  it("treats an override stored without its master as a one-off, not a series it cannot edit", () => {
    // Being invited to one occurrence of someone else's series stores exactly this.
    // Calling it recurring sent delete_event span=this down the ungated path.
    const [only] = parseIcsEvents(cal(OVERRIDE));
    expect(only.isRecurring).toBe(false);
    expect(only.occurrenceDate).toBe("2026-10-20T14:00:00.000Z");
  });

  it("still calls the same instance recurring when it comes from a ranged (expanded) listing", () => {
    const [only] = parseIcsEvents(cal(OVERRIDE), {
      start: "2026-10-19T00:00:00Z",
      end: "2026-10-22T00:00:00Z",
    });
    expect(only.isRecurring).toBe(true);
  });

  it("gives an override stored next to its master the master's rule", () => {
    const events = parseIcsEvents(cal(MASTER, OVERRIDE));
    const moved = events.find((e) => e.title === "Moved");
    expect(moved).toMatchObject({ isRecurring: true, recurrenceRule: "FREQ=DAILY;COUNT=3" });
  });

  it("calls an RDATE-only master recurring with or without a range", () => {
    const rdateOnly = MASTER.replace(
      "RRULE:FREQ=DAILY;COUNT=3",
      "RDATE:20261021T140000Z,20261023T140000Z",
    );
    expect(parseIcsEvents(cal(rdateOnly))[0].isRecurring).toBe(true);
    const ranged = parseIcsEvents(cal(rdateOnly), {
      start: "2026-10-18T00:00:00Z",
      end: "2026-10-25T00:00:00Z",
    });
    expect(ranged.every((e) => e.isRecurring)).toBe(true);
  });
});
