import { loadEmailConfig } from "@miguelarios/pim-core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ImapService } from "./services/ImapService.js";
import { SmtpService } from "./services/SmtpService.js";
import { EMAIL_TOOLS, handleEmailTool } from "./tools/emailTools.js";

export async function createServer(): Promise<Server> {
  const config = loadEmailConfig();
  const imapService = new ImapService(config);
  const smtpService = new SmtpService(config);

  const server = new Server(
    { name: "@miguelarios/email-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: EMAIL_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleEmailTool(name, (args ?? {}) as Record<string, unknown>, imapService, smtpService);
  });

  const handleShutdown = async () => {
    process.exit(0);
  };
  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);

  server.onerror = (error) => {
    console.error("[email-mcp] Server error:", error.message);
  };

  return server;
}

export async function startServer(): Promise<void> {
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[email-mcp] Server started on stdio");
}
