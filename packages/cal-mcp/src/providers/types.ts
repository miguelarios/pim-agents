/**
 * The data shapes every calendar backend speaks, independent of protocol.
 * They used to live in CalDavService.ts and are still re-exported from there.
 */
import type { FreeBusyPeriod, ParsedAlarm } from "@miguelarios/pim-core/ics";

export interface CalendarInfo {
  calendar_id: string;
  display_name: string;
  color: string | null;
  description: string | null;
  /** IANA zone the calendar defaults to (`calendar-timezone`), when the provider reports one. */
  timezone: string | null;
  /** Sort position among the account's calendars (Apple `calendar-order`), when reported. */
  order: number | null;
  source: string;
  read_only: boolean;
  url: string;
  ctag?: string;
}

/** A calendar collection as the management tools name it. */
export interface CalendarCollection {
  calendar_id: string;
  display_name: string;
  url: string;
  provider: string;
}

export interface EventSummary {
  uid: string;
  calendar_id: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location: string | null;
  status: string | null;
  is_recurring: boolean;
  occurrence_date: string | null;
}

export interface EventFull extends EventSummary {
  description: string | null;
  url: string | null;
  availability: string | null;
  attendees: Array<{
    name: string | null;
    email: string;
    status: string | null;
    role: string | null;
    type: string;
  }>;
  organizer: { name: string | null; email: string } | null;
  recurrence_rule: string | null;
  created: string | null;
  last_modified: string | null;
  alarms: ParsedAlarm[];
  categories: string[];
  geo: { latitude: number; longitude: number } | null;
}

export interface FreeSlot {
  start: string;
  end: string;
  duration: number;
}

export interface FindFreeSlotsOptions {
  ignoreTentative?: boolean;
  preferredStart?: string;
  preferredEnd?: string;
  excludeCalendars?: string[];
  includeAllDayAsBusy?: boolean;
}

export interface CalendarObjectMeta {
  url: string;
  etag?: string;
}

export interface FreeBusyOptions {
  ignoreTentative?: boolean;
  includeAllDayAsBusy?: boolean;
}

/** Where a calendar's busy periods came from. */
export type FreeBusySource = "server" | "computed";

export interface FreeBusyResult {
  busy: FreeBusyPeriod[];
  sources: Record<string, FreeBusySource>;
}
