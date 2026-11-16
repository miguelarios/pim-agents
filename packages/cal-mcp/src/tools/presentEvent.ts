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
}

const UTC_MIDNIGHT = /T00:00:00(\.000)?Z$/;

function asDate(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : new Date(ms).toISOString().slice(0, 10);
}

function asLocal(iso: string, timezone: string): string {
  return Number.isNaN(Date.parse(iso)) ? iso : formatInTimezone(iso, timezone);
}

export function presentEvent<T extends EventTimes>(event: T, timezone: string): T {
  const render = (iso: string) => (event.allDay ? asDate(iso) : asLocal(iso, timezone));
  const occ = event.occurrenceDate;
  return {
    ...event,
    start: render(event.start),
    end: render(event.end),
    // The slot belongs to the series, which an override may have changed the
    // type of: a date-valued RECURRENCE-ID is UTC midnight here, anything else
    // is a time.
    occurrenceDate:
      occ === null
        ? null
        : event.allDay && UTC_MIDNIGHT.test(occ)
          ? asDate(occ)
          : asLocal(occ, timezone),
  };
}

/** `presentEvent` over a tool payload's `event` and `events` fields. */
export function presentPayload<T>(payload: T, timezone: string): T {
  if (payload === null || typeof payload !== "object") return payload;
  const p = payload as Record<string, unknown>;
  const out: Record<string, unknown> = { ...p };
  if (p.event && typeof p.event === "object") {
    out.event = presentEvent(p.event as EventTimes, timezone);
  }
  if (Array.isArray(p.events)) {
    out.events = p.events.map((e) => presentEvent(e as EventTimes, timezone));
  }
  return out as T;
}
