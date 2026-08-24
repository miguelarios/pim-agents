# PIM Agents

AI agent tooling for email (IMAP/SMTP), calendar (CalDAV), and contacts (CardDAV). Three independent MCP servers built on open protocols.

## Protocol support

All three servers speak MCP revision **2026-07-28** over stdio, and continue to serve 2025-era clients from the same tool definitions — no configuration needed either way.

Every tool declares a `title`, a full set of behaviour annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), and an `outputSchema`; results carry validated `structuredContent` alongside the serialized JSON.

Irreversible operations — `send_email`, `send_draft`, a permanent `delete_email`, `delete_contact`, and any `delete_event` that removes the calendar object — ask the user to confirm before they run, using the spec's multi round-trip request pattern. Set `PIM_MCP_CONFIRM=off` to skip confirmation in headless or automated use.

A client that does not support elicitation cannot answer the prompt, so those tools fail fast with `CONFIRMATION_UNSUPPORTED` and point at `PIM_MCP_CONFIRM=off` — rather than returning a question that never reaches anyone.

## Packages

| Package | Description | Install |
|---------|-------------|---------|
| [@miguelarios/email-mcp](packages/email-mcp) | Email via IMAP/SMTP | `npx @miguelarios/email-mcp` |
| [@miguelarios/cal-mcp](packages/cal-mcp) | Calendars via CalDAV | `npx @miguelarios/cal-mcp` |
| [@miguelarios/card-mcp](packages/card-mcp) | Contacts via CardDAV | `npx @miguelarios/card-mcp` |

## Tools

### [Email (12 tools)](docs/tools/email-mcp.md)

| Tool | Description |
|------|-------------|
| `search_emails` | Search and filter emails by folder, sender, subject, date, flags |
| `get_email` | Fetch full email by UID — headers, body, attachment metadata |
| `send_email` | Compose and send via SMTP, reply with threading, or save as draft (confirms before sending) |
| `send_draft` | Send an existing draft from the Drafts folder (confirms first) |
| `move_email` | Move emails between folders |
| `mark_email` | Set/unset flags (read, unread, flagged) |
| `delete_email` | Move to trash, or permanently delete (confirms first) |
| `list_folders` | List all IMAP folders with special-use flags |
| `create_folder` | Create an IMAP folder |
| `download_attachment` | Download attachment by email UID and part ID, as an embedded binary resource |
| `get_email_raw` | Export email as raw .eml, as an embedded `message/rfc822` resource |
| `get_folder_status` | Get total and unread message counts for a folder |

### [Calendar (12 tools)](docs/tools/cal-mcp.md)

| Tool | Description |
|------|-------------|
| `list_calendars` | Discover calendars across all configured providers |
| `list_events` | Query events by date range with recurrence expansion |
| `get_today_events` | Get all events for today |
| `search_events` | Keyword search across title, description, and location |
| `get_event` | Get full event details by UID |
| `create_event` | Create event with attendees, alarms, categories |
| `update_event` | Update event by UID, including single recurrence instances |
| `move_event` | Move an event to another calendar within the same account |
| `delete_event` | Delete event by UID (confirms first) or exclude a single recurrence instance |
| `create_events_batch` | Create multiple events at once |
| `import_ics` | Import events from .ics content |
| `find_free_slots` | Find available time slots across calendars |

### [Contacts (6 tools)](docs/tools/card-mcp.md)

| Tool | Description |
|------|-------------|
| `list_contacts` | List and search contacts by name, email, phone, org |
| `get_contact` | Get full contact details by UID |
| `create_contact` | Create a new contact with typed fields |
| `update_contact` | Update an existing contact (merge-based) |
| `delete_contact` | Delete a contact by UID (confirms first) |
| `resolve_contact` | Given a name, return email address |

## Configuration

Add the servers to your MCP client config (Claude Desktop, Claude Code, etc.). Credentials are passed via environment variables.

### Email

```json
{
  "mcpServers": {
    "email": {
      "command": "npx",
      "args": ["-y", "@miguelarios/email-mcp"],
      "env": {
        "IMAP_HOST": "imap.example.com",
        "IMAP_USER": "user@example.com",
        "IMAP_PASS": "your-app-password",
        "SMTP_HOST": "smtp.example.com",
        "SMTP_USER": "user@example.com",
        "SMTP_PASS": "your-app-password"
      }
    }
  }
}
```

Optional email env vars:

