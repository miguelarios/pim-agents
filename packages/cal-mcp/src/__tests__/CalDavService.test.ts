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
});
