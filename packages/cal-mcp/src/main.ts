import { createRequire } from "node:module";
import { loadCalDavConfig } from "@miguelarios/pim-core";
import { TOOL_LIST_CACHE_HINT, registerTools } from "@miguelarios/pim-core/mcp";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { CalDavService } from "./services/CalDavService.js";
import { CALENDAR_MANAGEMENT_TOOLS } from "./tools/calendarManagementTools.js";
import { CALENDAR_TOOLS } from "./tools/calendarTools.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export async function createServer(): Promise<McpServer> {
  const config = loadCalDavConfig();
  const service = new CalDavService(config);

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

  const handleShutdown = async () => {
    process.exit(0);
  };
  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);

  return server;
}

export async function startServer(): Promise<void> {
  // `serveStdio` owns the era decision: a 2026-07-28 client gets the new
  // protocol, and a 2025-era client is still served from the same factory.
  serveStdio(() => createServer(), {
    onerror: (error) => console.error("[cal-mcp] Server error:", error.message),
  });
  console.error("[cal-mcp] Server started on stdio");
}
