import { beforeEach, describe, expect, it, vi } from "vitest";
import { CalDavService } from "../services/CalDavService.js";

// Mock tsdav — same pattern as card-mcp
vi.mock("tsdav", () => {
  const mockClient = {
    login: vi.fn().mockResolvedValue(undefined),
    fetchCalendars: vi.fn().mockResolvedValue([
      {
        displayName: "Work",
        url: "/caldav/work/",
        ctag: "ctag-1",
        components: ["VEVENT"],
      },
      {
        displayName: "Personal",
        url: "/caldav/personal/",
        ctag: "ctag-2",
        components: ["VEVENT"],
      },
    ]),
    fetchCalendarObjects: vi.fn().mockResolvedValue([]),
    createCalendarObject: vi.fn().mockResolvedValue({ ok: true }),
    updateCalendarObject: vi.fn().mockResolvedValue({ ok: true }),
    deleteCalendarObject: vi.fn().mockResolvedValue({ ok: true }),
  };
  return {
    DAVClient: vi.fn().mockImplementation(() => mockClient),
    __mockClient: mockClient,
  };
});

// Mock ical helpers
vi.mock("../ical.js", () => ({
  parseIcsEvents: vi.fn().mockReturnValue([]),
  generateEventIcs: vi.fn().mockReturnValue("BEGIN:VCALENDAR\nEND:VCALENDAR"),
}));

const TEST_CONFIG = {
  accounts: [
    {
      id: "mailbox",
      url: "https://dav.mailbox.org/caldav/",
      username: "miguel@mailbox.org",
      password: "secret-1",
    },
    {
      id: "nextcloud",
      url: "https://cloud.example.com/remote.php/dav/calendars/miguel/",
      username: "miguel",
      password: "secret-2",
    },
  ],
};

