/**
 * Binary attachment upload on `send_email`.
 *
 * `content` is a JSON string, and nodemailer reads a bare string as UTF-8, so
 * before `encoding` existed the only way to attach real binary was a file
 * inside EMAIL_ATTACHMENT_DIR. That made the obvious round trip impossible:
 * `download_attachment` hands back base64, and there was nowhere to put it.
 * These tests pin that round trip.
 */
import { dispatchTool } from "@miguelarios/pim-core/mcp";
import type { ServerContext } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { EMAIL_TOOLS } from "../tools/emailTools.js";

/** Answers send_email's confirmation with "yes"; the gate has its own tests. */
const AUTO_CONFIRM = {
  mcpReq: {
    inputResponses: { confirm_send_email: { action: "accept", content: { confirm: true } } },
  },
} as unknown as ServerContext;

const smtpStub = () => ({
  config: { smtp: { user: "me@example.com" }, autoSent: true, fromName: undefined },
  resolveFromAddress: vi.fn((requested?: string) => requested?.trim() || "me@example.com"),
  formatFromHeader: vi.fn((address: string) => address),
  composeRawMessage: vi.fn().mockResolvedValue(Buffer.from("raw")),
  sendRawMessage: vi.fn().mockResolvedValue({ messageId: "<sent@test.com>" }),
});

const imapStub = () => ({
  getSpecialUseFolder: vi.fn().mockResolvedValue("Sent"),
  appendMessage: vi.fn().mockResolvedValue({ uid: 1 }),
});

/** A first-round context: nothing confirmed yet. */
const NOT_CONFIRMED = { mcpReq: { inputResponses: undefined } } as unknown as ServerContext;

const sendWith = (attachments: unknown[], smtp: ReturnType<typeof smtpStub>, ctx: ServerContext) =>
  dispatchTool(
    EMAIL_TOOLS,
    "send_email",
    { to: ["someone@example.com"], subject: "Hi", text: "body", attachments },
    { imap: imapStub(), smtp } as never,
    ctx,
  ) as Promise<any>;

const send = (attachments: unknown[], smtp = smtpStub()) =>
  dispatchTool(
    EMAIL_TOOLS,
    "send_email",
    { to: ["someone@example.com"], subject: "Hi", text: "body", attachments },
    { imap: imapStub(), smtp } as never,
    AUTO_CONFIRM,
  ) as Promise<any>;

/** The attachments as they were handed to the SMTP layer. */
const sentAttachments = (smtp: ReturnType<typeof smtpStub>) =>
  smtp.composeRawMessage.mock.calls[0][0].attachments;

const PDF_BYTES = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x00, 0xff, 0xfe]);

