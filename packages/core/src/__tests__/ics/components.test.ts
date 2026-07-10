import { describe, expect, it } from "vitest";
import "../../ics/_tz-init.js";
import {
  addExdateToIcs,
  combineIcsComponents,
  createExceptionComponent,
  removeExceptionFromIcs,
  splitIcsByUid,
} from "../../ics/components.js";
import { updateMasterEventIcs } from "../../ics/components.js";
import { IcsParseError } from "../../ics/errors.js";
import { generateEventIcs } from "../../ics/generate.js";

const masterIcs = generateEventIcs({
  title: "Weekly standup",
  start: "2026-05-04T13:00:00.000Z",
  end: "2026-05-04T13:30:00.000Z",
  uid: "components-test@pim-core",
  recurrence_rule: "FREQ=WEEKLY;BYDAY=MO",
  organizer: { email: "alice@example.com", name: "Alice Smith" },
  attendees: [{ email: "bob@example.com" }],
});

describe("createExceptionComponent", () => {
  it("creates a VEVENT block with RECURRENCE-ID and applies overrides", () => {
    const ex = createExceptionComponent(
      masterIcs,
      "vevent",
      "2026-05-11T13:00:00.000Z",
      {
        title: "Standup (moved)",
        start: "2026-05-11T15:00:00.000Z",
        end: "2026-05-11T15:30:00.000Z",
      },
      false,
    );
    expect(ex).toContain("BEGIN:VEVENT");
    expect(ex).toContain("END:VEVENT");
    expect(ex).toMatch(/RECURRENCE-ID/);
    expect(ex).toContain("Standup (moved)");
  });
});

describe("combineIcsComponents", () => {
  it("inserts the exception VEVENT into the master VCALENDAR", () => {
    const ex = createExceptionComponent(
      masterIcs,
      "vevent",
      "2026-05-11T13:00:00.000Z",
      { title: "Standup (moved)" },
      false,
    );
    const combined = combineIcsComponents(masterIcs, ex);
    expect(combined.match(/BEGIN:VEVENT/g)?.length).toBe(2);
    expect(combined).toContain("Standup (moved)");
  });

  it("replaces a prior exception with the same RECURRENCE-ID", () => {
    const ex1 = createExceptionComponent(
      masterIcs,
      "vevent",
      "2026-05-11T13:00:00.000Z",
      { title: "First override" },
      false,
    );
    const intermediate = combineIcsComponents(masterIcs, ex1);
    const ex2 = createExceptionComponent(
      masterIcs,
      "vevent",
      "2026-05-11T13:00:00.000Z",
      { title: "Second override" },
      false,
    );
    const combined = combineIcsComponents(intermediate, ex2);
    expect(combined.match(/BEGIN:VEVENT/g)?.length).toBe(2);
    expect(combined).not.toContain("First override");
    expect(combined).toContain("Second override");
  });
});

describe("addExdateToIcs", () => {
  it("appends an EXDATE for the given occurrence", () => {
    const updated = addExdateToIcs(masterIcs, "2026-05-11T13:00:00.000Z", false);
    expect(updated).toMatch(/EXDATE/);
  });
  it("is idempotent for the same date", () => {
    const once = addExdateToIcs(masterIcs, "2026-05-11T13:00:00.000Z", false);
    const twice = addExdateToIcs(once, "2026-05-11T13:00:00.000Z", false);
    expect((twice.match(/EXDATE/g) ?? []).length).toBe((once.match(/EXDATE/g) ?? []).length);
  });

  it("is idempotent for all-day EXDATE across DST boundaries (compare YYYY-MM-DD)", () => {
    // March 15, 2026 falls a week after US DST starts (Mar 8). A naive epoch-ms
    // comparison would interpret a date-only value differently when local tz
    // changes offset; the YMD-based check protects against that.
    const dailyMaster = generateEventIcs({
      title: "All-day daily",
      start: "2026-03-01T00:00:00.000Z",
      end: "2026-03-02T00:00:00.000Z",
      uid: "all-day-exdate@pim-core",
      all_day: true,
      recurrence_rule: "FREQ=DAILY;COUNT=30",
    });
    const once = addExdateToIcs(dailyMaster, "2026-03-15T00:00:00.000Z", true);
    const twice = addExdateToIcs(once, "2026-03-15T00:00:00.000Z", true);
    expect((twice.match(/EXDATE/g) ?? []).length).toBe((once.match(/EXDATE/g) ?? []).length);
  });
});

