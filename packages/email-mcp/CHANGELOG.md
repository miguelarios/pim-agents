# Changelog

## 0.12.0 (2026-08-10)

- `get_email` now detects `text/calendar` MIME parts regardless of content disposition or filename, so inline calendar invitations are no longer omitted from responses (PR #19, `claude/feature-planning-xexlsc`).
- Added `calendarParts` to the `get_email` output: MIME part ID, content type, iTIP method (uppercased), filename when present, and decoded iCalendar content (base64/quoted-printable handled, charset parameter honored). Content is inlined up to 256 KiB; larger parts set `truncated: true` and remain downloadable via `download_attachment` (PR #19, `claude/feature-planning-xexlsc`).
- `hasAttachments` in `get_email` and `search_emails` now counts inline calendar parts, and such parts are listed in `attachments` with a working `partId` (PR #19, `claude/feature-planning-xexlsc`).

## 0.11.0 (2026-08-07)

- Adopted MCP spec revision 2026-07-28: migrated from `@modelcontextprotocol/sdk` to `@modelcontextprotocol/server` v2 (`McpServer` + `registerTools` + `serveStdio`); 2025-era clients are still served from the same tool definitions (PR #15, `claude/mcp-spec-improvements-m9bqli`).
- Tool arguments are now validated against the declared input schemas before handlers run, and every tool declares a title, all four behaviour annotations, and an `outputSchema` with validated `structuredContent` (PR #15, `claude/mcp-spec-improvements-m9bqli`).
- Irreversible operations (`send_email` when actually sending, `send_draft`, `delete_email` with `permanent`) now confirm via the spec's multi round-trip request pattern; `PIM_MCP_CONFIRM=off` bypasses it for headless use (PR #15, `claude/mcp-spec-improvements-m9bqli`).
- `download_attachment` no longer duplicates the base64 payload in `structuredContent` — the bytes ride only in the embedded resource block (PR #15, `claude/mcp-spec-improvements-m9bqli`).
- `send_email`/`create_draft` may set a visible `From` address when explicitly allowed via server configuration; documented `EMAIL_ATTACHMENT_DIR`, `URL_RESOLVE_DISABLE`, `SMTP_AUTO_SENT`, and the SPF/DKIM/DMARC alignment requirements for `SMTP_ALLOWED_FROM` (PR #2, `feat/email-shared-sender`).
- Added `src/__tests__/roundtrip.test.ts` driving a real MCP client over an in-memory transport on both protocol eras (PR #15, `claude/mcp-spec-improvements-m9bqli`).
- Bumped `@miguelarios/pim-core` dependency to `^0.8.0`.

## 0.10.0 (2026-07-10)

- **BREAKING:** attachment `partId` values now identify a MIME bodystructure part path instead of an array index — callers that cached or hardcoded a previous `partId` must re-fetch it via `get_email` before calling `download_attachment` (PR #10, `fix/email-attachments`).
- `get_email` now populates message flags (read/flagged/etc.) instead of leaving them empty (PR #10, `fix/email-attachments`).
- `delete_email` (non-permanent) resolves the trash folder via the IMAP special-use flag with fallbacks, instead of assuming a folder literally named `"Trash"` (PR #11, `fix/email-imap-correctness`).
- Bcc recipients are now preserved through the draft round-trip (`create_draft` → `send_draft`) without leaking a `Bcc` header to any recipient on the wire (PR #11, `fix/email-imap-correctness`).
- **BREAKING:** `attachments[].path` on `send_email`/`create_draft` now requires `EMAIL_ATTACHMENT_DIR` to be configured — arbitrary filesystem paths are rejected as an arbitrary-file-read guard (PR #12, `fix/email-security`).
- Markdown link resolution now blocks private/reserved IP targets (with an `URL_RESOLVE_DISABLE` escape hatch), closing an SSRF-style vector in `get_email` markdown conversion (PR #12, `fix/email-security`).
- `delete_email{permanent: true}` now declares `destructiveHint: true` and read-only tools declare `readOnlyHint: true` (PR #12, `fix/email-security`, tool-annotations sweep).
- Server declared a stale hardcoded version; the MCP `Server` constructor now reads its version from `package.json` at runtime (PR #3, `chore/hygiene-sweep`).
- Regenerated the package README from the current tool source (PR #3, `chore/hygiene-sweep`).
- Bumped `@miguelarios/pim-core` dependency to `^0.7.0`.

Earlier releases: see git tags and docs/superpowers/specs/.
