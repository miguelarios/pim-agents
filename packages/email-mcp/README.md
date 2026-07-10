# @miguelarios/email-mcp

MCP server for email via IMAP/SMTP — search, read, send, and manage emails and folders.

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

## Tools (12)

See [docs/tools/email-mcp.md](../../docs/tools/email-mcp.md) for full parameter and output details.

| Tool | Description |
|------|-------------|
| `search_emails` | Search and filter emails by folder, sender, subject, date, flags |
| `get_email` | Fetch full email by UID — headers, body, attachment metadata |
| `send_email` | Compose and send via SMTP, reply with threading, or save as draft |
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
