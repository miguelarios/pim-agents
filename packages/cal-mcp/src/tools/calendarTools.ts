import { toPimError } from "@miguelarios/pim-core";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { generateEventIcs, parseIcsEvents } from "../ical.js";
import type { CalDavService } from "../services/CalDavService.js";

export const CALENDAR_TOOLS: Tool[] = [
  {
    name: "list_calendars",
    description:
      "List all calendars across all configured CalDAV providers. Returns provider-prefixed IDs (e.g., mailbox/work).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_events",
    description: "Query events in a calendar by date range. Expands recurring events.",
    inputSchema: {
      type: "object",
      properties: {
        calendar: {
          type: "string",
          description: "Provider-prefixed calendar ID (e.g., mailbox/Work)",
        },
        start: {
          type: "string",
          description: "Start of date range (ISO 8601)",
        },
        end: {
          type: "string",
          description: "End of date range (ISO 8601)",
        },
      },
      required: ["calendar", "start", "end"],
    },
  },
  {
    name: "get_event",
    description: "Get full details of a single event by calendar and UID.",
    inputSchema: {
      type: "object",
      properties: {
        calendar: {
          type: "string",
          description: "Provider-prefixed calendar ID",
        },
        uid: { type: "string", description: "Event UID" },
      },
      required: ["calendar", "uid"],
    },
  },
  {
    name: "create_event",
    description: "Create a new calendar event.",
    inputSchema: {
      type: "object",
      properties: {
        calendar: {
          type: "string",
          description: "Provider-prefixed calendar ID",
        },
        summary: { type: "string", description: "Event title" },
        start: {
          type: "string",
          description: "Start time (ISO 8601)",
        },
        end: { type: "string", description: "End time (ISO 8601)" },
        location: { type: "string", description: "Event location" },
        description: {
          type: "string",
          description: "Event description",
        },
        attendees: {
          type: "array",
          items: {
            type: "object",
            properties: {
              email: { type: "string" },
              name: { type: "string" },
            },
            required: ["email"],
          },
          description: "List of attendees",
        },
      },
      required: ["calendar", "summary", "start", "end"],
    },
  },
  {
    name: "update_event",
    description: "Update an existing event. Only provided fields are changed.",
    inputSchema: {
      type: "object",
      properties: {
        calendar: {
          type: "string",
          description: "Provider-prefixed calendar ID",
        },
        uid: {
          type: "string",
          description: "Event UID to update",
        },
        summary: { type: "string", description: "New event title" },
        start: {
          type: "string",
          description: "New start time (ISO 8601)",
        },
        end: {
          type: "string",
          description: "New end time (ISO 8601)",
        },
        location: { type: "string", description: "New location" },
        description: {
          type: "string",
          description: "New description",
        },
        attendees: {
          type: "array",
          items: {
            type: "object",
            properties: {
              email: { type: "string" },
              name: { type: "string" },
            },
            required: ["email"],
          },
          description: "New attendee list (replaces existing)",
        },
      },
      required: ["calendar", "uid"],
    },
  },
  {
    name: "delete_event",
    description: "Delete a calendar event by UID.",
    inputSchema: {
      type: "object",
      properties: {
        calendar: {
          type: "string",
          description: "Provider-prefixed calendar ID",
        },
        uid: {
          type: "string",
          description: "Event UID to delete",
        },
      },
      required: ["calendar", "uid"],
    },
  },
  {
    name: "create_events_batch",
    description: "Create multiple events at once. Returns created event count.",
    inputSchema: {
      type: "object",
      properties: {
        calendar: {
          type: "string",
          description: "Provider-prefixed calendar ID",
        },
        events: {
          type: "array",
          items: {
            type: "object",
            properties: {
              summary: { type: "string" },
              start: { type: "string" },
              end: { type: "string" },
              location: { type: "string" },
              description: { type: "string" },
            },
            required: ["summary", "start", "end"],
          },
          description: "Array of events to create",
        },
      },
      required: ["calendar", "events"],
    },
  },
  {
    name: "import_ics",
    description: "Import events from iCalendar (.ics) content into a calendar.",
    inputSchema: {
      type: "object",
      properties: {
        calendar: {
          type: "string",
          description: "Provider-prefixed calendar ID",
        },
        icsContent: {
          type: "string",
          description: "Raw iCalendar content string",
        },
      },
      required: ["calendar", "icsContent"],
    },
  },
  {
    name: "find_free_slots",
    description:
      "Find available time slots across specified calendars. Returns free windows matching the requested duration.",
    inputSchema: {
      type: "object",
      properties: {
        calendars: {
          type: "array",
          items: { type: "string" },
          description: "Provider-prefixed calendar IDs to check availability against",
        },
        start: {
          type: "string",
          description: "Start of search range (ISO 8601)",
        },
        end: {
          type: "string",
          description: "End of search range (ISO 8601)",
        },
        duration: {
          type: "number",
          description: "Minimum slot duration in minutes",
        },
        preferredStart: {
          type: "string",
          description: "Preferred earliest time (HH:MM, e.g., 08:00)",
        },
        preferredEnd: {
          type: "string",
          description: "Preferred latest time (HH:MM, e.g., 17:00)",
        },
        ignore_tentative: {
          type: "boolean",
          description: "If true, tentative events don't block slots (default: false)",
        },
      },
      required: ["calendars", "start", "end", "duration"],
    },
  },
];

