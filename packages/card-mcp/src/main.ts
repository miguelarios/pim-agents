import { createRequire } from "node:module";
import { loadCardDavConfig } from "@miguelarios/pim-core";
import { TOOL_LIST_CACHE_HINT, registerTools, serve } from "@miguelarios/pim-core/mcp";
import { McpServer } from "@modelcontextprotocol/server";
import { CardDavService } from "./services/CardDavService.js";
import { CARD_TOOLS } from "./tools/index.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

/**
 * Builds one server instance around a shared service. Called per connection on
 * stdio and per request over HTTP, so it must not open connections or install
 * process handlers of its own.
 */
export function createServer(service: CardDavService): McpServer {
  const server = new McpServer(
    { name: "@miguelarios/card-mcp", title: "CardDAV Contacts", version },
    {
      capabilities: { tools: { listChanged: false } },
      instructions:
        "Read and manage CardDAV contacts and address books. Use resolve_contact to turn a person's name into an email address before composing mail. Call list_address_books to discover the account's books, then pass a book's name (or URL) as addressBook to any contact tool. delete_contact and delete_address_book ask the user to confirm first.",
      cacheHints: { "tools/list": TOOL_LIST_CACHE_HINT },
    },
  );

  registerTools(server, CARD_TOOLS, service);

  return server;
}

export async function startServer(): Promise<void> {
  // CARDDAV_SERVER_SEARCH=off is the escape hatch for a server whose
  // addressbook-query filtering answers wrongly rather than not at all.
  const service = new CardDavService(loadCardDavConfig(), {
    serverSearch: process.env.CARDDAV_SERVER_SEARCH?.toLowerCase() !== "off",
  });

  // PIM_MCP_TRANSPORT picks stdio or Streamable HTTP; either way the entry
  // serves 2026-07-28 and 2025-era clients from the same factory.
  const handle = await serve(() => createServer(service), { name: "card-mcp" });

  const handleShutdown = async () => {
    await handle.close();
    await service.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);
}
