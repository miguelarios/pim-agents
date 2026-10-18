import ICAL from "ical.js";
import "./_tz-init.js";
import {
  parseAlarms,
  parseAttendees,
  parseCategories,
  parseGeo,
  parseOrganizer,
  timeToIso,
} from "./_shared.js";
import { IcsParseError } from "./errors.js";
import type { ParsedEvent, TimeRange } from "./types.js";

function nullIfEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.length > 0 ? value : null;
}

function buildBaseEvent(component: ICAL.Component): Omit<ParsedEvent, "start" | "end"> {
  const url = component.getFirstPropertyValue("url");
  const status = component.getFirstPropertyValue("status");
  const transp = component.getFirstPropertyValue("transp");
  const rrule = component.getFirstPropertyValue("rrule");
  const created = component.getFirstPropertyValue("created");
  const lastModified = component.getFirstPropertyValue("last-modified");

  const rdateProps = component.getAllProperties("rdate");
  const rdates: string[] = [];
  for (const prop of rdateProps) {
    for (const v of prop.getValues()) {
      if (v instanceof ICAL.Time) rdates.push(timeToIso(v));
    }
  }

  let availability: string | null = null;
  if (typeof transp === "string") {
    if (transp.toUpperCase() === "OPAQUE") availability = "busy";
    else if (transp.toUpperCase() === "TRANSPARENT") availability = "free";
  }

  const summary = component.getFirstPropertyValue("summary");
  const uid = component.getFirstPropertyValue("uid");
  const location = component.getFirstPropertyValue("location");
  const description = component.getFirstPropertyValue("description");

  return {
    uid: typeof uid === "string" ? uid : "",
    title: typeof summary === "string" ? summary : "",
    all_day: false, // overwritten below per-instance
    location: nullIfEmpty(location),
    description: nullIfEmpty(description),
    status: typeof status === "string" ? status.toLowerCase() : null,
    availability,
    url: typeof url === "string" && url.length > 0 ? url : null,
    attendees: parseAttendees(component),
    categories: parseCategories(component),
    geo: parseGeo(component),
    organizer: parseOrganizer(component),
    recurrence_rule: rrule ? rrule.toString() : null,
    rdates: rdates.length > 0 ? rdates : null,
    created: created instanceof ICAL.Time ? created.toJSDate().toISOString() : null,
    last_modified: lastModified instanceof ICAL.Time ? lastModified.toJSDate().toISOString() : null,
    is_recurring: !!rrule || rdates.length > 0,
    alarms: parseAlarms(component),
    occurrence_date: null,
  };
}

