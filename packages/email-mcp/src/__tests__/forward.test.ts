/**
 * forward_email: the forwarded-message header block, attachment carry-over,
 * and the confirmation that gates putting mail on the wire.
 */
import { dispatchTool } from "@miguelarios/pim-core/mcp";
import type { ServerContext } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMAIL_TOOLS } from "../tools/emailTools.js";

vi.mock("../htmlToMarkdown.js", () => ({
  htmlToMarkdown: vi.fn(async (html: string) => `markdown(${html})`),
}));

const AUTO_CONFIRM = {
  mcpReq: {
    inputResponses: {
      confirm_forward_email: { action: "accept", content: { confirm: true } },
    },
  },
} as unknown as ServerContext;

const NOT_CONFIRMED = { mcpReq: { inputResponses: undefined } } as unknown as ServerContext;

const ORIGINAL = {
  uid: 42,
  messageId: "<original@test.com>",
  subject: "Q3 numbers",
  from: { name: "Ada Lovelace", address: "ada@example.com" },
  to: [{ address: "user@test.com" }, { name: "Bob", address: "bob@example.com" }],
  cc: [{ address: "cara@example.com" }],
  date: "2026-03-04T12:00:00.000Z",
  flags: [],
  hasAttachments: true,
  inReplyTo: null,
  references: [],
  textBody: "Numbers attached.",
  htmlBody: "<p>Numbers attached.</p>",
  attachments: [
    { filename: "q3.pdf", contentType: "application/pdf", size: 4, partId: "2" },
    { filename: "notes.txt", contentType: "text/plain", size: 5, partId: "3" },
  ],
};

const mockFetchEmail = vi.fn();
const mockDownloadAttachment = vi.fn();
const mockComposeRawMessage = vi.fn();
const mockSendRawMessage = vi.fn();
const mockAppendMessage = vi.fn();
const mockGetSpecialUseFolder = vi.fn();

const imap = {
  fetchEmail: mockFetchEmail,
  downloadAttachment: mockDownloadAttachment,
  appendMessage: mockAppendMessage,
  getSpecialUseFolder: mockGetSpecialUseFolder,
} as any;

const smtp = {
  composeRawMessage: mockComposeRawMessage,
  sendRawMessage: mockSendRawMessage,
  resolveFromAddress: vi.fn((requested?: string) => requested || "user@test.com"),
  formatFromHeader: vi.fn((address: string) => address),
  config: { autoSent: true, smtp: { user: "user@test.com" } },
} as any;

const forward = (args: Record<string, unknown>, ctx: ServerContext = AUTO_CONFIRM) =>
  dispatchTool(EMAIL_TOOLS, "forward_email", args, { imap, smtp } as any, ctx) as Promise<any>;

const composed = () => mockComposeRawMessage.mock.calls[0][0];

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchEmail.mockResolvedValue(ORIGINAL);
  mockDownloadAttachment.mockImplementation(async (_f: string, _u: number, partId: string) => ({
    filename: partId === "2" ? "q3.pdf" : "notes.txt",
    contentType: partId === "2" ? "application/pdf" : "text/plain",
    size: 4,
    oversized: false,
    content: Buffer.from(partId === "2" ? "PDF!" : "notes"),
  }));
  mockComposeRawMessage.mockResolvedValue(Buffer.from("raw"));
  mockSendRawMessage.mockResolvedValue({ messageId: "<fwd@test.com>", accepted: [], rejected: [] });
  mockGetSpecialUseFolder.mockResolvedValue("Drafts");
  mockAppendMessage.mockResolvedValue({ uid: 100 });
});

