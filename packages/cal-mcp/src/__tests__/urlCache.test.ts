import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteCachedObject,
  getCachedObject,
  moveCachedCalendar,
  purgeCachedCalendar,
  setCachedObject,
} from "../services/urlCache.js";

// The cache is a real file under XDG_CACHE_HOME; point it at a temp dir so
// these tests never touch the developer's own cache.
let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), "cal-mcp-cache-"));
  vi.stubEnv("XDG_CACHE_HOME", cacheDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(cacheDir, { recursive: true, force: true });
});

describe("urlCache basics", () => {
  it("round-trips an entry", () => {
    setCachedObject("mailbox/Work", "evt-1", { url: "/caldav/work/evt-1.ics", etag: "e1" });
    expect(getCachedObject("mailbox/Work", "evt-1")).toEqual({
      url: "/caldav/work/evt-1.ics",
      etag: "e1",
    });
  });

  it("returns null for anything it has not seen", () => {
    expect(getCachedObject("mailbox/Work", "nope")).toBeNull();
    deleteCachedObject("mailbox/Work", "nope");
  });
});

describe("moveCachedCalendar", () => {
  it("rekeys every entry onto the new calendar_id", () => {
    setCachedObject("mailbox/Work", "evt-1", { url: "/caldav/work/evt-1.ics", etag: "e1" });
    setCachedObject("mailbox/Work", "evt-2", { url: "/caldav/work/evt-2.ics" });

    moveCachedCalendar("mailbox/Work", "mailbox/Team");

    // The object URLs are untouched by a rename — only the key was stale.
    expect(getCachedObject("mailbox/Team", "evt-1")).toEqual({
      url: "/caldav/work/evt-1.ics",
      etag: "e1",
    });
    expect(getCachedObject("mailbox/Team", "evt-2")).toEqual({ url: "/caldav/work/evt-2.ics" });
    expect(getCachedObject("mailbox/Work", "evt-1")).toBeNull();
  });

  it("leaves other calendars alone", () => {
    setCachedObject("mailbox/Work", "evt-1", { url: "/a.ics" });
    setCachedObject("mailbox/Personal", "evt-2", { url: "/b.ics" });

    moveCachedCalendar("mailbox/Work", "mailbox/Team");

    expect(getCachedObject("mailbox/Personal", "evt-2")).toEqual({ url: "/b.ics" });
  });

  it("prefers entries already filed under the destination", () => {
    // A name reused after an earlier rename: the destination's own entries were
    // written against the URLs that name resolves to now, so they win.
    setCachedObject("mailbox/Work", "evt-1", { url: "/caldav/work/evt-1.ics" });
    setCachedObject("mailbox/Team", "evt-1", { url: "/caldav/team/evt-1.ics" });

    moveCachedCalendar("mailbox/Work", "mailbox/Team");

    expect(getCachedObject("mailbox/Team", "evt-1")).toEqual({ url: "/caldav/team/evt-1.ics" });
  });

  it("is a no-op when the ID did not change, or when there is nothing to move", () => {
    setCachedObject("mailbox/Work", "evt-1", { url: "/a.ics" });
    moveCachedCalendar("mailbox/Work", "mailbox/Work");
    expect(getCachedObject("mailbox/Work", "evt-1")).toEqual({ url: "/a.ics" });

    expect(() => moveCachedCalendar("mailbox/Ghost", "mailbox/Other")).not.toThrow();
    expect(getCachedObject("mailbox/Other", "evt-1")).toBeNull();
  });
});

describe("purgeCachedCalendar", () => {
  it("drops every entry for the calendar and nothing else", () => {
    setCachedObject("mailbox/Work", "evt-1", { url: "/a.ics" });
    setCachedObject("mailbox/Work", "evt-2", { url: "/b.ics" });
    setCachedObject("mailbox/Personal", "evt-3", { url: "/c.ics" });

    purgeCachedCalendar("mailbox/Work");

    expect(getCachedObject("mailbox/Work", "evt-1")).toBeNull();
    expect(getCachedObject("mailbox/Work", "evt-2")).toBeNull();
    expect(getCachedObject("mailbox/Personal", "evt-3")).toEqual({ url: "/c.ics" });
  });

  it("is a no-op for a calendar with no entries", () => {
    expect(() => purgeCachedCalendar("mailbox/Ghost")).not.toThrow();
  });
});
