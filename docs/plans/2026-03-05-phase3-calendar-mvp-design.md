# Phase 3: Calendar (CalDAV) MVP Design

**Date:** March 5, 2026
**Status:** Approved
**Scope:** `@miguelarios/cal-mcp` — CalDAV calendar MCP server with multi-provider support

---

## Tool Surface (9 tools)

| Tool | Description | Priority |
|------|------------|----------|
| `list_calendars` | List all calendars across all providers. Returns provider-prefixed IDs (e.g., `mailbox/work`), display names, colors, read-only status. | Must Have |
| `list_events` | Query events by date range within a calendar. Expands recurring events. Returns summaries with UID, title, start/end, location. | Must Have |
| `get_event` | Fetch full event details by calendar + UID — description, attendees, recurrence rule, location, status. | Must Have |
| `create_event` | Create a single event — summary, start/end (ISO 8601), location, description, attendees, target calendar. | Must Have |
| `update_event` | Update an existing event by calendar + UID. Merge update — only provided fields change. | Must Have |
| `delete_event` | Delete event by calendar + UID. | Must Have |
| `create_events_batch` | Create multiple events at once. Accepts an array of event objects. Returns created UIDs. | Must Have |
| `import_ics` | Parse iCalendar string content and create events in target calendar. | Must Have |
| `find_free_slots` | Find available time slots in a date range. Requires explicit `calendars` array (opt-in). Supports duration, preferred hours, and tentative handling. | Should Have |

### Deferred

- **`resolve_datetime`** — natural language to RFC 3339 timestamps. Deferred to Phase 5; the agent (Claude) can produce ISO timestamps directly.
- **`check_availability`** — redundant with `find_free_slots` using a narrow time range.

---

## Architecture

```
packages/cal-mcp/src/
├── main.ts                    # MCP server (createServer, startServer)
├── bin/cli.ts                 # npx entrypoint
├── services/
│   └── CalDavService.ts       # Multi-provider CalDAV operations
├── tools/
│   └── calendarTools.ts       # 9 MCP tool defs + handler
├── ical.ts                    # iCal generate/parse helpers
└── __tests__/
    ├── CalDavService.test.ts
    ├── calendarTools.test.ts
    └── ical.test.ts
```

### CalDavService

Single class with internal provider map. Approach A from brainstorming — matches card-mcp's single-service pattern while adding multi-provider routing.

- Constructor takes `CalDavConfig` (array of accounts)
- Each method creates a `DAVClient` per-request (connect-per-request)
- Routes by splitting provider-prefixed ID on `/` — e.g., `mailbox/work` → mailbox account, calendar path `work`
- Methods:
  - `listCalendars()` — fetches from all providers, returns with prefixed IDs
  - `listEvents(calendarId, start, end)` — time-range query with recurring event expansion (`expand: true`)
  - `getEvent(calendarId, uid)` — fetch single event by UID
  - `createEvent(calendarId, icalString)` — create calendar object
  - `updateEvent(calendarId, uid, icalString)` — update calendar object
  - `deleteEvent(calendarId, uid)` — delete calendar object
  - `findFreeSlots(calendarIds, start, end, duration, options?)` — availability search

### ical.ts — iCalendar Helpers

Thin wrapper around libraries:
- `generateEvent(props)` → iCalendar string (uses `ical-generator`)
- `parseIcs(content)` → array of parsed event objects (uses `node-ical`)

### Connection Strategy

Connect-per-request. Each tool call creates a fresh `DAVClient`, logs in, performs the operation, and disconnects. Same pattern as card-mcp with tsdav. CalDAV handshake overhead is negligible for MCP usage patterns.

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `tsdav` | CalDAV protocol client (shared with card-mcp) |
| `ical-generator` | Generate iCalendar VEVENT strings |
| `node-ical` | Parse .ics content with recurrence expansion |

---

## Configuration

Single env var with JSON array of CalDAV accounts:

