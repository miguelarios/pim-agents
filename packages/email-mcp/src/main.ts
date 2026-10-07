import { createRequire } from "node:module";
import { loadEmailConfig } from "@miguelarios/pim-core";
import { TOOL_LIST_CACHE_HINT, registerTools, serve } from "@miguelarios/pim-core/mcp";
import { McpServer } from "@modelcontextprotocol/server";
import { disposeUrlCleaner, disposeUrlProxy } from "./htmlToMarkdown.js";
import { registerImapResources } from "./resources/imapResources.js";
import { ImapService } from "./services/ImapService.js";
import { SmtpService } from "./services/SmtpService.js";
import { EMAIL_TOOLS, type EmailServices } from "./tools/emailTools.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

/**
 * Builds one server instance around shared services. Called per connection on
 * stdio and per request over HTTP, so it must not open connections or install
 * process handlers of its own.
 */
export function createServer(services: EmailServices): McpServer {
  const server = new McpServer(
    { name: "@miguelarios/email-mcp", title: "IMAP/SMTP Email", version },
    {
      capabilities: {
        tools: { listChanged: false },
        // Attachment and message URIs are addressable but not enumerable, so
        // there is no list to change.
        resources: { listChanged: false },
      },
      instructions:
        "Read, search and send email over IMAP/SMTP. Folder paths are IMAP paths and default to INBOX — call list_folders to discover them. send_email, send_draft and permanent deletes ask the user to confirm first. Attachments and message sources are also addressable as imap:// resources, so their bytes can be fetched with resources/read instead of through a tool result.",
      cacheHints: { "tools/list": TOOL_LIST_CACHE_HINT },
    },
  );

  registerTools(server, EMAIL_TOOLS, services);
  registerImapResources(server, services.imap);

  return server;
}

export async function startServer(): Promise<void> {
  const config = loadEmailConfig();
  const services = {
    imap: new ImapService(config),
    smtp: new SmtpService(config),
  };

  // PIM_MCP_TRANSPORT picks stdio or Streamable HTTP; either way the entry
  // serves 2026-07-28 and 2025-era clients from the same factory.
  const handle = await serve(() => createServer(services), { name: "email-mcp" });

  const handleShutdown = async () => {
    await handle.close();
    await Promise.all([disposeUrlCleaner(), disposeUrlProxy()]);
    process.exit(0);
  };
  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);
}
