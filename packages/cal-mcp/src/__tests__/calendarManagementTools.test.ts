import { CalendarError, ErrorCode, ValidationError } from "@miguelarios/pim-core";
import type { ServerContext } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { CALENDAR_MANAGEMENT_TOOLS } from "../tools/calendarManagementTools.js";

/** Minimal handler context: no multi-round-trip input responses carried. */
const emptyCtx = { mcpReq: { inputResponses: undefined } } as unknown as ServerContext;

const confirmCtx = (key: string, answer: unknown) =>
  ({ mcpReq: { inputResponses: { [key]: answer } } }) as unknown as ServerContext;

/** Invokes one tool's handler directly, bypassing the MCP transport. */
function callTool(
  name: string,
  args: Record<string, unknown>,
  service: unknown,
  ctx: ServerContext = emptyCtx,
) {
  const tool = CALENDAR_MANAGEMENT_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  // test-only invocation of a heterogeneous handler
  return tool.handler(args as any, service as any, ctx) as Promise<any>;
}

const notFound = (message: string) => new CalendarError(message, ErrorCode.CALENDAR_NOT_FOUND);

const fakeService = () => ({
  listProviders: vi.fn().mockReturnValue(["mailbox", "nextcloud"]),
  findCalendarEntry: vi.fn().mockResolvedValue({
    calendar_id: "mailbox/Work",
    display_name: "Work",
    url: "/caldav/work/",
    provider: "mailbox",
  }),
  countCalendarObjects: vi.fn().mockResolvedValue(214),
  createCalendar: vi.fn().mockResolvedValue({
    calendar_id: "mailbox/Team",
    display_name: "Team",
    url: "/caldav/team/",
    provider: "mailbox",
  }),
  updateCalendarMeta: vi.fn().mockResolvedValue({
    calendar_id: "mailbox/Team",
    display_name: "Team",
    url: "/caldav/work/",
    provider: "mailbox",
  }),
  deleteCalendar: vi.fn().mockResolvedValue({
    calendar_id: "mailbox/Work",
    display_name: "Work",
    url: "/caldav/work/",
    provider: "mailbox",
  }),
});

describe("CALENDAR_MANAGEMENT_TOOLS definitions", () => {
  it("defines the management and sharing tools with complete annotations", () => {
    expect(CALENDAR_MANAGEMENT_TOOLS.map((t) => t.name)).toEqual([
      "create_calendar",
      "update_calendar",
      "delete_calendar",
      "get_calendar_sharing",
      "share_calendar",
      "unshare_calendar",
    ]);
    for (const tool of CALENDAR_MANAGEMENT_TOOLS) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.outputSchema, tool.name).toBeDefined();
      for (const hint of [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ] as const) {
        expect(typeof tool.annotations[hint], `${tool.name}.${hint}`).toBe("boolean");
      }
    }
  });

  it("marks only delete_calendar and unshare_calendar destructive", () => {
    const destructive = CALENDAR_MANAGEMENT_TOOLS.filter((t) => t.annotations.destructiveHint);
    expect(destructive.map((t) => t.name)).toEqual(["delete_calendar", "unshare_calendar"]);
  });

  it("marks get_calendar_sharing read-only and nothing else", () => {
    const readOnly = CALENDAR_MANAGEMENT_TOOLS.filter((t) => t.annotations.readOnlyHint);
    expect(readOnly.map((t) => t.name)).toEqual(["get_calendar_sharing"]);
  });

  it("requires the target on every write tool — no first-calendar fallback", () => {
    for (const [name, required] of [
      ["create_calendar", "display_name"],
      ["update_calendar", "calendar"],
      ["delete_calendar", "calendar"],
    ] as const) {
      const tool = CALENDAR_MANAGEMENT_TOOLS.find((t) => t.name === name)!;
      expect((tool.inputSchema as { required?: string[] }).required, name).toContain(required);
    }
  });

  it("leaves provider optional on create — it defaults only when unambiguous", () => {
    const tool = CALENDAR_MANAGEMENT_TOOLS.find((t) => t.name === "create_calendar")!;
    expect((tool.inputSchema as { required?: string[] }).required).not.toContain("provider");
  });
});

