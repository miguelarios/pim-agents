/**
 * Streamable HTTP serving: a real MCP client over a real socket, on both
 * protocol eras. The confirmation round trip is the case that shaped the
 * design — on the 2025 era it needs a sessionful transport, because the
 * client's answer to `elicitation/create` arrives as a separate POST.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigurationError } from "../errors.js";
import { type HttpServerHandle, loadTransportConfig, serveHttp } from "../mcp/http.js";
import { type ToolDef, confirmDestructive, ok, registerTools } from "../mcp/index.js";

type Era = "legacy" | "modern";

const TOOLS: ToolDef<{ remove: () => void }>[] = [
  {
    name: "echo",
    title: "Echo",
    description: "Echoes its input.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    handler: async (args: { text: string }) => ok(args.text),
  },
  {
    name: "remove",
    title: "Remove",
    description: "Irreversibly removes something.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, service, ctx) => {
      const gate = confirmDestructive(ctx, "confirm_remove", "Remove it?");
      if (gate.status === "interrupt") return gate.result;
      service.remove();
      return ok("Removed.");
    },
  },
];

const handles: HttpServerHandle[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
  await Promise.all(handles.splice(0).map((h) => h.close()));
});

async function start(service = { remove: vi.fn() }, allowedOrigins: string[] = []) {
  const factory = vi.fn(() => {
    const server = new McpServer({ name: "http-test", version: "0.0.0" });
    registerTools(server, TOOLS, service);
    return server;
  });
  const handle = await serveHttp(factory, { host: "127.0.0.1", port: 0, allowedOrigins });
  handles.push(handle);
  return { handle, service, factory };
}

async function connect(url: URL, era: Era, answer?: { confirm: boolean }) {
  const client = new Client(
    { name: "http-test-client", version: "0.0.0" },
    {
      capabilities: answer ? { elicitation: {} } : {},
      versionNegotiation: { mode: era === "modern" ? { pin: "2026-07-28" } : "legacy" },
    },
  );
  if (answer) {
    client.setRequestHandler("elicitation/create", async () => ({
      action: "accept",
      content: answer,
    }));
  }
  await client.connect(new StreamableHTTPClientTransport(url));
  clients.push(client);
  return client;
}

describe.each<Era>(["legacy", "modern"])("serveHttp (%s era)", (era) => {
  it("negotiates the era and calls a tool", async () => {
    const { handle } = await start();
    const client = await connect(handle.url, era);

    expect(client.getProtocolEra()).toBe(era);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["echo", "remove"]);

    const result = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    expect(result.content).toEqual([{ type: "text", text: "hi" }]);
  });

  it("runs the destructive operation once the user confirms", async () => {
    const { handle, service } = await start();
    const client = await connect(handle.url, era, { confirm: true });

    const result = await client.callTool({ name: "remove", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(service.remove).toHaveBeenCalledOnce();
  });

  it("does not run it when the user declines", async () => {
    const { handle, service } = await start();
    const client = await connect(handle.url, era, { confirm: false });

    const result = await client.callTool({ name: "remove", arguments: {} });

    expect(result.isError).toBe(true);
    expect(service.remove).not.toHaveBeenCalled();
  });

  it("fails fast for a client that cannot be asked", async () => {
    const { handle, service } = await start();
    const client = await connect(handle.url, era);

    const result = await client.callTool({ name: "remove", arguments: {} });

    expect(JSON.stringify(result.content)).toContain("elicitation");
    expect(service.remove).not.toHaveBeenCalled();
  });
});

describe("serveHttp endpoint", () => {
  it("keeps one server instance per 2025-era session", async () => {
    const { handle, factory } = await start();
    const client = await connect(handle.url, "legacy");

    await client.listTools();
    await client.callTool({ name: "echo", arguments: { text: "a" } });
    await client.callTool({ name: "echo", arguments: { text: "b" } });

    expect(factory).toHaveBeenCalledOnce();
  });

  it("answers the health probe", async () => {
    const { handle } = await start();
    const response = await fetch(new URL("/healthz", handle.url));
    expect(response.status).toBe(200);
  });

  it("404s other paths", async () => {
    const { handle } = await start();
    const response = await fetch(new URL("/other", handle.url), { method: "POST" });
    expect(response.status).toBe(404);
  });

  it("404s an unknown session so the client re-initializes", async () => {
    const { handle } = await start();
    const response = await fetch(handle.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "nope",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(404);
  });

  it("rejects a 2025-era request that is neither initialize nor in a session", async () => {
    const { handle } = await start();
    const response = await fetch(handle.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects a browser origin that is not allowed", async () => {
    const { handle } = await start();
    const response = await fetch(handle.url, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    });
    expect(response.status).toBe(403);
  });

  it("admits an allowed origin", async () => {
    const { handle } = await start(undefined, ["https://app.example"]);
    const response = await fetch(handle.url, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.example" },
      body: "{}",
    });
    expect(response.status).not.toBe(403);
  });
});

describe("loadTransportConfig", () => {
  it("defaults to stdio", () => {
    expect(loadTransportConfig({})).toEqual({ kind: "stdio" });
  });

  it("defaults http to loopback on port 3000", () => {
    expect(loadTransportConfig({ PIM_MCP_TRANSPORT: "http" })).toEqual({
      kind: "http",
      host: "127.0.0.1",
      port: 3000,
      allowedOrigins: [],
    });
  });

  it("reads host, port and origins", () => {
    expect(
      loadTransportConfig({
        PIM_MCP_TRANSPORT: "HTTP",
        PIM_MCP_HTTP_HOST: "0.0.0.0",
        PIM_MCP_HTTP_PORT: "8000",
        PIM_MCP_HTTP_ALLOWED_ORIGINS: "https://a.example, https://b.example,",
      }),
    ).toEqual({
      kind: "http",
      host: "0.0.0.0",
      port: 8000,
      allowedOrigins: ["https://a.example", "https://b.example"],
    });
  });

  it.each(["0", "65536", "80a", "-1", "1.5"])("rejects port %s", (port) => {
    expect(() =>
      loadTransportConfig({ PIM_MCP_TRANSPORT: "http", PIM_MCP_HTTP_PORT: port }),
    ).toThrow(ConfigurationError);
  });

  it("rejects an unknown transport", () => {
    expect(() => loadTransportConfig({ PIM_MCP_TRANSPORT: "sse" })).toThrow(ConfigurationError);
  });
});
