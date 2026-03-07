import {
  type CalDavAccount,
  type CalDavConfig,
  CalendarError,
  ErrorCode,
  toPimError,
} from "@miguelarios/pim-core";
import { DAVClient } from "tsdav";
import { type ParsedEvent, parseIcsEvents } from "../ical.js";

export interface CalendarInfo {
  calendarId: string;
  displayName: string;
  url: string;
  ctag?: string;
  providerId: string;
}

export interface EventSummary {
  uid: string;
  calendarId: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
  status?: string;
  isRecurring: boolean;
}

export interface EventFull extends EventSummary {
  description?: string;
  attendees?: Array<{ name?: string; email: string; status?: string }>;
  organizer?: { name?: string; email: string };
  recurrenceRule?: string;
  transparency?: string;
  created?: string;
  lastModified?: string;
}

export interface FreeSlot {
  start: string;
  end: string;
  duration: number;
}

export interface FindFreeSlotsOptions {
  ignoreTentative?: boolean;
  preferredStart?: string; // "HH:MM"
  preferredEnd?: string; // "HH:MM"
}

export class CalDavService {
  private accounts: Map<string, CalDavAccount>;

  constructor(config: CalDavConfig) {
    this.accounts = new Map(config.accounts.map((a) => [a.id, a]));
  }

