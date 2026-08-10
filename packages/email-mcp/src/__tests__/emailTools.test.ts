import { mkdirSync, rmSync } from "node:fs";
import { dispatchTool } from "@miguelarios/pim-core/mcp";
import type { ServerContext } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMAIL_TOOLS } from "../tools/emailTools.js";

/**
 * Answers every confirmation prompt this package can raise with "yes". Used as
 * the default so the suites below exercise send/delete behaviour rather than
 * the gate; the gate has its own tests, which pass `NOT_CONFIRMED`.
 */
const AUTO_CONFIRM = {
  mcpReq: {
    inputResponses: Object.fromEntries(
      ["confirm_send_email", "confirm_send_draft", "confirm_delete_email"].map((key) => [
        key,
        { action: "accept", content: { confirm: true } },
      ]),
    ),
  },
} as unknown as ServerContext;

/** A first-round context: no answers carried yet. */
const NOT_CONFIRMED = { mcpReq: { inputResponses: undefined } } as unknown as ServerContext;

const handleEmailTool = (
  name: string,
  args: Record<string, unknown>,
  imap: unknown,
  smtp: unknown,
  ctx: ServerContext = AUTO_CONFIRM,
  // test-only loose typing over a heterogeneous result
) => dispatchTool(EMAIL_TOOLS, name, args, { imap, smtp } as any, ctx) as Promise<any>;

// Mock ImapService
const mockFetchEmail = vi.fn();
const mockGetSpecialUseFolder = vi.fn();
const mockAppendMessage = vi.fn();
const mockFetchRawSource = vi.fn();
const mockDeleteEmails = vi.fn();

const mockImapService = {
  fetchEmail: mockFetchEmail,
  getSpecialUseFolder: mockGetSpecialUseFolder,
  appendMessage: mockAppendMessage,
  fetchRawSource: mockFetchRawSource,
  deleteEmails: mockDeleteEmails,
} as any;

const mockSendEmail = vi.fn();
const mockComposeRawMessage = vi.fn();
const mockSendRawMessage = vi.fn();
const mockResolveFromAddress = vi.fn((requested?: string) => requested || "user@test.com");
const mockFormatFromHeader = vi.fn(
  (address: string, displayName?: string) => `"${displayName || "Test User"}" <${address}>`,
);

const mockSmtpService = {
  sendEmail: mockSendEmail,
  composeRawMessage: mockComposeRawMessage,
  sendRawMessage: mockSendRawMessage,
  resolveFromAddress: mockResolveFromAddress,
  formatFromHeader: mockFormatFromHeader,
  config: { autoSent: false, fromName: "Test User", smtp: { user: "user@test.com" } },
} as any;

// Mock htmlToMarkdown
vi.mock("../htmlToMarkdown.js", () => ({
  htmlToMarkdown: vi.fn().mockResolvedValue("**converted markdown**"),
}));

