import {
  type CallToolResult,
  type ClientCapabilities,
  type InputRequiredResult,
  type JsonSchemaType,
  type McpServer,
  type ServerContext,
  type ToolAnnotations,
  fromJsonSchema,
  inputRequired,
  inputResponse,
} from "@modelcontextprotocol/server";
/**
 * Shared MCP plumbing for the PIM servers, built on the 2026-07-28 protocol
 * revision. Kept behind the `@miguelarios/pim-core/mcp` subpath so consumers of
 * the main entry point do not pull in the MCP SDK.
 */
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import type { GenericSchema } from "valibot";
import { type PimError, toPimError } from "../errors.js";

/** Result a tool handler may return: a finished call, or a request for more input. */
export type ToolResult = CallToolResult | InputRequiredResult;

// Re-exported so tool modules can type their results without importing the SDK
// directly — this module is the servers' MCP facade.
export type {
  CallToolResult,
  ClientCapabilities,
  InputRequiredResult,
  ServerContext,
  ToolAnnotations,
};

/**
 * A declarative tool definition.
 *
 * Tools stay an inspectable array rather than a pile of `registerTool` calls so
 * they can be asserted over in tests and registered in one place.
 */
// `Args` defaults to `any` so a heterogeneous
// `ToolDef<Service>[]` can hold handlers that each declare their own argument type. The SDK
// validates arguments against `inputSchema` before the handler runs, so the declared type is
// a documentation and authoring aid rather than the safety boundary.
export interface ToolDef<Service, Args = any> {
  /** Wire name. Must match the spec's `[A-Za-z0-9_.-]`, 1-128 character rule. */
  name: string;
  /** Human-readable display name shown by clients. */
  title: string;
  description: string;
  /**
   * Behaviour hints. Clients use these to decide what to put in front of the
   * user — a host may auto-approve a read-only tool and confirm a destructive
   * one. All four hints are required here so none is forgotten.
   */
  annotations: Required<
    Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint" | "idempotentHint" | "openWorldHint">
  >;
  /** Raw JSON Schema for the arguments. Validated before the handler runs. */
  inputSchema: JsonSchemaType;
  /** Valibot schema describing `structuredContent`. Validated before the result leaves the server. */
  outputSchema?: GenericSchema;
  handler: (args: Args, service: Service, ctx: ServerContext) => Promise<ToolResult>;
}

/**
 * Registers every tool against an {@link McpServer}. The SDK derives argument
 * validation from `inputSchema` and validates `structuredContent` against
 * `outputSchema`, so handlers receive checked arguments and cannot emit a
 * result that contradicts its advertised schema.
 */
export function registerTools<Service>(
  server: McpServer,
  defs: ReadonlyArray<ToolDef<Service>>,
  service: Service,
): void {
  for (const def of defs) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        annotations: def.annotations,
        inputSchema: fromJsonSchema(def.inputSchema),
        ...(def.outputSchema ? { outputSchema: toStandardJsonSchema(def.outputSchema) } : {}),
      },
      // the SDK infers handler args from the
      // schema generic; the per-tool `Args` type is asserted by each tool module instead.
      (args: any, ctx: ServerContext) =>
        def.handler(args, service, withClientCapabilities(server, ctx)),
    );
  }
}

/** A handler context carrying no multi round-trip input responses. */
const EMPTY_CTX = { mcpReq: { inputResponses: undefined } } as unknown as ServerContext;

/**
 * Invokes one tool's handler by name, bypassing the MCP transport.
 *
 * Useful for testing handlers in isolation and for embedding the tools without
 * a protocol layer. Argument validation lives in the SDK's `tools/call` path,
 * so callers of this function are responsible for passing well-formed `args`.
 */
export function dispatchTool<Service>(
  defs: ReadonlyArray<ToolDef<Service>>,
  name: string,
  args: Record<string, unknown>,
  service: Service,
  ctx: ServerContext = EMPTY_CTX,
): Promise<ToolResult> {
  const tool = defs.find((def) => def.name === name);
  if (!tool) {
    return Promise.resolve(fail("UNKNOWN_TOOL", `Unknown tool: ${name}`));
  }
  return tool.handler(args, service, ctx);
}

/** A successful result carrying only human-readable text. */
export function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * A successful result carrying machine-readable data.
 *
 * The spec requires a tool returning structured content to also return the
 * serialized JSON in a text block, for clients that do not read
 * `structuredContent`.
 */
export function structured<T>(payload: T): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as CallToolResult["structuredContent"],
  };
}

/** A tool execution error the model can read and self-correct from. */
export function fail(code: string, message: string, retryable = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: code, message, retryable }) }],
    isError: true,
  };
}

/**
 * Converts a thrown error into a tool execution error.
 *
 * Unlike the previous per-package handling, the {@link PimError} code survives
 * to the client instead of being flattened into a bare string. `mapCode` lets a
 * server keep its own external code vocabulary.
 */
export function toolError(err: unknown, mapCode?: (error: PimError) => string): CallToolResult {
  const pimError = toPimError(err instanceof Error ? err : new Error(String(err)));
  return fail(mapCode ? mapCode(pimError) : pimError.code, pimError.message, pimError.isRetryable);
}

/** The `_meta` envelope key carrying the client's declared capabilities (2026-07-28). */
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

/** Where {@link withClientCapabilities} parks the 2025-era capabilities on a context. */
const CAPABILITIES = Symbol("pim.clientCapabilities");

type CapabilityCarrier = { [CAPABILITIES]?: ClientCapabilities };