describe("send_email attachment encoding", () => {
  it("decodes base64 content to the exact original bytes", async () => {
    const smtp = smtpStub();
    const result = await send(
      [{ filename: "report.pdf", content: PDF_BYTES.toString("base64"), encoding: "base64" }],
      smtp,
    );

    expect(result.isError).toBeFalsy();
    const [attachment] = sentAttachments(smtp);
    expect(Buffer.isBuffer(attachment.content)).toBe(true);
    // Byte-for-byte, not merely "looks right": 0xff/0xfe are exactly what a
    // UTF-8 read would have mangled into replacement characters.
    expect(Buffer.compare(attachment.content, PDF_BYTES)).toBe(0);
  });

  it("does not leak the encoding hint downstream once it has been applied", async () => {
    const smtp = smtpStub();
    await send(
      [{ filename: "a.pdf", content: PDF_BYTES.toString("base64"), encoding: "base64" }],
      smtp,
    );

    // The bytes are already decoded, so a lingering encoding would tell
    // nodemailer to decode them a second time.
    expect(sentAttachments(smtp)[0].encoding).toBeUndefined();
  });

  it("still treats content as text when no encoding is given", async () => {
    const smtp = smtpStub();
    await send([{ filename: "notes.txt", content: "hello, world" }], smtp);

    expect(sentAttachments(smtp)[0].content).toBe("hello, world");
  });

  it("passes an explicit utf8 encoding through as text", async () => {
    const smtp = smtpStub();
    await send([{ filename: "notes.txt", content: "héllo", encoding: "utf8" }], smtp);

    expect(sentAttachments(smtp)[0].content).toBe("héllo");
  });

  it("forwards contentType so a round-tripped file keeps its media type", async () => {
    const smtp = smtpStub();
    await send(
      [
        {
          filename: "scan",
          content: PDF_BYTES.toString("base64"),
          encoding: "base64",
          contentType: "application/pdf",
        },
      ],
      smtp,
    );

    // Without this the type would be guessed from a filename that has no
    // extension to guess from.
    expect(sentAttachments(smtp)[0].contentType).toBe("application/pdf");
  });

  it("accepts base64 that arrives wrapped across lines", async () => {
    const smtp = smtpStub();
    const wrapped = PDF_BYTES.toString("base64").replace(/(.{4})/g, "$1\n");
    await send([{ filename: "a.pdf", content: wrapped, encoding: "base64" }], smtp);

    expect(Buffer.compare(sentAttachments(smtp)[0].content, PDF_BYTES)).toBe(0);
  });

  it.each([
    ["characters outside the alphabet", "not valid base64!"],
    ["a truncated quantum", "YWJjZ"],
    ["non-canonical trailing bits", "YR=="],
  ])("rejects %s rather than sending a corrupt attachment", async (_label, content) => {
    const smtp = smtpStub();
    const result = await send([{ filename: "a.pdf", content, encoding: "base64" }], smtp);

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/base64/i);
    // The code, not just the message: `toPimError` has no pattern for these,
    // so a thrown Error would surface as INTERNAL_ERROR and blame the server
    // for what is plainly a malformed request.
    expect(JSON.parse(result.content[0].text).error).toBe("INVALID_INPUT");
    expect(smtp.composeRawMessage).not.toHaveBeenCalled();
  });

  it("rejects encoding on a path attachment instead of silently ignoring it", async () => {
    const smtp = smtpStub();
    const result = await send(
      [{ filename: "a.pdf", path: "/tmp/a.pdf", encoding: "base64" }],
      smtp,
    );

    expect(result.isError).toBe(true);
    // The message names the real conflict; "no content" would send the caller
    // looking for a missing field rather than an incompatible pair.
    expect(JSON.stringify(result.content)).toMatch(/attaches a path/);
    expect(smtp.composeRawMessage).not.toHaveBeenCalled();
  });

  it("rejects a malformed attachment before asking the user to confirm the send", async () => {
    // Validation sits above the confirmation gate. Confirming an irreversible
    // send and only then being told the payload was never valid spends the
    // confirmation on nothing, and teaches the user that confirming does not
    // mean the mail went out.
    const smtp = smtpStub();
    const result = await sendWith(
      [{ filename: "a.pdf", content: "not valid base64!", encoding: "base64" }],
      smtp,
      NOT_CONFIRMED,
    );

    expect(result.resultType).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error).toBe("INVALID_INPUT");
  });

  it("still asks for confirmation when the attachments are well formed", async () => {
    // The guard above must not have swallowed the gate for valid requests.
    const smtp = smtpStub();
    const result = await sendWith(
      [{ filename: "a.pdf", content: PDF_BYTES.toString("base64"), encoding: "base64" }],
      smtp,
      NOT_CONFIRMED,
    );

    expect(result.resultType).toBe("input_required");
    expect(smtp.composeRawMessage).not.toHaveBeenCalled();
  });

  it("declares encoding and contentType on the tool's input schema", () => {
    const tool = EMAIL_TOOLS.find((t) => t.name === "send_email")!;
    const props = (tool.inputSchema.properties as any).attachments.items.properties;
    expect(props.encoding.enum).toEqual(["base64", "utf8"]);
    expect(props.contentType).toBeDefined();
  });
});
