# Calendar MCP Tools

`@miguelarios/cal-mcp` — CalDAV calendar server with 16 tools.

> Definitions are pulled directly from `packages/cal-mcp/src/tools/calendarTools.ts` (events) and `packages/cal-mcp/src/tools/calendarManagementTools.ts` (calendar collections). Output shapes from `packages/cal-mcp/src/tools/calendarSchemas.ts` and `packages/cal-mcp/src/services/CalDavService.ts`.

> All results carry validated `structuredContent` matching the tool's advertised `outputSchema`, with the same JSON serialized into a text block for clients that do not read structured output. Errors are returned as `isError: true` with a `{ error, message, retryable }` body.

## list_calendars

List all calendars across all configured CalDAV providers. Returns provider-prefixed IDs (e.g., `mailbox/work`).

*No parameters.*

**Output**

```ts
{
  calendars: Array<{
    calendar_id: string;     // provider-prefixed, e.g. "mailbox/Work"
    display_name: string;
    color: string | null;
    description: string | null;
    timezone: string | null; // IANA zone from calendar-timezone(-id), where the provider reports one
    order: number | null;    // Apple calendar-order sort position, where reported
    source: string;          // provider name
    read_only: boolean;
    url: string;             // CalDAV URL
    ctag?: string;
  }>;
}
```

## list_events

Query events in a date range. Recurring events are expanded into individual instances.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `calendar` | string | | Provider-prefixed calendar ID (e.g., `mailbox/Work`). If omitted, queries all calendars. |
| `calendars` | string[] | | Provider-prefixed calendar IDs to query (e.g., `["mailbox/Work", "mailbox/Team"]`). Combined with `calendar` if both are given. If neither is given, queries all calendars. |
| `start` | string | yes | Start of date range (ISO 8601). |
| `end` | string | yes | End of date range (ISO 8601). |
| `detail_level` | `"summary"` \| `"full"` | | Response verbosity (default: `summary`). |

**Output**

```ts
{ events: EventSummary[] }            // when detail_level = "summary" (default)
{ events: EventFull[]    }            // when detail_level = "full"
```

