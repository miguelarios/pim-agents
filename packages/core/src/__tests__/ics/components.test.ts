import { describe, expect, it } from "vitest";
import "../../ics/_tz-init.js";
import {
  addExdateToIcs,
  combineIcsComponents,
  createExceptionComponent,
  removeExceptionFromIcs,
  splitIcsByUid,
  splitRecurrenceIcs,
  truncateRecurrenceIcs,
} from "../../ics/components.js";
import { updateMasterEventIcs } from "../../ics/components.js";
import { IcsParseError } from "../../ics/errors.js";
import { generateEventIcs } from "../../ics/generate.js";
import { parseIcsEvents } from "../../ics/parse-events.js";

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

describe("createExceptionComponent — categories and alarms", () => {
  const masterWithExtras = generateEventIcs({
    title: "Weekly standup",
    start: "2026-05-04T13:00:00.000Z",
    end: "2026-05-04T13:30:00.000Z",
    uid: "components-extras@pim-core",
    recurrence_rule: "FREQ=WEEKLY;BYDAY=MO",
    categories: ["Work", "Sync"],
    alarms: [{ type: "relative", trigger: -600 }],
  });
  const WEEK = { start: "2026-05-11T00:00:00.000Z", end: "2026-05-12T00:00:00.000Z" };

  it("inherits the master's VALARMs when no alarms override is given", () => {
    const ex = createExceptionComponent(
      masterWithExtras,
      "vevent",
      "2026-05-11T13:00:00.000Z",
      { title: "Moved" },
      false,
    );
    expect(ex).toContain("BEGIN:VALARM");
    expect(ex).toContain("TRIGGER:-PT10M");
    const occurrence = parseIcsEvents(combineIcsComponents(masterWithExtras, ex), WEEK)[0];
    expect(occurrence.title).toBe("Moved");
    expect(occurrence.alarms.map((a) => a.trigger)).toEqual([-600]);
  });

  it("replaces the alarms when an override is given", () => {
    const ex = createExceptionComponent(
      masterWithExtras,
      "vevent",
      "2026-05-11T13:00:00.000Z",
      { alarms: [{ type: "relative", trigger: -300 }] },
      false,
    );
    const occurrence = parseIcsEvents(combineIcsComponents(masterWithExtras, ex), WEEK)[0];
    expect(occurrence.alarms.map((a) => a.trigger)).toEqual([-300]);
  });

  it("clears the alarms when an empty override is given", () => {
    const ex = createExceptionComponent(
      masterWithExtras,
      "vevent",
      "2026-05-11T13:00:00.000Z",
      { alarms: [] },
      false,
    );
    expect(ex).not.toContain("BEGIN:VALARM");
  });

  it("writes categories as separate values on the override", () => {
    const inherited = createExceptionComponent(
      masterWithExtras,
      "vevent",
      "2026-05-11T13:00:00.000Z",
      {},
      false,
    );
    expect(inherited).toContain("CATEGORIES:Work,Sync");
    const replaced = createExceptionComponent(
      masterWithExtras,
      "vevent",
      "2026-05-11T13:00:00.000Z",
      { categories: ["Ops", "Standup"] },
      false,
    );
    const occurrence = parseIcsEvents(combineIcsComponents(masterWithExtras, replaced), WEEK)[0];
    expect(occurrence.categories).toEqual(["Ops", "Standup"]);
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

  it("writes categories as separate values, and an empty list removes them", () => {
    const tagged = updateMasterEventIcs(RECURRING_MASTER, { categories: ["Work", "Sync"] });
    expect(tagged).toContain("CATEGORIES:Work,Sync");
    expect(parseIcsEvents(tagged)[0].categories).toEqual(["Work", "Sync"]);
    const cleared = updateMasterEventIcs(tagged, { categories: [] });
    expect(cleared).not.toContain("CATEGORIES");
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

describe("truncateRecurrenceIcs", () => {
  const SERIES = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "BEGIN:VEVENT",
    "UID:trunc-1",
    "DTSTAMP:20260301T000000Z",
    "DTSTART:20260302T150000Z",
    "DTEND:20260302T153000Z",
    "SUMMARY:Weekly sync",
    "SEQUENCE:3",
    "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=20",
    "RDATE:20260305T150000Z,20260402T150000Z",
    "EXDATE:20260309T150000Z",
    "EXDATE:20260406T150000Z",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:trunc-1",
    "RECURRENCE-ID:20260316T150000Z",
    "DTSTAMP:20260301T000000Z",
    "DTSTART:20260316T160000Z",
    "DTEND:20260316T163000Z",
    "SUMMARY:Weekly sync moved and kept",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:trunc-1",
    "RECURRENCE-ID:20260413T150000Z",
    "DTSTAMP:20260301T000000Z",
    "DTSTART:20260413T160000Z",
    "DTEND:20260413T163000Z",
    "SUMMARY:Weekly sync moved and dropped",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  it("ends the rule one second before the cut and drops COUNT", () => {
    const out = truncateRecurrenceIcs(SERIES, "2026-03-30T15:00:00.000Z", false)!;
    expect(out).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20260330T145959Z");
    expect(out).not.toContain("COUNT");
    expect(out).toContain("SEQUENCE:4");
    const occurrences = parseIcsEvents(out, {
      start: "2026-03-01T00:00:00Z",
      end: "2026-06-01T00:00:00Z",
    });
    const starts = occurrences.map((e) => e.occurrence_date);
    expect(starts).toContain("2026-03-23T15:00:00.000Z");
    expect(starts).not.toContain("2026-03-30T15:00:00.000Z");
    expect(starts.every((d) => d! < "2026-03-30")).toBe(true);
  });

  it("keeps overrides, RDATEs and EXDATEs before the cut and removes those after", () => {
    const out = truncateRecurrenceIcs(SERIES, "2026-03-30T15:00:00.000Z", false)!;
    expect(out).toContain("SUMMARY:Weekly sync moved and kept");
    expect(out).not.toContain("SUMMARY:Weekly sync moved and dropped");
    expect(out).toContain("RDATE:20260305T150000Z");
    expect(out).not.toContain("20260402T150000Z");
    expect(out).toContain("EXDATE:20260309T150000Z");
    expect(out).not.toContain("EXDATE:20260406T150000Z");
  });

  it("returns null when the cut is at or before the first occurrence", () => {
    expect(truncateRecurrenceIcs(SERIES, "2026-03-02T15:00:00.000Z", false)).toBeNull();
    expect(truncateRecurrenceIcs(SERIES, "2026-01-01T00:00:00.000Z", false)).toBeNull();
  });

  it("writes a DATE-valued UNTIL on the previous day for an all-day series", () => {
    const allDay = generateEventIcs({
      title: "Daily",
      start: "2026-03-01T00:00:00.000Z",
      end: "2026-03-02T00:00:00.000Z",
      uid: "trunc-all-day@pim-core",
      all_day: true,
      recurrence_rule: "FREQ=DAILY;COUNT=30",
    });
    const out = truncateRecurrenceIcs(allDay, "2026-03-10T00:00:00.000Z", true)!;
    expect(out).toContain("UNTIL=20260309");
    expect(out).not.toMatch(/UNTIL=20260309T/);
    const occurrences = parseIcsEvents(out, {
      start: "2026-03-01T00:00:00Z",
      end: "2026-04-01T00:00:00Z",
    });
    expect(occurrences).toHaveLength(9);
  });

  it("throws when the master has no RRULE", () => {
    expect(() =>
      truncateRecurrenceIcs(
        SERIES.replace("RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=20\r\n", ""),
        "2026-03-30T15:00:00.000Z",
        false,
      ),
    ).toThrow(IcsParseError);
  });
});

describe("splitRecurrenceIcs", () => {
  const SERIES = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    "BEGIN:VEVENT",
    "UID:split-1",
    "DTSTAMP:20260301T000000Z",
    "DTSTART:20260302T150000Z",
    "DTEND:20260302T153000Z",
    "SUMMARY:Weekly sync",
    "LOCATION:Room A",
    "SEQUENCE:3",
    "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10",
    "EXDATE:20260309T150000Z",
    "EXDATE:20260413T150000Z",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:split-1",
    "RECURRENCE-ID:20260316T150000Z",
    "DTSTAMP:20260301T000000Z",
    "DTSTART:20260316T160000Z",
    "DTEND:20260316T163000Z",
    "SUMMARY:Weekly sync moved",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const RANGE = { start: "2026-03-01T00:00:00Z", end: "2026-07-01T00:00:00Z" };
  const CUT = "2026-03-30T15:00:00.000Z";

  it("ends the old series before the cut and starts the new one at it", () => {
    const { before, after } = splitRecurrenceIcs(SERIES, CUT, false, "split-1-tail")!;
    expect(before).toContain("UID:split-1\r\n");
    expect(before).toContain("UNTIL=20260330T145959Z");
    expect(after).toContain("UID:split-1-tail");
    expect(after).toContain("DTSTART:20260330T150000Z");
    expect(after).toContain("DTEND:20260330T153000Z");
    expect(after).toContain("SUMMARY:Weekly sync");
    expect(after).toContain("LOCATION:Room A");
  });

  it("together the two series cover exactly the original occurrences", () => {
    const { before, after } = splitRecurrenceIcs(SERIES, CUT, false, "split-1-tail")!;
    const original = parseIcsEvents(SERIES, RANGE).map((e) => e.occurrence_date);
    const combined = [
      ...parseIcsEvents(before, RANGE).map((e) => e.occurrence_date),
      ...parseIcsEvents(after, RANGE).map((e) => e.occurrence_date),
    ];
    expect(combined).toEqual(original);
    // COUNT=10 minus the four rule instances before 30 Mar (2, 9, 16, 23).
    expect(after).toContain("COUNT=6");
  });

  it("splits EXDATEs between the halves and drops overrides from the tail", () => {
    const { before, after } = splitRecurrenceIcs(SERIES, CUT, false, "split-1-tail")!;
    expect(before).toContain("EXDATE:20260309T150000Z");
    expect(before).not.toContain("EXDATE:20260413T150000Z");
    expect(after).not.toContain("EXDATE:20260309T150000Z");
    expect(after).toContain("EXDATE:20260413T150000Z");
    expect(before).toContain("Weekly sync moved");
    expect(after).not.toContain("RECURRENCE-ID");
  });

  it("starts the tail at SEQUENCE 0 with a fresh DTSTAMP", () => {
    const { after } = splitRecurrenceIcs(SERIES, CUT, false, "split-1-tail")!;
    expect(after).toContain("SEQUENCE:0");
    expect(after).not.toContain("DTSTAMP:20260301T000000Z");
  });

  it("keeps an UNTIL rule and the master's TZID on the tail", () => {
    const zoned = generateEventIcs({
      title: "Zoned",
      start: "2026-03-02T15:00:00.000Z",
      end: "2026-03-02T15:30:00.000Z",
      uid: "split-zoned@pim-core",
      recurrence_rule: "FREQ=WEEKLY;UNTIL=20260601T000000Z",
      timezone: "America/Chicago",
    });
    // 09:00 Chicago is 15:00Z in March before DST and 14:00Z after; the
    // 30 March occurrence is the latter, and the split insists on the real one.
    const { after } = splitRecurrenceIcs(
      zoned,
      "2026-03-30T14:00:00.000Z",
      false,
      "split-zoned-tail",
    )!;
    expect(after).toContain("UNTIL=20260601T000000Z");
    expect(after).toContain("DTSTART;TZID=America/Chicago:20260330T090000");
    expect(after).toContain("DTEND;TZID=America/Chicago:20260330T093000");
  });

  it("returns null when the cut is at the first occurrence", () => {
    expect(splitRecurrenceIcs(SERIES, "2026-03-02T15:00:00.000Z", false, "x")).toBeNull();
  });

  it("throws when nothing remains at or after the cut", () => {
    expect(() => splitRecurrenceIcs(SERIES, "2027-01-01T00:00:00.000Z", false, "x")).toThrow(
      IcsParseError,
    );
  });

  it("refuses a cut that is not an occurrence of the series", () => {
    // A Tuesday, and a Monday at the wrong time: neither is generated by the rule.
    expect(() => splitRecurrenceIcs(SERIES, "2026-03-31T15:00:00.000Z", false, "x")).toThrow(
      /No occurrence at 2026-03-31T15:00:00.000Z/,
    );
    expect(() => splitRecurrenceIcs(SERIES, "2026-03-30T15:30:00.000Z", false, "x")).toThrow(
      IcsParseError,
    );
  });

  it("accepts a cut at an RDATE-added occurrence", () => {
    const withRdate = SERIES.replace(
      "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10",
      "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10\r\nRDATE:20260401T150000Z",
    );
    const { after } = splitRecurrenceIcs(withRdate, "2026-04-01T15:00:00.000Z", false, "t")!;
    expect(after).toContain("DTSTART:20260401T150000Z");
  });

  it("counts the overrides at or after the cut that the split discards", () => {
    const { droppedOverrides: none } = splitRecurrenceIcs(SERIES, CUT, false, "x")!;
    expect(none).toBe(0);
    const { droppedOverrides } = splitRecurrenceIcs(
      SERIES,
      "2026-03-09T15:00:00.000Z",
      false,
      "x",
    )!;
    expect(droppedOverrides).toBe(1);
  });
});

describe("EXDATE handling (#40)", () => {
  const RANGE = { start: "2026-03-01T00:00:00Z", end: "2026-03-20T00:00:00Z" };
  const starts = (ics: string) =>
    parseIcsEvents(ics, RANGE).map((e) => `${e.title}@${e.start.slice(5, 16)}`);

  /** A zoned daily series with one TZID-form and one UTC-form exclusion, plus an override. */
  function zonedSeries(): string {
    const base = generateEventIcs({
      title: "Std",
      start: "2026-03-02T16:00:00.000Z",
      end: "2026-03-02T16:30:00.000Z",
      uid: "exdate@pim-core",
      recurrence_rule: "FREQ=DAILY;COUNT=6",
      timezone: "America/Chicago",
    }).replace(
      "RRULE:FREQ=DAILY;COUNT=6",
      "RRULE:FREQ=DAILY;COUNT=6\r\nEXDATE;TZID=America/Chicago:20260303T100000\r\nEXDATE:20260304T160000Z",
    );
    return combineIcsComponents(
      base,
      createExceptionComponent(
        base,
        "vevent",
        "2026-03-06T16:00:00.000Z",
        { title: "moved6" },
        false,
      ),
    );
  }

  it("expands with TZID-form, UTC-form and multi-value EXDATEs all honoured", () => {
    const multi = zonedSeries().replace(
      "EXDATE;TZID=America/Chicago:20260303T100000\r\nEXDATE:20260304T160000Z",
      "EXDATE;TZID=America/Chicago:20260303T100000,20260304T100000",
    );
    expect(starts(zonedSeries())).toEqual([
      "Std@03-02T16:00",
      "Std@03-05T16:00",
      "moved6@03-06T16:00",
      "Std@03-07T16:00",
    ]);
    expect(starts(multi)).toEqual(starts(zonedSeries()));
  });

  it("addExdateToIcs is idempotent against TZID-form and multi-value exclusions", () => {
    const ics = zonedSeries();
    expect(addExdateToIcs(ics, "2026-03-03T16:00:00.000Z", false)).toBe(ics);
    expect(addExdateToIcs(ics, "2026-03-04T16:00:00.000Z", false)).toBe(ics);
    const multi = ics.replace(
      "EXDATE;TZID=America/Chicago:20260303T100000\r\nEXDATE:20260304T160000Z",
      "EXDATE;TZID=America/Chicago:20260303T100000,20260304T100000",
    );
    expect(addExdateToIcs(multi, "2026-03-04T16:00:00.000Z", false)).toBe(multi);
  });

  it("a plain field edit on the master leaves every exclusion in place", () => {
    const edited = updateMasterEventIcs(zonedSeries(), { title: "Renamed" });
    expect(edited).toContain("EXDATE;TZID=America/Chicago:20260303T100000");
    expect(edited).toContain("EXDATE:20260304T160000Z");
    expect(starts(edited)).toEqual([
      "Renamed@03-02T16:00",
      "Renamed@03-05T16:00",
      "moved6@03-06T16:00",
      "Renamed@03-07T16:00",
    ]);
  });

  it("moving the series moves its exclusions and overrides with it", () => {
    const moved = updateMasterEventIcs(zonedSeries(), {
      start: "2026-03-02T17:00:00.000Z",
      end: "2026-03-02T17:30:00.000Z",
      timezone: "America/Chicago",
    });
    expect(moved).toContain("EXDATE;TZID=America/Chicago:20260303T110000");
    expect(moved).toContain("EXDATE:20260304T170000Z");
    expect(moved).toContain("RECURRENCE-ID:20260306T170000Z");
    // Cancelled occurrences stay cancelled; the override still applies and
    // keeps the time it was explicitly given.
    expect(starts(moved)).toEqual([
      "Std@03-02T17:00",
      "Std@03-05T17:00",
      "moved6@03-06T16:00",
      "Std@03-07T17:00",
    ]);
  });

  it("moving an all-day series shifts DATE-valued exclusions by whole days", () => {
    const allDay = generateEventIcs({
      title: "Day",
      start: "2026-03-02T00:00:00.000Z",
      end: "2026-03-03T00:00:00.000Z",
      uid: "exdate-all-day@pim-core",
      all_day: true,
      recurrence_rule: "FREQ=DAILY;COUNT=5",
    });
    const excluded = addExdateToIcs(allDay, "2026-03-04T00:00:00.000Z", true);
    const moved = updateMasterEventIcs(excluded, {
      start: "2026-03-09T00:00:00.000Z",
      end: "2026-03-10T00:00:00.000Z",
    });
    expect(moved).toContain("EXDATE;VALUE=DATE:20260311");
    expect(parseIcsEvents(moved, RANGE).map((e) => e.start.slice(5, 10))).toEqual([
      "03-09",
      "03-10",
      "03-12",
      "03-13",
    ]);
  });

  it("editing a cancelled occurrence brings it back as the override", () => {
    const ics = zonedSeries();
    const back = combineIcsComponents(
      ics,
      createExceptionComponent(
        ics,
        "vevent",
        "2026-03-04T16:00:00.000Z",
        { title: "back4" },
        false,
      ),
    );
    expect(back).not.toContain("EXDATE:20260304T160000Z");
    expect(back).toContain("EXDATE;TZID=America/Chicago:20260303T100000");
    expect(starts(back)).toEqual([
      "Std@03-02T16:00",
      "back4@03-04T16:00",
      "Std@03-05T16:00",
      "moved6@03-06T16:00",
      "Std@03-07T16:00",
    ]);
  });

  it("drops only the matching value from a multi-value EXDATE", () => {
    const multi = zonedSeries().replace(
      "EXDATE;TZID=America/Chicago:20260303T100000\r\nEXDATE:20260304T160000Z",
      "EXDATE;TZID=America/Chicago:20260303T100000,20260304T100000",
    );
    const back = combineIcsComponents(
      multi,
      createExceptionComponent(
        multi,
        "vevent",
        "2026-03-04T16:00:00.000Z",
        { title: "back4" },
        false,
      ),
    );
    expect(back).toContain("EXDATE;TZID=America/Chicago:20260303T100000\r\n");
    expect(back).not.toContain("20260304T100000");
    expect(starts(back)).toContain("back4@03-04T16:00");
  });
});
