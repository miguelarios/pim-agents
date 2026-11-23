import ICAL from "ical.js";
import "./_tz-init.js";
import {
  parseAttendees,
  parseCategories,
  parseOrganizer,
  setAlarms,
  setCategories,
} from "./_shared.js";
import { IcsParseError } from "./errors.js";
import { toIcalTime } from "./generate.js";

export interface ExceptionOverrides {
  title?: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  location?: string;
  description?: string;
  attendees?: Array<{ email: string }>;
  alarms?: Array<{ type: "relative" | "absolute"; trigger: number | string }>;
  categories?: string[];
  organizer?: { email: string; name?: string | null };
  availability?: "busy" | "free";
}

export interface MasterEventUpdates {
  title?: string;
  start?: string; // ISO 8601
  end?: string;
  allDay?: boolean;
  location?: string; // "" removes the property
  description?: string; // "" removes the property
  attendees?: Array<{ email: string }>; // replaces the list (participation state of replaced attendees is reset — inherent)
  alarms?: Array<{ type: "relative" | "absolute"; trigger: number | string }>;
  categories?: string[];
  organizer?: { email: string; name?: string | null };
  availability?: "busy" | "free";
  timezone?: string; // TZID for rewritten DTSTART/DTEND
}

function parseRoot(ics: string): ICAL.Component {
  try {
    return ICAL.Component.fromString(ics);
  } catch (e) {
    throw new IcsParseError("Invalid ICS content", e);
  }
}

/** YYYY-MM-DD of a time's own calendar date, for DATE-valued comparisons. */
function ymdOf(time: ICAL.Time): string {
  return `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`;
}

/** Whether a DATE or DATE-TIME value names the given occurrence instant. */
function timeMatches(time: ICAL.Time, occurrenceMs: number, allDay: boolean): boolean {
  if (allDay && time.isDate)
    return ymdOf(time) === new Date(occurrenceMs).toISOString().slice(0, 10);
  if (allDay !== time.isDate) return false;
  return time.toJSDate().getTime() === occurrenceMs;
}

/**
 * Drops every EXDATE value on the master that names `occurrenceMs`. Used when
 * an override is added for that occurrence: RFC 5545 §3.8.5.1 excludes the
 * instance outright, so an override left behind an EXDATE is invisible.
 */
function removeExdate(master: ICAL.Component, occurrenceMs: number, allDay: boolean): boolean {
  let removed = false;
  for (const prop of master.getAllProperties("exdate")) {
    const values = prop.getValues();
    const kept = values.filter(
      (v) => !(v instanceof ICAL.Time) || !timeMatches(v, occurrenceMs, allDay),
    );
    if (kept.length === values.length) continue;
    removed = true;
    if (kept.length === 0) master.removeProperty(prop);
    else prop.setValues(kept);
  }
  return removed;
}