describe("create_calendar", () => {
  it("passes snake_case args through as the service's camelCase options", async () => {
    const service = fakeService();
    const res = await callTool(
      "create_calendar",
      {
        provider: "mailbox",
        display_name: "Team",
        description: "Shared",
        color: "#3B82F6",
        slug: "team",
      },
      service,
    );
    expect(service.createCalendar).toHaveBeenCalledWith({
      provider: "mailbox",
      displayName: "Team",
      description: "Shared",
      color: "#3B82F6",
      slug: "team",
    });
    expect(res.structuredContent).toEqual({
      status: "created",
      calendar_id: "mailbox/Team",
      url: "/caldav/team/",
      display_name: "Team",
    });
  });

  it("forwards an absent provider rather than inventing one", async () => {
    const service = fakeService();
    await callTool("create_calendar", { display_name: "Team" }, service);
    expect(service.createCalendar).toHaveBeenCalledWith(
      expect.objectContaining({ provider: undefined }),
    );
  });

  it("reports a caller-fixable failure as VALIDATION_FAILED, not a server error", async () => {
    const service = fakeService();
    service.createCalendar.mockRejectedValue(
      new ValidationError('Invalid color "blue" — use #RRGGBB or #RRGGBBAA (e.g. #3B82F6)'),
    );
    const res = await callTool("create_calendar", { display_name: "Team", color: "blue" }, service);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.error).toBe("VALIDATION_FAILED");
    expect(parsed.message).toContain("#RRGGBB");
  });
});

describe("update_calendar", () => {
  it("returns the post-rename calendar_id, not the one it was given", async () => {
    const service = fakeService();
    const res = await callTool(
      "update_calendar",
      { calendar: "mailbox/Work", display_name: "Team" },
      service,
    );
    expect(service.updateCalendarMeta).toHaveBeenCalledWith("mailbox/Work", {
      displayName: "Team",
      description: undefined,
      color: undefined,
    });
    expect(res.structuredContent.calendar_id).toBe("mailbox/Team");
    expect(res.structuredContent.status).toBe("updated");
  });

  it("surfaces an empty update as VALIDATION_FAILED", async () => {
    const service = fakeService();
    service.updateCalendarMeta.mockRejectedValue(
      new ValidationError(
        "Nothing to change — provide a display_name, color, description, timezone and/or order",
      ),
    );
    const res = await callTool("update_calendar", { calendar: "mailbox/Work" }, service);
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe("VALIDATION_FAILED");
  });

  it("surfaces an unknown calendar as CALENDAR_NOT_FOUND", async () => {
    const service = fakeService();
    service.updateCalendarMeta.mockRejectedValue(notFound('Calendar "Nope" not found'));
    const res = await callTool(
      "update_calendar",
      { calendar: "mailbox/Nope", color: "#000000" },
      service,
    );
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe("CALENDAR_NOT_FOUND");
  });
});

describe("delete_calendar", () => {
  it("asks for confirmation before deleting anything", async () => {
    const service = fakeService();
    const res = await callTool("delete_calendar", { calendar: "mailbox/Work" }, service);
    expect(res.resultType).toBe("input_required");
    expect(service.deleteCalendar).not.toHaveBeenCalled();
  });

  it("names the calendar, its provider, and its event count in the prompt", async () => {
    const service = fakeService();
    const res = await callTool("delete_calendar", { calendar: "mailbox/Work" }, service);
    const message = res.inputRequests.confirm_delete_calendar.params.message as string;
    expect(message).toContain('"Work"');
    expect(message).toContain('provider "mailbox"');
    expect(message).toContain("all 214 events in it");
    expect(message).toContain("cannot be undone");
  });

  it("falls back to a countless prompt when the count cannot be read", async () => {
    const service = fakeService();
    service.countCalendarObjects.mockResolvedValue(undefined);
    const res = await callTool("delete_calendar", { calendar: "mailbox/Work" }, service);
    expect(res.inputRequests.confirm_delete_calendar.params.message).toContain("every event in it");
  });

  it("deletes once confirmed", async () => {
    const service = fakeService();
    const res = await callTool(
      "delete_calendar",
      { calendar: "mailbox/Work" },
      service,
      confirmCtx("confirm_delete_calendar", { action: "accept", content: { confirm: true } }),
    );
    expect(service.deleteCalendar).toHaveBeenCalledWith("mailbox/Work");
    expect(res.structuredContent).toEqual({
      status: "deleted",
      calendar_id: "mailbox/Work",
      url: "/caldav/work/",
      display_name: "Work",
    });
  });

  it("does not delete when the user declines", async () => {
    const service = fakeService();
    const res = await callTool(
      "delete_calendar",
      { calendar: "mailbox/Work" },
      service,
      confirmCtx("confirm_delete_calendar", { action: "accept", content: { confirm: false } }),
    );
    expect(service.deleteCalendar).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe("CONFIRMATION_DECLINED");
  });

  it("fails before the gate when the calendar cannot be resolved", async () => {
    const service = fakeService();
    service.findCalendarEntry.mockRejectedValue(notFound('Calendar "Nope" not found'));
    const res = await callTool("delete_calendar", { calendar: "mailbox/Nope" }, service);
    expect(JSON.parse(res.content[0].text).error).toBe("CALENDAR_NOT_FOUND");
    expect(service.deleteCalendar).not.toHaveBeenCalled();
  });
});

