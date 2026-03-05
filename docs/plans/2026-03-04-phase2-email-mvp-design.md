# Phase 2: Email (IMAP/SMTP) MVP Design

**Date:** March 4, 2026
**Status:** Approved
**Scope:** `@miguelarios/email-mcp` — IMAP read/search/manage + SMTP send against Mailbox.org

---

## Tool Surface (10 tools)

| Tool | Description | Priority |
|------|------------|----------|
| `list_emails` | Search/filter emails by folder, sender, subject, date range, flags. Supports `from:`, `subject:`, `has:attachment`, `is:unread` query prefixes. Pagination via offset+limit. | Must Have |
| `get_email` | Fetch full email by UID — headers, text/HTML body, attachment metadata | Must Have |
| `send_email` | Compose and send via SMTP — to/cc/bcc, subject, text+HTML body, display name in From | Must Have |
| `move_email` | Move email(s) between folders by UID | Must Have |
| `mark_email` | Set/unset flags on email(s) — read, unread, flagged. Batch UIDs supported. | Must Have |
| `delete_email` | Move to Trash (default) or permanent delete | Must Have |
| `list_folders` | List all IMAP folders with message counts and special-use flags | Must Have |
| `create_folder` | Create new IMAP folder | Should Have |
| `download_attachment` | Download specific attachment by email UID + part ID/filename | Must Have |
| `get_email_raw` | Export email as .eml (raw RFC 822 source) | Should Have |

### Deferred to Later Phases

- **Sieve filter management** — Deferred from MVP. Unique differentiator but adds complexity (custom ManageSieve protocol, no good npm library). Revisit Phase 5.
- **Connection pooling** — MVP uses simple connect-per-request. Pool with health checks and circuit breakers planned for Phase 5 optimization.
- **Triage/inbox summary** — Nice-to-have, defer to Phase 5.

---

## Architecture

```
packages/email-mcp/src/
├── main.ts                    # MCP server (createServer, startServer)
├── bin/cli.ts                 # npx entrypoint
├── services/
│   ├── ImapService.ts         # IMAP operations (imapflow)
│   └── SmtpService.ts         # SMTP send (nodemailer)
├── tools/
│   └── emailTools.ts          # 10 MCP tool defs + handler
├── search.ts                  # Query parser (from:, subject:, etc.)
└── __tests__/
    ├── ImapService.test.ts
    ├── SmtpService.test.ts
    ├── emailTools.test.ts
    └── search.test.ts
```

### Connection Strategy

**Simple connect-per-request.** Each tool call creates a fresh IMAP/SMTP connection, performs the operation, and disconnects. This matches the card-mcp pattern with tsdav and keeps the MVP simple. IMAP handshake overhead (~200-500ms) is negligible for MCP usage patterns.

### Service Layer

**ImapService** wraps `imapflow`:
- Constructor takes `EmailConfig`, creates ImapFlow client
- `connect()` / `disconnect()` for explicit lifecycle
- `ensureConnected()` auto-connects if needed (same pattern as CardDavService)
- Methods: `listFolders()`, `searchEmails(folder, query, options)`, `fetchEmail(folder, uid)`, `fetchRawEmail(folder, uid)`, `moveEmails(folder, uids, destination)`, `markEmails(folder, uids, flags, action)`, `deleteEmails(folder, uids, permanent)`, `createFolder(path)`, `downloadAttachment(folder, uid, partId)`

**SmtpService** wraps `nodemailer`:
- Constructor takes `EmailConfig`, creates nodemailer transporter
- `sendEmail(options)` — to/cc/bcc, subject, text, html, attachments, from name
- Verify connection before sending

### Tool Handler

Same pattern as card-mcp `contactTools.ts`:
- `TOOLS` array of tool definitions with JSON Schema `inputSchema`
- `handleEmailTool(name, args, imapService, smtpService)` router
- `ok(data)` / `error(message)` response helpers

---

## Search Query Parser

Parses structured query strings into IMAP search criteria. Lives in `search.ts`.

**Supported prefixes:**
- `from:sender@example.com` → IMAP FROM filter
- `to:recipient@example.com` → IMAP TO filter
- `subject:keyword` → IMAP SUBJECT filter
- `has:attachment` → Content-Type check
- `is:unread` / `is:read` / `is:flagged` → flag filters
- `since:2026-01-01` / `before:2026-03-01` → date range
- Plain text (no prefix) → IMAP TEXT search (subject + body)

**Combinable:** `from:boss@work.com is:unread subject:urgent` produces a compound AND search.

**Output:** Returns an imapflow-compatible search criteria object.

---

## Core Library Changes

### New Error Codes (`pim-core/errors.ts`)

```typescript
// Add to ErrorCode enum:
EMAIL_NOT_FOUND = "EMAIL_NOT_FOUND",
FOLDER_NOT_FOUND = "FOLDER_NOT_FOUND",
SEND_FAILED = "SEND_FAILED",
ATTACHMENT_NOT_FOUND = "ATTACHMENT_NOT_FOUND",
```

### New Error Class

```typescript
export class EmailError extends PimError {
  public readonly emailUid?: number;
  constructor(message: string, code: ErrorCode, emailUid?: number) {
    super(message, code, false);
    this.emailUid = emailUid;
  }
}
```

### New Config (`pim-core/config.ts`)

```typescript
export interface EmailConfig {
  imap: { host: string; port: number; user: string; pass: string; secure: boolean };
  smtp: { host: string; port: number; user: string; pass: string; secure: boolean };
  fromName?: string;
}
```

**Env vars:** `IMAP_HOST`, `IMAP_PORT` (default 993), `IMAP_USER`, `IMAP_PASS`, `IMAP_SECURE` (default true), `SMTP_HOST`, `SMTP_PORT` (default 465), `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` (default true), `SMTP_FROM_NAME` (optional).

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `imapflow` | Modern IMAP client with promise-based API. Used by mailbox-mcp reference. |
| `nodemailer` | SMTP email sending. De facto standard. |
| `mailparser` | RFC 822 email parsing — headers, body, attachments. |

---

## Testing Strategy

- Mock `imapflow` and `nodemailer` entirely (same as card-mcp mocking tsdav)
- Unit test ImapService: search, fetch, move, delete, flags, folders, attachments
- Unit test SmtpService: send with various params (to/cc/bcc, attachments, from name)
- Unit test search query parser: all prefixes, combinations, edge cases, empty queries
- Unit test tool handler routing and error responses

---

## Email Data Model

```typescript
interface EmailSummary {
  uid: number;
  messageId: string;
  subject: string;
  from: { name?: string; address: string };
  to: Array<{ name?: string; address: string }>;
  date: string; // ISO 8601
  flags: string[];
  hasAttachments: boolean;
}

interface EmailFull extends EmailSummary {
  cc?: Array<{ name?: string; address: string }>;
  bcc?: Array<{ name?: string; address: string }>;
  textBody?: string;
  htmlBody?: string;
  attachments: Array<{
    filename: string;
    contentType: string;
    size: number;
    partId: string;
  }>;
}
```