export async function handleCalendarTool(
  name: string,
  args: Record<string, unknown>,
  service: CalDavService,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  try {
    switch (name) {
      case "list_calendars": {
        const calendars = await service.listCalendars();
        return ok(JSON.stringify(calendars, null, 2));
      }

      case "list_events": {
        const events = await service.listEvents(
          args.calendar as string,
          args.start as string,
          args.end as string,
        );
        return ok(JSON.stringify(events, null, 2));
      }

      case "get_event": {
        const event = await service.getEvent(args.calendar as string, args.uid as string);
        return ok(JSON.stringify(event, null, 2));
      }

      case "create_event": {
        const icsString = generateEventIcs({
          summary: args.summary as string,
          start: args.start as string,
          end: args.end as string,
          location: args.location as string | undefined,
          description: args.description as string | undefined,
          attendees: args.attendees as Array<{ email: string; name?: string }> | undefined,
        });
        await service.createEvent(args.calendar as string, icsString);
        return ok(JSON.stringify({ status: "created" }));
      }

      case "update_event": {
        const existing = await service.getEvent(args.calendar as string, args.uid as string);
        const icsString = generateEventIcs({
          summary: (args.summary as string) ?? existing.summary,
          start: (args.start as string) ?? existing.start,
          end: (args.end as string) ?? existing.end,
          location: (args.location as string) ?? existing.location,
          description: (args.description as string) ?? existing.description,
          attendees:
            (args.attendees as Array<{ email: string; name?: string }> | undefined) ??
            existing.attendees,
        });
        await service.updateEvent(args.calendar as string, args.uid as string, icsString);
        return ok(JSON.stringify({ status: "updated", uid: args.uid }));
      }

      case "delete_event": {
        await service.deleteEvent(args.calendar as string, args.uid as string);
        return ok(JSON.stringify({ status: "deleted", uid: args.uid }));
      }

      case "create_events_batch": {
        const events = args.events as Array<{
          summary: string;
          start: string;
          end: string;
          location?: string;
          description?: string;
        }>;
        let created = 0;
        for (const event of events) {
          const icsString = generateEventIcs(event);
          await service.createEvent(args.calendar as string, icsString);
          created++;
        }
        return ok(JSON.stringify({ status: "created", count: created }));
      }

      case "import_ics": {
        const icsContent = args.icsContent as string;
        const parsed = parseIcsEvents(icsContent);
        if (parsed.length === 0) {
          return error("No events found in ICS content");
        }
        await service.createEvent(args.calendar as string, icsContent);
        return ok(JSON.stringify({ status: "imported", count: parsed.length }));
      }

      case "find_free_slots": {
        const slots = await service.findFreeSlots(
          args.calendars as string[],
          args.start as string,
          args.end as string,
          args.duration as number,
          {
            preferredStart: args.preferredStart as string | undefined,
            preferredEnd: args.preferredEnd as string | undefined,
            ignoreTentative: (args.ignore_tentative as boolean) ?? false,
          },
        );
        return ok(JSON.stringify(slots, null, 2));
      }

      default:
        return error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const pimError = toPimError(err instanceof Error ? err : new Error(String(err)));
    return error(`${pimError.message}${pimError.isRetryable ? " (retryable)" : ""}`);
  }
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function error(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
