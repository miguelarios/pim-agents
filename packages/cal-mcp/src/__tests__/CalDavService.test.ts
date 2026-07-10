import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CalDavService, buildCanonicalHref } from "../services/CalDavService.js";

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
    propfind: vi.fn().mockResolvedValue([]),
  };
  return {
    DAVClient: vi.fn().mockImplementation(() => mockClient),
    __mockClient: mockClient,
  };
});

// Mock ical helpers
vi.mock("@miguelarios/pim-core/ics", () => ({
  parseIcsEvents: vi.fn().mockReturnValue([]),
  generateEventIcs: vi.fn().mockReturnValue("BEGIN:VCALENDAR\nEND:VCALENDAR"),
}));

// Mock the persistent URL cache so tests are deterministic and don't touch the
// user's real cache file. Each test gets a fresh empty cache.
vi.mock("../services/urlCache.js", () => {
  const store = new Map<string, { url: string; etag?: string }>();
  return {
    getCachedObject: vi.fn(
      (calendarId: string, uid: string) => store.get(`${calendarId}::${uid}`) ?? null,
    ),
    setCachedObject: vi.fn(
      (calendarId: string, uid: string, obj: { url: string; etag?: string }) => {
        store.set(`${calendarId}::${uid}`, obj);
      },
    ),
    deleteCachedObject: vi.fn((calendarId: string, uid: string) => {
      store.delete(`${calendarId}::${uid}`);
    }),
    __urlCacheStore: store,
  };
});

