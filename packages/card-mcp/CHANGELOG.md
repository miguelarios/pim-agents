# Changelog

## 0.4.0 (2026-07-10)

- **BREAKING (behavioral):** `update_contact` no longer silently drops `PHOTO`, structured-name parts, `ORG` units, and social-profile fields on update — this is strictly a fix, but `Contact` payloads now include previously-missing fields such as `middleName` and `orgUnits` that callers should expect to see (PR #5, `fix/contact-roundtrip`).
- `update`/`delete` operations now surface the underlying HTTP error instead of failing silently; the CardDAV client resets itself after a failed login instead of getting stuck (PR #6, `fix/carddav-http-errors`).
- `delete_contact` now declares `destructiveHint: true` and read-only tools declare `readOnlyHint: true`, so MCP clients can gate destructive calls (PR #12, `fix/email-security`, tool-annotations sweep).
- The MCP `Server` constructor now reads its version from `package.json` at runtime instead of a stale hardcoded string (was `0.1.0`), so it can't drift from the real package version again (PR #3, `chore/hygiene-sweep`).
- Corrected the `@miguelarios/pim-core` dependency range to match the version actually required (PR #3, `chore/hygiene-sweep`).
- Bumped `@miguelarios/pim-core` dependency to `^0.7.0`.

Earlier releases: see git tags and docs/superpowers/specs/.
