# @miguelarios/card-mcp

MCP server for contacts via CardDAV — CRUD contacts, search, resolve names to emails, and manage address books.

## Protocol support

Speaks MCP revision **2026-07-28** over stdio, and still serves 2025-era clients from the same tool definitions.
Every tool declares a `title`, all four behaviour annotations, and an `outputSchema`, and returns validated `structuredContent`.

`delete_contact` and `delete_address_book` ask the user to confirm before deleting. Set `PIM_MCP_CONFIRM=off` to skip confirmation in headless use.

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
| `list_address_books` | List address books with metadata and opt-in contact counts |
| `create_address_book` | Create an address book (extended MKCOL) |
| `rename_address_book` | Rename an address book or update its description |
| `delete_address_book` | Delete an address book and its contacts (confirms first) |

Every `addressBook` parameter takes a display name (e.g. `Work`) as well as a URL.

## License

MIT