export function createExceptionComponent(
  masterIcs: string,
  componentType: "vevent" | "vtodo",
  occurrenceDate: string,
  overrides: ExceptionOverrides,
  allDay: boolean,
): string {
  const masterRoot = parseRoot(masterIcs);
  const masterComp = masterRoot.getFirstSubcomponent(componentType);
  if (!masterComp) throw new IcsParseError(`No ${componentType} found in master ICS`, null);

  // Read fields directly from the already-parsed component instead of running a
  // second full pass through parseIcsEvents.
  const rawUid = masterComp.getFirstPropertyValue("uid");
  const uid = typeof rawUid === "string" ? rawUid : "";
  const masterDtstart = masterComp.getFirstPropertyValue("dtstart");
  const masterDtend = masterComp.getFirstPropertyValue("dtend");
  const masterStartMs = masterDtstart instanceof ICAL.Time ? masterDtstart.toJSDate().getTime() : 0;
  const masterEndMs = masterDtend instanceof ICAL.Time ? masterDtend.toJSDate().getTime() : 0;
  const duration = masterEndMs - masterStartMs;
  const occMs = new Date(occurrenceDate).getTime();
  const defaultStart = new Date(occMs).toISOString();
  const defaultEnd = new Date(occMs + duration).toISOString();

  const rawSummary = masterComp.getFirstPropertyValue("summary");
  const masterTitle = typeof rawSummary === "string" ? rawSummary : "";
  const rawLocation = masterComp.getFirstPropertyValue("location");
  const masterLocation =
    typeof rawLocation === "string" && rawLocation.length > 0 ? rawLocation : null;
  const rawDescription = masterComp.getFirstPropertyValue("description");
  const masterDescription =
    typeof rawDescription === "string" && rawDescription.length > 0 ? rawDescription : null;
  const masterOrganizer = parseOrganizer(masterComp);
  const masterAttendees = parseAttendees(masterComp);
  const masterCategories = parseCategories(masterComp);
  const masterTransp = masterComp.getFirstPropertyValue("transp");
  let masterAvailability: "busy" | "free" | null = null;
  if (typeof masterTransp === "string") {
    if (masterTransp.toUpperCase() === "OPAQUE") masterAvailability = "busy";
    else if (masterTransp.toUpperCase() === "TRANSPARENT") masterAvailability = "free";
  }

  const ex = new ICAL.Component(componentType);
  ex.updatePropertyWithValue("uid", uid);

  const recurId = ICAL.Time.fromJSDate(new Date(occurrenceDate), true);
  if (allDay) recurId.isDate = true;
  ex.updatePropertyWithValue("recurrence-id", recurId);

  const startIso = overrides.start ?? defaultStart;
  const endIso = overrides.end ?? defaultEnd;
  const isAllDay = overrides.allDay ?? allDay;

  const dtstart = ICAL.Time.fromJSDate(new Date(startIso), true);
  if (isAllDay) dtstart.isDate = true;
  ex.updatePropertyWithValue("dtstart", dtstart);

  const dtend = ICAL.Time.fromJSDate(new Date(endIso), true);
  if (isAllDay) dtend.isDate = true;
  ex.updatePropertyWithValue("dtend", dtend);

  // SEQUENCE: bump master's
  const masterSeq = masterComp.getFirstPropertyValue("sequence");
  const seq = (typeof masterSeq === "number" ? masterSeq : 0) + 1;
  ex.updatePropertyWithValue("sequence", seq);

  ex.updatePropertyWithValue("summary", overrides.title ?? masterTitle);
  if (overrides.location ?? masterLocation) {
    ex.updatePropertyWithValue("location", overrides.location ?? masterLocation ?? "");
  }
  if (overrides.description ?? masterDescription) {
    ex.updatePropertyWithValue("description", overrides.description ?? masterDescription ?? "");
  }

  const organizer = overrides.organizer ?? masterOrganizer;
  if (organizer) {
    const name =
      organizer.name && organizer.name.trim().length > 0
        ? organizer.name
        : organizer.email.split("@")[0];
    const orgProp = ex.updatePropertyWithValue("organizer", `mailto:${organizer.email}`);
    orgProp.setParameter("cn", name);
  }

  const attendees = overrides.attendees ?? masterAttendees;
  if (attendees) {
    for (const att of attendees) {
      ex.addPropertyWithValue("attendee", `mailto:${att.email}`);
    }
  }

  const categories = overrides.categories ?? masterCategories;
  if (categories && categories.length > 0) setCategories(ex, categories);

  const availability = overrides.availability ?? masterAvailability;
  if (availability === "free") ex.updatePropertyWithValue("transp", "TRANSPARENT");
  else if (availability === "busy") ex.updatePropertyWithValue("transp", "OPAQUE");

  ex.updatePropertyWithValue("status", "CONFIRMED");

  // An override VEVENT stands alone — nothing is inherited from the master —
  // so the master's VALARMs have to be copied across or the occurrence
  // silently loses its reminders. An explicit `alarms` replaces them.
  if (overrides.alarms !== undefined) {
    setAlarms(ex, overrides.alarms);
  } else {
    for (const valarm of masterComp.getAllSubcomponents("valarm")) {
      ex.addSubcomponent(ICAL.Component.fromString(valarm.toString()));
    }
  }

  return ex.toString();
}

export function combineIcsComponents(masterIcs: string, exceptionComponent: string): string {
  const masterRoot = parseRoot(masterIcs);

  // Guard against double-wrap: callers should pass a bare BEGIN:VEVENT…END:VEVENT
  // block (the output of createExceptionComponent), not a full VCALENDAR.
  if (/BEGIN:VCALENDAR/i.test(exceptionComponent)) {
    throw new IcsParseError(
      "exceptionComponent must be a bare VEVENT/VTODO block, not a full VCALENDAR",
      null,
    );
  }

  // Wrap the bare exception VEVENT/VTODO in a synthetic VCALENDAR so it can be parsed.
  const wrapped = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//pim-core//combine//EN\r\n${exceptionComponent}\r\nEND:VCALENDAR`;
  const exRoot = parseRoot(wrapped);
  const exComp = exRoot.getFirstSubcomponent("vevent") ?? exRoot.getFirstSubcomponent("vtodo");
  if (!exComp) throw new IcsParseError("Exception component is not a VEVENT or VTODO", null);

  const exUid = exComp.getFirstPropertyValue("uid");
  const exRecurId = exComp.getFirstPropertyValue("recurrence-id");
  if (!(exRecurId instanceof ICAL.Time)) {
    throw new IcsParseError("Exception component must have a RECURRENCE-ID", null);
  }
  const exRecurMs = exRecurId.toJSDate().getTime();
  const componentName = exComp.name;

  // Find and remove any existing matching subcomponent.
  const existing = masterRoot.getAllSubcomponents(componentName);
  for (const sub of existing) {
    const subUid = sub.getFirstPropertyValue("uid");
    const subRecur = sub.getFirstPropertyValue("recurrence-id");
    if (
      subUid === exUid &&
      subRecur instanceof ICAL.Time &&
      subRecur.toJSDate().getTime() === exRecurMs
    ) {
      masterRoot.removeSubcomponent(sub);
    }
  }

  // An occurrence that was cancelled and is now being edited is being brought
  // back on purpose: the exclusion has to go, or the override never shows.
  const master = existing.find(
    (sub) => sub.getFirstPropertyValue("uid") === exUid && !sub.getFirstProperty("recurrence-id"),
  );
  if (master) removeExdate(master, exRecurMs, exRecurId.isDate);

  masterRoot.addSubcomponent(exComp);
  return masterRoot.toString();
}