describe("EMAIL_TOOLS definitions", () => {
  it("defines 12 tools", () => {
    expect(EMAIL_TOOLS).toHaveLength(12);
  });

  it("all tools have name, description, and inputSchema", () => {
    for (const tool of EMAIL_TOOLS) {
      expect(tool.name).toBeDefined();
      expect(tool.description).toBeDefined();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("defines the expected tool names", () => {
    const names = EMAIL_TOOLS.map((t) => t.name);
    expect(names).toContain("search_emails");
    expect(names).toContain("get_email");
    expect(names).toContain("send_email");
    expect(names).toContain("move_email");
    expect(names).toContain("mark_email");
    expect(names).toContain("delete_email");
    expect(names).toContain("list_folders");
    expect(names).toContain("create_folder");
    expect(names).toContain("download_attachment");
    expect(names).toContain("get_email_raw");
    expect(names).toContain("get_folder_status");
    expect(names).toContain("send_draft");
  });

  it("send_email requires only to", () => {
    const tool = EMAIL_TOOLS.find((t) => t.name === "send_email")!;
    expect(tool.inputSchema.required).toEqual(["to"]);
  });

  it("send_email has replyToUid, replyToFolder, saveToDrafts, from, and fromName properties", () => {
    const tool = EMAIL_TOOLS.find((t) => t.name === "send_email")!;
    const props = tool.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("replyToUid");
    expect(props).toHaveProperty("replyToFolder");
    expect(props).toHaveProperty("saveToDrafts");
    expect(props).toHaveProperty("from");
    expect(props).toHaveProperty("fromName");
  });

  it("send_draft requires uid", () => {
    const tool = EMAIL_TOOLS.find((t) => t.name === "send_draft")!;
    expect(tool.inputSchema.required).toEqual(["uid"]);
  });

  it("search_emails has structured search params", () => {
    const tool = EMAIL_TOOLS.find((t) => t.name === "search_emails")!;
    const props = tool.inputSchema.properties as Record<string, unknown>;
    expect(props).toHaveProperty("folder");
    expect(props).toHaveProperty("hasWords");
    expect(props).not.toHaveProperty("query");
    expect(props).toHaveProperty("body");
    expect(props).toHaveProperty("from");
    expect(props).toHaveProperty("to");
    expect(props).toHaveProperty("cc");
    expect(props).toHaveProperty("bcc");
    expect(props).toHaveProperty("subject");
    expect(props).toHaveProperty("since");
    expect(props).toHaveProperty("before");
    expect(props).toHaveProperty("unread");
    expect(props).toHaveProperty("flagged");
    expect(props).toHaveProperty("hasAttachment");
    expect(props).toHaveProperty("tags");
    expect(props).toHaveProperty("limit");
    expect(props).toHaveProperty("offset");
    expect(props).toHaveProperty("sortBy");
    expect(props).toHaveProperty("sortOrder");
  });

  it("get_email requires folder and uid", () => {
    const tool = EMAIL_TOOLS.find((t) => t.name === "get_email")!;
    expect(tool.inputSchema.required).toContain("uid");
  });

  it("get_email schema includes format property", () => {
    const tool = EMAIL_TOOLS.find((t) => t.name === "get_email")!;
    const props = tool.inputSchema.properties as Record<string, any>;
    expect(props).toHaveProperty("format");
    expect(props.format.enum).toEqual(["markdown", "html", "text"]);
  });

  it("download_attachment requires uid and partId", () => {
    const tool = EMAIL_TOOLS.find((t) => t.name === "download_attachment")!;
    expect(tool.inputSchema.required).toContain("uid");
    expect(tool.inputSchema.required).toContain("partId");
  });

  it("read-only tools carry readOnlyHint; destructive tools carry destructiveHint", () => {
    const byName = Object.fromEntries(EMAIL_TOOLS.map((t) => [t.name, t as any]));
    for (const name of [
      "search_emails",
      "get_email",
      "list_folders",
      "download_attachment",
      "get_email_raw",
      "get_folder_status",
    ]) {
      expect(byName[name].annotations?.readOnlyHint, name).toBe(true);
    }
    expect(byName.delete_email.annotations?.destructiveHint).toBe(true);
    expect(byName.send_email.annotations?.readOnlyHint).toBe(false);
    expect(byName.send_email.annotations?.idempotentHint).toBe(false);
    expect(byName.send_email.annotations?.openWorldHint).toBe(true);
  });

  it("every tool declares a title, an output schema and all four annotations", () => {
    for (const tool of EMAIL_TOOLS) {
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.outputSchema, tool.name).toBeDefined();
      for (const hint of [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ] as const) {
        expect(typeof tool.annotations[hint], `${tool.name}.${hint}`).toBe("boolean");
      }
    }
  });

  it("uses tool names the spec allows", () => {
    for (const tool of EMAIL_TOOLS) {
      expect(tool.name, tool.name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
    }
  });
});

describe("confirmation gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockComposeRawMessage.mockResolvedValue(Buffer.from("raw-message"));
    mockSendRawMessage.mockResolvedValue({
      messageId: "<sent-1@test.com>",
      accepted: ["r@test.com"],
      rejected: [],
    });
    mockGetSpecialUseFolder.mockResolvedValue("Drafts");
    mockAppendMessage.mockResolvedValue({ uid: 100 });
    mockDeleteEmails.mockResolvedValue(undefined);
  });

  it("send_email asks before putting mail on the wire", async () => {
    const result = await handleEmailTool(
      "send_email",
      { to: ["r@test.com"], subject: "Hi", text: "Hello" },
      mockImapService,
      mockSmtpService,
      NOT_CONFIRMED,
    );

    expect(result.resultType).toBe("input_required");
    expect(result.inputRequests.confirm_send_email).toBeDefined();
    expect(mockSendRawMessage).not.toHaveBeenCalled();
  });

  it("send_email does not ask when only saving a draft", async () => {
    const result = await handleEmailTool(
      "send_email",
      { to: ["r@test.com"], subject: "Hi", text: "Hello", saveToDrafts: true },
      mockImapService,
      mockSmtpService,
      NOT_CONFIRMED,
    );

    expect(result.resultType).toBeUndefined();
    expect(JSON.parse(result.content[0].text).status).toBe("draft");
    expect(mockSendRawMessage).not.toHaveBeenCalled();
  });

  it("send_email does not send when the user declines", async () => {
    const declined = {
      mcpReq: { inputResponses: { confirm_send_email: { action: "decline" } } },
    } as unknown as ServerContext;
    const result = await handleEmailTool(
      "send_email",
      { to: ["r@test.com"], subject: "Hi", text: "Hello" },
      mockImapService,
      mockSmtpService,
      declined,
    );

    expect(result.isError).toBe(true);
    expect(result.resultType).toBeUndefined();
    expect(mockSendRawMessage).not.toHaveBeenCalled();
  });

  it("send_draft asks before sending", async () => {
    const result = await handleEmailTool(
      "send_draft",
      { uid: 7 },
      mockImapService,
      mockSmtpService,
      NOT_CONFIRMED,
    );

    expect(result.resultType).toBe("input_required");
    expect(mockSendRawMessage).not.toHaveBeenCalled();
  });

  it("delete_email asks only for a permanent delete", async () => {
    const trashed = await handleEmailTool(
      "delete_email",
      { uids: [1] },
      mockImapService,
      mockSmtpService,
      NOT_CONFIRMED,
    );
    expect(trashed.resultType).toBeUndefined();
    expect(JSON.parse(trashed.content[0].text).status).toBe("moved_to_trash");

    const permanent = await handleEmailTool(
      "delete_email",
      { uids: [1], permanent: true },
      mockImapService,
      mockSmtpService,
      NOT_CONFIRMED,
    );
    expect(permanent.resultType).toBe("input_required");
  });
});

