# @miguelarios/cal-mcp

MCP server for calendars via CalDAV — query, create, and manage events across one or more providers, including recurrence, attendees, alarms, and free/busy lookups.

## Protocol support

Speaks MCP revision **2026-07-28** over stdio or Streamable HTTP, and still serves 2025-era clients from the same tool definitions.
Every tool declares a `title`, all four behaviour annotations, and an `outputSchema`, and returns validated `structuredContent`.

`delete_event` asks the user to confirm whenever it removes the calendar object — `span: "all"`, and `span: "this"` on a non-recurring event. Excluding one occurrence of a recurring event is recoverable and is not gated. `delete_calendar` always asks, and so does an `update_event` with `span: "future"` that would drop per-occurrence changes. Set `PIM_MCP_CONFIRM=off` to skip confirmation in headless use.

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

Optional env vars:

- `PIM_TIMEZONE` — IANA timezone used for "today", free-slot searches and local times. Defaults to the host timezone, which in a container is usually UTC.
- `CAL_MCP_DEBUG` — set to `1` to attach per-step CalDAV timings to tool results under `_meta`.

## Over HTTP and in Docker

Set `PIM_MCP_TRANSPORT=http` to serve Streamable HTTP at `/mcp` instead of stdio — for a client that connects by URL, or a server in a container. `PIM_MCP_HTTP_HOST` (default `127.0.0.1`) and `PIM_MCP_HTTP_PORT` (default `3000`) set where it listens, and `GET /healthz` answers `ok` for health checks. **The HTTP server does no authentication**: keep it on loopback or a private network, and put an OAuth proxy in front before exposing it further.

```bash
docker run -d --name cal-mcp --restart unless-stopped --user node \
  --env-file cal.env \
  -e PIM_MCP_TRANSPORT=http -e PIM_MCP_HTTP_HOST=0.0.0.0 \
  -p 127.0.0.1:3002:3000 -v cal-mcp-home:/home/node \
  node:22-alpine npx -y @miguelarios/cal-mcp@0.20.0
```

See the [Docker guide](https://github.com/miguelarios/pim-agents/blob/main/docs/docker.md) for the env file, stdio use from a desktop client, Docker Compose, and exposing a server safely, and the [README](https://github.com/miguelarios/pim-agents/blob/main/README.md#over-streamable-http) for every HTTP setting.

## Tools (16)

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
| `get_free_busy` | Busy periods in a range, typed, without event details |
| `create_calendar` | Create a calendar collection |
| `update_calendar` | Rename or recolour a calendar |
| `delete_calendar` | Delete a calendar and every event in it |

## License

MIT
