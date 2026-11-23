/**
 * Times a caller passes in are read in TZ, the zone results are
 * given in: a date-only range bound is local midnight, and a date-time with
 * no offset is local wall-clock time. Not UTC, and not the host's zone.
 */
import { parseIcsEvents } from "@miguelarios/pim-core/ics";
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
  beforeEach(() => vi.stubEnv("TZ", "America/Chicago"));
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

  it("renders the range and every period in TZ", async () => {
    vi.stubEnv("TZ", "America/Chicago");
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
    vi.stubEnv("TZ", "Not/AZone");
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
  beforeEach(() => vi.stubEnv("TZ", "America/Chicago"));
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
    vi.stubEnv("TZ", "Europe/Berlin");
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
    vi.stubEnv("TZ", "Europe/Berlin");
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
    vi.stubEnv("TZ", "America/Chicago");
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
    vi.stubEnv("TZ", "Asia/Tokyo");
    const s = mockService();
    allDaySeries(s);
    const r = await call(
      "delete_event",
      { calendar: "prov/Cal", uid: "e1", span: "this", occurrenceDate: "2026-11-23T00:00:00" },
      s,
    );
    expect(r.isError).toBeFalsy();
    const ics = String(s.updateEvent.mock.calls[0][2]);
    expect(ics).toMatch(/EXDATE;VALUE=DATE:20261123/);
  });

  it("update_event span=this on an all-day series targets the named day", async () => {
    vi.stubEnv("TZ", "Asia/Tokyo");
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
    expect(String(s.updateEvent.mock.calls[0][2])).toMatch(/RECURRENCE-ID;VALUE=DATE:20261123/);
  });

  it("update_event with allDay: true writes the local date of a timed value", async () => {
    vi.stubEnv("TZ", "America/Chicago");
    const s = mockService();
    allDaySeries(s);
    await call(
      "update_event",
      {
        calendar: "prov/Cal",
        uid: "e1",
        span: "all",
        allDay: true,
        start: "2026-11-16T20:00:00",
        end: "2026-11-17T20:00:00",
      },
      s,
    );
    const ics = String(s.updateEvent.mock.calls[0][2]);
    expect(ics).toMatch(/DTSTART;VALUE=DATE:20261116/);
    expect(ics).toMatch(/DTEND;VALUE=DATE:20261117/);
  });

  it("reads an absolute alarm trigger with no offset in the zone", async () => {
    vi.stubEnv("TZ", "America/Chicago");
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
    vi.stubEnv("TZ", "America/Chicago");
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

describe("update_event switches an all-day event to timed when given a time", () => {
  beforeEach(() => vi.stubEnv("TZ", "America/Chicago"));
  afterEach(() => vi.unstubAllEnvs());

  const ALLDAY = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:e1",
    "DTSTART;VALUE=DATE:20261116",
    "DTEND;VALUE=DATE:20261117",
    "SUMMARY:Dentist",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const ALLDAY_SERIES = ALLDAY.replace(
    "SUMMARY:Dentist",
    "RRULE:FREQ=WEEKLY;COUNT=5\r\nSUMMARY:Dentist",
  );

  function stored(s: ReturnType<typeof mockService>, ics: string, recurring: boolean) {
    s.getEventWithMeta.mockResolvedValue({
      event: {
        ...EVENT,
        allDay: true,
        timeZone: null,
        start: "2026-11-16T00:00:00.000Z",
        end: "2026-11-17T00:00:00.000Z",
        isRecurring: recurring,
        attendees: [],
        alarms: [],
        categories: [],
        organizer: null,
      },
      meta: { url: "u", etag: "e" },
    });
    s.fetchRawCalendarObject.mockResolvedValue({ data: ics, url: "u", etag: "e" });
  }
  const written = (s: ReturnType<typeof mockService>) => String(s.updateEvent.mock.calls[0][2]);

  it("writes a timed event, not a zero-length all-day one", async () => {
    const s = mockService();
    stored(s, ALLDAY, false);
    const r = await call(
      "update_event",
      {
        calendar: "prov/Cal",
        uid: "e1",
        span: "all",
        start: "2026-11-16T14:00:00",
        end: "2026-11-16T15:00:00",
      },
      s,
    );
    expect(r.isError).toBeFalsy();
    expect(written(s)).toContain("DTSTART;TZID=America/Chicago:20261116T140000");
    expect(written(s)).toContain("DTEND;TZID=America/Chicago:20261116T150000");
    expect(written(s)).not.toContain("VALUE=DATE");
  });

  it("does the same for an explicit offset", async () => {
    const s = mockService();
    stored(s, ALLDAY, false);
    await call(
      "update_event",
      {
        calendar: "prov/Cal",
        uid: "e1",
        span: "all",
        start: "2026-11-16T20:00:00Z",
        end: "2026-11-16T21:00:00Z",
      },
      s,
    );
    expect(written(s)).toContain("DTSTART;TZID=America/Chicago:20261116T140000");
  });

  it("moves one occurrence of an all-day series to a time", async () => {
    const s = mockService();
    stored(s, ALLDAY_SERIES, true);
    const r = await call(
      "update_event",
      {
        calendar: "prov/Cal",
        uid: "e1",
        span: "this",
        occurrenceDate: "2026-11-23",
        start: "2026-11-23T14:00:00",
        end: "2026-11-23T15:00:00",
      },
      s,
    );
    expect(r.isError).toBeFalsy();
    const ics = written(s);
    // The slot stays a date (it is the series'), the override is timed.
    expect(ics).toContain("RECURRENCE-ID;VALUE=DATE:20261123");
    expect(ics).toContain("DTSTART:20261123T200000Z");
    expect(r.structuredContent.event).toMatchObject({
      allDay: false,
      start: "2026-11-23T14:00:00-06:00",
      occurrenceDate: "2026-11-23",
    });
  });

  it("moves an all-day event given only a timed start, keeping it all-day and its length", async () => {
    const s = mockService();
    stored(s, ALLDAY, false);
    const r = await call(
      "update_event",
      { calendar: "prov/Cal", uid: "e1", span: "all", start: "2026-11-18T14:00:00" },
      s,
    );
    expect(r.isError).toBeFalsy();
    expect(written(s)).toContain("DTSTART;VALUE=DATE:20261118");
    expect(written(s)).toContain("DTEND;VALUE=DATE:20261119");
  });

  it("keeps an explicit allDay: true, reducing the times to their local dates", async () => {
    const s = mockService();
    stored(s, ALLDAY, false);
    await call(
      "update_event",
      {
        calendar: "prov/Cal",
        uid: "e1",
        span: "all",
        allDay: true,
        start: "2026-11-18T14:00:00",
        end: "2026-11-19T14:00:00",
      },
      s,
    );
    expect(written(s)).toContain("DTSTART;VALUE=DATE:20261118");
    expect(written(s)).toContain("DTEND;VALUE=DATE:20261119");
  });

  it("keeps an all-day event all-day when given plain dates", async () => {
    const s = mockService();
    stored(s, ALLDAY, false);
    await call(
      "update_event",
      { calendar: "prov/Cal", uid: "e1", span: "all", start: "2026-11-18", end: "2026-11-19" },
      s,
    );
    expect(written(s)).toContain("DTSTART;VALUE=DATE:20261118");
  });
});

describe("update_event all-day → timed, limits (#168 review)", () => {
  beforeEach(() => vi.stubEnv("TZ", "America/Chicago"));
  afterEach(() => vi.unstubAllEnvs());

  const SERIES = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:e1",
    "DTSTART;VALUE=DATE:20261116",
    "DTEND;VALUE=DATE:20261117",
    "RRULE:FREQ=WEEKLY;UNTIL=20261214",
    "EXDATE;VALUE=DATE:20261130",
    "SUMMARY:Gym",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const ONE_OFF = SERIES.replace(
    "RRULE:FREQ=WEEKLY;UNTIL=20261214\r\nEXDATE;VALUE=DATE:20261130\r\n",
    "",
  );

  function stored(s: ReturnType<typeof mockService>, ics: string, recurring: boolean) {
    s.getEventWithMeta.mockResolvedValue({
      event: {
        ...EVENT,
        allDay: true,
        timeZone: null,
        start: "2026-11-16T00:00:00.000Z",
        end: "2026-11-17T00:00:00.000Z",
        isRecurring: recurring,
        attendees: [],
        alarms: [],
        categories: [],
        organizer: null,
      },
      meta: { url: "u", etag: "e" },
    });
    s.fetchRawCalendarObject.mockResolvedValue({ data: ics, url: "u", etag: "e" });
  }
  const written = (s: ReturnType<typeof mockService>) =>
    String(s.updateEvent.mock.calls[0]?.[2] ?? "");

  it("makes a whole all-day series timed for span all, converting its exclusions and UNTIL", async () => {
    const s = mockService();
    stored(s, SERIES, true);
    const r = await call(
      "update_event",
      {
        calendar: "prov/Cal",
        uid: "e1",
        span: "all",
        start: "2026-11-16T14:00:00",
        end: "2026-11-16T15:00:00",
      },
      s,
    );
    expect(r.isError).toBeFalsy();
    const ics = written(s);
    expect(ics).toContain("DTSTART;TZID=America/Chicago:20261116T140000");
    expect(ics).toContain("EXDATE;TZID=America/Chicago:20261130T140000");
    expect(ics).toContain("RRULE:FREQ=WEEKLY;UNTIL=20261214T200000Z");
    // Every remaining occurrence, the last included, at 14:00 Chicago.
    const occ = parseIcsEvents(ics, { start: "2026-11-01T00:00:00Z", end: "2027-01-01T00:00:00Z" });
    expect(occ.map((e) => e.start)).toEqual([
      "2026-11-16T20:00:00.000Z",
      "2026-11-23T20:00:00.000Z",
      "2026-12-07T20:00:00.000Z",
      "2026-12-14T20:00:00.000Z",
    ]);
  });

  it("makes the rest of an all-day series timed for span future", async () => {
    const s = mockService();
    stored(s, SERIES, true);
    const r = await call(
      "update_event",
      {
        calendar: "prov/Cal",
        uid: "e1",
        span: "future",
        occurrenceDate: "2026-12-07",
        start: "2026-12-07T14:00:00",
        end: "2026-12-07T15:00:00",
      },
      s,
    );
    expect(r.isError).toBeFalsy();
    const tail = String(s.createEvent.mock.calls[0][1]);
    expect(tail).toContain("DTSTART;TZID=America/Chicago:20261207T140000");
    expect(tail).toMatch(/RRULE:FREQ=WEEKLY;UNTIL=20261214T200000Z/);
    const occ = parseIcsEvents(tail, {
      start: "2026-11-01T00:00:00Z",
      end: "2027-01-01T00:00:00Z",
    });
    expect(occ.map((e) => e.start)).toEqual([
      "2026-12-07T20:00:00.000Z",
      "2026-12-14T20:00:00.000Z",
    ]);
    // The earlier part stays all-day, ending before the cut.
    expect(String(s.updateEvent.mock.calls[0][2])).toContain("DTSTART;VALUE=DATE:20261116");
  });

  it("reads a plain date mixed with a time as local midnight", async () => {
    const s = mockService();
    stored(s, ONE_OFF, false);
    const r = await call(
      "update_event",
      {
        calendar: "prov/Cal",
        uid: "e1",
        span: "all",
        start: "2026-11-16",
        end: "2026-11-16T15:00:00",
      },
      s,
    );
    expect(r.isError).toBeFalsy();
    expect(written(s)).toContain("DTSTART;TZID=America/Chicago:20261116T000000");
    expect(written(s)).toContain("DTEND;TZID=America/Chicago:20261116T150000");
  });

  it("rejects an end before the start rather than write it", async () => {
    const s = mockService();
    stored(s, ONE_OFF, false);
    const r = await call(
      "update_event",
      {
        calendar: "prov/Cal",
        uid: "e1",
        span: "all",
        start: "2026-11-16T14:00:00",
        end: "2026-11-16",
      },
      s,
    );
    expect(r.isError).toBe(true);
    expect(s.updateEvent).not.toHaveBeenCalled();
  });
});

describe("update_event keeps an event in its own time zone", () => {
  beforeEach(() => vi.stubEnv("TZ", "America/Chicago"));
  afterEach(() => vi.unstubAllEnvs());

  const stored = (s: ReturnType<typeof mockService>, ics: string, timeZone: string | null) => {
    s.getEventWithMeta.mockResolvedValue({
      event: {
        ...EVENT,
        timeZone,
        isRecurring: ics.includes("RRULE"),
        attendees: [],
        alarms: [],
        categories: [],
        organizer: null,
      },
      meta: { url: "u", etag: "e" },
    });
    s.fetchRawCalendarObject.mockResolvedValue({ data: ics, url: "u", etag: "e" });
  };
  const event = (start: string, end: string, extra = "") =>
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:e1",
      start,
      end,
      extra,
      "SUMMARY:x",
      "END:VEVENT",
      "END:VCALENDAR",
    ]
      .filter(Boolean)
      .join("\r\n");
  const written = (s: ReturnType<typeof mockService>) => String(s.updateEvent.mock.calls[0][2]);

  it("moves a London series in London time, so both countries' DST changes don't shift it", async () => {
    const s = mockService();
    stored(
      s,
      event(
        "DTSTART;TZID=Europe/London:20270301T090000",
        "DTEND;TZID=Europe/London:20270301T100000",
        "RRULE:FREQ=WEEKLY;COUNT=6",
      ),
      "Europe/London",
    );
    // 03:30 Chicago on Mar 1 is 09:30 London.
    await call(
      "update_event",
      {
        calendar: "prov/Cal",
        uid: "e1",
        span: "all",
        start: "2027-03-01T03:30:00",
        end: "2027-03-01T04:30:00",
      },
      s,
    );
    const ics = written(s);
    expect(ics).toContain("DTSTART;TZID=Europe/London:20270301T093000");
    expect(ics).toContain("DTEND;TZID=Europe/London:20270301T103000");
    const london = parseIcsEvents(ics, {
      start: "2027-02-01T00:00:00Z",
      end: "2027-05-01T00:00:00Z",
    }).map((e) =>
      new Date(e.start).toLocaleTimeString("en-GB", {
        timeZone: "Europe/London",
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
    expect(london).toEqual(["09:30", "09:30", "09:30", "09:30", "09:30", "09:30"]);
  });

  it("keeps a UTC event in UTC", async () => {
    const s = mockService();
    stored(s, event("DTSTART:20261116T140000Z", "DTEND:20261116T150000Z"), "UTC");
    await call(
      "update_event",
      {
        calendar: "prov/Cal",
        uid: "e1",
        span: "all",
        start: "2026-11-16T09:00:00",
        end: "2026-11-16T10:00:00",
      },
      s,
    );
    expect(written(s)).toContain("DTSTART:20261116T150000Z");
  });

  it("still uses your zone for an event that has none (floating)", async () => {
    const s = mockService();
    stored(s, event("DTSTART:20261116T090000", "DTEND:20261116T100000"), null);
    await call(
      "update_event",
      {
        calendar: "prov/Cal",
        uid: "e1",
        span: "all",
        start: "2026-11-16T10:00:00",
        end: "2026-11-16T11:00:00",
      },
      s,
    );
    expect(written(s)).toContain("DTSTART;TZID=America/Chicago:20261116T100000");
  });
});

describe("update_event keeps only a zone it can resolve (#176 review)", () => {
  beforeEach(() => vi.stubEnv("TZ", "America/Chicago"));
  afterEach(() => vi.unstubAllEnvs());

  const vtimezone = (tzid: string) =>
    [
      "BEGIN:VTIMEZONE",
      `TZID:${tzid}`,
      "BEGIN:STANDARD",
      "DTSTART:16011104T020000",
      "RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=11",
      "TZOFFSETFROM:-0500",
      "TZOFFSETTO:-0600",
      "END:STANDARD",
      "BEGIN:DAYLIGHT",
      "DTSTART:16010311T020000",
      "RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3",
      "TZOFFSETFROM:-0600",
      "TZOFFSETTO:-0500",
      "END:DAYLIGHT",
      "END:VTIMEZONE",
    ].join("\r\n");
  const ics = (tzid: string, withDefinition: boolean, extra = "") =>
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      ...(withDefinition ? [vtimezone(tzid)] : []),
      "BEGIN:VEVENT",
      "UID:e1",
      `DTSTART;TZID=${tzid}:20270104T090000`,
      `DTEND;TZID=${tzid}:20270104T100000`,
      "RRULE:FREQ=WEEKLY;COUNT=20",
      extra,
      "SUMMARY:x",
      "END:VEVENT",
      "END:VCALENDAR",
    ]
      .filter(Boolean)
      .join("\r\n");
  const store = (s: ReturnType<typeof mockService>, data: string, timeZone: string) => {
    s.getEventWithMeta.mockResolvedValue({
      event: {
        ...EVENT,
        timeZone,
        isRecurring: true,
        attendees: [],
        alarms: [],
        categories: [],
        organizer: null,
      },
      meta: { url: "u", etag: "e" },
    });
    s.fetchRawCalendarObject.mockResolvedValue({ data, url: "u", etag: "e" });
  };
  /** Every occurrence's local Chicago hour after the series is moved to 10:00 Chicago. */
  const hoursAfterMove = async (data: string, timeZone: string) => {
    const s = mockService();
    store(s, data, timeZone);
    await call(
      "update_event",
      {
        calendar: "prov/Cal",
        uid: "e1",
        span: "all",
        start: "2027-01-04T10:00:00",
        end: "2027-01-04T11:00:00",
      },
      s,
    );
    const written = String(s.updateEvent.mock.calls[0][2]);
    // Parsed as the service does: floating times (an unknown zone) in TZ.
    const occ = parseIcsEvents(
      written,
      { start: "2027-01-01T00:00:00Z", end: "2027-06-01T00:00:00Z" },
      "America/Chicago",
    );
    return {
      written,
      hours: [
        ...new Set(
          occ.map((e) =>
            new Date(e.start).toLocaleTimeString("en-US", {
              timeZone: "America/Chicago",
              hour: "numeric",
            }),
          ),
        ),
      ],
      count: occ.length,
    };
  };

  it("falls back to TZ for an Outlook zone name, keeping 10:00 through DST", async () => {
    const { written, hours } = await hoursAfterMove(
      ics("Central Standard Time", true),
      "Central Standard Time",
    );
    expect(written).toContain("DTSTART;TZID=America/Chicago:20270104T100000");
    expect(hours).toEqual(["10 AM"]);
  });

  it("falls back to TZ for a custom zone the server has no name for", async () => {
    const { hours } = await hoursAfterMove(
      ics("Customized Time Zone", true),
      "Customized Time Zone",
    );
    expect(hours).toEqual(["10 AM"]);
  });

  it("falls back to TZ for an unknown zone, keeping its exclusions", async () => {
    const { hours, count } = await hoursAfterMove(
      ics("Foo/Bar", false, "EXDATE;TZID=Foo/Bar:20270322T090000"),
      "Foo/Bar",
    );
    expect(hours).toEqual(["10 AM"]);
    expect(count).toBe(19); // 20 minus the excluded Mar 22
  });

  it("falls back to TZ for a zone the bundled data lacks (Europe/Kyiv) or gets wrong (EST)", async () => {
    for (const zone of ["Europe/Kyiv", "EST"]) {
      const { written, hours } = await hoursAfterMove(ics(zone, false), zone);
      expect(written, zone).toContain("DTSTART;TZID=America/Chicago:20270104T100000");
      expect(hours, zone).toEqual(["10 AM"]);
    }
  });

  it("keeps an Etc/UTC event in UTC, as a plain Z time", async () => {
    const s = mockService();
    store(s, ics("Etc/UTC", false), "Etc/UTC");
    await call(
      "update_event",
      {
        calendar: "prov/Cal",
        uid: "e1",
        span: "all",
        start: "2027-01-04T10:00:00",
        end: "2027-01-04T11:00:00",
      },
      s,
    );
    expect(String(s.updateEvent.mock.calls[0][2])).toContain("DTSTART:20270104T160000Z");
  });

  it("keeps a custom-zone series' exclusions on span=future", async () => {
    const s = mockService();
    store(
      s,
      ics(
        "Customized Time Zone",
        true,
        [
          "EXDATE;TZID=Customized Time Zone:20270308T090000",
          "EXDATE;TZID=Customized Time Zone:20270503T090000",
          "EXDATE:20270510T140000Z",
        ].join("\r\n"),
      ).replace("COUNT=20", "COUNT=30"),
      "Customized Time Zone",
    );
    const r = await call(
      "update_event",
      {
        calendar: "prov/Cal",
        uid: "e1",
        span: "future",
        occurrenceDate: "2027-03-01T15:00:00.000Z",
        start: "2027-03-01T10:00:00",
        end: "2027-03-01T11:00:00",
      },
      s,
    );
    expect(r.isError).toBeFalsy();
    const tail = String(s.createEvent.mock.calls[0][1]);
    const occ = parseIcsEvents(
      tail,
      { start: "2027-01-01T00:00:00Z", end: "2028-01-01T00:00:00Z" },
      "America/Chicago",
    );
    const days = occ.map((e) =>
      new Date(e.start).toLocaleDateString("en-CA", { timeZone: "America/Chicago" }),
    );
    for (const excluded of ["2027-03-08", "2027-05-03", "2027-05-10"])
      expect(days).not.toContain(excluded);
    const hours = new Set(
      occ.map((e) =>
        new Date(e.start).toLocaleTimeString("en-US", {
          timeZone: "America/Chicago",
          hour: "numeric",
        }),
      ),
    );
    expect([...hours]).toEqual(["10 AM"]);
  });

  it("writes a TZID=UTC event as a plain UTC time", async () => {
    const s = mockService();
    store(s, ics("UTC", false), "UTC");
    await call(
      "update_event",
      {
        calendar: "prov/Cal",
        uid: "e1",
        span: "all",
        start: "2027-01-04T10:00:00",
        end: "2027-01-04T11:00:00",
      },
      s,
    );
    const written = String(s.updateEvent.mock.calls[0][2]);
    expect(written).toContain("DTSTART:20270104T160000Z");
    expect(written).not.toContain("TZID=UTC");
  });
});
