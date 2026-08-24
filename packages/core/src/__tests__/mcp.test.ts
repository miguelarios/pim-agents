/**
 * Unit coverage for the shared MCP facade's confirmation gate. The wire-level
 * behaviour is proven by each server's roundtrip test; this pins the decision
 * table the gate applies to a request's client capabilities.
 */
import { afterEach, describe, expect, it } from "vitest";
import { type ServerContext, confirmDestructive } from "../mcp/index.js";

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

    it("reports a distinct error code", () => {
      const outcome = noElicitation();
      if (outcome.status !== "interrupt") throw new Error("expected an interrupt");
      const [block] = (outcome.result as { content: Array<{ text: string }> }).content;
      expect(JSON.parse(block.text).error).toBe("CONFIRMATION_UNSUPPORTED");
    });
  });
});
