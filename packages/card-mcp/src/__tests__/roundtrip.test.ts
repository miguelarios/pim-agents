/**
 * End-to-end wire conformance: a real MCP client talking to the real server
 * over an in-memory transport pair, on both protocol eras.
 *
 * Everything else in this package tests handlers directly, which cannot catch
 * schema advertisement, argument validation, or the multi round-trip flow.
 */
import { TOOL_LIST_CACHE_HINT, registerTools } from "@miguelarios/pim-core/mcp";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CardDavService } from "../services/CardDavService.js";
import { CARD_TOOLS } from "../tools/index.js";

const CONTACT = {
  uid: "u1",
  fullName: "Ada Lovelace",
  emails: [{ type: "work", value: "ada@example.com" }],
  phones: [],
  addresses: [],
  urls: [],
  otherProperties: [],
};

function fakeService() {
  return {
    listAddressBooks: vi.fn().mockResolvedValue([{ url: "book1", displayName: "Personal" }]),
    findAddressBook: vi.fn().mockImplementation(async (ref: string) => ref),
    findAddressBookEntry: vi
      .fn()
      .mockImplementation(async (ref: string) => ({ displayName: ref, url: ref })),
    fetchContacts: vi.fn().mockResolvedValue([CONTACT]),
    searchContacts: vi.fn().mockResolvedValue([CONTACT]),
    deleteContact: vi.fn().mockResolvedValue(undefined),
    updateContact: vi.fn().mockResolvedValue(undefined),
    createAddressBook: vi.fn().mockResolvedValue({ url: "/dav/team/", displayName: "Team" }),
    renameAddressBook: vi.fn().mockResolvedValue(undefined),
    deleteAddressBook: vi.fn().mockResolvedValue(undefined),
    countContacts: vi.fn().mockResolvedValue(2),
    moveContacts: vi.fn().mockResolvedValue({ transferred: [{ uid: "uid-1" }], failed: [] }),
    copyContacts: vi
      .fn()
      .mockResolvedValue({ transferred: [{ uid: "uid-1", newUid: "uid-copy" }], failed: [] }),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

type Era = "legacy" | "modern";
/**
 * How the test client answers a confirmation. `unsupported` is not an answer
 * but a client shape: one that never declared the `elicitation` capability.
 */
type ElicitAnswer =
  | { action: "accept"; content: { confirm: boolean } }
  | { action: "decline" }
  | { action: "unsupported" };

const open = async (
  era: Era,
  service: ReturnType<typeof fakeService>,
  answer: ElicitAnswer = { action: "accept", content: { confirm: true } },
) => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const handle = serveStdio(
    () => {
      const server = new McpServer(
        { name: "@miguelarios/card-mcp", title: "CardDAV Contacts", version: "0.0.0-test" },
        {
          capabilities: { tools: { listChanged: false } },
          cacheHints: { "tools/list": TOOL_LIST_CACHE_HINT },
        },
      );
      registerTools(server, CARD_TOOLS, service as unknown as CardDavService);
      return server;
    },
    { transport: serverTransport },
  );

  const elicitations: string[] = [];
  const elicitAnswer = answer.action === "unsupported" ? undefined : answer;
  const client = new Client(
    { name: "roundtrip-test", version: "0.0.0" },
    {
      capabilities: elicitAnswer ? { elicitation: {} } : {},
      versionNegotiation: { mode: era === "modern" ? { pin: "2026-07-28" } : "legacy" },
    },
  );
  if (elicitAnswer) {
    client.setRequestHandler("elicitation/create", async (req) => {
      elicitations.push(req.params.message as string);
      return elicitAnswer;
    });
  }
  await client.connect(clientTransport);

  return { client, handle, elicitations };
};

const openHandles: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(openHandles.splice(0).map((h) => h.close()));
});

const connect = async (...args: Parameters<typeof open>) => {
  const session = await open(...args);
  openHandles.push(session.handle);
  return session;
};

