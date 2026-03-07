import { describe, expect, it } from "vitest";
import { generateEventIcs, parseIcsEvents } from "../ical.js";

const SAMPLE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:evt-1@example.com
DTSTART:20260310T140000Z
DTEND:20260310T150000Z
SUMMARY:Team Meeting
LOCATION:Office Room A
DESCRIPTION:Weekly standup
STATUS:CONFIRMED
TRANSP:OPAQUE
END:VEVENT
END:VCALENDAR`;

const MULTI_EVENT_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:evt-1@example.com
DTSTART:20260310T090000Z
DTEND:20260310T100000Z
SUMMARY:Morning Meeting
END:VEVENT
BEGIN:VEVENT
UID:evt-2@example.com
DTSTART:20260310T140000Z
DTEND:20260310T150000Z
SUMMARY:Afternoon Meeting
END:VEVENT
END:VCALENDAR`;

describe("parseIcsEvents", () => {
  it("parses a single VEVENT from iCalendar string", () => {
    const events = parseIcsEvents(SAMPLE_ICS);
    expect(events).toHaveLength(1);
    expect(events[0].uid).toBe("evt-1@example.com");
    expect(events[0].summary).toBe("Team Meeting");
    expect(events[0].location).toBe("Office Room A");
    expect(events[0].description).toBe("Weekly standup");
    expect(events[0].status).toBe("CONFIRMED");
    expect(events[0].transparency).toBe("OPAQUE");
    expect(events[0].start).toContain("2026-03-10");
    expect(events[0].end).toContain("2026-03-10");
  });

  it("parses multiple VEVENTs from iCalendar string", () => {
    const events = parseIcsEvents(MULTI_EVENT_ICS);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.summary).sort()).toEqual(["Afternoon Meeting", "Morning Meeting"]);
  });

  it("returns empty array for iCalendar with no VEVENTs", () => {
    const events = parseIcsEvents("BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR");
    expect(events).toHaveLength(0);
  });

  it("returns empty array for empty string", () => {
    const events = parseIcsEvents("");
    expect(events).toHaveLength(0);
  });
});

describe("generateEventIcs", () => {
  it("generates valid iCalendar string with required fields", () => {
    const ics = generateEventIcs({
      summary: "Test Event",
      start: "2026-03-10T14:00:00Z",
      end: "2026-03-10T15:00:00Z",
    });
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("Test Event");
    expect(ics).toContain("END:VEVENT");
    expect(ics).toContain("END:VCALENDAR");
  });

  it("includes optional fields when provided", () => {
    const ics = generateEventIcs({
      summary: "Lunch",
      start: "2026-03-10T12:00:00Z",
      end: "2026-03-10T13:00:00Z",
      location: "Cafe",
      description: "Team lunch",
    });
    expect(ics).toContain("Cafe");
    expect(ics).toContain("Team lunch");
  });

  it("includes attendees when provided", () => {
    const ics = generateEventIcs({
      summary: "Meeting",
      start: "2026-03-10T14:00:00Z",
      end: "2026-03-10T15:00:00Z",
      attendees: [{ email: "bob@example.com", name: "Bob" }],
    });
    expect(ics).toContain("bob@example.com");
  });
});