describe("CalDavService", () => {
  let service: CalDavService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new CalDavService(TEST_CONFIG);
  });

  describe("listCalendars", () => {
    it("fetches calendars from all providers and returns provider-prefixed IDs", async () => {
      const calendars = await service.listCalendars();
      // 2 calendars per provider × 2 providers = 4
      expect(calendars).toHaveLength(4);

      // Check mailbox calendars
      const mailboxCals = calendars.filter((c) => c.calendarId.startsWith("mailbox/"));
      expect(mailboxCals).toHaveLength(2);
      expect(mailboxCals[0].calendarId).toBe("mailbox/Work");
      expect(mailboxCals[0].displayName).toBe("Work");

      // Check nextcloud calendars
      const ncCals = calendars.filter((c) => c.calendarId.startsWith("nextcloud/"));
      expect(ncCals).toHaveLength(2);
    });

    it("creates DAVClient with correct config per provider", async () => {
      const { DAVClient } = await import("tsdav");
      await service.listCalendars();

      expect(DAVClient).toHaveBeenCalledTimes(2);
      expect(DAVClient).toHaveBeenCalledWith(
        expect.objectContaining({
          serverUrl: "https://dav.mailbox.org/caldav/",
          credentials: {
            username: "miguel@mailbox.org",
            password: "secret-1",
          },
          authMethod: "Basic",
          defaultAccountType: "caldav",
        }),
      );
      expect(DAVClient).toHaveBeenCalledWith(
        expect.objectContaining({
          serverUrl: "https://cloud.example.com/remote.php/dav/calendars/miguel/",
        }),
      );
    });
  });

  describe("listEvents", () => {
    it("fetches events with time range and returns EventSummary array", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("../ical.js");
      (parseIcsEvents as any).mockReturnValue([
        {
          uid: "evt-1",
          summary: "Team Meeting",
          start: "2026-03-10T14:00:00.000Z",
          end: "2026-03-10T15:00:00.000Z",
          location: "Office",
          status: "CONFIRMED",
          recurrenceRule: undefined,
        },
      ]);
      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "BEGIN:VCALENDAR...END:VCALENDAR", url: "/cal/evt-1.ics", etag: '"e1"' },
      ]);

      const events = await service.listEvents(
        "mailbox/Work",
        "2026-03-10T00:00:00Z",
        "2026-03-10T23:59:59Z",
      );

      expect(events).toHaveLength(1);
      expect(events[0].uid).toBe("evt-1");
      expect(events[0].calendarId).toBe("mailbox/Work");
      expect(events[0].summary).toBe("Team Meeting");
      expect(events[0].isRecurring).toBe(false);

      expect(__mockClient.fetchCalendarObjects).toHaveBeenCalledWith(
        expect.objectContaining({
          timeRange: {
            start: "2026-03-10T00:00:00Z",
            end: "2026-03-10T23:59:59Z",
          },
          expand: true,
        }),
      );
    });

    it("throws CalendarError for unknown provider", async () => {
      await expect(
        service.listEvents("unknown/cal", "2026-03-10T00:00:00Z", "2026-03-10T23:59:59Z"),
      ).rejects.toThrow("Unknown provider");
    });
  });

  describe("getEvent", () => {
    it("fetches a single event by UID and returns full details", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("../ical.js");
      (parseIcsEvents as any).mockReturnValue([
        {
          uid: "evt-1",
          summary: "Team Meeting",
          start: "2026-03-10T14:00:00.000Z",
          end: "2026-03-10T15:00:00.000Z",
          location: "Office",
          description: "Weekly standup",
          status: "CONFIRMED",
          transparency: "OPAQUE",
          attendees: [{ email: "bob@example.com", name: "Bob" }],
          organizer: { email: "miguel@example.com", name: "Miguel" },
          recurrenceRule: undefined,
        },
      ]);
      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "BEGIN:VCALENDAR...END:VCALENDAR", url: "/cal/evt-1.ics", etag: '"e1"' },
      ]);

      const event = await service.getEvent("mailbox/Work", "evt-1");

      expect(event.uid).toBe("evt-1");
      expect(event.calendarId).toBe("mailbox/Work");
      expect(event.description).toBe("Weekly standup");
      expect(event.attendees).toHaveLength(1);
      expect(event.organizer?.email).toBe("miguel@example.com");
    });

    it("throws CalendarError when event not found", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("../ical.js");
      (parseIcsEvents as any).mockReturnValue([{ uid: "other-event", summary: "Other" }]);
      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "...", url: "/cal/other.ics", etag: '"e1"' },
      ]);

      await expect(service.getEvent("mailbox/Work", "evt-missing")).rejects.toThrow("not found");
    });
  });

  describe("createEvent", () => {
    it("creates a calendar object with generated iCal string", async () => {
      const { __mockClient } = (await import("tsdav")) as any;

      await service.createEvent("mailbox/Work", "BEGIN:VCALENDAR\nEND:VCALENDAR");

      expect(__mockClient.createCalendarObject).toHaveBeenCalledWith(
        expect.objectContaining({
          iCalString: "BEGIN:VCALENDAR\nEND:VCALENDAR",
        }),
      );
    });
  });

  describe("updateEvent", () => {
    it("updates an existing calendar object by UID", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("../ical.js");
      (parseIcsEvents as any).mockReturnValue([{ uid: "evt-1" }]);
      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "...", url: "/cal/evt-1.ics", etag: '"e1"' },
      ]);

      await service.updateEvent("mailbox/Work", "evt-1", "BEGIN:VCALENDAR\nUPDATED\nEND:VCALENDAR");

      expect(__mockClient.updateCalendarObject).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarObject: expect.objectContaining({
            url: "/cal/evt-1.ics",
            etag: '"e1"',
            data: "BEGIN:VCALENDAR\nUPDATED\nEND:VCALENDAR",
          }),
        }),
      );
    });

    it("throws CalendarError when event to update is not found", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("../ical.js");
      (parseIcsEvents as any).mockReturnValue([]);
      __mockClient.fetchCalendarObjects.mockResolvedValue([]);

      await expect(service.updateEvent("mailbox/Work", "missing", "...")).rejects.toThrow(
        "not found",
      );
    });
  });

  describe("deleteEvent", () => {
    it("deletes a calendar object by UID", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("../ical.js");
      (parseIcsEvents as any).mockReturnValue([{ uid: "evt-1" }]);
      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "...", url: "/cal/evt-1.ics", etag: '"e1"' },
      ]);

      await service.deleteEvent("mailbox/Work", "evt-1");

      expect(__mockClient.deleteCalendarObject).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarObject: expect.objectContaining({
            url: "/cal/evt-1.ics",
            etag: '"e1"',
          }),
        }),
      );
    });
  });
});