- `IMAP_PORT` (default 993), `IMAP_SECURE` (default true), `SMTP_PORT` (default 465), `SMTP_SECURE` (default true), `SMTP_FROM_NAME`.
- `PIM_TIMEZONE` — IANA timezone (e.g. `America/Chicago`) for rendering email dates. Defaults to the host timezone.
- `EMAIL_ATTACHMENT_DIR` — directory that gates `send_email` file attachments. **Path-based attachments (`attachments[].path`) are rejected unless this is set**, and only files resolving inside it are allowed (a guard against exfiltrating arbitrary files via prompt injection). Use `attachments[].content` for inline content without setting this.
- `URL_RESOLVE_DISABLE` — set to `1` or `true` to skip all network link-resolution when rendering email to markdown (avoids outbound requests to links in a message). Link/tracker URLs are left unresolved in the output.
- `SMTP_AUTO_SENT` — set to `true` if your provider auto-files sent mail into the Sent folder, so the server skips the extra IMAP append.
- `SMTP_ALLOWED_FROM` — comma-separated allowlist of additional visible `From` addresses that `send_email` may use. The SMTP envelope sender is always the authenticated account; only the visible header changes. **Keep allowlisted addresses on a domain your SMTP account can authenticate for** — see [Deliverability: SPF, DKIM and DMARC](#deliverability-spf-dkim-and-dmarc).

#### Deliverability: SPF, DKIM and DMARC

`SMTP_ALLOWED_FROM` changes the **visible** `From:` header only. The SMTP envelope sender stays the authenticated
`SMTP_USER`, so mail is still submitted as your account.

That split is what receiving servers scrutinise. DMARC requires the visible `From:` domain to *align* with a domain
that passed SPF (checked against the envelope sender) or DKIM (checked against the signing domain). So:

- **Same domain — safe.** `SMTP_USER=alice@example.com` with `SMTP_ALLOWED_FROM=team@example.com` aligns, because
  both are `example.com`. This is the intended use: several agents sharing one mailbox under a shared identity.
- **Different domain — expect problems.** `SMTP_USER=alice@example.com` with `SMTP_ALLOWED_FROM=bob@example.org`
  does *not* align. If `example.org` publishes a DMARC policy of `p=quarantine` or `p=reject`, recipients will spam-folder
  or bounce the message, and you may harm the sending reputation of both domains.

If you genuinely need to send as another domain, authorise it properly at the provider — add the domain to your mail
account, publish an SPF record covering the provider, and enable DKIM signing for it — rather than only adding it to
this allowlist. The allowlist controls what this server *permits*; it cannot make a receiving server trust you.

`SMTP_FROM_NAME` and the per-call `fromName` only change the display name, never the address, so they carry no
deliverability risk.

### Calendar

```json
{
  "mcpServers": {
    "calendar": {
      "command": "npx",
      "args": ["-y", "@miguelarios/cal-mcp"],
      "env": {
        "CALDAV_MAILBOX_URL": "https://dav.mailbox.org/caldav/",
        "CALDAV_MAILBOX_USER": "user@mailbox.org",
        "CALDAV_MAILBOX_PASS": "app-password"
      }
    }
  }
}
```

Add multiple providers by using different IDs: `CALDAV_NEXTCLOUD_URL`, `CALDAV_NEXTCLOUD_USER`, `CALDAV_NEXTCLOUD_PASS`, etc.

### Contacts

```json
{
  "mcpServers": {
    "contacts": {
      "command": "npx",
      "args": ["-y", "@miguelarios/card-mcp"],
      "env": {
        "CARDDAV_URL": "https://dav.example.com/carddav/",
        "CARDDAV_USER": "user@example.com",
        "CARDDAV_PASS": "your-app-password"
      }
    }
  }
}
```

### All three together

```json
{
  "mcpServers": {
    "email": {
      "command": "npx",
      "args": ["-y", "@miguelarios/email-mcp"],
      "env": {
        "IMAP_HOST": "imap.example.com",
        "IMAP_USER": "user@example.com",
        "IMAP_PASS": "your-app-password",
        "SMTP_HOST": "smtp.example.com",
        "SMTP_USER": "user@example.com",
        "SMTP_PASS": "your-app-password"
      }
    },
    "calendar": {
      "command": "npx",
      "args": ["-y", "@miguelarios/cal-mcp"],
      "env": {
        "CALDAV_MAILBOX_URL": "https://dav.mailbox.org/caldav/",
        "CALDAV_MAILBOX_USER": "user@mailbox.org",
        "CALDAV_MAILBOX_PASS": "app-password"
      }
    },
    "contacts": {
      "command": "npx",
      "args": ["-y", "@miguelarios/card-mcp"],
      "env": {
        "CARDDAV_URL": "https://dav.example.com/carddav/",
        "CARDDAV_USER": "user@example.com",
        "CARDDAV_PASS": "your-app-password"
      }
    }
  }
}
```

## License

MIT
