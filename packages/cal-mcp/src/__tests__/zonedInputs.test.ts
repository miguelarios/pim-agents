/**
 * Times a caller passes in are read in PIM_TIMEZONE, the zone results are
 * given in: a date-only range bound is local midnight, and a date-time with
 * no offset is local wall-clock time. Not UTC, and not the host's zone.
 */
import { dispatchTool } from "@miguelarios/pim-core/mcp";
import type { ServerContext } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CALENDAR_TOOLS } from "../tools/calendarTools.js";

const EVENT = {
  uid: "e1",
  calendarId: "prov/Cal",
  title: "x",
  start: "2026-11-16T14:30:00.000Z",
  end: "2026-11-16T15:30:00.000Z",
  allDay: false,
  timeZone: "America/Chicago",
  location: null,
  status: null,
  isRecurring: false,
  occurrenceDate: null,
};

function mockService() {
  return {
    listCalendars: vi.fn(async () => [{ calendarId: "prov/Cal" }]),
    listReachableCalendars: vi.fn(async () => ({
      calendars: [{ calendarId: "prov/Cal" }],
      unavailable: [],
    })),
    listEvents: vi.fn(async () => []),
    listEventsFull: vi.fn(async () => []),
    getEvent: vi.fn(async () => EVENT),
    getEventWithMeta: vi.fn(),
    createEvent: vi.fn(async (..._args: unknown[]) => EVENT),
    updateEvent: vi.fn(async (..._args: unknown[]) => EVENT),
    fetchRawCalendarObject: vi.fn(),
    getFreeBusy: vi.fn(async () => ({ busy: [], sources: {} })),
    findFreeSlots: vi.fn(async () => []),
    getAccountEmail: vi.fn(() => "me@example.com"),
  };
}

const call = (name: string, args: Record<string, unknown>, service: unknown, ctx?: ServerContext) =>
  dispatchTool(CALENDAR_TOOLS, name, args, service as never, ctx) as Promise<any>;

describe("range bounds", () => {
  beforeEach(() => vi.stubEnv("PIM_TIMEZONE", "America/Chicago"));
  afterEach(() => vi.unstubAllEnvs());

  it("list_events reads a date as local midnight", async () => {
    const s = mockService();
    await call("list_events", { calendar: "prov/Cal", start: "2026-11-16", end: "2026-11-17" }, s);
    expect(s.listEvents).toHaveBeenCalledWith(
      "prov/Cal",
      "2026-11-16T06:00:00.000Z",
      "2026-11-17T06:00:00.000Z",
    );
  });

  it("list_events reads a time with no offset in the zone and keeps an explicit one", async () => {
    const s = mockService();
    await call(
      "list_events",
      { calendar: "prov/Cal", start: "2026-11-16T08:00:00", end: "2026-11-16T20:00:00Z" },
      s,
    );
    expect(s.listEvents).toHaveBeenCalledWith(
      "prov/Cal",
      "2026-11-16T14:00:00.000Z",
      "2026-11-16T20:00:00Z",
    );
  });

  it("still rejects an unreadable or inverted range", async () => {
    const s = mockService();
    const bad = await call("list_events", { start: "soon", end: "2026-11-17" }, s);
    expect(bad.isError).toBe(true);
    const inverted = await call("list_events", { start: "2026-11-17", end: "2026-11-16" }, s);
    expect(inverted.isError).toBe(true);
    expect(s.listEvents).not.toHaveBeenCalled();
  });

  it("search_events, get_free_busy and find_free_slots read dates the same way", async () => {
    const s = mockService();
    const range = { start: "2026-11-16", end: "2026-11-17" };
    await call("search_events", { query: "x", calendar: "prov/Cal", ...range }, s);
    expect(s.listEvents.mock.calls[0].slice(1)).toEqual([
      "2026-11-16T06:00:00.000Z",
      "2026-11-17T06:00:00.000Z",
    ]);
    await call("get_free_busy", { calendars: ["prov/Cal"], ...range }, s);
    expect(s.getFreeBusy.mock.calls[0].slice(1, 3)).toEqual([
      "2026-11-16T06:00:00.000Z",
      "2026-11-17T06:00:00.000Z",
    ]);
    await call("find_free_slots", { calendars: ["prov/Cal"], duration: 30, ...range }, s);
    expect(s.findFreeSlots.mock.calls[0].slice(1, 3)).toEqual([
      "2026-11-16T06:00:00.000Z",
      "2026-11-17T06:00:00.000Z",
    ]);
  });
});

