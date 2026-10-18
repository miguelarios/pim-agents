// packages/core/src/ics/types.ts

export interface ParsedAlarm {
  type: "relative" | "absolute";
  trigger: number | string;
  trigger_human: string;
}

export interface ParsedAttendee {
  name: string | null;
  email: string;
  status: string | null;
  role: string | null;
  type: string;
}

export interface ParsedOrganizer {
  name: string | null;
  email: string;
}

export interface ParsedGeo {
  latitude: number;
  longitude: number;
}

export interface ParsedEvent {
  uid: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location: string | null;
  description: string | null;
  status: string | null;
  availability: string | null;
  url: string | null;
  attendees: ParsedAttendee[];
  categories: string[];
  geo: ParsedGeo | null;
  organizer: ParsedOrganizer | null;
  /**
   * The series' RRULE. Every occurrence expanded from a master reports the
   * master's rule, overrides included. An instance whose master is not in the
   * payload (a server-expanded instance, an orphan override) has no rule to
   * report, so this is null there even though `is_recurring` is true.
   */
  recurrence_rule: string | null;
  rdates: string[] | null;
  created: string | null;
  last_modified: string | null;
  /**
   * True for a master with an RRULE or RDATE, and for an occurrence of a series:
   * an instance with a RECURRENCE-ID that came from a ranged listing or sits
   * beside its master. An override stored without its master (an invitation
   * to one occurrence) is false: there is no series here to edit.
   */
  is_recurring: boolean;
  alarms: ParsedAlarm[];
  /** The occurrence's RECURRENCE-ID as an ISO instant (UTC midnight when date-only); null for a master or a one-off. */
  occurrence_date: string | null;
}

export interface ParsedTodo {
  uid: string;
  title: string;
  due: string | null;
  completed: string | null;
  percent_complete: number | null;
  priority: number | null;
  status: string | null;
  description: string | null;
  categories: string[];
  attendees: ParsedAttendee[];
  organizer: ParsedOrganizer | null;
  alarms: ParsedAlarm[];
  recurrence_rule: string | null;
  created: string | null;
  last_modified: string | null;
  occurrence_date: string | null;
}

export interface ParsedJournal {
  uid: string;
  title: string;
  date: string;
  description: string | null;
  categories: string[];
  status: string | null;
  created: string | null;
  last_modified: string | null;
}

/** How a busy period blocks time; `FREE` periods are never reported. */
export type FreeBusyType = "busy" | "tentative" | "unavailable";

export interface FreeBusyPeriod {
  start: string; // ISO 8601 UTC
  end: string;
  type: FreeBusyType;
}

export interface TimeRange {
  start: string;
  end: string;
}

export interface EventCreateProps {
  title: string;
  start: string;
  end: string;
  all_day?: boolean;
  location?: string;
  description?: string;
  attendees?: Array<{ email: string }>;
  uid?: string;
  timezone?: string;
  alarms?: Array<{ type: "relative" | "absolute"; trigger: number | string }>;
  categories?: string[];
  recurrence_rule?: string;
  organizer?: { email: string; name?: string | null };
  availability?: "busy" | "free";
}
