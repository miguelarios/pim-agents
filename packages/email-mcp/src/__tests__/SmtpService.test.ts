import { beforeEach, describe, expect, it, vi } from "vitest";
import { SmtpService } from "../services/SmtpService.js";

const { mockSendMail, mockVerify } = vi.hoisted(() => ({
  mockSendMail: vi.fn(),
  mockVerify: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({
      sendMail: mockSendMail,
      verify: mockVerify,
    }),
  },
  createTransport: vi.fn().mockReturnValue({
    sendMail: mockSendMail,
    verify: mockVerify,
  }),
}));

const testConfig = {
  imap: {
    host: "imap.test.com",
    port: 993,
    user: "user@test.com",
    pass: "secret",
    secure: true,
  },
  smtp: {
    host: "smtp.test.com",
    port: 465,
    user: "user@test.com",
    pass: "secret",
    secure: true,
  },
  fromName: "Test User",
  allowedFrom: ["shared@test.com"],
};

describe("SmtpService", () => {
  let service: SmtpService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMail.mockResolvedValue({
      messageId: "<sent-1@test.com>",
      accepted: ["recipient@test.com"],
      rejected: [],
    });
    mockVerify.mockResolvedValue(true);
    service = new SmtpService(testConfig);
  });

  describe("from address helpers", () => {
    it("defaults to the smtp user when no custom from is requested", () => {
      expect(service.resolveFromAddress()).toBe("user@test.com");
    });

    it("allows configured custom from addresses", () => {
      expect(service.resolveFromAddress("shared@test.com")).toBe("shared@test.com");
    });

    it("rejects unlisted custom from addresses", () => {
      expect(() => service.resolveFromAddress("blocked@test.com")).toThrow(/not allowed/i);
    });

    it("formats From headers with the configured display name", () => {
      expect(service.formatFromHeader("shared@test.com")).toBe('"Test User" <shared@test.com>');
    });

    it("lets a caller override the visible display name", () => {
      expect(service.formatFromHeader("shared@test.com", "John Doe")).toBe(
        '"John Doe" <shared@test.com>',
      );
    });
  });

  describe("sendEmail", () => {
    it("sends a basic email", async () => {
      const result = await service.sendEmail({
        to: ["recipient@test.com"],
        subject: "Test Subject",
        text: "Hello world",
      });

      expect(result.messageId).toBe("<sent-1@test.com>");
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: '"Test User" <user@test.com>',
          to: "recipient@test.com",
          subject: "Test Subject",
          text: "Hello world",
        }),
      );
    });

    it("sends with cc and bcc", async () => {
      await service.sendEmail({
        to: ["a@test.com"],
        cc: ["b@test.com"],
        bcc: ["c@test.com"],
        subject: "Test",
        text: "Hello",
      });

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          cc: "b@test.com",
          bcc: "c@test.com",
        }),
      );
    });

    it("sends with HTML body", async () => {
      await service.sendEmail({
        to: ["a@test.com"],
        subject: "Test",
        html: "<h1>Hello</h1>",
      });

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: "<h1>Hello</h1>",
        }),
      );
    });

    it("sends with attachments", async () => {
      await service.sendEmail({
        to: ["a@test.com"],
        subject: "Test",
        text: "See attached",
        attachments: [{ filename: "doc.pdf", path: "/tmp/doc.pdf" }],
      });

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: [{ filename: "doc.pdf", path: "/tmp/doc.pdf" }],
        }),
      );
    });

    it("uses email address only when no fromName configured", async () => {
      const noNameService = new SmtpService({
        ...testConfig,
        fromName: undefined,
      });

      await noNameService.sendEmail({
        to: ["a@test.com"],
        subject: "Test",
        text: "Hello",
      });

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "user@test.com",
        }),
      );
    });
  });

  describe("composeRawMessage", () => {
    it("composes a basic email to RFC 822 Buffer", async () => {
      const raw = await service.composeRawMessage({
        from: '"Test User" <user@test.com>',
        to: ["recipient@test.com"],
        subject: "Test Subject",
        text: "Hello world",
      });

      expect(Buffer.isBuffer(raw)).toBe(true);
      const content = raw.toString();
      expect(content).toContain("Subject: Test Subject");
      expect(content).toContain("To: recipient@test.com");
      expect(content).toContain("Hello world");
    });

    it("includes In-Reply-To and References headers when provided", async () => {
      const raw = await service.composeRawMessage({
        from: '"Test User" <user@test.com>',
        to: ["recipient@test.com"],
        subject: "Re: Original",
        text: "Reply body",
        inReplyTo: "<original@test.com>",
        references: ["<root@test.com>", "<original@test.com>"],
      });

      const content = raw.toString();
      expect(content).toContain("In-Reply-To: <original@test.com>");
      expect(content).toContain("References: <root@test.com> <original@test.com>");
    });

    it("includes CC header (BCC is stripped per RFC 2822)", async () => {
      const raw = await service.composeRawMessage({
        from: "user@test.com",
        to: ["a@test.com"],
        cc: ["b@test.com"],
        bcc: ["c@test.com"],
        subject: "Test",
        text: "Hello",
      });

      const content = raw.toString();
      expect(content).toContain("Cc: b@test.com");
      // BCC is intentionally omitted from message headers per RFC 2822;
      // it is envelope-only and must not appear in the composed body.
      expect(content).not.toContain("Bcc:");
    });

    it("keeps the Bcc header when keepBcc is set", async () => {
      const raw = await service.composeRawMessage(
        {
          from: "alice@example.com",
          to: ["bob@example.com"],
          bcc: ["carol@example.com"],
          subject: "s",
          text: "b",
        },
        { keepBcc: true },
      );
      expect(raw.toString()).toMatch(/^bcc:.*carol@example\.com/im);
    });
  });

  describe("sendRawMessage", () => {
    it("sends a pre-composed raw message via SMTP", async () => {
      mockSendMail.mockResolvedValueOnce({
        messageId: "<raw-1@test.com>",
        accepted: ["recipient@test.com"],
        rejected: [],
      });

      const raw = Buffer.from("Subject: Test\r\n\r\nHello");
      const result = await service.sendRawMessage(raw, {
        from: "user@test.com",
        to: ["recipient@test.com"],
      });

      expect(result.messageId).toBe("<raw-1@test.com>");
      expect(mockSendMail).toHaveBeenCalledWith({
        envelope: { from: "user@test.com", to: ["recipient@test.com"] },
        raw,
      });
    });
  });
});
