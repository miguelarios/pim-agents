import { randomBytes } from "node:crypto";
import {
  type CalDavAccount,
  type CalDavConfig,
  CalendarError,
  ErrorCode,
  ValidationError,
  checkDavCollectionResponse,
  formatInTimezone,
  getLocalDateParts,
  getTimezone,
  toPimError,
  zonedTimeToUtc,
} from "@miguelarios/pim-core";
import {
  type ParsedAlarm,
  type ParsedEvent,
  type TimeRange,
  parseIcsEvents,
} from "@miguelarios/pim-core/ics";
import { DAVClient } from "tsdav";
import {
  deleteCachedObject,
  getCachedObject,
  moveCachedCalendar,
  purgeCachedCalendar,
  setCachedObject,
} from "./urlCache.js";

export interface CalendarInfo {
  calendar_id: string;
  display_name: string;
  color: string | null;
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

/** Derives a URL slug from a display name; falls back to a random one when nothing survives. */
function slugify(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `calendar-${randomBytes(4).toString("hex")}`;
}

/** Normalises a URL or href to a comparable path: origin stripped, trailing slashes trimmed. */
function collectionPath(ref: string): string {
  try {
    return new URL(ref, "http://placeholder.invalid").pathname.replace(/\/+$/, "");
  } catch {
    return ref.replace(/\/+$/, "");
  }
}

/**
 * Namespace declarations for every collection-level request this service makes.
 * `ical` is Apple's, and is where `calendar-color` lives — the same property
 * tsdav's `fetchCalendars` reads back as `calendarColor`, so a colour written
 * here is what `list_calendars` reports.
 */
const CALENDAR_DAV_NAMESPACES = {
  "xmlns:d": "DAV:",
  "xmlns:cal": "urn:ietf:params:xml:ns:caldav",
  "xmlns:ical": "http://apple.com/ns/ical/",
} as const;

/** tsdav types `displayName` loosely; calendars without one read as "". */
function displayNameOf(calendar: unknown): string {
  const name = (calendar as { displayName?: unknown } | null | undefined)?.displayName;
  return typeof name === "string" ? name : "";
}

/**
 * Validates a calendar colour and returns it unchanged. Apple clients write the
 * 8-digit form, so both are accepted; the value is passed through verbatim
 * rather than reformatted, since it is what reads back out of `calendarColor`.
 */
function normalizeCalendarColor(color: string): string {
  const trimmed = color.trim();
  if (!/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(trimmed)) {
    throw new ValidationError(
      `Invalid color "${color}" — use #RRGGBB or #RRGGBBAA (e.g. #3B82F6)`,
      "color",
    );
  }
  return trimmed;
}

/**
 * Wiring for the shared DAV collection response checker, so every collection
 * verb in this service speaks CalendarError rather than a generic failure.
 */
const CALENDAR_DAV_CHECK = {
  resource: "calendar",
  notFound: (url: string) =>
    new CalendarError(`Calendar not found: ${url}`, ErrorCode.CALENDAR_NOT_FOUND),
  failed: (message: string) => new CalendarError(message, ErrorCode.OPERATION_FAILED),
};

// Build the conventional CalDAV href for an event: <calendar-url>/<uid>.ics.
// Accepts absolute (https://host/path/) or relative (/path/) calendar URLs;
// uses the URL constructor when possible and falls back to string concat so
// unit tests with relative URLs work the same as production CalDAV responses.
export function buildCanonicalHref(calendarUrl: string, uid: string): string | null {
  if (!calendarUrl || !uid) return null;
  const filename = `${uid}.ics`;
  try {
    return new URL(filename, calendarUrl).href;
  } catch {
    const base = calendarUrl.endsWith("/") ? calendarUrl : `${calendarUrl}/`;
    return `${base}${filename}`;
  }
}

// Diagnostic: when CAL_MCP_DEBUG=1, findCalendarObject appends timing
// breadcrumbs here. The server flushes them into the next tool response so
// users can see where time is going even when the MCP process's stderr is
// swallowed by the harness (e.g., mcporter).
export const DEBUG_TIMINGS: Array<{ op: string; step: string; ms: number; count?: number }> = [];
export function drainDebugTimings(): Array<{
  op: string;
  step: string;
  ms: number;
  count?: number;
}> {
  const out = DEBUG_TIMINGS.slice();
  DEBUG_TIMINGS.length = 0;
  return out;
}

export class CalDavService {
  private accounts: Map<string, CalDavAccount>;
  private clients: Map<string, DAVClient> = new Map();
  private calendarsCache: Map<string, any[]> = new Map();
  private timezone: string;