```
CALDAV_ACCOUNTS='[
  {"id":"mailbox","url":"https://dav.mailbox.org/caldav/","username":"user","password":"pass"},
  {"id":"nextcloud","url":"https://cloud.example.com/remote.php/dav/calendars/user/","username":"user","password":"pass"}
]'
```

### Core Config (pim-core/config.ts)

```typescript
export interface CalDavAccount {
  id: string;       // provider prefix: "mailbox", "nextcloud"
  url: string;      // CalDAV base URL
  username: string;
  password: string;
}

export interface CalDavConfig {
  accounts: CalDavAccount[];
}
```

Validated with Valibot. Each account must have non-empty `id`, valid `url`, non-empty `username` and `password`.

---

## Core Library Changes

### New Error Codes (pim-core/errors.ts)

```typescript
CALENDAR_NOT_FOUND = "CALENDAR_NOT_FOUND",
EVENT_NOT_FOUND = "EVENT_NOT_FOUND",
INVALID_ICS = "INVALID_ICS",
```

### New Error Class

```typescript
export class CalendarError extends PimError {
  public readonly eventUid?: string;
  constructor(message: string, code: ErrorCode, eventUid?: string) {
    super(message, code, false);
    this.eventUid = eventUid;
  }
}
```

---

## Event Data Model

```typescript
interface EventSummary {
  uid: string;
  calendarId: string;       // provider-prefixed: "mailbox/work"
  summary: string;
  start: string;            // ISO 8601
  end: string;              // ISO 8601
  location?: string;
  status?: string;          // confirmed, tentative, cancelled
  isRecurring: boolean;
}

interface EventFull extends EventSummary {
  description?: string;
  attendees?: Array<{ name?: string; email: string; status?: string }>;
  organizer?: { name?: string; email: string };
  recurrenceRule?: string;  // RRULE string if recurring
  transparency?: string;    // opaque (busy) or transparent (free)
  created?: string;
  lastModified?: string;
}

interface FreeSlot {
  start: string;            // ISO 8601
  end: string;              // ISO 8601
  duration: number;         // minutes
}
```

---

## find_free_slots Design

### Parameters

```typescript
{
  calendars: string[];        // required, opt-in: ["mailbox/work", "nextcloud/personal"]
  start: string;              // ISO 8601
  end: string;                // ISO 8601
  duration: number;           // minutes
  preferredStart?: string;    // HH:MM — prefer slots after this time
  preferredEnd?: string;      // HH:MM — prefer slots before this time
  ignore_tentative?: boolean; // default false — if true, tentative events don't block slots
}
```

### Availability Logic

- Events with TRANSP: TRANSPARENT → **never block** (always ignored)
- Events with status TENTATIVE → **block by default**; `ignore_tentative: true` makes them non-blocking
- Events with status CONFIRMED/BUSY → **always block**

### Algorithm

1. Fetch all events across specified calendars for the date range
2. Filter out transparent events; filter out tentative if `ignore_tentative: true`
3. Merge overlapping busy intervals across all calendars
4. Find gaps ≥ `duration` minutes
5. Sort: slots within preferred hours first, then outside preferred hours

---

## Testing Strategy

- Mock `tsdav` — `vi.mock("tsdav")` (same pattern as card-mcp)
- Mock `ical-generator` and `node-ical` for ical.ts helpers
- **CalDavService tests:** list calendars, CRUD events, multi-provider routing, free slot calculation
- **ical.ts tests:** generate events with various properties, parse .ics content, edge cases (missing fields, malformed input)
- **Tool handler tests:** routing, error responses, parameter validation
- **find_free_slots tests:** overlapping events, tentative handling, preferred hours filtering, cross-provider merging, edge cases (no events, fully booked)

---

## Tool Handler Pattern

Same pattern as card-mcp `contactTools.ts` and email-mcp `emailTools.ts`:
- `CALENDAR_TOOLS` array of tool definitions with JSON Schema `inputSchema`
- `handleCalendarTool(name, args, service)` router
- `ok(data)` / `error(message)` response helpers