function dateOnlyToIso(time: ICAL.Time): string {
  // For VALUE=DATE values, treat as UTC midnight rather than local-midnight.
  // ICAL.Time.toJSDate() for date-only values uses the local Date constructor
  // which makes the result depend on the test machine's tz; we want a
  // deterministic ISO string anchored at UTC midnight.
  const yyyy = time.year.toString().padStart(4, "0");
  const mm = time.month.toString().padStart(2, "0");
  const dd = time.day.toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T00:00:00.000Z`;
}

function timeToEventIso(time: ICAL.Time): string {
  return time.isDate ? dateOnlyToIso(time) : time.toJSDate().toISOString();
}

// A floating time has no TZID and is not UTC ("Z"). In ical.js v2 the parser
// assigns ICAL.Timezone.localTimezone to such values, which makes
// toJSDate() interpret the wall-clock components in the host process tz.
// That makes parser output non-deterministic across machines. When the caller
// passes a `timezone` argument, treat it as the viewer's preferred zone and
// re-anchor the wall-clock there before converting to UTC.
function isFloating(time: ICAL.Time): boolean {
  if (time.isDate) return false;
  const zone = time.zone;
  return zone === ICAL.Timezone.localTimezone || zone == null;
}

function timeToEventIsoWithTz(time: ICAL.Time, timezone?: string): string {
  if (time.isDate) return dateOnlyToIso(time);
  if (timezone && isFloating(time)) {
    const tz = ICAL.TimezoneService.get(timezone);
    if (tz) {
      // Build a fresh ICAL.Time with the same wall-clock components anchored
      // in the requested zone. Mutating `time.zone` directly also works in
      // ical.js v2 but constructing a new value avoids touching the caller's
      // component tree.
      const rebound = new ICAL.Time(
        {
          year: time.year,
          month: time.month,
          day: time.day,
          hour: time.hour,
          minute: time.minute,
          second: time.second,
          isDate: false,
        },
        tz,
      );
      return rebound.toJSDate().toISOString();
    }
  }
  return time.toJSDate().toISOString();
}

/**
 * What is known about the series an instance with a RECURRENCE-ID belongs to:
 * the master, when it is in the payload; "expanded" when the instance came
 * out of a ranged listing with no master (a server that honours <expand>);
 * null when there is no series to speak of (an override stored on its own,
 * as an invitation to a single occurrence is).
 */
type SeriesContext = Pick<ParsedEvent, "recurrence_rule" | "rdates"> | "expanded" | null;

function emitNonExpanded(
  component: ICAL.Component,
  isException: boolean,
  timezone?: string,
  series: SeriesContext = null,
): ParsedEvent[] {
  const base = buildBaseEvent(component);
  const dtstart = component.getFirstPropertyValue("dtstart");
  const dtend = component.getFirstPropertyValue("dtend");
  if (!(dtstart instanceof ICAL.Time)) return [];
  const allDay = dtstart.isDate;
  const startIso = timeToEventIsoWithTz(dtstart, timezone);
  const endIso = dtend instanceof ICAL.Time ? timeToEventIsoWithTz(dtend, timezone) : startIso;
  let occDate: string | null = null;
  if (isException) {
    const recurId = component.getFirstPropertyValue("recurrence-id");
    // Same conversion as start/end and as emitOccurrences, so a date-only
    // RECURRENCE-ID is UTC midnight here too rather than host-local midnight.
    if (recurId instanceof ICAL.Time) occDate = timeToEventIsoWithTz(recurId, timezone);
  }
  return [
    {
      ...base,
      all_day: allDay,
      start: startIso,
      end: endIso,
      occurrence_date: occDate,
      // A RECURRENCE-ID makes this an occurrence of a series even without an
      // RRULE of its own: a detached override never carries one, and a server
      // that honours calendar-query <expand> (SabreDAV/Nextcloud) returns
      // every instance that way, with no master in the payload (#99). It does
      // not when there is no series behind it: an override stored on its own
      // has no master to edit, and calling it recurring would send writes
      // down the per-occurrence paths that assume one.
      is_recurring: base.is_recurring || (occDate !== null && series !== null),
      ...(series && series !== "expanded"
        ? { recurrence_rule: series.recurrence_rule, rdates: series.rdates }
        : {}),
    },
  ];
}

function emitOccurrences(event: ICAL.Event, range: TimeRange, timezone?: string): ParsedEvent[] {
  const out: ParsedEvent[] = [];
  const rangeStart = ICAL.Time.fromJSDate(new Date(range.start), true);
  const rangeEnd = ICAL.Time.fromJSDate(new Date(range.end), true);
  // Series-level fields belong to the master. An override VEVENT carries no
  // RRULE of its own, so building them from it made a moved occurrence report
  // is_recurring: false and no rule while its siblings reported both (#99).
  const series = buildBaseEvent(event.component);
  const it = event.iterator();
  // event.iterator().next() returns null/undefined when the series is exhausted
  // (finite RRULEs with COUNT or UNTIL hit this branch). Range is half-open
  // [start, end) per RFC 4791 §9.9 — an occurrence whose DTSTART equals
  // range.end is excluded.
  while (true) {
    const next: ICAL.Time | null | undefined = it.next();
    if (!next) break;
    if (next.compare(rangeEnd) >= 0) break;
    if (next.compare(rangeStart) < 0) continue;
    const details = event.getOccurrenceDetails(next);
    const effective = details.item; // master or exception override
    const base = buildBaseEvent(effective.component);
    const allDay = details.startDate.isDate;
    out.push({
      ...base,
      recurrence_rule: series.recurrence_rule,
      rdates: series.rdates,
      is_recurring: true,
      all_day: allDay,
      start: timeToEventIsoWithTz(details.startDate, timezone),
      end: timeToEventIsoWithTz(details.endDate, timezone),
      // occurrence_date is the original RRULE-generated slot (RECURRENCE-ID).
      // For ordinary occurrences this equals startDate; for exception overrides
      // it is the original time the occurrence was supposed to fire, which is
      // what consumers need to reconcile overrides back to the master series.
      occurrence_date: timeToEventIsoWithTz(details.recurrenceId, timezone),
    });
  }
  return out;
}

export function parseIcsEvents(
  icsContent: string,
  range?: TimeRange,
  timezone?: string,
): ParsedEvent[] {
  if (!icsContent.trim()) return [];

  let root: ICAL.Component;
  try {
    root = ICAL.Component.fromString(icsContent);
  } catch (e) {
    throw new IcsParseError("Invalid ICS content", e);
  }

  const veventComponents = root.getAllSubcomponents("vevent");
  // Group by UID. Master events have no RECURRENCE-ID; exception VEVENTs do.
  const groups = new Map<string, { master: ICAL.Component | null; exceptions: ICAL.Component[] }>();
  for (const comp of veventComponents) {
    // UID is REQUIRED by RFC 5545 §3.8.4.7 but real-world fixtures sometimes
    // omit it (e.g. ical.js sample timezone_from_file.ics). Bucket UID-less
    // VEVENTs under the empty string so they still surface to consumers
    // rather than being silently dropped.
    const rawUid = comp.getFirstPropertyValue("uid");
    const uid = typeof rawUid === "string" ? rawUid : "";
    let group = groups.get(uid);
    if (!group) {
      group = { master: null, exceptions: [] };
      groups.set(uid, group);
    }
    if (comp.getFirstProperty("recurrence-id")) {
      group.exceptions.push(comp);
    } else {
      group.master = comp;
    }
  }

  const out: ParsedEvent[] = [];

  for (const [, group] of groups) {
    if (!group.master) {
      // Orphan exception VEVENTs (master not in this ICS) — emit each as standalone.
      for (const ex of group.exceptions) {
        out.push(...emitNonExpanded(ex, true, timezone, range ? "expanded" : null));
      }
      continue;
    }

    let event: ICAL.Event;
    try {
      event = new ICAL.Event(group.master);
      for (const ex of group.exceptions) {
        event.relateException(new ICAL.Event(ex));
      }
    } catch {
      // If ICAL.Event construction fails for this group, skip it but don't fail the batch.
      continue;
    }

    if (event.isRecurring() && range) {
      out.push(...emitOccurrences(event, range, timezone));
    } else {
      out.push(...emitNonExpanded(group.master, false, timezone));
      const series = event.isRecurring() ? buildBaseEvent(group.master) : null;
      for (const ex of group.exceptions) {
        out.push(...emitNonExpanded(ex, true, timezone, series));
      }
    }
  }

  return out;
}