  constructor(config: CalDavConfig) {
    this.accounts = new Map(config.accounts.map((a) => [a.id, a]));
    this.timezone = getTimezone();
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

  private async getClient(account: CalDavAccount): Promise<DAVClient> {
    const existing = this.clients.get(account.id);
    if (existing) return existing;

    const client = this.createClient(account);
    await client.login();
    this.clients.set(account.id, client);
    return client;
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
    const calendars = await this.fetchCalendarsFor(client, providerId);
    const calendar = calendars.find((c) => displayNameOf(c) === calendarName);
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
    calendarId?: string,
  ): Promise<{ url: string; etag?: string; data?: string }> {
    const debug = process.env.CAL_MCP_DEBUG === "1";
    const timings: Array<{ step: string; ms: number; count?: number }> = [];
    const step = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const t0 = Date.now();
      const v = await fn();
      const ms = Date.now() - t0;
      const entry: { step: string; ms: number; count?: number } = { step: name, ms };
      if (Array.isArray(v)) entry.count = v.length;
      timings.push(entry);
      if (debug) {
        process.stderr.write(`[cal-mcp] ${name}: ${ms}ms\n`);
        DEBUG_TIMINGS.push({ op: `findCalendarObject(${uid})`, ...entry });
      }
      return v;
    };

    // 1) Canonical-URL fast path. CalDAV convention (RFC 4791) and the
    // tsdav/ts-caldav/apple/baikal defaults all store an event at
    // <calendar.url>/<uid>.ics. Try that URL directly — one round trip, no
    // search, no cache required. Kills the cold-cache penalty for all events
    // created by cal-mcp or by any conventional client.
    const canonicalUrl = buildCanonicalHref((calendar as { url: string }).url, uid);
    if (canonicalUrl) {
      try {
        const probe = await step("fetchCalendarObjects(canonical URL)", () =>
          client.fetchCalendarObjects({ calendar, objectUrls: [canonicalUrl] }),
        );
        for (const obj of probe) {
          if (!obj.data) continue;
          const events = parseIcsEvents(obj.data);
          if (events.some((e) => e.uid === uid)) {
            if (calendarId) setCachedObject(calendarId, uid, { url: obj.url, etag: obj.etag });
            return obj as { url: string; etag?: string; data?: string };
          }
        }
      } catch {
        // Some servers 404 on unknown URLs instead of returning empty.
      }
    }

    // 2) Cached-URL fast path. Handles events whose URL doesn't follow the
    // canonical convention (e.g., created by a third-party client that
    // chose a random filename).
    if (calendarId) {
      const cached = getCachedObject(calendarId, uid);
      if (cached) {
        const targeted = await step("fetchCalendarObjects(cached URL)", () =>
          client.fetchCalendarObjects({ calendar, objectUrls: [cached.url] }),
        );
        for (const obj of targeted) {
          if (!obj.data) continue;
          const events = parseIcsEvents(obj.data);
          if (events.some((e) => e.uid === uid)) {
            // Refresh etag if changed server-side
            if (obj.etag && obj.etag !== cached.etag) {
              setCachedObject(calendarId, uid, { url: cached.url, etag: obj.etag });
            }
            return obj as { url: string; etag?: string; data?: string };
          }
        }
        // Cache stale (event moved/deleted) — drop entry and fall through.
        deleteCachedObject(calendarId, uid);
      }
    }

    // Use a CalDAV calendar-query REPORT with a UID text-match filter so the
    // server returns only the target event instead of the entire calendar.
    const uidFilter = {
      "comp-filter": {
        _attributes: { name: "VCALENDAR" },
        "comp-filter": {
          _attributes: { name: "VEVENT" },
          "prop-filter": {
            _attributes: { name: "UID" },
            "text-match": { _text: uid },
          },
        },
      },
    };

    const filtered = await step("fetchCalendarObjects(UID filter)", () =>
      client.fetchCalendarObjects({ calendar, filters: uidFilter }),
    );
    for (const obj of filtered) {
      if (!obj.data) continue;
      const events = parseIcsEvents(obj.data);
      if (events.some((e) => e.uid === uid)) {
        if (calendarId) setCachedObject(calendarId, uid, { url: obj.url, etag: obj.etag });
        return obj as { url: string; etag?: string; data?: string };
      }
    }

    // Fallback: some CalDAV servers ignore UID prop-filter. Scan all objects,
    // and opportunistically populate the cache with every UID we see so the
    // next call for any of them hits the fast path.
    const all = await step("fetchCalendarObjects(full scan)", () =>
      client.fetchCalendarObjects({ calendar }),
    );
    let hit: { url: string; etag?: string; data?: string } | null = null;
    for (const obj of all) {
      if (!obj.data) continue;
      // Cheap substring pre-check: skip full ICS parse when the UID isn't
      // even mentioned in the raw blob. ~100x faster on CPU for large
      // calendars — no TZID / rrule expansion cost per object.
      if (!obj.data.includes(uid)) continue;
      const events = parseIcsEvents(obj.data);
      // Cache every UID we see in a matched blob (usually just one, sometimes
      // a few for recurrence exceptions sharing a UID with overrides).
      for (const e of events) {
        if (calendarId && e.uid) {
          setCachedObject(calendarId, e.uid, { url: obj.url, etag: obj.etag });
        }
      }
      if (events.some((e) => e.uid === uid)) {
        hit = obj as { url: string; etag?: string; data?: string };
        break; // nothing more to do — substring check already filtered non-matches
      }
    }
    if (hit) return hit;
    const summary = timings
      .map((t) => `${t.step}=${t.ms}ms${t.count != null ? `(${t.count})` : ""}`)
      .join(" ");
    throw new CalendarError(
      `Event "${uid}" not found (${summary})`,
      ErrorCode.EVENT_NOT_FOUND,
      uid,
    );
  }

