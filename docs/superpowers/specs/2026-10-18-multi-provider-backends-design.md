# Multi-provider backends for cal-mcp and card-mcp (#42, #53)

## Goal

Let one cal-mcp (and one card-mcp) serve Google Calendar / Google Contacts and
Microsoft 365 alongside CalDAV/CardDAV accounts, with the same tools and the
same `<provider>/<calendar>` IDs, so an agent does not care which protocol an
account speaks.

Non-goals: Exchange EWS, Gmail (email-mcp stays IMAP/SMTP), syncing between
providers, and accounts whose only API is CalDAV's deprecated Google proxy.

## What the code looks like today

**cal-mcp's tool layer is iCalendar-shaped, not protocol-neutral.** #42
assumed tool handlers could stay unchanged and dispatch on the calendar ID
prefix. They can for reads, but every create and every recurring edit is done
in the tool layer, on iCalendar text:

- `create_event` / `create_events_batch` / `import_ics` build VCALENDAR text and
  call `createEvent(calendarId, ics, uid)`.
- `update_event` (`span: this | future | all`) and `delete_event`
  (`span: this | future`) call `fetchRawCalendarObject`, rewrite the stored
  VCALENDAR with pim-core's ICS helpers (override VEVENTs, `EXDATE`, `UNTIL`,
  splitting a series), and write it back with `updateEvent(calendarId, uid, ics,
  meta)`.

Google Calendar API v3 and Microsoft Graph take JSON events, not iCalendar. So
the recurrence logic has to move *below* the backend interface before a
non-CalDAV provider can exist. That move is the bulk of this work.

**card-mcp is already close.** Its tools exchange pim-core's structured
`Contact` and `ContactUpdates`. The CardDAV traits that show through are that
address books are named by URL, and `LocatedContact` carries the raw vCard and
etag. Both can be treated as opaque by callers.

## Architecture

```
tools ──▶ Router (CalendarBackend) ──┬─▶ CalDavBackend    (account "mailbox")
          dispatch on ID prefix,     ├─▶ CalDavBackend    (account "nextcloud")
          fan out list/free-busy     ├─▶ GoogleBackend    (account "gmail")
                                     └─▶ GraphBackend     (account "work")
```

- **Backend interface** (`providers/CalendarBackend.ts`,
  `providers/ContactsBackend.ts`): the semantic operations the tools need, in
  this package's own data shapes (`providers/types.ts`).
- **Router**: owns the account map, dispatches per-calendar calls on the ID
  prefix, and fans out the cross-account ones (`listCalendars`, free/busy, free
  slots), keeping #127's "skip an unreachable provider in listings, never in
  availability" rule in one place.
- **CalDavBackend**: today's CalDavService, one instance per account, plus the
  recurrence logic currently in `calendarTools.ts`.

### Phase 2 interface change (events)

The iCalendar-level methods are replaced by semantic writes, with recurrence
handled by each backend:

```ts
createEvent(calendarId, input: EventInput): Promise<EventFull>
updateEvent(calendarId, uid, changes: EventChanges,
            target: { span: "all" } | { span: "this" | "future"; occurrenceDate: string },
            meta?): Promise<EventFull>
deleteEvent(calendarId, uid,
            target: { span: "all" } | { span: "this" | "future"; occurrenceDate: string },
            meta?): Promise<void>
importIcs(calendarId, ics): Promise<EventFull[]>    // CalDAV stores it, Google imports, Graph parses
```

`EventInput` / `EventChanges` are what the tools already validate (title,
start/end, all_day, location, description, attendees, alarms, categories,
availability, recurrence_rule). The confirmation decisions stay in the tool
layer, but they need facts only the backend has: "would this split discard
overrides?" and "is this the only occurrence?". So the backend gets a
read-only `planEventChange(…)` that answers them without writing.

## Providers

