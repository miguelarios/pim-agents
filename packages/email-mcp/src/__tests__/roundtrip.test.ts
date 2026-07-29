/**
 * End-to-end wire conformance: a real MCP client talking to the real server
 * over an in-memory transport pair, on both protocol eras.
 */
import { TOOL_LIST_CACHE_HINT, registerTools } from "@miguelarios/pim-core/mcp";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMAIL_TOOLS, type EmailServices } from "../tools/emailTools.js";

const SUMMARY = {
  uid: 1,
  messageId: "<a@test.com>",
  subject: "Hello",
  from: { name: "Ada", address: "ada@example.com" },
  to: [{ address: "me@example.com" }],
  date: "2026-07-28T10:00:00.000Z",
  flags: ["\\Seen"],
  hasAttachments: false,
};

function fakeServices() {
  return {
    imap: {
      searchEmails: vi.fn().mockResolvedValue([SUMMARY]),
      fetchEmail: vi.fn().mockResolvedValue({
        ...SUMMARY,
        inReplyTo: null,
        references: [],
        textBody: "Hello there",
        attachments: [],
      }),
      listFolders: vi
        .fn()
        .mockResolvedValue([{ path: "INBOX", delimiter: "/", specialUse: "\\Inbox" }]),
      getFolderStatus: vi.fn().mockResolvedValue({ total: 10, unseen: 2 }),
      deleteEmails: vi.fn().mockResolvedValue(undefined),
      getSpecialUseFolder: vi.fn().mockResolvedValue("Drafts"),
      appendMessage: vi.fn().mockResolvedValue({ uid: 100 }),
    },
    smtp: {
      config: { smtp: { user: "me@example.com" }, autoSent: true, fromName: undefined },
      composeRawMessage: vi.fn().mockResolvedValue(Buffer.from("raw")),
      sendRawMessage: vi.fn().mockResolvedValue({ messageId: "<sent@test.com>" }),
    },
  };
}

type Era = "legacy" | "modern";
type ElicitAnswer = { action: "accept"; content: { confirm: boolean } } | { action: "decline" };

const open = async (
  era: Era,
  services: ReturnType<typeof fakeServices>,
  answer: ElicitAnswer = { action: "accept", content: { confirm: true } },
) => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const handle = serveStdio(
    () => {
      const server = new McpServer(
        { name: "@miguelarios/email-mcp", title: "IMAP/SMTP Email", version: "0.0.0-test" },
        {
          capabilities: { tools: { listChanged: false } },
          cacheHints: { "tools/list": TOOL_LIST_CACHE_HINT },
        },
      );
      registerTools(server, EMAIL_TOOLS, services as unknown as EmailServices);
      return server;
    },
    { transport: serverTransport },
  );

  const elicitations: string[] = [];
  const client = new Client(
    { name: "roundtrip-test", version: "0.0.0" },
    {
      capabilities: { elicitation: {} },
      versionNegotiation: { mode: era === "modern" ? { pin: "2026-07-28" } : "legacy" },
    },
  );
  client.setRequestHandler("elicitation/create", async (req) => {
    elicitations.push(req.params.message as string);
    return answer;
  });
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

describe.each<Era>(["legacy", "modern"])("email-mcp over the wire (%s era)", (era) => {
  it("negotiates the expected protocol era", async () => {
    const { client } = await connect(era, fakeServices());
    expect(client.getProtocolEra()).toBe(era);
  });

  it("advertises title, annotations and outputSchema for every tool", async () => {
    const { client } = await connect(era, fakeServices());
    const { tools } = await client.listTools();

    expect(tools).toHaveLength(EMAIL_TOOLS.length);
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
    const { client } = await connect(era, fakeServices());
    const first = (await client.listTools()).tools.map((t) => t.name);
    const second = (await client.listTools()).tools.map((t) => t.name);
    expect(second).toEqual(first);
    expect(first).toEqual(EMAIL_TOOLS.map((t) => t.name));
  });

  it("returns structuredContent matching the advertised outputSchema", async () => {
    const { client } = await connect(era, fakeServices());
    const result = await client.callTool({ name: "search_emails", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ count: 1 });
  });

  it("rejects malformed arguments without running the handler", async () => {
    const services = fakeServices();
    const { client } = await connect(era, services);
    // `uid` is declared as a number.
    const result = await client.callTool({
      name: "get_email",
      arguments: { uid: "not-a-number" },
    });

    expect(result.isError).toBe(true);
    expect(services.imap.fetchEmail).not.toHaveBeenCalled();
  });

  it("confirms before sending, then sends", async () => {
    const services = fakeServices();
    const { client, elicitations } = await connect(era, services);
    const result = await client.callTool({
      name: "send_email",
      arguments: { to: ["r@test.com"], subject: "Hi", text: "Hello" },
    });

    expect(elicitations).toHaveLength(1);
    expect(elicitations[0]).toContain("r@test.com");
    expect(result.isError).toBeFalsy();
    expect(services.smtp.sendRawMessage).toHaveBeenCalled();
  });

  it("does not send when the user declines", async () => {
    const services = fakeServices();
    const { client, elicitations } = await connect(era, services, { action: "decline" });
    const result = await client.callTool({
      name: "send_email",
      arguments: { to: ["r@test.com"], subject: "Hi", text: "Hello" },
    });

    expect(elicitations).toHaveLength(1);
    expect(result.isError).toBe(true);
    expect(services.smtp.sendRawMessage).not.toHaveBeenCalled();
  });

  it("saves a draft without asking", async () => {
    const services = fakeServices();
    const { client, elicitations } = await connect(era, services);
    const result = await client.callTool({
      name: "send_email",
      arguments: { to: ["r@test.com"], subject: "Hi", text: "Hello", saveToDrafts: true },
    });

    expect(elicitations).toHaveLength(0);
    expect(result.isError).toBeFalsy();
    expect(services.smtp.sendRawMessage).not.toHaveBeenCalled();
  });

  it("moves to Trash without asking, but confirms a permanent delete", async () => {
    const services = fakeServices();
    const { client, elicitations } = await connect(era, services);

    await client.callTool({ name: "delete_email", arguments: { uids: [1] } });
    expect(elicitations).toHaveLength(0);

    await client.callTool({ name: "delete_email", arguments: { uids: [1], permanent: true } });
    expect(elicitations).toHaveLength(1);
  });
});
