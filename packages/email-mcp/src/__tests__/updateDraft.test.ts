/**
 * update_draft against the real composer and parser: the draft is a real MIME
 * message, the new version is built by the real SmtpService, and what was
 * saved is parsed back to check what survived the merge. Only IMAP is faked.
 */
import { dispatchTool } from "@miguelarios/pim-core/mcp";
import type { ServerContext } from "@modelcontextprotocol/server";
import { type ParsedMail, simpleParser } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SmtpService } from "../services/SmtpService.js";
import { EMAIL_TOOLS } from "../tools/emailTools.js";

const NO_ANSWERS = { mcpReq: { inputResponses: undefined } } as unknown as ServerContext;

const smtp = new SmtpService({
  imap: { host: "imap.test", port: 993, user: "me@example.com", pass: "x", secure: true },
  smtp: { host: "smtp.test", port: 465, user: "me@example.com", pass: "x", secure: true },
} as never);

/** A draft as a mail client would have saved it: a threaded reply with a PDF. */
async function buildDraft(overrides: Record<string, unknown> = {}): Promise<Buffer> {
  const message = new MailComposer({
    from: '"Me Myself" <me@example.com>',
    to: '"Doe, Jane" <jane@example.com>',
    cc: "carl@example.com",
    bcc: "boss@example.com",
    replyTo: "replies@example.com",
    subject: "Re: Budget",
    text: "First version",
    html: "<p>First version</p>",
    inReplyTo: "<orig@example.com>",
    references: "<root@example.com> <orig@example.com>",
    messageId: "<draft-v1@example.com>",
    attachments: [
      {
        filename: "budget.pdf",
        content: Buffer.from("%PDF-1.4 budget"),
        contentType: "application/pdf",
      },
    ],
    ...overrides,
  }).compile();
  (message as unknown as { keepBcc: boolean }).keepBcc = true;
  return new Promise((resolve, reject) =>
    message.build((err, built) => (err ? reject(err) : resolve(built))),
  );
}

const imap = {
  getSpecialUseFolder: vi.fn(),
  fetchDraft: vi.fn(),
  replaceDraft: vi.fn(),
};

