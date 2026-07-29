# Calendar MCP Tools

`@miguelarios/cal-mcp` — CalDAV calendar server with 11 tools.

> Definitions are pulled directly from `packages/cal-mcp/src/tools/calendarTools.ts`. Output shapes from `packages/cal-mcp/src/services/CalDavService.ts`.

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
| `start` | string | | Range start (ISO 8601). Defaults to 90 days ago. |
| `end` | string | | Range end (ISO 8601). Defaults to 90 days ahead. |
| `detail_level` | `"summary"` \| `"full"` | | Response verbosity (default: `summary`). |

**Output**

`{ events: EventSummary[] | EventFull[] }` — matches whose title, location, or (when `full`) description contains the query (case-insensitive substring).

## get_event

Get full details of a single event by calendar and UID.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `calendar` | string | yes | Provider-prefixed calendar ID. |
| `uid` | string | yes | Event UID. |

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
| `occurrence_date` | string | | ISO 8601 date of the specific occurrence to modify. **Required** when `span` is `"this"` on a recurring event. Get this value from `list_events` results. |
| `span` | `"this"` \| `"all"` | | `this` modifies only this occurrence (default), `all` modifies the entire series. |
| `availability` | `"busy"` \| `"free"` | | Free/busy transparency. If omitted, existing value is preserved. |

**Output**

```ts
{ event: EventFull }
```

When `span: "this"` is applied to a recurring event, the response reflects the modified occurrence (with `occurrence_date` set and `recurrence_rule: null`); the underlying series gets a RECURRENCE-ID exception.

## delete_event

Delete a calendar event by UID.

> **Asks for confirmation.** Gated whenever the calendar object is actually removed — that is `span: "all"`, and also `span: "this"` on a **non-recurring** event, where there is no occurrence to exclude. Only excluding one occurrence of a recurring event (`span: "this"` on a recurring event, which adds an `EXDATE`) is ungated, since it can be undone by re-adding the occurrence. The client prompts the user before the operation runs; declining returns an error and changes nothing. Set `PIM_MCP_CONFIRM=off` to skip.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `calendar` | string | yes | Provider-prefixed calendar ID. |
| `uid` | string | yes | Event UID to delete. |
| `occurrence_date` | string | | ISO 8601 date of the specific occurrence to delete. **Required** when `span` is `"this"` on a recurring event. |
| `span` | `"this"` \| `"all"` | | `this` deletes only this occurrence (adds EXDATE), `all` (default) deletes the entire series. |

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

## import_ics

Import events from iCalendar (.ics) content into a calendar.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `calendar` | string | yes | Provider-prefixed calendar ID. |
| `ics_content` | string | yes | Raw iCalendar content string. |

**Output**

```ts
{ imported: number; events: EventFull[] }
```

Errors with `validation_error` if no events parse from the ICS content.

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

`EventFull` (returned by `get_event`, `create_event`, `update_event`, and when `detail_level: "full"`):

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
    type: string;
  }>;
  organizer: { name: string | null; email: string } | null;
  recurrence_rule: string | null;    // RRULE string
  created: string | null;            // ISO 8601
  last_modified: string | null;      // ISO 8601
  alarms: Array<{
    type: "relative" | "absolute";
    trigger: number | string;
    description?: string;
  }>;
  categories: string[];
  geo: { latitude: number; longitude: number } | null;
}
```

## Errors

All tools wrap errors as `{ error: <code>, message: <text> }` with `isError: true`. Codes: `validation_error`, `not_found`, `backend_error`.
