# cal-mcp: Calendar Collection Management

**Date:** 2026-08-28
**Packages:** `@miguelarios/cal-mcp`, `@miguelarios/pim-core`
**Issues:** #43 (create), #44 (update metadata), #45 (delete)
**Status:** Designed, pending implementation

## Problem

`cal-mcp` can read and write events but cannot manage the calendars that hold them.
Creating a calendar, renaming one, changing its color, or deleting one all require
leaving the tool for a provider web UI. The reads and per-event writes already speak
in provider-prefixed calendar IDs (`mailbox/Work`), so the naming surface exists — only
the lifecycle operations are missing.

This is the CalDAV twin of card-mcp's address book management (#54–#57, shipped in
`2026-08-24-card-mcp-address-books-design.md`), with one structural difference that
design never had to face: **cal-mcp is multi-provider**. card-mcp talks to one account,
so "create a book" had an unambiguous destination. cal-mcp holds a map of accounts and
every calendar ID is `provider/DisplayName` — so `create_calendar` must know *which
account* to create on, and rename must contend with the display name being half of the
calendar's identity.

## Solution

Three new tools, following the card-mcp collection-tool pattern:

| Tool | Annotations | Notes |
|------|-------------|-------|
| `create_calendar` | write, non-idempotent | `MKCALENDAR` (RFC 4791 §5.3.1) |
| `update_calendar` | write, idempotent | `PROPPATCH` `displayname` / `calendar-description` / `calendar-color` |
| `delete_calendar` | destructive, idempotent | Gated on `confirmDestructive` |

No new list tool — `list_calendars` already exists and already returns
`calendar_id`, `display_name`, `color`, `url`, and `read_only`.

Tool count goes from 12 to 15.

### Targeting: which account, which calendar

**`create_calendar` takes a `provider` argument** — the account ID that prefixes every
calendar ID (`mailbox` in `mailbox/Work`). It is optional in the schema but resolved
strictly in the handler:

```
provider given      → must match a configured account, else validation_error
                      listing the configured provider IDs
provider omitted,
exactly one account → that account (the common single-account setup stays zero-friction)
provider omitted,
multiple accounts   → validation_error listing the configured provider IDs —
                      "whichever account sorts first" is not a thing a caller can mean
```

This needs one small service addition: `listProviders(): string[]` (the `accounts` map
keys), since `resolveAccount` only accepts the combined `provider/name` form.

**`update_calendar` and `delete_calendar` take the usual required `calendar`
parameter** (provider-prefixed ID), resolved through the existing `resolveAccount` /
`findCalendar` path. No defaults: same rule as card-mcp's write tools — the target is
required.

### Creating a calendar

Unlike address books (extended MKCOL), CalDAV has a dedicated verb: `MKCALENDAR`.
The resourcetype is implied by the method, and RFC 4791 §5.3.1 makes the request
atomic — if any property in the body is refused, the calendar is not created — so
display name, description, and color all ride in the one request:

```
MKCALENDAR <homeUrl><slug>/
<cal:mkcalendar xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"
                xmlns:ical="http://apple.com/ns/ical/">
  <d:set><d:prop>
    <d:displayname>Work</d:displayname>
    <cal:calendar-description>…</cal:calendar-description>   <!-- when given -->
    <ical:calendar-color>#3B82F6</ical:calendar-color>       <!-- when given -->
  </d:prop></d:set>
</cal:mkcalendar>
```

The request goes through `client.davRequest()` directly, with the namespace
declarations as `_attributes` on the root element — the pattern card-mcp's
`createAddressBook` established. tsdav's own `makeCalendar` exists but is not used;
see *Alternatives considered*.

**Color** is the `ical:calendar-color` property in Apple's `http://apple.com/ns/ical/`
namespace — the same property tsdav's `fetchCalendars` already reads back as
`calendarColor`, which is what populates `list_calendars`' `color` field today, so a
created color is immediately visible through the existing read path. Input is
validated as `#RRGGBB` or `#RRGGBBAA` (Apple clients write the 8-digit form) and
passed through verbatim.