const call = (args: Record<string, unknown>) =>
  dispatchTool(EMAIL_TOOLS, "update_draft", args, { imap, smtp } as never, NO_ANSWERS) as Promise<{
    isError?: boolean;
    content: Array<{ text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;

/** The message update_draft handed to IMAP, parsed back. */
async function saved(): Promise<ParsedMail> {
  const raw = imap.replaceDraft.mock.calls[0][2] as Buffer;
  return simpleParser(raw, { keepCidLinks: true });
}

describe("update_draft", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    imap.getSpecialUseFolder.mockResolvedValue("Drafts");
    imap.fetchDraft.mockResolvedValue({ source: await buildDraft(), flags: ["\\Draft", "\\Seen"] });
    imap.replaceDraft.mockResolvedValue({ uid: 42, previousRemoved: true, atomic: false });
  });

  it("is advertised as a non-destructive write that needs a uid", () => {
    const tool = EMAIL_TOOLS.find((t) => t.name === "update_draft")!;
    expect(tool.inputSchema.required).toEqual(["uid"]);
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it("changes the subject and body, keeping everything else, and asks nothing", async () => {
    const result = await call({ uid: 7, subject: "Re: Budget (revised)", text: "Second version" });

    expect(result.isError).toBeFalsy();
    const mail = await saved();
    expect(mail.subject).toBe("Re: Budget (revised)");
    expect(mail.text?.trim()).toBe("Second version");
    // A new body replaces the old one whole: the stale HTML part is not kept
    // beside a text part that now says something else.
    expect(mail.html).toBeFalsy();

    expect(mail.to).toMatchObject({ value: [{ name: "Doe, Jane", address: "jane@example.com" }] });
    expect(mail.cc).toMatchObject({ value: [{ address: "carl@example.com" }] });
    expect(mail.bcc).toMatchObject({ value: [{ address: "boss@example.com" }] });
    expect(mail.replyTo).toMatchObject({ value: [{ address: "replies@example.com" }] });
    expect(mail.from).toMatchObject({ value: [{ name: "Me Myself", address: "me@example.com" }] });
  });

  it("keeps a reply draft threaded", async () => {
    await call({ uid: 7, text: "Second version" });

    const mail = await saved();
    expect(mail.inReplyTo).toBe("<orig@example.com>");
    expect(mail.references).toEqual(["<root@example.com>", "<orig@example.com>"]);
  });

  it("keeps the attachments unless they are replaced", async () => {
    await call({ uid: 7, text: "Second version" });
    let mail = await saved();
    expect(mail.attachments.map((a) => a.filename)).toEqual(["budget.pdf"]);
    expect(mail.attachments[0].content.toString()).toBe("%PDF-1.4 budget");

    imap.replaceDraft.mockClear();
    await call({ uid: 7, attachments: [{ filename: "notes.txt", content: "v2 notes" }] });
    mail = await saved();
    expect(mail.attachments.map((a) => a.filename)).toEqual(["notes.txt"]);

    imap.replaceDraft.mockClear();
    await call({ uid: 7, attachments: [] });
    mail = await saved();
    expect(mail.attachments).toHaveLength(0);
  });

  it("keeps the body when only recipients change, and an empty list clears a field", async () => {
    await call({ uid: 7, to: ["ada@example.com", "bob@example.com"], bcc: [] });

    const mail = await saved();
    expect(mail.to).toMatchObject({
      value: [{ address: "ada@example.com" }, { address: "bob@example.com" }],
    });
    expect(mail.bcc).toBeUndefined();
    expect(mail.cc).toMatchObject({ value: [{ address: "carl@example.com" }] });
    expect(mail.text?.trim()).toBe("First version");
    expect(mail.html).toContain("First version");
  });

  it("does not give an HTML-only draft a text part it never had", async () => {
    imap.fetchDraft.mockResolvedValue({
      source: await buildDraft({ text: undefined, html: "<p>Only <b>HTML</b></p>" }),
      flags: ["\\Draft"],
    });

    await call({ uid: 7, subject: "HTML only" });

    const raw = (imap.replaceDraft.mock.calls[0][2] as Buffer).toString("latin1");
    expect(raw).not.toMatch(/content-type: text\/plain/i);
    expect((await saved()).html).toContain("<b>HTML</b>");
  });

  it("keeps an inline image's Content-ID, so the HTML that cites it still renders", async () => {
    imap.fetchDraft.mockResolvedValue({
      source: await buildDraft({
        html: '<p>Chart: <img src="cid:chart@x"></p>',
        attachments: [
          {
            filename: "chart.png",
            content: Buffer.from("PNG"),
            contentType: "image/png",
            cid: "chart@x",
          },
        ],
      }),
      flags: ["\\Draft"],
    });

    await call({ uid: 7, subject: "Chart" });

    const mail = await saved();
    expect(mail.html).toContain("cid:chart@x");
    expect(mail.attachments[0]).toMatchObject({ filename: "chart.png", cid: "chart@x" });
  });

  it("saves under a fresh Message-ID, carrying the old flags and \\Draft", async () => {
    imap.fetchDraft.mockResolvedValue({
      source: await buildDraft(),
      flags: ["\\Seen", "$Label1", "\\Recent"],
    });

    const result = await call({ uid: 7, text: "v2" });

    const [folder, oldUid, raw, flags, messageId] = imap.replaceDraft.mock.calls[0];
    expect([folder, oldUid]).toEqual(["Drafts", 7]);
    expect(flags).toEqual(["\\Seen", "$Label1", "\\Draft"]);
    const mail = await simpleParser(raw as Buffer);
    expect(mail.messageId).toBe(messageId);
    expect(messageId).not.toBe("<draft-v1@example.com>");

    expect(result.structuredContent).toEqual({
      status: "updated",
      uid: 42,
      folder: "Drafts",
      messageId,
      previousUid: 7,
      previousRemoved: true,
    });
  });

  it("reports a stale copy left behind instead of failing", async () => {
    imap.replaceDraft.mockResolvedValue({ uid: 42, previousRemoved: false, atomic: false });

    const result = await call({ uid: 7, text: "v2" });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      uid: 42,
      previousRemoved: false,
      previousUid: 7,
    });
  });

  it("refuses a call that changes nothing, before touching IMAP", async () => {
    const result = await call({ uid: 7 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("INVALID_INPUT");
    expect(imap.fetchDraft).not.toHaveBeenCalled();
  });

  it("refuses a bad attachment before touching IMAP", async () => {
    const result = await call({
      uid: 7,
      attachments: [{ filename: "x.bin", content: "not base64!", encoding: "base64" }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not valid base64");
    expect(imap.fetchDraft).not.toHaveBeenCalled();
  });

  it("refuses to rewrite a message outside Drafts that is not flagged \\Draft", async () => {
    imap.fetchDraft.mockResolvedValue({ source: await buildDraft(), flags: ["\\Seen"] });

    const result = await call({ uid: 7, folder: "INBOX", text: "v2" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not a draft");
    expect(imap.replaceDraft).not.toHaveBeenCalled();
  });

  it("accepts a \\Draft-flagged message in another folder", async () => {
    const result = await call({ uid: 7, folder: "Work/Drafts", text: "v2" });

    expect(result.isError).toBeFalsy();
    expect(imap.fetchDraft).toHaveBeenCalledWith("Work/Drafts", 7);
    expect(imap.replaceDraft.mock.calls[0][0]).toBe("Work/Drafts");
  });

  it("accepts an unflagged message in the Drafts folder, as other clients save them", async () => {
    imap.fetchDraft.mockResolvedValue({ source: await buildDraft(), flags: [] });

    const result = await call({ uid: 7, text: "v2" });

    expect(result.isError).toBeFalsy();
  });

  it("reports a missing draft as a lookup error", async () => {
    const { EmailError, ErrorCode } = await import("@miguelarios/pim-core");
    imap.fetchDraft.mockRejectedValue(
      new EmailError("Draft UID 99 not found in Drafts", ErrorCode.EMAIL_NOT_FOUND, 99),
    );

    const result = await call({ uid: 99, text: "v2" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("EMAIL_NOT_FOUND");
  });
});
