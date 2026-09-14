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
  recurrence_rule: string | null;
  rdates: string[] | null;
  created: string | null;
  last_modified: string | null;
  is_recurring: boolean;
  alarms: ParsedAlarm[];
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
