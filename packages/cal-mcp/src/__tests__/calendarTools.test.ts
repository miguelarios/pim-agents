import { beforeEach, describe, expect, it, vi } from "vitest";
import { CALENDAR_TOOLS, handleCalendarTool } from "../tools/calendarTools.js";

const mockService = {
  listCalendars: vi.fn(),
  listEvents: vi.fn(),
  listEventsFull: vi.fn(),
  getEvent: vi.fn(),
  getEventWithMeta: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  moveEvent: vi.fn(),
  findFreeSlots: vi.fn(),
  fetchRawCalendarObject: vi.fn(),
  getAccountEmail: vi.fn(() => "user@example.com"),
};

describe("calendarTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports 12 tool definitions", () => {
    expect(CALENDAR_TOOLS).toHaveLength(12);
    const names = CALENDAR_TOOLS.map((t) => t.name);
    expect(names).toContain("list_calendars");
    expect(names).toContain("list_events");
    expect(names).toContain("get_today_events");
    expect(names).toContain("search_events");
    expect(names).toContain("get_event");
    expect(names).toContain("create_event");
    expect(names).toContain("update_event");
    expect(names).toContain("move_event");
    expect(names).toContain("delete_event");
    expect(names).toContain("create_events_batch");
    expect(names).toContain("import_ics");
    expect(names).toContain("find_free_slots");
  });

  it("read-only tools carry readOnlyHint; destructive tools carry destructiveHint", () => {
    const byName = Object.fromEntries(CALENDAR_TOOLS.map((t) => [t.name, t as any]));
    for (const name of [
      "list_calendars",
      "list_events",
      "get_today_events",
      "search_events",
      "get_event",
      "find_free_slots",
    ]) {
      expect(byName[name].annotations?.readOnlyHint, name).toBe(true);
    }
    expect(byName.delete_event.annotations?.destructiveHint).toBe(true);
    expect(byName.create_event.annotations?.readOnlyHint).toBeFalsy();
  });

  it("create_event schema uses title not summary", () => {
    const tool = CALENDAR_TOOLS.find((t) => t.name === "create_event")!;
    const props = (tool.inputSchema as any).properties;
    expect(props.title).toBeDefined();
    expect(props.summary).toBeUndefined();
    expect(props.all_day).toBeDefined();
    expect((tool.inputSchema as any).required).toContain("title");
  });

  it("import_ics schema uses ics_content not icsContent", () => {
    const tool = CALENDAR_TOOLS.find((t) => t.name === "import_ics")!;
    const props = (tool.inputSchema as any).properties;
    expect(props.ics_content).toBeDefined();
    expect(props.icsContent).toBeUndefined();
  });

  it("import_ics PUTs one object per UID and reports unique-UID count", async () => {
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

    mockService.createEvent.mockResolvedValue({ uid: "x" });
    mockService.getEvent.mockResolvedValue({ uid: "x" });

    const result = await handleCalendarTool(
      "import_ics",
      { calendar: "mailbox/PIM-Test", ics_content: MULTI },
      mockService as any,
    );

    expect(mockService.createEvent).toHaveBeenCalledTimes(2); // a-1 and b-2, not 1
    const payload = JSON.parse(result.content[0].text);
    expect(payload.imported).toBe(2); // unique UIDs, not 3 ParsedEvents
  });

  it("find_free_slots schema has new params", () => {
    const tool = CALENDAR_TOOLS.find((t) => t.name === "find_free_slots")!;
    const props = (tool.inputSchema as any).properties;
    expect(props.preferred_start).toBeDefined();
    expect(props.preferred_end).toBeDefined();
    expect(props.exclude_calendars).toBeDefined();
    expect(props.include_all_day_as_busy).toBeDefined();
    expect(props.ignore_tentative).toBeDefined();
    // calendars is optional
    expect((tool.inputSchema as any).required).not.toContain("calendars");
  });

  it("list_events schema has detail_level and optional calendar", () => {
    const tool = CALENDAR_TOOLS.find((t) => t.name === "list_events")!;
    const props = (tool.inputSchema as any).properties;
    expect(props.detail_level).toBeDefined();
    expect((tool.inputSchema as any).required).toEqual(["start", "end"]);
  });

  it("create_event schema includes alarms and categories params", () => {
    const tool = CALENDAR_TOOLS.find((t) => t.name === "create_event")!;
    const props = (tool.inputSchema as any).properties;
    expect(props.alarms).toBeDefined();
    expect(props.categories).toBeDefined();
  });

  it("update_event schema includes alarms and categories params", () => {
    const tool = CALENDAR_TOOLS.find((t) => t.name === "update_event")!;
    const props = (tool.inputSchema as any).properties;
    expect(props.alarms).toBeDefined();
    expect(props.categories).toBeDefined();
  });

  it("create_events_batch schema includes alarms and categories in event items", () => {
    const tool = CALENDAR_TOOLS.find((t) => t.name === "create_events_batch")!;
    const eventProps = (tool.inputSchema as any).properties.events.items.properties;
    expect(eventProps.alarms).toBeDefined();
    expect(eventProps.categories).toBeDefined();
  });

  describe("handleCalendarTool", () => {
    it("list_calendars wraps in { calendars } envelope", async () => {
      mockService.listCalendars.mockResolvedValue([
        {
          calendar_id: "mailbox/Work",
          display_name: "Work",
          color: null,
          source: "mailbox",
          read_only: false,
        },
      ]);

      const result = await handleCalendarTool("list_calendars", {}, mockService as any);
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.calendars).toHaveLength(1);
      expect(parsed.calendars[0].calendar_id).toBe("mailbox/Work");
    });

    it("list_events wraps in { events } envelope", async () => {
      mockService.listEvents.mockResolvedValue([
        { uid: "evt-1", calendar_id: "mailbox/Work", title: "Meeting" },
      ]);

      const result = await handleCalendarTool(
        "list_events",
        { calendar: "mailbox/Work", start: "2026-03-10T00:00:00Z", end: "2026-03-10T23:59:59Z" },
        mockService as any,
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.events).toHaveLength(1);
      expect(parsed.events[0].title).toBe("Meeting");
    });

    it("get_event wraps in { event } envelope", async () => {
      mockService.getEvent.mockResolvedValue({ uid: "evt-1", title: "Meeting" });

      const result = await handleCalendarTool(
        "get_event",
        { calendar: "mailbox/Work", uid: "evt-1" },
        mockService as any,
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.event.uid).toBe("evt-1");
    });

    it("create_event uses title param and wraps in { event } envelope", async () => {
      mockService.createEvent.mockResolvedValue({ uid: "new-1", title: "New Event" });

      const result = await handleCalendarTool(
        "create_event",
        {
          calendar: "mailbox/Work",
          title: "New Event",
          start: "2026-03-10T14:00:00Z",
          end: "2026-03-10T15:00:00Z",
        },
        mockService as any,
      );

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.event.uid).toBe("new-1");
    });

    it("move_event schema requires target_calendar", () => {
      const tool = CALENDAR_TOOLS.find((t) => t.name === "move_event")!;
      const props = (tool.inputSchema as any).properties;
      expect(props.calendar).toBeDefined();
      expect(props.uid).toBeDefined();
      expect(props.target_calendar).toBeDefined();
      expect((tool.inputSchema as any).required).toEqual(["calendar", "uid", "target_calendar"]);
    });

    it("move_event returns { event } envelope", async () => {
      mockService.getEventWithMeta.mockResolvedValue({
        event: { uid: "evt-1", title: "Meeting" },
        meta: { url: "/cal/evt-1.ics", etag: '"e1"' },
      });
      mockService.moveEvent.mockResolvedValue({ uid: "evt-1", calendar_id: "mailbox/Personal" });

      const result = await handleCalendarTool(
        "move_event",
        {
          calendar: "mailbox/Work",
          uid: "evt-1",
          target_calendar: "mailbox/Personal",
        },
        mockService as any,
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.event.uid).toBe("evt-1");
      expect(mockService.moveEvent).toHaveBeenCalledWith(
        "mailbox/Work",
        "evt-1",
        "mailbox/Personal",
        { url: "/cal/evt-1.ics", etag: '"e1"' },
      );
    });

    it("delete_event returns { deleted, uid } envelope", async () => {
      mockService.deleteEvent.mockResolvedValue(undefined);

      const result = await handleCalendarTool(
        "delete_event",
        { calendar: "mailbox/Work", uid: "evt-1" },
        mockService as any,
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.deleted).toBe(true);
      expect(parsed.uid).toBe("evt-1");
    });

    it("returns structured error for unknown tool", async () => {
      const result = await handleCalendarTool("unknown_tool", {}, mockService as any);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBeDefined();
      expect(parsed.message).toBeDefined();
    });

    it("returns structured error with error code on service failure", async () => {
      mockService.listCalendars.mockRejectedValue(new Error("Connection failed"));

      const result = await handleCalendarTool("list_calendars", {}, mockService as any);
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toBe("backend_error");
      expect(parsed.message).toContain("Connection failed");
    });

    it("update_event schema has occurrence_date and span enum without future", () => {
      const tool = CALENDAR_TOOLS.find((t) => t.name === "update_event")!;
      const props = (tool.inputSchema as any).properties;
      expect(props.occurrence_date).toBeDefined();
      expect(props.span.enum).toEqual(["this", "all"]);
    });

    it("delete_event schema has occurrence_date and span enum without future", () => {
      const tool = CALENDAR_TOOLS.find((t) => t.name === "delete_event")!;
      const props = (tool.inputSchema as any).properties;
      expect(props.occurrence_date).toBeDefined();
      expect(props.span.enum).toEqual(["this", "all"]);
    });

    it("update_event succeeds with span this on non-recurring event", async () => {
      mockService.getEventWithMeta.mockResolvedValue({
        event: {
          uid: "evt-1",
          title: "Meeting",
          is_recurring: false,
          recurrence_rule: null,
          start: "2026-03-10T14:00:00Z",
          end: "2026-03-10T15:00:00Z",
          all_day: false,
          location: null,
          description: null,
          attendees: [],
        },
        meta: { url: "/cal/evt-1.ics", etag: '"e1"' },
      });
      mockService.fetchRawCalendarObject.mockResolvedValue({
        data: [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "BEGIN:VEVENT",
          "UID:evt-1",
          "DTSTAMP:20260301T000000Z",
          "DTSTART:20260310T140000Z",
          "DTEND:20260310T150000Z",
          "SUMMARY:Meeting",
          "END:VEVENT",
          "END:VCALENDAR",
        ].join("\r\n"),
        url: "/cal/evt-1.ics",
        etag: '"e1"',
      });
      mockService.updateEvent.mockResolvedValue({
        uid: "evt-1",
        title: "Updated Meeting",
        is_recurring: false,
      });

      const result = await handleCalendarTool(
        "update_event",
        { calendar: "mailbox/Work", uid: "evt-1", title: "Updated Meeting" },
        mockService as any,
      );

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.event.title).toBe("Updated Meeting");
    });

    it("create_event passes alarms and categories to generateEventIcs", async () => {
      mockService.createEvent.mockResolvedValue({
        uid: "new-1",
        title: "Event with Alarm",
        alarms: [{ type: "relative", trigger: -900, trigger_human: "15 minutes before" }],
        categories: ["Work"],
      });

      const result = await handleCalendarTool(
        "create_event",
        {
          calendar: "mailbox/Work",
          title: "Event with Alarm",
          start: "2026-03-10T14:00:00Z",
          end: "2026-03-10T15:00:00Z",
          alarms: [{ type: "relative", trigger: -900 }],
          categories: ["Work"],
        },
        mockService as any,
      );

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.event.alarms).toHaveLength(1);
      expect(parsed.event.categories).toEqual(["Work"]);
    });

    it("update_event preserves existing alarms when not provided", async () => {
      mockService.getEventWithMeta.mockResolvedValue({
        event: {
          uid: "evt-1",
          title: "Meeting",
          is_recurring: false,
          recurrence_rule: null,
          start: "2026-03-10T14:00:00Z",
          end: "2026-03-10T15:00:00Z",
          all_day: false,
          location: null,
          description: null,
          attendees: [],
          alarms: [{ type: "relative", trigger: -900, trigger_human: "15 minutes before" }],
          categories: ["Meeting"],
        },
        meta: { url: "/cal/evt-1.ics", etag: '"e1"' },
      });
      mockService.fetchRawCalendarObject.mockResolvedValue({
        data: [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "BEGIN:VEVENT",
          "UID:evt-1",
          "DTSTAMP:20260301T000000Z",
          "DTSTART:20260310T140000Z",
          "DTEND:20260310T150000Z",
          "SUMMARY:Meeting",
          "CATEGORIES:Meeting",
          "BEGIN:VALARM",
          "ACTION:DISPLAY",
          "DESCRIPTION:Reminder",
          "TRIGGER:-PT15M",
          "END:VALARM",
          "END:VEVENT",
          "END:VCALENDAR",
        ].join("\r\n"),
        url: "/cal/evt-1.ics",
        etag: '"e1"',
      });
      mockService.updateEvent.mockResolvedValue({
        uid: "evt-1",
        title: "Updated Meeting",
        alarms: [{ type: "relative", trigger: -900, trigger_human: "15 minutes before" }],
        categories: ["Meeting"],
      });

      const result = await handleCalendarTool(
        "update_event",
        { calendar: "mailbox/Work", uid: "evt-1", title: "Updated Meeting" },
        mockService as any,
      );

      expect(result.isError).toBeUndefined();
    });

    it("list_calendars handler passes through read_only field", async () => {
      mockService.listCalendars.mockResolvedValue([
        {
          calendar_id: "mailbox/Work",
          display_name: "Work",
          color: null,
          source: "mailbox",
          read_only: false,
        },
        {
          calendar_id: "mailbox/Holidays",
          display_name: "Holidays",
          color: null,
          source: "mailbox",
          read_only: true,
        },
      ]);

      const result = await handleCalendarTool("list_calendars", {}, mockService as any);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.calendars[0].read_only).toBe(false);
      expect(parsed.calendars[1].read_only).toBe(true);
    });

    it("find_free_slots wraps in { slots, count } envelope", async () => {
      mockService.listCalendars.mockResolvedValue([{ calendar_id: "mailbox/Work" }]);
      mockService.findFreeSlots.mockResolvedValue([
        { start: "2026-03-10T10:00:00Z", end: "2026-03-10T12:00:00Z", duration: 120 },
      ]);

      const result = await handleCalendarTool(
        "find_free_slots",
        { start: "2026-03-10T08:00:00Z", end: "2026-03-10T17:00:00Z", duration: 30 },
        mockService as any,
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.slots).toHaveLength(1);
      expect(parsed.count).toBe(1);
    });

    const fullEventFixture = (overrides: Record<string, unknown> = {}) => ({
      uid: "weekly",
      calendar_id: "prov/Cal",
      title: "Standup",
      start: "2026-03-05T10:00:00Z",
      end: "2026-03-05T11:00:00Z",
      all_day: false,
      is_recurring: true,
      occurrence_date: "2026-03-05T10:00:00Z",
      location: null,
      description: "Weekly standup meeting",
      attendees: [],
      alarms: [],
      categories: [],
      geo: null,
      organizer: null,
      status: null,
      availability: null,
      url: null,
      created: null,
      last_modified: null,
      recurrence_rule: "FREQ=WEEKLY;COUNT=52",
      ...overrides,
    });

    it("list_events detail_level=full fetches full events in one call (no per-event getEvent)", async () => {
      mockService.listEventsFull.mockResolvedValueOnce([fullEventFixture()]);

      const result = await handleCalendarTool(
        "list_events",
        { start: "2026-03-01", end: "2026-03-31", calendar: "prov/Cal", detail_level: "full" },
        mockService as any,
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.events[0].occurrence_date).toBe("2026-03-05T10:00:00Z");
      expect(parsed.events[0].start).toBe("2026-03-05T10:00:00Z");
      expect(parsed.events[0].end).toBe("2026-03-05T11:00:00Z");
      expect(parsed.events[0].description).toBe("Weekly standup meeting");
      expect(mockService.getEvent).not.toHaveBeenCalled();
      expect(mockService.listEventsFull).toHaveBeenCalledTimes(1);
    });

    it("list_events detail_level=full across all calendars fetches in parallel", async () => {
      mockService.listCalendars.mockResolvedValueOnce([
        { calendar_id: "prov/A" },
        { calendar_id: "prov/B" },
      ]);
      mockService.listEventsFull
        .mockResolvedValueOnce([fullEventFixture({ uid: "a", calendar_id: "prov/A" })])
        .mockResolvedValueOnce([fullEventFixture({ uid: "b", calendar_id: "prov/B" })]);

      const result = await handleCalendarTool(
        "list_events",
        { start: "2026-03-01", end: "2026-03-31", detail_level: "full" },
        mockService as any,
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.events.map((e: { uid: string }) => e.uid).sort()).toEqual(["a", "b"]);
      expect(mockService.listEventsFull).toHaveBeenCalledTimes(2);
      expect(mockService.listEvents).not.toHaveBeenCalled();
      expect(mockService.getEvent).not.toHaveBeenCalled();
    });

    it("get_today_events detail_level=full uses listEventsFull", async () => {
      mockService.listCalendars.mockResolvedValueOnce([{ calendar_id: "prov/Cal" }]);
      mockService.listEventsFull.mockResolvedValueOnce([
        fullEventFixture({
          uid: "daily",
          start: "2026-03-28T09:00:00Z",
          end: "2026-03-28T09:30:00Z",
          occurrence_date: "2026-03-28T09:00:00Z",
          description: "Daily standup",
        }),
      ]);

      const result = await handleCalendarTool(
        "get_today_events",
        { detail_level: "full" },
        mockService as any,
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.events[0].occurrence_date).toBe("2026-03-28T09:00:00Z");
      expect(parsed.events[0].description).toBe("Daily standup");
      expect(mockService.getEvent).not.toHaveBeenCalled();
    });

    it("get_today_events computes day bounds in PIM_TIMEZONE, not host time", async () => {
      vi.stubEnv("PIM_TIMEZONE", "America/Chicago");
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-10T03:00:00Z")); // still July 9 in Chicago
      mockService.listCalendars.mockResolvedValueOnce([{ calendar_id: "prov/Cal" }]);
      mockService.listEvents.mockResolvedValueOnce([]);

      await handleCalendarTool("get_today_events", {}, mockService as any);

      const [, start, end] = mockService.listEvents.mock.calls[0];
      expect(start).toBe("2026-07-09T05:00:00.000Z"); // Chicago midnight (CDT)
      expect(end).toBe("2026-07-10T05:00:00.000Z"); // next midnight, exclusive
      vi.useRealTimers();
      vi.unstubAllEnvs();
    });

    it("search_events detail_level=full filters against description from full events", async () => {
      mockService.listCalendars.mockResolvedValueOnce([{ calendar_id: "prov/Cal" }]);
      mockService.listEventsFull.mockResolvedValueOnce([
        fullEventFixture({ title: "Standup", description: "Weekly standup meeting" }),
        fullEventFixture({ uid: "other", title: "Other", description: "Unrelated" }),
      ]);

      const result = await handleCalendarTool(
        "search_events",
        { query: "standup", detail_level: "full" },
        mockService as any,
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.events).toHaveLength(1);
      expect(parsed.events[0].uid).toBe("weekly");
      expect(parsed.events[0].description).toBe("Weekly standup meeting");
      expect(mockService.getEvent).not.toHaveBeenCalled();
    });
  });

  describe("update_event span=this on recurring event", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("creates exception VEVENT when span=this on recurring event", async () => {
      const masterIcs = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "UID:weekly",
        "DTSTART:20260101T100000Z",
        "DTEND:20260101T110000Z",
        "RRULE:FREQ=WEEKLY;COUNT=52",
        "SUMMARY:Standup",
        "LOCATION:Room A",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      mockService.getEventWithMeta.mockResolvedValueOnce({
        event: {
          uid: "weekly",
          title: "Standup",
          is_recurring: true,
          start: "2026-01-01T10:00:00.000Z",
          end: "2026-01-01T11:00:00.000Z",
          all_day: false,
          location: "Room A",
          recurrence_rule: "FREQ=WEEKLY;COUNT=52",
          description: null,
          attendees: [],
          alarms: [],
          categories: [],
          geo: null,
          organizer: null,
          status: null,
          availability: null,
          url: null,
          created: null,
          last_modified: null,
          calendar_id: "prov/Cal",
          occurrence_date: null,
        },
        meta: { url: "/cal/weekly.ics", etag: '"etag-1"' },
      });

      mockService.fetchRawCalendarObject.mockResolvedValueOnce({
        data: masterIcs,
        url: "/cal/weekly.ics",
        etag: '"etag-1"',
      });

      mockService.updateEvent.mockResolvedValueOnce({});

      const result = await handleCalendarTool(
        "update_event",
        {
          calendar: "prov/Cal",
          uid: "weekly",
          title: "Renamed Standup",
          span: "this",
          occurrence_date: "2026-03-05T10:00:00.000Z",
        },
        mockService as any,
      );

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.event.title).toBe("Renamed Standup");

      // Verify updateEvent was called with combined ICS containing RECURRENCE-ID
      expect(mockService.updateEvent).toHaveBeenCalledWith(
        "prov/Cal",
        "weekly",
        expect.stringContaining("RECURRENCE-ID"),
        expect.objectContaining({ url: "/cal/weekly.ics" }),
      );
    });

    it("returns error when span=this + recurring + no occurrence_date", async () => {
      mockService.getEventWithMeta.mockResolvedValueOnce({
        event: { uid: "weekly", is_recurring: true, all_day: false, occurrence_date: null },
        meta: { url: "/cal/weekly.ics", etag: '"etag-1"' },
      });

      const result = await handleCalendarTool(
        "update_event",
        { calendar: "prov/Cal", uid: "weekly", title: "New Title", span: "this" },
        mockService as any,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("occurrence_date");
    });
  });

  describe("delete_event span=this on recurring event", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("adds EXDATE when span=this on recurring event", async () => {
      const masterIcs = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "UID:weekly",
        "DTSTART:20260101T100000Z",
        "DTEND:20260101T110000Z",
        "RRULE:FREQ=WEEKLY;COUNT=52",
        "SUMMARY:Standup",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      mockService.getEventWithMeta.mockResolvedValueOnce({
        event: { uid: "weekly", is_recurring: true, all_day: false, occurrence_date: null },
        meta: { url: "/cal/weekly.ics", etag: '"etag-1"' },
      });

      mockService.fetchRawCalendarObject.mockResolvedValueOnce({
        data: masterIcs,
        url: "/cal/weekly.ics",
        etag: '"etag-1"',
      });

      mockService.updateEvent.mockResolvedValueOnce({});

      const result = await handleCalendarTool(
        "delete_event",
        {
          calendar: "prov/Cal",
          uid: "weekly",
          span: "this",
          occurrence_date: "2026-03-05T10:00:00.000Z",
        },
        mockService as any,
      );

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.deleted).toBe(true);

      // Verify updateEvent was called with ICS containing EXDATE
      expect(mockService.updateEvent).toHaveBeenCalledWith(
        "prov/Cal",
        "weekly",
        expect.stringContaining("EXDATE"),
        expect.objectContaining({ url: "/cal/weekly.ics" }),
      );
    });

    it("returns error when span=this + recurring + no occurrence_date", async () => {
      mockService.getEventWithMeta.mockResolvedValueOnce({
        event: { uid: "weekly", is_recurring: true, all_day: false, occurrence_date: null },
        meta: { url: "/cal/weekly.ics", etag: '"etag-1"' },
      });

      const result = await handleCalendarTool(
        "delete_event",
        { calendar: "prov/Cal", uid: "weekly", span: "this" },
        mockService as any,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("occurrence_date");
    });

    it("removes existing exception VEVENT when deleting occurrence", async () => {
      const icsWithException = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "UID:weekly",
        "DTSTART:20260101T100000Z",
        "DTEND:20260101T110000Z",
        "RRULE:FREQ=WEEKLY;COUNT=52",
        "SUMMARY:Standup",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:weekly",
        "RECURRENCE-ID:20260305T100000Z",
        "DTSTART:20260305T140000Z",
        "DTEND:20260305T150000Z",
        "SUMMARY:Rescheduled",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      mockService.getEventWithMeta.mockResolvedValueOnce({
        event: { uid: "weekly", is_recurring: true, all_day: false, occurrence_date: null },
        meta: { url: "/cal/weekly.ics", etag: '"etag-1"' },
      });
      mockService.fetchRawCalendarObject.mockResolvedValueOnce({
        data: icsWithException,
        url: "/cal/weekly.ics",
        etag: '"etag-1"',
      });
      mockService.updateEvent.mockResolvedValueOnce({});

      await handleCalendarTool(
        "delete_event",
        {
          calendar: "prov/Cal",
          uid: "weekly",
          span: "this",
          occurrence_date: "2026-03-05T10:00:00.000Z",
        },
        mockService as any,
      );

      const icsArg = mockService.updateEvent.mock.calls[0][2];
      expect(icsArg).toContain("EXDATE");
      expect(icsArg).not.toContain("RECURRENCE-ID");
    });
  });

  describe("ORGANIZER injection (CalDAV 412 fix)", () => {
    it("create_event injects ORGANIZER from account when attendees are present", async () => {
      mockService.createEvent.mockResolvedValue({ uid: "new-1", title: "Meeting" });

      await handleCalendarTool(
        "create_event",
        {
          calendar: "mailbox/Calendar",
          title: "Meeting",
          start: "2026-03-10T14:00:00Z",
          end: "2026-03-10T15:00:00Z",
          attendees: [{ email: "alice@example.com" }],
        },
        mockService as any,
      );

      expect(mockService.getAccountEmail).toHaveBeenCalledWith("mailbox/Calendar");
      const icsArg = mockService.createEvent.mock.calls[0][1];
      expect(icsArg).toMatch(/ORGANIZER[^\r\n]*mailto:user@example\.com/i);
      expect(icsArg).toContain("alice@example.com");
    });

    it("create_event does NOT inject ORGANIZER when no attendees", async () => {
      mockService.createEvent.mockResolvedValue({ uid: "new-1", title: "Solo" });

      await handleCalendarTool(
        "create_event",
        {
          calendar: "mailbox/Calendar",
          title: "Solo",
          start: "2026-03-10T14:00:00Z",
          end: "2026-03-10T15:00:00Z",
        },
        mockService as any,
      );

      const icsArg = mockService.createEvent.mock.calls[0][1];
      expect(icsArg).not.toMatch(/^ORGANIZER/m);
    });

    it("update_event injects account ORGANIZER when adding attendees to organizer-less event", async () => {
      mockService.getEventWithMeta.mockResolvedValue({
        event: {
          uid: "evt-1",
          title: "Meeting",
          is_recurring: false,
          recurrence_rule: null,
          start: "2026-03-10T14:00:00Z",
          end: "2026-03-10T15:00:00Z",
          all_day: false,
          location: null,
          description: null,
          attendees: [],
          organizer: null,
          alarms: [],
          categories: [],
          availability: null,
        },
        meta: { url: "/cal/evt-1.ics", etag: '"e1"' },
      });
      mockService.fetchRawCalendarObject.mockResolvedValue({
        data: [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "BEGIN:VEVENT",
          "UID:evt-1",
          "DTSTAMP:20260301T000000Z",
          "DTSTART:20260310T140000Z",
          "DTEND:20260310T150000Z",
          "SUMMARY:Meeting",
          "END:VEVENT",
          "END:VCALENDAR",
        ].join("\r\n"),
        url: "/cal/evt-1.ics",
        etag: '"e1"',
      });
      mockService.updateEvent.mockResolvedValue({ uid: "evt-1" });

      await handleCalendarTool(
        "update_event",
        {
          calendar: "mailbox/Calendar",
          uid: "evt-1",
          attendees: [{ email: "alice@example.com" }],
        },
        mockService as any,
      );

      const icsArg = mockService.updateEvent.mock.calls[0][2];
      expect(icsArg).toMatch(/ORGANIZER[^\r\n]*mailto:user@example\.com/i);
      expect(icsArg).toContain("alice@example.com");
    });

    it("update_event preserves existing ORGANIZER instead of overwriting with account", async () => {
      mockService.getEventWithMeta.mockResolvedValue({
        event: {
          uid: "evt-1",
          title: "Meeting",
          is_recurring: false,
          recurrence_rule: null,
          start: "2026-03-10T14:00:00Z",
          end: "2026-03-10T15:00:00Z",
          all_day: false,
          location: null,
          description: null,
          attendees: [{ email: "bob@example.com" }],
          organizer: { email: "alice@example.com", name: "Alice" },
          alarms: [],
          categories: [],
          availability: null,
        },
        meta: { url: "/cal/evt-1.ics", etag: '"e1"' },
      });
      mockService.fetchRawCalendarObject.mockResolvedValue({
        data: [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "BEGIN:VEVENT",
          "UID:evt-1",
          "DTSTAMP:20260301T000000Z",
          "DTSTART:20260310T140000Z",
          "DTEND:20260310T150000Z",
          "SUMMARY:Meeting",
          "ORGANIZER;CN=Alice:mailto:alice@example.com",
          "ATTENDEE:mailto:bob@example.com",
          "END:VEVENT",
          "END:VCALENDAR",
        ].join("\r\n"),
        url: "/cal/evt-1.ics",
        etag: '"e1"',
      });
      mockService.updateEvent.mockResolvedValue({ uid: "evt-1" });

      await handleCalendarTool(
        "update_event",
        { calendar: "mailbox/Calendar", uid: "evt-1", title: "Renamed" },
        mockService as any,
      );

      const icsArg = mockService.updateEvent.mock.calls[0][2];
      expect(icsArg).toMatch(/ORGANIZER[^\r\n]*mailto:alice@example\.com/i);
      expect(icsArg).not.toContain("user@example.com");
    });
  });

  describe("availability / free-busy", () => {
    it("update_event schema exposes availability enum", () => {
      const tool = CALENDAR_TOOLS.find((t) => t.name === "update_event")!;
      const props = (tool.inputSchema as any).properties;
      expect(props.availability).toBeDefined();
      expect(props.availability.enum).toEqual(["busy", "free"]);
    });

    it("create_event schema exposes availability enum", () => {
      const tool = CALENDAR_TOOLS.find((t) => t.name === "create_event")!;
      const props = (tool.inputSchema as any).properties;
      expect(props.availability).toBeDefined();
      expect(props.availability.enum).toEqual(["busy", "free"]);
    });

    it("create_event sets TRANSP:TRANSPARENT when availability is 'free'", async () => {
      mockService.createEvent.mockResolvedValue({ uid: "new-1" });

      await handleCalendarTool(
        "create_event",
        {
          calendar: "mailbox/Calendar",
          title: "Focus",
          start: "2026-03-10T14:00:00Z",
          end: "2026-03-10T15:00:00Z",
          availability: "free",
        },
        mockService as any,
      );

      const icsArg = mockService.createEvent.mock.calls[0][1];
      expect(icsArg).toContain("TRANSP:TRANSPARENT");
    });

    it("update_event preserves existing 'free' availability when not provided", async () => {
      mockService.getEventWithMeta.mockResolvedValue({
        event: {
          uid: "evt-1",
          title: "Focus",
          is_recurring: false,
          recurrence_rule: null,
          start: "2026-03-10T14:00:00Z",
          end: "2026-03-10T15:00:00Z",
          all_day: false,
          location: null,
          description: null,
          attendees: [],
          organizer: null,
          alarms: [],
          categories: [],
          availability: "free",
        },
        meta: { url: "/cal/evt-1.ics", etag: '"e1"' },
      });
      mockService.fetchRawCalendarObject.mockResolvedValue({
        data: [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "BEGIN:VEVENT",
          "UID:evt-1",
          "DTSTAMP:20260301T000000Z",
          "DTSTART:20260310T140000Z",
          "DTEND:20260310T150000Z",
          "SUMMARY:Focus",
          "TRANSP:TRANSPARENT",
          "END:VEVENT",
          "END:VCALENDAR",
        ].join("\r\n"),
        url: "/cal/evt-1.ics",
        etag: '"e1"',
      });
      mockService.updateEvent.mockResolvedValue({ uid: "evt-1" });

      await handleCalendarTool(
        "update_event",
        { calendar: "mailbox/Calendar", uid: "evt-1", title: "Focus Block" },
        mockService as any,
      );

      const icsArg = mockService.updateEvent.mock.calls[0][2];
      expect(icsArg).toContain("TRANSP:TRANSPARENT");
    });

    it("update_event overrides availability from 'busy' to 'free'", async () => {
      mockService.getEventWithMeta.mockResolvedValue({
        event: {
          uid: "evt-1",
          title: "Meeting",
          is_recurring: false,
          recurrence_rule: null,
          start: "2026-03-10T14:00:00Z",
          end: "2026-03-10T15:00:00Z",
          all_day: false,
          location: null,
          description: null,
          attendees: [],
          organizer: null,
          alarms: [],
          categories: [],
          availability: "busy",
        },
        meta: { url: "/cal/evt-1.ics", etag: '"e1"' },
      });
      mockService.fetchRawCalendarObject.mockResolvedValue({
        data: [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "BEGIN:VEVENT",
          "UID:evt-1",
          "DTSTAMP:20260301T000000Z",
          "DTSTART:20260310T140000Z",
          "DTEND:20260310T150000Z",
          "SUMMARY:Meeting",
          "TRANSP:OPAQUE",
          "END:VEVENT",
          "END:VCALENDAR",
        ].join("\r\n"),
        url: "/cal/evt-1.ics",
        etag: '"e1"',
      });
      mockService.updateEvent.mockResolvedValue({ uid: "evt-1" });

      await handleCalendarTool(
        "update_event",
        { calendar: "mailbox/Calendar", uid: "evt-1", availability: "free" },
        mockService as any,
      );

      const icsArg = mockService.updateEvent.mock.calls[0][2];
      expect(icsArg).toContain("TRANSP:TRANSPARENT");
    });
  });

  describe("update_event span=all on recurring event (master mutation)", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("update_event span=all on a recurring event preserves RRULE, EXDATE, overrides, PARTSTAT, STATUS", async () => {
      const MASTER = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//test//EN",
        "BEGIN:VEVENT",
        "UID:weekly-9",
        "DTSTAMP:20260301T000000Z",
        "DTSTART:20260302T150000Z",
        "DTEND:20260302T153000Z",
        "SUMMARY:Weekly sync",
        "STATUS:TENTATIVE",
        "SEQUENCE:1",
        "RRULE:FREQ=WEEKLY;BYDAY=MO",
        "EXDATE:20260316T150000Z",
        "ORGANIZER;CN=alice:mailto:alice@example.com",
        "ATTENDEE;PARTSTAT=ACCEPTED:mailto:bob@example.com",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:weekly-9",
        "RECURRENCE-ID:20260309T150000Z",
        "DTSTAMP:20260301T000000Z",
        "DTSTART:20260309T160000Z",
        "DTEND:20260309T163000Z",
        "SUMMARY:Weekly sync (moved)",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      mockService.getEventWithMeta.mockResolvedValueOnce({
        event: {
          uid: "weekly-9",
          calendar_id: "mailbox/Calendar",
          title: "Weekly sync",
          start: "2026-03-02T15:00:00.000Z",
          end: "2026-03-02T15:30:00.000Z",
          all_day: false,
          is_recurring: true,
          recurrence_rule: "FREQ=WEEKLY;BYDAY=MO",
          organizer: { email: "alice@example.com", name: "alice" },
          attendees: [{ email: "bob@example.com" }],
        },
        meta: { url: "https://dav.example.com/cal/weekly-9.ics", etag: '"e9"' },
      });
      mockService.fetchRawCalendarObject.mockResolvedValueOnce({
        data: MASTER,
        url: "https://dav.example.com/cal/weekly-9.ics",
        etag: '"e9"',
      });
      mockService.updateEvent.mockResolvedValueOnce({ uid: "weekly-9" });

      const result = await handleCalendarTool(
        "update_event",
        { calendar: "mailbox/Calendar", uid: "weekly-9", span: "all", title: "Weekly sync v2" },
        mockService as any,
      );

      expect(result.isError).toBeFalsy();
      const sentIcs = mockService.updateEvent.mock.calls[0][2] as string;
      expect(sentIcs).toContain("SUMMARY:Weekly sync v2");
      expect(sentIcs).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO");
      expect(sentIcs).toContain("EXDATE:20260316T150000Z");
      expect(sentIcs).toContain("RECURRENCE-ID:20260309T150000Z");
      expect(sentIcs).toContain("PARTSTAT=ACCEPTED");
      expect(sentIcs).toContain("STATUS:TENTATIVE");
    });
  });
});
