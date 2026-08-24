import type { McpServer } from "@modelcontextprotocol/server";
/**
 * Unit coverage for the shared MCP facade's confirmation gate. The wire-level
 * behaviour is proven by each server's roundtrip test; this pins the decision
 * table the gate applies to a request's client capabilities.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  type ServerContext,
  type ToolResult,
  confirmDestructive,
  ok,
  registerTools,
} from "../mcp/index.js";

const CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

/** A 2026-07-28-era context whose request envelope declares `capabilities`. */
const modernCtx = (capabilities: Record<string, unknown>, inputResponses?: unknown) =>
  ({
    mcpReq: {
      envelope: { [CLIENT_CAPABILITIES]: capabilities },
      inputResponses,
    },
  }) as unknown as ServerContext;

/** A context carrying no capability information at all (direct dispatch, 2025 era). */
const unknownCtx = (inputResponses?: unknown) =>
  ({ mcpReq: { inputResponses } }) as unknown as ServerContext;

const gate = (ctx: ServerContext) => confirmDestructive(ctx, "confirm_delete", "Delete it?");

afterEach(() => {
  delete process.env.PIM_MCP_CONFIRM;
});

describe("confirmDestructive", () => {
  it("asks when the client declares elicitation", () => {
    const outcome = gate(modernCtx({ elicitation: {} }));
    expect(outcome.status).toBe("interrupt");
    if (outcome.status !== "interrupt") return;
    expect(
      (outcome.result as { inputRequests: Record<string, unknown> }).inputRequests.confirm_delete,
    ).toBeDefined();
  });

  it("asks when the client's capabilities are unknown", () => {
    const outcome = gate(unknownCtx());
    expect(outcome.status).toBe("interrupt");
    if (outcome.status !== "interrupt") return;
    expect((outcome.result as { inputRequests?: unknown }).inputRequests).toBeDefined();
  });

  it.each([
    ["an array", [] as unknown],
    ["a primitive", "elicitation" as unknown],
  ])("asks when the envelope's capabilities are %s", (_label, value) => {
    const outcome = gate(modernCtx(value as Record<string, unknown>));
    expect(outcome.status).toBe("interrupt");
    if (outcome.status !== "interrupt") return;
    expect((outcome.result as { inputRequests?: unknown }).inputRequests).toBeDefined();
  });

  it("asks when the envelope's capabilities are malformed", () => {
    // Not an object, so not a determination — treating it as "declared, and
    // empty" would refuse an irreversible operation on a client that may well
    // support elicitation.
    const outcome = gate(modernCtx(null as unknown as Record<string, unknown>));
    expect(outcome.status).toBe("interrupt");
    if (outcome.status !== "interrupt") return;
    expect((outcome.result as { inputRequests?: unknown }).inputRequests).toBeDefined();
  });

  it("proceeds once the user confirms", () => {
    const ctx = modernCtx(
      { elicitation: {} },
      { confirm_delete: { action: "accept", content: { confirm: true } } },
    );
    expect(gate(ctx).status).toBe("proceed");
  });

  it("does not proceed when the user declines", () => {
    const ctx = modernCtx({ elicitation: {} }, { confirm_delete: { action: "decline" } });
    const outcome = gate(ctx);
    expect(outcome.status).toBe("interrupt");
    if (outcome.status !== "interrupt") return;
    expect((outcome.result as { isError?: boolean }).isError).toBe(true);
  });

  it("proceeds without asking when PIM_MCP_CONFIRM=off", () => {
    process.env.PIM_MCP_CONFIRM = "off";
    expect(gate(modernCtx({})).status).toBe("proceed");
  });

  describe("when the client cannot be asked", () => {
    const noElicitation = () => gate(modernCtx({}));

    it("fails instead of returning an elicitation the client can never answer", () => {
      const outcome = noElicitation();
      expect(outcome.status).toBe("interrupt");
      if (outcome.status !== "interrupt") return;
      const result = outcome.result as { isError?: boolean; inputRequests?: unknown };
      expect(result.isError).toBe(true);
      expect(result.inputRequests).toBeUndefined();
    });

    it("names PIM_MCP_CONFIRM=off so the caller can unblock itself", () => {
      const outcome = noElicitation();
      if (outcome.status !== "interrupt") throw new Error("expected an interrupt");
      const [block] = (outcome.result as { content: Array<{ text: string }> }).content;
      expect(block.text).toContain("PIM_MCP_CONFIRM=off");
    });

    it("fails when the client declares a malformed elicitation capability", () => {
      // The same reasoning one level down: `elicitation: null` is not a
      // statement of support, and asking would strand the call exactly as
      // issue #22 describes.
      const outcome = gate(modernCtx({ elicitation: null }));
      expect(outcome.status).toBe("interrupt");
      if (outcome.status !== "interrupt") return;
      const [block] = (outcome.result as { content: Array<{ text: string }> }).content;
      expect(JSON.parse(block.text).error).toBe("CONFIRMATION_UNSUPPORTED");
    });

    it("reports a distinct error code", () => {
      const outcome = noElicitation();
      if (outcome.status !== "interrupt") throw new Error("expected an interrupt");
      const [block] = (outcome.result as { content: Array<{ text: string }> }).content;
      expect(JSON.parse(block.text).error).toBe("CONFIRMATION_UNSUPPORTED");
    });
  });
});

