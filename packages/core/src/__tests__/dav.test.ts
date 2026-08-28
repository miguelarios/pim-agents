import { describe, expect, it } from "vitest";
import { checkDavCollectionResponse, propstatStatusLines } from "../dav.js";
import { CalendarError, ContactError, ErrorCode, type PimError } from "../errors.js";

const calendarOpts = {
  resource: "calendar",
  notFound: (url: string): PimError =>
    new CalendarError(`Calendar not found: ${url}`, ErrorCode.CALENDAR_NOT_FOUND),
  failed: (message: string): PimError => new CalendarError(message, ErrorCode.OPERATION_FAILED),
};

const bookOpts = {
  resource: "address book",
  notFound: (url: string): PimError =>
    new ContactError(`Address book not found: ${url}`, ErrorCode.ADDRESSBOOK_NOT_FOUND),
  failed: (message: string): PimError => new ContactError(message, ErrorCode.OPERATION_FAILED),
};

const URL_ = "/caldav/work/";

/** A tsdav parsed-branch response whose real verdict lives in propstat only. */
const multistatus = (statusLines: string[]) => ({
  ok: true,
  status: 207,
  statusText: "Multi-Status",
  raw: {
    multistatus: {
      response: { propstat: statusLines.map((status) => ({ status, prop: {} })) },
    },
  },
});

describe("propstatStatusLines", () => {
  it("returns nothing for a body with no multistatus", () => {
    expect(propstatStatusLines(undefined)).toEqual([]);
    expect(propstatStatusLines(null)).toEqual([]);
    expect(propstatStatusLines({})).toEqual([]);
    expect(propstatStatusLines({ multistatus: {} })).toEqual([]);
  });

  it("reads a single response with a single propstat", () => {
    expect(
      propstatStatusLines({
        multistatus: { response: { propstat: { status: "HTTP/1.1 200 OK" } } },
      }),
    ).toEqual(["HTTP/1.1 200 OK"]);
  });

  it("reads arrays of responses and of propstats", () => {
    expect(
      propstatStatusLines({
        multistatus: {
          response: [
            { propstat: [{ status: "HTTP/1.1 200 OK" }, { status: "HTTP/1.1 403 Forbidden" }] },
            { propstat: { status: "HTTP/1.1 424 Failed Dependency" } },
          ],
        },
      }),
    ).toEqual(["HTTP/1.1 200 OK", "HTTP/1.1 403 Forbidden", "HTTP/1.1 424 Failed Dependency"]);
  });

  it("skips responses with no propstat and non-string statuses", () => {
    expect(
      propstatStatusLines({
        multistatus: {
          response: [{ href: "/x/" }, { propstat: { status: 200 } }],
        },
      }),
    ).toEqual([]);
  });
});

describe("checkDavCollectionResponse", () => {
  it("accepts a plain 2xx", () => {
    expect(() =>
      checkDavCollectionResponse(
        { status: 201, statusText: "Created" },
        "create",
        URL_,
        calendarOpts,
      ),
    ).not.toThrow();
  });

  it("accepts a 207 whose propstat statuses are all 2xx", () => {
    expect(() =>
      checkDavCollectionResponse(multistatus(["HTTP/1.1 200 OK"]), "update", URL_, calendarOpts),
    ).not.toThrow();
  });

  it("fails a 207 whose propstat status is a failure, though the mapped status is 2xx", () => {
    // The whole reason this helper exists: tsdav reports ok:true / status:207.
    expect(() =>
      checkDavCollectionResponse(
        multistatus(["HTTP/1.1 403 Forbidden"]),
        "update",
        URL_,
        calendarOpts,
      ),
    ).toThrow(/refused to update .* may be read-only/);
  });

  it("fails a 207 with a mix of passing and failing propstats", () => {
    expect(() =>
      checkDavCollectionResponse(
        multistatus(["HTTP/1.1 200 OK", "HTTP/1.1 424 Failed Dependency"]),
        "update",
        URL_,
        calendarOpts,
      ),
    ).toThrow(/HTTP 424/);
  });

  it("refuses a 207 with no readable per-property status rather than assuming success", () => {
    expect(() =>
      checkDavCollectionResponse(
        { ok: true, status: 207, statusText: "Multi-Status" },
        "update",
        URL_,
        calendarOpts,
      ),
    ).toThrow(/no readable per-property status/);
  });

  it("refuses a response carrying no status at all", () => {
    for (const response of [undefined, null, {}, { ok: true }]) {
      expect(() => checkDavCollectionResponse(response, "delete", URL_, calendarOpts)).toThrow(
        /no usable status/,
      );
    }
  });

  it("maps 404 through the caller's notFound factory", () => {
    try {
      checkDavCollectionResponse({ status: 404 }, "delete", URL_, calendarOpts);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as PimError).code).toBe(ErrorCode.CALENDAR_NOT_FOUND);
      expect((err as PimError).message).toContain(URL_);
    }
  });

  it("names the parent collection on a create 404, not the resource", () => {
    expect(() => checkDavCollectionResponse({ status: 404 }, "create", URL_, calendarOpts)).toThrow(
      /parent collection does not exist/,
    );
  });

  it("maps a create 405 to 'a collection already exists'", () => {
    expect(() => checkDavCollectionResponse({ status: 405 }, "create", URL_, calendarOpts)).toThrow(
      /collection already exists/,
    );
  });

  it.each([403, 501])("maps a create %i to unsupported-by-provider, pluralised", (status) => {
    expect(() => checkDavCollectionResponse({ status }, "create", URL_, calendarOpts)).toThrow(
      `The provider does not allow creating calendars here (HTTP ${status})`,
    );
    expect(() => checkDavCollectionResponse({ status }, "create", URL_, bookOpts)).toThrow(
      `The provider does not allow creating address books here (HTTP ${status})`,
    );
  });

  it("maps a non-create 403 to a read-only hint naming the action", () => {
    expect(() => checkDavCollectionResponse({ status: 403 }, "delete", URL_, calendarOpts)).toThrow(
      "The server refused to delete /caldav/work/ — the calendar may be read-only (HTTP 403)",
    );
  });

  it("falls through to status and statusText for anything else", () => {
    try {
      checkDavCollectionResponse(
        { status: 507, statusText: "Insufficient Storage" },
        "create",
        URL_,
        calendarOpts,
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as PimError).message).toBe(
        "Failed to create calendar /caldav/work/: HTTP 507 Insufficient Storage",
      );
      expect((err as PimError).code).toBe(ErrorCode.OPERATION_FAILED);
    }
  });

  it("keeps each server's own not-found vocabulary", () => {
    try {
      checkDavCollectionResponse({ status: 404 }, "rename", "/dav/work/", bookOpts);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as PimError).code).toBe(ErrorCode.ADDRESSBOOK_NOT_FOUND);
    }
  });
});
