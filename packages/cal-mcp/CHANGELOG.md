# Changelog

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