describe.each<Era>(["legacy", "modern"])("card-mcp over the wire (%s era)", (era) => {
  it("negotiates the expected protocol era", async () => {
    const { client } = await connect(era, fakeService());
    expect(client.getProtocolEra()).toBe(era);
    if (era === "modern") {
      expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    }
  });

  it("advertises title, annotations and outputSchema for every tool", async () => {
    const { client } = await connect(era, fakeService());
    const { tools } = await client.listTools();

    expect(tools).toHaveLength(CARD_TOOLS.length);
    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(tool.annotations, tool.name).toMatchObject({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
    }
  });

  it("returns tools in a stable order across calls", async () => {
    const { client } = await connect(era, fakeService());
    const first = (await client.listTools()).tools.map((t) => t.name);
    const second = (await client.listTools()).tools.map((t) => t.name);
    expect(second).toEqual(first);
    expect(first).toEqual(CARD_TOOLS.map((t) => t.name));
  });

  it("returns structuredContent matching the advertised outputSchema", async () => {
    const { client } = await connect(era, fakeService());
    const result = await client.callTool({ name: "get_contact", arguments: { uid: "u1" } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ uid: "u1", fullName: "Ada Lovelace" });
    const [first] = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(first.text)).toEqual(result.structuredContent);
  });

  it("rejects malformed arguments without running the handler", async () => {
    const service = fakeService();
    const { client } = await connect(era, service);
    const result = await client.callTool({ name: "get_contact", arguments: { uid: 42 } });

    expect(result.isError).toBe(true);
    expect(service.fetchContacts).not.toHaveBeenCalled();
  });

  it("accepts null for a nullable update_contact field through the real validator", async () => {
    const service = fakeService();
    const { client } = await connect(era, service);
    const result = await client.callTool({
      name: "update_contact",
      arguments: { uid: "u1", note: null, phones: null, title: "Countess" },
    });

    expect(result.isError).toBeFalsy();
    expect(service.updateContact.mock.calls[0].slice(0, 3)).toEqual([
      "book1",
      "u1",
      { note: null, phones: null, title: "Countess" },
    ]);
  });

  it("still rejects a wrong type on a nullable update_contact field", async () => {
    const service = fakeService();
    const { client } = await connect(era, service);
    const result = await client.callTool({
      name: "update_contact",
      arguments: { uid: "u1", note: 42 },
    });

    expect(result.isError).toBe(true);
    expect(service.updateContact).not.toHaveBeenCalled();
  });

  it("confirms before deleting, then deletes", async () => {
    const service = fakeService();
    const { client, elicitations } = await connect(era, service);
    const result = await client.callTool({ name: "delete_contact", arguments: { uid: "u1" } });

    expect(elicitations).toHaveLength(1);
    expect(elicitations[0]).toContain("u1");
    expect(result.isError).toBeFalsy();
    expect(service.deleteContact.mock.calls[0].slice(0, 2)).toEqual(["book1", "u1"]);
  });

  it("confirms before deleting an address book, then deletes it", async () => {
    const service = fakeService();
    const { client, elicitations } = await connect(era, service);
    const result = await client.callTool({
      name: "delete_address_book",
      arguments: { addressBook: "Team" },
    });

    expect(elicitations).toHaveLength(1);
    expect(elicitations[0]).toContain("Team");
    expect(result.isError).toBeFalsy();
    expect(service.deleteAddressBook).toHaveBeenCalledWith("Team");
  });

  it("does not delete an address book when the user declines", async () => {
    const service = fakeService();
    const { client, elicitations } = await connect(era, service, { action: "decline" });
    const result = await client.callTool({
      name: "delete_address_book",
      arguments: { addressBook: "Team" },
    });

    expect(elicitations).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(service.deleteAddressBook).not.toHaveBeenCalled();
  });

  it("fails with an actionable error when the client cannot be asked", async () => {
    const service = fakeService();
    const { client, elicitations } = await connect(era, service, { action: "unsupported" });
    const result = await client.callTool({ name: "delete_contact", arguments: { uid: "u1" } });

    expect(elicitations).toHaveLength(0);
    expect(result.isError).toBe(true);
    const [block] = result.content as Array<{ text: string }>;
    expect(JSON.parse(block.text).error).toBe("CONFIRMATION_UNSUPPORTED");
    expect(block.text).toContain("PIM_MCP_CONFIRM=off");
    expect(service.deleteContact).not.toHaveBeenCalled();
  });

  it("does not delete when the user declines, and asks only once", async () => {
    const service = fakeService();
    const { client, elicitations } = await connect(era, service, { action: "decline" });
    const result = await client.callTool({ name: "delete_contact", arguments: { uid: "u1" } });

    expect(elicitations).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(service.deleteContact).not.toHaveBeenCalled();
  });

  it("moves contacts between books and reports the resolved URLs", async () => {
    const service = fakeService();
    const { client } = await connect(era, service);
    const result = await client.callTool({
      name: "move_contacts",
      arguments: { uids: ["uid-1"], addressBook: "Personal", targetAddressBook: "Work" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      status: "moved",
      from: "Personal",
      to: "Work",
      transferred: [{ uid: "uid-1" }],
    });
    expect(service.moveContacts).toHaveBeenCalledWith("Personal", "Work", ["uid-1"]);
  });

  it("copies contacts and surfaces the new UID over the wire", async () => {
    const service = fakeService();
    const { client } = await connect(era, service);
    const result = await client.callTool({
      name: "copy_contacts",
      arguments: { uids: ["uid-1"], addressBook: "Personal", targetAddressBook: "Work" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      status: "copied",
      transferred: [{ uid: "uid-1", newUid: "uid-copy" }],
    });
  });

  it("rejects a transfer missing its target book without running the handler", async () => {
    const service = fakeService();
    const { client } = await connect(era, service);
    const result = await client.callTool({
      name: "move_contacts",
      arguments: { uids: ["uid-1"], addressBook: "Personal" },
    });

    expect(result.isError).toBe(true);
    expect(service.moveContacts).not.toHaveBeenCalled();
  });

  it("neither transfer asks for confirmation — nothing is destroyed", async () => {
    const service = fakeService();
    const { client, elicitations } = await connect(era, service);
    await client.callTool({
      name: "move_contacts",
      arguments: { uids: ["uid-1"], addressBook: "Personal", targetAddressBook: "Work" },
    });
    await client.callTool({
      name: "copy_contacts",
      arguments: { uids: ["uid-1"], addressBook: "Personal", targetAddressBook: "Work" },
    });

    expect(elicitations).toHaveLength(0);
  });
});

describe.each<Era>(["legacy", "modern"])("card-mcp group tools over the wire (%s)", (era) => {
  it("confirms before deleting a group, then deletes it", async () => {
    const service = fakeService();
    service.fetchContacts.mockResolvedValue([
      { ...CONTACT, uid: "g1", fullName: "Book Club", kind: "group", members: ["u1"] },
    ]);
    const { client, elicitations } = await connect(era, service);
    const result = await client.callTool({ name: "delete_group", arguments: { uid: "g1" } });
    expect(elicitations).toHaveLength(1);
    expect(elicitations[0]).toContain("Book Club");
    expect(result.structuredContent).toEqual({ status: "deleted", uid: "g1", name: "Book Club" });
    expect(service.deleteContact).toHaveBeenCalledWith("book1", "g1");
  });

  it("validates get_group output against its schema", async () => {
    const service = fakeService();
    service.fetchContacts.mockResolvedValue([
      CONTACT,
      { ...CONTACT, uid: "g1", fullName: "Book Club", kind: "group", members: ["u1"] },
    ]);
    const { client } = await connect(era, service);
    const result = await client.callTool({ name: "get_group", arguments: { uid: "g1" } });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as any).members).toEqual([
      { uid: "u1", fullName: "Ada Lovelace", email: "ada@example.com" },
    ]);
  });
});

describe("card-mcp cache hints", () => {
  it("emits ttlMs and cacheScope on the 2026-07-28 era", async () => {
    const { client } = await connect("modern", fakeService());
    const result = await client.listTools();
    expect(result.ttlMs).toBe(TOOL_LIST_CACHE_HINT.ttlMs);
    expect(result.cacheScope).toBe(TOOL_LIST_CACHE_HINT.cacheScope);
  });

  it("leaves 2025-era responses untouched", async () => {
    const { client } = await connect("legacy", fakeService());
    const result = await client.listTools();
    expect(result.ttlMs).toBeUndefined();
    expect(result.cacheScope).toBeUndefined();
  });
});
