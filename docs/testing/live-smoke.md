# Live Smoke Test Guide

Manual verification matrix for the three MCP servers (`email`, `calendars`, `contacts`)
against real CalDAV/CardDAV/IMAP servers via `mcporter`. This complements the unit test
suite — it exercises real server quirks (timezone handling, RRULE preservation, IMAP
flag/bodystructure behavior) that mocks can't catch.

Run this after each release wave, once the new package versions are published and pinned
in `mcporter`. See `docs/superpowers/plans/2026-07-10-pim-hardening.md` (Task 11.2) for
the plan this guide implements.

## 1. Prerequisites

- `mcporter` configured with three servers: `email`, `calendars`, `contacts`. Credentials
  are env-interpolated from the shell profile (e.g. `~/.zshenv`) — **never** committed to
  this repo or pasted into a session transcript.
- Dedicated write targets that already exist and must not be recreated:
  - Calendars: `mailbox/PIM-Test` and `nextcloud/PIM-Test`
  - Contacts: the Nextcloud `PIM-Test` address book
  - Email: the mailbox's `PIM-Test` IMAP folder

**Rule:** reads may touch real data (real calendars, real contacts, the real inbox);
**writes go only to the PIM-Test targets above.** Test entities always use the canonical
synthetic identity — `Alice Smith` / `alice@example.com` / `+1-555-0100` — never a real
name, address, or phone number. `send_email` tests only ever target the account's own
address (self-addressed sends), never a third party.

## 2. Output hygiene

- Session transcripts, raw tool output, and any files downloaded during a smoke run
  (attachments, `.ics` exports, screenshots) stay out of the repo — treat the session as
  scratch space, not a place to accumulate artifacts.
- If a live run surfaces a server quirk worth preserving for regression coverage (an
  unusual `RECURRENCE-ID` form, a bodystructure shape, an escaping edge case), turn it
  into a **scrubbed** fixture + oracle pair under
  `packages/core/src/__tests__/ics/fixtures/`, following the existing convention there
  (`<name>.ics` input + `<name>.oracle.json` expected output, PII replaced with canonical
  synthetic data before it ever touches the working tree).
- Never paste real email addresses, real hostnames, or real filesystem paths into this
  doc or into a commit. Use `alice@example.com`, `example.com`, and `~/...` as stand-ins.

## 3. Calendar write matrix

Run the full sequence once against `mailbox/PIM-Test`, then again against
`nextcloud/PIM-Test` — provider-specific CalDAV quirks (timezone handling, RRULE
serialization) can differ between the two.

1. **Create** a timed event (title: synthetic, e.g. `"Smoke: timed event"`) → **get** it
   back → **update** the title only (default `span`) → confirm the update succeeded
   without requiring an `RRULE` on a non-recurring event.