  private hasWritePrivilege(privileges: Array<Record<string, unknown>>): boolean {
    return privileges.some(
      (p) => p.write !== undefined || p["write-content"] !== undefined || p.bind !== undefined,
    );
  }

  private async fetchPrivileges(client: DAVClient, calendarUrl: string): Promise<boolean> {
    try {
      const responses = await (client as any).propfind({
        url: calendarUrl,
        props: {
          "d:current-user-privilege-set": {},
        },
        depth: "0",
      });
      const privSet = responses?.[0]?.props?.currentUserPrivilegeSet;
      if (!privSet) return true; // Default to writable
      const privileges = privSet.privilege;
      if (!privileges) return true;
      const privArray = Array.isArray(privileges) ? privileges : [privileges];
      return this.hasWritePrivilege(privArray);
    } catch {
      return true; // Default to writable on error
    }
  }

  // Returns the CalDAV account username for the given calendar_id. Used by
  // the tool layer to populate ORGANIZER on events that include attendees —
  // without this, strict CalDAV servers reject the PUT with 412 (see
  // updateEvent and generateEventIcs for context).
  getAccountEmail(calendarId: string): string {
    const { account } = this.resolveAccount(calendarId);
    return account.username;
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const allCalendars: CalendarInfo[] = [];

    for (const [providerId, account] of this.accounts) {
      try {
        const client = await this.getClient(account);
        const calendars = await client.fetchCalendars();
        this.calendarsCache.set(providerId, calendars);
        for (const cal of calendars) {
          const displayName = displayNameOf(cal);
          const canWrite = await this.fetchPrivileges(client, cal.url);
          allCalendars.push({
            calendar_id: `${providerId}/${displayName}`,
            display_name: displayName,
            color: (cal as any).calendarColor ?? null,
            source: providerId,
            read_only: !canWrite,
            url: cal.url,
            ctag: cal.ctag,
          });
        }
      } catch (error) {
        throw toPimError(error instanceof Error ? error : new Error(String(error)));
      }
    }

    return allCalendars;
  }

  /** The configured provider IDs — the prefix half of every `calendar_id`. */
  listProviders(): string[] {
    return [...this.accounts.keys()];
  }

  /**
   * Picks the account a new calendar is created on.
   *
   * Omitting `provider` is only allowed when it cannot be ambiguous. With
   * several accounts configured there is no sensible default — creating on
   * "whichever account sorts first" is not a thing a caller can mean — so it
   * is refused with the list of IDs rather than guessed.
   */
  private resolveProvider(provider?: string): CalDavAccount {
    const known = this.listProviders();
    if (provider !== undefined) {
      const account = this.accounts.get(provider);
      if (!account) {
        throw new ValidationError(
          `Unknown provider "${provider}" — configured providers: ${known.join(", ")}`,
          "provider",
        );
      }
      return account;
    }
    if (known.length === 1) {
      const only = this.accounts.get(known[0]);
      if (only) return only;
    }
    throw new ValidationError(
      `provider is required when several accounts are configured — choose one of: ${known.join(", ")}`,
      "provider",
    );
  }

