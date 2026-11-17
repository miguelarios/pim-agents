# cal-mcp: event times in the user's zone, all-day events as dates

**Date:** 2026-11-16
**Scope:** cal-mcp output (breaking, needs 2.0.0); pim-core `ParsedEvent.timeZone` (additive, minor)

## Problem

Every event tool returned `start`, `end` and `occurrenceDate` as UTC instants
(`2026-11-16T14:30:00.000Z`), and dropped the zone the event was written in.

- Every caller had to convert to local time itself, which is how agents read
  times wrong.
- All-day events came back as UTC midnight (`2026-11-16T00:00:00.000Z`). Read
  as an instant, that's the previous evening anywhere west of Greenwich.
- Nothing said whether `14:30Z` was an organizer's 08:30 Chicago, a UTC time
  or a floating time.

`find_free_slots` and email-mcp already return local time with an offset.

## Design

- **pim-core** adds `timeZone` to `ParsedEvent`: DTSTART's TZID, `"UTC"` for a
  UTC time, `null` for a floating time or a date. The TZID parameter is read
  directly, so a zone ical.js has no definition for is still named. `start` and
  `end` are still UTC instants. The ICS helpers, free/busy merging and
  occurrence matching all compare those, and none of them change.
- **cal-mcp** renders event times at the output boundary, in `ok()`, through
  `presentEvent`:
  - Timed values become wall-clock time in `PIM_TIMEZONE` with their offset
    (`2026-11-16T08:30:00-06:00`). It's the same instant, and the offset
    follows DST for each occurrence.
  - All-day values become plain dates (`2026-11-16`). `end` stays exclusive,
    as DTEND is.
  - `occurrenceDate` is a date for an all-day series and a local time
    otherwise. "Series" matters here: an occurrence moved to a timed slot
    still has a date RECURRENCE-ID. pim-core reports this as
    `ParsedEvent.occurrenceAllDay`; cal-mcp uses it and strips it from
    results. For events built from tool input, which have no flag, a plain
    `YYYY-MM-DD` value stays a date.
  - Each event gains `timeZone`.

If Intl doesn't know `PIM_TIMEZONE`, rendering falls back to UTC. It doesn't
throw, because by the time a result is rendered, a create, update or move has
already reached the server, and reporting it as a failure would invite a
duplicate retry.

Both forms parse back (via `Date.parse`) to the instant the server uses
internally, so an `occurrenceDate` passed back to `get_event`, `update_event`
or `delete_event` still matches. A plain date parses as UTC midnight, which is
exactly how date-only values are anchored inside.

## Rejected

- **Additive fields (`startLocal`, `startDate`) next to UTC `start`, in a
  minor.** This would avoid a major, but it leaves the misleading UTC-midnight
  `start` as the field every caller reads first. The owner chose the breaking
  change.
- **Render in each event's own TZID instead of `PIM_TIMEZONE`.** A listing
  would mix offsets, and the user reads times in their own zone. The event's
  zone is still available in `timeZone`.
- **Change the parser's output.** `start`/`end` strings are compared and
  parsed throughout cal-mcp and pim-core's ICS helpers (`mergeFreeBusy` even
  compares them as strings). Converting only at the boundary keeps that code
  unchanged.
