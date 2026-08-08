# @miguelarios/card-mcp

MCP server for contacts via CardDAV — CRUD contacts, search, resolve names to emails.

## Protocol support

Speaks MCP revision **2026-07-28** over stdio, and still serves 2025-era clients from the same tool definitions.
Every tool declares a `title`, all four behaviour annotations, and an `outputSchema`, and returns validated `structuredContent`.

`delete_contact` asks the user to confirm before deleting. Set `PIM_MCP_CONFIRM=off` to skip confirmation in headless use.

## Usage

```bash
npx @miguelarios/card-mcp
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CARDDAV_URL` | Yes | CardDAV server URL |
| `CARDDAV_USER` | Yes | CardDAV username |
| `CARDDAV_PASS` | Yes | CardDAV password |

## Tools

| Tool | Description |
|------|-------------|
| `list_contacts` | List and search contacts by name, email, phone, org |
| `get_contact` | Get full contact details by UID |
| `create_contact` | Create a new contact |
| `update_contact` | Update an existing contact (merge-based) |
| `delete_contact` | Delete a contact by UID |
| `resolve_contact` | Given a name, return email address |

## License

MIT