export function addExdateToIcs(
  icsContent: string,
  occurrenceDate: string,
  allDay: boolean,
): string {
  const root = parseRoot(icsContent);
  // EXDATE goes on the master event (first VEVENT without a RECURRENCE-ID).
  const masters = root
    .getAllSubcomponents("vevent")
    .filter((c) => !c.getFirstProperty("recurrence-id"));
  const master = masters[0];
  if (!master) return icsContent;

  const newDate = ICAL.Time.fromJSDate(new Date(occurrenceDate), true);
  if (allDay) newDate.isDate = true;
  const newMs = newDate.toJSDate().getTime();
  const newYmd = `${newDate.year}-${String(newDate.month).padStart(2, "0")}-${String(newDate.day).padStart(2, "0")}`;

  // Idempotency check: scan existing EXDATE values. For all-day (DATE-typed)
  // EXDATEs compare YYYY-MM-DD strings — toJSDate() on a date-only value uses
  // local-midnight which can drift across DST boundaries vs. the new value's
  // UTC-midnight epoch ms. For date-time EXDATEs the epoch comparison works.
  for (const exProp of master.getAllProperties("exdate")) {
    for (const v of exProp.getValues()) {
      if (!(v instanceof ICAL.Time)) continue;
      if (allDay && v.isDate) {
        const vYmd = `${v.year}-${String(v.month).padStart(2, "0")}-${String(v.day).padStart(2, "0")}`;
        if (vYmd === newYmd) return icsContent;
      } else if (!allDay && !v.isDate && v.toJSDate().getTime() === newMs) {
        return icsContent;
      }
    }
  }

  master.addPropertyWithValue("exdate", newDate);
  return root.toString();
}

export function updateMasterEventIcs(rawIcs: string, updates: MasterEventUpdates): string {
  const root = parseRoot(rawIcs);
  const master = root
    .getAllSubcomponents("vevent")
    .find((c) => !c.getFirstProperty("recurrence-id"));
  if (!master) throw new IcsParseError("No master VEVENT found in ICS", null);

  const currentDtstart = master.getFirstPropertyValue("dtstart");
  const currentAllDay = currentDtstart instanceof ICAL.Time ? currentDtstart.isDate : false;
  const allDay = updates.allDay ?? currentAllDay;

  if (updates.title !== undefined) master.updatePropertyWithValue("summary", updates.title);

  const setTime = (propName: "dtstart" | "dtend", iso: string) => {
    const existing = master.getFirstProperty(propName);
    const existingTzid = existing?.getParameter("tzid");
    const effectiveTz =
      updates.timezone ?? (typeof existingTzid === "string" ? existingTzid : undefined);
    const t = toIcalTime(iso, allDay, effectiveTz);
    const prop = master.updatePropertyWithValue(propName, t);
    prop.removeParameter("tzid");
    prop.removeParameter("value");
    // No explicit VALUE=DATE: ical.js resets the property's type from the
    // value (an ICAL.Time with isDate is "date") and writes VALUE=DATE
    // itself, so adding it here wrote "DTSTART;VALUE=DATE;VALUE=DATE:...".
    if (!allDay && effectiveTz && ICAL.TimezoneService.get(effectiveTz)) {
      prop.setParameter("tzid", effectiveTz);
    }
  };
  const currentDtend = master.getFirstPropertyValue("dtend");
  if (updates.start !== undefined) setTime("dtstart", updates.start);
  if (updates.end !== undefined) setTime("dtend", updates.end);
  else if (
    updates.start !== undefined &&
    currentDtstart instanceof ICAL.Time &&
    currentDtend instanceof ICAL.Time
  ) {
    moveEndWithStart(master, currentDtstart, currentDtend);
  }

  // Moving the series moves its occurrences, so everything that names an
  // occurrence by its old time — EXDATE exclusions, RDATE additions and the
  // RECURRENCE-ID of each override — has to move with it. Left at the old
  // times they would match nothing: cancelled occurrences would come back,
  // added ones would stay pinned at the old slot, and per-occurrence edits
  // would silently detach. When the series also changes between all-day and
  // timed, they change type with it, and so does the RRULE's UNTIL.
  const newDtstart = master.getFirstPropertyValue("dtstart");
  if (
    updates.start !== undefined &&
    currentDtstart instanceof ICAL.Time &&
    newDtstart instanceof ICAL.Time &&
    master.getFirstProperty("rrule")
  ) {
    moveSeriesSlots(root, master, currentDtstart, newDtstart);
    moveRuleDays(master, currentDtstart, newDtstart);
  }

  const setOrRemove = (propName: string, value: string | undefined) => {
    if (value === undefined) return;
    if (value === "") master.removeAllProperties(propName);
    else master.updatePropertyWithValue(propName, value);
  };
  setOrRemove("location", updates.location);
  setOrRemove("description", updates.description);

  if (updates.organizer) {
    const name =
      updates.organizer.name && updates.organizer.name.trim().length > 0
        ? updates.organizer.name
        : updates.organizer.email.split("@")[0];
    const orgProp = master.updatePropertyWithValue(
      "organizer",
      `mailto:${updates.organizer.email}`,
    );
    orgProp.setParameter("cn", name);
  }

  if (updates.attendees !== undefined) {
    master.removeAllProperties("attendee");
    for (const att of updates.attendees) {
      master.addPropertyWithValue("attendee", `mailto:${att.email}`);
    }
  }

  if (updates.categories !== undefined) setCategories(master, updates.categories);

  if (updates.availability === "free") master.updatePropertyWithValue("transp", "TRANSPARENT");
  else if (updates.availability === "busy") master.updatePropertyWithValue("transp", "OPAQUE");

  if (updates.alarms !== undefined) setAlarms(master, updates.alarms);

  const seq = master.getFirstPropertyValue("sequence");
  master.updatePropertyWithValue("sequence", (typeof seq === "number" ? seq : 0) + 1);
  master.updatePropertyWithValue("dtstamp", ICAL.Time.now());

  return root.toString();
}

