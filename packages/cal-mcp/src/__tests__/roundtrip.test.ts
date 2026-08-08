/**
 * End-to-end wire conformance: a real MCP client talking to the real server
 * over an in-memory transport pair, on both protocol eras.
 */
import { TOOL_LIST_CACHE_HINT, registerTools } from "@miguelarios/pim-core/mcp";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalDavService } from "../services/CalDavService.js";
import { CALENDAR_TOOLS } from "../tools/calendarTools.js";

const EVENT = {
  uid: "evt-1",
  calendar_id: "mailbox/Work",
  title: "Standup",
  start: "2026-08-01T09:00:00.000Z",
  end: "2026-08-01T09:15:00.000Z",
  all_day: false,
  location: null,
  status: null,
  is_recurring: false,
  occurrence_date: null,
};

const RECURRING_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//test//EN",
  "BEGIN:VEVENT",
  "UID:evt-1",
  "DTSTAMP:20260701T000000Z",
  "DTSTART:20260801T090000Z",
  "DTEND:20260801T091500Z",
  "SUMMARY:Standup",
  "RRULE:FREQ=DAILY",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

function fakeService() {
  return {
    listCalendars: vi.fn().mockResolvedValue([
      {
        calendar_id: "mailbox/Work",
        display_name: "Work",
        color: null,
        source: "mailbox",
        read_only: false,
        url: "https://example.test/work",
      },
    ]),
    listEvents: vi.fn().mockResolvedValue([EVENT]),
    listEventsFull: vi.fn().mockResolvedValue([EVENT]),
    getEvent: vi.fn().mockResolvedValue(EVENT),
    getEventWithMeta: vi.fn().mockResolvedValue({
      event: { ...EVENT, is_recurring: false },
      meta: { url: "u", etag: "e" },
    }),
    deleteEvent: vi.fn().mockResolvedValue(undefined),
    updateEvent: vi.fn().mockResolvedValue(EVENT),
    fetchRawCalendarObject: vi.fn().mockResolvedValue({ data: RECURRING_ICS, url: "u", etag: "e" }),
    findFreeSlots: vi.fn().mockResolvedValue([]),
    getAccountEmail: vi.fn(() => "user@example.com"),
  };
}

type Era = "legacy" | "modern";
type ElicitAnswer = { action: "accept"; content: { confirm: boolean } } | { action: "decline" };

const open = async (
  era: Era,
  service: ReturnType<typeof fakeService>,
  answer: ElicitAnswer = { action: "accept", content: { confirm: true } },
) => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const handle = serveStdio(
    () => {
      const server = new McpServer(
        { name: "@miguelarios/cal-mcp", title: "CalDAV Calendars", version: "0.0.0-test" },
        {
          capabilities: { tools: { listChanged: false } },
          cacheHints: { "tools/list": TOOL_LIST_CACHE_HINT },
        },
      );
      registerTools(server, CALENDAR_TOOLS, service as unknown as CalDavService);
      return server;
    },
    { transport: serverTransport },
  );

  const elicitations: string[] = [];
  const client = new Client(
    { name: "roundtrip-test", version: "0.0.0" },
    {
      capabilities: { elicitation: {} },
      versionNegotiation: { mode: era === "modern" ? { pin: "2026-07-28" } : "legacy" },
    },
  );
  client.setRequestHandler("elicitation/create", async (req) => {
    elicitations.push(req.params.message as string);
    return answer;
  });
  await client.connect(clientTransport);

  return { client, handle, elicitations };
};

const openHandles: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(openHandles.splice(0).map((h) => h.close()));
});

const connect = async (...args: Parameters<typeof open>) => {
  const session = await open(...args);
  openHandles.push(session.handle);
  return session;
};