2. **Create** a recurring weekly event with `recurrence_rule: "FREQ=WEEKLY;BYDAY=MO"` →
   **update** the title with `span: "all"` → **get** and verify `recurrence_rule` is
   still present and unchanged on the master event. This is the regression check for the
   `fix/cal-master-update` fix (PR #7) — the old behavior regenerated the ICS body on
   update and silently dropped `RRULE`/exception overrides.
3. On the same recurring event, **update one occurrence** with `span: "this"` plus an
   `occurrence_date` → **list** events across the range and verify the exception
   (recurrence override) is present with the updated title, and the other occurrences
   are unaffected.
4. **Delete one occurrence** with `span: "this"` on the same series → **list** again and
   verify the occurrence is gone (an `EXDATE` was added to the master) while the rest of
   the series remains.
5. **Import** a 2-UID `.ics` file via `import_ics` → verify it produces **two** separate
   calendar objects, not one malformed object or a silently dropped second event. This is
   the regression check for `fix/cal-import-and-exceptions` (PR #9, `splitIcsByUid`).
6. **Create** an all-day event → **get** it back → verify the all-day round-trip (date-only
   `DTSTART`/`DTEND`, no spurious time-of-day or timezone shift).
7. Call `find_free_slots` with `preferred_start: "09:00"` and verify the returned slot
   boundaries land on 9 AM **local** time, not shifted by the host's UTC offset. This is
   the regression check for `fix/cal-timezones` (PR #8, `PIM_TIMEZONE`-aware boundaries).
8. **Delete everything created** in steps 1–7 for this provider before moving to the next
   one, or before ending the session.

## 4. Contacts write matrix

Run against the Nextcloud `PIM-Test` address book. Pass the address book URL explicitly
on every call — `card-mcp` defaults to the first address book it finds, which may not be
`PIM-Test`.

1. **Create** a contact — `Alice Smith`, with a phone number (`+1-555-0100`), an email
   (`alice@example.com`), a postal address, and a note containing an embedded newline.
2. **Get** the contact back and verify the note round-trips with the newline intact
   (regression check for the `fix/vcard-escaping` fix, PR #4).
3. **Update** the contact, changing only the title/display name field.
4. **Get** the full contact again and verify every other field (phone, email, address,
   note) is byte-for-byte unchanged — nothing else should have moved. This is the
   regression check for `fix/contact-roundtrip` (PR #5): the old update path silently
   dropped `PHOTO`, structured-name parts, `ORG` units, and social-profile fields on any
   update.
5. **Create a second synthetic contact** (`Bob Jones` / `bob@example.com` /
   `+1-555-0101`) with a name that's ambiguous against the first (e.g. matching partial
   name token) → call `resolve_contact` and verify it surfaces the ambiguity (multiple
   candidates) rather than silently picking one.
6. **Delete both** synthetic contacts created in steps 1–5.
7. Separately: copy **one real iOS contact** into the `PIM-Test` book manually (outside
   the tool, e.g. via the Nextcloud UI or iOS contact sync), then **update** it through
   `card-mcp` (a trivial field change), then verify in the Nextcloud web UI that the
   contact's photo survived the update (regression check for PR #5's `PHOTO` preservation
   against a real-world vCard, not just a synthetic one). **Delete the copy** afterward —
   never leave a copy of a real contact sitting in the test book.

## 5. Email matrix

Uses the `PIM-Test` IMAP folder and self-addressed sends only — no email is ever sent to
a third party as part of this matrix.

1. `get_folder_status` on `PIM-Test` — sanity check that the folder is reachable and
   reports message counts.
2. `search_emails` with a distinctive subject token — confirm search returns the expected
   subset.
3. **Send** a self-addressed email (to the account's own address) with an attachment
   supplied via inline content (not a filesystem path).
4. `get_email` on the message just sent → verify **flags** are populated (not empty) —
   regression check for `fix/email-attachments` (PR #10). Note the attachment's `partId`.
5. `download_attachment` using that `partId` → verify it returns the actual attachment
   bytes, not an empty or mismatched payload — the other half of the PR #10 regression
   check (`partId` now identifies a bodystructure part path, not an array index that
   silently drifted).
6. **Create a draft** with a `bcc` recipient set to another alias on the same account →
   `send_draft` → verify the bcc recipient actually received the message, **and** verify
   the copy any visible recipient receives has **no** `Bcc` header present. Regression
   check for `fix/email-imap-correctness` (PR #11).
7. `delete_email` on a test message with `permanent: false` → verify the message lands in
   the server's actual trash folder (not silently dropped or misfiled under a
   hardcoded `"Trash"` name that doesn't exist on this server) — regression check for PR
   #11's special-use trash resolution.
8. Pick one real newsletter-style email already in the mailbox (read-only — do not modify
   it) and run markdown conversion (`get_email` with markdown format) on it. Verify the
   conversion completes without error and that any links pointing at private/reserved IP
   targets are left unresolved rather than resolved or causing a request to be made to
   them — regression check for `fix/email-security` (PR #12).
9. Clean up: delete any test messages created in steps 3–7 that are still present in
   `PIM-Test` or the account's trash, per the output-hygiene rule above.

## 6. mcporter invocation crib

Use function-call syntax with `--output json` for structured, parseable output:

```bash
mcporter call 'calendars.create_event(calendar: "mailbox/PIM-Test", title: "Smoke recurring", start: "2026-07-13T09:00:00", end: "2026-07-13T09:30:00", recurrence_rule: "FREQ=WEEKLY;BYDAY=MO")' --output json

mcporter call 'contacts.list_contacts(query: "Alice Smith", addressBook: "https://example.com/remote.php/dav/addressbooks/users/example/PIM-Test/")' --output json

mcporter call 'email.get_folder_status(folder: "PIM-Test")' --output json
```

General pattern: `mcporter call '<server>.<tool>(<arg>: <value>, ...)' --output json`.
Quote the whole call in single quotes so the shell doesn't interpret the parentheses;
use double-quoted string values inside. Timestamps are ISO 8601; omit the trailing `Z`
for provider-local times where a tool expects local time (e.g. `find_free_slots`
`preferred_start`).

## 7. Protocol conformance spot-checks

The servers speak MCP `2026-07-28` and also serve 2025-era clients. The
`src/__tests__/roundtrip.test.ts` suite in each package covers both eras against
mocked backends; these steps confirm the same behaviour against real ones.

- [ ] Client reports the negotiated version as `2026-07-28`. On a 2025-era host it
      should report a 2025 revision and still work — neither needs configuration.
- [ ] `tools/list` shows a `title`, an `outputSchema`, and all four annotations
      (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) on every
      tool, and repeats in the same order across two calls.
- [ ] A read tool (`list_contacts`, `list_events`, `search_emails`) returns
      `structuredContent` that validates against its advertised `outputSchema`.
- [ ] A bad argument (e.g. `get_email(uid: "abc")`) comes back as `isError: true`
      without reaching the backend.
- [ ] `delete_contact` on a throwaway PIM-Test contact prompts for confirmation.
      Declining leaves the contact intact; accepting deletes it.
- [ ] `send_email(saveToDrafts: true)` does **not** prompt; a real self-addressed
      send does.
- [ ] `delete_email(permanent: true)` prompts; a plain `delete_email` (Trash) does not.
- [ ] `download_attachment` returns the bytes as an embedded binary resource, and
      `get_email_raw` returns a `message/rfc822` resource.
