# Changelog

## 0.14.0 (2026-09-16)

- `get_email` and `search_emails` now report attachments that carry `Content-Disposition: inline` with a filename. Apple Mail (iOS and macOS) writes forwarded file attachments that way, so a forwarded message with a real PDF attached previously reported `hasAttachments: false` and an empty `attachments` array — the part was in the MIME source the whole time, and `download_attachment` retrieved it correctly when given the `partId` by hand. Content-ID distinguishes the two inline cases: an image the HTML body references carries one, a forwarded file does not, so embedded signature logos are still not listed as attachments (PR #107, `claude/exciting-wozniak-55ly2k`).
- `search_emails` no longer turns a blank filter into a constraint that matches nothing. `from: ""` became a literal `SEARCH FROM ""`, and `since: ""` became `new Date("")` — an Invalid Date that serializes to `null` — so a search could return zero results for a folder that demonstrably had messages. Blank and whitespace-only values are now discarded for `from`, `to`, `cc`, `bcc`, `subject`, `body`, `hasWords`, `since` and `before`, real values are trimmed, and blank entries are dropped from `tags` (PR #108, `claude/exciting-wozniak-55ly2k-search-defaults`).
- An unparseable `since` or `before` is now rejected with `VALIDATION_FAILED` naming the field, instead of silently producing an empty result set. The throw happens before the IMAP connection is opened (PR #108, `claude/exciting-wozniak-55ly2k-search-defaults`).
- The `unread`, `flagged` and `hasAttachment` descriptions now state their semantics explicitly: `true` and `false` are both real filters, omission means "match both", and `hasAttachment: false` is not a filter at all since IMAP cannot express it. The booleans themselves are deliberately unchanged — `unread: false` ("read mail") and `flagged: false` ("unflagged mail") are legitimate queries, so a `false` is honoured rather than discarded (PR #108, `claude/exciting-wozniak-55ly2k-search-defaults`).

## 0.13.0 (2026-09-15)

- Attachments and message sources are now addressable as MCP resources, so a client can fetch the bytes with `resources/read` instead of only ever receiving them inline in a tool result: `imap://{folder}/{uid}/{partId}` serves one attachment under its own media type, `imap://{folder}/{uid}.eml` serves the raw RFC 822 source. `download_attachment` and `get_email_raw` already stamped these URIs onto the blocks they returned, but nothing could resolve one (PR #102, `claude/laughing-euler-nko3sh`).
- **BREAKING:** `download_attachment` and `get_email_raw` no longer embed a payload over 256 KiB. Above the limit they return a `resource_link` plus a note naming the size, the limit and the URI, and the bytes stay reachable via `resources/read`. A caller that unconditionally reads `content[0].resource.blob` must now check `structuredContent.embedded` first. Previously there was no ceiling at all: an 8 MB PDF became ~10.7 MB of base64 in one tool result, which most clients put straight into the model's context, so the call failed downstream after the bytes had already been pulled off the IMAP server (PR #103, `claude/laughing-euler-nko3sh-size-guard`).
- `EMAIL_MAX_INLINE_BYTES` overrides that ceiling; `0` links everything, and an unparseable value falls back to the default rather than disabling the guard. The default matches the 256 KiB `MAX_INLINE_CALENDAR_BYTES` that has guarded calendar parts since 0.12.0 (PR #103, `claude/laughing-euler-nko3sh-size-guard`).
- `download_attachment` and `get_email_raw` output gained `uri` and `embedded`, so a caller can tell which path it got without inspecting content blocks (PR #103, `claude/laughing-euler-nko3sh-size-guard`).
- Oversized payloads are no longer fetched, only to be discarded: attachment size comes from BODYSTRUCTURE before the body is read, and message size from RFC822.SIZE in a single FETCH. A server that withholds either is still held to the ceiling, after the fetch rather than before it (PR #103, `claude/laughing-euler-nko3sh-size-guard`).
- `send_email` attachments accept `encoding: "base64" | "utf8"` and `contentType`. `content` is a JSON string and was read as UTF-8, so binary could not be attached through it at all — the only working path for a real file was `attachments[].path`, which requires `EMAIL_ATTACHMENT_DIR`. Downloading an attachment and sending it back out now works without a directory on the server. Invalid base64 is rejected rather than attached, since `Buffer.from(s, "base64")` discards anything outside the alphabet and would otherwise deliver a silently corrupt file (PR #104, `claude/laughing-euler-nko3sh`).
- Attachment errors on `send_email` now report `INVALID_INPUT` and are raised before the send confirmation, instead of `INTERNAL_ERROR` after the user had already confirmed an irreversible send. This also corrects the pre-existing `EMAIL_ATTACHMENT_DIR` path rejection, which had both problems (PR #104, `claude/laughing-euler-nko3sh`).
- Bumped `@miguelarios/pim-core` dependency to `^0.10.0`.

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
