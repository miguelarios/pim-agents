# @miguelarios/email-mcp

MCP server for email via IMAP/SMTP — search, read, send, and manage emails and folders.

## Protocol support

Speaks MCP revision **2026-07-28** over stdio, and still serves 2025-era clients from the same tool definitions.
Every tool declares a `title`, all four behaviour annotations, and an `outputSchema`, and returns validated `structuredContent`.

`send_email` (when sending, not when saving a draft), `send_draft`, `delete_email` with `permanent: true`, and `delete_folder` ask the user to confirm first. Set `PIM_MCP_CONFIRM=off` to skip confirmation in headless use.

Requires Node.js **20.18.1 or newer**.

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

- `EMAIL_MAX_INLINE_BYTES` — bytes above which `download_attachment` and `get_email_raw`
  return a resource link instead of embedding the payload. Defaults to `262144` (256 KB),
  matching the ceiling calendar parts already use. `0` links everything; an unparseable
  value falls back to the default rather than disabling the guard. Base64 adds a third on
  top, and most clients put a tool result straight into the model's context, so raise it
  deliberately.
- `EMAIL_ATTACHMENT_DIR` — directory that gates `send_email` file attachments. Path-based attachments (`attachments[].path`) are rejected unless this is set, and only files resolving inside it are allowed. Use `attachments[].content` for inline content without setting this.
- `URL_RESOLVE_DISABLE` — set to `1`/`true` to skip network link-resolution when rendering email to markdown; links are left unresolved in the output.
- `URL_RESOLVE_PROXY` — route link resolution through an HTTP proxy, so the machine running
  the server does not hand its IP address to every host an email links to. Takes an
  `http://` or `https://` URL, with credentials if the proxy needs them
  (`http://user:pass@proxy.internal:3128`). See [Link resolution and your IP address](#link-resolution-and-your-ip-address).
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

## Tools (16)

See [docs/tools/email-mcp.md](../../docs/tools/email-mcp.md) for full parameter and output details.

| Tool | Description |
|------|-------------|
| `search_emails` | Search and filter emails by folder, sender, subject, date, flags — server-side `SORT` where available |
| `get_email` | Fetch full email by UID — headers, body, attachment metadata, calendar invitation parts |
| `get_thread` | Fetch the whole conversation a message belongs to, oldest first |
| `send_email` | Compose and send via SMTP, reply with threading, save as draft, or use an allowed visible From address |
| `send_draft` | Send an existing draft from the Drafts folder |
| `move_email` | Move emails between folders |
| `copy_email` | Copy emails into another folder, leaving the originals in place |
| `mark_email` | Set/unset flags (read, unread, flagged) |
| `delete_email` | Move to trash or permanently delete |
| `list_folders` | List all IMAP folders with special-use flags |
| `create_folder` | Create an IMAP folder |
| `rename_folder` | Rename an IMAP folder, or move it under a different parent |
| `delete_folder` | Delete an IMAP folder and everything in it (asks to confirm) |
| `download_attachment` | Download attachment by email UID and part ID |
| `get_email_raw` | Export email as raw .eml |
| `get_folder_status` | Get total and unread message counts for a folder |

## Sorting

`search_emails` uses the server's own `SORT` command (RFC 5256) when the server advertises
the capability. The whole result set is ordered server-side, only the requested page's
envelopes come across the wire, and pagination is exact however large the folder is.

A filter carrying non-ASCII is issued under the charset imapflow's compiler asks for, lifted into the slot RFC 5256 gives it rather than left in the search key where it would be a syntax error.

Without `SORT`, the previous behaviour stands: the result set is fetched and sorted here,
and beyond 1000 messages a non-date sort is approximate — ordered within the page only.
The same fallback catches a server that advertises `SORT` but rejects the command (an
older server that only accepts `US-ASCII`, say, answers `BADCHARSET`), so a search never
fails over it.

Server-side ordering is not byte-identical to the fallback, because RFC 5256 defines the
keys differently: `SUBJECT` sorts on the *base* subject with `Re:`/`Fwd:` stripped, and
`FROM` sorts on the sender's mailbox address where the fallback prefers the display name.

## Link resolution and your IP address

Rendering an email to markdown resolves the links in it, which means a GET to every distinct
URL the message contains. Those hosts see the request come from whatever machine the server
runs on — a home connection, typically — and marketing links are often instrumented precisely
to record that. The links come from senders you did not choose.

Set `URL_RESOLVE_PROXY` to an `http://` or `https://` proxy URL and every resolution fetch
goes through it instead. Credentials are supported in the URL. Nothing else about the
server's traffic is proxied: IMAP and SMTP connections are unaffected.

**A proxy that cannot be used disables resolution rather than falling back to a direct
fetch.** If the value is unparseable or has a scheme other than `http`/`https`, the server
logs the reason to stderr and leaves links unresolved. Resolving directly at that point would
disclose exactly the address the setting exists to protect, so it fails closed.

Unset the variable to resolve directly (the default), or `URL_RESOLVE_DISABLE=1` to skip
resolution entirely — that still wins over a configured proxy.

The SSRF guard is unchanged and independent: private-range, loopback and reserved-suffix
targets are never fetched, proxy or not.

## Resources

Attachments and message sources are addressable as `imap://` resources, not just
returned inline by a tool. A client that wants the bytes can fetch them with
`resources/read` on its own terms — which keeps a large payload out of the model's
context when only the file itself is wanted.

| URI template | Contents |
|--------------|----------|
| `imap://{folder}/{uid}/{partId}` | One attachment's bytes, under its own media type. Part IDs come from `get_email`'s attachment metadata. |
| `imap://{folder}/{uid}.eml` | The message's raw RFC 822 source. |

`download_attachment` and `get_email_raw` stamp these URIs onto whatever they return,
so a URI from a tool result can be read back directly. Under `EMAIL_MAX_INLINE_BYTES`
the payload is embedded as before; over it, the tool returns a `resource_link` and the
bytes stay one `resources/read` away instead of arriving as multi-megabyte base64.
Either way `structuredContent` carries the `uri` and an `embedded` flag saying which
happened.

The folder occupies the URI's authority and is percent-encoded whole, so a hierarchy
delimiter inside it survives: `Archive/2024` becomes `imap://Archive%2F2024/99/1.2`.
Folder case is preserved, because IMAP mailbox names are case-sensitive.

Neither template is enumerable — there is no `resources/list` entry for them, since
listing every attachment in an account would mean walking every message. Discover
them through `resources/templates/list`, and find part IDs with `get_email`.

## Sending attachments

`send_email` takes attachments three ways:

| Field | Use for |
|-------|---------|
| `content` alone | Text. Read as UTF-8, so it **corrupts binary**. |
| `content` + `encoding: "base64"` | Binary — a PDF, an image, or bytes from `download_attachment`. |
| `path` | A file on the server, only inside `EMAIL_ATTACHMENT_DIR`. |

Set `contentType` when the filename has no extension to guess from.

This is what makes the download-then-forward round trip work without a configured
directory: `download_attachment` returns base64, and `encoding: "base64"` is where
it goes. Invalid base64 is rejected rather than attached — a payload that silently
decoded to fewer bytes would reach the recipient as a corrupt file with no error
anywhere.

## License

MIT