describe("handleEmailTool get_email format", () => {
  beforeEach(() => {
    mockFetchEmail.mockReset();
    mockFetchEmail.mockResolvedValue({
      uid: 123,
      messageId: "<msg@test.com>",
      subject: "Test",
      from: { address: "sender@test.com" },
      to: [{ address: "recipient@test.com" }],
      date: "2026-03-11T12:00:00Z",
      flags: [],
      hasAttachments: false,
      textBody: "Plain text body",
      htmlBody: "<p>HTML body</p>",
      attachments: [],
    });
  });

  it("defaults to markdown format", async () => {
    const result = await handleEmailTool(
      "get_email",
      { uid: 123 },
      mockImapService,
      mockSmtpService,
    );
    const body = JSON.parse(result.content[0].text);
    expect(body.markdownBody).toBe("**converted markdown**");
    expect(body.textBody).toBeUndefined();
    expect(body.htmlBody).toBeUndefined();
  });

  it("format html returns htmlBody only", async () => {
    const result = await handleEmailTool(
      "get_email",
      { uid: 123, format: "html" },
      mockImapService,
      mockSmtpService,
    );
    const body = JSON.parse(result.content[0].text);
    expect(body.htmlBody).toBe("<p>HTML body</p>");
    expect(body.textBody).toBeUndefined();
    expect(body.markdownBody).toBeUndefined();
  });

  it("format text returns textBody only", async () => {
    const result = await handleEmailTool(
      "get_email",
      { uid: 123, format: "text" },
      mockImapService,
      mockSmtpService,
    );
    const body = JSON.parse(result.content[0].text);
    expect(body.textBody).toBe("Plain text body");
    expect(body.htmlBody).toBeUndefined();
    expect(body.markdownBody).toBeUndefined();
  });

  it("keeps calendarParts in the response across format handling", async () => {
    mockFetchEmail.mockResolvedValue({
      uid: 123,
      messageId: "<invite@test.com>",
      subject: "Invitation",
      from: { address: "organizer@test.com" },
      to: [{ address: "attendee@test.com" }],
      date: "2026-08-10T12:00:00Z",
      flags: [],
      hasAttachments: true,
      textBody: "You are invited.",
      attachments: [
        { filename: "attachment-0", contentType: "text/calendar", size: 228, partId: "2" },
      ],
      calendarParts: [
        {
          partId: "2",
          contentType: "text/calendar",
          method: "REQUEST",
          filename: null,
          size: 228,
          content: "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR",
        },
      ],
    });

    const result = await handleEmailTool(
      "get_email",
      { uid: 123 },
      mockImapService,
      mockSmtpService,
    );
    const body = JSON.parse(result.content[0].text);
    expect(body.calendarParts).toHaveLength(1);
    expect(body.calendarParts[0].method).toBe("REQUEST");
    expect(body.calendarParts[0].content).toContain("BEGIN:VCALENDAR");
    expect(result.structuredContent.calendarParts).toEqual(body.calendarParts);
  });

  it("text-only email with markdown format uses textBody as markdownBody", async () => {
    mockFetchEmail.mockResolvedValue({
      uid: 123,
      messageId: "<msg@test.com>",
      subject: "Test",
      from: { address: "sender@test.com" },
      to: [{ address: "recipient@test.com" }],
      date: "2026-03-11T12:00:00Z",
      flags: [],
      hasAttachments: false,
      textBody: "Plain text only",
      attachments: [],
    });

    const result = await handleEmailTool(
      "get_email",
      { uid: 123 },
      mockImapService,
      mockSmtpService,
    );
    const body = JSON.parse(result.content[0].text);
    expect(body.markdownBody).toBe("Plain text only");
    expect(body.textBody).toBeUndefined();
    expect(body.htmlBody).toBeUndefined();
  });

  it("falls back to raw bodies on conversion error", async () => {
    const { htmlToMarkdown } = await import("../htmlToMarkdown.js");
    vi.mocked(htmlToMarkdown).mockRejectedValueOnce(new Error("Parse error"));

    const result = await handleEmailTool(
      "get_email",
      { uid: 123 },
      mockImapService,
      mockSmtpService,
    );
    const body = JSON.parse(result.content[0].text);
    // Falls back — original fields preserved
    expect(body.htmlBody).toBe("<p>HTML body</p>");
    expect(body.textBody).toBe("Plain text body");
  });
});