describe("client capabilities reaching the gate", () => {
  /**
   * Drives the real `registerTools` wiring so the era-bridging precedence is
   * pinned through the public surface rather than by reaching for the private
   * symbol the 2025-era capabilities are parked under.
   */
  const registerOneTool = (negotiated: Record<string, unknown> | undefined) => {
    let handler: ((args: unknown, ctx: ServerContext) => Promise<ToolResult>) | undefined;
    const server = {
      registerTool: (_name: string, _config: unknown, fn: typeof handler) => {
        handler = fn;
      },
      server: { getClientCapabilities: () => negotiated },
    } as unknown as McpServer;

    registerTools(
      server,
      [
        {
          name: "erase_it",
          title: "Erase it",
          description: "an irreversible operation",
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
          },
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          handler: async (_args: unknown, _service: unknown, ctx: ServerContext) => {
            const outcome = confirmDestructive(ctx, "confirm_erase", "Erase it?");
            return outcome.status === "proceed" ? ok("erased") : outcome.result;
          },
        },
      ],
      {},
    );

    if (!handler) throw new Error("registerTools never registered the tool");
    return { handler, request: requestCtx };
  };

  /** A request context, optionally carrying a 2026-07-28 `_meta` envelope. */
  const requestCtx = (envelope?: Record<string, unknown>) =>
    ({
      mcpReq: { ...(envelope ? { envelope } : {}), inputResponses: undefined },
    }) as unknown as ServerContext;

  const callThroughRegisterTools = async (
    negotiated: Record<string, unknown> | undefined,
    envelope: Record<string, unknown> | undefined,
  ) => {
    const { handler } = registerOneTool(negotiated);
    return handler({}, requestCtx(envelope));
  };

  const refused = (result: ToolResult) => {
    const [block] = (result as { content?: Array<{ text: string }> }).content ?? [];
    return block !== undefined && JSON.parse(block.text).error === "CONFIRMATION_UNSUPPORTED";
  };

  it("prefers the per-request envelope over the negotiated capabilities", async () => {
    // The 2025-era value is stale here: the envelope is what this request carried.
    const result = await callThroughRegisterTools(
      { elicitation: {} },
      { [CLIENT_CAPABILITIES]: {} },
    );
    expect(refused(result)).toBe(true);
  });

  it("asks when the envelope declares elicitation but the negotiated value does not", async () => {
    const result = await callThroughRegisterTools(
      {},
      { [CLIENT_CAPABILITIES]: { elicitation: {} } },
    );
    expect((result as { inputRequests?: unknown }).inputRequests).toBeDefined();
  });

  it("falls back to the negotiated capabilities when the envelope is malformed", async () => {
    // The reason the lookup reads two sources: an unreadable envelope is not a
    // dead end while the negotiated value still says something.
    const result = await callThroughRegisterTools({}, { [CLIENT_CAPABILITIES]: null });
    expect(refused(result)).toBe(true);
  });

  it("asks when a malformed envelope has no negotiated value behind it", async () => {
    const result = await callThroughRegisterTools(undefined, { [CLIENT_CAPABILITIES]: null });
    expect((result as { inputRequests?: unknown }).inputRequests).toBeDefined();
  });

  it.each([
    ["null", null],
    ["an array", [] as unknown],
    ["a primitive", 7 as unknown],
  ])("asks when the negotiated capabilities are %s", async (_label, negotiated) => {
    // The 2025-era value arrives from the SDK unvalidated, exactly like the
    // envelope does, so it has to clear the same bar before it is trusted.
    const result = await callThroughRegisterTools(
      negotiated as Record<string, unknown> | undefined,
      undefined,
    );
    expect((result as { inputRequests?: unknown }).inputRequests).toBeDefined();
  });

  it("keeps concurrent requests from seeing each other's capabilities", async () => {
    // registerTools records capabilities on the context it is handed. The SDK
    // builds a fresh one per request — verified against
    // `@modelcontextprotocol/server` 2.0.0, where two calls in flight at once
    // receive distinct `ctx` and `ctx.mcpReq` objects on both eras — so this
    // pins the half we own: the wrapper must hold no state of its own between
    // calls, or requests would answer with each other's capabilities.
    const { handler } = registerOneTool({});
    const [supported, unsupported] = await Promise.all([
      handler({}, requestCtx({ [CLIENT_CAPABILITIES]: { elicitation: {} } })),
      handler({}, requestCtx({ [CLIENT_CAPABILITIES]: {} })),
    ]);
    expect((supported as { inputRequests?: unknown }).inputRequests).toBeDefined();
    expect(refused(unsupported)).toBe(true);
  });

  it("falls back to the negotiated capabilities when there is no envelope", async () => {
    // The 2025 era, where capabilities are settled once at `initialize`.
    expect(refused(await callThroughRegisterTools({}, undefined))).toBe(true);
  });

  it("asks when neither source knows anything", async () => {
    const result = await callThroughRegisterTools(undefined, undefined);
    expect((result as { inputRequests?: unknown }).inputRequests).toBeDefined();
  });
});
