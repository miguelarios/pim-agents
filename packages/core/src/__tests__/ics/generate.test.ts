// packages/core/src/__tests__/ics/generate.test.ts
import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import "../../ics/_tz-init.js";
import { IcsGenerateError } from "../../ics/errors.js";
import { generateEventIcs, generateVTimezoneIcs } from "../../ics/generate.js";
import { parseIcsEvents } from "../../ics/parse-events.js";

describe("generateEventIcs — basic round-trip", () => {
  it("emits VCALENDAR/VEVENT and round-trips through parseIcsEvents", () => {
    const ics = generateEventIcs({
      title: "Team standup",
      start: "2026-05-01T13:00:00.000Z",
      end: "2026-05-01T13:30:00.000Z",
      uid: "round-trip-test@pim-core",
    });
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("UID:round-trip-test@pim-core");
    const parsed = parseIcsEvents(ics);
    expect(parsed.length).toBe(1);
    expect(parsed[0].uid).toBe("round-trip-test@pim-core");
    expect(parsed[0].title).toBe("Team standup");
    expect(parsed[0].start).toBe("2026-05-01T13:00:00.000Z");
    expect(parsed[0].end).toBe("2026-05-01T13:30:00.000Z");
  });

  it("emits attendees and organizer", () => {
    const ics = generateEventIcs({
      title: "Sync",
      start: "2026-05-01T13:00:00.000Z",
      end: "2026-05-01T13:30:00.000Z",
      uid: "attendees-test@pim-core",
      organizer: { email: "alice@example.com", name: "Alice Smith" },
      attendees: [{ email: "bob@example.com" }, { email: "carol@example.com" }],
    });
    expect(ics).toContain("ORGANIZER");
    expect(ics).toContain("alice@example.com");
    expect(ics).toMatch(/ATTENDEE.*bob@example\.com/);
    expect(ics).toMatch(/ATTENDEE.*carol@example\.com/);
  });

  it("emits a valid RRULE", () => {
    const ics = generateEventIcs({
      title: "Recurring",
      start: "2026-05-01T13:00:00.000Z",
      end: "2026-05-01T13:30:00.000Z",
      uid: "rrule-test@pim-core",
      recurrence_rule: "FREQ=WEEKLY;BYDAY=FR",
    });
    expect(ics).toContain("RRULE:FREQ=WEEKLY;BYDAY=FR");
  });

  it("throws IcsGenerateError on invalid RRULE", () => {
    expect(() =>
      generateEventIcs({
        title: "Bad",
        start: "2026-05-01T13:00:00.000Z",
        end: "2026-05-01T13:30:00.000Z",
        recurrence_rule: "BAD-RULE",
      }),
    ).toThrow(IcsGenerateError);
  });

  it("throws IcsGenerateError when attendees provided without organizer", () => {
    expect(() =>
      generateEventIcs({
        title: "Bad",
        start: "2026-05-01T13:00:00.000Z",
        end: "2026-05-01T13:30:00.000Z",
        attendees: [{ email: "bob@example.com" }],
      }),
    ).toThrow(IcsGenerateError);
  });

  it("throws IcsGenerateError on invalid date", () => {
    expect(() =>
      generateEventIcs({
        title: "Bad",
        start: "not-a-date",
        end: "2026-05-01T13:30:00.000Z",
      }),
    ).toThrow(IcsGenerateError);
  });
});

describe("generateEventIcs — categories and alarms round-trip", () => {
  it("writes one CATEGORIES value per category, not one escaped value", () => {
    const ics = generateEventIcs({
      title: "Tagged",
      start: "2026-05-01T13:00:00.000Z",
      end: "2026-05-01T13:30:00.000Z",
      uid: "categories@pim-core",
      categories: ["Work", "Sync"],
    });
    expect(ics).toContain("CATEGORIES:Work,Sync");
    expect(ics).not.toContain("\\,");
    expect(parseIcsEvents(ics)[0].categories).toEqual(["Work", "Sync"]);
  });

  it("escapes a comma inside a single category name", () => {
    const ics = generateEventIcs({
      title: "Tagged",
      start: "2026-05-01T13:00:00.000Z",
      end: "2026-05-01T13:30:00.000Z",
      uid: "categories-comma@pim-core",
      categories: ["Smith, Jane"],
    });
    expect(parseIcsEvents(ics)[0].categories).toEqual(["Smith, Jane"]);
  });

  it("writes DISPLAY alarms described by the event title", () => {
    const ics = generateEventIcs({
      title: "Reminded",
      start: "2026-05-01T13:00:00.000Z",
      end: "2026-05-01T13:30:00.000Z",
      uid: "alarms@pim-core",
      alarms: [
        { type: "relative", trigger: -600 },
        { type: "absolute", trigger: "2026-05-01T12:00:00.000Z" },
      ],
    });
    expect(ics).toContain("TRIGGER:-PT10M");
    expect(ics).toContain("TRIGGER;VALUE=DATE-TIME:20260501T120000Z");
    expect(ics).toContain("DESCRIPTION:Reminded");
    expect(parseIcsEvents(ics)[0].alarms).toHaveLength(2);
  });
});

describe("generateVTimezoneIcs", () => {
  it("wraps the zone's VTIMEZONE in a VCALENDAR", () => {
    const ics = generateVTimezoneIcs("America/Chicago")!;
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("BEGIN:VTIMEZONE");
    expect(ics).toContain("TZID:America/Chicago");
    expect(ics).toContain("END:VCALENDAR");
  });

  it("returns null for a zone it does not know", () => {
    expect(generateVTimezoneIcs("Mars/Olympus_Mons")).toBeNull();
  });
});

describe("generateEventIcs — shared VTIMEZONE", () => {
  it("keeps the VTIMEZONE in a calendar built earlier when another is built for the same zone", () => {
    const zone = ICAL.TimezoneService.get("America/Chicago")!;
    // Simulate the old behaviour's hazard: hold a component that shares the
    // service's zone object, then generate an event for the same zone.
    const shared = new ICAL.Component(["vcalendar", [], []]);
    shared.addSubcomponent(zone.component!);
    generateEventIcs({
      title: "Zoned",
      start: "2026-05-01T13:00:00.000Z",
      end: "2026-05-01T13:30:00.000Z",
      uid: "shared-zone@pim-core",
      timezone: "America/Chicago",
    });
    expect(shared.toString()).toContain("BEGIN:VTIMEZONE");
  });
});