describe("send_email handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveFromAddress.mockImplementation((requested?: string) => requested || "user@test.com");
    mockFormatFromHeader.mockImplementation(
      (address: string, displayName?: string) => `"${displayName || "Test User"}" <${address}>`,
    );
    mockComposeRawMessage.mockResolvedValue(Buffer.from("raw-message"));
    mockSendRawMessage.mockResolvedValue({
      messageId: "<sent-1@test.com>",
      accepted: ["r@test.com"],
      rejected: [],
    });
    mockGetSpecialUseFolder.mockResolvedValue("Sent");
    mockAppendMessage.mockResolvedValue({ uid: 100 });
  });

  it("returns validation error when no subject and no replyToUid", async () => {
    const result = await handleEmailTool(
      "send_email",
      { to: ["r@test.com"], text: "Hello" },
      mockImapService,
      mockSmtpService,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("subject is required");
  });

  it("sends new email and appends to Sent folder", async () => {
    const result = await handleEmailTool(
      "send_email",
      { to: ["r@test.com"], subject: "Hi", text: "Hello" },
      mockImapService,
      mockSmtpService,
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("sent");
    expect(parsed.messageId).toBe("<sent-1@test.com>");
    expect(mockComposeRawMessage).toHaveBeenCalled();
    expect(mockSendRawMessage).toHaveBeenCalled();
    expect(mockAppendMessage).toHaveBeenCalledWith("Sent", expect.any(Buffer), ["\\Seen"]);
  });

  it("auto-derives subject when replyToUid is set and subject is omitted", async () => {
    mockFetchEmail.mockResolvedValueOnce({
      uid: 42,
      messageId: "<original@test.com>",
      subject: "Original Subject",
      inReplyTo: null,
      references: [],
    });

    const result = await handleEmailTool(
      "send_email",
      { to: ["r@test.com"], text: "Reply", replyToUid: 42 },
      mockImapService,
      mockSmtpService,
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("sent");
    expect(mockComposeRawMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Re: Original Subject",
        inReplyTo: "<original@test.com>",
        references: ["<original@test.com>"],
      }),
    );
  });

  it("uses explicit subject even for replies", async () => {
    mockFetchEmail.mockResolvedValueOnce({
      uid: 42,
      messageId: "<original@test.com>",
      subject: "Original Subject",
      inReplyTo: null,
      references: [],
    });

    await handleEmailTool(
      "send_email",
      { to: ["r@test.com"], subject: "Custom Subject", text: "Reply", replyToUid: 42 },
      mockImapService,
      mockSmtpService,
    );

    expect(mockComposeRawMessage).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "Custom Subject" }),
    );
  });

  it("builds References chain from original email", async () => {
    mockFetchEmail.mockResolvedValueOnce({
      uid: 42,
      messageId: "<mid@test.com>",
      subject: "Thread",
      inReplyTo: "<root@test.com>",
      references: ["<root@test.com>"],
    });

    await handleEmailTool(
      "send_email",
      { to: ["r@test.com"], text: "Reply", replyToUid: 42 },
      mockImapService,
      mockSmtpService,
    );

    expect(mockComposeRawMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        inReplyTo: "<mid@test.com>",
        references: ["<root@test.com>", "<mid@test.com>"],
      }),
    );
  });

  it("saves as draft when saveToDrafts is true", async () => {
    mockGetSpecialUseFolder.mockResolvedValue("Drafts");
    mockAppendMessage.mockResolvedValue({ uid: 200 });

    const result = await handleEmailTool(
      "send_email",
      { to: ["r@test.com"], subject: "Draft", text: "WIP", saveToDrafts: true },
      mockImapService,
      mockSmtpService,
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("draft");
    expect(parsed.uid).toBe(200);
    expect(parsed.folder).toBe("Drafts");
    expect(mockSendRawMessage).not.toHaveBeenCalled();
    expect(mockAppendMessage).toHaveBeenCalledWith("Drafts", expect.any(Buffer), [
      "\\Draft",
      "\\Seen",
    ]);
  });

  it("saves threaded draft when saveToDrafts and replyToUid both set", async () => {
    mockFetchEmail.mockResolvedValueOnce({
      uid: 42,
      messageId: "<original@test.com>",
      subject: "Original",
      inReplyTo: null,
      references: [],
    });
    mockGetSpecialUseFolder.mockResolvedValue("Drafts");
    mockAppendMessage.mockResolvedValue({ uid: 201 });

    const result = await handleEmailTool(
      "send_email",
      { to: ["r@test.com"], text: "Draft reply", replyToUid: 42, saveToDrafts: true },
      mockImapService,
      mockSmtpService,
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("draft");
    expect(mockComposeRawMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "Re: Original",
        inReplyTo: "<original@test.com>",
      }),
      { keepBcc: true },
    );
  });

  it("does not double-prefix Re: when original subject already starts with Re:", async () => {
    mockFetchEmail.mockResolvedValueOnce({
      uid: 42,
      messageId: "<original@test.com>",
      subject: "Re: Already a reply",
      inReplyTo: "<root@test.com>",
      references: ["<root@test.com>"],
    });

    await handleEmailTool(
      "send_email",
      { to: ["r@test.com"], text: "Reply", replyToUid: 42 },
      mockImapService,
      mockSmtpService,
    );

    expect(mockComposeRawMessage).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "Re: Already a reply" }),
    );
  });

  it("still returns sent status when Sent folder APPEND fails", async () => {
    mockGetSpecialUseFolder.mockResolvedValue("Sent");
    mockAppendMessage.mockRejectedValueOnce(new Error("IMAP connection lost"));

    const result = await handleEmailTool(
      "send_email",
      { to: ["r@test.com"], subject: "Hi", text: "Hello" },
      mockImapService,
      mockSmtpService,
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("sent");
    expect(parsed.messageId).toBe("<sent-1@test.com>");
  });

  it("coerces string to to array when client passes single string", async () => {
    const result = await handleEmailTool(
      "send_email",
      { to: "r@test.com" as unknown, subject: "Hi", text: "Hello" },
      mockImapService,
      mockSmtpService,
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("sent");
    expect(mockComposeRawMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: ["r@test.com"] }),
    );
  });

  it("coerces string cc and bcc to arrays when client passes single strings", async () => {
    const result = await handleEmailTool(
      "send_email",
      {
        to: ["r@test.com"],
        cc: "cc@test.com" as unknown,
        bcc: "bcc@test.com" as unknown,
        subject: "Hi",
        text: "Hello",
      },
      mockImapService,
      mockSmtpService,
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("sent");
    expect(mockComposeRawMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        cc: ["cc@test.com"],
        bcc: ["bcc@test.com"],
      }),
    );
  });

  it("passes an allowed custom from address into the visible From header", async () => {
    const result = await handleEmailTool(
      "send_email",
      {
        to: ["r@test.com"],
        from: "shared@test.com",
        subject: "Hi",
        text: "Hello",
      },
      mockImapService,
      mockSmtpService,
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("sent");
    expect(mockResolveFromAddress).toHaveBeenCalledWith("shared@test.com");
    expect(mockFormatFromHeader).toHaveBeenCalledWith("shared@test.com", undefined);
    expect(mockComposeRawMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '"Test User" <shared@test.com>',
      }),
    );
    expect(mockSendRawMessage).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.objectContaining({ from: "user@test.com" }),
    );
  });

  it("passes a caller-provided display name into the visible From header", async () => {
    const result = await handleEmailTool(
      "send_email",
      {
        to: ["r@test.com"],
        from: "shared@test.com",
        fromName: "John Doe via Example Agents",
        subject: "Hi",
        text: "Hello",
      },
      mockImapService,
      mockSmtpService,
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("sent");
    expect(mockFormatFromHeader).toHaveBeenCalledWith(
      "shared@test.com",
      "John Doe via Example Agents",
    );
    expect(mockComposeRawMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '"John Doe via Example Agents" <shared@test.com>',
      }),
    );
  });

  it("returns an error when the requested from address is not allowed", async () => {
    mockResolveFromAddress.mockImplementationOnce(() => {
      throw new Error("Requested from address is not allowed: blocked@test.com");
    });

    const result = await handleEmailTool(
      "send_email",
      {
        to: ["r@test.com"],
        from: "blocked@test.com",
        subject: "Hi",
        text: "Hello",
      },
      mockImapService,
      mockSmtpService,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not allowed");
  });

  it("skips Sent folder append when autoSent is true", async () => {
    mockSmtpService.config = {
      autoSent: true,
      fromName: "Test User",
      smtp: { user: "user@test.com" },
    };

    await handleEmailTool(
      "send_email",
      { to: ["r@test.com"], subject: "Hi", text: "Hello" },
      mockImapService,
      mockSmtpService,
    );

    expect(mockAppendMessage).not.toHaveBeenCalled();
    mockSmtpService.config = {
      autoSent: false,
      fromName: "Test User",
      smtp: { user: "user@test.com" },
    };
  });

  describe("attachment path restriction", () => {
    // realpathSync needs the allowed root to actually exist to exercise the
    // real escape check (rather than incidentally failing on a missing
    // root dir), so create/remove a real synthetic dir under /tmp.
    const attachmentDir = "/tmp/attachments";

    beforeEach(() => {
      mkdirSync(attachmentDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(attachmentDir, { recursive: true, force: true });
      vi.unstubAllEnvs();
    });

    it("rejects path attachments when EMAIL_ATTACHMENT_DIR is unset", async () => {
      vi.stubEnv("EMAIL_ATTACHMENT_DIR", "");

      const result = await handleEmailTool(
        "send_email",
        {
          to: ["r@test.com"],
          subject: "Hi",
          text: "Hello",
          attachments: [{ filename: "a.txt", path: "/etc/passwd" }],
        },
        mockImapService,
        mockSmtpService,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/EMAIL_ATTACHMENT_DIR/);
    });

    it("rejects paths that escape EMAIL_ATTACHMENT_DIR", async () => {
      vi.stubEnv("EMAIL_ATTACHMENT_DIR", attachmentDir);

      const result = await handleEmailTool(
        "send_email",
        {
          to: ["r@test.com"],
          subject: "Hi",
          text: "Hello",
          attachments: [{ filename: "a.txt", path: `${attachmentDir}/../../etc/passwd` }],
        },
        mockImapService,
        mockSmtpService,
      );

      expect(result.isError).toBe(true);
    });
  });
});

