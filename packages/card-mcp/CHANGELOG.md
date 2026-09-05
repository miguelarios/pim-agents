# Changelog

## 0.9.0 (2026-09-05)

- **Every book is searched when none is named.** `list_contacts`, `get_contact` and
  `resolve_contact` used to default to the first address book, so a name filed in `Work`
  went missing whenever `Personal` sorted first. Each returned contact now carries an
  `addressBook` label (display name, or URL for a nameless book) that can be passed back
  to any contact tool. `update_contact` and `delete_contact` on an unqualified UID locate
  the contact's book first via the new `CardDavService.locateContact`, and refuse to guess
  when two books hold the same UID; a single-book account skips the lookup.
  `create_contact` keeps the first-book default: a new contact has to land somewhere.

## 0.8.0 (2026-09-05)

- **`update_contact` can clear a field.** Absent keeps the stored value, `null` clears it,
  a value replaces it. Before this a stale phone or note could not be removed short of
  deleting and recreating the contact. Multi-valued fields that are required on `Contact`
  (`emails`, `phones`, `addresses`, `urls`) clear to an empty list; everything else is
  dropped from the card. `fullName` is not nullable — `FN` is required by every vCard
  version.
- `create_contact` and `update_contact` accept `middleName`, `namePrefix`, `nameSuffix`,
  `orgUnits` and `socialProfiles`, which the parser already round-tripped but no tool
  could write.
- Requires `@miguelarios/pim-core` 0.9.1, which keeps `orgUnits` on the card when
  `organization` is cleared.

## 0.7.0 (2026-08-29)

- `move_contacts` — move contacts to another address book (#58). Issues a DAV `MOVE` per
  contact, which is atomic: a create-then-delete pair failing between its two steps would
  leave the contact in both books, the one state a move exists to avoid. `Overwrite: F`
  keeps it from clobbering a contact already filed under that name in the target. Each
  contact keeps its UID — a moved contact is the same person, filed somewhere else.
- `copy_contacts` — copy contacts into another address book, leaving the originals in place
  (#59). Each copy is a new vCard and gets a **new UID**, returned as `newUid`: two vCards
  sharing a UID inside one account is a sync hazard, since servers and clients key on UID
  and can silently merge the pair or drop one of them.
- Both take a batch of UIDs and read the source book once for the whole batch — the
  per-contact lookup scans every vCard in the book, so a per-call form would re-read the
  entire book once per contact. A batch can partly succeed, so the result reports per
  contact (`transferred[]`, plus `failed[]` when something did not make it) rather than
  failing whole on one unknown UID.
- Both require *both* address books, unlike the single-contact tools' optional
  `addressBook`: moving out of whichever book happened to sort first is not a thing a caller
  can mean. Either end accepts a display name or a URL, and transferring into the source
  book is refused.
- Neither asks for confirmation. A move relocates and a copy adds; nothing is destroyed.

## 0.6.1 (2026-08-29)

- Collection-level DAV responses (MKCOL, PROPPATCH, DELETE) are now judged by
  `checkDavCollectionResponse` from `@miguelarios/pim-core` instead of a private copy of the
  same logic. Behaviour and error messages are unchanged — the existing tests pass untouched —
  but the code that exists to distrust tsdav's response shapes (`ok` is `!responseBody.error`,
  and a propstat-level PROPPATCH failure leaves the mapped `status` at the transport's 207)
  now has one implementation shared with cal-mcp rather than two to keep in step (#71).

## 0.6.0 (2026-08-24)

- Four address book management tools: `list_address_books` (metadata plus opt-in per-book
  contact counts), `create_address_book` (extended MKCOL; refuses duplicate display
  names), `rename_address_book` (PROPPATCH displayname/description), and
  `delete_address_book` (destroys the book and its contacts; asks for confirmation with
  the book's name and contact count) (#54, #55, #56, #57).
- Every `addressBook` parameter now accepts a display name (e.g. `Work`) as well as a
  URL. Names match exactly, case-insensitively; an unknown name fails listing the known
  names, and a duplicated name fails listing the matching URLs.
- Collection-level DAV responses are judged on numeric statuses including the raw
  propstat statuses — never on tsdav's `ok`, which reports `true` for a 207 wrapping a
  failed propstat.

## 0.5.0 (2026-08-07)

_Backfilled — this release shipped without a changelog section._

- Adopted MCP protocol revision 2026-07-28 (`@modelcontextprotocol/server` v2): tool
  titles, all four behaviour annotations, output schemas with validated
  `structuredContent`, while still serving 2025-era clients from the same definitions.
- `delete_contact` now asks the user to confirm via the spec's multi round-trip request
  pattern (`PIM_MCP_CONFIRM=off` bypasses it).

## 0.4.0 (2026-07-10)

- **BREAKING (behavioral):** `update_contact` no longer silently drops `PHOTO`, structured-name parts, `ORG` units, and social-profile fields on update — this is strictly a fix, but `Contact` payloads now include previously-missing fields such as `middleName` and `orgUnits` that callers should expect to see (PR #5, `fix/contact-roundtrip`).
- `update`/`delete` operations now surface the underlying HTTP error instead of failing silently; the CardDAV client resets itself after a failed login instead of getting stuck (PR #6, `fix/carddav-http-errors`).
- `delete_contact` now declares `destructiveHint: true` and read-only tools declare `readOnlyHint: true`, so MCP clients can gate destructive calls (PR #12, `fix/email-security`, tool-annotations sweep).
- The MCP `Server` constructor now reads its version from `package.json` at runtime instead of a stale hardcoded string (was `0.1.0`), so it can't drift from the real package version again (PR #3, `chore/hygiene-sweep`).
- Corrected the `@miguelarios/pim-core` dependency range to match the version actually required (PR #3, `chore/hygiene-sweep`).
- Bumped `@miguelarios/pim-core` dependency to `^0.7.0`.

Earlier releases: see git tags and docs/superpowers/specs/.