| | CalDAV (today) | iCloud | Google Calendar API v3 | Microsoft Graph |
| --- | --- | --- | --- | --- |
| Protocol | CalDAV | CalDAV | REST/JSON | REST/JSON |
| Auth | Basic | Basic with an app-specific password | OAuth 2.0 | OAuth 2.0 (Entra ID; tenant-aware) |
| Event ID | iCalendar UID | UID | `id`; `iCalUID` kept and queryable | `id` (changes on move unless `Prefer: IdType="ImmutableId"`); `iCalUId` |
| Occurrence | RECURRENCE-ID | RECURRENCE-ID | `recurringEventId` + `originalStartTime`; `events.instances` | `type: occurrence/exception`, `seriesMasterId`; `/instances` |
| Free/busy | `free-busy-query` or computed | same | `freebusy.query` | `getSchedule` |
| Sharing (#47) | CalendarServer / ownCloud | CalendarServer | ACL rules API | `calendarPermission` |
| Contacts | CardDAV | CardDAV | People API (`resourceName`) | `/me/contacts` |

**iCloud needs no new backend.** It is CalDAV/CardDAV at `caldav.icloud.com` /
`contacts.icloud.com` with principal discovery, which tsdav already does. It
needs a documented config example and a run of the live-smoke matrix. Whether
iCloud honours the slug URL that `create_calendar` asks for is untested.
mailbox.org, for one, files a new calendar under its own ID and keeps the
requested URL working as an alias.

**Event IDs:** keep the tools' `uid` as the iCalendar UID where the provider
exposes one (Google and Graph both do, `iCalUID` / `iCalUId`), and resolve it
to the provider's own ID in the backend, with a cache like `urlCache.ts`. That
keeps IDs stable across providers and keeps `import_ics` dedup meaningful.

## Authentication

This is the decision that most affects deployment, and it needs the
maintainer's call:

1. **Refresh token in the environment** (`GOOGLE_<ID>_REFRESH_TOKEN`, client
   ID and secret). The server only refreshes access tokens. A one-off
   `cal-mcp auth google <id>` command runs the OAuth device or loopback flow
   and prints the token to store. Fits stdio and Docker equally well and needs
   no server-side storage. *Recommended.*
2. **Token file** under `$XDG_CONFIG_HOME/pim-agents/` (mode 0600), written by
   the same auth command and refreshed in place. Rotates cleanly, but needs a
   writable volume in Docker.
3. **MCP authorization (2026-07-28, HTTP transport only)**: the client
   authorizes the *user* to the MCP server; downstream Google/Graph tokens
   would still have to be obtained and stored by the server, so this composes
   with 1 or 2 rather than replacing them.

Scopes stay minimal: `calendar.events` + `calendar.readonly` (Google), and
`Calendars.ReadWrite` + `Contacts.ReadWrite` (Graph). Google and Graph accounts
are opt-in per account, and CalDAV remains the zero-setup default.

## Configuration

The account ID stays the env-prefix, with a type selector that defaults to
CalDAV, so existing configs are unchanged:

```
CAL_WORK_TYPE=graph            # caldav (default) | google | graph
CAL_WORK_TENANT=…              # graph only
CAL_WORK_CLIENT_ID=…  CAL_WORK_CLIENT_SECRET=${…}  CAL_WORK_REFRESH_TOKEN=${…}
CALDAV_MAILBOX_URL=…           # existing form keeps working
```

## Phases

1. **Interfaces, no behaviour change** (this PR). `CalendarBackend` /
   `IcsCalendarBackend` and `ContactsBackend`, with the data types in
   `providers/types.ts`. Both services `implements` their interface, and the
   tools depend on the interface instead of the class. The existing suites pass
   unchanged.
2. **Semantic event writes.** Move the recurrence edits from `calendarTools.ts`
   into the CalDAV backend behind the phase-2 methods, then drop
   `IcsCalendarBackend`. The existing tool tests are the safety net, re-pointed
   at the backend, plus the live-smoke calendar matrix.
3. **Router and per-account backends**, with #127's partial-listing rule moved
   into the router. Document iCloud and run the matrix against it.
4. **Google backend** (calendar, then People API for card-mcp) behind
   `CAL_<ID>_TYPE=google`, with the auth command.
5. **Graph backend**, same shape.

Each phase ships on its own, and phases 1 to 3 change nothing for an existing
user.

## Open questions

- Auth option 1 or 2 (or both)?
- Should Google/Graph backends live in cal-mcp / card-mcp, or in a separate
  optional package so CalDAV-only users don't install the SDKs? A separate
  package costs a plugin seam in the router.
- Which accounts are available to test phases 4–5 live? The live-smoke rule
  is that writes only go to dedicated test calendars.