describe("get_free_busy answers in local time", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("renders the range and every period in PIM_TIMEZONE", async () => {
    vi.stubEnv("PIM_TIMEZONE", "America/Chicago");
    const s = mockService();
    s.getFreeBusy.mockResolvedValueOnce({
      busy: [{ start: "2026-11-16T14:30:00.000Z", end: "2026-11-16T15:30:00.000Z", type: "busy" }],
      sources: { "prov/Cal": "server" },
    } as never);
    const r = await call(
      "get_free_busy",
      { calendars: ["prov/Cal"], start: "2026-11-16", end: "2026-11-17" },
      s,
    );
    expect(r.structuredContent).toMatchObject({
      start: "2026-11-16T00:00:00-06:00",
      end: "2026-11-17T00:00:00-06:00",
      busy: [
        { start: "2026-11-16T08:30:00-06:00", end: "2026-11-16T09:30:00-06:00", type: "busy" },
      ],
    });
  });

  it("falls back to UTC for a zone Intl does not know", async () => {
    vi.stubEnv("PIM_TIMEZONE", "Not/AZone");
    const s = mockService();
    const r = await call(
      "get_free_busy",
      { calendars: ["prov/Cal"], start: "2026-11-16T00:00:00Z", end: "2026-11-17T00:00:00Z" },
      s,
    );
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.start).toBe("2026-11-16T00:00:00+00:00");
  });
});

describe("event times", () => {
  beforeEach(() => vi.stubEnv("PIM_TIMEZONE", "America/Chicago"));
  afterEach(() => vi.unstubAllEnvs());

  const written = (s: ReturnType<typeof mockService>, n = 0) =>
    String(s.createEvent.mock.calls[n][1]);

  it("create_event writes a time with no offset as that wall-clock time in the zone", async () => {
    const s = mockService();
    await call(
      "create_event",
      {
        calendar: "prov/Cal",
        title: "Flight",
        start: "2026-11-16T08:30:00",
        end: "2026-11-16T09:30:00",
      },
      s,
    );
    expect(written(s)).toContain("DTSTART;TZID=America/Chicago:20261116T083000");
    expect(written(s)).toContain("DTEND;TZID=America/Chicago:20261116T093000");
  });

  it("create_event keeps an all-day date as that date, east of UTC too", async () => {
    vi.stubEnv("PIM_TIMEZONE", "Europe/Berlin");
    const s = mockService();
    await call(
      "create_event",
      { calendar: "prov/Cal", title: "Trip", start: "2026-11-16", end: "2026-11-17", allDay: true },
      s,
    );
    expect(written(s)).toContain("DTSTART;VALUE=DATE:20261116");
    expect(written(s)).toContain("DTEND;VALUE=DATE:20261117");
  });

  it("create_events_batch reads each event's times in the zone", async () => {
    const s = mockService();
    await call(
      "create_events_batch",
      {
        calendar: "prov/Cal",
        events: [
          { title: "a", start: "2026-11-16T08:30:00", end: "2026-11-16T09:00:00" },
          { title: "b", start: "2026-11-17", end: "2026-11-18", allDay: true },
        ],
      },
      s,
    );
    expect(written(s, 0)).toContain("DTSTART;TZID=America/Chicago:20261116T083000");
    expect(written(s, 1)).toContain("DTSTART;VALUE=DATE:20261117");
  });

  it("update_event span=this reads a time with no offset in the zone", async () => {
    const s = mockService();
    const master = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:e1",
      "DTSTART;TZID=America/Chicago:20261102T083000",
      "DTEND;TZID=America/Chicago:20261102T093000",
      "RRULE:FREQ=WEEKLY;COUNT=5",
      "SUMMARY:Standup",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    s.getEventWithMeta.mockResolvedValue({
      event: {
        ...EVENT,
        isRecurring: true,
        attendees: [],
        alarms: [],
        categories: [],
        organizer: null,
      },
      meta: { url: "u", etag: "e" },
    });
    s.fetchRawCalendarObject.mockResolvedValue({ data: master, url: "u", etag: "e" });
    const r = await call(
      "update_event",
      {
        calendar: "prov/Cal",
        uid: "e1",
        span: "this",
        occurrenceDate: "2026-11-16T08:30:00",
        start: "2026-11-16T10:00:00",
        end: "2026-11-16T11:00:00",
      },
      s,
    );
    expect(r.isError).toBeFalsy();
    const ics = String(s.updateEvent.mock.calls[0][2]);
    expect(ics).toContain("RECURRENCE-ID:20261116T143000Z");
    expect(ics).toContain("DTSTART:20261116T160000Z");
    expect(r.structuredContent.event.start).toBe("2026-11-16T10:00:00-06:00");
  });

  it("get_event reads an occurrenceDate with no offset in the zone", async () => {
    const s = mockService();
    await call(
      "get_event",
      { calendar: "prov/Cal", uid: "e1", occurrenceDate: "2026-11-16T08:30:00" },
      s,
    );
    expect(s.getEvent).toHaveBeenCalledWith("prov/Cal", "e1", "2026-11-16T14:30:00.000Z");
  });

  it("keeps a date-form occurrenceDate as the date it names", async () => {
    const s = mockService();
    await call("get_event", { calendar: "prov/Cal", uid: "e1", occurrenceDate: "2026-11-16" }, s);
    expect(s.getEvent).toHaveBeenCalledWith("prov/Cal", "e1", "2026-11-16");
  });
});

