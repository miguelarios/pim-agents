/**
 * Valibot output schemas for the calendar tools. These drive the `outputSchema`
 * advertised in `tools/list` and validate `structuredContent` before it leaves
 * the server.
 *
 * They mirror `CalendarInfo`, `EventSummary`, `EventFull` and `FreeSlot` from
 * `../services/CalDavService.js`. `list_events` and friends can return either
 * the summary or the full shape depending on `detail_level`, so the event
 * schema is the summary shape with every full-only field optional.
 */
import * as v from "valibot";

const nullableString = v.nullable(v.string());

export const calendarSchema = v.object({
  calendar_id: v.string(),
  display_name: v.string(),
  color: nullableString,
  source: v.string(),
  read_only: v.boolean(),
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
  trigger_human: v.string(),
});

/** Summary fields, plus the full-detail fields as optional. */
export const eventSchema = v.object({
  uid: v.string(),
  calendar_id: v.string(),
  title: v.string(),
  start: v.string(),
  end: v.string(),
  all_day: v.boolean(),
  location: nullableString,
  status: nullableString,
  is_recurring: v.boolean(),
  occurrence_date: nullableString,
  description: v.optional(nullableString),
  url: v.optional(nullableString),
  availability: v.optional(nullableString),
  attendees: v.optional(v.array(attendeeSchema)),
  organizer: v.optional(v.nullable(v.object({ name: nullableString, email: v.string() }))),
  recurrence_rule: v.optional(nullableString),
  created: v.optional(nullableString),
  last_modified: v.optional(nullableString),
  alarms: v.optional(v.array(alarmSchema)),
  categories: v.optional(v.array(v.string())),
  geo: v.optional(v.nullable(v.object({ latitude: v.number(), longitude: v.number() }))),
});

export const calendarListSchema = v.object({
  calendars: v.array(calendarSchema),
});

export const eventListSchema = v.object({
  events: v.array(eventSchema),
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

/**
 * Result of the three collection-management tools. `calendar_id` is always the
 * post-operation ID, so a rename hands back the ID that resolves from now on
 * rather than the one the caller passed in.
 */
export const calendarWriteResultSchema = v.object({
  status: v.picklist(["created", "updated", "deleted"]),
  calendar_id: v.string(),
  url: v.string(),
  display_name: v.optional(v.string()),
});
