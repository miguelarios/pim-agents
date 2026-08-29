/**
 * Calendar collection lifecycle: create, update metadata, delete.
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
import type { CalDavService } from "../services/CalDavService.js";
import { calendarWriteResultSchema } from "./calendarSchemas.js";

/**
 * Maps to this server's external error vocabulary, as `calendarTools` does —
 * plus `validation_error`, which these tools actually raise: bad colours, empty
 * names, unresolvable providers and empty updates are all caller-fixable, and
 * reporting them as `backend_error` would send a caller looking at the server.
 */
function mapError(err: unknown) {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (code === "CALENDAR_NOT_FOUND") return toolError(err, () => "not_found");
    if (code === "VALIDATION_FAILED") return toolError(err, () => "validation_error");
  }
  return toolError(err, () => "backend_error");
}

async function run(body: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (err) {
    return mapError(err);
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

type CreateArgs = {
  provider?: string;
  display_name: string;
  description?: string;
  color?: string;
  slug?: string;
};
type UpdateArgs = {
  calendar: string;
  display_name?: string;
  description?: string;
  color?: string;
};
type DeleteArgs = { calendar: string };

export const CALENDAR_MANAGEMENT_TOOLS: ReadonlyArray<ToolDef<CalDavService>> = [
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
      "Update a calendar's display name, colour, and/or description. At least one must be given. Renaming changes the calendar's ID — the new ID is returned, and the old one stops resolving.",
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
        return mapError(err);
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
];