describe("forward_email", () => {
  it("is declared with a title, an output schema and all four annotations", () => {
    const tool = EMAIL_TOOLS.find((t) => t.name === "forward_email")!;
    expect(tool.title).toBeTruthy();
    expect(tool.outputSchema).toBeDefined();
    expect(tool.inputSchema.required).toEqual(["uid", "to"]);
    expect(tool.annotations.readOnlyHint).toBe(false);
    expect(tool.annotations.idempotentHint).toBe(false);
  });

  it("prefixes the subject with Fwd:", async () => {
    await forward({ uid: 42, to: ["dan@example.com"] });
    expect(composed().subject).toBe("Fwd: Q3 numbers");
  });

  it("does not double-prefix a subject that is already forwarded", async () => {
    mockFetchEmail.mockResolvedValue({ ...ORIGINAL, subject: "Fwd: Q3 numbers" });
    await forward({ uid: 42, to: ["dan@example.com"] });
    expect(composed().subject).toBe("Fwd: Q3 numbers");
  });

  it("uses an explicit subject as given", async () => {
    await forward({ uid: 42, to: ["dan@example.com"], subject: "Have a look" });
    expect(composed().subject).toBe("Have a look");
  });

  it("writes the forwarded-message header block above the original body", async () => {
    await forward({ uid: 42, to: ["dan@example.com"] });

    expect(composed().text).toBe(
      "---------- Forwarded message ----------\n" +
        "From: Ada Lovelace <ada@example.com>\n" +
        "Date: 2026-03-04T12:00:00.000Z\n" +
        "Subject: Q3 numbers\n" +
        "To: user@test.com, Bob <bob@example.com>\n" +
        "Cc: cara@example.com\n\n" +
        "Numbers attached.",
    );
  });

  it("puts the note above the forwarded block", async () => {
    await forward({ uid: 42, to: ["dan@example.com"], note: "FYI — see page 3." });

    expect(composed().text.startsWith("FYI — see page 3.\n\n---------- Forwarded message")).toBe(
      true,
    );
  });

  it("omits header lines the original does not have", async () => {
    mockFetchEmail.mockResolvedValue({ ...ORIGINAL, cc: [], date: "" });
    await forward({ uid: 42, to: ["dan@example.com"] });

    expect(composed().text).not.toContain("Cc:");
    expect(composed().text).not.toContain("Date:");
  });

  it("carries every attachment across, by part ID", async () => {
    await forward({ uid: 42, to: ["dan@example.com"] });

    expect(mockDownloadAttachment).toHaveBeenCalledWith("INBOX", 42, "2");
    expect(mockDownloadAttachment).toHaveBeenCalledWith("INBOX", 42, "3");
    expect(composed().attachments).toEqual([
      { filename: "q3.pdf", contentType: "application/pdf", content: Buffer.from("PDF!") },
      { filename: "notes.txt", contentType: "text/plain", content: Buffer.from("notes") },
    ]);
  });

  it("skips attachments when includeAttachments is false", async () => {
    await forward({ uid: 42, to: ["dan@example.com"], includeAttachments: false });

    expect(mockDownloadAttachment).not.toHaveBeenCalled();
    expect(composed().attachments).toBeUndefined();
  });

  it("forwards an HTML body as an HTML part too", async () => {
    await forward({ uid: 42, to: ["dan@example.com"], note: "FYI" });

    expect(composed().html).toContain("Forwarded message");
    expect(composed().html).toContain("<p>Numbers attached.</p>");
    expect(composed().html).toContain("FYI");
  });

  it("renders an HTML-only original into the text part", async () => {
    mockFetchEmail.mockResolvedValue({ ...ORIGINAL, textBody: undefined });
    await forward({ uid: 42, to: ["dan@example.com"] });

    expect(composed().text).toContain("markdown(<p>Numbers attached.</p>)");
  });

  it("starts a new thread — no In-Reply-To, no References", async () => {
    await forward({ uid: 42, to: ["dan@example.com"] });

    expect(composed().inReplyTo).toBeUndefined();
    expect(composed().references).toBeUndefined();
  });

  it("carries cc and bcc through to the envelope", async () => {
    await forward({
      uid: 42,
      to: ["dan@example.com"],
      cc: ["eve@example.com"],
      bcc: ["frank@example.com"],
    });

    const [, envelope] = mockSendRawMessage.mock.calls[0];
    expect(envelope.to).toEqual(["dan@example.com", "eve@example.com", "frank@example.com"]);
  });

  it("asks before sending, naming the recipients and the original subject", async () => {
    const result = await forward({ uid: 42, to: ["dan@example.com"] }, NOT_CONFIRMED);

    expect(result.resultType).toBe("input_required");
    const { message } = result.inputRequests.confirm_forward_email.params;
    expect(message).toContain("dan@example.com");
    expect(message).toContain("Q3 numbers");
    expect(mockSendRawMessage).not.toHaveBeenCalled();
  });

  it("does not send when the user declines", async () => {
    const declined = {
      mcpReq: { inputResponses: { confirm_forward_email: { action: "decline" } } },
    } as unknown as ServerContext;

    const result = await forward({ uid: 42, to: ["dan@example.com"] }, declined);

    expect(result.isError).toBe(true);
    expect(mockSendRawMessage).not.toHaveBeenCalled();
  });

  it("saves to Drafts without asking", async () => {
    const result = await forward(
      { uid: 42, to: ["dan@example.com"], saveToDrafts: true },
      NOT_CONFIRMED,
    );

    expect(result.resultType).toBeUndefined();
    expect(result.structuredContent).toEqual({ status: "draft", uid: 100, folder: "Drafts" });
    expect(mockSendRawMessage).not.toHaveBeenCalled();
    expect(mockAppendMessage).toHaveBeenCalledWith("Drafts", expect.any(Buffer), [
      "\\Draft",
      "\\Seen",
    ]);
  });

  it("rejects an empty recipient list without fetching anything", async () => {
    const result = await forward({ uid: 42, to: [] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/to must be a non-empty/);
    expect(mockFetchEmail).not.toHaveBeenCalled();
  });

  it("surfaces a missing original as a tool error, before asking", async () => {
    mockFetchEmail.mockRejectedValueOnce(new Error("Email UID 42 not found"));

    const result = await forward({ uid: 42, to: ["dan@example.com"] }, NOT_CONFIRMED);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/);
    expect(result.resultType).toBeUndefined();
  });
});
