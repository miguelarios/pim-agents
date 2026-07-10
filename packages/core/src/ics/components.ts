import ICAL from "ical.js";
import "./_tz-init.js";
import { parseAttendees, parseCategories, parseOrganizer } from "./_shared.js";
import { IcsParseError } from "./errors.js";
import { toIcalTime } from "./generate.js";

export interface ExceptionOverrides {
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
}

export interface MasterEventUpdates {
  title?: string;
  start?: string; // ISO 8601
  end?: string;
  all_day?: boolean;
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
  const recurProp = ex.updatePropertyWithValue("recurrence-id", recurId);
  if (allDay) recurProp.setParameter("value", "DATE");

  const startIso = overrides.start ?? defaultStart;
  const endIso = overrides.end ?? defaultEnd;
  const isAllDay = overrides.all_day ?? allDay;

  const dtstart = ICAL.Time.fromJSDate(new Date(startIso), true);
  if (isAllDay) dtstart.isDate = true;
  const dtstartProp = ex.updatePropertyWithValue("dtstart", dtstart);
  if (isAllDay) dtstartProp.setParameter("value", "DATE");

  const dtend = ICAL.Time.fromJSDate(new Date(endIso), true);
  if (isAllDay) dtend.isDate = true;
  const dtendProp = ex.updatePropertyWithValue("dtend", dtend);
  if (isAllDay) dtendProp.setParameter("value", "DATE");

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
  if (categories && categories.length > 0) {
    ex.addPropertyWithValue("categories", categories.join(","));
  }

  const availability = overrides.availability ?? masterAvailability;
  if (availability === "free") ex.updatePropertyWithValue("transp", "TRANSPARENT");
  else if (availability === "busy") ex.updatePropertyWithValue("transp", "OPAQUE");

  ex.updatePropertyWithValue("status", "CONFIRMED");

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

  const exProp = master.addPropertyWithValue("exdate", newDate);
  if (allDay) exProp.setParameter("value", "DATE");
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
  const allDay = updates.all_day ?? currentAllDay;

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
    if (allDay) prop.setParameter("value", "DATE");
    else if (effectiveTz && ICAL.TimezoneService.get(effectiveTz)) {
      prop.setParameter("tzid", effectiveTz);
    }
  };
  if (updates.start !== undefined) setTime("dtstart", updates.start);
  if (updates.end !== undefined) setTime("dtend", updates.end);

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

  if (updates.categories !== undefined) {
    master.removeAllProperties("categories");
    if (updates.categories.length > 0) {
      master.addPropertyWithValue("categories", updates.categories.join(","));
    }
  }

  if (updates.availability === "free") master.updatePropertyWithValue("transp", "TRANSPARENT");
  else if (updates.availability === "busy") master.updatePropertyWithValue("transp", "OPAQUE");

  if (updates.alarms !== undefined) {
    for (const valarm of master.getAllSubcomponents("valarm")) {
      master.removeSubcomponent(valarm);
    }
    for (const alarm of updates.alarms) {
      const valarm = new ICAL.Component("valarm");
      valarm.updatePropertyWithValue("action", "DISPLAY");
      const summary = master.getFirstPropertyValue("summary");
      valarm.updatePropertyWithValue(
        "description",
        typeof summary === "string" ? summary : "Reminder",
      );
      if (alarm.type === "relative" && typeof alarm.trigger === "number") {
        valarm.updatePropertyWithValue("trigger", ICAL.Duration.fromSeconds(alarm.trigger));
      } else if (alarm.type === "absolute" && typeof alarm.trigger === "string") {
        valarm.updatePropertyWithValue(
          "trigger",
          ICAL.Time.fromJSDate(new Date(alarm.trigger), true),
        );
      }
      master.addSubcomponent(valarm);
    }
  }

  const seq = master.getFirstPropertyValue("sequence");
  master.updatePropertyWithValue("sequence", (typeof seq === "number" ? seq : 0) + 1);
  master.updatePropertyWithValue("dtstamp", ICAL.Time.now());

  return root.toString();
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
