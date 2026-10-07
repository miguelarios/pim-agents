import { createRequire } from "node:module";
import { loadCalDavConfig } from "@miguelarios/pim-core";
import { TOOL_LIST_CACHE_HINT, registerTools, serve } from "@miguelarios/pim-core/mcp";
import { McpServer } from "@modelcontextprotocol/server";
import { CalDavService } from "./services/CalDavService.js";
import { CALENDAR_MANAGEMENT_TOOLS } from "./tools/calendarManagementTools.js";
import { CALENDAR_TOOLS } from "./tools/calendarTools.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

/**
 * Builds one server instance around a shared service. Called per connection on
 * stdio and per request over HTTP, so it must not open connections or install
 * process handlers of its own.
 */
export function createServer(service: CalDavService): McpServer {
  const server = new McpServer(
    { name: "@miguelarios/cal-mcp", title: "CalDAV Calendars", version },
    {
      capabilities: { tools: { listChanged: false } },
      instructions:
        "Read and manage CalDAV calendars across every configured provider. Calendar IDs are provider-prefixed (e.g. mailbox/Work) — call list_calendars first. delete_event asks the user to confirm whenever it removes the calendar object; excluding one occurrence of a recurring event does not. delete_calendar asks the user to confirm too, since it removes every event in the calendar. Renaming a calendar with update_calendar changes its ID.",
      cacheHints: { "tools/list": TOOL_LIST_CACHE_HINT },
    },
  );

  registerTools(server, [...CALENDAR_TOOLS, ...CALENDAR_MANAGEMENT_TOOLS], service);

  return server;
}

export async function startServer(): Promise<void> {
  const service = new CalDavService(loadCalDavConfig());

  // PIM_MCP_TRANSPORT picks stdio or Streamable HTTP; either way the entry
  // serves 2026-07-28 and 2025-era clients from the same factory.
  const handle = await serve(() => createServer(service), { name: "cal-mcp" });

  const handleShutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);
}
