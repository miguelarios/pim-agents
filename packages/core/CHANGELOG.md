# Changelog

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
