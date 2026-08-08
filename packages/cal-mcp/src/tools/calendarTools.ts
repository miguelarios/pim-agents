import { getLocalDateParts, getTimezone, toPimError, zonedTimeToUtc } from "@miguelarios/pim-core";
import {
  type MasterEventUpdates,
  addExdateToIcs,
  combineIcsComponents,
  createExceptionComponent,
  generateEventIcs,
  removeExceptionFromIcs,
  splitIcsByUid,
  updateMasterEventIcs,
} from "@miguelarios/pim-core/ics";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  type CalDavService,
  type CalendarObjectMeta,
  type EventFull,
  type EventSummary,
  drainDebugTimings,
} from "../services/CalDavService.js";

async function fetchEvents(
  service: CalDavService,
  calendar: string | undefined,
  start: string,
  end: string,
  detailLevel: string,
): Promise<EventSummary[] | EventFull[]> {
  const full = detailLevel === "full";
  if (calendar) {
    return full
      ? await service.listEventsFull(calendar, start, end)
      : await service.listEvents(calendar, start, end);
  }
  const calendars = await service.listCalendars();
  const results = await Promise.all(
    calendars.map((cal) =>
      full
        ? service.listEventsFull(cal.calendar_id, start, end)
        : service.listEvents(cal.calendar_id, start, end),
    ),
  );
  return results.flat();
}

export const CALENDAR_TOOLS: Tool[] = [
  {
    name: "list_calendars",
    description:
      "List all calendars across all configured CalDAV providers. Returns provider-prefixed IDs (e.g., mailbox/work).",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_events",
    description:
      "Query events in a date range. Recurring events are expanded into individual instances.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        calendar: {
          type: "string",
          description:
            "Provider-prefixed calendar ID (e.g., mailbox/Work). If omitted, queries all calendars.",
        },
        start: {
          type: "string",
          description: "Start of date range (ISO 8601)",
        },
        end: {
          type: "string",
          description: "End of date range (ISO 8601)",
        },
        detail_level: {
          type: "string",
          enum: ["summary", "full"],
          description: "Response verbosity (default: summary)",
        },
      },
      required: ["start", "end"],
    },
  },
  {
    name: "get_today_events",
    description: "Get all events for today. Convenience wrapper over list_events.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        calendar: {
          type: "string",
          description: "Provider-prefixed calendar ID. If omitted, queries all calendars.",
        },
        detail_level: {
          type: "string",
          enum: ["summary", "full"],
          description: "Response verbosity (default: summary)",
        },
      },
    },
  },
  {
    name: "search_events",
    description: "Keyword search across event title, description, and location.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search term",
        },
        calendar: {
          type: "string",
          description: "Provider-prefixed calendar ID. If omitted, searches all calendars.",
        },
        start: {
          type: "string",
          description: "Range start (ISO 8601). Defaults to 90 days ago.",
        },
        end: {
          type: "string",
          description: "Range end (ISO 8601). Defaults to 90 days ahead.",
        },
        detail_level: {
          type: "string",
          enum: ["summary", "full"],
          description: "Response verbosity (default: summary)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_event",
    description: "Get full details of a single event by calendar and UID.",
    annotations: { readOnlyHint: true },
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
        title: { type: "string", description: "Event title" },
        start: {
          type: "string",
          description: "Start time (ISO 8601)",
        },
        end: { type: "string", description: "End time (ISO 8601)" },
        all_day: {
          type: "boolean",
          description: "All-day event flag (default: false)",
        },
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
              email: {
                type: "string",
                description:
                  "Attendee email address. Display name is resolved server-side from the invitee's address book.",
              },
            },
            required: ["email"],
          },
          description: "List of attendee email addresses to invite.",
        },
        alarms: {
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
        },
        categories: {
          type: "array",
          items: { type: "string", description: "Category / tag name" },
          description: "Event categories/tags",
        },
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
        title: { type: "string", description: "New event title" },
        start: {
          type: "string",
          description: "New start time (ISO 8601)",
        },
        end: {
          type: "string",
          description: "New end time (ISO 8601)",
        },
        all_day: {
          type: "boolean",
          description: "All-day event flag",
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
              email: {
                type: "string",
                description:
                  "Attendee email address. Display name is resolved server-side from the invitee's address book.",
              },
            },
            required: ["email"],
          },
          description: "New attendee list (replaces existing).",
        },
        alarms: {
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
        },
        categories: {
          type: "array",
          items: { type: "string", description: "Category / tag name" },
          description: "Event categories/tags",
        },
        occurrence_date: {
          type: "string",
          description:
            "ISO 8601 date of the specific occurrence to modify. Required when span is 'this' on a recurring event. Get this value from list_events results.",
        },
        span: {
          type: "string",
          enum: ["this", "all"],
          description:
            "'this' modifies only this occurrence, 'all' modifies the entire series. Default: this.",
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
  },
  {
    name: "move_event",
    description:
      "Move an event to another calendar, equivalent to reassigning its calendar in a CalDAV client.",
    inputSchema: {
      type: "object",
      properties: {
        calendar: {
          type: "string",
          description: "Current provider-prefixed calendar ID",
        },
        uid: {
          type: "string",
          description: "Event UID to move",
        },
        target_calendar: {
          type: "string",
          description: "Destination provider-prefixed calendar ID",
        },
      },
      required: ["calendar", "uid", "target_calendar"],
    },
  },
  {
    name: "delete_event",
    description: "Delete a calendar event by UID.",
    annotations: { destructiveHint: true },
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
        occurrence_date: {
          type: "string",
          description:
            "ISO 8601 date of the specific occurrence to delete. Required when span is 'this' on a recurring event. Get this value from list_events results.",
        },
        span: {
          type: "string",
          enum: ["this", "all"],
          description:
            "'this' deletes only this occurrence, 'all' deletes the entire series. Default: all.",
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
              title: { type: "string", description: "Event title" },
              start: {
                type: "string",
                description: "Start time (ISO 8601)",
              },
              end: { type: "string", description: "End time (ISO 8601)" },
              all_day: {
                type: "boolean",
                description: "All-day event flag (default: false)",
              },
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
                    email: {
                      type: "string",
                      description:
                        "Attendee email address. Display name is resolved server-side from the invitee's address book.",
                    },
                  },
                  required: ["email"],
                },
                description: "List of attendee email addresses to invite.",
              },
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
              categories: {
                type: "array",
                items: { type: "string", description: "Category / tag name" },
                description: "Event categories/tags",
              },
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
        ics_content: {
          type: "string",
          description: "Raw iCalendar content string",
        },
      },
      required: ["calendar", "ics_content"],
    },
  },
  {
    name: "find_free_slots",
    description:
      "Find available time slots across specified calendars. Returns free windows matching the requested duration.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        calendars: {
          type: "array",
          items: { type: "string", description: "Provider-prefixed calendar ID" },
          description:
            "Provider-prefixed calendar IDs to check availability against. If omitted, uses all calendars.",
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
  },
];