/** Compares an ICAL.Time against an instant, by calendar day for DATE values. */
function timeIsBefore(time: ICAL.Time, instantMs: number, allDay: boolean): boolean {
  if (allDay && time.isDate) {
    const ymd = `${time.year}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}`;
    return ymd < new Date(instantMs).toISOString().slice(0, 10);
  }
  return time.toJSDate().getTime() < instantMs;
}

/**
 * Ends a recurring series just before `occurrenceDate`, so that occurrence and
 * every later one stop being generated while earlier ones — and their
 * overrides — are kept.
 *
 * The master RRULE gets `UNTIL` set to the instant before the occurrence (one
 * second before for a date-time series, the previous day for an all-day one),
 * replacing any `COUNT` since RFC 5545 §3.3.10 forbids both. `RDATE`,
 * `EXDATE` and override VEVENTs at or after the cut are removed rather than
 * left dangling past the end of the rule. `SEQUENCE` is bumped so attendees'
 * clients notice the change.
 *
 * Returns `null` when nothing would remain — the cut is at or before the first
 * occurrence — so the caller can delete the object instead of leaving an empty
 * series behind.
 */
export function truncateRecurrenceIcs(
  icsContent: string,
  occurrenceDate: string,
  allDay: boolean,
): string | null {
  const root = parseRoot(icsContent);
  const master = root
    .getAllSubcomponents("vevent")
    .find((c) => !c.getFirstProperty("recurrence-id"));
  if (!master) throw new IcsParseError("No master VEVENT found in ICS", null);
  const rruleValue = master.getFirstPropertyValue("rrule");
  if (!(rruleValue instanceof ICAL.Recur)) {
    throw new IcsParseError("Master VEVENT has no RRULE to truncate", null);
  }

  const cutMs = new Date(occurrenceDate).getTime();
  if (Number.isNaN(cutMs))
    throw new IcsParseError(`Invalid occurrence date: ${occurrenceDate}`, null);

  const dtstart = master.getFirstPropertyValue("dtstart");
  if (dtstart instanceof ICAL.Time && !timeIsBefore(dtstart, cutMs, allDay)) return null;

  const until = allDay
    ? ICAL.Time.fromJSDate(new Date(cutMs - 86_400_000), true)
    : ICAL.Time.fromJSDate(new Date(cutMs - 1000), true);
  if (allDay) until.isDate = true;
  const recur = ICAL.Recur.fromString(rruleValue.toString());
  recur.count = null;
  recur.until = until;
  master.updatePropertyWithValue("rrule", recur);

  // Dates the rule no longer reaches: extra occurrences past the cut would
  // survive UNTIL, and exclusions past it would be noise.
  for (const name of ["rdate", "exdate"] as const) {
    for (const prop of master.getAllProperties(name)) {
      const kept = prop
        .getValues()
        .filter((v) => !(v instanceof ICAL.Time) || timeIsBefore(v, cutMs, allDay));
      if (kept.length === prop.getValues().length) continue;
      if (kept.length === 0) master.removeProperty(prop);
      else prop.setValues(kept);
    }
  }

  for (const comp of root.getAllSubcomponents("vevent")) {
    const recurId = comp.getFirstPropertyValue("recurrence-id");
    if (recurId instanceof ICAL.Time && !timeIsBefore(recurId, cutMs, allDay)) {
      root.removeSubcomponent(comp);
    }
  }

  const seq = master.getFirstPropertyValue("sequence");
  master.updatePropertyWithValue("sequence", (typeof seq === "number" ? seq : 0) + 1);
  master.updatePropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(), true));
  return root.toString();
}

/**
 * Splits a recurring series at `occurrenceDate` into two calendar objects:
 * `before`, the original series ended just before the cut (via
 * {@link truncateRecurrenceIcs}), and `after`, a copy of the master under
 * `newUid` whose DTSTART is the cut occurrence and whose rule carries on the
 * remaining pattern. This is the "this and future occurrences" edit: the
 * caller applies its changes to `after` and writes both.
 *
 * On `after`: a `COUNT` is reduced by the occurrences already consumed before
 * the cut, an `UNTIL` is kept as is; `RDATE`s and `EXDATE`s before the cut are
 * dropped (they belong to `before`) and later ones kept. Override VEVENTs at
 * or after the cut are not carried over: the caller is redefining the future,
 * and once DTSTART moves their RECURRENCE-IDs no longer line up with the rule.
 *
 * `droppedOverrides` counts the override VEVENTs at or after the cut that
 * neither half keeps, so a caller can warn before discarding them.
 *
 * Returns `null` when the cut is at or before the first occurrence, where a
 * split degenerates into editing the whole series. Throws when
 * `occurrenceDate` is not an occurrence the series generates (a rule instance
 * or an RDATE): a date that merely lands near one would silently become the
 * tail's DTSTART and shift every later occurrence.
 */
