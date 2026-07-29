# @miguelarios/cal-mcp

MCP server for calendars via CalDAV — query, create, and manage events across one or more providers, including recurrence, attendees, alarms, and free/busy lookups.

## Protocol support

Speaks MCP revision **2026-07-28** over stdio, and still serves 2025-era clients from the same tool definitions.
Every tool declares a `title`, all four behaviour annotations, and an `outputSchema`, and returns validated `structuredContent`.

`delete_event` with `span: "all"` asks the user to confirm before removing a whole series; deleting a single occurrence does not. Set `PIM_MCP_CONFIRM=off` to skip confirmation in headless use.

## Usage

```bash
npx @miguelarios/cal-mcp
```

## Configuration

Add the server to your MCP client config (Claude Desktop, Claude Code, etc.). Credentials are passed via environment variables. Configure one or more CalDAV accounts using prefixed env vars — the `<ID>` becomes the provider identifier.

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

Optional env vars: `PIM_TIMEZONE`.

## Tools (11)

See [docs/tools/cal-mcp.md](../../docs/tools/cal-mcp.md) for full parameter and output details.

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
| `delete_event` | Delete event by UID or single recurrence instance |
| `create_events_batch` | Create multiple events at once |
| `import_ics` | Import events from .ics content |
| `find_free_slots` | Find available time slots across calendars |

## License

MIT