describe("combineIcsComponents — defensive guards", () => {
  it("rejects a full VCALENDAR-wrapped exception component", () => {
    const wrapped = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//x//EN\r\nBEGIN:VEVENT\r\nUID:x@pim-core\r\nDTSTAMP:20260101T000000Z\r\nRECURRENCE-ID:20260511T130000Z\r\nDTSTART:20260511T140000Z\r\nDTEND:20260511T143000Z\r\nSUMMARY:Bad shape\r\nEND:VEVENT\r\nEND:VCALENDAR`;
    expect(() => combineIcsComponents(masterIcs, wrapped)).toThrow(IcsParseError);
  });
});

const RECURRING_MASTER = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//test//EN",
  "BEGIN:VEVENT",
  "UID:weekly-1",
  "DTSTAMP:20260301T000000Z",
  "DTSTART:20260302T150000Z",
  "DTEND:20260302T153000Z",
  "SUMMARY:Weekly sync",
  "STATUS:TENTATIVE",
  "SEQUENCE:2",
  "RRULE:FREQ=WEEKLY;BYDAY=MO",
  "EXDATE:20260316T150000Z",
  "URL:https://example.com/meeting",
  "ORGANIZER;CN=alice:mailto:alice@example.com",
  "ATTENDEE;PARTSTAT=ACCEPTED;CN=Bob Jones:mailto:bob@example.com",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:weekly-1",
  "RECURRENCE-ID:20260309T150000Z",
  "DTSTAMP:20260301T000000Z",
  "DTSTART:20260309T160000Z",
  "DTEND:20260309T163000Z",
  "SUMMARY:Weekly sync (moved)",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("updateMasterEventIcs", () => {
  it("changes only the requested field and preserves everything else", () => {
    const out = updateMasterEventIcs(RECURRING_MASTER, { title: "Weekly sync v2" });
    expect(out).toContain("SUMMARY:Weekly sync v2");
    expect(out).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO");
    expect(out).toContain("EXDATE:20260316T150000Z");
    expect(out).toContain("RECURRENCE-ID:20260309T150000Z"); // exception override survives
    expect(out).toContain("PARTSTAT=ACCEPTED"); // attendee state survives
    expect(out).toContain("STATUS:TENTATIVE"); // status not rewritten
    expect(out).toContain("URL:https://example.com/meeting"); // unknown props survive
    expect(out).toContain("SEQUENCE:3"); // bumped from 2
  });

  it("replaces the attendee list only when attendees are provided", () => {
    const out = updateMasterEventIcs(RECURRING_MASTER, {
      attendees: [{ email: "carol@example.com" }],
    });
    expect(out).toContain("mailto:carol@example.com");
    expect(out).not.toContain("mailto:bob@example.com");
  });

  it("rewrites DTSTART/DTEND when start/end provided, without touching RRULE", () => {
    const out = updateMasterEventIcs(RECURRING_MASTER, {
      start: "2026-03-02T16:00:00Z",
      end: "2026-03-02T16:30:00Z",
    });
    expect(out).toContain("DTSTART:20260302T160000Z");
    expect(out).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO");
  });

  const ZONED_MASTER = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "BEGIN:VEVENT",
    "UID:weekly-tz-1",
    "DTSTAMP:20260301T000000Z",
    "DTSTART;TZID=America/New_York:20260302T100000",
    "DTEND;TZID=America/New_York:20260302T103000",
    "SUMMARY:Weekly sync NY",
    "SEQUENCE:0",
    "RRULE:FREQ=WEEKLY;BYDAY=MO",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  it("preserves the existing TZID when start is updated without a timezone override", () => {
    const out = updateMasterEventIcs(ZONED_MASTER, { start: "2026-03-02T11:00:00-05:00" });
    // Updated DTSTART keeps its zone (not flattened to a UTC Z instant) so the
    // RRULE keeps resolving 11:00 local across DST rather than drifting.
    expect(out).toContain("DTSTART;TZID=America/New_York:20260302T110000");
    expect(out).not.toMatch(/DTSTART[^\n]*:\d{8}T\d{6}Z/);
    // The untouched DTEND is unchanged — still zoned, no mismatched pair.
    expect(out).toContain("DTEND;TZID=America/New_York:20260302T103000");
    expect(out).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO");
  });

  it("lets updates.timezone override the existing TZID", () => {
    const out = updateMasterEventIcs(ZONED_MASTER, {
      start: "2026-03-02T09:00:00-08:00",
      timezone: "America/Los_Angeles",
    });
    expect(out).toContain("DTSTART;TZID=America/Los_Angeles:20260302T090000");
    expect(out).not.toContain("DTSTART;TZID=America/New_York");
  });
});

