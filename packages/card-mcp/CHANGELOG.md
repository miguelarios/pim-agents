# Changelog

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