**URL derivation** is identical to card-mcp: `client.account.homeUrl` (the
calendar-home-set, populated by `login()`) plus a slug plus `/`. The slug is derived
from the display name — lowercased, non-alphanumerics collapsed to `-` — with an
optional explicit `slug` parameter (validated `^[a-z0-9][a-z0-9-]{0,62}$`). Explicit
slugs that collide are refused; derived slugs that collide with a *differently named*
calendar are suffixed `-2`, `-3`, ….

**Duplicate display names are refused, not suffixed** — per provider,
case-insensitively. This matters more here than in card-mcp: the display name is not
merely a convenience alias, it is the second half of `calendar_id` itself, and
`findCalendar` resolves every event operation by exact display-name match. A second
"Work" on the same provider would make `mailbox/Work` ambiguous on **every subsequent
call**. The same reasoning as card-mcp — plus it keeps a retried create from minting
duplicates. An empty or whitespace-only `display_name` is refused for the same
reason: a calendar with no name cannot be addressed by ID at all.

**Provider support varies.** Baikal, Radicale, Nextcloud, SOGo (mailbox.org),
Fastmail, and iCloud implement MKCALENDAR; Google's CalDAV endpoint does not. A
`403`/`405`/`501` maps to a plain-language "this provider does not allow creating
calendars here" rather than a bare status code.

On success the per-provider `calendarsCache` entry is invalidated so the next
`findCalendar` sees the new collection.

### Updating calendar metadata

`PROPPATCH` on the calendar URL with `<d:propertyupdate><d:set><d:prop>` carrying any
of `d:displayname`, `cal:calendar-description`, `ical:calendar-color`. At least one of
the three must be given; an empty update is rejected as `validation_error`, not sent as
a no-op round trip.

Two renames-are-identity consequences, both unique to cal-mcp:

1. **The calendar_id changes.** Renaming `mailbox/Work` to "Team" makes the calendar
   `mailbox/Team`; the old ID stops resolving. The tool result therefore returns the
   **new** `calendar_id`, and the tool description says plainly that renaming changes
   the calendar's ID.
2. **Caches keyed by calendar_id must follow.** The service invalidates the provider's
   `calendarsCache`; the persistent UID→URL cache gets a new
   `moveCachedCalendar(oldId, newId)` helper in `urlCache.ts` that rekeys the
   calendar's entries (the object URLs themselves are unchanged by a PROPPATCH — only
   the key is stale). Correctness does not depend on this — `findCalendarObject`
   verifies UIDs after every fetch and falls back to a scan — but without the rekey a
   rename would silently throw away the cache that exists to avoid the 100-second
   full-calendar scans on Mailbox.org.

Renaming to a display name that already exists on that provider (case-insensitive,
self excluded) is refused with the same ambiguity rationale as create. Renaming does
**not** move the collection URL — display name and slug are allowed to drift, exactly
as in every CalDAV client.

Updates to a calendar `list_calendars` reports as `read_only` will be refused by the
server; the 403 maps to an error saying the calendar may be read-only. No client-side
pre-check — the server is the authority.

### Deleting a calendar

Plain `DELETE` on the collection URL (`client.deleteObject`), destroying every event in
it. Following `delete_address_book`:

- The calendar is resolved **and its objects counted** before the confirmation gate,
  so the prompt names what is being destroyed: *"Permanently delete calendar "Work"
  on provider "mailbox" (<url>) and all 214 events in it? This cannot be undone."*
  The count is a `PROPFIND` at `depth: 1` requesting only `d:getetag` — hrefs below
  the collection, no ICS bodies transferred. It counts calendar *objects* (a whole
  recurring series is one object), which is the honest unit here. Count failures are
  non-fatal: the prompt falls back to "and every event in it".
- The gate is `confirmDestructive` with a distinct `confirm_delete_calendar` action
  (`PIM_MCP_CONFIRM=off` bypasses, as everywhere). The confirmed retry re-enters the
  handler and re-resolves + re-counts — two cheap requests, accepted for a stateless
  handler, same trade as card-mcp.
- On success: invalidate the provider's `calendarsCache` and purge the calendar's
  UID→URL entries via a new `purgeCachedCalendar(calendarId)` in `urlCache.ts`.

