import { createRequire } from "node:module";
import { loadCardDavConfig } from "@miguelarios/pim-core";
import { TOOL_LIST_CACHE_HINT, registerTools } from "@miguelarios/pim-core/mcp";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { CardDavService } from "./services/CardDavService.js";
import { CONTACT_TOOLS } from "./tools/contactTools.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export async function createServer(): Promise<McpServer> {
  const config = loadCardDavConfig();
  const service = new CardDavService(config);

  const server = new McpServer(
    { name: "@miguelarios/card-mcp", title: "CardDAV Contacts", version },
    {
      capabilities: { tools: { listChanged: false } },
      instructions:
        "Read and manage CardDAV contacts. Use resolve_contact to turn a person's name into an email address before composing mail. delete_contact asks the user to confirm before deleting.",
      cacheHints: { "tools/list": TOOL_LIST_CACHE_HINT },
    },
  );

  registerTools(server, CONTACT_TOOLS, service);

  const handleShutdown = async () => {
    await service.disconnect();
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
    onerror: (error) => console.error("[card-mcp] Server error:", error.message),
  });
  console.error("[card-mcp] Server started on stdio");
}
