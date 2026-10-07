import { randomUUID } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import {
  type McpServerFactory,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isInitializeRequest,
  isLegacyRequest,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ConfigurationError } from "../errors.js";

/**
 * Serving the PIM servers over Streamable HTTP, next to stdio.
 *
 * The two protocol eras need different shapes over HTTP:
 *
 * - 2026-07-28 requests carry everything in a per-request envelope, so the
 *   SDK's `createMcpHandler` serves them statelessly, one instance per request.
 *   Confirmations use the multi round-trip pattern, which needs no session.
 * - 2025-era requests are served from a **sessionful** transport, one instance
 *   per session. The SDK's built-in legacy fallback is stateless, and that
 *   breaks `confirmDestructive`: the confirmation is a server-to-client
 *   `elicitation/create`, whose answer arrives as a separate POST that a
 *   stateless fallback hands to a fresh instance with no record of the
 *   question — so the tool call hangs. Client capabilities, which the gate
 *   reads to decide whether to ask at all, likewise only exist on the instance
 *   that saw `initialize`.
 *
 * No authentication is performed here. Exposed beyond loopback, this endpoint
 * belongs behind an OAuth proxy.
 */

/** Where the MCP endpoint is served. */
export const MCP_HTTP_PATH = "/mcp";

/** Liveness probe for container health checks. Touches no upstream service. */
export const HEALTH_PATH = "/healthz";

/** A 2025-era session idle this long is closed; the client re-initializes. */
const DEFAULT_SESSION_IDLE_MS = 30 * 60_000;

export type TransportConfig =
  | { kind: "stdio" }
  | {
      kind: "http";
      host: string;
      port: number;
      /** Browser origins allowed to call the endpoint. Requests without `Origin` are always allowed. */
      allowedOrigins: string[];
    };

/**
 * Reads the transport selection from the environment.
 *
 * - `PIM_MCP_TRANSPORT` — `stdio` (default) or `http`
 * - `PIM_MCP_HTTP_HOST` — bind address, default `127.0.0.1`
 * - `PIM_MCP_HTTP_PORT` — default `3000`
 * - `PIM_MCP_HTTP_ALLOWED_ORIGINS` — comma-separated browser origins to admit
 */
export function loadTransportConfig(
  env: Record<string, string | undefined> = process.env,
): TransportConfig {
  const kind = (env.PIM_MCP_TRANSPORT || "stdio").trim().toLowerCase();
  if (kind === "stdio") return { kind: "stdio" };
  if (kind !== "http") {
    throw new ConfigurationError(
      `PIM_MCP_TRANSPORT must be "stdio" or "http", got "${env.PIM_MCP_TRANSPORT}"`,
    );
  }

  const rawPort = (env.PIM_MCP_HTTP_PORT || "3000").trim();
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) {
    throw new ConfigurationError(`PIM_MCP_HTTP_PORT must be a port number, got "${rawPort}"`);
  }

  return {
    kind: "http",
    host: env.PIM_MCP_HTTP_HOST?.trim() || "127.0.0.1",
    port,
    allowedOrigins: (env.PIM_MCP_HTTP_ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  };
}

export interface HttpHandlerOptions {
  allowedOrigins?: string[];
  onerror?: (error: Error) => void;
  /** Close a 2025-era session after this long without a request. */
  sessionIdleMs?: number;
}

/** A web-standard handler for the MCP endpoint, independent of any HTTP server. */
export interface PimHttpHandler {
  fetch: (request: Request) => Promise<Response>;
  /** Number of open 2025-era sessions. */
  readonly sessionCount: number;
  close: () => Promise<void>;
}

interface LegacySession {
  transport: WebStandardStreamableHTTPServerTransport;
  lastSeen: number;
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });
}