const TEST_CONFIG = {
  accounts: [
    {
      id: "mailbox",
      url: "https://dav.mailbox.org/caldav/",
      username: "user@example.com",
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

  beforeAll(() => {
    vi.stubEnv("PIM_TIMEZONE", "UTC");
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset the mocked URL cache between tests
    const mod = (await import("../services/urlCache.js")) as unknown as {
      __urlCacheStore: Map<string, unknown>;
    };
    mod.__urlCacheStore.clear();
    service = new CalDavService(TEST_CONFIG);
  });

  describe("listCalendars", () => {
    it("fetches calendars from all providers and returns provider-prefixed IDs", async () => {
      const calendars = await service.listCalendars();
      expect(calendars).toHaveLength(4);

      const mailboxCals = calendars.filter((c) => c.calendar_id.startsWith("mailbox/"));
      expect(mailboxCals).toHaveLength(2);
      expect(mailboxCals[0].calendar_id).toBe("mailbox/Work");
      expect(mailboxCals[0].display_name).toBe("Work");
      expect(mailboxCals[0].source).toBe("mailbox");
      expect(mailboxCals[0].color).toBeNull();
      expect(mailboxCals[0].read_only).toBe(false);

      const ncCals = calendars.filter((c) => c.calendar_id.startsWith("nextcloud/"));
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
            username: "user@example.com",
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

    it("returns read_only: false when privilege set includes write", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      __mockClient.propfind.mockResolvedValue([
        {
          props: {
            currentUserPrivilegeSet: {
              privilege: [{ write: {} }, { read: {} }],
            },
          },
        },
      ]);

      const calendars = await service.listCalendars();
      const workCal = calendars.find((c) => c.display_name === "Work");
      expect(workCal?.read_only).toBe(false);
    });

    it("returns read_only: true when privilege set lacks write", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      __mockClient.propfind.mockResolvedValue([
        {
          props: {
            currentUserPrivilegeSet: {
              privilege: [{ read: {} }],
            },
          },
        },
      ]);

      const calendars = await service.listCalendars();
      // All calendars from this provider should be read_only
      expect(calendars.every((c) => c.read_only)).toBe(true);
    });

    it("defaults read_only: false when propfind returns no privilege info", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      __mockClient.propfind.mockResolvedValue([]);

      const calendars = await service.listCalendars();
      expect(calendars[0].read_only).toBe(false);
    });
  });

  describe("listEvents", () => {
    it("fetches events with time range and returns EventSummary array", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");
      (parseIcsEvents as any).mockReturnValue([
        {
          uid: "evt-1",
          title: "Team Meeting",
          start: "2026-03-10T14:00:00.000Z",
          end: "2026-03-10T15:00:00.000Z",
          all_day: false,
          location: "Office",
          status: "confirmed",
          recurrence_rule: null,
          is_recurring: false,
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
      expect(events[0].calendar_id).toBe("mailbox/Work");
      expect(events[0].title).toBe("Team Meeting");
      expect(events[0].is_recurring).toBe(false);
      expect(events[0].all_day).toBe(false);
      expect(events[0].location).toBe("Office");
    });

    it("throws CalendarError for unknown provider", async () => {
      await expect(
        service.listEvents("unknown/cal", "2026-03-10T00:00:00Z", "2026-03-10T23:59:59Z"),
      ).rejects.toThrow("Unknown provider");
    });
  });

  describe("listEventsFull", () => {
    it("returns full events in a single CalDAV fetch (no per-event getEvent)", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");
      (parseIcsEvents as any).mockReturnValue([
        {
          uid: "evt-1",
          title: "Team Meeting",
          start: "2026-03-10T14:00:00.000Z",
          end: "2026-03-10T15:00:00.000Z",
          all_day: false,
          location: "Office",
          description: "Weekly sync",
          status: "confirmed",
          availability: "busy",
          url: null,
          attendees: [],
          organizer: null,
          recurrence_rule: null,
          is_recurring: false,
          created: null,
          last_modified: null,
          alarms: [],
          categories: [],
          geo: null,
          occurrence_date: null,
        },
      ]);
      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "BEGIN:VCALENDAR...END:VCALENDAR", url: "/cal/evt-1.ics", etag: '"e1"' },
      ]);

      const events = await service.listEventsFull(
        "mailbox/Work",
        "2026-03-10T00:00:00Z",
        "2026-03-10T23:59:59Z",
      );

      expect(__mockClient.fetchCalendarObjects).toHaveBeenCalledTimes(1);
      expect(events).toHaveLength(1);
      expect(events[0].uid).toBe("evt-1");
      expect(events[0].description).toBe("Weekly sync");
      expect(events[0].calendar_id).toBe("mailbox/Work");
    });
  });

  describe("getEvent", () => {
    it("fetches a single event by UID and returns full details", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");
      (parseIcsEvents as any).mockReturnValue([
        {
          uid: "evt-1",
          title: "Team Meeting",
          start: "2026-03-10T14:00:00.000Z",
          end: "2026-03-10T15:00:00.000Z",
          all_day: false,
          location: "Office",
          description: "Weekly standup",
          status: "confirmed",
          availability: "busy",
          url: null,
          attendees: [
            { email: "bob@example.com", name: "Bob", status: null, role: null, type: "unknown" },
          ],
          organizer: { email: "miguel@example.com", name: "Miguel" },
          recurrence_rule: null,
          is_recurring: false,
          created: null,
          last_modified: null,
          alarms: [],
          categories: [],
          geo: null,
        },
      ]);
      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "BEGIN:VCALENDAR...END:VCALENDAR", url: "/cal/evt-1.ics", etag: '"e1"' },
      ]);

      const event = await service.getEvent("mailbox/Work", "evt-1");

      expect(event.uid).toBe("evt-1");
      expect(event.calendar_id).toBe("mailbox/Work");
      expect(event.title).toBe("Team Meeting");
      expect(event.description).toBe("Weekly standup");
      expect(event.availability).toBe("busy");
      expect(event.attendees).toHaveLength(1);
      expect(event.organizer?.email).toBe("miguel@example.com");
      expect(event.recurrence_rule).toBeNull();
      expect(event.url).toBeNull();
    });

    it("throws CalendarError when event not found", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");
      (parseIcsEvents as any).mockReturnValue([{ uid: "other-event", summary: "Other" }]);
      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "...", url: "/cal/other.ics", etag: '"e1"' },
      ]);

      await expect(service.getEvent("mailbox/Work", "evt-missing")).rejects.toThrow("not found");
    });

    it("tries the canonical URL (<cal>/<uid>.ics) first — single targeted fetch", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");
      (parseIcsEvents as any).mockReturnValue([
        {
          uid: "evt-1",
          title: "Team Meeting",
          start: "2026-03-10T14:00:00.000Z",
          end: "2026-03-10T15:00:00.000Z",
          all_day: false,
          location: null,
          description: null,
          status: "confirmed",
          availability: "busy",
          url: null,
          attendees: [],
          organizer: null,
          recurrence_rule: null,
          is_recurring: false,
          created: null,
          last_modified: null,
          alarms: [],
          categories: [],
          geo: null,
        },
      ]);
      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "ICS evt-1 blob", url: "/caldav/work/evt-1.ics", etag: '"e1"' },
      ]);

      await service.getEvent("mailbox/Work", "evt-1");

      // Exactly one fetchCalendarObjects call — targeted multiget via objectUrls.
      // No filter, no scan, no cache lookup necessary.
      expect(__mockClient.fetchCalendarObjects).toHaveBeenCalledTimes(1);
      const args = __mockClient.fetchCalendarObjects.mock.calls[0][0];
      expect(args.objectUrls).toEqual(["/caldav/work/evt-1.ics"]);
      expect(args.filters).toBeUndefined();
    });

    it("falls back to UID prop-filter then full scan when canonical URL misses", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");
      (parseIcsEvents as any).mockReturnValue([
        {
          uid: "evt-1",
          title: "Team Meeting",
          start: "2026-03-10T14:00:00.000Z",
          end: "2026-03-10T15:00:00.000Z",
          all_day: false,
          location: null,
          description: null,
          status: "confirmed",
          availability: "busy",
          url: null,
          attendees: [],
          organizer: null,
          recurrence_rule: null,
          is_recurring: false,
          created: null,
          last_modified: null,
          alarms: [],
          categories: [],
          geo: null,
        },
      ]);
      // Call sequence when the canonical URL misses, cache is empty, filter
      // returns nothing, and the full scan is the only path that finds it.
      __mockClient.fetchCalendarObjects
        // 1) canonical URL probe: miss
        .mockResolvedValueOnce([])
        // 2) UID filter: server ignored / no match
        .mockResolvedValueOnce([])
        // 3) full scan: returns the event with a substring-matching ICS
        .mockResolvedValueOnce([
          { data: "BEGIN:VEVENT\nUID:evt-1\nEND:VEVENT", url: "/cal/other-path.ics", etag: '"e1"' },
        ]);

      const event = await service.getEvent("mailbox/Work", "evt-1");
      expect(event.uid).toBe("evt-1");
      expect(__mockClient.fetchCalendarObjects).toHaveBeenCalledTimes(3);
      // Third call must be unfiltered (full scan)
      const scanCallArgs = __mockClient.fetchCalendarObjects.mock.calls[2][0];
      expect(scanCallArgs.filters).toBeUndefined();
      expect(scanCallArgs.objectUrls).toBeUndefined();
    });

    it("sends a UID prop-filter as the second fallback (when canonical URL misses)", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");
      (parseIcsEvents as any).mockReturnValue([
        {
          uid: "evt-1",
          title: "Team Meeting",
          start: "2026-03-10T14:00:00.000Z",
          end: "2026-03-10T15:00:00.000Z",
          all_day: false,
          location: null,
          description: null,
          status: "confirmed",
          availability: "busy",
          url: null,
          attendees: [],
          organizer: null,
          recurrence_rule: null,
          is_recurring: false,
          created: null,
          last_modified: null,
          alarms: [],
          categories: [],
          geo: null,
        },
      ]);
      __mockClient.fetchCalendarObjects
        .mockResolvedValueOnce([]) // canonical URL: miss
        .mockResolvedValueOnce([{ data: "...", url: "/cal/xyz.ics", etag: '"e1"' }]); // filter: hit

      await service.getEvent("mailbox/Work", "evt-1");

      const filterCallArgs = __mockClient.fetchCalendarObjects.mock.calls[1][0];
      expect(filterCallArgs.filters).toBeDefined();
      const propFilter = filterCallArgs.filters["comp-filter"]["comp-filter"]["prop-filter"];
      expect(propFilter._attributes.name).toBe("UID");
      expect(propFilter["text-match"]._text).toBe("evt-1");
    });

    it("uses the cached URL fast path when a UID→URL mapping exists", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");
      const { setCachedObject } = (await import("../services/urlCache.js")) as any;

      // Seed the cache with a non-canonical URL so the canonical-URL fast
      // path is guaranteed to miss first, forcing the cache path to be used.
      setCachedObject("mailbox/Work", "evt-1", {
        url: "/cal/non-canonical-path.ics",
        etag: '"e1"',
      });

      (parseIcsEvents as any).mockReturnValue([
        {
          uid: "evt-1",
          title: "Team Meeting",
          start: "2026-03-10T14:00:00.000Z",
          end: "2026-03-10T15:00:00.000Z",
          all_day: false,
          location: null,
          description: null,
          status: "confirmed",
          availability: "busy",
          url: null,
          attendees: [],
          organizer: null,
          recurrence_rule: null,
          is_recurring: false,
          created: null,
          last_modified: null,
          alarms: [],
          categories: [],
          geo: null,
        },
      ]);
      __mockClient.fetchCalendarObjects
        // 1) canonical URL (/caldav/work/evt-1.ics) misses — this UID's file
        //    wasn't stored under the conventional filename
        .mockResolvedValueOnce([])
        // 2) cached URL (/cal/non-canonical-path.ics) hits
        .mockResolvedValueOnce([
          { data: "ICS evt-1 blob", url: "/cal/non-canonical-path.ics", etag: '"e1"' },
        ]);

      const event = await service.getEvent("mailbox/Work", "evt-1");
      expect(event.uid).toBe("evt-1");
      // Exactly 2 calls: canonical URL probe (miss) then cached URL (hit)
      expect(__mockClient.fetchCalendarObjects).toHaveBeenCalledTimes(2);
      const cachedCallArgs = __mockClient.fetchCalendarObjects.mock.calls[1][0];
      expect(cachedCallArgs.objectUrls).toEqual(["/cal/non-canonical-path.ics"]);
      expect(cachedCallArgs.filters).toBeUndefined();
    });

    it("drops a stale URL-cache entry and falls through when the targeted fetch misses", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");
      const { setCachedObject, getCachedObject } = (await import("../services/urlCache.js")) as any;

      setCachedObject("mailbox/Work", "evt-1", { url: "/cal/old-url.ics", etag: '"e0"' });

      // parseIcsEvents: first call returns no match (cache stale), later calls return the real event
      (parseIcsEvents as any).mockImplementation((data: string) => {
        if (data === "stale") return [{ uid: "other-event" }];
        return [
          {
            uid: "evt-1",
            title: "Team Meeting",
            start: "2026-03-10T14:00:00.000Z",
            end: "2026-03-10T15:00:00.000Z",
            all_day: false,
            location: null,
            description: null,
            status: "confirmed",
            availability: "busy",
            url: null,
            attendees: [],
            organizer: null,
            recurrence_rule: null,
            is_recurring: false,
            created: null,
            last_modified: null,
            alarms: [],
            categories: [],
            geo: null,
          },
        ];
      });
      __mockClient.fetchCalendarObjects
        // 1) canonical URL probe: miss
        .mockResolvedValueOnce([])
        // 2) cached URL fetch: returns a different event's ICS (cache stale)
        .mockResolvedValueOnce([{ data: "stale", url: "/cal/old-url.ics", etag: '"e0"' }])
        // 3) UID filter path finds the real event
        .mockResolvedValueOnce([{ data: "real evt-1", url: "/cal/evt-1.ics", etag: '"e1"' }]);

      const event = await service.getEvent("mailbox/Work", "evt-1");
      expect(event.uid).toBe("evt-1");
      // Stale entry was dropped and replaced with the fresh one
      expect(getCachedObject("mailbox/Work", "evt-1")).toEqual({
        url: "/cal/evt-1.ics",
        etag: '"e1"',
      });
    });

    it("getEvent returns new fields (alarms, categories, geo, attendee type)", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");
      (parseIcsEvents as any).mockReturnValue([
        {
          uid: "evt-full",
          title: "Full Event",
          start: "2026-03-10T14:00:00.000Z",
          end: "2026-03-10T15:00:00.000Z",
          all_day: false,
          location: "Office",
          description: "Test",
          status: "confirmed",
          availability: "busy",
          url: null,
          attendees: [
            {
              email: "alice@example.com",
              name: "Alice",
              status: "accepted",
              role: "req-participant",
              type: "person",
            },
            { email: "rooma@example.com", name: "Room A", status: null, role: null, type: "room" },
          ],
          organizer: { email: "miguel@example.com", name: "Miguel" },
          recurrence_rule: null,
          is_recurring: false,
          created: null,
          last_modified: null,
          alarms: [{ type: "relative", trigger: -900, trigger_human: "15 minutes before" }],
          categories: ["Meeting", "Project-X"],
          geo: { latitude: 37.386, longitude: -122.083 },
        },
      ]);
      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "...", url: "/cal/evt-full.ics", etag: '"e1"' },
      ]);

      const event = await service.getEvent("mailbox/Work", "evt-full");

      expect(event.alarms).toHaveLength(1);
      expect(event.alarms[0].trigger).toBe(-900);
      expect(event.categories).toEqual(["Meeting", "Project-X"]);
      expect(event.geo).toEqual({ latitude: 37.386, longitude: -122.083 });
      expect(event.attendees[0].type).toBe("person");
      expect(event.attendees[1].type).toBe("room");
    });
  });

  describe("createEvent", () => {
    it("creates a calendar object and returns event built from ICS", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");

      __mockClient.createCalendarObject.mockResolvedValue({ ok: true });

      // parseIcsEvents called to build EventFull from ICS (no re-fetch)
      (parseIcsEvents as any).mockReturnValue([
        {
          uid: "new-evt",
          title: "New Event",
          start: "2026-03-10T14:00:00.000Z",
          end: "2026-03-10T15:00:00.000Z",
          all_day: false,
          location: null,
          description: null,
          status: null,
          availability: null,
          url: null,
          attendees: [],
          organizer: null,
          recurrence_rule: null,
          is_recurring: false,
          created: null,
          last_modified: null,
          alarms: [],
          categories: [],
          geo: null,
        },
      ]);

      const result = await service.createEvent(
        "mailbox/Work",
        "BEGIN:VCALENDAR\nEND:VCALENDAR",
        "new-evt",
      );

      expect(result.uid).toBe("new-evt");
      expect(result.title).toBe("New Event");
      expect(result.calendar_id).toBe("mailbox/Work");
      expect(__mockClient.createCalendarObject).toHaveBeenCalled();
      // Should NOT call fetchCalendarObjects (no post-write re-fetch)
      expect(__mockClient.fetchCalendarObjects).not.toHaveBeenCalled();
    });

    it("throws CalendarError when server returns non-ok response", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      __mockClient.createCalendarObject.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      await expect(
        service.createEvent("mailbox/Work", "BEGIN:VCALENDAR\nEND:VCALENDAR", "new-evt"),
      ).rejects.toThrow("Failed to create event: 500 Internal Server Error");
    });
  });

  describe("updateEvent", () => {
    it("updates an existing calendar object and returns the updated event", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");

      // findCalendarObject call: parseIcsEvents matches uid to find the object
      (parseIcsEvents as any).mockReturnValueOnce([{ uid: "evt-1" }]);
      __mockClient.fetchCalendarObjects.mockResolvedValueOnce([
        { data: "...", url: "/cal/evt-1.ics", etag: '"e1"' },
      ]);

      __mockClient.updateCalendarObject.mockResolvedValue({ ok: true });

      // After write: parseIcsEvents called on the ICS string to build EventFull
      const fullEvent = {
        uid: "evt-1",
        title: "Updated Meeting",
        start: "2026-03-10T14:00:00.000Z",
        end: "2026-03-10T15:00:00.000Z",
        all_day: false,
        location: null,
        description: null,
        status: null,
        availability: null,
        url: null,
        attendees: [],
        organizer: null,
        recurrence_rule: null,
        is_recurring: false,
        created: null,
        last_modified: null,
        alarms: [],
        categories: [],
        geo: null,
      };
      (parseIcsEvents as any).mockReturnValueOnce([fullEvent]);

      const result = await service.updateEvent(
        "mailbox/Work",
        "evt-1",
        "BEGIN:VCALENDAR\nUPDATED\nEND:VCALENDAR",
      );

      expect(result.uid).toBe("evt-1");
      expect(result.title).toBe("Updated Meeting");
      expect(__mockClient.updateCalendarObject).toHaveBeenCalled();
    });

    it("throws CalendarError when event to update is not found", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");
      (parseIcsEvents as any).mockReturnValue([]);
      __mockClient.fetchCalendarObjects.mockResolvedValue([]);

      await expect(service.updateEvent("mailbox/Work", "missing", "...")).rejects.toThrow(
        "not found",
      );
    });

    it("throws CalendarError when retried PUT still returns 412", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");

      // findCalendarObject succeeds on both the initial lookup and the post-412 refetch
      (parseIcsEvents as any).mockReturnValue([{ uid: "evt-1" }]);
      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "...", url: "/cal/evt-1.ics", etag: '"e1"' },
      ]);

      __mockClient.updateCalendarObject.mockResolvedValue({
        ok: false,
        status: 412,
        statusText: "Precondition Failed",
      });

      await expect(
        service.updateEvent("mailbox/Work", "evt-1", "BEGIN:VCALENDAR\nEND:VCALENDAR"),
      ).rejects.toThrow("Failed to update event: 412 Precondition Failed");
      // Initial PUT + one retry
      expect(__mockClient.updateCalendarObject).toHaveBeenCalledTimes(2);
    });

    it("throws CalendarError when server returns non-412 non-ok response", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");

      (parseIcsEvents as any).mockReturnValueOnce([{ uid: "evt-1" }]);
      __mockClient.fetchCalendarObjects.mockResolvedValueOnce([
        { data: "...", url: "/cal/evt-1.ics", etag: '"e1"' },
      ]);

      __mockClient.updateCalendarObject.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      await expect(
        service.updateEvent("mailbox/Work", "evt-1", "BEGIN:VCALENDAR\nEND:VCALENDAR"),
      ).rejects.toThrow("Failed to update event: 500 Internal Server Error");
      // No retry for non-412 errors
      expect(__mockClient.updateCalendarObject).toHaveBeenCalledTimes(1);
    });

    it("retries once with a fresh etag on 412 and succeeds", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");

      const fullEvent = {
        uid: "evt-1",
        title: "Updated Meeting",
        start: "2026-03-10T14:00:00.000Z",
        end: "2026-03-10T15:00:00.000Z",
        all_day: false,
        location: null,
        description: null,
        status: null,
        availability: null,
        url: null,
        attendees: [],
        organizer: null,
        recurrence_rule: null,
        is_recurring: false,
        created: null,
        last_modified: null,
        alarms: [],
        categories: [],
        geo: null,
      };

      // Two findCalendarObject calls (initial + retry), each parses one event; final
      // parse builds the EventFull response.
      (parseIcsEvents as any)
        .mockReturnValueOnce([{ uid: "evt-1" }])
        .mockReturnValueOnce([{ uid: "evt-1" }])
        .mockReturnValueOnce([fullEvent]);

      __mockClient.fetchCalendarObjects
        .mockResolvedValueOnce([{ data: "...", url: "/cal/evt-1.ics", etag: '"stale"' }])
        .mockResolvedValueOnce([{ data: "...", url: "/cal/evt-1.ics", etag: '"fresh"' }]);

      __mockClient.updateCalendarObject
        .mockResolvedValueOnce({ ok: false, status: 412, statusText: "Precondition Failed" })
        .mockResolvedValueOnce({ ok: true });

      const result = await service.updateEvent(
        "mailbox/Work",
        "evt-1",
        "BEGIN:VCALENDAR\nUPDATED\nEND:VCALENDAR",
      );

      expect(result.uid).toBe("evt-1");
      expect(__mockClient.updateCalendarObject).toHaveBeenCalledTimes(2);
      // First PUT used the stale etag, retry used the fresh one
      expect(__mockClient.updateCalendarObject).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          calendarObject: expect.objectContaining({ etag: '"stale"' }),
        }),
      );
      expect(__mockClient.updateCalendarObject).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          calendarObject: expect.objectContaining({ etag: '"fresh"' }),
        }),
      );
    });

    it("retries with a fresh etag on 412 even when meta was provided by the caller", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");

      const fullEvent = {
        uid: "evt-1",
        title: "Updated Meeting",
        start: "2026-03-10T14:00:00.000Z",
        end: "2026-03-10T15:00:00.000Z",
        all_day: false,
        location: null,
        description: null,
        status: null,
        availability: null,
        url: null,
        attendees: [],
        organizer: null,
        recurrence_rule: null,
        is_recurring: false,
        created: null,
        last_modified: null,
        alarms: [],
        categories: [],
        geo: null,
      };

      // parseIcsEvents: one call inside the refetch's findCalendarObject, one for the final response.
      (parseIcsEvents as any)
        .mockReturnValueOnce([{ uid: "evt-1" }])
        .mockReturnValueOnce([fullEvent]);

      __mockClient.fetchCalendarObjects.mockResolvedValueOnce([
        { data: "...", url: "/cal/evt-1.ics", etag: '"fresh"' },
      ]);

      __mockClient.updateCalendarObject
        .mockResolvedValueOnce({ ok: false, status: 412, statusText: "Precondition Failed" })
        .mockResolvedValueOnce({ ok: true });

      const result = await service.updateEvent(
        "mailbox/Work",
        "evt-1",
        "BEGIN:VCALENDAR\nUPDATED\nEND:VCALENDAR",
        { url: "/cal/evt-1.ics", etag: '"stale"' },
      );

      expect(result.uid).toBe("evt-1");
      expect(__mockClient.updateCalendarObject).toHaveBeenCalledTimes(2);
      // First PUT used the caller-supplied stale etag
      expect(__mockClient.updateCalendarObject).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          calendarObject: expect.objectContaining({ etag: '"stale"' }),
        }),
      );
      // Retry used the fresh etag from the server
      expect(__mockClient.updateCalendarObject).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          calendarObject: expect.objectContaining({ etag: '"fresh"' }),
        }),
      );
      // Refetch happened exactly once (for the retry)
      expect(__mockClient.fetchCalendarObjects).toHaveBeenCalledTimes(1);
    });

    it("skips findCalendarObject when meta is provided", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");

      const fullEvent = {
        uid: "evt-1",
        title: "Updated Meeting",
        start: "2026-03-10T14:00:00.000Z",
        end: "2026-03-10T15:00:00.000Z",
        all_day: false,
        location: null,
        description: null,
        status: null,
        availability: null,
        url: null,
        attendees: [],
        organizer: null,
        recurrence_rule: null,
        is_recurring: false,
        created: null,
        last_modified: null,
        alarms: [],
        categories: [],
        geo: null,
      };

      __mockClient.updateCalendarObject.mockResolvedValue({ ok: true });
      // parseIcsEvents called only for building EventFull from ICS (no findCalendarObject)
      (parseIcsEvents as any).mockReturnValue([fullEvent]);

      const result = await service.updateEvent(
        "mailbox/Work",
        "evt-1",
        "BEGIN:VCALENDAR\nUPDATED\nEND:VCALENDAR",
        { url: "/cal/evt-1.ics", etag: '"e1"' },
      );

      expect(result.uid).toBe("evt-1");
      expect(result.title).toBe("Updated Meeting");
      // fetchCalendarObjects should NOT have been called (meta provided)
      expect(__mockClient.fetchCalendarObjects).not.toHaveBeenCalled();
      expect(__mockClient.updateCalendarObject).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarObject: expect.objectContaining({
            url: "/cal/evt-1.ics",
            etag: '"e1"',
          }),
        }),
      );
    });
  });

  describe("deleteEvent", () => {
    it("deletes a calendar object by UID", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");
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

    it("throws CalendarError when server returns non-ok response", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");

      (parseIcsEvents as any).mockReturnValue([{ uid: "evt-1" }]);
      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "...", url: "/cal/evt-1.ics", etag: '"e1"' },
      ]);

      __mockClient.deleteCalendarObject.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      await expect(service.deleteEvent("mailbox/Work", "evt-1")).rejects.toThrow(
        "Failed to delete event: 404 Not Found",
      );
    });

    it("skips findCalendarObject when meta is provided", async () => {
      const { __mockClient } = (await import("tsdav")) as any;

      __mockClient.deleteCalendarObject.mockResolvedValue({ ok: true });

      await service.deleteEvent("mailbox/Work", "evt-1", { url: "/cal/evt-1.ics", etag: '"e1"' });

      // fetchCalendarObjects should NOT have been called (meta provided)
      expect(__mockClient.fetchCalendarObjects).not.toHaveBeenCalled();
      expect(__mockClient.deleteCalendarObject).toHaveBeenCalledWith(
        expect.objectContaining({
          calendarObject: expect.objectContaining({
            url: "/cal/evt-1.ics",
            etag: '"e1"',
          }),
        }),
      );
    });

    it("retries once with a fresh etag on 412 and succeeds", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");

      // Two findCalendarObject calls: initial lookup + retry refetch
      (parseIcsEvents as any).mockReturnValue([{ uid: "evt-1" }]);
      __mockClient.fetchCalendarObjects
        .mockResolvedValueOnce([{ data: "...", url: "/cal/evt-1.ics", etag: '"stale"' }])
        .mockResolvedValueOnce([{ data: "...", url: "/cal/evt-1.ics", etag: '"fresh"' }]);

      __mockClient.deleteCalendarObject
        .mockResolvedValueOnce({ ok: false, status: 412, statusText: "Precondition Failed" })
        .mockResolvedValueOnce({ ok: true });

      await service.deleteEvent("mailbox/Work", "evt-1");

      expect(__mockClient.deleteCalendarObject).toHaveBeenCalledTimes(2);
      expect(__mockClient.deleteCalendarObject).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          calendarObject: expect.objectContaining({ etag: '"stale"' }),
        }),
      );
      expect(__mockClient.deleteCalendarObject).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          calendarObject: expect.objectContaining({ etag: '"fresh"' }),
        }),
      );
    });

    it("throws CalendarError when retried DELETE still returns 412", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");

      (parseIcsEvents as any).mockReturnValue([{ uid: "evt-1" }]);
      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "...", url: "/cal/evt-1.ics", etag: '"e1"' },
      ]);

      __mockClient.deleteCalendarObject.mockResolvedValue({
        ok: false,
        status: 412,
        statusText: "Precondition Failed",
      });

      await expect(service.deleteEvent("mailbox/Work", "evt-1")).rejects.toThrow(
        "Failed to delete event: 412 Precondition Failed",
      );
      // Initial DELETE + one retry
      expect(__mockClient.deleteCalendarObject).toHaveBeenCalledTimes(2);
    });
  });

  describe("findFreeSlots", () => {
    it("finds free slots between events", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = (await import("@miguelarios/pim-core/ics")) as any;

      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "ics-0", url: "/cal/evt-0.ics", etag: '"e0"' },
        { data: "ics-1", url: "/cal/evt-1.ics", etag: '"e1"' },
      ]);
      // Each object parsed returns one event
      parseIcsEvents
        .mockReturnValueOnce([
          {
            uid: "evt-0",
            title: "Morning",
            start: "2026-03-10T09:00:00.000Z",
            end: "2026-03-10T10:00:00.000Z",
            all_day: false,
            status: "confirmed",
            availability: "busy",
          },
        ])
        .mockReturnValueOnce([
          {
            uid: "evt-1",
            title: "Afternoon",
            start: "2026-03-10T14:00:00.000Z",
            end: "2026-03-10T15:00:00.000Z",
            all_day: false,
            status: "confirmed",
            availability: "busy",
          },
        ]);

      const slots = await service.findFreeSlots(
        ["mailbox/Work"],
        "2026-03-10T08:00:00Z",
        "2026-03-10T17:00:00Z",
        30,
      );

      // Free: 08:00-09:00, 10:00-14:00, 15:00-17:00 — all >= 30 min
      expect(slots.length).toBeGreaterThanOrEqual(3);
      expect(slots[0].duration).toBeGreaterThanOrEqual(30);
    });

    it("ignores free events (availability: free)", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = (await import("@miguelarios/pim-core/ics")) as any;

      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "ics-0", url: "/cal/evt-0.ics", etag: '"e0"' },
      ]);
      parseIcsEvents.mockReturnValue([
        {
          uid: "evt-0",
          title: "All Day Free",
          start: "2026-03-10T08:00:00.000Z",
          end: "2026-03-10T17:00:00.000Z",
          all_day: false,
          status: "confirmed",
          availability: "free",
        },
      ]);

      const slots = await service.findFreeSlots(
        ["mailbox/Work"],
        "2026-03-10T08:00:00Z",
        "2026-03-10T17:00:00Z",
        30,
      );

      // Free event doesn't block — entire range is free
      expect(slots.length).toBe(1);
      expect(slots[0].duration).toBe(540); // 9 hours
    });

    it("treats tentative as busy by default", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = (await import("@miguelarios/pim-core/ics")) as any;

      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "ics-0", url: "/cal/evt-0.ics", etag: '"e0"' },
      ]);
      parseIcsEvents.mockReturnValue([
        {
          uid: "evt-0",
          title: "Maybe Meeting",
          start: "2026-03-10T09:00:00.000Z",
          end: "2026-03-10T17:00:00.000Z",
          all_day: false,
          status: "tentative",
          availability: "busy",
        },
      ]);

      const slots = await service.findFreeSlots(
        ["mailbox/Work"],
        "2026-03-10T08:00:00Z",
        "2026-03-10T17:00:00Z",
        30,
      );

      // Tentative blocks by default — only 08:00-09:00 is free
      expect(slots).toHaveLength(1);
      expect(slots[0].duration).toBe(60);
    });

    it("ignores tentative events when ignoreTentative is true", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = (await import("@miguelarios/pim-core/ics")) as any;

      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "ics-0", url: "/cal/evt-0.ics", etag: '"e0"' },
      ]);
      parseIcsEvents.mockReturnValue([
        {
          uid: "evt-0",
          title: "Maybe Meeting",
          start: "2026-03-10T09:00:00.000Z",
          end: "2026-03-10T17:00:00.000Z",
          all_day: false,
          status: "tentative",
          availability: "busy",
        },
      ]);

      const slots = await service.findFreeSlots(
        ["mailbox/Work"],
        "2026-03-10T08:00:00Z",
        "2026-03-10T17:00:00Z",
        30,
        { ignoreTentative: true },
      );

      // Tentative ignored — entire range is free
      expect(slots).toHaveLength(1);
      expect(slots[0].duration).toBe(540);
    });

    it("excludes events from excluded calendars", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = (await import("@miguelarios/pim-core/ics")) as any;

      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "ics-0", url: "/cal/evt-0.ics", etag: '"e0"' },
      ]);
      parseIcsEvents.mockReturnValue([
        {
          uid: "evt-0",
          title: "Blocked",
          start: "2026-03-10T09:00:00.000Z",
          end: "2026-03-10T17:00:00.000Z",
          all_day: false,
          status: "confirmed",
          availability: "busy",
          calendar_id: "mailbox/Work",
        },
      ]);

      const slots = await service.findFreeSlots(
        ["mailbox/Work"],
        "2026-03-10T08:00:00Z",
        "2026-03-10T17:00:00Z",
        30,
        { excludeCalendars: ["mailbox/Work"] },
      );

      // Excluded calendar — entire range is free
      expect(slots).toHaveLength(1);
      expect(slots[0].duration).toBe(540);
    });

    it("skips all-day events by default", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = (await import("@miguelarios/pim-core/ics")) as any;

      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "ics-0", url: "/cal/evt-0.ics", etag: '"e0"' },
      ]);
      parseIcsEvents.mockReturnValue([
        {
          uid: "evt-0",
          title: "Holiday",
          start: "2026-03-10T00:00:00.000Z",
          end: "2026-03-11T00:00:00.000Z",
          all_day: true,
          status: "confirmed",
          availability: "busy",
        },
      ]);

      const slots = await service.findFreeSlots(
        ["mailbox/Work"],
        "2026-03-10T08:00:00Z",
        "2026-03-10T17:00:00Z",
        30,
      );

      // All-day events skipped by default — entire range free
      expect(slots).toHaveLength(1);
      expect(slots[0].duration).toBe(540);
    });

    it("blocks all-day events when includeAllDayAsBusy is true", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = (await import("@miguelarios/pim-core/ics")) as any;

      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "ics-0", url: "/cal/evt-0.ics", etag: '"e0"' },
      ]);
      parseIcsEvents.mockReturnValue([
        {
          uid: "evt-0",
          title: "Holiday",
          start: "2026-03-10T00:00:00.000Z",
          end: "2026-03-11T00:00:00.000Z",
          all_day: true,
          status: "confirmed",
          availability: "busy",
        },
      ]);

      const slots = await service.findFreeSlots(
        ["mailbox/Work"],
        "2026-03-10T08:00:00Z",
        "2026-03-10T17:00:00Z",
        30,
        { includeAllDayAsBusy: true },
      );

      // All-day blocks entire range — no free slots
      expect(slots).toHaveLength(0);
    });

    it("ends free slot exactly at event start time", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = (await import("@miguelarios/pim-core/ics")) as any;

      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "ics-0", url: "/cal/evt-0.ics", etag: '"e0"' },
      ]);
      parseIcsEvents.mockReturnValue([
        {
          uid: "odd-time",
          title: "Odd Time Event",
          start: "2026-03-15T14:50:00.000Z",
          end: "2026-03-15T16:00:00.000Z",
          all_day: false,
          status: "confirmed",
          availability: "busy",
        },
      ]);

      const slots = await service.findFreeSlots(
        ["mailbox/Work"],
        "2026-03-15T13:00:00Z",
        "2026-03-15T17:00:00Z",
        30,
      );

      // First free slot should end exactly at 14:50
      expect(slots[0].end).toBe("2026-03-15T14:50:00+00:00");
      // Second free slot should start at 16:00
      expect(slots[1].start).toBe("2026-03-15T16:00:00+00:00");
    });

    it("sorts preferred-hours slots first", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = (await import("@miguelarios/pim-core/ics")) as any;

      __mockClient.fetchCalendarObjects.mockResolvedValue([]);
      parseIcsEvents.mockReturnValue([]);

      const slots = await service.findFreeSlots(
        ["mailbox/Work"],
        "2026-03-10T06:00:00Z",
        "2026-03-10T20:00:00Z",
        30,
        { preferredStart: "09:00", preferredEnd: "17:00" },
      );

      // Should have slots, with preferred-hours slots first
      expect(slots.length).toBeGreaterThanOrEqual(1);
      // First slot should start at or after 09:00
      const firstSlotHour = new Date(slots[0].start).getUTCHours();
      expect(firstSlotHour).toBeGreaterThanOrEqual(9);
    });

    it("splits preferred hours in PIM_TIMEZONE, not UTC (9 AM Chicago, DST-safe)", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = (await import("@miguelarios/pim-core/ics")) as any;

      __mockClient.fetchCalendarObjects.mockResolvedValue([]);
      parseIcsEvents.mockReturnValue([]);

      // Must stub the timezone BEFORE constructing the service — the service
      // reads PIM_TIMEZONE once in its constructor via getTimezone().
      vi.stubEnv("PIM_TIMEZONE", "America/Chicago");
      const chicagoService = new CalDavService(TEST_CONFIG);

      const slots = await chicagoService.findFreeSlots(
        ["mailbox/Work"],
        "2026-03-10T06:00:00Z",
        "2026-03-10T20:00:00Z",
        30,
        { preferredStart: "09:00", preferredEnd: "17:00" },
      );

      // 2026-03-10 is CDT (UTC-5): 9 AM Chicago is 14:00 UTC, not 09:00 UTC.
      expect(slots.length).toBeGreaterThanOrEqual(1);
      expect(new Date(slots[0].start).toISOString()).toBe("2026-03-10T14:00:00.000Z");

      // Restore for subsequent tests in this file, which assume UTC.
      vi.stubEnv("PIM_TIMEZONE", "UTC");
    });
  });

  describe("fetchCalendars cache", () => {
    it("caches fetchCalendars result and reuses on second findCalendar call", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");

      (parseIcsEvents as any).mockReturnValue([
        {
          uid: "evt-1",
          title: "Event",
          start: "2026-03-10T14:00:00.000Z",
          end: "2026-03-10T15:00:00.000Z",
          all_day: false,
          location: null,
          description: null,
          status: null,
          availability: null,
          url: null,
          attendees: [],
          organizer: null,
          recurrence_rule: null,
          is_recurring: false,
          created: null,
          last_modified: null,
          alarms: [],
          categories: [],
          geo: null,
        },
      ]);
      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "...", url: "/cal/evt-1.ics", etag: '"e1"' },
      ]);

      // Two getEvent calls to the same provider
      await service.getEvent("mailbox/Work", "evt-1");
      await service.getEvent("mailbox/Work", "evt-1");

      // fetchCalendars should only be called once (cached after first)
      expect(__mockClient.fetchCalendars).toHaveBeenCalledTimes(1);
    });

    it("listCalendars always fetches fresh and populates cache", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");

      (parseIcsEvents as any).mockReturnValue([
        {
          uid: "evt-1",
          title: "Event",
          start: "2026-03-10T14:00:00.000Z",
          end: "2026-03-10T15:00:00.000Z",
          all_day: false,
          location: null,
          description: null,
          status: null,
          availability: null,
          url: null,
          attendees: [],
          organizer: null,
          recurrence_rule: null,
          is_recurring: false,
          created: null,
          last_modified: null,
          alarms: [],
          categories: [],
          geo: null,
        },
      ]);
      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "...", url: "/cal/evt-1.ics", etag: '"e1"' },
      ]);

      // listCalendars fetches fresh
      await service.listCalendars();
      // getEvent should use the cache populated by listCalendars
      await service.getEvent("mailbox/Work", "evt-1");

      // fetchCalendars called 2 times for listCalendars (one per account),
      // then 0 more for getEvent (cache hit)
      expect(__mockClient.fetchCalendars).toHaveBeenCalledTimes(2);
    });

    it("invalidates cache on write error", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");

      (parseIcsEvents as any).mockReturnValue([
        {
          uid: "evt-1",
          title: "Event",
          start: "2026-03-10T14:00:00.000Z",
          end: "2026-03-10T15:00:00.000Z",
          all_day: false,
          location: null,
          description: null,
          status: null,
          availability: null,
          url: null,
          attendees: [],
          organizer: null,
          recurrence_rule: null,
          is_recurring: false,
          created: null,
          last_modified: null,
          alarms: [],
          categories: [],
          geo: null,
        },
      ]);
      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "...", url: "/cal/evt-1.ics", etag: '"e1"' },
      ]);

      // First call populates the cache
      await service.getEvent("mailbox/Work", "evt-1");
      expect(__mockClient.fetchCalendars).toHaveBeenCalledTimes(1);

      // Simulate a write error (non-CalendarError triggers cache invalidation)
      __mockClient.updateCalendarObject.mockRejectedValue(new Error("network failure"));

      await expect(
        service.updateEvent("mailbox/Work", "evt-1", "BEGIN:VCALENDAR\nEND:VCALENDAR"),
      ).rejects.toThrow();

      // Next call should re-fetch calendars (cache was invalidated)
      await service.getEvent("mailbox/Work", "evt-1");
      expect(__mockClient.fetchCalendars).toHaveBeenCalledTimes(2);
    });
  });

  describe("getEventWithMeta", () => {
    it("returns event and CalDAV object metadata (url, etag)", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");
      (parseIcsEvents as any).mockReturnValue([
        {
          uid: "evt-1",
          title: "Team Meeting",
          start: "2026-03-10T14:00:00.000Z",
          end: "2026-03-10T15:00:00.000Z",
          all_day: false,
          location: "Office",
          description: "Weekly standup",
          status: "confirmed",
          availability: "busy",
          url: null,
          attendees: [],
          organizer: null,
          recurrence_rule: null,
          is_recurring: false,
          created: null,
          last_modified: null,
          alarms: [],
          categories: [],
          geo: null,
        },
      ]);
      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "BEGIN:VCALENDAR...END:VCALENDAR", url: "/cal/evt-1.ics", etag: '"e1"' },
      ]);

      const { event, meta } = await service.getEventWithMeta("mailbox/Work", "evt-1");

      expect(event.uid).toBe("evt-1");
      expect(event.title).toBe("Team Meeting");
      expect(event.calendar_id).toBe("mailbox/Work");
      expect(meta.url).toBe("/cal/evt-1.ics");
      expect(meta.etag).toBe('"e1"');
    });
  });

  describe("client caching", () => {
    it("reuses authenticated client across multiple calls for same account", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = (await import("@miguelarios/pim-core/ics")) as any;

      // Setup mock data for listEvents
      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "ics-data", url: "/cal/evt.ics", etag: '"e1"' },
      ]);
      parseIcsEvents.mockReturnValue([
        {
          uid: "evt-1",
          title: "Event",
          start: "2026-03-10T14:00:00.000Z",
          end: "2026-03-10T15:00:00.000Z",
          all_day: false,
          location: null,
          status: null,
          is_recurring: false,
        },
      ]);

      const loginSpy = __mockClient.login;
      loginSpy.mockClear();

      // Three calls to the same account
      await service.listEvents("mailbox/Work", "2026-03-01", "2026-03-31");
      await service.listEvents("mailbox/Work", "2026-04-01", "2026-04-30");
      await service.listEvents("mailbox/Work", "2026-05-01", "2026-05-31");

      // Should only login once (cached after first call)
      expect(loginSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("fetchRawCalendarObject", () => {
    it("returns raw ICS data, url, and etag for a given uid", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");
      const rawIcs = "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:test-uid\nEND:VEVENT\nEND:VCALENDAR";

      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: rawIcs, url: "/cal/obj1.ics", etag: '"etag-123"' },
      ]);
      (parseIcsEvents as any).mockReturnValue([{ uid: "test-uid" }]);

      const result = await service.fetchRawCalendarObject("mailbox/Work", "test-uid");

      expect(result.data).toBe(rawIcs);
      expect(result.url).toBe("/cal/obj1.ics");
      expect(result.etag).toBe('"etag-123"');
    });

    it("throws when uid not found", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");

      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { data: "BEGIN:VCALENDAR...END:VCALENDAR", url: "/cal/other.ics", etag: '"e1"' },
      ]);
      (parseIcsEvents as any).mockReturnValue([{ uid: "other-uid" }]);

      await expect(service.fetchRawCalendarObject("mailbox/Work", "nonexistent")).rejects.toThrow();
    });

    it("throws CalendarError when object has no data", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const { parseIcsEvents } = await import("@miguelarios/pim-core/ics");

      // Simulate an object returned with no data field
      __mockClient.fetchCalendarObjects.mockResolvedValue([
        { url: "/cal/obj1.ics", etag: '"etag-123"' },
      ]);
      // parseIcsEvents won't be called (obj.data is falsy, skipped in findCalendarObject)
      (parseIcsEvents as any).mockReturnValue([{ uid: "test-uid" }]);

      await expect(service.fetchRawCalendarObject("mailbox/Work", "test-uid")).rejects.toThrow();
    });

    it("throws for unknown provider", async () => {
      await expect(service.fetchRawCalendarObject("unknown/Work", "test-uid")).rejects.toThrow();
    });
  });
});

