/**
 * Calendar collection lifecycle: create, update metadata, delete, and sharing.
 *
 * Events live in `calendarTools.ts`; this file is about the collections that
 * hold them. `list_calendars` is deliberately not here — it already exists on
 * the event side, and reads belong with the rest of the read surface.
 */
import {
  type ToolDef,
  type ToolResult,
  confirmDestructive,
  structured,
  toolError,
} from "@miguelarios/pim-core/mcp";
import type { CalendarBackend } from "../providers/CalendarBackend.js";
import { calendarSharingSchema, calendarWriteResultSchema } from "./calendarSchemas.js";

async function run(body: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (err) {
    return toolError(err);
  }
}

/**
 * The target is required on every one of these tools. Unlike the event tools'
 * optional `calendar`, renaming or deleting "whichever calendar happened to
 * sort first" is not a thing a caller can mean.
 */
const TARGET_CALENDAR_PROP = {
  type: "string",
  description: "Provider-prefixed calendar ID to act on (e.g. mailbox/Work).",
} as const;

const COLOR_PROP = {
  type: "string",
  description: "Calendar colour as #RRGGBB or #RRGGBBAA (e.g. #3B82F6).",
} as const;

const TIMEZONE_PROP = {
  type: "string",
  description:
    "Default timezone for the calendar as an IANA zone name (e.g. America/Chicago). Written as the CalDAV calendar-timezone property; not every provider keeps it.",
} as const;

const ORDER_PROP = {
  type: "integer",
  minimum: 0,
  description:
    "Sort position among the account's calendars (0 first). Apple's calendar-order property, honoured by Apple, SabreDAV and Radicale-based servers; others may ignore it.",
} as const;

type CreateArgs = {
  provider?: string;
  display_name: string;
  description?: string;
  color?: string;
  timezone?: string;
  order?: number;
  slug?: string;
};
type UpdateArgs = {
  calendar: string;
  display_name?: string;
  description?: string;
  color?: string;
  timezone?: string;
  order?: number;
};
type DeleteArgs = { calendar: string };
type ShareArgs = {
  calendar: string;
  sharee: string;
  access: "read" | "read-write";
  summary?: string;
};