  private createClient(account: CalDavAccount): DAVClient {
    return new DAVClient({
      serverUrl: account.url,
      credentials: {
        username: account.username,
        password: account.password,
      },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
  }

  private resolveAccount(calendarId: string): {
    account: CalDavAccount;
    calendarName: string;
  } {
    const slashIndex = calendarId.indexOf("/");
    if (slashIndex === -1) {
      throw new CalendarError(
        `Invalid calendar ID "${calendarId}" — must be "provider/calendar"`,
        ErrorCode.CALENDAR_NOT_FOUND,
      );
    }
    const providerId = calendarId.substring(0, slashIndex);
    const calendarName = calendarId.substring(slashIndex + 1);
    const account = this.accounts.get(providerId);
    if (!account) {
      throw new CalendarError(`Unknown provider "${providerId}"`, ErrorCode.CALENDAR_NOT_FOUND);
    }
    return { account, calendarName };
  }

  private async findCalendar(
    client: DAVClient,
    calendarName: string,
    providerId: string,
  ): Promise<any> {
    const calendars = await client.fetchCalendars();
    const calendar = calendars.find(
      (c) => (typeof c.displayName === "string" ? c.displayName : "") === calendarName,
    );
    if (!calendar) {
      throw new CalendarError(
        `Calendar "${calendarName}" not found on provider "${providerId}"`,
        ErrorCode.CALENDAR_NOT_FOUND,
      );
    }
    return calendar;
  }

  private async findCalendarObject(
    client: DAVClient,
    calendar: any,
    uid: string,
  ): Promise<{ url: string; etag?: string; data?: string }> {
    const objects = await client.fetchCalendarObjects({ calendar });
    for (const obj of objects) {
      if (!obj.data) continue;
      const events = parseIcsEvents(obj.data);
      if (events.some((e) => e.uid === uid)) {
        return obj as { url: string; etag?: string; data?: string };
      }
    }
    throw new CalendarError(`Event "${uid}" not found`, ErrorCode.EVENT_NOT_FOUND, uid);
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const allCalendars: CalendarInfo[] = [];

    for (const [providerId, account] of this.accounts) {
      const client = this.createClient(account);
      try {
        await client.login();
        const calendars = await client.fetchCalendars();
        for (const cal of calendars) {
          const displayName = (typeof cal.displayName === "string" ? cal.displayName : "") || "";
          allCalendars.push({
            calendarId: `${providerId}/${displayName}`,
            displayName,
            url: cal.url,
            ctag: cal.ctag,
            providerId,
          });
        }
      } catch (error) {
        throw toPimError(error instanceof Error ? error : new Error(String(error)));
      }
    }

    return allCalendars;
  }

  async listEvents(calendarId: string, start: string, end: string): Promise<EventSummary[]> {
    const { account, calendarName } = this.resolveAccount(calendarId);
    const client = this.createClient(account);

    try {
      await client.login();
      const calendar = await this.findCalendar(client, calendarName, account.id);

      const objects = await client.fetchCalendarObjects({
        calendar,
        timeRange: { start, end },
        expand: true,
      });

      const summaries: EventSummary[] = [];
      for (const obj of objects) {
        if (!obj.data) continue;
        const parsed = parseIcsEvents(obj.data);
        for (const event of parsed) {
          summaries.push({
            uid: event.uid,
            calendarId,
            summary: event.summary,
            start: event.start,
            end: event.end,
            location: event.location,
            status: event.status,
            isRecurring: !!event.recurrenceRule,
          });
        }
      }

      return summaries;
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async getEvent(calendarId: string, uid: string): Promise<EventFull> {
    const { account, calendarName } = this.resolveAccount(calendarId);
    const client = this.createClient(account);

    try {
      await client.login();
      const calendar = await this.findCalendar(client, calendarName, account.id);
      const obj = await this.findCalendarObject(client, calendar, uid);
      const parsed = parseIcsEvents(obj.data!);
      const event = parsed.find((e) => e.uid === uid);
      if (!event) {
        throw new CalendarError(`Event "${uid}" not found`, ErrorCode.EVENT_NOT_FOUND, uid);
      }

      return {
        uid: event.uid,
        calendarId,
        summary: event.summary,
        start: event.start,
        end: event.end,
        location: event.location,
        status: event.status,
        isRecurring: !!event.recurrenceRule,
        description: event.description,
        attendees: event.attendees,
        organizer: event.organizer,
        recurrenceRule: event.recurrenceRule,
        transparency: event.transparency,
        created: event.created,
        lastModified: event.lastModified,
      };
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async createEvent(calendarId: string, icalString: string): Promise<void> {
    const { account, calendarName } = this.resolveAccount(calendarId);
    const client = this.createClient(account);

    try {
      await client.login();
      const calendar = await this.findCalendar(client, calendarName, account.id);
      await client.createCalendarObject({
        calendar,
        iCalString: icalString,
        filename: `${crypto.randomUUID()}.ics`,
      });
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async updateEvent(calendarId: string, uid: string, icalString: string): Promise<void> {
    const { account, calendarName } = this.resolveAccount(calendarId);
    const client = this.createClient(account);

    try {
      await client.login();
      const calendar = await this.findCalendar(client, calendarName, account.id);
      const obj = await this.findCalendarObject(client, calendar, uid);
      await client.updateCalendarObject({
        calendarObject: {
          url: obj.url,
          etag: obj.etag,
          data: icalString,
        },
      });
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async deleteEvent(calendarId: string, uid: string): Promise<void> {
    const { account, calendarName } = this.resolveAccount(calendarId);
    const client = this.createClient(account);

    try {
      await client.login();
      const calendar = await this.findCalendar(client, calendarName, account.id);
      const obj = await this.findCalendarObject(client, calendar, uid);
      await client.deleteCalendarObject({
        calendarObject: {
          url: obj.url,
          etag: obj.etag,
        },
      });
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async findFreeSlots(
    calendarIds: string[],
    start: string,
    end: string,
    durationMinutes: number,
    options: FindFreeSlotsOptions = {},
  ): Promise<FreeSlot[]> {
    // 1. Fetch all events across specified calendars
    const allEvents: Array<{
      start: string;
      end: string;
      status?: string;
      transparency?: string;
    }> = [];

    for (const calendarId of calendarIds) {
      try {
        const { account, calendarName } = this.resolveAccount(calendarId);
        const client = this.createClient(account);
        await client.login();
        const calendar = await this.findCalendar(client, calendarName, account.id);
        const objects = await client.fetchCalendarObjects({
          calendar,
          timeRange: { start, end },
          expand: true,
        });

        for (const obj of objects) {
          if (!obj.data) continue;
          const parsed = parseIcsEvents(obj.data);
          for (const event of parsed) {
            allEvents.push({
              start: event.start,
              end: event.end,
              status: event.status,
              transparency: event.transparency,
            });
          }
        }
      } catch (error) {
        if (error instanceof CalendarError) throw error;
        throw toPimError(error instanceof Error ? error : new Error(String(error)));
      }
    }

    // 2. Filter events — skip transparent and optionally tentative
    const busyIntervals = allEvents.filter((e) => {
      if (e.transparency === "TRANSPARENT") return false;
      if (options.ignoreTentative && e.status === "TENTATIVE") return false;
      return true;
    });

    // 3. Merge overlapping busy intervals
    const sorted = busyIntervals
      .map((e) => ({
        start: new Date(e.start).getTime(),
        end: new Date(e.end).getTime(),
      }))
      .sort((a, b) => a.start - b.start);

    const merged: Array<{ start: number; end: number }> = [];
    for (const interval of sorted) {
      if (merged.length > 0 && interval.start <= merged[merged.length - 1].end) {
        merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, interval.end);
      } else {
        merged.push({ ...interval });
      }
    }

    // 4. Find gaps >= durationMinutes
    const rangeStart = new Date(start).getTime();
    const rangeEnd = new Date(end).getTime();
    const durationMs = durationMinutes * 60 * 1000;

    const freeSlots: FreeSlot[] = [];
    let cursor = rangeStart;

    for (const busy of merged) {
      if (busy.start > cursor) {
        const gapMs = busy.start - cursor;
        if (gapMs >= durationMs) {
          freeSlots.push({
            start: new Date(cursor).toISOString(),
            end: new Date(busy.start).toISOString(),
            duration: Math.round(gapMs / 60000),
          });
        }
      }
      cursor = Math.max(cursor, busy.end);
    }

    // Check final gap
    if (rangeEnd > cursor) {
      const gapMs = rangeEnd - cursor;
      if (gapMs >= durationMs) {
        freeSlots.push({
          start: new Date(cursor).toISOString(),
          end: new Date(rangeEnd).toISOString(),
          duration: Math.round(gapMs / 60000),
        });
      }
    }

    // 5. Split and sort by preferred hours
    if (options.preferredStart && options.preferredEnd) {
      const [prefStartH, prefStartM] = options.preferredStart.split(":").map(Number);
      const [prefEndH, prefEndM] = options.preferredEnd.split(":").map(Number);
      const prefStartMinutes = prefStartH * 60 + prefStartM;
      const prefEndMinutes = prefEndH * 60 + prefEndM;

      // Split slots at preferred-hour boundaries so they can be reordered
      const splitSlots: FreeSlot[] = [];
      for (const slot of freeSlots) {
        const slotStart = new Date(slot.start);
        const slotEnd = new Date(slot.end);

        // Compute preferred boundary timestamps for each day the slot spans
        const dayStart = new Date(slotStart);
        dayStart.setUTCHours(0, 0, 0, 0);

        const boundaries: number[] = [];
        // Check current day and next day in case slot spans midnight
        for (let d = 0; d <= 1; d++) {
          const day = new Date(dayStart.getTime() + d * 86400000);
          const prefS = new Date(day);
          prefS.setUTCHours(prefStartH, prefStartM, 0, 0);
          const prefE = new Date(day);
          prefE.setUTCHours(prefEndH, prefEndM, 0, 0);
          if (prefS.getTime() > slotStart.getTime() && prefS.getTime() < slotEnd.getTime()) {
            boundaries.push(prefS.getTime());
          }
          if (prefE.getTime() > slotStart.getTime() && prefE.getTime() < slotEnd.getTime()) {
            boundaries.push(prefE.getTime());
          }
        }

        boundaries.sort((a, b) => a - b);

        // Split the slot at boundaries
        let cursor = slotStart.getTime();
        for (const boundary of boundaries) {
          if (boundary > cursor) {
            const dur = Math.round((boundary - cursor) / 60000);
            if (dur >= durationMinutes) {
              splitSlots.push({
                start: new Date(cursor).toISOString(),
                end: new Date(boundary).toISOString(),
                duration: dur,
              });
            }
            cursor = boundary;
          }
        }
        // Remainder
        if (slotEnd.getTime() > cursor) {
          const dur = Math.round((slotEnd.getTime() - cursor) / 60000);
          if (dur >= durationMinutes) {
            splitSlots.push({
              start: new Date(cursor).toISOString(),
              end: new Date(slotEnd.getTime()).toISOString(),
              duration: dur,
            });
          }
        }
      }

      // Sort: preferred-hours slots first, then chronologically
      splitSlots.sort((a, b) => {
        const aDate = new Date(a.start);
        const bDate = new Date(b.start);
        const aMinutes = aDate.getUTCHours() * 60 + aDate.getUTCMinutes();
        const bMinutes = bDate.getUTCHours() * 60 + bDate.getUTCMinutes();
        const aInPref = aMinutes >= prefStartMinutes && aMinutes < prefEndMinutes;
        const bInPref = bMinutes >= prefStartMinutes && bMinutes < prefEndMinutes;

        if (aInPref && !bInPref) return -1;
        if (!aInPref && bInPref) return 1;
        return aDate.getTime() - bDate.getTime();
      });

      return splitSlots;
    }

    return freeSlots;
  }
}
