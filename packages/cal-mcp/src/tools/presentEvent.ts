/**
 * How event times leave the server. Inside, `start`, `end` and `occurrenceDate`
 * are UTC instants (all-day ones anchored at UTC midnight), which is what the
 * ICS helpers and free/busy maths compare. A caller reading them as UTC has to
 * do its own zone conversion, and an all-day `2026-11-16T00:00:00Z` reads as
 * the previous evening anywhere west of Greenwich. So at the tool boundary:
 *
 * - a timed value becomes local wall-clock time in `PIM_TIMEZONE` with its
 *   offset (`2026-11-16T08:30:00-06:00`), the same instant, as
 *   `find_free_slots` already returns;
 * - an all-day value becomes a plain date (`2026-11-16`); `end` stays
 *   exclusive, as DTEND is.
 *
 * Both forms parse back to the instant the server uses, so an `occurrenceDate`
 * handed back to `get_event`, `update_event` or `delete_event` still matches.
 */
import { formatInTimezone } from "@miguelarios/pim-core";

interface EventTimes {
  start: string;
  end: string;
  allDay: boolean;
  occurrenceDate: string | null;
  /** Internal: the RECURRENCE-ID is a date. Consumed here, never sent. */
  occurrenceAllDay?: boolean;
}

const UTC_MIDNIGHT = /T00:00:00(\.000)?Z$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function asDate(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toISOString().slice(0, 10);
}

function asLocal(iso: string, timezone: string): string {
  return Number.isNaN(Date.parse(iso)) ? iso : formatInTimezone(iso, timezone);
}

/**
 * `timezone` if Intl knows it, else UTC. A bad `PIM_TIMEZONE` must not turn a
 * write that already reached the server into a reported failure.
 */
function usableZone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    return "UTC";
  }
}

export function presentEvent<T extends EventTimes>(event: T, timezone: string): T {
  const { occurrenceAllDay, ...rest } = event;
  const render = (iso: string) => (event.allDay ? asDate(iso) : asLocal(iso, timezone));
  const occ = event.occurrenceDate;
  // The slot belongs to the series, which may be all-day even when this
  // occurrence was moved to a timed slot. Without the parser's flag (an event
  // built from tool input), fall back to the value's own form.
  const occIsDate =
    occ !== null &&
    (occurrenceAllDay ?? (DATE_ONLY.test(occ) || (event.allDay && UTC_MIDNIGHT.test(occ))));
  return {
    ...rest,
    start: render(event.start),
    end: render(event.end),
    occurrenceDate: occ === null ? null : occIsDate ? asDate(occ) : asLocal(occ, timezone),
  } as T;
}

/** `presentEvent` over a tool payload's `event` and `events` fields. */
export function presentPayload<T>(payload: T, timezone: string): T {
  if (payload === null || typeof payload !== "object") return payload;
  const zone = usableZone(timezone);
  const p = payload as Record<string, unknown>;
  const out: Record<string, unknown> = { ...p };
  // import_ics reports an event it could not read back as just `{ uid }`.
  const isEvent = (e: unknown): e is EventTimes =>
    typeof e === "object" && e !== null && typeof (e as EventTimes).start === "string";
  if (isEvent(p.event)) out.event = presentEvent(p.event, zone);
  if (Array.isArray(p.events)) {
    out.events = p.events.map((e) => (isEvent(e) ? presentEvent(e, zone) : e));
  }
  return out as T;
}