const SHAREE_PROP = {
  type: "string",
  description:
    "Who to share with: an email address (mailbox.org/Open-Xchange, Apple), or a Nextcloud principal such as principals/users/bob or principals/groups/family.",
} as const;

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const CALENDAR_MANAGEMENT_TOOLS: ReadonlyArray<ToolDef<CalendarBackend>> = [
  {
    name: "create_calendar",
    title: "Create Calendar",
    description:
      "Create a new calendar on a CalDAV provider. The URL is derived from the display name unless an explicit slug is given. Fails if a calendar with that name already exists on the provider, since the name is half of every calendar ID.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description:
            "Provider/account to create on — the prefix half of a calendar ID (e.g. 'mailbox' in mailbox/Work). Optional when only one account is configured; required otherwise. Call list_calendars to see the configured providers.",
        },
        display_name: { type: "string", description: "Display name for the new calendar" },
        description: { type: "string", description: "Optional calendar description" },
        color: COLOR_PROP,
        timezone: TIMEZONE_PROP,
        order: ORDER_PROP,
        slug: {
          type: "string",
          description:
            "Optional URL path segment (lowercase letters, digits, hyphens). Derived from display_name when omitted.",
        },
      },
      required: ["display_name"],
    },
    outputSchema: calendarWriteResultSchema,
    handler: (args: CreateArgs, service) =>
      run(async () => {
        const created = await service.createCalendar({
          provider: args.provider,
          displayName: args.display_name,
          description: args.description,
          color: args.color,
          timezone: args.timezone,
          order: args.order,
          slug: args.slug,
        });
        return structured({
          status: "created" as const,
          calendar_id: created.calendar_id,
          url: created.url,
          display_name: created.display_name,
        });
      }),
  },
  {
    name: "update_calendar",
    title: "Update Calendar",
    description:
      "Update a calendar's display name, colour, description, default timezone and/or display order. At least one must be given. Renaming changes the calendar's ID — the new ID is returned, and the old one stops resolving.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        calendar: TARGET_CALENDAR_PROP,
        display_name: {
          type: "string",
          description: "New display name. Changes the calendar's ID.",
        },
        color: COLOR_PROP,
        description: { type: "string", description: "New calendar description" },
        timezone: TIMEZONE_PROP,
        order: ORDER_PROP,
      },
      required: ["calendar"],
    },
    outputSchema: calendarWriteResultSchema,
    handler: (args: UpdateArgs, service) =>
      run(async () => {
        const updated = await service.updateCalendarMeta(args.calendar, {
          displayName: args.display_name,
          description: args.description,
          color: args.color,
          timezone: args.timezone,
          order: args.order,
        });
        return structured({
          status: "updated" as const,
          calendar_id: updated.calendar_id,
          url: updated.url,
          display_name: updated.display_name,
        });
      }),
  },
  {
    name: "delete_calendar",
    title: "Delete Calendar",
    description:
      "Delete a calendar and every event in it. This cannot be undone, and asks the user to confirm first. The event count in the confirmation is read when the prompt is built, so it describes the calendar at that moment rather than guaranteeing what the delete will remove.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        calendar: TARGET_CALENDAR_PROP,
      },
      required: ["calendar"],
    },
    outputSchema: calendarWriteResultSchema,
    handler: async (args: DeleteArgs, service, ctx) => {
      let entry: { calendar_id: string; display_name: string; url: string; provider: string };
      let count: number | undefined;
      try {
        // Resolved and counted before the gate so the confirmation names what
        // is actually being destroyed rather than echoing the caller's own
        // string back at them. The confirmed retry re-enters here and repeats
        // both — two cheap requests, accepted for a stateless handler.
        entry = await service.findCalendarEntry(args.calendar);
        count = await service.countCalendarObjects(args.calendar);
      } catch (err) {
        return toolError(err);
      }

      const eventsClause = count !== undefined ? `all ${count} events in it` : "every event in it";
      const gate = confirmDestructive(
        ctx,
        "confirm_delete_calendar",
        `Permanently delete calendar "${entry.display_name}" on provider "${entry.provider}" (${entry.url}) and ${eventsClause}? This cannot be undone.`,
      );
      if (gate.status === "interrupt") return gate.result;

      return run(async () => {
        const deleted = await service.deleteCalendar(args.calendar);
        return structured({
          status: "deleted" as const,
          calendar_id: deleted.calendar_id,
          url: deleted.url,
          display_name: deleted.display_name,
        });
      });
    },
  },
  {
    name: "get_calendar_sharing",
    title: "Get Calendar Sharing",
    description:
      "Who a calendar is shared with and at what access (read or read-write), and whether each person has accepted. Also says whether the calendar can be shared at all. Reads CalendarServer sharing (mailbox.org/Open-Xchange, Apple), Nextcloud sharing, or WebDAV resource sharing, whichever the server reports.",
    annotations: READ_ONLY_ANNOTATIONS,
    inputSchema: {
      type: "object",
      properties: { calendar: TARGET_CALENDAR_PROP },
      required: ["calendar"],
    },
    outputSchema: calendarSharingSchema,
    handler: (args: { calendar: string }, service) =>
      run(async () =>
        structured({
          calendar_id: args.calendar,
          ...(await service.getCalendarSharing(args.calendar)),
        }),
      ),
  },
  {
    name: "share_calendar",
    title: "Share Calendar",
    description:
      "Share a calendar with someone, or change their access. The server usually sends them an invitation, so this asks the user to confirm first. On CalendarServer servers (mailbox.org/Open-Xchange, Apple) the sharee is an email address; on Nextcloud it is a user or group principal such as principals/users/bob. Returns the calendar's sharing afterwards.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      // Repeating it can send the sharee another invitation.
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        calendar: TARGET_CALENDAR_PROP,
        sharee: SHAREE_PROP,
        access: {
          type: "string",
          enum: ["read", "read-write"],
          description: "'read' lets them see events; 'read-write' also lets them change them.",
        },
        summary: {
          type: "string",
          description: "Optional note included in the invitation, where the server sends one.",
        },
      },
      required: ["calendar", "sharee", "access"],
    },
    outputSchema: calendarSharingSchema,
    handler: async (args: ShareArgs, service, ctx) => {
      const gate = confirmDestructive(
        ctx,
        "confirm_share_calendar",
        `Give ${args.sharee} ${args.access === "read-write" ? "read-write" : "read-only"} access to calendar "${args.calendar}"? The server may send them an invitation.`,
      );
      if (gate.status === "interrupt") return gate.result;
      return run(async () =>
        structured({
          calendar_id: args.calendar,
          ...(await service.changeCalendarShare(
            args.calendar,
            args.sharee,
            args.access,
            args.summary,
          )),
        }),
      );
    },
  },
  {
    name: "unshare_calendar",
    title: "Unshare Calendar",
    description:
      "Remove someone's access to a calendar. Asks the user to confirm first. Pass the sharee as get_calendar_sharing reports it: an email address, or on Nextcloud a principal such as principals/users/bob. Returns the calendar's sharing afterwards.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: { calendar: TARGET_CALENDAR_PROP, sharee: SHAREE_PROP },
      required: ["calendar", "sharee"],
    },
    outputSchema: calendarSharingSchema,
    handler: async (args: { calendar: string; sharee: string }, service, ctx) => {
      const gate = confirmDestructive(
        ctx,
        "confirm_unshare_calendar",
        `Remove ${args.sharee}'s access to calendar "${args.calendar}"?`,
      );
      if (gate.status === "interrupt") return gate.result;
      return run(async () =>
        structured({
          calendar_id: args.calendar,
          ...(await service.changeCalendarShare(args.calendar, args.sharee, null)),
        }),
      );
    },
  },
];
