import ICAL from "ical.js";
import type { ParsedAlarm, ParsedAttendee, ParsedGeo, ParsedOrganizer } from "./types.js";

const CUTYPE_MAP: Record<string, string> = {
  INDIVIDUAL: "person",
  ROOM: "room",
  RESOURCE: "resource",
  GROUP: "group",
};

function stripMailto(value: string): string {
  return value.replace(/^mailto:/i, "");
}

/**
 * Writes CATEGORIES as one property with one value per category. Joining the
 * names with "," and writing a single value gets the comma escaped as "\\,",
 * so `parseCategories` reads a single "Work,Sync" back — the multi-value form
 * (RFC 5545 §3.8.1.2) is what every other client writes and reads.
 */
export function setCategories(component: ICAL.Component, categories: string[]): void {
  component.removeAllProperties("categories");
  if (categories.length === 0) return;
  const prop = new ICAL.Property("categories");
  prop.setValues(categories);
  component.addProperty(prop);
}

export interface AlarmInput {
  type: "relative" | "absolute";
  trigger: number | string;
}

/** Replaces every VALARM on the component with DISPLAY alarms for `alarms`. */
export function setAlarms(component: ICAL.Component, alarms: AlarmInput[]): void {
  for (const valarm of component.getAllSubcomponents("valarm")) {
    component.removeSubcomponent(valarm);
  }
  const summary = component.getFirstPropertyValue("summary");
  for (const alarm of alarms) {
    const valarm = new ICAL.Component("valarm");
    valarm.updatePropertyWithValue("action", "DISPLAY");
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
    component.addSubcomponent(valarm);
  }
}

export function parseAttendees(component: ICAL.Component): ParsedAttendee[] {
  const properties = component.getAllProperties("attendee");
  return properties.map((prop) => {
    const value = prop.getFirstValue() as string | undefined;
    const email = typeof value === "string" ? stripMailto(value) : "";
    const cnRaw = prop.getParameter("cn");
    const cn = typeof cnRaw === "string" ? cnRaw : null;
    const partstatRaw = prop.getParameter("partstat");
    const partstat = typeof partstatRaw === "string" ? partstatRaw : undefined;
    const roleRaw = prop.getParameter("role");
    const role = typeof roleRaw === "string" ? roleRaw : undefined;
    const cutypeRaw = prop.getParameter("cutype");
    // RFC 5545 §3.2.3: CUTYPE defaults to INDIVIDUAL when absent.
    const cutype = typeof cutypeRaw === "string" && cutypeRaw.length > 0 ? cutypeRaw : "INDIVIDUAL";
    return {
      email,
      name: cn,
      status: partstat ? partstat.toLowerCase() : null,
      role: role ? role.toLowerCase() : null,
      type: CUTYPE_MAP[cutype] ?? "unknown",
    };
  });
}

export function parseOrganizer(component: ICAL.Component): ParsedOrganizer | null {
  const prop = component.getFirstProperty("organizer");
  if (!prop) return null;
  const value = prop.getFirstValue() as string | undefined;
  const email = typeof value === "string" ? stripMailto(value) : "";
  if (!email) return null;
  const cnRaw = prop.getParameter("cn");
  const name = typeof cnRaw === "string" ? cnRaw : null;
  return { email, name };
}

export function parseCategories(component: ICAL.Component): string[] {
  const properties = component.getAllProperties("categories");
  const out: string[] = [];
  for (const prop of properties) {
    const values = prop.getValues();
    for (const v of values) {
      if (typeof v === "string" && v.length > 0) out.push(v);
    }
  }
  return out;
}

export function parseGeo(component: ICAL.Component): ParsedGeo | null {
  const prop = component.getFirstProperty("geo");
  if (!prop) return null;
  const value = prop.getFirstValue() as unknown;
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [lat, lon] = value as [number, number];
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
  // Reject GEO:; sentinel: ical.js parses `GEO:;` (empty value) as [0, 0]
  // (verified). The 0,0 false-rejection at Gulf-of-Guinea (0°N 0°E) is a known
  // edge case — preferred over surfacing corrupted-GEO data as a real location.
  // If you genuinely need 0,0, a future change can disambiguate by inspecting
  // the raw property string for "GEO:;" vs "GEO:0;0".
  if (lat === 0 && lon === 0) return null;
  return { latitude: lat, longitude: lon };
}

export function parseDurationToSeconds(duration: string): number {
  const negative = duration.startsWith("-");
  // RFC 5545 §3.3.6: PnW (weeks-only) is mutually exclusive with the date/time form.
  const weekMatch = duration.match(/P(\d+)W$/);
  if (weekMatch) {
    const weeks = Number.parseInt(weekMatch[1], 10);
    return (negative ? -1 : 1) * weeks * 604800;
  }
  const match = duration.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/);
  if (!match) return 0;
  const days = Number.parseInt(match[1] || "0", 10);
  const hours = Number.parseInt(match[2] || "0", 10);
  const minutes = Number.parseInt(match[3] || "0", 10);
  const seconds = Number.parseInt(match[4] || "0", 10);
  const total = days * 86400 + hours * 3600 + minutes * 60 + seconds;
  return negative ? -total : total;
}

export function formatTriggerHuman(seconds: number): string {
  if (seconds === 0) return "At time of event";
  const abs = Math.abs(seconds);
  const suffix = seconds < 0 ? "before" : "after";
  const parts: string[] = [];
  const days = Math.floor(abs / 86400);
  const hours = Math.floor((abs % 86400) / 3600);
  const minutes = Math.floor((abs % 3600) / 60);
  if (days > 0) parts.push(`${days} ${days === 1 ? "day" : "days"}`);
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  if (parts.length === 0) {
    parts.push(`${abs} ${abs === 1 ? "second" : "seconds"}`);
  }
  return `${parts.join(", ")} ${suffix}`;
}

export function parseAlarms(component: ICAL.Component): ParsedAlarm[] {
  const valarms = component.getAllSubcomponents("valarm");
  const out: ParsedAlarm[] = [];
  for (const valarm of valarms) {
    const triggerProp = valarm.getFirstProperty("trigger");
    if (!triggerProp) continue;
    const value = triggerProp.getFirstValue();
    if (value instanceof ICAL.Time) {
      const date = value.toJSDate();
      out.push({
        type: "absolute",
        trigger: date.toISOString(),
        trigger_human: date.toISOString(),
      });
    } else if (value instanceof ICAL.Duration) {
      const seconds = value.toSeconds();
      out.push({
        type: "relative",
        trigger: seconds,
        trigger_human: formatTriggerHuman(seconds),
      });
    }
  }
  return out;
}

export function timeToIso(time: ICAL.Time): string {
  // Convert to UTC then to JS Date then to ISO. Floating times resolve as-if-UTC
  // unless the caller is providing context via a viewer timezone (handled at the
  // parse-events layer where the timezone param is known).
  return time.toJSDate().toISOString();
}