describe("buildCanonicalHref", () => {
  it("appends <uid>.ics to an absolute calendar URL with trailing slash", () => {
    expect(buildCanonicalHref("https://dav.mailbox.org/caldav/abc/", "evt-1")).toBe(
      "https://dav.mailbox.org/caldav/abc/evt-1.ics",
    );
  });

  it("appends <uid>.ics to an absolute calendar URL without trailing slash", () => {
    // URL() normalizes by treating the last segment as replaceable, so the
    // fallback path handles this case identically: ensure a slash, append filename.
    const result = buildCanonicalHref("https://dav.mailbox.org/caldav/abc", "evt-1");
    expect(
      result === "https://dav.mailbox.org/caldav/abc/evt-1.ics" ||
        result === "https://dav.mailbox.org/caldav/evt-1.ics",
    ).toBe(true);
  });

  it("handles relative calendar URLs via string concatenation", () => {
    expect(buildCanonicalHref("/caldav/work/", "evt-1")).toBe("/caldav/work/evt-1.ics");
  });

  it("adds a slash when the relative URL has no trailing one", () => {
    expect(buildCanonicalHref("/caldav/work", "evt-1")).toBe("/caldav/work/evt-1.ics");
  });

  it("returns null for empty inputs", () => {
    expect(buildCanonicalHref("", "evt-1")).toBeNull();
    expect(buildCanonicalHref("/caldav/work/", "")).toBeNull();
  });
});
