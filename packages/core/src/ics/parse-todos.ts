import ICAL from "ical.js";
import "./_tz-init.js";
import { parseAlarms, parseAttendees, parseCategories, parseOrganizer } from "./_shared.js";
import { IcsParseError } from "./errors.js";
import type { ParsedTodo } from "./types.js";

export function parseIcsTodos(icsContent: string): ParsedTodo[] {
  if (!icsContent.trim()) return [];

  let root: ICAL.Component;
  try {
    root = ICAL.Component.fromString(icsContent);
  } catch (e) {
    throw new IcsParseError("Invalid ICS content", e);
  }

  const out: ParsedTodo[] = [];
  for (const vtodo of root.getAllSubcomponents("vtodo")) {
    try {
      const due = vtodo.getFirstPropertyValue("due");
      const completed = vtodo.getFirstPropertyValue("completed");
      const percent = vtodo.getFirstPropertyValue("percent-complete");
      const priority = vtodo.getFirstPropertyValue("priority");
      const status = vtodo.getFirstPropertyValue("status");
      const created = vtodo.getFirstPropertyValue("created");
      const lastModified = vtodo.getFirstPropertyValue("last-modified");
      const rrule = vtodo.getFirstPropertyValue("rrule");
      const recurId = vtodo.getFirstPropertyValue("recurrence-id");
      const rawUid = vtodo.getFirstPropertyValue("uid");
      const rawSummary = vtodo.getFirstPropertyValue("summary");
      const rawDescription = vtodo.getFirstPropertyValue("description");

      out.push({
        uid: typeof rawUid === "string" ? rawUid : "",
        title: typeof rawSummary === "string" ? rawSummary : "",
        due: due instanceof ICAL.Time ? due.toJSDate().toISOString() : null,
        completed: completed instanceof ICAL.Time ? completed.toJSDate().toISOString() : null,
        percentComplete: typeof percent === "number" ? percent : null,
        priority: typeof priority === "number" ? priority : null,
        status: typeof status === "string" ? status.toLowerCase() : null,
        description: typeof rawDescription === "string" ? rawDescription : null,
        categories: parseCategories(vtodo),
        attendees: parseAttendees(vtodo),
        organizer: parseOrganizer(vtodo),
        alarms: parseAlarms(vtodo),
        recurrenceRule: rrule ? rrule.toString() : null,
        created: created instanceof ICAL.Time ? created.toJSDate().toISOString() : null,
        lastModified:
          lastModified instanceof ICAL.Time ? lastModified.toJSDate().toISOString() : null,
        occurrenceDate: recurId instanceof ICAL.Time ? recurId.toJSDate().toISOString() : null,
      });
    } catch {
      // Skip malformed VTODO, don't fail whole batch.
    }
  }
  return out;
}