export function splitRecurrenceIcs(
  icsContent: string,
  occurrenceDate: string,
  allDay: boolean,
  newUid: string,
): { before: string; after: string; droppedOverrides: number } | null {
  const before = truncateRecurrenceIcs(icsContent, occurrenceDate, allDay);
  if (before === null) return null;

  const root = parseRoot(icsContent);
  const cutMs = new Date(occurrenceDate).getTime();
  let droppedOverrides = 0;
  for (const comp of root.getAllSubcomponents("vevent")) {
    const recurId = comp.getFirstPropertyValue("recurrence-id");
    if (!(recurId instanceof ICAL.Time)) continue;
    if (!timeIsBefore(recurId, cutMs, allDay)) droppedOverrides++;
    root.removeSubcomponent(comp);
  }
  const master = root.getFirstSubcomponent("vevent");
  if (!master) throw new IcsParseError("No master VEVENT found in ICS", null);
  const rruleValue = master.getFirstPropertyValue("rrule");
  const dtstart = master.getFirstPropertyValue("dtstart");
  const dtend = master.getFirstPropertyValue("dtend");
  if (!(rruleValue instanceof ICAL.Recur) || !(dtstart instanceof ICAL.Time)) {
    throw new IcsParseError("Master VEVENT has no RRULE to split", null);
  }

  // Occurrences the rule generates before the cut are spent; a COUNT on the
  // new series has to exclude them or the tail would run long. The first
  // instance at or after the cut must be the cut itself, unless an RDATE
  // names it: anything else is not an occurrence of this series.
  const recur = ICAL.Recur.fromString(rruleValue.toString());
  const iterator = recur.iterator(dtstart);
  let consumed = 0;
  let isOccurrence = master
    .getAllProperties("rdate")
    .flatMap((p) => p.getValues())
    .some((v) => v instanceof ICAL.Time && timeMatches(v, cutMs, allDay));
  for (let next = iterator.next(); next; next = iterator.next()) {
    if (timeIsBefore(next, cutMs, allDay)) {
      consumed++;
      continue;
    }
    if (timeMatches(next, cutMs, allDay)) isOccurrence = true;
    break;
  }
  if (!isOccurrence) {
    throw new IcsParseError(
      `No occurrence at ${occurrenceDate} — occurrenceDate must be a value list_events returned for this event`,
      null,
    );
  }
  if (recur.count !== null && recur.count !== undefined) recur.count -= consumed;
  master.updatePropertyWithValue("rrule", recur);

  master.updatePropertyWithValue("uid", newUid);
  const durationMs =
    dtend instanceof ICAL.Time ? dtend.toJSDate().getTime() - dtstart.toJSDate().getTime() : 0;
  const tzid = master.getFirstProperty("dtstart")?.getParameter("tzid");
  const setTime = (name: "dtstart" | "dtend", ms: number) => {
    const t = toIcalTime(
      new Date(ms).toISOString(),
      allDay,
      typeof tzid === "string" ? tzid : undefined,
    );
    const prop = master.updatePropertyWithValue(name, t);
    prop.removeParameter("tzid");
    prop.removeParameter("value");
    // No explicit VALUE=DATE: ical.js resets the property's type from the
    // value (an ICAL.Time with isDate is "date") and writes VALUE=DATE
    // itself, so adding it here wrote "DTSTART;VALUE=DATE;VALUE=DATE:...".
    if (!allDay && typeof tzid === "string" && ICAL.TimezoneService.get(tzid)) {
      prop.setParameter("tzid", tzid);
    }
  };
  setTime("dtstart", cutMs);
  if (dtend instanceof ICAL.Time) setTime("dtend", cutMs + durationMs);

  for (const name of ["rdate", "exdate"] as const) {
    for (const prop of master.getAllProperties(name)) {
      const kept = prop
        .getValues()
        .filter((v) => !(v instanceof ICAL.Time) || !timeIsBefore(v, cutMs, allDay));
      if (kept.length === prop.getValues().length) continue;
      if (kept.length === 0) master.removeProperty(prop);
      else prop.setValues(kept);
    }
  }

  master.updatePropertyWithValue("sequence", 0);
  master.updatePropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(), true));
  master.updatePropertyWithValue("created", ICAL.Time.fromJSDate(new Date(), true));
  master.removeAllProperties("last-modified");
  return { before, after: root.toString(), droppedOverrides };
}