  /**
   * Resolves a calendar_id to the entry it names, so a caller can say what it
   * is about to act on rather than echoing back the string it was handed.
   */
  async findCalendarEntry(calendarId: string): Promise<CalendarCollection> {
    const { account, calendarName } = this.resolveAccount(calendarId);
    try {
      const client = await this.getClient(account);
      const calendar = await this.findCalendar(client, calendarName, account.id);
      return {
        calendar_id: calendarId,
        display_name: calendarName,
        url: (calendar as { url: string }).url,
        provider: account.id,
      };
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Counts the objects in a calendar with a single depth-1 PROPFIND asking only
   * for etags — no ICS bodies cross the wire. Counts calendar *objects*, so a
   * whole recurring series counts once, which is the honest unit for "what is
   * about to be destroyed".
   *
   * Returns `undefined` rather than failing when the server refuses: a count is
   * there to make a confirmation concrete, and losing it should not block the
   * operation.
   */
  async countCalendarObjects(calendarId: string): Promise<number | undefined> {
    try {
      const { account, calendarName } = this.resolveAccount(calendarId);
      const client = await this.getClient(account);
      const calendar = await this.findCalendar(client, calendarName, account.id);
      const url = (calendar as { url: string }).url;
      const responses = await (client as any).propfind({
        url,
        props: { "d:getetag": {} },
        depth: "1",
      });
      const self = collectionPath(url);
      return (responses as Array<{ href?: string }>).filter(
        (r) => r.href && collectionPath(r.href) !== self,
      ).length;
    } catch {
      return undefined;
    }
  }

  /**
   * Creates a calendar collection with MKCALENDAR (RFC 4791 §5.3.1).
   *
   * Unlike CardDAV's extended MKCOL the resourcetype is implied by the method,
   * and the request is atomic — if any property in the body is refused the
   * calendar is not created — so name, description and colour all ride in the
   * one request rather than needing a follow-up PROPPATCH that could half-fail.
   *
   * The request goes through `davRequest` rather than tsdav's `makeCalendar`:
   * that helper's namespace set is fixed and carries no Apple `ical` namespace,
   * so a colour could not ride along. Namespace declarations go in
   * `_attributes` on the root element, where `davRequest` keeps them —
   * document-level attributes are silently dropped.
   */
  async createCalendar(opts: {
    provider?: string;
    displayName: string;
    description?: string;
    color?: string;
    slug?: string;
  }): Promise<CalendarCollection> {
    const account = this.resolveProvider(opts.provider);

    // A calendar with no display name has no addressable calendar_id at all —
    // `provider/` resolves to nothing — so creating one is refused rather than
    // quietly made unreachable.
    if (opts.displayName.trim() === "") {
      throw new ValidationError("display_name cannot be empty", "display_name");
    }
    if (opts.slug !== undefined && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(opts.slug)) {
      throw new ValidationError(
        `Invalid slug "${opts.slug}" — use lowercase letters, digits and hyphens, starting with a letter or digit`,
        "slug",
      );
    }
    const color = opts.color !== undefined ? normalizeCalendarColor(opts.color) : undefined;

    const client = await this.getClient(account);
    const existing = await this.fetchCalendarsFor(client, account.id);

    // A second calendar with the same display name on the same provider would
    // make its calendar_id ambiguous on *every subsequent call* — the name is
    // not a convenience alias here, it is half the ID, and findCalendar
    // resolves every event operation by exact display-name match. So duplicates
    // are refused rather than suffixed; that also keeps a retried create from
    // minting one.
    const duplicate = existing.find(
      (c) => displayNameOf(c).toLowerCase() === opts.displayName.trim().toLowerCase(),
    );
    if (duplicate) {
      throw new CalendarError(
        `A calendar named "${displayNameOf(duplicate)}" already exists on provider "${account.id}" (${(duplicate as { url: string }).url})`,
        ErrorCode.OPERATION_FAILED,
      );
    }

    const homeUrl = (client as { account?: { homeUrl?: string } }).account?.homeUrl;
    if (!homeUrl) {
      throw new CalendarError(
        `Provider "${account.id}" has no calendar home URL — cannot derive a location for the new calendar`,
        ErrorCode.OPERATION_FAILED,
      );
    }
    const base = homeUrl.endsWith("/") ? homeUrl : `${homeUrl}/`;
    const taken = new Set(existing.map((c) => collectionPath((c as { url: string }).url)));
    if (opts.slug !== undefined && taken.has(collectionPath(base + opts.slug))) {
      // An explicit slug is a request for a specific URL. Suffixing it would
      // hand back a different one than was asked for, observable only by
      // reading the result, so this refuses instead.
      throw new CalendarError(
        `A collection already exists at the requested slug "${opts.slug}" (${base}${opts.slug}/)`,
        ErrorCode.OPERATION_FAILED,
      );
    }
    const slug = opts.slug ?? slugify(opts.displayName);
    let candidate = slug;
    for (let n = 2; taken.has(collectionPath(base + candidate)); n++) {
      candidate = `${slug}-${n}`;
    }
    const url = `${base}${candidate}/`;

    try {
      const [response] = await (client as any).davRequest({
        url,
        init: {
          method: "MKCALENDAR",
          headers: {},
          body: {
            "cal:mkcalendar": {
              _attributes: CALENDAR_DAV_NAMESPACES,
              "d:set": {
                "d:prop": {
                  "d:displayname": opts.displayName,
                  ...(opts.description !== undefined
                    ? { "cal:calendar-description": opts.description }
                    : {}),
                  ...(color !== undefined ? { "ical:calendar-color": color } : {}),
                },
              },
            },
          },
        },
      });
      checkDavCollectionResponse(response, "create", url, CALENDAR_DAV_CHECK);
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }

    // The new collection is not in the cached listing, and findCalendar reads
    // that cache — so drop it or the calendar stays invisible to this process.
    this.calendarsCache.delete(account.id);
    return {
      calendar_id: `${account.id}/${opts.displayName}`,
      display_name: opts.displayName,
      url,
      provider: account.id,
    };
  }

  /**
   * Updates a calendar's display name, description and/or colour via PROPPATCH.
   *
   * Renaming changes the calendar's identity: `calendar_id` is
   * `provider/DisplayName`, so the old ID stops resolving and the *new* one
   * comes back in the result. The collection URL is untouched — display name
   * and slug are allowed to drift, exactly as in every CalDAV client.
   */
  async updateCalendarMeta(
    calendarId: string,
    opts: { displayName?: string; description?: string; color?: string },
  ): Promise<CalendarCollection> {
    if (
      opts.displayName === undefined &&
      opts.description === undefined &&
      opts.color === undefined
    ) {
      throw new ValidationError(
        "Nothing to change — provide a display_name, color and/or description",
      );
    }
    if (opts.displayName !== undefined && opts.displayName.trim() === "") {
      throw new ValidationError("display_name cannot be empty", "display_name");
    }
    const color = opts.color !== undefined ? normalizeCalendarColor(opts.color) : undefined;

    const { account, calendarName } = this.resolveAccount(calendarId);
    const client = await this.getClient(account);
    const calendar = await this.findCalendar(client, calendarName, account.id);
    const url = (calendar as { url: string }).url;

    // Renaming onto a name already in use would make that calendar_id ambiguous
    // — the same reason create refuses duplicates. The calendar being renamed is
    // excluded so re-applying its own name stays a no-op rather than an error.
    if (opts.displayName !== undefined) {
      const existing = await this.fetchCalendarsFor(client, account.id);
      const clash = existing.find(
        (c) =>
          displayNameOf(c).toLowerCase() === opts.displayName!.trim().toLowerCase() &&
          collectionPath((c as { url: string }).url) !== collectionPath(url),
      );
      if (clash) {
        throw new CalendarError(
          `A calendar named "${displayNameOf(clash)}" already exists on provider "${account.id}" (${(clash as { url: string }).url})`,
          ErrorCode.OPERATION_FAILED,
        );
      }
    }

    try {
      const [response] = await (client as any).davRequest({
        url,
        init: {
          method: "PROPPATCH",
          headers: {},
          body: {
            "d:propertyupdate": {
              _attributes: CALENDAR_DAV_NAMESPACES,
              "d:set": {
                "d:prop": {
                  ...(opts.displayName !== undefined ? { "d:displayname": opts.displayName } : {}),
                  ...(opts.description !== undefined
                    ? { "cal:calendar-description": opts.description }
                    : {}),
                  ...(color !== undefined ? { "ical:calendar-color": color } : {}),
                },
              },
            },
          },
        },
      });
      checkDavCollectionResponse(response, "update", url, CALENDAR_DAV_CHECK);
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      this.calendarsCache.delete(account.id);
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }

    const newDisplayName = opts.displayName ?? calendarName;
    const newCalendarId = `${account.id}/${newDisplayName}`;
    this.calendarsCache.delete(account.id);
    // The UID→URL cache is keyed by calendar_id; a rename leaves its entries
    // valid but filed under a key nothing looks up again.
    moveCachedCalendar(calendarId, newCalendarId);

    return {
      calendar_id: newCalendarId,
      display_name: newDisplayName,
      url,
      provider: account.id,
    };
  }

  /** Deletes a calendar collection — and with it every event inside. */
  async deleteCalendar(calendarId: string): Promise<CalendarCollection> {
    const { account, calendarName } = this.resolveAccount(calendarId);
    const client = await this.getClient(account);
    const calendar = await this.findCalendar(client, calendarName, account.id);
    const url = (calendar as { url: string }).url;

    try {
      const response = await client.deleteObject({ url });
      checkDavCollectionResponse(response, "delete", url, CALENDAR_DAV_CHECK);
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      this.calendarsCache.delete(account.id);
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }

    this.calendarsCache.delete(account.id);
    purgeCachedCalendar(calendarId);
    return {
      calendar_id: calendarId,
      display_name: calendarName,
      url,
      provider: account.id,
    };
  }

  /** Fetches a provider's calendars, populating the shared listing cache. */
  private async fetchCalendarsFor(client: DAVClient, providerId: string): Promise<any[]> {
    const cached = this.calendarsCache.get(providerId);
    if (cached) return cached;
    const calendars = await client.fetchCalendars();
    this.calendarsCache.set(providerId, calendars);
    return calendars;
  }

  async listEvents(calendarId: string, start: string, end: string): Promise<EventSummary[]> {
    const { account, calendarName } = this.resolveAccount(calendarId);

    try {
      const client = await this.getClient(account);
      const calendar = await this.findCalendar(client, calendarName, account.id);

      const objects = await client.fetchCalendarObjects({
        calendar,
        timeRange: { start, end },
        expand: true,
      });

      const summaries: EventSummary[] = [];
      for (const obj of objects) {
        if (!obj.data) continue;
        const parsed = parseIcsEvents(obj.data, { start, end }, this.timezone);
        for (const event of parsed) {
          // Populate the URL cache opportunistically so subsequent
          // get/update/delete for any of these UIDs can skip the scan.
          if (event.uid && obj.url) {
            setCachedObject(calendarId, event.uid, { url: obj.url, etag: obj.etag });
          }
          summaries.push({
            uid: event.uid,
            calendar_id: calendarId,
            title: event.title,
            start: event.start,
            end: event.end,
            all_day: event.all_day,
            location: event.location,
            status: event.status,
            is_recurring: event.is_recurring,
            occurrence_date: event.occurrence_date,
          });
        }
      }

      return summaries;
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async listEventsFull(calendarId: string, start: string, end: string): Promise<EventFull[]> {
    const { account, calendarName } = this.resolveAccount(calendarId);

    try {
      const client = await this.getClient(account);
      const calendar = await this.findCalendar(client, calendarName, account.id);

      const objects = await client.fetchCalendarObjects({
        calendar,
        timeRange: { start, end },
        expand: true,
      });

      const events: EventFull[] = [];
      for (const obj of objects) {
        if (!obj.data) continue;
        const parsed = parseIcsEvents(obj.data, { start, end }, this.timezone);
        for (const event of parsed) {
          events.push(this.toEventFull(event, calendarId));
        }
      }

      return events;
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async getEvent(calendarId: string, uid: string): Promise<EventFull> {
    const { account, calendarName } = this.resolveAccount(calendarId);

    try {
      const client = await this.getClient(account);
      const calendar = await this.findCalendar(client, calendarName, account.id);
      const obj = await this.findCalendarObject(client, calendar, uid, calendarId);
      const parsed = parseIcsEvents(obj.data!, undefined, this.timezone);
      const event = parsed.find((e) => e.uid === uid);
      if (!event) {
        throw new CalendarError(`Event "${uid}" not found`, ErrorCode.EVENT_NOT_FOUND, uid);
      }

      return this.toEventFull(event, calendarId);
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async getEventWithMeta(
    calendarId: string,
    uid: string,
  ): Promise<{ event: EventFull; meta: CalendarObjectMeta }> {
    const { account, calendarName } = this.resolveAccount(calendarId);

    try {
      const client = await this.getClient(account);
      const calendar = await this.findCalendar(client, calendarName, account.id);
      const obj = await this.findCalendarObject(client, calendar, uid, calendarId);
      const parsed = parseIcsEvents(obj.data!, undefined, this.timezone);
      const event = parsed.find((e) => e.uid === uid);
      if (!event) {
        throw new CalendarError(`Event "${uid}" not found`, ErrorCode.EVENT_NOT_FOUND, uid);
      }

      return {
        event: this.toEventFull(event, calendarId),
        meta: { url: obj.url, etag: obj.etag },
      };
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async createEvent(calendarId: string, icalString: string, uid: string): Promise<EventFull> {
    const { account, calendarName } = this.resolveAccount(calendarId);

    try {
      const client = await this.getClient(account);
      const calendar = await this.findCalendar(client, calendarName, account.id);
      const filename = `${uid}.ics`;
      const response = await client.createCalendarObject({
        calendar,
        iCalString: icalString,
        filename,
      });
      if (!(response as any).ok) {
        throw new CalendarError(
          `Failed to create event: ${(response as any).status} ${(response as any).statusText}`,
          ErrorCode.WRITE_FAILED,
          uid,
        );
      }

      // Cache the object URL for fast UID lookup by subsequent get/update/delete.
      // tsdav composes the URL as new URL(filename, calendar.url).href, so we can
      // derive it locally without a re-fetch. ETag is best-effort from the response.
      try {
        const objectUrl = new URL(filename, (calendar as { url: string }).url).href;
        const etag = (response as unknown as Response).headers?.get?.("etag") ?? undefined;
        setCachedObject(calendarId, uid, { url: objectUrl, etag: etag ?? undefined });
      } catch {
        // Cache write failures are non-fatal
      }

      const parsed = parseIcsEvents(icalString, undefined, this.timezone);
      const event = parsed.find((e) => e.uid === uid);
      if (!event) {
        throw new CalendarError(`Event "${uid}" not found in ICS`, ErrorCode.EVENT_NOT_FOUND, uid);
      }

      return this.toEventFull(event, calendarId);
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      this.calendarsCache.delete(account.id);
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async updateEvent(
    calendarId: string,
    uid: string,
    icalString: string,
    meta?: CalendarObjectMeta,
  ): Promise<EventFull> {
    const { account, calendarName } = this.resolveAccount(calendarId);

    try {
      const client = await this.getClient(account);

      let url: string;
      let etag: string | undefined;
      if (meta?.url) {
        url = meta.url;
        etag = meta.etag;
      } else {
        const calendar = await this.findCalendar(client, calendarName, account.id);
        const obj = await this.findCalendarObject(client, calendar, uid, calendarId);
        url = obj.url;
        etag = obj.etag;
      }

      let response = await client.updateCalendarObject({
        calendarObject: { url, etag, data: icalString },
      });

      // On 412 Precondition Failed, the server's etag has changed between our read
      // and our PUT. This can happen from server-side ICS normalization, concurrent
      // edits, or weak/strong etag drift. Refetch the current etag and retry once.
      if ((response as any).status === 412) {
        const calendar = await this.findCalendar(client, calendarName, account.id);
        const obj = await this.findCalendarObject(client, calendar, uid, calendarId);
        url = obj.url;
        etag = obj.etag;
        response = await client.updateCalendarObject({
          calendarObject: { url, etag, data: icalString },
        });
      }

      if (!(response as any).ok) {
        throw new CalendarError(
          `Failed to update event: ${(response as any).status} ${(response as any).statusText}`,
          ErrorCode.WRITE_FAILED,
          uid,
        );
      }

      const parsed = parseIcsEvents(icalString, undefined, this.timezone);
      const event = parsed.find((e) => e.uid === uid);
      if (!event) {
        throw new CalendarError(`Event "${uid}" not found in ICS`, ErrorCode.EVENT_NOT_FOUND, uid);
      }

      return this.toEventFull(event, calendarId);
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      this.calendarsCache.delete(account.id);
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async moveEvent(
    calendarId: string,
    uid: string,
    targetCalendarId: string,
    meta?: CalendarObjectMeta,
  ): Promise<EventFull> {
    const { account, calendarName } = this.resolveAccount(calendarId);
    const target = this.resolveAccount(targetCalendarId);

    if (account.id !== target.account.id) {
      throw new CalendarError(
        "Moving events across providers/accounts is not supported",
        ErrorCode.WRITE_FAILED,
        uid,
      );
    }

    try {
      const client = await this.getClient(account);

      let url: string;
      let etag: string | undefined;
      if (meta?.url) {
        url = meta.url;
        etag = meta.etag;
      } else {
        const calendar = await this.findCalendar(client, calendarName, account.id);
        const obj = await this.findCalendarObject(client, calendar, uid, calendarId);
        url = obj.url;
        etag = obj.etag;
      }

      const targetCalendar = await this.findCalendar(client, target.calendarName, account.id);
      const sourceFilename = new URL(url).pathname.split("/").pop();
      if (!sourceFilename) {
        throw new CalendarError(
          `Failed to derive calendar object filename for event "${uid}"`,
          ErrorCode.WRITE_FAILED,
          uid,
        );
      }

      const targetCalendarUrl = new URL(targetCalendar.url, account.url).toString();
      const destination = new URL(sourceFilename, targetCalendarUrl).toString();

      const performMove = async (currentUrl: string, currentEtag?: string): Promise<Response> => {
        const headers: Record<string, string> = {
          Authorization: `Basic ${Buffer.from(`${account.username}:${account.password}`).toString("base64")}`,
          Destination: destination,
          Overwrite: "F",
        };
        if (currentEtag) {
          headers["If-Match"] = currentEtag;
        }
        return fetch(currentUrl, {
          method: "MOVE",
          headers,
        });
      };

      let response = await performMove(url, etag);

      if (response.status === 412) {
        const calendar = await this.findCalendar(client, calendarName, account.id);
        const obj = await this.findCalendarObject(client, calendar, uid, calendarId);
        url = obj.url;
        etag = obj.etag;
        response = await performMove(url, etag);
      }

      if (!response.ok) {
        throw new CalendarError(
          `Failed to move event: ${response.status} ${response.statusText}`,
          ErrorCode.WRITE_FAILED,
          uid,
        );
      }

      deleteCachedObject(calendarId, uid);
      try {
        const relative = new URL(destination).pathname;
        setCachedObject(targetCalendarId, uid, {
          url: relative || destination,
        });
      } catch {
        setCachedObject(targetCalendarId, uid, { url: destination });
      }

      return await this.getEvent(targetCalendarId, uid);
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      this.calendarsCache.delete(account.id);
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async deleteEvent(calendarId: string, uid: string, meta?: CalendarObjectMeta): Promise<void> {
    const { account, calendarName } = this.resolveAccount(calendarId);

    try {
      const client = await this.getClient(account);

      let url: string;
      let etag: string | undefined;
      if (meta?.url) {
        url = meta.url;
        etag = meta.etag;
      } else {
        const calendar = await this.findCalendar(client, calendarName, account.id);
        const obj = await this.findCalendarObject(client, calendar, uid, calendarId);
        url = obj.url;
        etag = obj.etag;
      }

      let response = await client.deleteCalendarObject({
        calendarObject: { url, etag },
      });

      // On 412 Precondition Failed, refetch the current etag and retry once.
      // Same rationale as updateEvent — server-side etag drift is common on some
      // CalDAV servers and a single stale read shouldn't hard-fail the operation.
      if ((response as any).status === 412) {
        const calendar = await this.findCalendar(client, calendarName, account.id);
        const obj = await this.findCalendarObject(client, calendar, uid, calendarId);
        url = obj.url;
        etag = obj.etag;
        response = await client.deleteCalendarObject({
          calendarObject: { url, etag },
        });
      }

      if (!(response as any).ok) {
        throw new CalendarError(
          `Failed to delete event: ${(response as any).status} ${(response as any).statusText}`,
          ErrorCode.WRITE_FAILED,
          uid,
        );
      }
      // Invalidate the URL cache for this UID now that the object is gone.
      deleteCachedObject(calendarId, uid);
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      this.calendarsCache.delete(account.id);
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async fetchRawCalendarObject(
    calendarId: string,
    uid: string,
  ): Promise<{ data: string; url: string; etag: string }> {
    const { account, calendarName } = this.resolveAccount(calendarId);
    try {
      const client = await this.getClient(account);
      const calendar = await this.findCalendar(client, calendarName, account.id);
      const obj = await this.findCalendarObject(client, calendar, uid, calendarId);
      if (!obj.data || !obj.etag) {
        throw new CalendarError(
          `Calendar object for "${uid}" has no data or etag`,
          ErrorCode.EVENT_NOT_FOUND,
          uid,
        );
      }
      return { data: obj.data, url: obj.url, etag: obj.etag };
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
      status: string | null;
      availability: string | null;
      all_day: boolean;
      calendar_id: string;
    }> = [];

    for (const calendarId of calendarIds) {
      // Skip excluded calendars
      if (options.excludeCalendars?.includes(calendarId)) continue;

      try {
        const { account, calendarName } = this.resolveAccount(calendarId);
        const client = await this.getClient(account);
        const calendar = await this.findCalendar(client, calendarName, account.id);
        const objects = await client.fetchCalendarObjects({
          calendar,
          timeRange: { start, end },
          expand: true,
        });

        for (const obj of objects) {
          if (!obj.data) continue;
          const parsed = parseIcsEvents(obj.data, { start, end });
          for (const event of parsed) {
            allEvents.push({
              start: event.start,
              end: event.end,
              status: event.status,
              availability: event.availability,
              all_day: event.all_day,
              calendar_id: calendarId,
            });
          }
        }
      } catch (error) {
        if (error instanceof CalendarError) throw error;
        throw toPimError(error instanceof Error ? error : new Error(String(error)));
      }
    }

    // 2. Filter events — skip free, all-day (unless opted in), and optionally tentative
    const busyIntervals = allEvents.filter((e) => {
      // Skip all-day events unless includeAllDayAsBusy
      if (e.all_day && !options.includeAllDayAsBusy) return false;
      // Skip free events
      if (e.availability === "free") return false;
      // Skip tentative when ignoreTentative
      if (options.ignoreTentative && e.status === "tentative") return false;
      // Everything else blocks
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

        // Compute preferred boundary timestamps for each day the slot spans,
        // in the configured timezone (DST-safe).
        const dayParts = getLocalDateParts(slotStart, this.timezone);

        const boundaries: number[] = [];
        // Check current day and next day in case slot spans midnight
        for (let d = 0; d <= 1; d++) {
          const prefS = zonedTimeToUtc(
            dayParts.year,
            dayParts.month,
            dayParts.day + d,
            prefStartH,
            prefStartM,
            this.timezone,
          );
          const prefE = zonedTimeToUtc(
            dayParts.year,
            dayParts.month,
            dayParts.day + d,
            prefEndH,
            prefEndM,
            this.timezone,
          );
          if (prefS.getTime() > slotStart.getTime() && prefS.getTime() < slotEnd.getTime()) {
            boundaries.push(prefS.getTime());
          }
          if (prefE.getTime() > slotStart.getTime() && prefE.getTime() < slotEnd.getTime()) {
            boundaries.push(prefE.getTime());
          }
        }

        boundaries.sort((a, b) => a - b);

        // Split the slot at boundaries
        let splitCursor = slotStart.getTime();
        for (const boundary of boundaries) {
          if (boundary > splitCursor) {
            const dur = Math.round((boundary - splitCursor) / 60000);
            if (dur >= durationMinutes) {
              splitSlots.push({
                start: new Date(splitCursor).toISOString(),
                end: new Date(boundary).toISOString(),
                duration: dur,
              });
            }
            splitCursor = boundary;
          }
        }
        // Remainder
        if (slotEnd.getTime() > splitCursor) {
          const dur = Math.round((slotEnd.getTime() - splitCursor) / 60000);
          if (dur >= durationMinutes) {
            splitSlots.push({
              start: new Date(splitCursor).toISOString(),
              end: new Date(slotEnd.getTime()).toISOString(),
              duration: dur,
            });
          }
        }
      }

      // Sort: preferred-hours slots first, then chronologically
      const localMinutes = (d: Date): number => {
        const dtf = new Intl.DateTimeFormat("en-US", {
          timeZone: this.timezone,
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        const parts: Record<string, string> = {};
        for (const p of dtf.formatToParts(d)) parts[p.type] = p.value;
        return (parts.hour === "24" ? 0 : Number(parts.hour)) * 60 + Number(parts.minute);
      };

      splitSlots.sort((a, b) => {
        const aDate = new Date(a.start);
        const bDate = new Date(b.start);
        const aMinutes = localMinutes(aDate);
        const bMinutes = localMinutes(bDate);
        const aInPref = aMinutes >= prefStartMinutes && aMinutes < prefEndMinutes;
        const bInPref = bMinutes >= prefStartMinutes && bMinutes < prefEndMinutes;

        if (aInPref && !bInPref) return -1;
        if (!aInPref && bInPref) return 1;
        return aDate.getTime() - bDate.getTime();
      });

      return this.formatSlots(splitSlots);
    }

    return this.formatSlots(freeSlots);
  }

  private toEventFull(event: ParsedEvent, calendarId: string): EventFull {
    return {
      uid: event.uid,
      calendar_id: calendarId,
      title: event.title,
      start: event.start,
      end: event.end,
      all_day: event.all_day,
      location: event.location,
      status: event.status,
      is_recurring: event.is_recurring,
      occurrence_date: event.occurrence_date,
      description: event.description,
      url: event.url,
      availability: event.availability,
      attendees: event.attendees,
      organizer: event.organizer,
      recurrence_rule: event.recurrence_rule,
      created: event.created,
      last_modified: event.last_modified,
      alarms: event.alarms,
      categories: event.categories,
      geo: event.geo,
    };
  }

  private formatSlots(slots: FreeSlot[]): FreeSlot[] {
    return slots.map((s) => ({
      start: formatInTimezone(s.start, this.timezone),
      end: formatInTimezone(s.end, this.timezone),
      duration: s.duration,
    }));
  }
}
