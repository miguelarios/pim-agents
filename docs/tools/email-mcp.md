# Email MCP Tools

`@miguelarios/email-mcp` — IMAP/SMTP email server with 12 tools.

> Definitions are pulled directly from `packages/email-mcp/src/tools/emailTools.ts`. Output shapes from `packages/email-mcp/src/services/ImapService.ts`.

> All results carry validated `structuredContent` matching the tool's advertised `outputSchema`, with the same JSON serialized into a text block for clients that do not read structured output. Errors are returned as `isError: true` with a `{ error, message, retryable }` body.

## search_emails

Search and list emails in a folder. Returns email summaries with configurable sorting (default: date descending). All filters combine with AND logic. Use the dedicated fields (`subject`, `from`, `to`, etc.) for most searches. **Note:** for result sets >1000, non-date sort fields are approximate (sorted within page only).

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `folder` | string | | IMAP folder path. Defaults to `INBOX`. |
| `subject` | string | | Search subject line. Multiple words are ANDed. Use `-term` to exclude. Use quotes for exact phrase: `"weekly report"`. |
| `from` | string | | Match sender name or email address (substring match). |
| `to` | string | | Match recipient name or email address (substring match). |
| `cc` | string | | Match CC recipient (substring match). |
| `bcc` | string | | Match BCC recipient (substring match). |
| `body` | string | | Search body text. Multiple words are ANDed. Use `-term` to exclude. Use quotes for exact phrase: `"project update"`. |
| `hasWords` | string | | Search all message content (headers + body, IMAP TEXT). Multiple words are ANDed. Use quotes for exact phrase. Use `-term` for exclusion. Examples: `budget`, `report -draft`, `"quarterly report"`. |
| `since` | string | | Emails on or after this date (YYYY-MM-DD). |
| `before` | string | | Emails before this date (YYYY-MM-DD). |
| `unread` | boolean | | Filter by unread status. |
| `flagged` | boolean | | Filter by flagged/starred status. |
| `hasAttachment` | boolean | | Filter for emails with attachments. |
| `tags` | string[] | | Filter by IMAP keyword flags. |
| `limit` | number | | Max results to return. Defaults to 50. |
| `offset` | number | | Number of results to skip for pagination. Defaults to 0. |
| `sortBy` | `"date"` \| `"from"` \| `"subject"` | | Sort field. Defaults to `date`. |
| `sortOrder` | `"asc"` \| `"desc"` | | Sort direction. Defaults to `desc` (newest first for date). |

**Output**

```ts
{
  emails: EmailSummary[];
  count: number;
}
```

