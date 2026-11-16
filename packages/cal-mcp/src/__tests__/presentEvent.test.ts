import { dispatchTool } from "@miguelarios/pim-core/mcp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CALENDAR_TOOLS } from "../tools/calendarTools.js";
import { presentEvent } from "../tools/presentEvent.js";

const timed = {
  uid: "a",
  calendarId: "caldav/Personal",
  title: "Flight",
  start: "2026-11-16T14:30:00.000Z",
  end: "2026-11-16T15:30:00.000Z",
  allDay: false,
  timeZone: "America/Chicago",
  location: null,
  status: null,
  isRecurring: false,
  occurrenceDate: null,
};

const allDay = {
  ...timed,
  uid: "b",
  title: "Holiday",
  start: "2026-11-16T00:00:00.000Z",
  end: "2026-11-17T00:00:00.000Z",
  allDay: true,
  timeZone: null,
};

describe("presentEvent", () => {
  it("renders a timed event in the configured zone, with its offset", () => {
    const out = presentEvent(timed, "America/Chicago");
    expect(out.start).toBe("2026-11-16T08:30:00-06:00");
    expect(out.end).toBe("2026-11-16T09:30:00-06:00");
    expect(out.timeZone).toBe("America/Chicago");
    // Same instant as before: nothing a client parses changes meaning.
    expect(Date.parse(out.start)).toBe(Date.parse(timed.start));
  });

  it("follows daylight saving per occurrence", () => {
    const summer = { ...timed, start: "2026-07-16T13:30:00.000Z", end: "2026-07-16T14:30:00.000Z" };
    expect(presentEvent(summer, "America/Chicago").start).toBe("2026-07-16T08:30:00-05:00");
  });

  it("renders an all-day event as plain dates, never as a previous-evening time", () => {
    const out = presentEvent(allDay, "America/Chicago");
    expect(out.start).toBe("2026-11-16");
    expect(out.end).toBe("2026-11-17");
  });

  it("renders occurrenceDate the way the series is: date for all-day, local time otherwise", () => {
    expect(
      presentEvent(
        { ...allDay, isRecurring: true, occurrenceDate: "2026-11-16T00:00:00.000Z" },
        "America/Chicago",
      ).occurrenceDate,
    ).toBe("2026-11-16");
    expect(
      presentEvent(
        { ...timed, isRecurring: true, occurrenceDate: "2026-11-16T14:30:00.000Z" },
        "America/Chicago",
      ).occurrenceDate,
    ).toBe("2026-11-16T08:30:00-06:00");
  });

  it("leaves a value it cannot parse untouched", () => {
    expect(presentEvent({ ...timed, start: "garbage" }, "America/Chicago").start).toBe("garbage");
  });
});

describe("event tools render times in PIM_TIMEZONE", () => {
  const service = {
    listCalendars: vi.fn(async () => [{ calendarId: "caldav/Personal" }]),
    listReachableCalendars: vi.fn(async () => ({
      calendars: [{ calendarId: "caldav/Personal" }],
      unavailable: [],
    })),
    listEvents: vi.fn(async () => [timed, allDay]),
    getEvent: vi.fn(async () => ({ ...timed })),
  };

  beforeEach(() => {
    vi.stubEnv("PIM_TIMEZONE", "America/Chicago");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("list_events", async () => {
    const result = (await dispatchTool(
      CALENDAR_TOOLS,
      "list_events",
      { start: "2026-11-16T00:00:00Z", end: "2026-11-17T00:00:00Z" },
      service as never,
    )) as { structuredContent: { events: Array<{ start: string; timeZone: string | null }> } };
    expect(result.structuredContent.events.map((e) => [e.start, e.timeZone])).toEqual([
      ["2026-11-16T08:30:00-06:00", "America/Chicago"],
      ["2026-11-16", null],
    ]);
  });

  it("get_event", async () => {
    const result = (await dispatchTool(
      CALENDAR_TOOLS,
      "get_event",
      { calendar: "caldav/Personal", uid: "a" },
      service as never,
    )) as { structuredContent: { event: { start: string } } };
    expect(result.structuredContent.event.start).toBe("2026-11-16T08:30:00-06:00");
  });
});
