# @miguelarios/pim-core

Shared config, validation, errors, and utilities for PIM agent MCP servers.

This is an internal library used by [@miguelarios/email-mcp](https://www.npmjs.com/package/@miguelarios/email-mcp), [@miguelarios/cal-mcp](https://www.npmjs.com/package/@miguelarios/cal-mcp), and [@miguelarios/card-mcp](https://www.npmjs.com/package/@miguelarios/card-mcp). You probably don't need to install this directly.

## Entry points

| Import | Contents |
|--------|----------|
| `@miguelarios/pim-core` | Config loading, `PimError` hierarchy and `ErrorCode`, vCard parse/build, timezone helpers |
| `@miguelarios/pim-core/ics` | iCalendar parsing, generation, and component mutation |
| `@miguelarios/pim-core/mcp` | MCP plumbing for revision 2026-07-28 — `ToolDef`, `registerTools`, `dispatchTool`, result helpers (`structured`, `fail`, `toolError`), and `confirmDestructive` |

Only the `/mcp` subpath pulls in `@modelcontextprotocol/server`; the other two are protocol-agnostic.

## License

MIT