describe("calendar sharing tools (#47)", () => {
  const SHARED = {
    can_be_shared: true,
    can_be_published: true,
    protocol: "calendarserver" as const,
    shares: [
      {
        email: "bob@example.com",
        principal: null,
        name: "Bob Jones",
        access: "read" as const,
        status: "accepted" as const,
      },
    ],
  };
  const sharingService = () => ({
    getCalendarSharing: vi.fn().mockResolvedValue(SHARED),
    changeCalendarShare: vi.fn().mockResolvedValue(SHARED),
  });
  const accept = (key: string) => confirmCtx(key, { action: "accept", content: { confirm: true } });

  it("get_calendar_sharing returns the shares under the calendar's ID, without asking", async () => {
    const service = sharingService();
    const res = await callTool("get_calendar_sharing", { calendar: "mailbox/Work" }, service);
    expect(res.inputRequests).toBeUndefined();
    expect(res.structuredContent).toEqual({ calendar_id: "mailbox/Work", ...SHARED });
  });

  it("share_calendar asks first, naming the sharee, the access and the invitation", async () => {
    const service = sharingService();
    const res = await callTool(
      "share_calendar",
      { calendar: "mailbox/Work", sharee: "carol@example.com", access: "read-write" },
      service,
    );
    const message = res.inputRequests.confirm_share_calendar.params.message as string;
    expect(message).toContain("carol@example.com");
    expect(message).toContain("read-write");
    expect(message).toContain('"mailbox/Work"');
    expect(message).toContain("invitation");
    expect(service.changeCalendarShare).not.toHaveBeenCalled();
  });

  it("share_calendar shares once confirmed, passing access and summary through", async () => {
    const service = sharingService();
    const res = await callTool(
      "share_calendar",
      { calendar: "mailbox/Work", sharee: "carol@example.com", access: "read", summary: "Hi" },
      service,
      accept("confirm_share_calendar"),
    );
    expect(service.changeCalendarShare).toHaveBeenCalledWith(
      "mailbox/Work",
      "carol@example.com",
      "read",
      "Hi",
    );
    expect(res.structuredContent.calendar_id).toBe("mailbox/Work");
  });

  it("unshare_calendar asks first, then revokes with a null access", async () => {
    const service = sharingService();
    const asked = await callTool(
      "unshare_calendar",
      { calendar: "mailbox/Work", sharee: "bob@example.com" },
      service,
    );
    expect(asked.inputRequests.confirm_unshare_calendar.params.message).toContain(
      "bob@example.com",
    );
    expect(service.changeCalendarShare).not.toHaveBeenCalled();

    await callTool(
      "unshare_calendar",
      { calendar: "mailbox/Work", sharee: "bob@example.com" },
      service,
      accept("confirm_unshare_calendar"),
    );
    expect(service.changeCalendarShare).toHaveBeenCalledWith(
      "mailbox/Work",
      "bob@example.com",
      null,
    );
  });

  it("does not share when the user declines", async () => {
    const service = sharingService();
    await callTool(
      "share_calendar",
      { calendar: "mailbox/Work", sharee: "carol@example.com", access: "read" },
      service,
      confirmCtx("confirm_share_calendar", { action: "decline" }),
    );
    expect(service.changeCalendarShare).not.toHaveBeenCalled();
  });

  it("reports a Nextcloud email sharee as VALIDATION_FAILED", async () => {
    const service = sharingService();
    service.changeCalendarShare.mockRejectedValue(
      new ValidationError("This server (Nextcloud) shares with users and groups, not addresses"),
    );
    const res = await callTool(
      "share_calendar",
      { calendar: "nextcloud/Work", sharee: "bob@example.com", access: "read" },
      service,
      accept("confirm_share_calendar"),
    );
    expect(JSON.parse(res.content[0].text).error).toBe("VALIDATION_FAILED");
  });
});
