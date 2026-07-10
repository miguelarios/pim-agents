# Changelog

## 0.7.0 (2026-07-10)

- RFC 6350 vCard value escaping/unescaping — commas, semicolons, backslashes, and newlines in `N`/`ADR`/`NOTE` fields are now correctly escaped on write and unescaped on read (PR #4, `fix/vcard-escaping`).
- `vcard.ts` preserves `PHOTO`, structured-name parts, `ORG` units, and social-profile fields through parse/serialize round-trips, fixing silent data loss that card-mcp's update path relied on (PR #5, `fix/contact-roundtrip`).
- `updateMasterEventIcs` — targeted master `VEVENT` mutation that preserves `RRULE`, `EXDATE`, and recurrence overrides instead of regenerating the whole ICS on update (PR #7, `fix/cal-master-update`).
- Timezone helpers (`timezone.ts`) resolve preferred-hour boundaries against `PIM_TIMEZONE` instead of the host's local zone (PR #8, `fix/cal-timezones`).
- `splitIcsByUid` — splits a multi-`VEVENT` ICS payload into one object per UID per RFC 4791 (PR #9, `fix/cal-import-and-exceptions`).
- `removeExceptionFromIcs` and ICS component handling now match recurrence overrides via `ical.js`, including TZID-form `RECURRENCE-ID` values (PR #9, `fix/cal-import-and-exceptions`).

Earlier releases: see git tags and docs/superpowers/specs/.