See [Email shapes](#email-shapes) below.

## get_email

Fetch a full email by UID including headers, body, and attachment metadata. Returns body as markdown by default for token efficiency. Use `format='html'` or `format='text'` for raw content.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `folder` | string | | IMAP folder containing the email. Defaults to `INBOX`. |
| `uid` | number | yes | The UID of the email to fetch. |
| `format` | `"markdown"` \| `"html"` \| `"text"` | | Body format to return. `markdown` (default) converts HTML to clean markdown for token efficiency. `html` returns raw HTML. `text` returns plain text only. |

**Output**

`EmailFull` — see [Email shapes](#email-shapes) below. Body field depends on `format`:
- `markdown` → `markdownBody` populated, `htmlBody` and `textBody` removed.
- `html` → `htmlBody` populated, `textBody` removed.
- `text` → `textBody` populated, `htmlBody` removed.

## send_email

Compose and send an email, or save it as a draft. Supports replies with automatic threading — when `replyToUid` is provided, the tool fetches the original email and sets correct `In-Reply-To`/`References` headers and `Re:` subject prefix automatically. Set `saveToDrafts` to true to save to the Drafts folder instead of sending. Sent emails are automatically copied to the Sent folder. Callers may optionally set a visible `From` address, but only when it is explicitly allowed by server configuration.

> **Asks for confirmation.** Only when actually sending — `saveToDrafts: true` is not gated. The client prompts the user before the operation runs; declining returns an error and changes nothing. Set `PIM_MCP_CONFIRM=off` to skip.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `to` | string[] | yes | Recipient email addresses. |
| `cc` | string[] | | CC email addresses. |
| `bcc` | string[] | | BCC email addresses. |
| `subject` | string | | Email subject line. Required for new emails. When `replyToUid` is set and subject is omitted, automatically uses `Re: <original subject>`. When provided explicitly, used as-is. |
| `text` | string | | Plain text body. |
| `html` | string | | HTML body. |
| `attachments` | `{ filename: string, path?: string, content?: string }[]` | | File attachments. Use `content` for inline string content. `path` (attach a file from disk) is **disabled unless the `EMAIL_ATTACHMENT_DIR` env var is set**, and only files resolving inside that directory are allowed. |
| `replyToUid` | number | | UID of the email to reply to. When set, the tool automatically fetches the original email's `Message-ID` and `References` chain, sets `In-Reply-To` and `References` headers, and prepends `Re:` to the subject if not already present. The reply will appear threaded in all email clients. |
| `replyToFolder` | string | | IMAP folder containing the email referenced by `replyToUid`. Defaults to `INBOX`. |
| `saveToDrafts` | boolean | | When true, saves the composed email to the Drafts folder instead of sending it. The draft will appear in any email client and can be edited there. Defaults to false. |
| `from` | string | | Optional visible From address. Must be either `SMTP_USER` or listed in `SMTP_ALLOWED_FROM`; anything else is rejected. SMTP envelope delivery still uses the account sender, so the address should share a domain with `SMTP_USER` — see the deliverability note below. |
| `fromName` | string | | Optional visible display name for the From header. Useful when multiple agents share one allowed sender address. |

**Output**

When `saveToDrafts: true`:
```json
{ "status": "draft", "uid": <number>, "folder": "<drafts-folder-path>" }
```

When sending (default):
```json
{ "status": "sent", "messageId": "<rfc-822-message-id>", "folder": "<sent-folder-path>" }
```

Errors with `subject is required when not replying to an existing email` if no subject and no `replyToUid`.

**Deliverability when using `from`**

`from` sets the visible `From:` header; the SMTP envelope sender remains the authenticated account. DMARC requires
the visible `From:` domain to align with a domain that passed SPF or DKIM, so an allowlisted address on the *same*
domain as `SMTP_USER` delivers normally, while one on a *different* domain is likely to be spam-foldered or rejected
outright when that domain publishes `p=quarantine` or `p=reject`.

If the goal is only to distinguish which agent sent a message, prefer `fromName` — it changes the display name
without touching the address, and carries no deliverability risk.


## send_draft

Send an existing email draft from the Drafts folder. Fetches the draft's raw RFC 822 source, sends it via SMTP, copies it to the Sent folder, and removes it from Drafts. The draft must already exist — use `send_email` with `saveToDrafts: true` to create one.

> **Asks for confirmation.** Sending a draft cannot be recalled. The client prompts the user before the operation runs; declining returns an error and changes nothing. Set `PIM_MCP_CONFIRM=off` to skip.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uid` | number | yes | UID of the draft email in the Drafts folder. |
| `folder` | string | | IMAP folder containing the draft. Defaults to the server's Drafts folder. |

**Output**

```json
{ "status": "sent", "messageId": "<rfc-822-message-id>", "folder": "<sent-folder-path>" }
```

Errors with `Draft has no recipients — cannot send` if the draft is missing `To`/`Cc`/`Bcc`.

## move_email

Move one or more emails to a different IMAP folder.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `folder` | string | | Source IMAP folder. Defaults to `INBOX`. |
| `uids` | number[] | yes | UIDs of emails to move. |
| `destination` | string | yes | Destination folder path. |

**Output**

```json
{ "status": "moved", "uids": [<uid>, ...], "destination": "<folder>" }
```

## mark_email

Set or unset flags on one or more emails. Common flags: `\Seen` (read), `\Flagged` (starred).

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `folder` | string | | IMAP folder. Defaults to `INBOX`. |
| `uids` | number[] | yes | UIDs of emails to modify. |
| `flags` | string[] | yes | Flags to set/unset (e.g., `\Seen`, `\Flagged`). |
| `action` | `"add"` \| `"remove"` | | Whether to add or remove the flags. Defaults to `add`. |

**Output**

```json
{ "status": "updated", "uids": [<uid>, ...], "flags": [...], "action": "add" | "remove" }
```

## delete_email

Delete one or more emails. Moves to Trash by default, or permanently deletes if specified.

> **Asks for confirmation.** Only when `permanent` is `true` — a move to Trash is not gated. The client prompts the user before the operation runs; declining returns an error and changes nothing. Set `PIM_MCP_CONFIRM=off` to skip.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `folder` | string | | IMAP folder. Defaults to `INBOX`. |
| `uids` | number[] | yes | UIDs of emails to delete. |
| `permanent` | boolean | | If true, permanently delete instead of moving to Trash. Defaults to false. |

**Output**

```json
{ "status": "moved_to_trash" | "permanently_deleted", "uids": [<uid>, ...] }
```

## list_folders

List all IMAP folders with their paths and special-use flags (Inbox, Sent, Trash, etc.).

*No parameters.*

**Output**

```ts
{
  folders: Array<{
    path: string;
    specialUse?: string;   // e.g. "\\Sent", "\\Drafts", "\\Trash"
    delimiter: string;     // hierarchy separator, usually "/" or "."
  }>;
}
```

## create_folder

Create a new IMAP folder.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Folder path to create (e.g., `Projects/Work`). |

**Output**

```json
{ "status": "created", "path": "<folder-path>" }
```

## download_attachment

Download a specific attachment from an email. Returns the attachment content as base64.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `folder` | string | | IMAP folder. Defaults to `INBOX`. |
| `uid` | number | yes | UID of the email containing the attachment. |
| `partId` | string | yes | MIME part ID of the attachment (from `get_email` attachment metadata). |

**Output**

The bytes are returned as an embedded binary resource in `content`:

```ts
{
  type: "resource",
  resource: {
    uri: "imap://<folder>/<uid>/<partId>",
    mimeType: string,
    blob: string,     // base64-encoded
  }
}
```

with the same payload in `structuredContent`:

```ts
{
  filename: string;
  contentType: string;
  size: number;       // bytes
  content: string;    // base64-encoded
}
```

## get_email_raw

Export an email as raw .eml (RFC 822 source). Useful for archival or forwarding.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `folder` | string | | IMAP folder. Defaults to `INBOX`. |
| `uid` | number | yes | UID of the email to export. |

**Output**

The source is returned as an embedded `message/rfc822` resource in `content`, so a multi-megabyte `.eml` is not duplicated in the payload:

```ts
{
  type: "resource",
  resource: {
    uri: "imap://<folder>/<uid>.eml",
    mimeType: "message/rfc822",
    text: string,     // raw RFC 822 source
  }
}
```

`structuredContent` carries the metadata only:

```ts
{ uid: number; folder: string; size: number }
```

## get_folder_status

Get total and unread message counts for a folder via IMAP STATUS (single round-trip, no payload).

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `folder` | string | | IMAP folder path. Defaults to `INBOX`. |

**Output**

```json
{ "total": <number>, "unseen": <number> }
```

## Email shapes

`EmailSummary` (returned by `search_emails`; `packages/email-mcp/src/services/ImapService.ts`):

```ts
interface EmailSummary {
  uid: number;
  messageId: string;
  subject: string;
  from: { name?: string; address: string };
  to: Array<{ name?: string; address: string }>;
  date: string;             // ISO 8601
  flags: string[];          // IMAP flags incl. "\Seen", "\Flagged", custom keywords
  hasAttachments: boolean;
}
```

`EmailFull` (returned by `get_email`):

```ts
interface EmailFull extends EmailSummary {
  cc?: Array<{ name?: string; address: string }>;
  inReplyTo: string | null;        // Message-ID being replied to
  references: string[];            // full thread chain
  textBody?: string;               // present when format = "text" or "markdown" fallback
  htmlBody?: string;               // present when format = "html"
  markdownBody?: string;           // present when format = "markdown"
  attachments: Array<{
    filename: string;
    contentType: string;
    size: number;                  // bytes
    partId: string;                // pass to download_attachment
  }>;
}
```

## Errors

All tools wrap errors as a string text content with `isError: true`. The format is `<message>` plus ` (retryable)` for transient failures (network/IMAP-disconnect class). Underlying type is `PimError` from `@miguelarios/pim-core`.
