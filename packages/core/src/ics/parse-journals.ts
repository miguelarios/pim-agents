import ICAL from "ical.js";
import "./_tz-init.js";
import { parseCategories } from "./_shared.js";
import { IcsParseError } from "./errors.js";
import type { ParsedJournal } from "./types.js";

function dateOnlyToString(t: ICAL.Time): string {
  // For VALUE=DATE properties, ical.js sets isDate=true and the JS Date is at midnight UTC.
  // Emit YYYY-MM-DD without timezone interpretation.
  const yr = t.year.toString().padStart(4, "0");
  const mo = t.month.toString().padStart(2, "0");
  const da = t.day.toString().padStart(2, "0");
  return `${yr}-${mo}-${da}`;
}

export function parseIcsJournals(icsContent: string): ParsedJournal[] {
  if (!icsContent.trim()) return [];

  let root: ICAL.Component;
  try {
    root = ICAL.Component.fromString(icsContent);
  } catch (e) {
    throw new IcsParseError("Invalid ICS content", e);
  }

  const out: ParsedJournal[] = [];
  for (const vjournal of root.getAllSubcomponents("vjournal")) {
    try {
      const dtstart = vjournal.getFirstPropertyValue("dtstart");
      const status = vjournal.getFirstPropertyValue("status");
      const created = vjournal.getFirstPropertyValue("created");
      const lastModified = vjournal.getFirstPropertyValue("last-modified");

      let dateStr = "";
      if (dtstart instanceof ICAL.Time) {
        dateStr = dtstart.isDate ? dateOnlyToString(dtstart) : dtstart.toJSDate().toISOString();
      }

      const rawUid = vjournal.getFirstPropertyValue("uid");
      const rawSummary = vjournal.getFirstPropertyValue("summary");
      const rawDescription = vjournal.getFirstPropertyValue("description");

      out.push({
        uid: typeof rawUid === "string" ? rawUid : "",
        title: typeof rawSummary === "string" ? rawSummary : "",
        date: dateStr,
        description: typeof rawDescription === "string" ? rawDescription : null,
        categories: parseCategories(vjournal),
        status: typeof status === "string" ? status.toLowerCase() : null,
        created: created instanceof ICAL.Time ? created.toJSDate().toISOString() : null,
        lastModified:
          lastModified instanceof ICAL.Time ? lastModified.toJSDate().toISOString() : null,
      });
    } catch {
      // Skip malformed VJOURNAL, don't fail whole batch.
    }
  }
  return out;
}