The server-instructions string in `main.ts` gains a sentence noting that
`delete_calendar`, like `delete_event`, asks the user to confirm.

### Response validation — shared with card-mcp via pim-core

card-mcp's #64 established, at some cost, that tsdav's collection-level responses
cannot be trusted shallowly: `ok` is `!responseBody.error` (so a 207 wrapping a failed
propstat reports `ok: true`), and a propstat-level PROPPATCH failure leaves the mapped
`status` at the transport's 207 with the real statuses surviving only under `raw`. Its
`checkCollectionResponse` + `propstatStatusLines` walk the raw propstat statuses and
refuse to treat an unreadable 207 as success.

cal-mcp needs exactly this logic for all three verbs. Rather than duplicating ~100
subtle lines that exist specifically to distrust a dependency — the kind of code that
drifts — the helper moves to the shared core:

- New `packages/core/src/dav.ts` exporting `checkDavCollectionResponse(response,
  action, url, opts)` and the `propstatStatusLines` walker. It inspects plain response
  objects only — core takes no tsdav dependency.
- Resource-specific wording is parameterized: `opts` carries the resource noun
  ("calendar" / "address book") and a `notFound: (url) => PimError` factory, so
  card-mcp keeps `ADDRESSBOOK_NOT_FOUND` and cal-mcp gets `CALENDAR_NOT_FOUND`. All
  other mappings (create-405 "already exists", create-403/501 "provider does not
  allow", 403 "may be read-only", create-404 "parent collection does not exist",
  no-status and unreadable-207 refusals) transfer unchanged.
- card-mcp's private copy is replaced by the shared helper as a follow-up patch
  release — mechanical, not a blocker for this work.

The status→error table is the card-mcp one, with the noun swapped:

| Status | Error |
|--------|-------|
| 403, 405, 501 (create) | `OPERATION_FAILED` — provider does not allow creating calendars here |
| 405 (create, collection exists) | `OPERATION_FAILED` — a collection already exists at that URL |
| 403 (update/delete) | `OPERATION_FAILED` — server refused; the calendar may be read-only |
| 404 | `CALENDAR_NOT_FOUND` |
| other non-2xx | `OPERATION_FAILED` with status and statusText |

## Input and output shapes

cal-mcp's argument convention is snake_case (`detail_level`, `all_day`), so unlike
card-mcp these tools take `display_name`, not `displayName`.

```ts
// create_calendar
{ provider?: string; display_name: string; color?: string;
  description?: string; slug?: string }

// update_calendar — at least one of display_name / color / description
{ calendar: string; display_name?: string; color?: string; description?: string }

// delete_calendar
{ calendar: string }
```

One shared valibot output schema in `calendarSchemas.ts`:

```ts
// calendarWriteResultSchema
{
  status: "created" | "updated" | "deleted";
  calendar_id: string;      // post-operation ID: reflects a rename
  url: string;
  display_name?: string;
}
```

`calendar_id` in every result is immediately usable by every other tool — for
`update_calendar` that means the *new* ID after a rename.

## Implementation layout

| Layer | Change |
|-------|--------|
| `core/src/dav.ts` (new) | `checkDavCollectionResponse`, `propstatStatusLines`; unit tests ported from card-mcp's response-checking tests |
| `cal-mcp/src/services/CalDavService.ts` | `listProviders()`, `createCalendar()`, `updateCalendarMeta()`, `deleteCalendar()`, private object-count helper; cache invalidation |
| `cal-mcp/src/services/urlCache.ts` | `moveCachedCalendar(oldId, newId)`, `purgeCachedCalendar(calendarId)` |
| `cal-mcp/src/tools/calendarManagementTools.ts` (new) | The three `ToolDef`s, mirroring `addressBookTools.ts` |
| `cal-mcp/src/tools/calendarSchemas.ts` | `calendarWriteResultSchema` |
| `cal-mcp/src/main.ts` | Register `[...CALENDAR_TOOLS, ...CALENDAR_MANAGEMENT_TOOLS]`; extend `instructions` |

Tests (TDD, per repo convention):