/**
 * Records the client's declared capabilities on a 2025-era context.
 *
 * On that era capabilities are negotiated once, at `initialize`, and never
 * reach the per-request context — so the server's view of them is attached
 * here for {@link clientCapabilities} to read back. 2026-07-28 requests carry
 * their own copy in the `_meta` envelope and take precedence.
 *
 * Writing to the context is safe because the SDK builds a fresh one per
 * request: two calls in flight at once were confirmed to receive distinct
 * `ctx` and `ctx.mcpReq` objects on both eras, so this cannot race.
 */
function withClientCapabilities(server: McpServer, ctx: ServerContext): ServerContext {
  (ctx as ServerContext & CapabilityCarrier)[CAPABILITIES] = server.server.getClientCapabilities();
  return ctx;
}

/**
 * The client capabilities in force for this request, or `undefined` when they
 * cannot be determined — as is the case for {@link dispatchTool}, which has no
 * client at all.
 *
 * A client that declares nothing yields `{}`, which is a determination: it
 * means the client supports no optional capability, not that we failed to look.
 * A malformed value is not a determination, and falls through to `undefined`
 * rather than being read as "declared, and empty".
 *
 * Both lookups read SDK surface that the published type declarations erase, so
 * an SDK upgrade should re-check them — last verified against
 * `@modelcontextprotocol/server` 2.0.0, where the 2026-07-28 era carries
 * capabilities in the envelope and returns `undefined` from
 * `getClientCapabilities()`, and the 2025 era does the reverse. A regression
 * there degrades to `undefined`, which restores the previous always-ask
 * behaviour rather than skipping a confirmation.
 */
function clientCapabilities(ctx: ServerContext): ClientCapabilities | undefined {
  const { envelope } = ctx.mcpReq as { envelope?: Record<string, unknown> };
  const declared = asObject(envelope?.[CLIENT_CAPABILITIES_KEY]);
  if (declared) return declared as ClientCapabilities;
  return (ctx as ServerContext & CapabilityCarrier)[CAPABILITIES];
}

/**
 * `value` as a plain object, or `undefined` when it is not one.
 *
 * The capabilities map and the `elicitation` capability inside it are both
 * objects per the spec, so anything else — `null`, an array, a primitive — is
 * malformed rather than something the client stated, and is read as silence.
 */
function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** The outcome of a {@link confirmDestructive} gate. */
export type ConfirmOutcome =
  | { status: "proceed" }
  /** Return `result` from the handler unchanged. */
  | { status: "interrupt"; result: ToolResult };

/**
 * Gates an irreversible operation behind user confirmation, using the
 * 2026-07-28 multi round-trip request pattern: the first call returns
 * `resultType: "input_required"` with an elicitation, and the client retries
 * with the answer.
 *
 * Works on 2025-era connections too — the SDK's legacy shim turns the
 * `input_required` return into a real server-to-client `elicitation/create`
 * and re-enters the handler, so this needs no era branching.
 *
 * A client that never declared the `elicitation` capability cannot answer, so
 * it is failed with `CONFIRMATION_UNSUPPORTED` rather than handed a question
 * that goes nowhere. Capabilities we cannot read at all are gated as usual —
 * unknown is not the same as unsupported, and the safe reading is to ask.
 *
 * Set `PIM_MCP_CONFIRM=off` to skip confirmation entirely (headless use).
 */
export function confirmDestructive(
  ctx: ServerContext,
  key: string,
  message: string,
): ConfirmOutcome {
  if (process.env.PIM_MCP_CONFIRM === "off") return { status: "proceed" };

  const view = inputResponse(ctx.mcpReq.inputResponses, key);

  if (view.kind === "elicit") {
    if (view.action === "accept" && view.content?.confirm === true) {
      return { status: "proceed" };
    }
    // Declined, cancelled, or answered "no". Do NOT re-ask — re-issuing the
    // elicitation here would loop until the client's round limit.
    return {
      status: "interrupt",
      result: fail("CONFIRMATION_DECLINED", "Cancelled: the user did not confirm this operation."),
    };
  }

  const capabilities = clientCapabilities(ctx);
  if (capabilities !== undefined && asObject(capabilities.elicitation) === undefined) {
    // Asking would return an `input_required` the client can never answer, so
    // the operation would simply be unusable. Fail with a way out instead.
    //
    // Note the deliberate asymmetry with `clientCapabilities`, which treats a
    // malformed capabilities map as silence and asks: there, nothing legible
    // was said at all. Here a legible map simply does not carry elicitation,
    // which is a statement. Making the two symmetric would send the second
    // case back to asking a client that cannot answer — the hang in #22.
    return {
      status: "interrupt",
      result: fail(
        "CONFIRMATION_UNSUPPORTED",
        "This operation is irreversible and requires confirmation, but the client did not " +
          'declare the "elicitation" capability, so it cannot be asked. Set PIM_MCP_CONFIRM=off ' +
          "to run irreversible operations without confirmation.",
      ),
    };
  }

  return {
    status: "interrupt",
    result: inputRequired({
      inputRequests: {
        [key]: inputRequired.elicit({
          message,
          requestedSchema: {
            type: "object",
            properties: {
              confirm: {
                type: "boolean",
                title: "Confirm",
                description: "Set to true to proceed with this irreversible operation.",
              },
            },
            required: ["confirm"],
          },
        }),
      },
    }),
  };
}

/**
 * Cache hints for `tools/list`. Our tool lists are static and identical for
 * every caller, so they are safe for shared caches. Only ever emitted on
 * 2026-07-28 connections; 2025-era responses are unaffected.
 */
export const TOOL_LIST_CACHE_HINT = { ttlMs: 3_600_000, cacheScope: "public" } as const;
