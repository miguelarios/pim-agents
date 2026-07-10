// packages/core/src/ics/generate.ts
import { randomUUID } from "node:crypto";
import ICAL from "ical.js";
import "./_tz-init.js";
import { IcsGenerateError } from "./errors.js";
import { normalizeRecurrenceRule } from "./rrule.js";
import type { EventCreateProps } from "./types.js";

export function toIcalTime(iso: string, allDay: boolean, tzid?: string): ICAL.Time {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new IcsGenerateError(`Invalid ISO date: ${iso}`, null);
  }
  if (allDay) {
    return ICAL.Time.fromDateString(date.toISOString().slice(0, 10));
  }
  if (tzid) {
    const zone = ICAL.TimezoneService.get(tzid);
    if (zone) {
      const utc = ICAL.Time.fromJSDate(date, true);
      return utc.convertToZone(zone);
    }
  }
  return ICAL.Time.fromJSDate(date, true);
}

export function generateEventIcs(props: EventCreateProps): string {
  if (props.attendees && props.attendees.length > 0 && !props.organizer) {
    throw new IcsGenerateError("ORGANIZER is required when ATTENDEE is present (RFC 6638)", null);
  }

  const calendar = new ICAL.Component(["vcalendar", [], []]);
  calendar.updatePropertyWithValue("prodid", "-//pim-core//cal-mcp//EN");
  calendar.updatePropertyWithValue("version", "2.0");

  if (props.timezone) {
    const zone = ICAL.TimezoneService.get(props.timezone);
    if (zone?.component) {
      calendar.addSubcomponent(zone.component);
    }
  }

  const vevent = new ICAL.Component("vevent");

  const uid = props.uid ?? `${randomUUID()}@pim-core`;
  vevent.updatePropertyWithValue("uid", uid);
  vevent.updatePropertyWithValue("dtstamp", ICAL.Time.now());
  vevent.updatePropertyWithValue("summary", props.title);
  vevent.updatePropertyWithValue("status", "CONFIRMED");

  const allDay = props.all_day === true;
  const dtstart = toIcalTime(props.start, allDay, props.timezone);
  const dtend = toIcalTime(props.end, allDay, props.timezone);
  const dtstartProp = vevent.updatePropertyWithValue("dtstart", dtstart);
  const dtendProp = vevent.updatePropertyWithValue("dtend", dtend);
  if (props.timezone && !allDay) {
    dtstartProp.setParameter("tzid", props.timezone);
    dtendProp.setParameter("tzid", props.timezone);
  }

  if (props.location) vevent.updatePropertyWithValue("location", props.location);
  if (props.description) vevent.updatePropertyWithValue("description", props.description);

  if (props.availability === "free") vevent.updatePropertyWithValue("transp", "TRANSPARENT");
  else if (props.availability === "busy") vevent.updatePropertyWithValue("transp", "OPAQUE");

  if (props.organizer) {
    const name =
      props.organizer.name && props.organizer.name.trim().length > 0
        ? props.organizer.name
        : props.organizer.email.split("@")[0];
    const orgProp = vevent.updatePropertyWithValue("organizer", `mailto:${props.organizer.email}`);
    orgProp.setParameter("cn", name);
  }

  if (props.attendees) {
    for (const att of props.attendees) {
      vevent.addPropertyWithValue("attendee", `mailto:${att.email}`);
    }
  }

  if (props.categories && props.categories.length > 0) {
    vevent.addPropertyWithValue("categories", props.categories.join(","));
  }

  if (props.recurrence_rule) {
    const normalized = normalizeRecurrenceRule(props.recurrence_rule);
    if (!normalized) {
      throw new IcsGenerateError(`Invalid recurrence_rule: ${props.recurrence_rule}`, null);
    }
    vevent.addProperty(ICAL.Property.fromString(`RRULE:${normalized}`));
  }

  if (props.alarms) {
    for (const alarm of props.alarms) {
      const valarm = new ICAL.Component("valarm");
      valarm.updatePropertyWithValue("action", "DISPLAY");
      valarm.updatePropertyWithValue("description", props.title);
      if (alarm.type === "relative" && typeof alarm.trigger === "number") {
        const dur = ICAL.Duration.fromSeconds(alarm.trigger);
        valarm.updatePropertyWithValue("trigger", dur);
      } else if (alarm.type === "absolute" && typeof alarm.trigger === "string") {
        const t = ICAL.Time.fromJSDate(new Date(alarm.trigger), true);
        valarm.updatePropertyWithValue("trigger", t);
      }
      vevent.addSubcomponent(valarm);
    }
  }

  calendar.addSubcomponent(vevent);
  return calendar.toString();
}