- **`CalDavService.test.ts`** (`vi.mock("tsdav")`): MKCALENDAR body shape including
  namespace `_attributes`; slug derivation, explicit-slug collision refusal, suffixing;
  duplicate-display-name refusal (create and rename, case-insensitive); PROPPATCH body;
  missing `homeUrl`; provider resolution including the multi-account-no-default error;
  cache invalidation and urlCache rekey/purge on rename/delete; 207-with-failed-propstat
  detected as failure; 403/405/501 mappings.
- **`calendarManagementTools.test.ts`** (via `dispatchTool`): validation errors (empty
  `display_name`, bad slug, bad color, empty update); `delete_calendar` gate interrupt
  and confirmed path; result shapes against `calendarWriteResultSchema`.
- **`roundtrip.test.ts`**: the three tools advertised with schemas on both protocol
  eras; `delete_calendar` confirmation round trip driven through a real client over
  `InMemoryTransport`.
- **`core/src/__tests__/dav.test.ts`**: the response-judging matrix.

## Delivery

Single PR touching both packages (the release flow publishes `pim-core` ahead of the
MCP servers automatically):

- `@miguelarios/pim-core` 0.8.0 → **0.9.0** — new `dav` module. Changelog entry.
- `@miguelarios/cal-mcp` 0.12.0 → **0.13.0** — three new tools; dependency bump to
  `^0.9.0`. Changelog entry closing #43/#44/#45.
- Docs: `docs/tools/cal-mcp.md` gains the three tool sections (and its stale "11
  tools" header becomes 15); root `README.md` "Calendar (12 tools)" → 15; `CLAUDE.md`
  cal-mcp line 11 → 15 tools.

Follow-up (separate, mechanical): card-mcp patch release swapping its private
`checkCollectionResponse` for the shared core helper.

## Alternatives considered

**tsdav's `client.makeCalendar()` instead of a direct `davRequest`.** It does issue a
correct MKCALENDAR with root-level `_attributes` (it is the pattern card-mcp copied).
Rejected anyway: its namespace set is fixed — no `http://apple.com/ns/ical/`
declaration, so a color property cannot ride in the create — and its return value
feeds the same untrustworthy response shapes, so the checking work is owed either way.
Going through `davRequest` keeps both servers on one collection-request idiom.

**Create with `MKCALENDAR` minimal, then PROPPATCH the color.** Two round trips and a
partial-failure state (calendar exists, color didn't apply) in exchange for nothing —
MKCALENDAR's atomicity is strictly better. Rejected.

**Suffix duplicate display names (`Work (2)`).** Rejected for the same reason as
card-mcp, with more force: here the display name *is* the calendar's address, and a
mutated name hands the caller a different ID than they asked for, observable only by
re-listing.

**A required `provider` argument on `create_calendar`.** Strictly explicit, but it
taxes the overwhelmingly common single-account configuration with an argument that has
exactly one valid value. The chosen rule (default only when unambiguous, refuse with
the list of providers otherwise) is the same shape `resolveAccount` errors already
take. 

**Duplicating `checkCollectionResponse` into cal-mcp, leaving core untouched.**
Smaller blast radius — no core release, one package changed, and it is what the
card-mcp design chose at the time (when there was only one consumer). Rejected now
that there are two: this is distrust-a-dependency logic whose subtlety is the point,
and two hand-maintained copies of it is how one server quietly stops catching refused
PROPPATCHes.

**Pre-checking `read_only` before update/delete.** The privilege PROPFIND
(`fetchPrivileges`) defaults to "writable" on any error, so a pre-check would add a
round trip without being able to say no reliably. The server's 403 is the authority;
it maps to a message that mentions read-onlyness.

## Out of scope

- Calendar timezone, `calendar-order`, and read-only-flag property management — #46.
- Sharing / ACLs — #47.
- Multi-calendar filtering on the read tools — #49 (largely served already).
- Clearing a property (e.g. removing a color via `d:remove`) — set-only for now,
  matching card-mcp.
- Moving events between providers, default-calendar designation, and
  `supported-calendar-component-set` restrictions (servers' defaults stand).
