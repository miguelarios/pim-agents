/**
 * End-to-end wire conformance: a real MCP client talking to the real server
 * over an in-memory transport pair, on both protocol eras.
 */
import { TOOL_LIST_CACHE_HINT, registerTools } from "@miguelarios/pim-core/mcp";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerImapResources } from "../resources/imapResources.js";
import type { ImapService } from "../services/ImapService.js";
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
        hasAttachments: true,
        inReplyTo: null,
        references: [],
        textBody: "Hello there",
        attachments: [
          { filename: "attachment-0", contentType: "text/calendar", size: 64, partId: "2" },
        ],
        calendarParts: [
          {
            partId: "2",
            contentType: "text/calendar",
            method: "REQUEST",
            filename: null,
            size: 64,
            content: "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR",
          },
        ],
      }),
      listFolders: vi
        .fn()
        .mockResolvedValue([{ path: "INBOX", delimiter: "/", specialUse: "\\Inbox" }]),
      getFolderStatus: vi.fn().mockResolvedValue({ total: 10, unseen: 2 }),
      fetchThread: vi.fn().mockResolvedValue({
        rootMessageId: "<a@test.com>",
        messages: [{ ...SUMMARY, folder: "INBOX" }],
      }),
      deleteEmails: vi.fn().mockResolvedValue(undefined),
      getSpecialUseFolder: vi.fn().mockResolvedValue("Drafts"),
      appendMessage: vi.fn().mockResolvedValue({ uid: 100 }),
      downloadAttachment: vi.fn(
        async (_folder: string, _uid: number, _partId: string, maxBytes?: number) => {
          const meta = { filename: "report.pdf", contentType: "application/pdf", size: 4 };
          return maxBytes !== undefined && meta.size > maxBytes
            ? { ...meta, oversized: true }
            : { ...meta, oversized: false, content: Buffer.from("PDF!") };
        },
      ),
      // Overloaded on the real service: bare for resources/read, ceiling-aware
      // for the tool. The stub answers both by carrying the source either way.
      fetchRawEmail: vi.fn(async (_folder: string, _uid: number, maxBytes?: number) => {
        const source = "From: ada@example.com\r\n\r\nbody";
        return maxBytes === undefined ? source : { size: source.length, oversized: false, source };
      }),
    },
    smtp: {
      config: { smtp: { user: "me@example.com" }, autoSent: true, fromName: undefined },
      // Mirrors SmtpService: an allowed address passes through, otherwise the
      // account sender is used; the header is only formatted, never validated here.
      ownAddresses: vi.fn(() => ["me@example.com"]),
      resolveFromAddress: vi.fn((requested?: string) => requested?.trim() || "me@example.com"),
      formatFromHeader: vi.fn((address: string, displayName?: string) =>
        displayName ? `"${displayName}" <${address}>` : address,
      ),
      composeRawMessage: vi.fn().mockResolvedValue(Buffer.from("raw")),
      sendRawMessage: vi.fn().mockResolvedValue({ messageId: "<sent@test.com>" }),
    },
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
  services: ReturnType<typeof fakeServices>,
  answer: ElicitAnswer = { action: "accept", content: { confirm: true } },
) => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const handle = serveStdio(
    () => {
      const server = new McpServer(
        { name: "@miguelarios/email-mcp", title: "IMAP/SMTP Email", version: "0.0.0-test" },
        {
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false },
          },
          cacheHints: { "tools/list": TOOL_LIST_CACHE_HINT },
        },
      );
      registerTools(server, EMAIL_TOOLS, services as unknown as EmailServices);
      registerImapResources(server, services.imap as unknown as ImapService);
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

  it("delivers a thread through the advertised get_thread outputSchema", async () => {
    const services = fakeServices();
    const { client } = await connect(era, services);
    const result = await client.callTool({ name: "get_thread", arguments: { uid: 1 } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      rootMessageId: "<a@test.com>",
      count: 1,
    });
    // Defaults to the anchor folder plus Sent, which the stub resolves.
    expect(services.imap.fetchThread).toHaveBeenCalledWith("INBOX", 1, ["INBOX", "Drafts"]);
  });

  it("returns structuredContent matching the advertised outputSchema", async () => {
    const { client } = await connect(era, fakeServices());
    const result = await client.callTool({ name: "search_emails", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ count: 1 });
  });

  it("delivers calendar parts through the advertised get_email outputSchema", async () => {
    const { client } = await connect(era, fakeServices());
    const result = await client.callTool({ name: "get_email", arguments: { uid: 1 } });

    // The SDK validates structuredContent against the advertised schema, so a
    // clean result proves schema and payload stayed in sync.
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      hasAttachments: boolean;
      calendarParts: Array<{ method: string | null; content?: string; partId: string }>;
    };
    expect(structured.hasAttachments).toBe(true);
    expect(structured.calendarParts).toHaveLength(1);
    expect(structured.calendarParts[0].method).toBe("REQUEST");
    expect(structured.calendarParts[0].content).toContain("BEGIN:VCALENDAR");
  });

  it("advertises both imap:// resource templates", async () => {
    const { client } = await connect(era, fakeServices());
    const { resourceTemplates } = await client.listResourceTemplates();

    expect(resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual([
      "imap://{folder}/{uid}.eml",
      "imap://{folder}/{uid}/{partId}",
    ]);
  });

  it("serves an attachment's bytes through resources/read", async () => {
    const services = fakeServices();
    const { client } = await connect(era, services);

    const result = await client.readResource({ uri: "imap://INBOX/4471/2" });

    expect(services.imap.downloadAttachment).toHaveBeenCalledWith("INBOX", 4471, "2");
    expect(result.contents[0]).toMatchObject({
      uri: "imap://INBOX/4471/2",
      mimeType: "application/pdf",
      blob: Buffer.from("PDF!").toString("base64"),
    });
  });

  it("serves a message's source through resources/read", async () => {
    const services = fakeServices();
    const { client } = await connect(era, services);

    const result = await client.readResource({ uri: "imap://INBOX/4471.eml" });

    expect(services.imap.fetchRawEmail).toHaveBeenCalledWith("INBOX", 4471);
    expect(result.contents[0]).toMatchObject({ mimeType: "message/rfc822" });
  });

  it("resolves the very URI download_attachment hands back", async () => {
    // The tool result's URI is only useful if it is addressable, so the two
    // paths are asserted against each other rather than against a literal.
    const services = fakeServices();
    const { client } = await connect(era, services);

    const call = await client.callTool({
      name: "download_attachment",
      arguments: { folder: "Archive/2024", uid: 99, partId: "1.2" },
    });
    const block = (call.content as Array<{ type: string; resource: { uri: string } }>).find(
      (c) => c.type === "resource",
    );
    const read = await client.readResource({ uri: block!.resource.uri });

    expect(services.imap.downloadAttachment).toHaveBeenLastCalledWith("Archive/2024", 99, "1.2");
    expect(read.contents[0]).toMatchObject({ blob: Buffer.from("PDF!").toString("base64") });
  });

  it("fails a resources/read for a malformed uid rather than guessing", async () => {
    const services = fakeServices();
    const { client } = await connect(era, services);

    await expect(client.readResource({ uri: "imap://INBOX/not-a-uid/2" })).rejects.toThrow();
    expect(services.imap.downloadAttachment).not.toHaveBeenCalled();
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

  it("returns an attachment as a binary resource, with the bytes only there", async () => {
    const { client } = await connect(era, fakeServices());
    const result = await client.callTool({
      name: "download_attachment",
      arguments: { uid: 1, partId: "2" },
    });

    expect(result.isError).toBeFalsy();
    const [block] = result.content as Array<{
      type: string;
      resource: { mimeType: string; blob: string };
    }>;
    expect(block.type).toBe("resource");
    expect(block.resource.mimeType).toBe("application/pdf");
    expect(Buffer.from(block.resource.blob, "base64").toString()).toBe("PDF!");
    // Metadata only — repeating the base64 here would double the response.
    // `uri` addresses the same bytes for a client that would rather fetch them
    // itself; `embedded` says they did fit under the inline ceiling.
    expect(result.structuredContent).toEqual({
      filename: "report.pdf",
      contentType: "application/pdf",
      size: 4,
      uri: "imap://INBOX/1/2",
      embedded: true,
    });
  });

  it("returns raw source as a message/rfc822 resource, with metadata-only structured output", async () => {
    const { client } = await connect(era, fakeServices());
    const result = await client.callTool({
      name: "get_email_raw",
      arguments: { uid: 1 },
    });

    expect(result.isError).toBeFalsy();
    const [block] = result.content as Array<{
      type: string;
      resource: { mimeType: string; text: string };
    }>;
    expect(block.type).toBe("resource");
    expect(block.resource.mimeType).toBe("message/rfc822");
    expect(block.resource.text).toContain("ada@example.com");
    expect(result.structuredContent).toEqual({
      uid: 1,
      folder: "INBOX",
      size: 29,
      uri: "imap://INBOX/1.eml",
      embedded: true,
    });
  });

  it("links an oversized attachment instead of embedding it, and the link resolves", async () => {
    // The whole point of the ceiling: the bytes leave the tool result, but stay
    // one resources/read away. Asserted as one flow rather than two tests,
    // because a link that does not resolve is worse than no ceiling at all.
    const previous = process.env.EMAIL_MAX_INLINE_BYTES;
    process.env.EMAIL_MAX_INLINE_BYTES = "0";
    try {
      const { client } = await connect(era, fakeServices());
      const result = await client.callTool({
        name: "download_attachment",
        arguments: { uid: 1, partId: "2" },
      });

      expect(result.isError).toBeFalsy();
      const blocks = result.content as Array<Record<string, unknown>>;
      expect(blocks.some((b) => b.type === "resource")).toBe(false);

      // `name` and `size` are asserted here rather than only in the unit test:
      // they are optional in the SDK's schema, so this is what proves they
      // survive serialization instead of being quietly stripped.
      const link = blocks.find((b) => b.type === "resource_link") as { uri: string };
      expect(link).toMatchObject({
        uri: "imap://INBOX/1/2",
        name: "report.pdf",
        mimeType: "application/pdf",
        size: 4,
      });
      expect(result.structuredContent).toMatchObject({ embedded: false });

      const read = await client.readResource({ uri: link.uri });
      expect(read.contents[0]).toMatchObject({ blob: Buffer.from("PDF!").toString("base64") });
    } finally {
      if (previous === undefined) delete process.env.EMAIL_MAX_INLINE_BYTES;
      else process.env.EMAIL_MAX_INLINE_BYTES = previous;
    }
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

  it("accepts a reply-all with no explicit recipients, and names them when asking", async () => {
    const services = fakeServices();
    services.imap.fetchEmail = vi.fn().mockResolvedValue({
      ...SUMMARY,
      from: { address: "ada@example.com" },
      to: [{ address: "me@example.com" }, { address: "bob@example.com" }],
      cc: [{ address: "cara@example.com" }],
      inReplyTo: null,
      references: [],
      attachments: [],
    });

    const { client, elicitations } = await connect(era, services);
    // `to` is deliberately absent: the SDK validates arguments against the
    // advertised inputSchema, so this call only reaches the handler because
    // the schema no longer marks it required.
    const result = await client.callTool({
      name: "send_email",
      arguments: { replyToUid: 1, replyAll: true, text: "Sounds good" },
    });

    expect(result.isError).toBeFalsy();
    expect(elicitations[0]).toContain("ada@example.com");
    expect(elicitations[0]).toContain("cara@example.com");
    expect(elicitations[0]).not.toContain("me@example.com");
    expect(services.smtp.composeRawMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["ada@example.com", "bob@example.com"],
        cc: ["cara@example.com"],
        subject: "Re: Hello",
      }),
    );
  });

  it("quotes the original when replying, without being asked to", async () => {
    const services = fakeServices();
    const { client } = await connect(era, services);
    const result = await client.callTool({
      name: "send_email",
      arguments: { to: ["ada@example.com"], replyToUid: 1, text: "Thanks!" },
    });

    expect(result.isError).toBeFalsy();
    const [composed] = (services.smtp.composeRawMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(composed.text).toContain("Ada <ada@example.com> wrote:");
    expect(composed.text).toContain("> Hello there");
  });

  it("fails with an actionable error when the client cannot be asked", async () => {
    const services = fakeServices();
    const { client, elicitations } = await connect(era, services, { action: "unsupported" });
    const result = await client.callTool({
      name: "send_email",
      arguments: { to: ["r@test.com"], subject: "Hi", text: "Hello" },
    });

    expect(elicitations).toHaveLength(0);
    expect(result.isError).toBe(true);
    const [block] = result.content as Array<{ text: string }>;
    expect(JSON.parse(block.text).error).toBe("CONFIRMATION_UNSUPPORTED");
    expect(block.text).toContain("PIM_MCP_CONFIRM=off");
    expect(services.smtp.sendRawMessage).not.toHaveBeenCalled();
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
