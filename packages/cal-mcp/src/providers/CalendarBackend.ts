import type { CalendarSharing, ShareAccess } from "../services/sharing.js";
/**
 * What the calendar tools need from a backend, as an interface rather than the
 * concrete CalDavService (#42). See
 * docs/superpowers/specs/2026-10-18-multi-provider-backends-design.md.
 *
 * Two layers, because the tool layer is not protocol-neutral yet:
 *
 * - `CalendarBackend` is what any provider can implement: calendars, events by
 *   ID, ranges, free/busy and collection management, in this package's own
 *   data shapes. Calendar IDs are `<provider>/<calendar>`; the provider prefix
 *   picks the account.
 * - `IcsCalendarBackend` adds the iCalendar-level operations the tools use
 *   today to create events and to edit recurring series (overrides, EXDATEs,
 *   splitting a series), by rewriting the stored VCALENDAR themselves. A
 *   provider whose API does not take iCalendar (Google Calendar, Microsoft
 *   Graph) cannot implement these. Replacing them with semantic operations,
 *   with the recurrence logic moved below this interface, is phase 2 of the
 *   design.
 */
import type {
  CalendarCollection,
  CalendarInfo,
  CalendarObjectMeta,
  EventFull,
  EventSummary,
  FindFreeSlotsOptions,
  FreeBusyOptions,
  FreeBusyResult,
  FreeSlot,
  ReachableCalendars,
} from "./types.js";

export interface CalendarBackend {
  // ── Accounts and calendars ────────────────────────────────────────────────
  /** Every calendar on every configured provider. Throws if any provider cannot be listed. */
  listCalendars(): Promise<CalendarInfo[]>;
  /**
   * The calendars of every provider that answers, and which did not (#127).
   * Throws only when none answers. For listings; availability uses listCalendars.
   */
  listReachableCalendars(): Promise<ReachableCalendars>;
  /** The configured provider IDs: the prefix half of every calendar ID. */
  listProviders(): string[];
  /** The account's own address on the calendar's provider (used as ORGANIZER). */
  getAccountEmail(calendarId: string): string;

  // ── Events ────────────────────────────────────────────────────────────────
  listEvents(calendarId: string, start: string, end: string): Promise<EventSummary[]>;
  listEventsFull(calendarId: string, start: string, end: string): Promise<EventFull[]>;
  /** The master, or with `occurrenceDate` one occurrence as it will happen. */
  getEvent(calendarId: string, uid: string, occurrenceDate?: string): Promise<EventFull>;
  /**
   * The event plus an opaque version handle. `meta.url` locates the stored
   * object and `meta.etag` guards a later write; both are the backend's own,
   * and callers only pass them back.
   */
  getEventWithMeta(
    calendarId: string,
    uid: string,
  ): Promise<{ event: EventFull; meta: CalendarObjectMeta }>;
  /** Removes the whole stored event (every occurrence of a series). */
  deleteEvent(calendarId: string, uid: string, meta?: CalendarObjectMeta): Promise<void>;
  /** Moves an event to another calendar on the same account. */
  moveEvent(
    calendarId: string,
    uid: string,
    targetCalendarId: string,
    meta?: CalendarObjectMeta,
  ): Promise<EventFull>;

  // ── Availability ──────────────────────────────────────────────────────────
  getFreeBusy(
    calendarIds: string[],
    start: string,
    end: string,
    options?: FreeBusyOptions,
  ): Promise<FreeBusyResult>;
  findFreeSlots(
    calendarIds: string[],
    start: string,
    end: string,
    durationMinutes: number,
    options?: FindFreeSlotsOptions,
  ): Promise<FreeSlot[]>;

  // ── Calendar collections ──────────────────────────────────────────────────
  findCalendarEntry(calendarId: string): Promise<CalendarCollection>;
  /** Number of stored events (a series counts once), or undefined when the provider will not say. */
  countCalendarObjects(calendarId: string): Promise<number | undefined>;
  createCalendar(opts: {
    provider?: string;
    displayName: string;
    description?: string;
    color?: string;
    timezone?: string;
    order?: number;
    slug?: string;
  }): Promise<CalendarCollection>;
  updateCalendarMeta(
    calendarId: string,
    opts: {
      displayName?: string;
      description?: string;
      color?: string;
      timezone?: string;
      order?: number;
    },
  ): Promise<CalendarCollection>;
  deleteCalendar(calendarId: string): Promise<CalendarCollection>;

  // ── Sharing (#47) ─────────────────────────────────────────────────────────
  /** Who a calendar is shared with, at what access, in the provider's own sharee form. */
  getCalendarSharing(calendarId: string): Promise<CalendarSharing>;
  /** Grants (`access` given) or revokes (`access` null) a sharee's access, then re-reads. */
  changeCalendarShare(
    calendarId: string,
    sharee: string,
    access: ShareAccess | null,
    summary?: string,
  ): Promise<CalendarSharing>;
}

/**
 * The iCalendar-level operations, for a backend that stores VCALENDAR objects
 * (CalDAV). Phase 2 of the design replaces these with semantic event writes.
 */
export interface IcsCalendarBackend extends CalendarBackend {
  /** The stored VCALENDAR text of one event object, with its location and version. */
  fetchRawCalendarObject(
    calendarId: string,
    uid: string,
  ): Promise<{ data: string; url: string; etag: string }>;
  /** Stores a new event object from VCALENDAR text. */
  createEvent(calendarId: string, icalString: string, uid: string): Promise<EventFull>;
  /** Replaces an event object with VCALENDAR text, guarded by `meta.etag` when given. */
  updateEvent(
    calendarId: string,
    uid: string,
    icalString: string,
    meta?: CalendarObjectMeta,
  ): Promise<EventFull>;
}
