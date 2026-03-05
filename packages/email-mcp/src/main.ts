import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export async function createServer(): Promise<Server> {
	const server = new Server(
		{ name: "@miguelarios/email-mcp", version: "0.1.0" },
		{ capabilities: { tools: {} } },
	);

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