See [Event shapes](#event-shapes) below.

## get_today_events

Get all events for today. Convenience wrapper over `list_events`.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `calendar` | string | | Provider-prefixed calendar ID. If omitted, queries all calendars. |
| `calendars` | string[] | | Provider-prefixed calendar IDs to query. Combined with `calendar` if both are given. If neither is given, queries all calendars. |
| `detail_level` | `"summary"` \| `"full"` | | Response verbosity (default: `summary`). |

**Output**

Same as `list_events` — `{ events: EventSummary[] | EventFull[] }`.

## search_events

Keyword search across event title, description, and location.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search term. |
| `calendar` | string | | Provider-prefixed calendar ID. If omitted, searches all calendars. |
| `calendars` | string[] | | Provider-prefixed calendar IDs to search. Combined with `calendar` if both are given. If neither is given, searches all calendars. |
| `start` | string | | Range start (ISO 8601). Defaults to 90 days ago. |
| `end` | string | | Range end (ISO 8601). Defaults to 90 days ahead. |
| `detail_level` | `"summary"` \| `"full"` | | Response verbosity (default: `summary`). |

**Output**

`{ events: EventSummary[] | EventFull[] }` — matches whose title, location, or (when `full`) description contains the query (case-insensitive substring).

## get_event

Get full details of a single event by calendar and UID. For a recurring event, pass `occurrence_date` to get one occurrence as it will actually happen — including any changes made to just that occurrence — instead of the master series.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `calendar` | string | yes | Provider-prefixed calendar ID. |
| `uid` | string | yes | Event UID. |
| `occurrence_date` | string | | ISO 8601 date-time of one occurrence of a recurring event, as returned in `list_events` results. Returns that occurrence (with any per-occurrence overrides applied) rather than the master series. Omit to get the master. `validation_error` on a non-recurring event; `not_found` if the series has no occurrence at that instant. |

**Output**

```ts
{ event: EventFull }
```

## create_event

Create a new calendar event.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `calendar` | string | yes | Provider-prefixed calendar ID. |
| `title` | string | yes | Event title. |
| `start` | string | yes | Start time (ISO 8601). |
| `end` | string | yes | End time (ISO 8601). |
| `all_day` | boolean | | All-day event flag (default: false). |
| `location` | string | | Event location. |
| `description` | string | | Event description. |
| `attendees` | `{ email: string }[]` | | List of attendee email addresses to invite. Display name is resolved server-side from the invitee's address book. |
| `alarms` | `{ type: "relative" \| "absolute", trigger: string \| number }[]` | | Event reminders/alarms. `trigger` is seconds offset (negative = before event) for relative, or ISO 8601 datetime for absolute. |
| `categories` | string[] | | Event categories/tags. |
| `recurrence_rule` | string | | RFC 5545 RRULE string for a recurring event (e.g., `FREQ=WEEKLY;BYDAY=MO,WE,FR` or `FREQ=MONTHLY;BYDAY=+3FR;COUNT=12`). Accepted with or without the `RRULE:` prefix. `FREQ` is required. |
| `availability` | `"busy"` \| `"free"` | | Free/busy transparency. `busy` (default) blocks the time (TRANSP:OPAQUE); `free` marks the time as available (TRANSP:TRANSPARENT). |

**Output**

```ts
{ event: EventFull }
```

Errors with `validation_error` on invalid `recurrence_rule`. ORGANIZER is auto-populated from the calendar account when attendees are present.

## update_event

Update an existing event. Only provided fields are changed.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `calendar` | string | yes | Provider-prefixed calendar ID. |
| `uid` | string | yes | Event UID to update. |
| `title` | string | | New event title. |
| `start` | string | | New start time (ISO 8601). |
| `end` | string | | New end time (ISO 8601). |
| `all_day` | boolean | | All-day event flag. |
| `location` | string | | New location. |
| `description` | string | | New description. |
| `attendees` | `{ email: string }[]` | | New attendee list (replaces existing). Display name is resolved server-side. |
| `alarms` | `{ type: "relative" \| "absolute", trigger: string \| number }[]` | | Event reminders/alarms. |
| `categories` | string[] | | Event categories/tags. |
| `occurrence_date` | string | | ISO 8601 date of the specific occurrence to modify. **Required** when `span` is `"this"` or `"future"` on a recurring event. Get this value from `list_events` results. |
| `span` | `"this"` \| `"all"` \| `"future"` | | `this` modifies only this occurrence (default), `future` modifies this occurrence and every later one, `all` modifies the entire series. |
| `availability` | `"busy"` \| `"free"` | | Free/busy transparency. If omitted, existing value is preserved. |

**Output**

```ts
{ event: EventFull }
```

When `span: "this"` is applied to a recurring event, the response reflects the modified occurrence (with `occurrence_date` set and `recurrence_rule: null`); the underlying series gets a RECURRENCE-ID exception.

When `span: "future"` is applied to a recurring event, the series is split at the occurrence: the existing object is ended just before it (`UNTIL` on its `RRULE`, keeping earlier occurrences and their overrides), and a **new calendar object with a new UID** carries the remaining pattern with the changes applied — the response is that new series' event, so use its `uid` for later edits. A `COUNT` is reduced by the occurrences already consumed; `EXDATE`s and `RDATE`s are divided between the two halves; per-occurrence overrides at or after the cut are not carried over, and when there are any the user is asked to confirm first (`confirm_update_event`), since that is the one thing this update can lose. `occurrence_date` must be an occurrence the series actually generates (a rule instance or an `RDATE`), otherwise `validation_error`: a nearby date would silently become the new series' start and shift every later occurrence. A cut at the first occurrence is the same as `span: "all"`. The new series is written before the old one is cut, so a failure part-way leaves a visible duplicate tail rather than missing occurrences. Giving `start` without `end` keeps the series' duration.

## move_event

Move an event to another calendar, equivalent to reassigning its calendar in a CalDAV client. Both calendars must belong to the same account: the move is a WebDAV `MOVE` of the calendar object, with `If-Match` on the current etag and one retry on `412`.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `calendar` | string | yes | Provider-prefixed calendar ID the event is in. |
| `uid` | string | yes | Event UID to move. |
| `target_calendar` | string | yes | Destination provider-prefixed calendar ID, on the same account. |

**Output**

```ts
{ event: EventFull }   // as read back from the target calendar
```

## delete_event

Delete a calendar event by UID.

> **Asks for confirmation.** Gated whenever the calendar object is actually removed — that is `span: "all"`, and also `span: "this"` on a **non-recurring** event, where there is no occurrence to exclude — and whenever a series is cut short with `span: "future"`, since the removed occurrences (and any overrides among them) cannot be recovered. Only excluding one occurrence of a recurring event (`span: "this"` on a recurring event, which adds an `EXDATE`) is ungated, since it can be undone by re-adding the occurrence. The client prompts the user before the operation runs; declining returns an error and changes nothing. Set `PIM_MCP_CONFIRM=off` to skip.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `calendar` | string | yes | Provider-prefixed calendar ID. |
| `uid` | string | yes | Event UID to delete. |
| `occurrence_date` | string | | ISO 8601 date of the specific occurrence to delete. **Required** when `span` is `"this"` or `"future"` on a recurring event. Get this value from `list_events` results. |
| `span` | `"this"` \| `"all"` \| `"future"` | | `this` deletes only this occurrence (adds EXDATE), `future` deletes this occurrence and every later one, `all` (default) deletes the entire series. |

`span: "future"` sets `UNTIL` on the master `RRULE` to just before the occurrence (one second before for a timed series, the previous day for an all-day one), replacing any `COUNT`; overrides, `RDATE`s and `EXDATE`s at or after the cut are removed, earlier ones are kept. When the occurrence is the first one, nothing would remain, so the whole object is deleted instead. `validation_error` on a non-recurring event.

**Output**

```json
{ "deleted": true, "uid": "<event-uid>" }
```

## create_events_batch

Create multiple events at once. Returns created event count.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `calendar` | string | yes | Provider-prefixed calendar ID. |
| `events` | object[] | yes | Array of events to create. Each event takes the same fields as `create_event` (minus `calendar`): `title` (required), `start` (required), `end` (required), `all_day`, `location`, `description`, `attendees`, `alarms`, `categories`, `recurrence_rule`, `availability`. |

**Output**

```ts
{ created: number; events: EventFull[] }
```

Events are created one at a time, in order. An invalid `recurrence_rule` returns `validation_error` and stops the batch, but events already created before it stay created.

## import_ics

Import events from iCalendar (.ics) content into a calendar.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `calendar` | string | yes | Provider-prefixed calendar ID. |
| `ics_content` | string | yes | Raw iCalendar content string. |

**Output**

```ts
{
  imported: number;
  failed?: Array<{ uid: string; message: string }>;   // omitted when every event was written
  events: Array<EventFull | { uid: string }>;         // { uid } alone when the write succeeded but the read-back did not
}
```

The content is split by UID (a recurring series and its overrides stay one calendar object) and each object is written separately, so one rejected event does not stop the rest: it is reported under `failed` with the server's reason. Errors with `validation_error` if no events parse from the ICS content.

## get_free_busy

When is a calendar busy? Returns the busy periods in a date range — merged, typed as `busy`, `tentative` or `unavailable` — without event details, so availability questions cost one call and expose nothing else. Uses the server's own `free-busy-query` REPORT (RFC 4791 §7.10) where it answers one, otherwise computes from the expanded events the same way `find_free_slots` does. Use `find_free_slots` to get the free windows of a given length instead.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `calendars` | string[] | | Provider-prefixed calendar IDs to report on. If omitted, uses all calendars. |
| `start` | string | yes | Start of range (ISO 8601). |
| `end` | string | yes | End of range (ISO 8601). Must be after `start`. |
| `include_all_day_as_busy` | boolean | | Treat all-day events as busy when computing from events (default: false). A server-side answer decides this itself. |
| `ignore_tentative` | boolean | | If true, tentative periods are left out (default: false). |

**Output**

```ts
{
  start: string;             // ISO 8601, normalised
  end: string;
  busy: Array<{
    start: string;           // ISO 8601 UTC, clipped to the range
    end: string;
    type: "busy" | "tentative" | "unavailable";
  }>;
  count: number;
  sources: Record<string, "server" | "computed">;   // per calendar_id
}
```

Overlapping periods of the same type are merged; a `busy` and a `tentative` period can still overlap. `sources` says which path each calendar took: the two can differ on all-day and transparent (`availability: free`) events, which are the server's call on its path and the options' on ours. SabreDAV-based servers (Nextcloud) only answer `free-busy-query` on the scheduling outbox, so they report `computed`.

## find_free_slots

Find available time slots across specified calendars. Returns free windows matching the requested duration.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `calendars` | string[] | | Provider-prefixed calendar IDs to check availability against. If omitted, uses all calendars. |
| `start` | string | yes | Start of search range (ISO 8601). |
| `end` | string | yes | End of search range (ISO 8601). |
| `duration` | number | yes | Minimum slot duration in minutes. |
| `preferred_start` | string | | Preferred earliest time (HH:MM, e.g., `08:00`). |
| `preferred_end` | string | | Preferred latest time (HH:MM, e.g., `17:00`). |
| `exclude_calendars` | string[] | | Calendar IDs to exclude from busy time calculation. |
| `include_all_day_as_busy` | boolean | | Treat all-day events as busy (default: false). |
| `ignore_tentative` | boolean | | If true, tentative events don't block slots (default: false). |

**Output**

```ts
{
  slots: Array<{
    start: string;     // ISO 8601
    end: string;       // ISO 8601
    duration: number;  // minutes
  }>;
  count: number;
}
```

## create_calendar

Create a new calendar on a CalDAV provider. The URL is derived from the display name unless an explicit slug is given.

Fails if a calendar with that name already exists on the provider: the display name is half of every calendar ID, and `findCalendar` resolves each event operation by exact match, so a duplicate would make that ID ambiguous on every subsequent call.

Issues `MKCALENDAR` (RFC 4791 §5.3.1). The request is atomic — name, description and colour are all set in it, so a refused property cannot leave a half-configured calendar behind. Providers vary: Baikal, Radicale, Nextcloud, SOGo, Fastmail and iCloud implement it; Google's CalDAV endpoint does not, and reports back as a plain-language "provider does not allow creating calendars here".

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `display_name` | string | yes | Display name for the new calendar. Becomes the second half of its `calendar_id`. |
| `provider` | string | | Provider/account to create on — the prefix half of a calendar ID (`mailbox` in `mailbox/Work`). Optional when only one account is configured; required otherwise. Call `list_calendars` to see the configured providers. |
| `color` | string | | Colour as `#RRGGBB` or `#RRGGBBAA` (e.g. `#3B82F6`). |
| `description` | string | | Calendar description. |
| `timezone` | string | | Default timezone as an IANA zone name (e.g. `America/Chicago`). Written as RFC 4791 `calendar-timezone` (a `VTIMEZONE`); not every provider keeps it. |
| `order` | integer (≥ 0) | | Sort position among the account's calendars, `0` first. Apple `calendar-order`; honoured by Apple, SabreDAV and Radicale-based servers, ignored by others. |
| `slug` | string | | URL path segment (lowercase letters, digits, hyphens). Derived from `display_name` when omitted. |

**Output**

See [Collection results](#collection-results) — `status: "created"`.

## update_calendar

Update a calendar's display name, colour, description, default timezone and/or display order via `PROPPATCH`. At least one must be given.

**Renaming changes the calendar's ID.** `calendar_id` is `provider/DisplayName`, so after a rename the old ID stops resolving and the new one is returned in the result. The collection URL does not move. As with `create_calendar`, renaming onto a name already used on that provider is refused.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `calendar` | string | yes | Provider-prefixed calendar ID to update (e.g. `mailbox/Work`). |
| `display_name` | string | | New display name. Changes the calendar's ID. |
| `color` | string | | New colour as `#RRGGBB` or `#RRGGBBAA`. |
| `description` | string | | New description. |
| `timezone` | string | | New default timezone as an IANA zone name. Written as RFC 4791 `calendar-timezone` only: RFC 7809's `calendar-timezone-id` is not implemented by SabreDAV-based servers, and a `PROPPATCH` is all-or-nothing, so including it would fail the whole update there. Both forms are read by `list_calendars`. |
| `order` | integer (≥ 0) | | New sort position, `0` first (Apple `calendar-order`). |

**Output**

See [Collection results](#collection-results) — `status: "updated"`, and `calendar_id` is the **post-rename** ID.

## delete_calendar

Delete a calendar and every event in it. This cannot be undone.

> **Asks for confirmation.** The calendar is resolved and its objects counted before the prompt is built, so the confirmation names what is being destroyed — *"Permanently delete calendar "Work" on provider "mailbox" (<url>) and all 214 events in it? This cannot be undone."* The count is read when the prompt is built, so it describes the calendar at that moment rather than guaranteeing what the delete will remove. It counts calendar objects, so a whole recurring series counts once. Declining returns an error and changes nothing. Set `PIM_MCP_CONFIRM=off` to skip.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `calendar` | string | yes | Provider-prefixed calendar ID to delete. |

**Output**

See [Collection results](#collection-results) — `status: "deleted"`.

## Collection results

`create_calendar`, `update_calendar` and `delete_calendar` share one result shape:

```ts
{
  status: "created" | "updated" | "deleted";
  calendar_id: string;      // post-operation ID — reflects a rename
  url: string;              // CalDAV collection URL
  display_name?: string;
}
```

`calendar_id` is always usable directly by the event tools.

## Event shapes

`EventSummary` (default for list/search; `packages/cal-mcp/src/services/CalDavService.ts`):

```ts
interface EventSummary {
  uid: string;
  calendar_id: string;
  title: string;
  start: string;                    // ISO 8601
  end: string;                      // ISO 8601
  all_day: boolean;
  location: string | null;
  status: string | null;            // CONFIRMED | TENTATIVE | CANCELLED
  is_recurring: boolean;
  occurrence_date: string | null;   // ISO 8601 of expanded occurrence (recurring only)
}
```

`EventFull` (returned by `get_event`, `create_event`, `update_event`, `move_event`, `create_events_batch`, `import_ics`, and by the list/search tools when `detail_level: "full"`). The advertised `outputSchema` is the summary shape with every full-only field optional, since one schema covers both detail levels:

```ts
interface EventFull extends EventSummary {
  description: string | null;
  url: string | null;
  availability: string | null;       // "busy" | "free"
  attendees: Array<{
    name: string | null;
    email: string;
    status: string | null;           // NEEDS-ACTION | ACCEPTED | DECLINED | TENTATIVE
    role: string | null;             // CHAIR | REQ-PARTICIPANT | OPT-PARTICIPANT
    type: string;                    // CUTYPE: "person" | "room" | "resource" | "group" (or the raw value)
  }>;
  organizer: { name: string | null; email: string } | null;
  recurrence_rule: string | null;    // RRULE string
  created: string | null;            // ISO 8601
  last_modified: string | null;      // ISO 8601
  alarms: Array<{
    type: "relative" | "absolute";
    trigger: number | string;        // seconds offset (relative) or ISO 8601 (absolute)
    trigger_human: string;           // readable form, e.g. "15 minutes before"; ISO 8601 for absolute
  }>;
  categories: string[];
  geo: { latitude: number; longitude: number } | null;
}
```

## Errors

All tools wrap errors as `{ error: <code>, message: <text>, retryable: <boolean> }` with `isError: true`. Codes: `validation_error`, `not_found`, `backend_error`.

With `CAL_MCP_DEBUG=1`, event-tool results also carry CalDAV request timings in `_meta["com.miguelarios.cal-mcp/debug"]`, outside the validated payload.