describe("send_draft handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSpecialUseFolder.mockImplementation((flag: string) => {
      if (flag === "\\Drafts") return Promise.resolve("Drafts");
      if (flag === "\\Sent") return Promise.resolve("Sent");
      return Promise.reject(new Error("unknown flag"));
    });
    mockSendRawMessage.mockResolvedValue({
      messageId: "<sent-draft@test.com>",
      accepted: ["r@test.com"],
      rejected: [],
    });
    mockAppendMessage.mockResolvedValue({ uid: 300 });
    mockDeleteEmails.mockResolvedValue(undefined);
    mockSmtpService.config = { autoSent: false, smtp: { user: "user@test.com" } };
  });

  it("fetches draft, sends via SMTP, copies to Sent, deletes from Drafts", async () => {
    const rawDraft = Buffer.from(
      "From: user@test.com\r\nTo: r@test.com\r\nSubject: Draft\r\nMessage-ID: <draft-1@test.com>\r\n\r\nDraft body",
    );
    mockFetchRawSource.mockResolvedValueOnce(rawDraft);

    const result = await handleEmailTool(
      "send_draft",
      { uid: 500 },
      mockImapService,
      mockSmtpService,
    );

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("sent");
    expect(parsed.messageId).toBe("<sent-draft@test.com>");

    // Verify draft was fetched from Drafts folder
    expect(mockFetchRawSource).toHaveBeenCalledWith("Drafts", 500);

    // Verify SMTP send
    expect(mockSendRawMessage).toHaveBeenCalledWith(
      rawDraft,
      expect.objectContaining({
        from: "user@test.com",
        to: expect.arrayContaining(["r@test.com"]),
      }),
    );

    // Verify Sent copy
    expect(mockAppendMessage).toHaveBeenCalledWith("Sent", rawDraft, ["\\Seen"]);

    // Verify draft deletion (permanent)
    expect(mockDeleteEmails).toHaveBeenCalledWith("Drafts", [500], true);
  });

  it("returns error when draft does not exist", async () => {
    mockFetchRawSource.mockRejectedValueOnce(new Error("Email UID 999 not found"));

    const result = await handleEmailTool(
      "send_draft",
      { uid: 999 },
      mockImapService,
      mockSmtpService,
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not found");
  });

  it("uses custom folder when provided", async () => {
    const rawDraft = Buffer.from(
      "From: user@test.com\r\nTo: r@test.com\r\nSubject: Test\r\nMessage-ID: <d@test.com>\r\n\r\nBody",
    );
    mockFetchRawSource.mockResolvedValueOnce(rawDraft);

    await handleEmailTool(
      "send_draft",
      { uid: 500, folder: "My Drafts" },
      mockImapService,
      mockSmtpService,
    );

    expect(mockFetchRawSource).toHaveBeenCalledWith("My Drafts", 500);
  });

  it("send_draft delivers to Bcc recipients but strips the Bcc header from the transmitted message", async () => {
    const draftRaw = Buffer.from(
      "From: alice@example.com\r\nTo: bob@example.com\r\nBcc: carol@example.com\r\nSubject: s\r\nMessage-ID: <d1@example.com>\r\n\r\nbody",
    );
    mockFetchRawSource.mockResolvedValueOnce(draftRaw);

    await handleEmailTool("send_draft", { uid: 7 }, mockImapService, mockSmtpService);

    const [sentRaw, envelope] = mockSendRawMessage.mock.calls[0];
    expect(envelope.to).toContain("carol@example.com"); // envelope keeps bcc
    expect(sentRaw.toString()).not.toMatch(/^bcc:/im); // header stripped from wire message
  });
});

describe("uids guards", () => {
  const mockMoveEmails = vi.fn();
  const mockMarkEmails = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockImapService.moveEmails = mockMoveEmails;
    mockImapService.markEmails = mockMarkEmails;
  });

  it.each(["move_email", "mark_email", "delete_email"])(
    "%s rejects an empty uids array",
    async (tool) => {
      const args: Record<string, unknown> = { uids: [] };
      if (tool === "move_email") args.destination = "Archive";
      if (tool === "mark_email") args.flags = ["\\Seen"];

      const result = await handleEmailTool(tool, args, mockImapService, mockSmtpService);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/uids must be a non-empty array/);
    },
  );
});
