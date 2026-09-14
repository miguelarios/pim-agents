# Changelog

## 0.11.0 (2026-09-14)

- `truncateRecurrenceIcs(ics, occurrenceDate, allDay)` — ends a recurring series just before an occurrence: `UNTIL` replaces `COUNT` on the master `RRULE` (one second before for a timed series, the previous day as a `DATE` for an all-day one), and override VEVENTs, `RDATE`s and `EXDATE`s at or after the cut are removed while earlier ones are kept. Returns `null` when the cut is at or before the first occurrence, so a caller can delete the object instead of writing an empty series (cal-mcp #41, and the split half of #38).

## 0.10.1 (2026-09-14)

- `CATEGORIES` is written as one property with one value per category on every ICS write
  path (`generateEventIcs`, `updateMasterEventIcs`, `createExceptionComponent`). The names
  were joined with "," into a single value, which ical.js escaped as `\,`, so two categories
  written by cal-mcp read back as one `"Work,Sync"` category — in cal-mcp and in every
  other client. An empty list still removes the property.
- `createExceptionComponent` no longer drops reminders. An override VEVENT stands alone, so
  the master's `VALARM`s are now copied onto it; an explicit `alarms` override replaces them
  (and `[]` clears them). Before, editing a single occurrence with `update_event` silently
  lost its alarms, and an `alarms` override was ignored.
- `setCategories` and `setAlarms` (`ics/_shared.ts`) are the one place each of those is
  written now, so the three paths cannot drift again.

## 0.10.0 (2026-09-05)

- `Contact` gains `kind` (`"group"` for a contact group, unset for an individual) and
  `members` (member UIDs). `parseVCard` reads RFC 6350 `KIND:group` / `MEMBER:urn:uuid:…`
  and Apple's vCard 3.0 `X-ADDRESSBOOKSERVER-KIND` / `X-ADDRESSBOOKSERVER-MEMBER` forms,
  stripping the `urn:uuid:` prefix and keeping any other URI scheme verbatim. `buildVCard`
  writes the `X-ADDRESSBOOKSERVER-*` form, since the builder emits `VERSION:3.0` and that
  is the form Apple, iCloud and SabreDAV-based servers read. On a group, none of the four
  properties land in `otherProperties`; any other `KIND` (`org`, `location`, an explicit
  `individual`) and any `MEMBER` on a non-group stay raw there, as before (issue #60).
- `isGroup(contact)` — the one place "is this a group" is decided.

## 0.9.1 (2026-09-05)

- `buildVCard` writes the `ORG` line when either `organization` or `orgUnits` is set, with
  an empty first component when only the units are. It was gated on `organization` alone,
  so clearing the company silently dropped the department on the next round trip, and a
  contact created with units but no company lost them on first save.

## 0.9.0 (2026-08-28)

- `checkDavCollectionResponse` and `propstatStatusLines` (`dav.ts`) — shared judging of DAV collection-level responses (MKCALENDAR, extended MKCOL, PROPPATCH, DELETE). Extracted from card-mcp so both DAV servers distrust tsdav's response shapes the same way: `ok` is `!responseBody.error`, and a propstat-level PROPPATCH failure leaves the mapped `status` at the transport's 207, so a refused rename reads as success unless the raw propstat statuses are walked. Resource wording and the not-found error are supplied by the caller, so each server keeps its own vocabulary (issues #43, #44, #45).

## 0.7.0 (2026-07-10)

- RFC 6350 vCard value escaping/unescaping — commas, semicolons, backslashes, and newlines in `N`/`ADR`/`NOTE` fields are now correctly escaped on write and unescaped on read (PR #4, `fix/vcard-escaping`).
- `vcard.ts` preserves `PHOTO`, structured-name parts, `ORG` units, and social-profile fields through parse/serialize round-trips, fixing silent data loss that card-mcp's update path relied on (PR #5, `fix/contact-roundtrip`).
- `updateMasterEventIcs` — targeted master `VEVENT` mutation that preserves `RRULE`, `EXDATE`, and recurrence overrides instead of regenerating the whole ICS on update (PR #7, `fix/cal-master-update`).
- Timezone helpers (`timezone.ts`) resolve preferred-hour boundaries against `PIM_TIMEZONE` instead of the host's local zone (PR #8, `fix/cal-timezones`).
- `splitIcsByUid` — splits a multi-`VEVENT` ICS payload into one object per UID per RFC 4791 (PR #9, `fix/cal-import-and-exceptions`).
- `removeExceptionFromIcs` and ICS component handling now match recurrence overrides via `ical.js`, including TZID-form `RECURRENCE-ID` values (PR #9, `fix/cal-import-and-exceptions`).

Earlier releases: see git tags and docs/superpowers/specs/.