describe("all-day values keep their local date (#165 review)", () => {
  afterEach(() => vi.unstubAllEnvs());

  const ALLDAY_SERIES = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:e1",
    "DTSTART;VALUE=DATE:20261116",
    "DTEND;VALUE=DATE:20261117",
    "RRULE:FREQ=WEEKLY;COUNT=5",
    "SUMMARY:Gym",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  function allDaySeries(s: ReturnType<typeof mockService>) {
    s.getEventWithMeta.mockResolvedValue({
      event: {
        ...EVENT,
        allDay: true,
        timeZone: null,
        start: "2026-11-16T00:00:00.000Z",
        end: "2026-11-17T00:00:00.000Z",
        isRecurring: true,
        attendees: [],
        alarms: [],
        categories: [],
        organizer: null,
      },
      meta: { url: "u", etag: "e" },
    });
    s.fetchRawCalendarObject.mockResolvedValue({ data: ALLDAY_SERIES, url: "u", etag: "e" });
  }

  it("create_event with allDay and midnight date-times writes those dates, east of UTC", async () => {
    vi.stubEnv("PIM_TIMEZONE", "Europe/Berlin");
    const s = mockService();
    await call(
      "create_event",
      {
        calendar: "prov/Cal",
        title: "Trip",
        allDay: true,
        start: "2026-11-16T00:00:00",
        end: "2026-11-17T00:00:00",
      },
      s,
    );
    const ics = String(s.createEvent.mock.calls[0][1]);
    expect(ics).toContain("DTSTART;VALUE=DATE:20261116");
    expect(ics).toContain("DTEND;VALUE=DATE:20261117");
  });

  it("create_events_batch does the same west of UTC with evening times", async () => {
    vi.stubEnv("PIM_TIMEZONE", "America/Chicago");
    const s = mockService();
    await call(
      "create_events_batch",
      {
        calendar: "prov/Cal",
        events: [
          { title: "a", allDay: true, start: "2026-11-16T20:00:00", end: "2026-11-17T20:00:00" },
        ],
      },
      s,
    );
    expect(String(s.createEvent.mock.calls[0][1])).toContain("DTSTART;VALUE=DATE:20261116");
  });

  it("delete_event span=this excludes the named day of an all-day series", async () => {
    vi.stubEnv("PIM_TIMEZONE", "Asia/Tokyo");
    const s = mockService();
    allDaySeries(s);
    const r = await call(
      "delete_event",
      { calendar: "prov/Cal", uid: "e1", span: "this", occurrenceDate: "2026-11-23T00:00:00" },
      s,
    );
    expect(r.isError).toBeFalsy();
    const ics = String(s.updateEvent.mock.calls[0][2]);
    expect(ics).toMatch(/EXDATE;VALUE=DATE(;VALUE=DATE)?:20261123/);
  });

  it("update_event span=this on an all-day series targets the named day", async () => {
    vi.stubEnv("PIM_TIMEZONE", "Asia/Tokyo");
    const s = mockService();
    allDaySeries(s);
    const r = await call(
      "update_event",
      {
        calendar: "prov/Cal",
        uid: "e1",
        span: "this",
        occurrenceDate: "2026-11-23T00:00:00",
        title: "Moved",
      },
      s,
    );
    expect(r.isError).toBeFalsy();
    expect(String(s.updateEvent.mock.calls[0][2])).toMatch(
      /RECURRENCE-ID;VALUE=DATE(;VALUE=DATE)?:20261123/,
    );
  });

  it("update_event on an all-day event writes the local date of a timed value", async () => {
    vi.stubEnv("PIM_TIMEZONE", "America/Chicago");
    const s = mockService();
    allDaySeries(s);
    await call(
      "update_event",
      {
        calendar: "prov/Cal",
        uid: "e1",
        span: "all",
        start: "2026-11-16T20:00:00",
        end: "2026-11-17T20:00:00",
      },
      s,
    );
    const ics = String(s.updateEvent.mock.calls[0][2]);
    expect(ics).toMatch(/DTSTART;VALUE=DATE(;VALUE=DATE)?:20261116/);
    expect(ics).toMatch(/DTEND;VALUE=DATE(;VALUE=DATE)?:20261117/);
  });

  it("reads an absolute alarm trigger with no offset in the zone", async () => {
    vi.stubEnv("PIM_TIMEZONE", "America/Chicago");
    const s = mockService();
    await call(
      "create_event",
      {
        calendar: "prov/Cal",
        title: "x",
        start: "2026-11-16T09:00:00",
        end: "2026-11-16T10:00:00",
        alarms: [{ type: "absolute", trigger: "2026-11-16T08:30:00" }],
      },
      s,
    );
    expect(String(s.createEvent.mock.calls[0][1])).toContain(
      "TRIGGER;VALUE=DATE-TIME:20261116T143000Z",
    );
  });

  it("asks about a span=future cut in local time", async () => {
    vi.stubEnv("PIM_TIMEZONE", "America/Chicago");
    const s = mockService();
    const master = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:e1",
      "DTSTART;TZID=America/Chicago:20261102T083000",
      "DTEND;TZID=America/Chicago:20261102T093000",
      "RRULE:FREQ=WEEKLY;COUNT=5",
      "SUMMARY:Standup",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    s.getEventWithMeta.mockResolvedValue({
      event: {
        ...EVENT,
        isRecurring: true,
        attendees: [],
        alarms: [],
        categories: [],
        organizer: null,
      },
      meta: { url: "u", etag: "e" },
    });
    s.fetchRawCalendarObject.mockResolvedValue({ data: master, url: "u", etag: "e" });
    const r = await call(
      "delete_event",
      { calendar: "prov/Cal", uid: "e1", span: "future", occurrenceDate: "2026-11-16T08:30:00" },
      s,
    );
    expect(JSON.stringify(r)).toContain("2026-11-16T08:30:00-06:00");
    expect(JSON.stringify(r)).not.toContain("14:30:00.000Z");
  });
});
