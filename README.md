# PIM Agents

AI agent tooling for email (IMAP/SMTP), calendar (CalDAV), and contacts (CardDAV). Three independent MCP servers built on open protocols.

## Protocol support

All three servers speak MCP revision **2026-07-28** over stdio or Streamable HTTP, and continue to serve 2025-era clients from the same tool definitions — no configuration needed either way.

Every tool declares a `title`, a full set of behaviour annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), and an `outputSchema`; results carry validated `structuredContent` alongside the serialized JSON.

Irreversible operations ask the user to confirm before they run — `send_email`, `send_draft`, `forward_email`, a permanent `delete_email`, `delete_folder`; any `delete_event` that removes the calendar object, `delete_calendar`, and an `update_event` with `span: "future"` that would drop per-occurrence changes; `delete_contact`, `delete_group` and `delete_address_book`. They ask, using the spec's multi round-trip request pattern. Set `PIM_MCP_CONFIRM=off` to skip confirmation in headless or automated use.

A client that does not support elicitation cannot answer the prompt, so those tools fail fast with `CONFIRMATION_UNSUPPORTED` and point at `PIM_MCP_CONFIRM=off` — rather than returning a question that never reaches anyone.

## Packages

| Package | Description | Install |
|---------|-------------|---------|
| [@miguelarios/email-mcp](packages/email-mcp) | Email via IMAP/SMTP | `npx @miguelarios/email-mcp` |
| [@miguelarios/cal-mcp](packages/cal-mcp) | Calendars via CalDAV | `npx @miguelarios/cal-mcp` |
| [@miguelarios/card-mcp](packages/card-mcp) | Contacts via CardDAV | `npx @miguelarios/card-mcp` |

## Tools

### [Email (17 tools)](docs/tools/email-mcp.md)

| Tool | Description |
|------|-------------|
| `search_emails` | Search and filter emails by folder, sender, subject, date, flags |
| `get_email` | Fetch full email by UID — headers, body, attachment metadata |
| `get_thread` | Fetch the whole conversation a message belongs to, oldest first |
| `send_email` | Compose and send via SMTP, reply with threading, or save as draft (confirms before sending) |
| `send_draft` | Send an existing draft from the Drafts folder (confirms first) |
| `forward_email` | Forward a message with its attachments and an optional note (confirms before sending) |
| `move_email` | Move emails between folders |
| `copy_email` | Copy emails into another folder, leaving the originals in place |
| `mark_email` | Set/unset flags (read, unread, flagged) |
| `delete_email` | Move to trash, or permanently delete (confirms first) |
| `list_folders` | List all IMAP folders with special-use flags |
| `create_folder` | Create an IMAP folder |
| `rename_folder` | Rename an IMAP folder, or move it under a different parent |
| `delete_folder` | Delete an IMAP folder and everything in it (confirms first) |
| `download_attachment` | Download attachment by email UID and part ID, as an embedded binary resource |
| `get_email_raw` | Export email as raw .eml, as an embedded `message/rfc822` resource |
| `get_folder_status` | Get total and unread message counts for a folder |

### [Calendar (16 tools)](docs/tools/cal-mcp.md)

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
| `get_free_busy` | Busy periods in a range, typed as busy/tentative/unavailable, without event details |
| `create_calendar` | Create a calendar on a provider, with colour and description |
| `update_calendar` | Rename a calendar or change its colour/description |
| `delete_calendar` | Delete a calendar and every event in it (confirms first) |

### [Contacts (17 tools)](docs/tools/card-mcp.md)

Every `addressBook` parameter takes a display name (e.g. `Work`) as well as a URL. When it is omitted, reads and lookups by UID cover every address book in the account.