describe.each<Era>(["legacy", "modern"])("cal-mcp over the wire (%s era)", (era) => {
  it("negotiates the expected protocol era", async () => {
    const { client } = await connect(era, fakeService());
    expect(client.getProtocolEra()).toBe(era);
  });

  it("advertises title, annotations and outputSchema for every tool", async () => {
    const { client } = await connect(era, fakeService());
    const { tools } = await client.listTools();

    expect(tools).toHaveLength(CALENDAR_TOOLS.length);
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(tool.annotations, tool.name).toMatchObject({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
    }
  });

  it("returns tools in a stable order across calls", async () => {
    const { client } = await connect(era, fakeService());
    const first = (await client.listTools()).tools.map((t) => t.name);
    const second = (await client.listTools()).tools.map((t) => t.name);
    expect(second).toEqual(first);
    expect(first).toEqual(CALENDAR_TOOLS.map((t) => t.name));
  });

  it("returns structuredContent matching the advertised outputSchema", async () => {
    const { client } = await connect(era, fakeService());
    const result = await client.callTool({ name: "list_calendars", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      calendars: [{ calendar_id: "mailbox/Work" }],
    });
  });

  it("expands events into structuredContent", async () => {
    const { client } = await connect(era, fakeService());
    const result = await client.callTool({
      name: "list_events",
      arguments: { start: "2026-08-01T00:00:00Z", end: "2026-08-02T00:00:00Z" },
    });

    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { events: unknown[] }).events).toHaveLength(1);
  });

  it("rejects malformed arguments without running the handler", async () => {
    const service = fakeService();
    const { client } = await connect(era, service);
    // `duration` must be a number, and start/end are required.
    const result = await client.callTool({
      name: "find_free_slots",
      arguments: { start: "2026-08-01T00:00:00Z", end: "2026-08-02T00:00:00Z", duration: "30" },
    });

    expect(result.isError).toBe(true);
    expect(service.findFreeSlots).not.toHaveBeenCalled();
  });

  it("confirms before deleting a whole series, then deletes", async () => {
    const service = fakeService();
    const { client, elicitations } = await connect(era, service);
    const result = await client.callTool({
      name: "delete_event",
      arguments: { calendar: "mailbox/Work", uid: "evt-1", span: "all" },
    });

    expect(elicitations).toHaveLength(1);
    expect(result.isError).toBeFalsy();
    expect(service.deleteEvent).toHaveBeenCalled();
  });

  it("does not delete a series when the user declines", async () => {
    const service = fakeService();
    const { client, elicitations } = await connect(era, service, { action: "decline" });
    const result = await client.callTool({
      name: "delete_event",
      arguments: { calendar: "mailbox/Work", uid: "evt-1", span: "all" },
    });

    expect(elicitations).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(service.deleteEvent).not.toHaveBeenCalled();
  });

  it("returns schema-valid structuredContent when updating one occurrence's attendees and alarms", async () => {
    // The exception branch builds its response from the caller's raw input
    // rather than a server round-trip, so it is the one update path that can
    // drift from the advertised outputSchema.
    const service = fakeService();
    service.getEventWithMeta.mockResolvedValue({
      event: { ...EVENT, is_recurring: true },
      meta: { url: "u", etag: "e" },
    });
    const { client } = await connect(era, service);

    const result = await client.callTool({
      name: "update_event",
      arguments: {
        calendar: "mailbox/Work",
        uid: "evt-1",
        span: "this",
        occurrence_date: "2026-08-02T09:00:00.000Z",
        attendees: [{ email: "guest@example.com" }],
        alarms: [{ type: "relative", trigger: -600 }],
      },
    });

    expect(result.isError).toBeFalsy();
    const event = (result.structuredContent as { event: Record<string, unknown> }).event;
    expect(event.attendees).toEqual([
      { email: "guest@example.com", name: null, status: null, role: null, type: "person" },
    ]);
    expect(event.alarms).toEqual([
      { type: "relative", trigger: -600, trigger_human: "10 minutes before" },
    ]);
  });

  it("excludes a single occurrence of a recurring event without asking", async () => {
    const service = fakeService();
    service.getEventWithMeta.mockResolvedValue({
      event: { ...EVENT, is_recurring: true },
      meta: { url: "u", etag: "e" },
    });
    const { client, elicitations } = await connect(era, service);
    const result = await client.callTool({
      name: "delete_event",
      arguments: {
        calendar: "mailbox/Work",
        uid: "evt-1",
        span: "this",
        occurrence_date: "2026-08-02T09:00:00.000Z",
      },
    });

    expect(elicitations).toHaveLength(0);
    expect(result.isError).toBeFalsy();
    // Excluding an occurrence rewrites the object rather than deleting it.
    expect(service.updateEvent).toHaveBeenCalled();
    expect(service.deleteEvent).not.toHaveBeenCalled();
  });

  it("still asks for span=this on a NON-recurring event", async () => {
    // No occurrence to exclude, so this is a full delete — the narrower span
    // must not bypass the gate.
    const service = fakeService();
    const { client, elicitations } = await connect(era, service);
    const result = await client.callTool({
      name: "delete_event",
      arguments: { calendar: "mailbox/Work", uid: "evt-1", span: "this" },
    });

    expect(elicitations).toHaveLength(1);
    expect(result.isError).toBeFalsy();
    expect(service.deleteEvent).toHaveBeenCalled();
  });

  it("does not delete a non-recurring event via span=this when declined", async () => {
    const service = fakeService();
    const { client, elicitations } = await connect(era, service, { action: "decline" });
    const result = await client.callTool({
      name: "delete_event",
      arguments: { calendar: "mailbox/Work", uid: "evt-1", span: "this" },
    });

    expect(elicitations).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(service.deleteEvent).not.toHaveBeenCalled();
  });
});
