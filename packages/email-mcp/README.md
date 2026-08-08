# @miguelarios/email-mcp

MCP server for email via IMAP/SMTP — search, read, send, and manage emails and folders.

## Protocol support

Speaks MCP revision **2026-07-28** over stdio, and still serves 2025-era clients from the same tool definitions.
Every tool declares a `title`, all four behaviour annotations, and an `outputSchema`, and returns validated `structuredContent`.

`send_email` (when sending, not when saving a draft), `send_draft`, and `delete_email` with `permanent: true` ask the user to confirm first. Set `PIM_MCP_CONFIRM=off` to skip confirmation in headless use.

## Usage

```bash
npx @miguelarios/email-mcp
```

## Configuration

Add the server to your MCP client config (Claude Desktop, Claude Code, etc.). Credentials are passed via environment variables.

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

Optional env vars: `IMAP_PORT` (default 993), `IMAP_SECURE` (default true), `SMTP_PORT` (default 465), `SMTP_SECURE` (default true), `SMTP_FROM_NAME`, `PIM_TIMEZONE`.

- `EMAIL_ATTACHMENT_DIR` — directory that gates `send_email` file attachments. Path-based attachments (`attachments[].path`) are rejected unless this is set, and only files resolving inside it are allowed. Use `attachments[].content` for inline content without setting this.
- `URL_RESOLVE_DISABLE` — set to `1`/`true` to skip network link-resolution when rendering email to markdown; links are left unresolved in the output.
- `SMTP_AUTO_SENT` — set to `true` if your provider auto-files sent mail, so the server skips the extra IMAP append to Sent.
- `SMTP_ALLOWED_FROM` — comma-separated allowlist of additional visible `From` addresses that `send_email` may use via its `from` parameter. Any address not in this list (and not `SMTP_USER`) is rejected. Read [Deliverability](#deliverability-spf-dkim-and-dmarc) before setting it.

### Deliverability: SPF, DKIM and DMARC

`SMTP_ALLOWED_FROM` changes the **visible** `From:` header only. The SMTP envelope sender remains the authenticated
`SMTP_USER`, so the message is still submitted as your account.

Receiving servers check those two against each other. DMARC requires the visible `From:` domain to *align* with a
domain that passed SPF (evaluated against the envelope sender) or DKIM (evaluated against the signing domain).

| Configuration | Aligns? | Result |
|---|---|---|
| `SMTP_USER=alice@example.com`, allow `team@example.com` | yes | Delivers normally — the intended use |
| `SMTP_USER=alice@example.com`, allow `bob@example.org` | no | Likely spam-foldered or rejected if `example.org` publishes `p=quarantine`/`p=reject` |

Keep allowlisted addresses on a domain your SMTP account can authenticate for. To send as a genuinely different
domain, authorise it at the provider — add the domain to the account, publish an SPF record covering the provider,
and enable DKIM signing for it. This allowlist controls what the server *permits*; it cannot make a receiving
server trust you.

`SMTP_FROM_NAME` and the per-call `fromName` change only the display name, never the address, so they carry no
deliverability risk. Prefer them when you just want a distinct agent identity on a shared mailbox.

## Tools (12)

See [docs/tools/email-mcp.md](../../docs/tools/email-mcp.md) for full parameter and output details.

| Tool | Description |
|------|-------------|
| `search_emails` | Search and filter emails by folder, sender, subject, date, flags |
| `get_email` | Fetch full email by UID — headers, body, attachment metadata |
| `send_email` | Compose and send via SMTP, reply with threading, save as draft, or use an allowed visible From address |
| `send_draft` | Send an existing draft from the Drafts folder |
| `move_email` | Move emails between folders |
| `mark_email` | Set/unset flags (read, unread, flagged) |
| `delete_email` | Move to trash or permanently delete |
| `list_folders` | List all IMAP folders with special-use flags |
| `create_folder` | Create an IMAP folder |
| `download_attachment` | Download attachment by email UID and part ID |
| `get_email_raw` | Export email as raw .eml |
| `get_folder_status` | Get total and unread message counts for a folder |

## License

MIT
