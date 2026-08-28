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

class FakeValidationError extends Error {
  code = "VALIDATION_FAILED";
}
class FakeNotFoundError extends Error {
  code = "CALENDAR_NOT_FOUND";
}

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
  it("defines the three tools with complete annotations", () => {
    expect(CALENDAR_MANAGEMENT_TOOLS.map((t) => t.name)).toEqual([
      "create_calendar",
      "update_calendar",
      "delete_calendar",
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

  it("marks only delete_calendar destructive", () => {
    const destructive = CALENDAR_MANAGEMENT_TOOLS.filter((t) => t.annotations.destructiveHint);
    expect(destructive.map((t) => t.name)).toEqual(["delete_calendar"]);
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

  it("reports a caller-fixable failure as validation_error, not backend_error", async () => {
    const service = fakeService();
    service.createCalendar.mockRejectedValue(
      new FakeValidationError('Invalid color "blue" — use #RRGGBB or #RRGGBBAA (e.g. #3B82F6)'),
    );
    const res = await callTool("create_calendar", { display_name: "Team", color: "blue" }, service);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.error).toBe("validation_error");
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

  it("surfaces an empty update as validation_error", async () => {
    const service = fakeService();
    service.updateCalendarMeta.mockRejectedValue(
      new FakeValidationError(
        "Nothing to change — provide a display_name, color and/or description",
      ),
    );
    const res = await callTool("update_calendar", { calendar: "mailbox/Work" }, service);
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe("validation_error");
  });

  it("surfaces an unknown calendar as not_found", async () => {
    const service = fakeService();
    service.updateCalendarMeta.mockRejectedValue(
      new FakeNotFoundError('Calendar "Nope" not found'),
    );
    const res = await callTool(
      "update_calendar",
      { calendar: "mailbox/Nope", color: "#000000" },
      service,
    );
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe("not_found");
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
    service.findCalendarEntry.mockRejectedValue(new FakeNotFoundError('Calendar "Nope" not found'));
    const res = await callTool("delete_calendar", { calendar: "mailbox/Nope" }, service);
    expect(JSON.parse(res.content[0].text).error).toBe("not_found");
    expect(service.deleteCalendar).not.toHaveBeenCalled();
  });
});
