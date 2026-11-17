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
