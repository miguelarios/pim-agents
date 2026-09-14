# Changelog

## 0.16.0 (2026-09-14)

- `delete_event` accepts `span: "future"`: deletes the given occurrence of a recurring event and every later one, keeping earlier occurrences and their overrides (#41). The master `RRULE` gets `UNTIL` set to just before the occurrence (replacing any `COUNT`), and overrides, `RDATE`s and `EXDATE`s past the cut are dropped. Cutting at the first occurrence deletes the object outright rather than leaving an empty series. Gated on confirmation like a full delete, since the removed occurrences cannot be recovered.
- Bumped `@miguelarios/pim-core` dependency to `^0.11.0` for `truncateRecurrenceIcs`.

## 0.15.0 (2026-09-14)

- `get_event` takes an optional `occurrence_date` and returns that one occurrence of a recurring event instead of the master series (#39). A modified occurrence (an override `VEVENT` with a matching `RECURRENCE-ID`) comes back with its own time and fields, exactly as `list_events` expands it; an ordinary occurrence comes back at its own slot with the master's fields. Passing it on a non-recurring event is a `validation_error`, and a date the rule never generates is `not_found`, so a stale `occurrence_date` cannot silently hand back the master.

## 0.14.0 (2026-09-14)

- `list_events`, `get_today_events` and `search_events` take a `calendars` array, so a query can be limited to a chosen set of calendars instead of one or all of them (#49). The existing single `calendar` still works; when both are given the sets are unioned, so a caller gets exactly the calendars it named. The named calendars are queried in parallel without a `list_calendars` round trip, and an unknown ID is reported as `not_found` rather than silently skipped.

## 0.13.0 (2026-08-28)

- `create_calendar` — create a calendar collection with `MKCALENDAR` (RFC 4791 §5.3.1). Display name, description, and colour ride in the one atomic request, so a refused property cannot leave a half-configured calendar behind. On multi-provider setups `provider` names the account to create on; it defaults only when a single account is configured, and is refused with the list of provider IDs otherwise rather than guessed (#43).
- `update_calendar` — change a calendar's display name, colour, and/or description via `PROPPATCH` (#44). Renaming changes the calendar's ID, since `calendar_id` is `provider/DisplayName`: the new ID comes back in the result, and the persistent UID→URL cache is rekeyed onto it instead of being stranded under a name nothing looks up again.
- `delete_calendar` — delete a calendar and every event in it, gated on `confirmDestructive` like `delete_event`. The calendar is resolved and its objects counted before the prompt is built, so the confirmation names what is about to be destroyed ("...and all 214 events in it") rather than echoing back the caller's own string (#45).
- Duplicate display names are refused per provider, on create and on rename. The display name is half of every `calendar_id` and `findCalendar` resolves each event operation by exact match, so a second "Work" on one provider would make `mailbox/Work` ambiguous on every subsequent call.
- Calendar colours are read and written as Apple's `calendar-color`, the same property `list_calendars` already reports, and validated as `#RRGGBB` or `#RRGGBBAA`.
- Bumped `@miguelarios/pim-core` dependency to `^0.9.0` for the shared DAV collection response checking.

## 0.11.0 (2026-07-10)

- `update_event` now mutates the master `VEVENT` in place instead of regenerating the ICS body — `RRULE`, recurrence overrides, and attendee `PARTSTAT` no longer get destroyed by a plain title/time update (PR #7, `fix/cal-master-update`).
- `get_today_events` and `find_free_slots` preferred-hour boundaries now respect `PIM_TIMEZONE` instead of the host's local timezone (PR #8, `fix/cal-timezones`).
- `import_ics` splits multi-UID ICS files into one calendar object per UID, per RFC 4791, instead of writing a single malformed object (PR #9, `fix/cal-import-and-exceptions`).
- Removing a recurrence override now matches occurrences via `ical.js`, including TZID-form `RECURRENCE-ID` values, instead of a brittle string match (PR #9, `fix/cal-import-and-exceptions`).
- Server declared version 0.3.0 while shipping 0.10.0's feature set; the MCP `Server` constructor now reads its version from `package.json` at runtime so it can't drift again (PR #3, `chore/hygiene-sweep`).
- `delete_event` now declares `destructiveHint: true` and read-only tools declare `readOnlyHint: true` (PR #12, `fix/email-security`, tool-annotations sweep).
- Regenerated the package README from the current tool source; dropped the stale, unused `cal-mcp-tools.json` snapshot (PR #3, `chore/hygiene-sweep`).
- Bumped `@miguelarios/pim-core` dependency to `^0.7.0`.

Earlier releases: see git tags and docs/superpowers/specs/.
