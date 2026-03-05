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
});
