import ICAL from "ical.js";
import "./_tz-init.js";
import { IcsParseError } from "./errors.js";
import type { FreeBusyPeriod, FreeBusyType } from "./types.js";

/** RFC 4791 §7.10 / RFC 5545 §3.2.9 FBTYPE values, in the vocabulary the tools use. */
function fbTypeOf(raw: unknown): FreeBusyType | null {
  const value = typeof raw === "string" ? raw.toUpperCase() : "BUSY";
  switch (value) {
    case "BUSY":
      return "busy";
    case "BUSY-TENTATIVE":
      return "tentative";
    case "BUSY-UNAVAILABLE":
      return "unavailable";
    case "FREE":
      return null;
    default:
      // An x-name or unknown type: RFC 5545 says treat as BUSY.
      return "busy";
  }
}

/**
 * Reads the busy periods out of a `VFREEBUSY` reply — what a CalDAV
 * `free-busy-query` REPORT (RFC 4791 §7.10) or an iTIP free/busy reply
 * carries. `FREE` periods are dropped: the result answers "when is this
 * calendar busy", and everything else in the queried range is free.
 */
export function parseIcsFreeBusy(icsContent: string): FreeBusyPeriod[] {
  if (!icsContent.trim()) return [];
  let root: ICAL.Component;
  try {
    root = ICAL.Component.fromString(icsContent);
  } catch (e) {
    throw new IcsParseError("Invalid ICS content", e);
  }
  const out: FreeBusyPeriod[] = [];
  for (const fb of root.getAllSubcomponents("vfreebusy")) {
    for (const prop of fb.getAllProperties("freebusy")) {
      const type = fbTypeOf(prop.getParameter("fbtype"));
      if (type === null) continue;
      for (const value of prop.getValues()) {
        if (!(value instanceof ICAL.Period)) continue;
        out.push({
          start: value.start.toJSDate().toISOString(),
          end: value.getEnd().toJSDate().toISOString(),
          type,
        });
      }
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}