describe("splitIcsByUid", () => {
  const MULTI = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "BEGIN:VTIMEZONE",
    "TZID:America/Chicago",
    "BEGIN:STANDARD",
    "DTSTART:20261101T020000",
    "TZOFFSETFROM:-0500",
    "TZOFFSETTO:-0600",
    "END:STANDARD",
    "END:VTIMEZONE",
    "BEGIN:VEVENT",
    "UID:a-1",
    "DTSTAMP:20260301T000000Z",
    "DTSTART:20260302T150000Z",
    "DTEND:20260302T153000Z",
    "SUMMARY:Event A",
    "RRULE:FREQ=WEEKLY",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:a-1",
    "RECURRENCE-ID:20260309T150000Z",
    "DTSTAMP:20260301T000000Z",
    "DTSTART:20260309T160000Z",
    "DTEND:20260309T163000Z",
    "SUMMARY:Event A moved",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:b-2",
    "DTSTAMP:20260301T000000Z",
    "DTSTART:20260401T150000Z",
    "DTEND:20260401T153000Z",
    "SUMMARY:Event B",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  it("groups master + overrides per UID and copies VTIMEZONE into each", () => {
    const groups = splitIcsByUid(MULTI);
    expect(groups.map((g) => g.uid).sort()).toEqual(["a-1", "b-2"]);
    const a = groups.find((g) => g.uid === "a-1")!.ics;
    expect(a.match(/BEGIN:VEVENT/g)).toHaveLength(2); // master + override
    expect(a).toContain("TZID:America/Chicago");
    const b = groups.find((g) => g.uid === "b-2")!.ics;
    expect(b.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(b).not.toContain("Event A");
  });
});

describe("removeExceptionFromIcs", () => {
  it("removes a TZID-form override that the old regex missed", () => {
    const ICS = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//test//EN",
      "BEGIN:VTIMEZONE",
      "TZID:America/Chicago",
      "BEGIN:DAYLIGHT",
      "DTSTART:20260308T030000",
      "TZOFFSETFROM:-0600",
      "TZOFFSETTO:-0500",
      "END:DAYLIGHT",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "UID:tz-1",
      "DTSTAMP:20260301T000000Z",
      "DTSTART;TZID=America/Chicago:20260302T100000",
      "DTEND;TZID=America/Chicago:20260302T103000",
      "SUMMARY:Standup",
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:tz-1",
      "RECURRENCE-ID;TZID=America/Chicago:20260309T100000",
      "DTSTAMP:20260301T000000Z",
      "DTSTART;TZID=America/Chicago:20260309T110000",
      "DTEND;TZID=America/Chicago:20260309T113000",
      "SUMMARY:Standup (moved)",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    // 2026-03-09 10:00 Chicago (CDT, UTC-5) = 15:00Z
    const out = removeExceptionFromIcs(ICS, "2026-03-09T15:00:00.000Z", false);
    expect(out).not.toContain("Standup (moved)");
    expect(out).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO"); // master untouched
  });
});
