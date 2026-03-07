import { loadCalDavConfig } from "@miguelarios/pim-core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CalDavService } from "./services/CalDavService.js";
import { CALENDAR_TOOLS, handleCalendarTool } from "./tools/calendarTools.js";

export async function createServer(): Promise<Server> {
  const config = loadCalDavConfig();
  const service = new CalDavService(config);

  const server = new Server(
    { name: "@miguelarios/cal-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: CALENDAR_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleCalendarTool(name, (args ?? {}) as Record<string, unknown>, service);
  });

  const handleShutdown = async () => {
    process.exit(0);
  };
  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);

  server.onerror = (error) => {
    console.error("[cal-mcp] Server error:", error.message);
  };

  return server;
}

export async function startServer(): Promise<void> {
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[cal-mcp] Server started on stdio");
}
