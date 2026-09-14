import { randomUUID } from "node:crypto";
import { getLocalDateParts, getTimezone, zonedTimeToUtc } from "@miguelarios/pim-core";
import {
  type ExceptionOverrides,
  type MasterEventUpdates,
  addExdateToIcs,
  combineIcsComponents,
  createExceptionComponent,
  formatTriggerHuman,
  generateEventIcs,
  removeExceptionFromIcs,
  splitIcsByUid,
  splitRecurrenceIcs,
  truncateRecurrenceIcs,
  updateMasterEventIcs,
} from "@miguelarios/pim-core/ics";
import {
  type CallToolResult,
  type ToolDef,
  type ToolResult,
  confirmDestructive,
  fail,
  structured,
  toolError,
} from "@miguelarios/pim-core/mcp";
import {
  type CalDavService,
  type EventFull,
  type EventSummary,
  drainDebugTimings,
} from "../services/CalDavService.js";
import {
  batchCreateSchema,
  calendarListSchema,
  deleteResultSchema,
  eventListSchema,
  freeBusySchema,
  freeSlotsSchema,
  importResultSchema,
  singleEventSchema,
} from "./calendarSchemas.js";

type Attendee = { email: string };
type Alarm = { type: "relative" | "absolute"; trigger: number | string };
type DetailLevel = "summary" | "full";
type Span = "this" | "all" | "future";

interface EventInput {
  title: string;
  start: string;
  end: string;
  all_day?: boolean;
  location?: string;
  description?: string;
  attendees?: Attendee[];
  alarms?: Alarm[];
  categories?: string[];
  recurrence_rule?: string;
  availability?: "busy" | "free";
}

/**
 * The `update_event` fields that are forwarded verbatim to the ICS layer on
 * both branches. Typed against `ExceptionOverrides` and `MasterEventUpdates`
 * below, so a field renamed in pim-core fails this build instead of silently
 * dropping out of the copy.
 */
const UPDATABLE_FIELDS = [
  "title",
  "start",
  "end",
  "all_day",
  "location",
  "description",
  "attendees",
  "alarms",
  "categories",
  "availability",
] as const;
type UpdatableField = (typeof UPDATABLE_FIELDS)[number];

/** The `update_event` arguments as the ICS layer sees them. */
type UpdateFields = Pick<ExceptionOverrides, UpdatableField> &
  Pick<MasterEventUpdates, UpdatableField>;

/** Copies one key from `source` to `target` when it was actually given. */
function copyDefined<T, K extends keyof T>(target: T, source: Pick<T, K>, key: K): void {
  const value = source[key];
  if (value !== undefined) target[key] = value;
}

/** The two ways a read tool names its calendars: one, or several. */
interface CalendarSelection {
  calendar?: string;
  calendars?: string[];
}

/**
 * Resolves a read tool's calendar selection to the IDs to query. `calendar`
 * and `calendars` are unioned rather than one overriding the other, so a
 * caller that sets both gets exactly the calendars it named. Empty means all.
 */
function selectedCalendars(args: CalendarSelection): string[] {
  const ids = [...(args.calendars ?? []), ...(args.calendar ? [args.calendar] : [])];
  return [...new Set(ids)];
}

async function fetchEvents(
  service: CalDavService,
  selection: CalendarSelection,
  start: string,
  end: string,
  detailLevel: string,
): Promise<EventSummary[] | EventFull[]> {
  const full = detailLevel === "full";
  let calendarIds = selectedCalendars(selection);
  if (calendarIds.length === 0) {
    calendarIds = (await service.listCalendars()).map((cal) => cal.calendar_id);
  }
  const results = await Promise.all(
    calendarIds.map((id) =>
      full ? service.listEventsFull(id, start, end) : service.listEvents(id, start, end),
    ),
  );
  return results.flat();
}

/**
 * Timing diagnostics ride in the result's `_meta` rather than inside the
 * payload, so they never have to be modelled in `outputSchema`.
 */
function debugMeta(): Pick<CallToolResult, "_meta"> | undefined {
  if (process.env.CAL_MCP_DEBUG !== "1") return undefined;
  const timings = drainDebugTimings();
  if (timings.length === 0) return undefined;
  return { _meta: { "com.miguelarios.cal-mcp/debug": { timings } } };
}

function ok<T>(payload: T): CallToolResult {
  return { ...structured(payload), ...debugMeta() };
}

function calFail(code: string, message: string, retryable = false): CallToolResult {
  return { ...fail(code, message, retryable), ...debugMeta() };
}

/**
 * Preserves this server's external error vocabulary (`not_found`,
 * `validation_error`, `backend_error`) while letting the underlying
 * `PimError` message through.
 */
