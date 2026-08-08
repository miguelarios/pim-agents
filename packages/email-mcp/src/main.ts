import { createRequire } from "node:module";
import { loadEmailConfig } from "@miguelarios/pim-core";
import { TOOL_LIST_CACHE_HINT, registerTools } from "@miguelarios/pim-core/mcp";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { disposeUrlCleaner } from "./htmlToMarkdown.js";
import { ImapService } from "./services/ImapService.js";
import { SmtpService } from "./services/SmtpService.js";
import { EMAIL_TOOLS } from "./tools/emailTools.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export async function createServer(): Promise<McpServer> {
  const config = loadEmailConfig();
  const services = {
    imap: new ImapService(config),
    smtp: new SmtpService(config),
  };

  const server = new McpServer(
    { name: "@miguelarios/email-mcp", title: "IMAP/SMTP Email", version },
    {
      capabilities: { tools: { listChanged: false } },
      instructions:
        "Read, search and send email over IMAP/SMTP. Folder paths are IMAP paths and default to INBOX — call list_folders to discover them. send_email, send_draft and permanent deletes ask the user to confirm first.",
      cacheHints: { "tools/list": TOOL_LIST_CACHE_HINT },
    },
  );

  registerTools(server, EMAIL_TOOLS, services);

  const handleShutdown = async () => {
    await disposeUrlCleaner();
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
    onerror: (error) => console.error("[email-mcp] Server error:", error.message),
  });
  console.error("[email-mcp] Server started on stdio");
}