// Removes any VEVENT/VTODO whose RECURRENCE-ID resolves to the same instant as
// occurrenceDate. ical.js resolves RECURRENCE-ID;TZID=... to the correct
// instant when the VTIMEZONE is present, so this epoch comparison (matching
// addExdateToIcs's convention) handles both UTC (...Z) and TZID-qualified
// forms — unlike a regex matching the literal UTC text.
export function removeExceptionFromIcs(
  icsContent: string,
  occurrenceDate: string,
  allDay: boolean,
): string {
  const root = parseRoot(icsContent);
  const target = ICAL.Time.fromJSDate(new Date(occurrenceDate), true);
  const targetMs = target.toJSDate().getTime();
  const targetYmd = `${target.year}-${String(target.month).padStart(2, "0")}-${String(target.day).padStart(2, "0")}`;
  let removed = false;
  for (const type of ["vevent", "vtodo"] as const) {
    for (const comp of root.getAllSubcomponents(type)) {
      const recurId = comp.getFirstPropertyValue("recurrence-id");
      if (!(recurId instanceof ICAL.Time)) continue;
      const matches =
        allDay && recurId.isDate
          ? `${recurId.year}-${String(recurId.month).padStart(2, "0")}-${String(recurId.day).padStart(2, "0")}` ===
            targetYmd
          : recurId.toJSDate().getTime() === targetMs;
      if (matches) {
        root.removeSubcomponent(comp);
        removed = true;
      }
    }
  }
  return removed ? root.toString() : icsContent;
}

// Splits a multi-event ICS file into one VCALENDAR per unique UID. RFC 4791
// §4.1 requires exactly one UID per calendar object; SabreDAV (Nextcloud)
// rejects or corrupts PUTs that bundle multiple UIDs into a single object.
// Each output group carries that UID's master event plus any RECURRENCE-ID
// overrides for the same UID, and a copy of every VTIMEZONE subcomponent
// from the source (so zoned DTSTART/DTEND still resolve after the split).
export function splitIcsByUid(icsContent: string): Array<{ uid: string; ics: string }> {
  const root = parseRoot(icsContent);
  const timezones = root.getAllSubcomponents("vtimezone");
  const byUid = new Map<string, ICAL.Component[]>();
  for (const type of ["vevent", "vtodo"] as const) {
    for (const comp of root.getAllSubcomponents(type)) {
      const uid = comp.getFirstPropertyValue("uid");
      if (typeof uid !== "string" || !uid) continue;
      const list = byUid.get(uid) ?? [];
      list.push(comp);
      byUid.set(uid, list);
    }
  }
  const results: Array<{ uid: string; ics: string }> = [];
  for (const [uid, comps] of byUid) {
    const cal = new ICAL.Component(["vcalendar", [], []]);
    cal.updatePropertyWithValue("prodid", "-//pim-core//import-split//EN");
    cal.updatePropertyWithValue("version", "2.0");
    for (const tz of timezones) cal.addSubcomponent(ICAL.Component.fromString(tz.toString()));
    for (const comp of comps) cal.addSubcomponent(ICAL.Component.fromString(comp.toString()));
    results.push({ uid, ics: cal.toString() });
  }
  return results;
}

/**
 * After DTSTART moved on its own, moves DTEND so the event keeps the length
 * it had (from `oldStart` to `oldEnd`), so it cannot end before it starts.
 *
 * The length is wall-clock time, read from the values' own fields. An
 * 18:00-to-18:00 two-day block stays 18:00 to 18:00 across a DST change, and
 * nothing is read in the host process's zone, which is what `toJSDate` does
 * with a date or a floating time. Only when start and end are in different
 * zones is the length absolute. An all-day result keeps whole days, at least
 * one.
 */
function moveEndWithStart(master: ICAL.Component, oldStart: ICAL.Time, oldEnd: ICAL.Time): void {
  const start = master.getFirstPropertyValue("dtstart");
  if (!(start instanceof ICAL.Time)) return;
  const wall = (t: ICAL.Time) =>
    Date.UTC(
      t.year,
      t.month - 1,
      t.day,
      t.isDate ? 0 : t.hour,
      t.isDate ? 0 : t.minute,
      t.isDate ? 0 : t.second,
    );
  const sameZone = (oldStart.zone?.tzid ?? null) === (oldEnd.zone?.tzid ?? null);
  const lengthMs = sameZone
    ? wall(oldEnd) - wall(oldStart)
    : oldEnd.toJSDate().getTime() - oldStart.toJSDate().getTime();
  const end = start.clone();
  if (start.isDate) {
    end.adjust(Math.max(1, Math.round(lengthMs / 86_400_000)), 0, 0, 0);
  } else {
    end.adjust(0, 0, 0, Math.round(lengthMs / 1000));
  }
  const prop = master.updatePropertyWithValue("dtend", end);
  prop.removeParameter("tzid");
  prop.removeParameter("value");
  const tzid = master.getFirstProperty("dtstart")?.getParameter("tzid");
  if (!start.isDate && typeof tzid === "string") prop.setParameter("tzid", tzid);
}

const DAY_MS = 86_400_000;

