# Streamable HTTP transport

**Date:** 2026-10-07
**Packages:** `@miguelarios/pim-core`, `@miguelarios/email-mcp`, `@miguelarios/cal-mcp`, `@miguelarios/card-mcp`
**Status:** Designed and implemented

## Problem

The three servers only spoke stdio, so a client that connects by URL — a remote connector,
or anything talking to a server in a container — needed a bridge such as supergateway in
between. A bridge is a second process per server, and it is built on the 1.x SDK, so it
pins the connection to the 2025 protocol era. These servers were written for 2026-07-28,
and the bridge was the one hop the round-trip tests could not cover.

## Design

### One switch, both transports

`PIM_MCP_TRANSPORT` selects `stdio` (the default) or `http`. `serve(factory, { name })` in
`pim-core/mcp` reads it and starts the matching entry, so each `main.ts` has one serving
call and no transport logic. HTTP binds to `PIM_MCP_HTTP_HOST` / `PIM_MCP_HTTP_PORT`
(`127.0.0.1:3000`) and serves `/mcp`, plus `GET /healthz` for container health checks.
Environment variables rather than CLI flags, because every other setting these servers
take is one, and a container sets them the same way.

### Each era gets the shape it needs

- **2026-07-28** requests go to the SDK's `createMcpHandler` with `legacy: "reject"`. The
  protocol carries capabilities and the multi round-trip state in each request, so it is
  served statelessly, one server instance per request.
- **2025-era** requests are served from a **sessionful** `WebStandardStreamableHTTPServerTransport`,
  one server instance per `Mcp-Session-Id`, routed by the SDK's own `isLegacyRequest`
  predicate so the split can never disagree with the SDK's classification. Sessions idle
  for 30 minutes are closed; the client gets `404` and re-initializes, as the spec intends.

**Rejected: the SDK's default legacy fallback.** `createMcpHandler` serves 2025-era traffic
statelessly unless told not to, and that breaks `confirmDestructive` on exactly the
clients most likely to connect by URL. On that era the confirmation is a real
server-to-client `elicitation/create` sent down the POST's response stream; the client's
answer comes back as a *separate* POST, which a stateless fallback hands to a fresh
instance with no record of the question. The confirm test in `core/src/__tests__/http.test.ts`
fails against that fallback and passes against the sessionful one. Client capabilities,
which the gate reads to decide whether it may ask at all, likewise exist only on the
instance that saw `initialize`.

### The factory builds, `startServer` owns

Over HTTP the factory runs per request or per session, where stdio ran it once (twice
when a client probes for 2026-07-28 and falls back). Each `createServer` used to load
config, construct its services and add `SIGINT`/`SIGTERM` handlers, which per request
would mean a service and two listeners per call. So `createServer(services)` now only
builds the `McpServer`, and `startServer` loads config, creates the services once, serves,
and owns shutdown. A config error therefore stops the process at startup rather than
surfacing on the first connection.

### No HTTP framework

The Node binding is ~40 lines over `node:http`: headers and a streamed body into a web
`Request`, the `Response` streamed back so SSE is not buffered, and an abort when the
client disconnects. `@modelcontextprotocol/node` would do the same but brings in `hono`
as a peer, which is a framework this repo does not otherwise use.

### Origin checking, no authentication

The transport spec requires validating `Origin` against DNS rebinding. A request with an
`Origin` not listed in `PIM_MCP_HTTP_ALLOWED_ORIGINS` gets `403`; requests without one —
every non-browser client — are unaffected.

**Rejected for now: authentication in the server.** The SDK can verify bearer tokens and
publish protected-resource metadata, but an authorization server (login, client
registration, token issuance) is security-critical code that does not belong here, and
token verification only makes sense once the identity provider is chosen. Until then the
endpoint binds to loopback by default, `serve` warns when bound anywhere else, and an
OAuth proxy in front supplies authentication. Adding `requireBearerAuth` with
protected-resource metadata pointing at an external provider is the natural next step,
and fits behind the same handler without changing the transport.

## Testing

- `core/src/__tests__/http.test.ts` drives a real client over a real socket on both eras:
  tool calls, confirm, decline, a client without elicitation, one instance per 2025-era
  session, unknown and missing sessions, the origin check, and `loadTransportConfig`.
- Each server's `roundtrip.test.ts` serves its shipped `createServer` over HTTP on both
  eras; card-mcp's runs the `delete_contact` confirmation through it.
