// Side-effect import: registers the IANA timezone set with ICAL.TimezoneService
// at module load. Consumers of @miguelarios/pim-core/ics get tz resolution wired
// up by virtue of importing from this barrel.
import "./_tz-init.js";

export { IcsParseError, IcsGenerateError } from "./errors.js";
export type {
  ParsedAlarm,
  ParsedAttendee,
  ParsedOrganizer,
  ParsedGeo,
  ParsedEvent,
  ParsedTodo,
  ParsedJournal,
  TimeRange,
  EventCreateProps,
} from "./types.js";
export { normalizeRecurrenceRule } from "./rrule.js";
export { parseIcsEvents } from "./parse-events.js";
export { parseIcsTodos } from "./parse-todos.js";
export { parseIcsJournals } from "./parse-journals.js";
export { generateEventIcs, toIcalTime } from "./generate.js";
// Exported so callers that build an event response by hand (rather than by
// re-reading it) can render `trigger_human` exactly as the parser would.
export { formatTriggerHuman } from "./_shared.js";
export {
  createExceptionComponent,
  combineIcsComponents,
  addExdateToIcs,
  removeExceptionFromIcs,
  updateMasterEventIcs,
  splitIcsByUid,
} from "./components.js";
export type { ExceptionOverrides, MasterEventUpdates } from "./components.js";
