/**
 * An all-day event blocks its day where the user is (PIM_TIMEZONE), not the
 * UTC day it is anchored to, which ends at 6 PM in Chicago. Runs the real
 * ICS parser; only tsdav is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//t//EN",
  "BEGIN:VEVENT",
  "UID:ooo",
  "DTSTAMP:20260101T000000Z",
  "DTSTART;VALUE=DATE:20261116",
  "DTEND;VALUE=DATE:20261117",
  "SUMMARY:Out of office",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

vi.mock("tsdav", () => {
  const client = {
    login: vi.fn().mockResolvedValue(undefined),
    fetchCalendars: vi.fn().mockResolvedValue([
      {
        displayName: "Work",
        url: "https://dav.example/caldav/work/",
        ctag: "1",
        components: ["VEVENT"],
      },
    ]),
    fetchCalendarObjects: vi.fn(),
  };
  return { DAVClient: vi.fn().mockImplementation(() => client), __client: client };
});

async function service() {
  const { __client } = (await import("tsdav")) as unknown as {
    __client: { fetchCalendarObjects: ReturnType<typeof vi.fn> };
  };
  __client.fetchCalendarObjects.mockResolvedValue([
    { url: "https://dav.example/caldav/work/ooo.ics", etag: "e", data: ICS },
  ]);
  const { CalDavService } = await import("../services/CalDavService.js");
  return new CalDavService({
    accounts: [{ id: "mb", url: "https://dav.example/caldav/", username: "u", password: "p" }],
  });
}

describe("all-day events block the local day", () => {
  beforeEach(() => {
    vi.stubEnv("PIM_TIMEZONE", "America/Chicago");
    // The server declines free-busy-query, so the busy time is computed.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 501,
        headers: new Headers(),
        text: async () => "",
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("find_free_slots offers nothing on the day", async () => {
    const s = await service();
    // 8 AM to 8 PM Chicago on Nov 16.
    const slots = await s.findFreeSlots(
      ["mb/Work"],
      "2026-11-16T14:00:00.000Z",
      "2026-11-17T02:00:00.000Z",
      60,
      { includeAllDayAsBusy: true },
    );
    expect(slots).toEqual([]);
  });

  it("get_free_busy reports local midnight to local midnight", async () => {
    const s = await service();
    const { busy } = await s.getFreeBusy(
      ["mb/Work"],
      "2026-11-15T06:00:00.000Z",
      "2026-11-18T06:00:00.000Z",
      { includeAllDayAsBusy: true },
    );
    expect(busy).toEqual([
      { start: "2026-11-16T06:00:00.000Z", end: "2026-11-17T06:00:00.000Z", type: "busy" },
    ]);
  });

  it("covers the whole day east of UTC too", async () => {
    vi.stubEnv("PIM_TIMEZONE", "Europe/Berlin");
    const s = await service();
    const { busy } = await s.getFreeBusy(
      ["mb/Work"],
      "2026-11-14T23:00:00.000Z",
      "2026-11-17T23:00:00.000Z",
      { includeAllDayAsBusy: true },
    );
    expect(busy).toEqual([
      { start: "2026-11-15T23:00:00.000Z", end: "2026-11-16T23:00:00.000Z", type: "busy" },
    ]);
  });
});

describe("all-day events in local ranges (#165 review)", () => {
  beforeEach(() => vi.stubEnv("PIM_TIMEZONE", "America/Chicago"));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function serviceWith(ics: string) {
    const { __client } = (await import("tsdav")) as unknown as {
      __client: { fetchCalendarObjects: ReturnType<typeof vi.fn> };
    };
    __client.fetchCalendarObjects.mockResolvedValue([
      { url: "https://dav.example/caldav/work/x.ics", etag: "e", data: ics },
    ]);
    const { CalDavService } = await import("../services/CalDavService.js");
    return {
      client: __client,
      s: new CalDavService({
        accounts: [{ id: "mb", url: "https://dav.example/caldav/", username: "u", password: "p" }],
      }),
    };
  }

  const WEEKLY = ICS.replace(
    "SUMMARY:Out of office",
    "RRULE:FREQ=WEEKLY;COUNT=3\r\nSUMMARY:Out of office",
  );

  it("lists a recurring all-day occurrence for its local day", async () => {
    const { s } = await serviceWith(WEEKLY);
    const events = await s.listEvents(
      "mb/Work",
      "2026-11-16T06:00:00.000Z",
      "2026-11-17T06:00:00.000Z",
    );
    expect(events.map((e) => e.start)).toEqual(["2026-11-16T00:00:00.000Z"]);
  });

  it("does not list an all-day event for the local day after it", async () => {
    const { s } = await serviceWith(ICS);
    const events = await s.listEvents(
      "mb/Work",
      "2026-11-17T06:00:00.000Z",
      "2026-11-18T06:00:00.000Z",
    );
    expect(events).toEqual([]);
  });

  it("blocks a recurring out-of-office day in find_free_slots", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 501,
        headers: new Headers(),
        text: async () => "",
      }),
    );
    const { s } = await serviceWith(WEEKLY);
    const slots = await s.findFreeSlots(
      ["mb/Work"],
      "2026-11-16T14:00:00.000Z",
      "2026-11-17T02:00:00.000Z",
      60,
      {
        includeAllDayAsBusy: true,
      },
    );
    expect(slots).toEqual([]);
  });

  it("asks the server a day wider than the range, so it cannot drop an all-day event read as UTC", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 501,
        headers: new Headers(),
        text: async () => "",
      }),
    );
    const { s, client } = await serviceWith(ICS);
    // 6 PM to 11 PM Chicago on the out-of-office day.
    const slots = await s.findFreeSlots(
      ["mb/Work"],
      "2026-11-17T00:00:00.000Z",
      "2026-11-17T05:00:00.000Z",
      60,
      {
        includeAllDayAsBusy: true,
      },
    );
    expect(client.fetchCalendarObjects.mock.lastCall?.[0].timeRange).toEqual({
      start: "2026-11-16T00:00:00.000Z",
      end: "2026-11-18T05:00:00.000Z",
    });
    expect(slots).toEqual([]);
  });
});