function mapError(err: unknown): CallToolResult {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (code === "CALENDAR_NOT_FOUND" || code === "EVENT_NOT_FOUND") {
      return { ...toolError(err, () => "not_found"), ...debugMeta() };
    }
    if (code === "VALIDATION_FAILED") {
      return { ...toolError(err, () => "validation_error"), ...debugMeta() };
    }
  }
  return { ...toolError(err, () => "backend_error"), ...debugMeta() };
}

/**
 * Widens an attendee from the tool's input shape (`{ email }`) to the shape a
 * read returns. `generateEventIcs` writes a bare `ATTENDEE:mailto:…` with no
 * CN/PARTSTAT/ROLE/CUTYPE, so re-reading it yields nulls and the RFC 5545
 * §3.2.3 default CUTYPE of INDIVIDUAL — which the parser maps to "person".
 */
function toResponseAttendee(attendee: Attendee) {
  return {
    email: attendee.email,
    name: null,
    status: null,
    role: null,
    type: "person",
  };
}

/** Widens an alarm from the tool's input shape by rendering `trigger_human`. */
function toResponseAlarm(alarm: Alarm) {
  return {
    ...alarm,
    trigger_human:
      alarm.type === "absolute"
        ? new Date(alarm.trigger).toISOString()
        : formatTriggerHuman(Number(alarm.trigger)),
  };
}

/** Runs a handler body, converting anything thrown into this server's error shape. */
async function run(body: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (err) {
    return mapError(err);
  }
}

const CALENDAR_PROP = {
  type: "string",
  description: "Provider-prefixed calendar ID",
} as const;

/** Multi-calendar selector shared by the read tools (#49). */
const CALENDARS_PROP = (verb: "query" | "search") =>
  ({
    type: "array",
    items: { type: "string", description: "Provider-prefixed calendar ID" },
    description: `Provider-prefixed calendar IDs to ${verb} (e.g., ["mailbox/Work", "mailbox/Team"]). Combined with 'calendar' if both are given. If neither is given, ${verb === "query" ? "queries" : "searches"} all calendars.`,
  }) as const;

const DETAIL_LEVEL_PROP = {
  type: "string",
  enum: ["summary", "full"],
  description: "Response verbosity (default: summary)",
} as const;

const ATTENDEES_PROP = (description: string) =>
  ({
    type: "array",
    items: {
      type: "object",
      properties: {
        email: {
          type: "string",
          description:
            "Attendee email address. Display name is resolved server-side from the invitee's address book.",
        },
      },
      required: ["email"],
    },
    description,
  }) as const;

const ALARMS_PROP = {
  type: "array",
  items: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["relative", "absolute"], description: "Alarm type" },
      trigger: {
        type: ["string", "number"],
        description:
          "Seconds offset (negative=before event) for relative, or ISO 8601 datetime for absolute",
      },
    },
    required: ["type", "trigger"],
  },
  description: "Event reminders/alarms",
} as const;

