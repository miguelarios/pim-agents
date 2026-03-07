import { beforeEach, describe, expect, it, vi } from "vitest";
import { CALENDAR_TOOLS, handleCalendarTool } from "../tools/calendarTools.js";

const mockService = {
  listCalendars: vi.fn(),
  listEvents: vi.fn(),
  getEvent: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  findFreeSlots: vi.fn(),
};

describe("calendarTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports 9 tool definitions", () => {
    expect(CALENDAR_TOOLS).toHaveLength(9);
    const names = CALENDAR_TOOLS.map((t) => t.name);
    expect(names).toContain("list_calendars");
    expect(names).toContain("list_events");
    expect(names).toContain("get_event");
    expect(names).toContain("create_event");
    expect(names).toContain("update_event");
    expect(names).toContain("delete_event");
    expect(names).toContain("create_events_batch");
    expect(names).toContain("import_ics");
    expect(names).toContain("find_free_slots");
  });

  describe("handleCalendarTool", () => {
    it("handles list_calendars", async () => {
      mockService.listCalendars.mockResolvedValue([
        {
          calendarId: "mailbox/Work",
          displayName: "Work",
          url: "/cal/work/",
          providerId: "mailbox",
        },
      ]);

      const result = await handleCalendarTool("list_calendars", {}, mockService as any);
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toHaveLength(1);
    });

    it("handles list_events", async () => {
      mockService.listEvents.mockResolvedValue([
        {
          uid: "evt-1",
          calendarId: "mailbox/Work",
          summary: "Meeting",
          start: "2026-03-10T14:00:00Z",
          end: "2026-03-10T15:00:00Z",
        },
      ]);

      const result = await handleCalendarTool(
        "list_events",
        {
          calendar: "mailbox/Work",
          start: "2026-03-10T00:00:00Z",
          end: "2026-03-10T23:59:59Z",
        },
        mockService as any,
      );

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].summary).toBe("Meeting");
    });

    it("handles get_event", async () => {
      mockService.getEvent.mockResolvedValue({
        uid: "evt-1",
        calendarId: "mailbox/Work",
        summary: "Meeting",
      });

      const result = await handleCalendarTool(
        "get_event",
        {
          calendar: "mailbox/Work",
          uid: "evt-1",
        },
        mockService as any,
      );

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text).uid).toBe("evt-1");
    });

    it("handles create_event", async () => {
      mockService.createEvent.mockResolvedValue(undefined);

      const result = await handleCalendarTool(
        "create_event",
        {
          calendar: "mailbox/Work",
          summary: "New Event",
          start: "2026-03-10T14:00:00Z",
          end: "2026-03-10T15:00:00Z",
        },
        mockService as any,
      );

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text).status).toBe("created");
    });

    it("handles delete_event", async () => {
      mockService.deleteEvent.mockResolvedValue(undefined);

      const result = await handleCalendarTool(
        "delete_event",
        {
          calendar: "mailbox/Work",
          uid: "evt-1",
        },
        mockService as any,
      );

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text).status).toBe("deleted");
    });

    it("returns error for unknown tool", async () => {
      const result = await handleCalendarTool("unknown_tool", {}, mockService as any);
      expect(result.isError).toBe(true);
    });

    it("catches service errors and returns error response", async () => {
      mockService.listCalendars.mockRejectedValue(new Error("Connection failed"));

      const result = await handleCalendarTool("list_calendars", {}, mockService as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Connection failed");
    });
  });
});
