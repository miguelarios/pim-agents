# Changelog

## 0.14.0 (2026-09-14)

- `generateVTimezoneIcs(tzid)` — the bundled `VTIMEZONE` for an IANA zone wrapped in a `VCALENDAR`, the shape CalDAV's `calendar-timezone` property carries; `null` for an unknown zone (cal-mcp #46).

## 0.13.0 (2026-09-14)

- `parseIcsFreeBusy(ics)` and the `FreeBusyPeriod` / `FreeBusyType` types — reads the `FREEBUSY` periods out of a `VFREEBUSY` reply (a CalDAV `free-busy-query` REPORT or an iTIP reply), resolving `start/duration` forms to ends, mapping `FBTYPE` to `busy` / `tentative` / `unavailable` (unknown and x-name types count as busy, per RFC 5545) and dropping `FREE` periods (cal-mcp #48).

## 0.12.1 (2026-09-14)

- `updateMasterEventIcs` moves a series' `EXDATE` and `RDATE` values and its overrides' `RECURRENCE-ID`s by the same delta as `DTSTART` when `start` changes. They were left at the old times, where they matched nothing: moving a series from 10:00 to 11:00 silently resurrected every cancelled occurrence, left every added occurrence pinned at the old slot, and detached every per-occurrence edit (cal-mcp #40). Zoned values shift in wall-clock terms, so exclusions stay at the same local hour across a DST change; `DATE` values shift by whole days.
- `combineIcsComponents` removes an `EXDATE` that names the occurrence an override is being added for, since RFC 5545 §3.8.5.1 excludes the instance outright and the override would otherwise never show. Editing a cancelled occurrence with `update_event span: "this"` now brings it back; only the matching value of a multi-value `EXDATE` is dropped.
- Tests now cover TZID-form, UTC-form and comma-separated multi-value `EXDATE`s through expansion, `addExdateToIcs` idempotency and plain edits.

## 0.12.0 (2026-09-14)

- `splitRecurrenceIcs(ics, occurrenceDate, allDay, newUid)` — splits a recurring series at an occurrence into `before` (the original ended just before it, via `truncateRecurrenceIcs`) and `after` (a copy of the master under `newUid`, starting at the occurrence, with a `COUNT` reduced by the instances already consumed, later `EXDATE`/`RDATE` values kept and earlier ones dropped, `SEQUENCE` reset, and no overrides), plus `droppedOverrides`, the number of overrides at or after the cut that neither half keeps. Returns `null` at or before the first occurrence, and throws when the date is not an occurrence the series generates — a rule instance or an `RDATE` (cal-mcp #38).

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
