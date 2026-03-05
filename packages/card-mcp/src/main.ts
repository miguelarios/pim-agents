import { loadCardDavConfig, toPimError } from "@miguelarios/pim-core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CardDavService } from "./services/CardDavService.js";
import { CONTACT_TOOLS, handleContactTool } from "./tools/contactTools.js";

export async function createServer(): Promise<Server> {
  const config = loadCardDavConfig();
  const service = new CardDavService(config);

  const server = new Server(
    { name: "@miguelarios/card-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: CONTACT_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleContactTool(name, (args ?? {}) as Record<string, unknown>, service);
  });

  const handleShutdown = async () => {
    await service.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);

  server.onerror = (error) => {
    console.error("[card-mcp] Server error:", error.message);
  };

  return server;
}

export async function startServer(): Promise<void> {
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[card-mcp] Server started on stdio");
}
