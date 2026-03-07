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
      const calendars = await client.fetchCalendars();
      const calendar = calendars.find(
        (c) => (typeof c.displayName === "string" ? c.displayName : "") === calendarName,
      );
      if (!calendar) {
        throw new CalendarError(
          `Calendar "${calendarName}" not found on provider "${account.id}"`,
          ErrorCode.CALENDAR_NOT_FOUND,
        );
      }

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
}