const CATEGORIES_PROP = {
  type: "array",
  items: { type: "string", description: "Category / tag name" },
  description: "Event categories/tags",
} as const;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const CALENDAR_TOOLS: ReadonlyArray<ToolDef<CalDavService>> = [
  {
    name: "list_calendars",
    title: "List Calendars",
    description:
      "List all calendars across all configured CalDAV providers. Returns provider-prefixed IDs (e.g., mailbox/work).",
    annotations: READ_ONLY,
    inputSchema: { type: "object", properties: {} },
    outputSchema: calendarListSchema,
    handler: (_args: Record<string, never>, service) =>
      run(async () => ok({ calendars: await service.listCalendars() })),
  },
  {
    name: "list_events",
    title: "List Events",
    description:
      "Query events in a date range. Recurring events are expanded into individual instances.",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        calendar: {
          type: "string",
          description:
            "Provider-prefixed calendar ID (e.g., mailbox/Work). If omitted, queries all calendars.",
        },
        calendars: CALENDARS_PROP("query"),
        start: { type: "string", description: "Start of date range (ISO 8601)" },
        end: { type: "string", description: "End of date range (ISO 8601)" },
        detail_level: DETAIL_LEVEL_PROP,
      },
      required: ["start", "end"],
    },
    outputSchema: eventListSchema,
    handler: (
      args: CalendarSelection & { start: string; end: string; detail_level?: DetailLevel },
      service,
    ) =>
      run(async () =>
        ok({
          events: await fetchEvents(
            service,
            args,
            args.start,
            args.end,
            args.detail_level ?? "summary",
          ),
        }),
      ),
  },
  {
    name: "get_today_events",
    title: "Get Today's Events",
    description: "Get all events for today. Convenience wrapper over list_events.",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        calendar: {
          type: "string",
          description: "Provider-prefixed calendar ID. If omitted, queries all calendars.",
        },
        calendars: CALENDARS_PROP("query"),
        detail_level: DETAIL_LEVEL_PROP,
      },
    },
    outputSchema: eventListSchema,
    handler: (args: CalendarSelection & { detail_level?: DetailLevel }, service) =>
      run(async () => {
        const tz = getTimezone();
        const { year, month, day } = getLocalDateParts(new Date(), tz);
        const todayStart = zonedTimeToUtc(year, month, day, 0, 0, tz).toISOString();
        const todayEnd = zonedTimeToUtc(year, month, day + 1, 0, 0, tz).toISOString();
        return ok({
          events: await fetchEvents(
            service,
            args,
            todayStart,
            todayEnd,
            args.detail_level ?? "summary",
          ),
        });
      }),
  },
  {
    name: "search_events",
    title: "Search Events",
    description: "Keyword search across event title, description, and location.",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term" },
        calendar: {
          type: "string",
          description: "Provider-prefixed calendar ID. If omitted, searches all calendars.",
        },
        calendars: CALENDARS_PROP("search"),
        start: {
          type: "string",
          description: "Range start (ISO 8601). Defaults to 90 days ago.",
        },
        end: {
          type: "string",
          description: "Range end (ISO 8601). Defaults to 90 days ahead.",
        },
        detail_level: DETAIL_LEVEL_PROP,
      },
      required: ["query"],
    },
    outputSchema: eventListSchema,
    handler: (
      args: CalendarSelection & {
        query: string;
        start?: string;
        end?: string;
        detail_level?: DetailLevel;
      },
      service,
    ) =>
      run(async () => {
        const query = args.query.toLowerCase();
        const detailLevel = args.detail_level ?? "summary";
        const now = new Date();
        const start = args.start ?? new Date(now.getTime() - 90 * 86400000).toISOString();
        const end = args.end ?? new Date(now.getTime() + 90 * 86400000).toISOString();

        const events = await fetchEvents(service, args, start, end, detailLevel);
        const matched = events.filter((e) => {
          const title = e.title?.toLowerCase() ?? "";
          const location = e.location?.toLowerCase() ?? "";
          const description =
            detailLevel === "full" ? ((e as EventFull).description?.toLowerCase() ?? "") : "";
          return title.includes(query) || location.includes(query) || description.includes(query);
        });
        return ok({ events: matched });
      }),
  },
  {
    name: "get_event",
    title: "Get Event",
    description:
      "Get full details of a single event by calendar and UID. For a recurring event, pass occurrence_date to get one occurrence as it will actually happen — including any changes made to just that occurrence — instead of the master series.",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        calendar: CALENDAR_PROP,
        uid: { type: "string", description: "Event UID" },
        occurrence_date: {
          type: "string",
          description:
            "ISO 8601 date-time of one occurrence of a recurring event, as returned in list_events results. Returns that occurrence (with any per-occurrence overrides applied) rather than the master series. Omit to get the master.",
        },
      },
      required: ["calendar", "uid"],
    },
    outputSchema: singleEventSchema,
    handler: (args: { calendar: string; uid: string; occurrence_date?: string }, service) =>
      run(async () =>
        ok({ event: await service.getEvent(args.calendar, args.uid, args.occurrence_date) }),
      ),
  },
  {
    name: "create_event",
    title: "Create Event",
    description: "Create a new calendar event.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        calendar: CALENDAR_PROP,
        title: { type: "string", description: "Event title" },
        start: { type: "string", description: "Start time (ISO 8601)" },
        end: { type: "string", description: "End time (ISO 8601)" },
        all_day: { type: "boolean", description: "All-day event flag (default: false)" },
        location: { type: "string", description: "Event location" },
        description: { type: "string", description: "Event description" },
        attendees: ATTENDEES_PROP("List of attendee email addresses to invite."),
        alarms: ALARMS_PROP,
        categories: CATEGORIES_PROP,
        recurrence_rule: {
          type: "string",
          description:
            "RFC 5545 RRULE string for a recurring event (e.g., 'FREQ=WEEKLY;BYDAY=MO,WE,FR' or 'FREQ=MONTHLY;BYDAY=+3FR;COUNT=12'). Accepted with or without the 'RRULE:' prefix. FREQ is required.",
        },
        availability: {
          type: "string",
          enum: ["busy", "free"],
          description:
            "Free/busy transparency. 'busy' (default) blocks the time (TRANSP:OPAQUE); 'free' marks the time as available (TRANSP:TRANSPARENT).",
        },
      },
      required: ["calendar", "title", "start", "end"],
    },
    outputSchema: singleEventSchema,
    handler: (args: EventInput & { calendar: string }, service) =>
      run(async () => {
        try {
          // Populate ORGANIZER whenever attendees are present — CalDAV servers
          // (SOGo/mailbox.org) reject ATTENDEE-without-ORGANIZER PUTs with 412.
          const organizer =
            args.attendees && args.attendees.length > 0
              ? { email: service.getAccountEmail(args.calendar) }
              : undefined;
          const icsString = generateEventIcs({
            title: args.title,
            start: args.start,
            end: args.end,
            all_day: args.all_day ?? false,
            location: args.location,
            description: args.description,
            attendees: args.attendees,
            alarms: args.alarms,
            categories: args.categories,
            recurrence_rule: args.recurrence_rule,
            organizer,
            availability: args.availability,
            timezone: getTimezone(),
          });
          const uidMatch = icsString.match(/UID:(.+)/);
          const uid = uidMatch ? uidMatch[1].trim() : crypto.randomUUID();
          return ok({ event: await service.createEvent(args.calendar, icsString, uid) });
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("Invalid recurrence_rule:")) {
            return calFail("validation_error", err.message);
          }
          throw err;
        }
      }),
  },
  {
    name: "update_event",
    title: "Update Event",
    description:
      "Update an existing event. Only provided fields are changed. On a recurring event, span picks the scope: 'this' changes one occurrence, 'future' changes that occurrence and every later one (the series is split there; the returned event carries the new series' UID, and the user is asked to confirm if per-occurrence changes after that date would be discarded), 'all' changes the whole series.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        calendar: CALENDAR_PROP,
        uid: { type: "string", description: "Event UID to update" },
        title: { type: "string", description: "New event title" },
        start: { type: "string", description: "New start time (ISO 8601)" },
        end: { type: "string", description: "New end time (ISO 8601)" },
        all_day: { type: "boolean", description: "All-day event flag" },
        location: { type: "string", description: "New location" },
        description: { type: "string", description: "New description" },
        attendees: ATTENDEES_PROP("New attendee list (replaces existing)."),
        alarms: ALARMS_PROP,
        categories: CATEGORIES_PROP,
        occurrence_date: {
          type: "string",
          description:
            "ISO 8601 date of the specific occurrence to modify. Required when span is 'this' or 'future' on a recurring event. Get this value from list_events results.",
        },
        span: {
          type: "string",
          enum: ["this", "all", "future"],
          description:
            "'this' modifies only this occurrence, 'future' modifies this occurrence and every later one, 'all' modifies the entire series. Default: this.",
        },
        availability: {
          type: "string",
          enum: ["busy", "free"],
          description:
            "Free/busy transparency. 'busy' blocks the time (TRANSP:OPAQUE); 'free' marks the time as available (TRANSP:TRANSPARENT). If omitted, existing value is preserved.",
        },
      },
      required: ["calendar", "uid"],
    },
    outputSchema: singleEventSchema,
    handler: (
      args: UpdateFields & {
        calendar: string;
        uid: string;
        occurrence_date?: string;
        span?: Span;
      },
      service,
      ctx,
    ) =>
      run(async () => {
        const span = args.span ?? "this";
        const { event: existing } = await service.getEventWithMeta(args.calendar, args.uid);

        // span="this" on a recurring event: create exception VEVENT
        if (existing.is_recurring && span === "this") {
          if (!args.occurrence_date) {
            return calFail(
              "validation_error",
              "occurrence_date is required when span is 'this' on a recurring event",
            );
          }
          const occurrenceDate = args.occurrence_date;
          const rawObj = await service.fetchRawCalendarObject(args.calendar, args.uid);

          const overrides: ExceptionOverrides = {};
          for (const field of UPDATABLE_FIELDS) copyDefined(overrides, args, field);

          // If the effective event will have attendees but no organizer yet,
          // inject one so the CalDAV PUT satisfies server scheduling preconditions.
          const effectiveAttendees = overrides.attendees ?? existing.attendees;
          if (effectiveAttendees && effectiveAttendees.length > 0 && !existing.organizer) {
            overrides.organizer = { email: service.getAccountEmail(args.calendar) };
          }

          const exceptionVevent = createExceptionComponent(
            rawObj.data,
            "vevent",
            occurrenceDate,
            overrides,
            existing.all_day,
          );
          const combinedIcs = combineIcsComponents(rawObj.data, exceptionVevent);

          await service.updateEvent(args.calendar, args.uid, combinedIcs, {
            url: rawObj.url,
            etag: rawObj.etag,
          });

          // Build response from overrides + existing. Unlike every other write
          // path, this one does not re-read the event afterwards, so anything
          // taken from `overrides` is in the tool's *input* shape and has to be
          // widened to the shape a read would return — otherwise the result
          // fails validation against this tool's own outputSchema.
          const occDuration = new Date(existing.end).getTime() - new Date(existing.start).getTime();
          return ok({
            event: {
              ...existing,
              title: overrides.title ?? existing.title,
              start: overrides.start ?? occurrenceDate,
              end:
                overrides.end ??
                new Date(new Date(occurrenceDate).getTime() + occDuration).toISOString(),
              all_day: overrides.all_day ?? existing.all_day,
              location: overrides.location ?? existing.location,
              description: overrides.description ?? existing.description,
              attendees: overrides.attendees
                ? overrides.attendees.map(toResponseAttendee)
                : existing.attendees,
              alarms: overrides.alarms ? overrides.alarms.map(toResponseAlarm) : existing.alarms,
              organizer: overrides.organizer
                ? { name: overrides.organizer.name ?? null, email: overrides.organizer.email }
                : existing.organizer,
              categories: overrides.categories ?? existing.categories,
              occurrence_date: occurrenceDate,
              recurrence_rule: null,
            },
          });
        }

        const rawObj = await service.fetchRawCalendarObject(args.calendar, args.uid);

        const updates: MasterEventUpdates = { timezone: getTimezone() };
        for (const field of UPDATABLE_FIELDS) copyDefined(updates, args, field);

        // Inject ORGANIZER only when the event will have attendees but has none
        // (CalDAV scheduling servers reject ATTENDEE-without-ORGANIZER, RFC 6638).
        const effectiveAttendees = updates.attendees ?? existing.attendees;
        if (effectiveAttendees && effectiveAttendees.length > 0 && !existing.organizer) {
          updates.organizer = { email: service.getAccountEmail(args.calendar) };
        }

        // span="future" on a recurring event: split the series at the
        // occurrence. The old object is ended just before it and a new object
        // (new UID) carries the remaining pattern with the changes applied.
        // A cut at the first occurrence has nothing to keep behind it, so it
        // falls through to the whole-series edit below (#38).
        if (existing.is_recurring && span === "future") {
          if (!args.occurrence_date) {
            return calFail(
              "validation_error",
              "occurrence_date is required when span is 'future' on a recurring event",
            );
          }
          const occurrenceDate = args.occurrence_date;
          if (Number.isNaN(new Date(occurrenceDate).getTime())) {
            return calFail(
              "validation_error",
              `Invalid occurrence_date "${occurrenceDate}" — use an ISO 8601 date-time`,
            );
          }
          const newUid = `${randomUUID()}@pim-core`;
          let split: ReturnType<typeof splitRecurrenceIcs>;
          try {
            split = splitRecurrenceIcs(rawObj.data, occurrenceDate, existing.all_day, newUid);
          } catch (err) {
            if (err instanceof Error && err.message.startsWith("No occurrence at")) {
              return calFail("validation_error", err.message);
            }
            throw err;
          }
          if (split !== null) {
            // Per-occurrence edits at or after the cut do not survive the
            // split. That is the one thing this update can lose, so it is the
            // one case that asks first; a series without them is rewritten
            // without a prompt, like any other update.
            if (split.droppedOverrides > 0) {
              const gate = confirmDestructive(
                ctx,
                "confirm_update_event",
                `Changing this and all future occurrences of event ${args.uid} from ${occurrenceDate} discards ${split.droppedOverrides} per-occurrence ${split.droppedOverrides === 1 ? "change" : "changes"} made on or after that date. Continue?`,
              );
              if (gate.status === "interrupt") return gate.result;
            }
            // A moved start without a new end keeps the series' duration,
            // rather than pinning the end to the old slot.
            if (updates.start !== undefined && updates.end === undefined) {
              const durationMs =
                new Date(existing.end).getTime() - new Date(existing.start).getTime();
              updates.end = new Date(new Date(updates.start).getTime() + durationMs).toISOString();
            }
            const tailIcs = updateMasterEventIcs(split.after, updates);
            // The new series is written first: if it fails nothing has changed,
            // and if ending the old one then fails, the worst case is a visible
            // duplicate tail rather than occurrences that vanished.
            const created = await service.createEvent(args.calendar, tailIcs, newUid);
            await service.updateEvent(args.calendar, args.uid, split.before, {
              url: rawObj.url,
              etag: rawObj.etag,
            });
            return ok({ event: created });
          }
        }

        // Non-exception path (span "all", or non-recurring event): mutate the
        // existing object in place — preserves RRULE/EXDATE/RDATE, exception
        // overrides, attendee participation state, STATUS, and unknown props.
        const updatedIcs = updateMasterEventIcs(rawObj.data, updates);
        return ok({
          event: await service.updateEvent(args.calendar, args.uid, updatedIcs, {
            url: rawObj.url,
            etag: rawObj.etag,
          }),
        });
      }),
  },
  {
    name: "move_event",
    title: "Move Event",
    description:
      "Move an event to another calendar, equivalent to reassigning its calendar in a CalDAV client. Both calendars must belong to the same account.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        calendar: CALENDAR_PROP,
        uid: { type: "string", description: "Event UID to move" },
        target_calendar: {
          type: "string",
          description: "Destination provider-prefixed calendar ID, on the same account",
        },
      },
      required: ["calendar", "uid", "target_calendar"],
    },
    outputSchema: singleEventSchema,
    handler: (args: { calendar: string; uid: string; target_calendar: string }, service) =>
      run(async () => {
        const { meta } = await service.getEventWithMeta(args.calendar, args.uid);
        return ok({
          event: await service.moveEvent(args.calendar, args.uid, args.target_calendar, meta),
        });
      }),
  },
  {
    name: "delete_event",
    title: "Delete Event",
    description:
      "Delete a calendar event by UID. Asks the user to confirm first, unless it is excluding a single occurrence of a recurring event (span 'this'), which is recoverable. span 'future' ends a recurring series just before the given occurrence, keeping earlier occurrences and their history.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        calendar: CALENDAR_PROP,
        uid: { type: "string", description: "Event UID to delete" },
        occurrence_date: {
          type: "string",
          description:
            "ISO 8601 date of the specific occurrence to delete. Required when span is 'this' or 'future' on a recurring event. Get this value from list_events results.",
        },
        span: {
          type: "string",
          enum: ["this", "all", "future"],
          description:
            "'this' deletes only this occurrence, 'future' deletes this occurrence and every later one (the series ends just before it), 'all' deletes the entire series. Default: all.",
        },
      },
      required: ["calendar", "uid"],
    },
    outputSchema: deleteResultSchema,
    handler: async (
      args: { calendar: string; uid: string; occurrence_date?: string; span?: Span },
      service,
      ctx,
    ) => {
      const span = args.span ?? "all";

      // Cutting a series short keeps what already happened, but the removed
      // occurrences — and any overrides among them — are gone for good, so it
      // is gated like a full delete. The series is resolved before the gate
      // so the prompt can say what it is about to do (#41).
      if (span === "future") {
        return run(async () => {
          const { event: existing, meta: eventMeta } = await service.getEventWithMeta(
            args.calendar,
            args.uid,
          );
          if (!existing.is_recurring) {
            return calFail(
              "validation_error",
              `Event "${args.uid}" is not recurring — use span 'all' to delete it`,
            );
          }
          if (!args.occurrence_date) {
            return calFail(
              "validation_error",
              "occurrence_date is required when span is 'future' on a recurring event",
            );
          }
          const occurrenceDate = args.occurrence_date;
          if (Number.isNaN(new Date(occurrenceDate).getTime())) {
            return calFail(
              "validation_error",
              `Invalid occurrence_date "${occurrenceDate}" — use an ISO 8601 date-time`,
            );
          }
          const rawObj = await service.fetchRawCalendarObject(args.calendar, args.uid);
          const truncated = truncateRecurrenceIcs(rawObj.data, occurrenceDate, existing.all_day);

          // Nothing would remain: the cut is at or before the first occurrence,
          // so this is a whole-series delete and is treated as one.
          if (truncated === null) {
            const gate = confirmDestructive(
              ctx,
              "confirm_delete_event",
              `Delete event ${args.uid} from ${args.calendar}? ${occurrenceDate} is its first occurrence, so ending the series there removes it entirely. This cannot be undone.`,
            );
            if (gate.status === "interrupt") return gate.result;
            await service.deleteEvent(args.calendar, args.uid, eventMeta);
            return ok({ deleted: true, uid: args.uid });
          }

          const gate = confirmDestructive(
            ctx,
            "confirm_delete_event",
            `Delete the occurrence of event ${args.uid} at ${occurrenceDate} and every later one from ${args.calendar}? Earlier occurrences are kept. This cannot be undone.`,
          );
          if (gate.status === "interrupt") return gate.result;

          await service.updateEvent(args.calendar, args.uid, truncated, {
            url: rawObj.url,
            etag: rawObj.etag,
          });
          return ok({ deleted: true, uid: args.uid });
        });
      }

      // Excluding one occurrence of a recurring event is recoverable — the
      // occurrence can be re-added. EVERY other path removes the calendar
      // object outright, including `span: "this"` on a NON-recurring event,
      // which is the same irreversible delete as `span: "all"`. So recurrence
      // has to be resolved before deciding whether to gate; keying the gate off
      // `span` alone would let an agent delete a one-off event unconfirmed
      // simply by passing the narrower-sounding span.
      if (span === "this") {
        return run(async () => {
          const { event: existing, meta: eventMeta } = await service.getEventWithMeta(
            args.calendar,
            args.uid,
          );

          if (existing.is_recurring) {
            if (!args.occurrence_date) {
              return calFail(
                "validation_error",
                "occurrence_date is required when span is 'this' on a recurring event",
              );
            }
            const occurrenceDate = args.occurrence_date;
            const rawObj = await service.fetchRawCalendarObject(args.calendar, args.uid);

            let updatedIcs = addExdateToIcs(rawObj.data, occurrenceDate, existing.all_day);

            // Remove any existing exception VEVENT/VTODO for this occurrence,
            // matching by resolved instant (handles both UTC and TZID-form
            // RECURRENCE-ID) rather than a literal-text regex.
            updatedIcs = removeExceptionFromIcs(updatedIcs, occurrenceDate, existing.all_day);

            await service.updateEvent(args.calendar, args.uid, updatedIcs, {
              url: rawObj.url,
              etag: rawObj.etag,
            });
            return ok({ deleted: true, uid: args.uid });
          }

          // Non-recurring: there is no occurrence to exclude, so this deletes
          // the whole event. Gate it exactly like `span: "all"`.
          const gate = confirmDestructive(
            ctx,
            "confirm_delete_event",
            `Delete event ${args.uid} from ${args.calendar}? This cannot be undone.`,
          );
          if (gate.status === "interrupt") return gate.result;

          await service.deleteEvent(args.calendar, args.uid, eventMeta);
          return ok({ deleted: true, uid: args.uid });
        });
      }

      // span="all" — removes the calendar object, series and all.
      const gate = confirmDestructive(
        ctx,
        "confirm_delete_event",
        `Delete event ${args.uid} from ${args.calendar}? If it recurs, the entire series is removed. This cannot be undone.`,
      );
      if (gate.status === "interrupt") return gate.result;

      return run(async () => {
        await service.deleteEvent(args.calendar, args.uid);
        return ok({ deleted: true, uid: args.uid });
      });
    },
  },
  {
    name: "create_events_batch",
    title: "Create Events (Batch)",
    description: "Create multiple events at once. Returns created event count.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        calendar: CALENDAR_PROP,
        events: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Event title" },
              start: { type: "string", description: "Start time (ISO 8601)" },
              end: { type: "string", description: "End time (ISO 8601)" },
              all_day: { type: "boolean", description: "All-day event flag (default: false)" },
              location: { type: "string", description: "Event location" },
              description: { type: "string", description: "Event description" },
              attendees: ATTENDEES_PROP("List of attendee email addresses to invite."),
              alarms: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    type: {
                      type: "string",
                      enum: ["relative", "absolute"],
                      description: "Alarm type",
                    },
                    trigger: {
                      description:
                        "Seconds offset (negative=before event) for relative, or ISO 8601 datetime for absolute",
                    },
                  },
                  required: ["type", "trigger"],
                },
                description: "Event reminders/alarms",
              },
              categories: CATEGORIES_PROP,
              recurrence_rule: {
                type: "string",
                description:
                  "RFC 5545 RRULE string for a recurring event (e.g., 'FREQ=WEEKLY;BYDAY=MO'). FREQ is required.",
              },
              availability: {
                type: "string",
                enum: ["busy", "free"],
                description:
                  "Free/busy transparency. 'busy' (default) blocks the time; 'free' marks the time as available.",
              },
            },
            required: ["title", "start", "end"],
          },
          description: "Array of events to create",
        },
      },
      required: ["calendar", "events"],
    },
    outputSchema: batchCreateSchema,
    handler: (args: { calendar: string; events: EventInput[] }, service) =>
      run(async () => {
        const accountEmail = service.getAccountEmail(args.calendar);
        const createdEvents = [];
        try {
          for (const input of args.events) {
            const organizer =
              input.attendees && input.attendees.length > 0 ? { email: accountEmail } : undefined;
            const icsString = generateEventIcs({
              ...input,
              organizer,
              timezone: getTimezone(),
            });
            const uidMatch = icsString.match(/UID:(.+)/);
            const uid = uidMatch ? uidMatch[1].trim() : crypto.randomUUID();
            createdEvents.push(await service.createEvent(args.calendar, icsString, uid));
          }
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("Invalid recurrence_rule:")) {
            return calFail("validation_error", err.message);
          }
          throw err;
        }
        return ok({ created: createdEvents.length, events: createdEvents });
      }),
  },
  {
    name: "import_ics",
    title: "Import iCalendar",
    description: "Import events from iCalendar (.ics) content into a calendar.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        calendar: CALENDAR_PROP,
        ics_content: { type: "string", description: "Raw iCalendar content string" },
      },
      required: ["calendar", "ics_content"],
    },
    outputSchema: importResultSchema,
    handler: (args: { calendar: string; ics_content: string }, service) =>
      run(async () => {
        const groups = splitIcsByUid(args.ics_content);
        if (groups.length === 0) {
          return calFail("validation_error", "No events found in ICS content");
        }
        const importedEvents = [];
        const failed: Array<{ uid: string; message: string }> = [];
        for (const group of groups) {
          try {
            await service.createEvent(args.calendar, group.ics, group.uid);
            try {
              importedEvents.push(await service.getEvent(args.calendar, group.uid));
            } catch {
              importedEvents.push({ uid: group.uid });
            }
          } catch (err) {
            failed.push({
              uid: group.uid,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
        return ok({
          imported: importedEvents.length,
          ...(failed.length > 0 ? { failed } : {}),
          events: importedEvents,
        });
      }),
  },
  {
    name: "get_free_busy",
    title: "Get Free/Busy",
    description:
      "When is a calendar busy? Returns the busy periods in a date range — merged, typed as busy, tentative or unavailable — without event details, so availability questions cost one call and expose nothing else. Uses the server's own free-busy-query where it supports one, otherwise computes from the events. Use find_free_slots to get the free windows of a given length instead.",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        calendars: {
          type: "array",
          items: { type: "string", description: "Provider-prefixed calendar ID" },
          description:
            "Provider-prefixed calendar IDs to report on. If omitted, uses all calendars.",
        },
        start: { type: "string", description: "Start of range (ISO 8601)" },
        end: { type: "string", description: "End of range (ISO 8601)" },
        include_all_day_as_busy: {
          type: "boolean",
          description:
            "Treat all-day events as busy when computing from events (default: false). A server-side answer decides this itself.",
        },
        ignore_tentative: {
          type: "boolean",
          description: "If true, tentative periods are left out (default: false)",
        },
      },
      required: ["start", "end"],
    },
    outputSchema: freeBusySchema,
    handler: (
      args: {
        calendars?: string[];
        start: string;
        end: string;
        include_all_day_as_busy?: boolean;
        ignore_tentative?: boolean;
      },
      service,
    ) =>
      run(async () => {
        const startMs = new Date(args.start).getTime();
        const endMs = new Date(args.end).getTime();
        if (Number.isNaN(startMs) || Number.isNaN(endMs) || startMs >= endMs) {
          return calFail(
            "validation_error",
            "start and end must be ISO 8601 with start before end",
          );
        }
        let calendarIds = args.calendars;
        if (!calendarIds || calendarIds.length === 0) {
          calendarIds = (await service.listCalendars()).map((c) => c.calendar_id);
        }
        const { busy, sources } = await service.getFreeBusy(calendarIds, args.start, args.end, {
          includeAllDayAsBusy: args.include_all_day_as_busy ?? false,
          ignoreTentative: args.ignore_tentative ?? false,
        });
        return ok({
          start: new Date(startMs).toISOString(),
          end: new Date(endMs).toISOString(),
          busy,
          count: busy.length,
          sources,
        });
      }),
  },
  {
    name: "find_free_slots",
    title: "Find Free Slots",
    description:
      "Find available time slots across specified calendars. Returns free windows matching the requested duration.",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        calendars: {
          type: "array",
          items: { type: "string", description: "Provider-prefixed calendar ID" },
          description:
            "Provider-prefixed calendar IDs to check availability against. If omitted, uses all calendars.",
        },
        start: { type: "string", description: "Start of search range (ISO 8601)" },
        end: { type: "string", description: "End of search range (ISO 8601)" },
        duration: { type: "number", description: "Minimum slot duration in minutes" },
        preferred_start: {
          type: "string",
          description: "Preferred earliest time (HH:MM, e.g., 08:00)",
        },
        preferred_end: {
          type: "string",
          description: "Preferred latest time (HH:MM, e.g., 17:00)",
        },
        exclude_calendars: {
          type: "array",
          items: { type: "string", description: "Provider-prefixed calendar ID to exclude" },
          description: "Calendar IDs to exclude from busy time calculation",
        },
        include_all_day_as_busy: {
          type: "boolean",
          description: "Treat all-day events as busy (default: false)",
        },
        ignore_tentative: {
          type: "boolean",
          description: "If true, tentative events don't block slots (default: false)",
        },
      },
      required: ["start", "end", "duration"],
    },
    outputSchema: freeSlotsSchema,
    handler: (
      args: {
        calendars?: string[];
        start: string;
        end: string;
        duration: number;
        preferred_start?: string;
        preferred_end?: string;
        exclude_calendars?: string[];
        include_all_day_as_busy?: boolean;
        ignore_tentative?: boolean;
      },
      service,
    ) =>
      run(async () => {
        let calendarIds = args.calendars;
        if (!calendarIds || calendarIds.length === 0) {
          const allCals = await service.listCalendars();
          calendarIds = allCals.map((c: { calendar_id: string }) => c.calendar_id);
        }
        const slots = await service.findFreeSlots(
          calendarIds,
          args.start,
          args.end,
          args.duration,
          {
            preferredStart: args.preferred_start,
            preferredEnd: args.preferred_end,
            ignoreTentative: args.ignore_tentative ?? false,
            excludeCalendars: args.exclude_calendars,
            includeAllDayAsBusy: args.include_all_day_as_busy ?? false,
          },
        );
        return ok({ slots, count: slots.length });
      }),
  },
];