function withDebug<T extends object>(payload: T): T | (T & { _debug: unknown }) {
  if (process.env.CAL_MCP_DEBUG !== "1") return payload;
  const timings = drainDebugTimings();
  if (timings.length === 0) return payload;
  return { ...payload, _debug: { timings } };
}

function ok(payload: object) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(withDebug(payload), null, 2) }],
  };
}

function error(code: string, message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(withDebug({ error: code, message })),
      },
    ],
    isError: true,
  };
}

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
        return ok({ calendars });
      }

      case "list_events": {
        const calendar = args.calendar as string | undefined;
        const detailLevel = (args.detail_level as string) ?? "summary";
        const events = await fetchEvents(
          service,
          calendar,
          args.start as string,
          args.end as string,
          detailLevel,
        );
        return ok({ events });
      }

      case "get_today_events": {
        const calendar = args.calendar as string | undefined;
        const detailLevel = (args.detail_level as string) ?? "summary";
        const tz = getTimezone();
        const now = new Date();
        const { year, month, day } = getLocalDateParts(now, tz);
        const todayStart = zonedTimeToUtc(year, month, day, 0, 0, tz).toISOString();
        const todayEnd = zonedTimeToUtc(year, month, day + 1, 0, 0, tz).toISOString();
        const events = await fetchEvents(service, calendar, todayStart, todayEnd, detailLevel);
        return ok({ events });
      }

      case "search_events": {
        const query = (args.query as string).toLowerCase();
        const calendar = args.calendar as string | undefined;
        const detailLevel = (args.detail_level as string) ?? "summary";
        const now = new Date();
        const start =
          (args.start as string) ?? new Date(now.getTime() - 90 * 86400000).toISOString();
        const end = (args.end as string) ?? new Date(now.getTime() + 90 * 86400000).toISOString();

        const events = await fetchEvents(service, calendar, start, end, detailLevel);
        const matched = events.filter((e) => {
          const title = e.title?.toLowerCase() ?? "";
          const location = e.location?.toLowerCase() ?? "";
          const description =
            detailLevel === "full" ? ((e as EventFull).description?.toLowerCase() ?? "") : "";
          return title.includes(query) || location.includes(query) || description.includes(query);
        });
        return ok({ events: matched });
      }

      case "get_event": {
        const event = await service.getEvent(args.calendar as string, args.uid as string);
        return ok({ event });
      }

      case "create_event": {
        try {
          const attendees = args.attendees as Array<{ email: string }> | undefined;
          const calendarId = args.calendar as string;
          // Populate ORGANIZER whenever attendees are present — CalDAV servers
          // (SOGo/mailbox.org) reject ATTENDEE-without-ORGANIZER PUTs with 412.
          const organizer =
            attendees && attendees.length > 0
              ? { email: service.getAccountEmail(calendarId) }
              : undefined;
          const icsString = generateEventIcs({
            title: args.title as string,
            start: args.start as string,
            end: args.end as string,
            all_day: (args.all_day as boolean) ?? false,
            location: args.location as string | undefined,
            description: args.description as string | undefined,
            attendees,
            alarms: args.alarms as
              | Array<{ type: "relative" | "absolute"; trigger: number | string }>
              | undefined,
            categories: args.categories as string[] | undefined,
            recurrence_rule: args.recurrence_rule as string | undefined,
            organizer,
            availability: args.availability as "busy" | "free" | undefined,
            timezone: getTimezone(),
          });
          const uidMatch = icsString.match(/UID:(.+)/);
          const uid = uidMatch ? uidMatch[1].trim() : crypto.randomUUID();
          const event = await service.createEvent(args.calendar as string, icsString, uid);
          return ok({ event });
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("Invalid recurrence_rule:")) {
            return error("validation_error", err.message);
          }
          throw err;
        }
      }

      case "update_event": {
        const span = (args.span as string) ?? "this";
        const { event: existing } = await service.getEventWithMeta(
          args.calendar as string,
          args.uid as string,
        );

        // span="this" on a recurring event: create exception VEVENT
        if (existing.is_recurring && span === "this") {
          const occurrenceDate = args.occurrence_date as string | undefined;
          if (!occurrenceDate) {
            return error(
              "validation_error",
              "occurrence_date is required when span is 'this' on a recurring event",
            );
          }

          const rawObj = await service.fetchRawCalendarObject(
            args.calendar as string,
            args.uid as string,
          );

          const overrides: {
            title?: string;
            start?: string;
            end?: string;
            all_day?: boolean;
            location?: string;
            description?: string;
            attendees?: Array<{ email: string }>;
            alarms?: Array<{ type: "relative" | "absolute"; trigger: number | string }>;
            categories?: string[];
            organizer?: { email: string; name?: string | null };
            availability?: "busy" | "free";
          } = {};
          if (args.title !== undefined) overrides.title = args.title as string;
          if (args.start !== undefined) overrides.start = args.start as string;
          if (args.end !== undefined) overrides.end = args.end as string;
          if (args.all_day !== undefined) overrides.all_day = args.all_day as boolean;
          if (args.location !== undefined) overrides.location = args.location as string;
          if (args.description !== undefined) overrides.description = args.description as string;
          if (args.attendees !== undefined)
            overrides.attendees = args.attendees as Array<{ email: string }>;
          if (args.alarms !== undefined)
            overrides.alarms = args.alarms as Array<{
              type: "relative" | "absolute";
              trigger: number | string;
            }>;
          if (args.categories !== undefined) overrides.categories = args.categories as string[];
          if (args.availability !== undefined)
            overrides.availability = args.availability as "busy" | "free";

          // If the effective event will have attendees but no organizer yet,
          // inject one so the CalDAV PUT satisfies server scheduling preconditions.
          const effectiveAttendees = overrides.attendees ?? existing.attendees;
          if (effectiveAttendees && effectiveAttendees.length > 0 && !existing.organizer) {
            overrides.organizer = { email: service.getAccountEmail(args.calendar as string) };
          }

          const exceptionVevent = createExceptionComponent(
            rawObj.data,
            "vevent",
            occurrenceDate,
            overrides,
            existing.all_day,
          );
          const combinedIcs = combineIcsComponents(rawObj.data, exceptionVevent);

          await service.updateEvent(args.calendar as string, args.uid as string, combinedIcs, {
            url: rawObj.url,
            etag: rawObj.etag,
          });

          // Build response from overrides + existing
          const occDuration = new Date(existing.end).getTime() - new Date(existing.start).getTime();
          const responseEvent = {
            ...existing,
            title: overrides.title ?? existing.title,
            start: overrides.start ?? occurrenceDate,
            end:
              overrides.end ??
              new Date(new Date(occurrenceDate).getTime() + occDuration).toISOString(),
            all_day: overrides.all_day ?? existing.all_day,
            location: overrides.location ?? existing.location,
            description: overrides.description ?? existing.description,
            attendees: overrides.attendees ?? existing.attendees,
            alarms: overrides.alarms ?? existing.alarms,
            categories: overrides.categories ?? existing.categories,
            occurrence_date: occurrenceDate,
            recurrence_rule: null,
          };
          return ok({ event: responseEvent });
        }

        // Non-exception path (span "all", or non-recurring event): mutate the
        // existing object in place — preserves RRULE/EXDATE/RDATE, exception
        // overrides, attendee participation state, STATUS, and unknown props.
        const rawObj = await service.fetchRawCalendarObject(
          args.calendar as string,
          args.uid as string,
        );

        const updates: MasterEventUpdates = { timezone: getTimezone() };
        if (args.title !== undefined) updates.title = args.title as string;
        if (args.start !== undefined) updates.start = args.start as string;
        if (args.end !== undefined) updates.end = args.end as string;
        if (args.all_day !== undefined) updates.all_day = args.all_day as boolean;
        if (args.location !== undefined) updates.location = args.location as string;
        if (args.description !== undefined) updates.description = args.description as string;
        if (args.attendees !== undefined)
          updates.attendees = args.attendees as Array<{ email: string }>;
        if (args.alarms !== undefined)
          updates.alarms = args.alarms as Array<{
            type: "relative" | "absolute";
            trigger: number | string;
          }>;
        if (args.categories !== undefined) updates.categories = args.categories as string[];
        if (args.availability !== undefined)
          updates.availability = args.availability as "busy" | "free";

        // Inject ORGANIZER only when the event will have attendees but has none
        // (CalDAV scheduling servers reject ATTENDEE-without-ORGANIZER, RFC 6638).
        const effectiveAttendees = updates.attendees ?? existing.attendees;
        if (effectiveAttendees && effectiveAttendees.length > 0 && !existing.organizer) {
          updates.organizer = { email: service.getAccountEmail(args.calendar as string) };
        }

        const updatedIcs = updateMasterEventIcs(rawObj.data, updates);
        const event = await service.updateEvent(
          args.calendar as string,
          args.uid as string,
          updatedIcs,
          {
            url: rawObj.url,
            etag: rawObj.etag,
          },
        );
        return ok({ event });
      }

      case "move_event": {
        const { meta } = await service.getEventWithMeta(
          args.calendar as string,
          args.uid as string,
        );
        const event = await service.moveEvent(
          args.calendar as string,
          args.uid as string,
          args.target_calendar as string,
          meta,
        );
        return ok({ event });
      }

      case "delete_event": {
        const span = (args.span as string) ?? "all";

        // span="this" on a recurring event: add EXDATE to exclude this occurrence
        if (span === "this") {
          const { event: existing, meta: eventMeta } = await service.getEventWithMeta(
            args.calendar as string,
            args.uid as string,
          );

          if (existing.is_recurring) {
            const occurrenceDate = args.occurrence_date as string | undefined;
            if (!occurrenceDate) {
              return error(
                "validation_error",
                "occurrence_date is required when span is 'this' on a recurring event",
              );
            }

            const rawObj = await service.fetchRawCalendarObject(
              args.calendar as string,
              args.uid as string,
            );

            let updatedIcs = addExdateToIcs(rawObj.data, occurrenceDate, existing.all_day);

            // Remove any existing exception VEVENT/VTODO for this occurrence,
            // matching by resolved instant (handles both UTC and TZID-form
            // RECURRENCE-ID) rather than a literal-text regex.
            updatedIcs = removeExceptionFromIcs(updatedIcs, occurrenceDate, existing.all_day);

            await service.updateEvent(args.calendar as string, args.uid as string, updatedIcs, {
              url: rawObj.url,
              etag: rawObj.etag,
            });
            return ok({ deleted: true, uid: args.uid });
          }

          // Non-recurring with span="this" — just delete normally
          await service.deleteEvent(args.calendar as string, args.uid as string, eventMeta);
          return ok({ deleted: true, uid: args.uid });
        }

        // span="all" — delete the entire calendar object
        await service.deleteEvent(args.calendar as string, args.uid as string);
        return ok({ deleted: true, uid: args.uid });
      }

      case "create_events_batch": {
        const eventInputs = args.events as Array<{
          title: string;
          start: string;
          end: string;
          all_day?: boolean;
          location?: string;
          description?: string;
          attendees?: Array<{ email: string }>;
          alarms?: Array<{ type: "relative" | "absolute"; trigger: number | string }>;
          categories?: string[];
          recurrence_rule?: string;
          availability?: "busy" | "free";
        }>;
        const calendarId = args.calendar as string;
        const accountEmail = service.getAccountEmail(calendarId);
        const createdEvents = [];
        try {
          for (const input of eventInputs) {
            const organizer =
              input.attendees && input.attendees.length > 0 ? { email: accountEmail } : undefined;
            const icsString = generateEventIcs({
              ...input,
              organizer,
              timezone: getTimezone(),
            });
            const uidMatch = icsString.match(/UID:(.+)/);
            const uid = uidMatch ? uidMatch[1].trim() : crypto.randomUUID();
            const event = await service.createEvent(calendarId, icsString, uid);
            createdEvents.push(event);
          }
        } catch (err) {
          if (err instanceof Error && err.message.startsWith("Invalid recurrence_rule:")) {
            return error("validation_error", err.message);
          }
          throw err;
        }
        return ok({ created: createdEvents.length, events: createdEvents });
      }

      case "import_ics": {
        const icsContent = args.ics_content as string;
        const groups = splitIcsByUid(icsContent);
        if (groups.length === 0) {
          return error("validation_error", "No events found in ICS content");
        }
        const importedEvents = [];
        const failed: Array<{ uid: string; message: string }> = [];
        for (const group of groups) {
          try {
            await service.createEvent(args.calendar as string, group.ics, group.uid);
            try {
              importedEvents.push(await service.getEvent(args.calendar as string, group.uid));
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
      }

      case "find_free_slots": {
        let calendarIds = args.calendars as string[] | undefined;
        if (!calendarIds || calendarIds.length === 0) {
          const allCals = await service.listCalendars();
          calendarIds = allCals.map((c: { calendar_id: string }) => c.calendar_id);
        }
        const slots = await service.findFreeSlots(
          calendarIds,
          args.start as string,
          args.end as string,
          args.duration as number,
          {
            preferredStart: args.preferred_start as string | undefined,
            preferredEnd: args.preferred_end as string | undefined,
            ignoreTentative: (args.ignore_tentative as boolean) ?? false,
            excludeCalendars: args.exclude_calendars as string[] | undefined,
            includeAllDayAsBusy: (args.include_all_day_as_busy as boolean) ?? false,
          },
        );
        return ok({ slots, count: slots.length });
      }

      default:
        return error("validation_error", `Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) {
      const calErr = err as any;
      if (calErr.code === "CALENDAR_NOT_FOUND" || calErr.code === "EVENT_NOT_FOUND") {
        return error("not_found", calErr.message);
      }
    }
    const pimError = toPimError(err instanceof Error ? err : new Error(String(err)));
    return error("backend_error", pimError.message);
  }
}
