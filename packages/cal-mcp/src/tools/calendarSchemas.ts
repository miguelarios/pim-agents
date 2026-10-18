/**
 * Valibot output schemas for the calendar tools. These drive the `outputSchema`
 * advertised in `tools/list` and validate `structuredContent` before it leaves
 * the server.
 *
 * They mirror `CalendarInfo`, `EventSummary`, `EventFull` and `FreeSlot` from
 * `../services/CalDavService.js`. `list_events` and friends can return either
 * the summary or the full shape depending on `detailLevel`, so the event
 * schema is the summary shape with every full-only field optional.
 */
import * as v from "valibot";

const nullableString = v.nullable(v.string());

export const calendarSchema = v.object({
  calendarId: v.string(),
  displayName: v.string(),
  color: nullableString,
  description: nullableString,
  timezone: nullableString,
  order: v.nullable(v.number()),
  source: v.string(),
  readOnly: v.boolean(),
  url: v.string(),
  ctag: v.optional(v.string()),
});

const attendeeSchema = v.object({
  name: nullableString,
  email: v.string(),
  status: nullableString,
  role: nullableString,
  type: v.string(),
});

const alarmSchema = v.object({
  type: v.picklist(["relative", "absolute"]),
  trigger: v.union([v.number(), v.string()]),
  triggerHuman: v.string(),
});

/** Summary fields, plus the full-detail fields as optional. */
export const eventSchema = v.object({
  uid: v.string(),
  calendarId: v.string(),
  title: v.string(),
  start: v.string(),
  end: v.string(),
  allDay: v.boolean(),
  location: nullableString,
  status: nullableString,
  isRecurring: v.boolean(),
  occurrenceDate: nullableString,
  description: v.optional(nullableString),
  url: v.optional(nullableString),
  availability: v.optional(nullableString),
  attendees: v.optional(v.array(attendeeSchema)),
  organizer: v.optional(v.nullable(v.object({ name: nullableString, email: v.string() }))),
  recurrenceRule: v.optional(nullableString),
  created: v.optional(nullableString),
  lastModified: v.optional(nullableString),
  alarms: v.optional(v.array(alarmSchema)),
  categories: v.optional(v.array(v.string())),
  geo: v.optional(v.nullable(v.object({ latitude: v.number(), longitude: v.number() }))),
});

/**
 * Present only when a listing spanning every provider skipped some, so a
 * caller can tell "no events" from "could not ask" (#127).
 */
const unavailableProvidersSchema = v.optional(
  v.array(v.object({ provider: v.string(), error: v.string() })),
);

export const calendarListSchema = v.object({
  calendars: v.array(calendarSchema),
  unavailableProviders: unavailableProvidersSchema,
});

export const eventListSchema = v.object({
  events: v.array(eventSchema),
  unavailableProviders: unavailableProvidersSchema,
});

export const singleEventSchema = v.object({
  event: eventSchema,
});

export const deleteResultSchema = v.object({
  deleted: v.boolean(),
  uid: v.string(),
});

export const batchCreateSchema = v.object({
  created: v.number(),
  events: v.array(eventSchema),
});

/** `import_ics` reports partial success: events that failed keep their UID and reason. */
export const importResultSchema = v.object({
  imported: v.number(),
  failed: v.optional(v.array(v.object({ uid: v.string(), message: v.string() }))),
  events: v.array(v.union([eventSchema, v.object({ uid: v.string() })])),
});

export const freeSlotsSchema = v.object({
  slots: v.array(v.object({ start: v.string(), end: v.string(), duration: v.number() })),
  count: v.number(),
});

/** `get_free_busy`: typed busy periods, and which path each calendar's answer took. */
export const freeBusySchema = v.object({
  start: v.string(),
  end: v.string(),
  busy: v.array(
    v.object({
      start: v.string(),
      end: v.string(),
      type: v.picklist(["busy", "tentative", "unavailable"]),
    }),
  ),
  count: v.number(),
  sources: v.record(v.string(), v.picklist(["server", "computed"])),
});

/**
 * Result of the three collection-management tools. `calendarId` is always the
 * post-operation ID, so a rename hands back the ID that resolves from now on
 * rather than the one the caller passed in.
 */
export const calendarWriteResultSchema = v.object({
  status: v.picklist(["created", "updated", "deleted"]),
  calendarId: v.string(),
  url: v.string(),
  displayName: v.optional(v.string()),
});

/** get_calendar_sharing, share_calendar and unshare_calendar (#47). */
export const calendarSharingSchema = v.object({
  calendarId: v.string(),
  canBeShared: v.boolean(),
  canBePublished: v.boolean(),
  protocol: v.nullable(v.picklist(["calendarserver", "owncloud", "webdav"])),
  shares: v.array(
    v.object({
      email: nullableString,
      principal: nullableString,
      name: nullableString,
      access: v.picklist(["read", "read-write"]),
      status: v.picklist(["accepted", "pending", "declined", "invalid"]),
    }),
  ),
});