| Tool | Description |
|------|-------------|
| `list_contacts` | List and search contacts by name, email, phone, org (groups hidden unless `include_groups`) |
| `get_contact` | Get full contact details by UID |
| `create_contact` | Create a new contact with typed fields |
| `update_contact` | Update an existing contact (merge-based) |
| `delete_contact` | Delete a contact by UID (confirms first) |
| `resolve_contact` | Given a name, return email address |
| `move_contacts` | Move contacts to another address book (keeps each UID) |
| `copy_contacts` | Copy contacts into another address book (each copy gets a new UID) |
| `list_groups` | List contact groups with member counts |
| `get_group` | Get a group with its members resolved to contacts |
| `create_group` | Create a contact group from member UIDs |
| `update_group` | Rename a group, add and remove members |
| `delete_group` | Delete a group, keeping its members (confirms first) |
| `list_address_books` | List address books with metadata and opt-in contact counts |
| `create_address_book` | Create an address book (extended MKCOL) |
| `rename_address_book` | Rename an address book or update its description |
| `delete_address_book` | Delete an address book and its contacts (confirms first) |

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
- `EMAIL_MAX_INLINE_BYTES` — bytes above which `download_attachment` and `get_email_raw` return a resource link instead of embedding the payload. Defaults to `262144` (256 KB); `0` links everything.
- `EMAIL_ATTACHMENT_DIR` — directory that gates `send_email` file attachments. **Path-based attachments (`attachments[].path`) are rejected unless this is set**, and only files resolving inside it are allowed (a guard against exfiltrating arbitrary files via prompt injection). Use `attachments[].content` for inline content without setting this.
- `URL_RESOLVE_DISABLE` — set to `1` or `true` to skip all network link-resolution when rendering email to markdown (avoids outbound requests to links in a message). Link/tracker URLs are left unresolved in the output.
- `URL_RESOLVE_PROXY` — route link resolution through an `http://` or `https://` proxy, so the machine running the server does not hand its IP address to every host an email links to. See [Link resolution and your IP address](packages/email-mcp/README.md#link-resolution-and-your-ip-address).
- `URL_RESOLVE_TIMEOUT` — milliseconds allowed for each link-resolution fetch. Default `10000`.
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

Add multiple providers by using different IDs: `CALDAV_NEXTCLOUD_URL`, `CALDAV_NEXTCLOUD_USER`, `CALDAV_NEXTCLOUD_PASS`, etc. The ID prefixes that account's calendar IDs (`nextcloud/Work`).

Optional calendar env vars:

- `PIM_TIMEZONE` — IANA timezone used for "today", free-slot searches and local times. Defaults to the host timezone, which in a container is usually UTC.
- `CAL_MCP_DEBUG` — set to `1` to attach per-step CalDAV timings to tool results under `_meta`, for diagnosing a slow provider.

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

Optional contacts env var: `CARDDAV_SERVER_SEARCH` — set to `off` to never search with a filtered `addressbook-query` REPORT and always fetch the whole book instead. A server that rejects the REPORT is fallen back from automatically; this is for one whose filter matching is wrong.

### Settings shared by all three

| Variable | Default | Meaning |
|----------|---------|---------|
| `PIM_MCP_CONFIRM` | *(on)* | Set to `off` to run irreversible operations without asking. For headless use |
| `PIM_TIMEZONE` | host zone | IANA timezone for dates and "today" |
| `PIM_MCP_TRANSPORT` | `stdio` | `stdio` or `http` — see [Over Streamable HTTP](#over-streamable-http) |

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

### Over Streamable HTTP

Every server runs over stdio by default. Set `PIM_MCP_TRANSPORT=http` to serve Streamable HTTP instead, for a client that connects by URL, such as a remote connector or a server in a container:

```bash
PIM_MCP_TRANSPORT=http PIM_MCP_HTTP_PORT=3000 \
CARDDAV_URL=https://dav.example.com/carddav/ CARDDAV_USER=user@example.com CARDDAV_PASS=app-password \
npx -y @miguelarios/card-mcp
# [card-mcp] Server started on http://127.0.0.1:3000/mcp
```

| Variable | Default | Meaning |
|----------|---------|---------|
| `PIM_MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `PIM_MCP_HTTP_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` inside a container |
| `PIM_MCP_HTTP_PORT` | `3000` | Listen port. Give each server its own when running more than one |
| `PIM_MCP_HTTP_ALLOWED_ORIGINS` | *(none)* | Comma-separated browser origins to admit. Requests carrying any other `Origin` header get `403`; requests with none (every non-browser client) are unaffected |

The endpoint is `/mcp`, and `GET /healthz` answers `ok` for container health checks without touching the mail or DAV server. Both protocol eras are served: 2026-07-28 requests statelessly, 2025-era clients in a session, so the confirmation prompt reaches them as it does over stdio.

**The HTTP server does no authentication.** Anyone who can reach the port can read and send your mail. Keep it on loopback or a private network, and put an OAuth proxy in front of it before exposing it any further. The server logs a warning when it is bound beyond loopback.

### Running in Docker

There is no dedicated image: run each server from `node:22-alpine` with `npx`, pinned to a version. For example, all three over HTTP, reachable from this machine only:

```yaml
x-mcp: &mcp
  image: node:22-alpine
  user: node
  restart: unless-stopped
  environment: &http
    PIM_MCP_TRANSPORT: http
    PIM_MCP_HTTP_HOST: 0.0.0.0
    PIM_MCP_HTTP_PORT: "3000"
  healthcheck:
    test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3000/healthz"]
    interval: 30s
    start_period: 60s

services:
  email-mcp:
    <<: *mcp
    command: ["npx", "-y", "@miguelarios/email-mcp@0.17.0"]
    env_file: email.env
    ports: ["127.0.0.1:3001:3000"]
    volumes: [email-mcp-home:/home/node]
  cal-mcp:
    <<: *mcp
    command: ["npx", "-y", "@miguelarios/cal-mcp@0.20.0"]
    env_file: cal.env
    environment:
      <<: *http
      PIM_TIMEZONE: America/Chicago
    ports: ["127.0.0.1:3002:3000"]
    volumes: [cal-mcp-home:/home/node]
  card-mcp:
    <<: *mcp
    command: ["npx", "-y", "@miguelarios/card-mcp@0.12.0"]
    env_file: card.env
    ports: ["127.0.0.1:3003:3000"]
    volumes: [card-mcp-home:/home/node]

volumes:
  email-mcp-home:
  cal-mcp-home:
  card-mcp-home:
```

**[docs/docker.md](docs/docker.md)** has the complete guide: an env file and `docker run` (stdio and HTTP) and Compose examples for each server on its own, connecting clients, attachments from disk, exposing a server safely, upgrading, and troubleshooting.

## License

MIT