export function createHttpHandler(
  factory: McpServerFactory,
  options: HttpHandlerOptions = {},
): PimHttpHandler {
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const idleMs = options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
  const report = (error: Error) => options.onerror?.(error);

  const modern = createMcpHandler(factory, { legacy: "reject", onerror: report });
  const sessions = new Map<string, LegacySession>();

  const closeSession = (id: string) => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    session.transport.close().catch((error) => report(error as Error));
  };

  const sweep = setInterval(
    () => {
      const cutoff = Date.now() - idleMs;
      for (const [id, session] of sessions) {
        if (session.lastSeen < cutoff) closeSession(id);
      }
    },
    Math.min(idleMs, 60_000),
  );
  sweep.unref();

  const openLegacySession = async (request: Request): Promise<Response> => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, lastSeen: Date.now() });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const product = await factory({ era: "legacy", requestInfo: request });
    await product.connect(transport);
    return transport.handleRequest(request);
  };

  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === HEALTH_PATH && request.method === "GET") {
      return new Response("ok", { status: 200 });
    }
    if (url.pathname !== MCP_HTTP_PATH) {
      return new Response("Not Found", { status: 404 });
    }

    // The spec requires validating Origin against DNS rebinding: a browser page
    // always sends one, and no legitimate non-browser client needs to.
    const origin = request.headers.get("origin");
    if (origin !== null && !allowedOrigins.has(origin)) {
      return jsonRpcError(403, -32000, "Forbidden: origin not allowed.");
    }

    try {
      const sessionId = request.headers.get("mcp-session-id");
      if (sessionId !== null) {
        const session = sessions.get(sessionId);
        if (!session) return jsonRpcError(404, -32001, "Session not found.");
        session.lastSeen = Date.now();
        return await session.transport.handleRequest(request);
      }

      if (!(await isLegacyRequest(request))) return await modern.fetch(request);

      if (request.method === "POST") {
        const body = await request
          .clone()
          .json()
          .catch(() => undefined);
        if (isInitializeRequest(body)) return await openLegacySession(request);
      }
      return jsonRpcError(400, -32000, "Bad Request: no valid session ID provided.");
    } catch (error) {
      report(error as Error);
      return jsonRpcError(500, -32603, "Internal server error.");
    }
  };

  return {
    fetch,
    get sessionCount() {
      return sessions.size;
    },
    close: async () => {
      clearInterval(sweep);
      for (const id of [...sessions.keys()]) closeSession(id);
      await modern.close();
    },
  };
}

/** Converts a Node request to a web `Request`, aborting it if the client goes away. */
function toWebRequest(req: IncomingMessage, res: ServerResponse): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }

  const controller = new AbortController();
  res.on("close", () => controller.abort());

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
    signal: controller.signal,
    // Required by Node's fetch whenever the body is a stream.
    duplex: "half",
  } as RequestInit);
}

/** Writes a web `Response` to a Node response, streaming the body (SSE included). */
async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  res.on("close", () => body.destroy());
  body.on("error", () => res.destroy());
  body.pipe(res);
}

export interface HttpServerHandle {
  /** The bound address, e.g. `http://127.0.0.1:3000/mcp`. */
  url: URL;
  close: () => Promise<void>;
}

/** Binds {@link createHttpHandler} to a Node HTTP server. */
export async function serveHttp(
  factory: McpServerFactory,
  options: HttpHandlerOptions & { host: string; port: number },
): Promise<HttpServerHandle> {
  const handler = createHttpHandler(factory, options);

  const server = createServer((req, res) => {
    handler
      .fetch(toWebRequest(req, res))
      .then((response) => writeWebResponse(response, res))
      .catch((error) => {
        options.onerror?.(error as Error);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;

  return {
    url: new URL(`http://${host}:${address.port}${MCP_HTTP_PATH}`),
    close: async () => {
      await handler.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Serves `factory` over the transport `PIM_MCP_TRANSPORT` selects.
 *
 * Both entries own the era decision: a 2026-07-28 client gets the new
 * protocol, and a 2025-era client is still served from the same factory.
 */
export async function serve(
  factory: McpServerFactory,
  options: { name: string; env?: Record<string, string | undefined> },
): Promise<{ close: () => Promise<void> }> {
  const { name } = options;
  const config = loadTransportConfig(options.env);
  const onerror = (error: Error) => console.error(`[${name}] Server error:`, error.message);

  if (config.kind === "stdio") {
    const handle = serveStdio(factory, { onerror });
    console.error(`[${name}] Server started on stdio`);
    return handle;
  }

  const handle = await serveHttp(factory, { ...config, onerror });
  console.error(`[${name}] Server started on ${handle.url.href}`);
  if (!LOOPBACK.has(config.host)) {
    console.error(
      `[${name}] Listening beyond loopback with no authentication — put an OAuth proxy in front of it.`,
    );
  }
  return handle;
}