/** Whole days from `a`'s calendar date to `b`'s, read from their own fields. */
function dayDiff(a: ICAL.Time, b: ICAL.Time): number {
  return Math.round(
    (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / DAY_MS,
  );
}

/** `t` as wall-clock time in `ref`'s zone, when both are zoned and differ. */
function inZoneOf(t: ICAL.Time, ref: ICAL.Time): ICAL.Time {
  const floating = (z: ICAL.Timezone | undefined | null) => !z || z === ICAL.Timezone.localTimezone;
  if (t.isDate || floating(t.zone) || floating(ref.zone) || t.zone?.tzid === ref.zone?.tzid)
    return t;
  return t.convertToZone(ref.zone as ICAL.Timezone);
}

/**
 * The occurrence slot `slot` of a series that started at `oldStart`, for the
 * series once it starts at `newStart`.
 *
 * - **Timed to timed:** the slot moves by the same instant delta, as before.
 * - **All-day to all-day:** it moves by whole days.
 * - **Across kinds:** it keeps its day offset from the series start. It takes
 *   the new start's time of day and zone when the series becomes timed, or
 *   its local date when the series becomes all-day.
 */
function moveSlot(slot: ICAL.Time, oldStart: ICAL.Time, newStart: ICAL.Time): ICAL.Time {
  if (!oldStart.isDate && !newStart.isDate && !slot.isDate) {
    const deltaS = Math.round(
      (newStart.toJSDate().getTime() - oldStart.toJSDate().getTime()) / 1000,
    );
    const moved = slot.clone();
    moved.adjust(0, 0, 0, deltaS);
    return moved;
  }
  const days = dayDiff(inZoneOf(oldStart, oldStart), inZoneOf(slot, oldStart));
  const moved = newStart.clone();
  moved.adjust(days, 0, 0, 0);
  return moved;
}

/**
 * Writes `values` to `prop`. When their type changed (date ↔ date-time), the
 * parameters are rewritten for the new type: the series' TZID for a zoned
 * date-time, none for a date or UTC. Otherwise they're kept, so a UTC
 * exclusion on a zoned series stays UTC.
 */
function setSlotValues(
  prop: ICAL.Property,
  values: ICAL.Time[],
  like: ICAL.Time,
  tzid: unknown,
  typeChanged: boolean,
): void {
  if (typeChanged) {
    prop.removeParameter("tzid");
    prop.removeParameter("value");
  }
  if (values.length === 1) prop.setValue(values[0]);
  else prop.setValues(values);
  if (
    typeChanged &&
    !like.isDate &&
    typeof tzid === "string" &&
    like.zone !== ICAL.Timezone.utcTimezone
  ) {
    prop.setParameter("tzid", tzid);
  }
}

/**
 * Moves every slot of the series `master` from a start at `oldStart` to
 * `newStart`: EXDATE, RDATE (date and date-time values; periods are left
 * alone), the RECURRENCE-ID of each override, and, when the series changes
 * between all-day and timed, the RRULE's UNTIL. An UNTIL keeps its own last
 * day. A timed series takes it at the new start's time, in UTC as RFC 5545
 * §3.3.10 requires for a zoned DTSTART, and an all-day series takes its local
 * date.
 */
function moveSeriesSlots(
  root: ICAL.Component,
  master: ICAL.Component,
  oldStart: ICAL.Time,
  newStart: ICAL.Time,
): void {
  const kindChanged = oldStart.isDate !== newStart.isDate;
  const unchanged =
    !kindChanged &&
    (newStart.isDate
      ? dayDiff(oldStart, newStart) === 0
      : newStart.toJSDate().getTime() === oldStart.toJSDate().getTime());
  if (unchanged) return;
  const tzid = master.getFirstProperty("dtstart")?.getParameter("tzid");

  for (const name of ["exdate", "rdate"] as const) {
    for (const prop of master.getAllProperties(name)) {
      const values = prop.getValues();
      if (!values.every((v) => v instanceof ICAL.Time)) continue; // RDATE periods
      const slots = values as ICAL.Time[];
      const moved = slots.map((v) => moveSlot(v, oldStart, newStart));
      setSlotValues(
        prop,
        moved,
        newStart,
        tzid,
        slots.some((v) => v.isDate !== newStart.isDate),
      );
    }
  }
  for (const comp of root.getAllSubcomponents("vevent")) {
    const recurProp = comp.getFirstProperty("recurrence-id");
    const recurId = recurProp?.getFirstValue();
    if (recurProp && recurId instanceof ICAL.Time) {
      const moved = moveSlot(recurId, oldStart, newStart);
      setSlotValues(recurProp, [moved], newStart, tzid, recurId.isDate !== newStart.isDate);
    }
  }

  if (!kindChanged) return;
  const rruleProp = master.getFirstProperty("rrule");
  const rule = rruleProp?.getFirstValue();
  if (!rruleProp || !(rule instanceof ICAL.Recur) || !(rule.until instanceof ICAL.Time)) return;
  const until = rule.until;
  if (newStart.isDate) {
    // The series' last day is the day of its last occurrence at or before
    // UNTIL. When UNTIL's local time is earlier than the series' start time
    // (truncateRecurrenceIcs writes one second before the cut), that's the
    // day before UNTIL's own date.
    let local = inZoneOf(until, oldStart);
    const secondsOfDay = (t: ICAL.Time) =>
      t.isDate ? 0 : t.hour * 3600 + t.minute * 60 + t.second;
    if (secondsOfDay(local) < secondsOfDay(inZoneOf(oldStart, oldStart))) {
      local = local.clone();
      local.adjust(-1, 0, 0, 0);
    }
    rule.until = ICAL.Time.fromDateString(
      `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`,
    );
  } else {
    const last = newStart.clone();
    last.adjust(dayDiff(newStart, until), 0, 0, 0);
    rule.until = last.convertToZone(ICAL.Timezone.utcTimezone);
  }
  rruleProp.setValue(rule);
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/**
 * Which week of its month `t` falls in: 1-5 counting from the start, or -1 to
 * -5 counting from the end, as an ordinal BYDAY (3WE, -1FR) names it.
 */
function weekOfMonth(t: ICAL.Time, fromEnd: boolean): number {
  if (!fromEnd) return Math.ceil(t.day / 7);
  return -Math.ceil((ICAL.Time.daysInMonth(t.month, t.year) - t.day + 1) / 7);
}

/**
 * After DTSTART moved to another day, moves the RRULE's day parts with it.
 * Without this, a weekly BYDAY=WE series moved to Thursday kept recurring on
 * Wednesdays and lost the moved first occurrence, which matches no rule day.
 *
 * Only what is unambiguous moves. A part moves only when it named the old
 * start's day, which is how a client that writes BYDAY for a plain weekly
 * event (Apple, Google) puts it. Days are read in each start's own zone.
 *
 * - **Plain BYDAY** (WE, or MO,WE): left alone if it already includes the new
 *   weekday (an every-weekday MO..FR rule, or a BYSETPOS rule, which picks
 *   from the set). Otherwise every day moves by the same amount, so MO,WE a
 *   day later is TU,TH.
 * - **Ordinal BYDAY** (3WE, -1FR): a single entry takes the new weekday, with
 *   the week of the month recomputed from the new date. Nov 8 is the 2nd
 *   Sunday, so 1SA moved to Nov 8 becomes 2SU. Several ordinal entries are
 *   left alone.
 * - **BYMONTHDAY:** positive days move by the change in day of the month,
 *   unless one would leave 1..31. Counts from the end (-1) are kept.
 * - **BYMONTH** (yearly rules): moves with the date's month.
 */
function moveRuleDays(master: ICAL.Component, oldStart: ICAL.Time, newStart: ICAL.Time): void {
  const rruleProp = master.getFirstProperty("rrule");
  const rule = rruleProp?.getFirstValue();
  if (!rruleProp || !(rule instanceof ICAL.Recur)) return;
  if (dayDiff(oldStart, newStart) === 0) return;
  let changed = false;

  const oldDay = WEEKDAYS[oldStart.dayOfWeek() - 1];
  const newDay = WEEKDAYS[newStart.dayOfWeek() - 1];
  const byDay = rule.parts.BYDAY as string[] | undefined;
  const parsed = (byDay ?? []).map((d) => /^([+-]?\d*)([A-Z]{2})$/.exec(d));
  if (byDay && byDay.length > 0 && parsed.every(Boolean)) {
    const entries = parsed.map((m) => ({
      ordinal: (m as RegExpExecArray)[1],
      day: (m as RegExpExecArray)[2],
    }));
    if (entries.some((e) => e.ordinal !== "")) {
      const [only] = entries;
      if (entries.length === 1 && only.day === oldDay) {
        const week = weekOfMonth(newStart, Number(only.ordinal) < 0);
        const next = `${week}${newDay}`;
        if (next !== byDay[0]) {
          rule.parts.BYDAY = [next];
          changed = true;
        }
      }
    } else {
      const days = entries.map((e) => e.day);
      if (newDay !== oldDay && days.includes(oldDay) && !days.includes(newDay)) {
        const shift = (WEEKDAYS.indexOf(newDay) - WEEKDAYS.indexOf(oldDay) + 7) % 7;
        rule.parts.BYDAY = days.map(
          (d) => WEEKDAYS[(WEEKDAYS.indexOf(d as (typeof WEEKDAYS)[number]) + shift) % 7],
        );
        changed = true;
      }
    }
  }

  const byMonthDay = rule.parts.BYMONTHDAY as number[] | undefined;
  if (byMonthDay?.includes(oldStart.day) && newStart.day !== oldStart.day) {
    const delta = newStart.day - oldStart.day;
    const moved = byMonthDay.map((d) => (d > 0 ? d + delta : d));
    // Only the originally positive days moved; each must still name a day.
    if (byMonthDay.every((d, k) => d < 0 || (moved[k] >= 1 && moved[k] <= 31))) {
      rule.parts.BYMONTHDAY = moved;
      changed = true;
    }
  }

  const byMonth = rule.parts.BYMONTH as number[] | undefined;
  if (
    rule.freq === "YEARLY" &&
    byMonth?.includes(oldStart.month) &&
    newStart.month !== oldStart.month &&
    !byMonth.includes(newStart.month)
  ) {
    const delta = newStart.month - oldStart.month;
    rule.parts.BYMONTH = byMonth.map((m) => ((((m - 1 + delta) % 12) + 12) % 12) + 1);
    changed = true;
  }

  if (changed) rruleProp.setValue(rule);
}
