import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImapService } from "../services/ImapService.js";

// Mock imapflow
const mockFetchOne = vi.fn();
const mockFetch = vi.fn();
const mockSearch = vi.fn();
const mockMessageMove = vi.fn();
const mockMessageDelete = vi.fn();
const mockMessageFlagsAdd = vi.fn();
const mockMessageFlagsRemove = vi.fn();
const mockList = vi.fn();
const mockMailboxCreate = vi.fn();
const mockDownload = vi.fn();
const mockGetMailboxLock = vi.fn();
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockLogout = vi.fn().mockResolvedValue(undefined);

vi.mock("imapflow", () => ({
  ImapFlow: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    logout: mockLogout,
    getMailboxLock: mockGetMailboxLock.mockResolvedValue({
      release: vi.fn(),
    }),
    fetchOne: mockFetchOne,
    fetch: mockFetch,
    search: mockSearch,
    messageMove: mockMessageMove,
    messageDelete: mockMessageDelete,
    messageFlagsAdd: mockMessageFlagsAdd,
    messageFlagsRemove: mockMessageFlagsRemove,
    list: mockList,
    mailboxCreate: mockMailboxCreate,
    download: mockDownload,
    mailbox: { exists: 100 },
  })),
}));

// Mock mailparser
vi.mock("mailparser", () => ({
  simpleParser: vi.fn().mockResolvedValue({
    messageId: "<msg-1@test.com>",
    subject: "Test Subject",
    from: { value: [{ address: "sender@test.com", name: "Sender" }] },
    to: { value: [{ address: "recipient@test.com", name: "Recipient" }] },
    cc: null,
    date: new Date("2026-03-04T12:00:00Z"),
    text: "Hello world",
    html: "<p>Hello world</p>",
    attachments: [
      {
        filename: "doc.pdf",
        contentType: "application/pdf",
        size: 1024,
        content: Buffer.from("pdf-content"),
      },
    ],
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
};

describe("ImapService", () => {
  let service: ImapService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ImapService(testConfig);
  });

  describe("listFolders", () => {
    it("returns list of IMAP folders", async () => {
      mockList.mockResolvedValueOnce([
        {
          path: "INBOX",
          specialUse: "\\Inbox",
          delimiter: "/",
          listed: true,
          subscribed: true,
        },
        {
          path: "Sent",
          specialUse: "\\Sent",
          delimiter: "/",
          listed: true,
          subscribed: true,
        },
        {
          path: "Trash",
          specialUse: "\\Trash",
          delimiter: "/",
          listed: true,
          subscribed: true,
        },
      ]);

      const folders = await service.listFolders();
      expect(folders).toHaveLength(3);
      expect(folders[0]).toEqual({
        path: "INBOX",
        specialUse: "\\Inbox",
        delimiter: "/",
      });
      expect(mockConnect).toHaveBeenCalled();
      expect(mockLogout).toHaveBeenCalled();
    });
  });

  describe("searchEmails", () => {
    it("searches emails and returns summaries", async () => {
      mockSearch.mockResolvedValueOnce([101, 102]);

      const messages = [
        {
          uid: 101,
          envelope: {
            messageId: "<msg-101@test.com>",
            subject: "First",
            from: [{ address: "a@test.com", name: "A" }],
            to: [{ address: "b@test.com", name: "B" }],
            date: new Date("2026-03-04"),
          },
          flags: new Set(["\\Seen"]),
          bodyStructure: { type: "text/plain" },
        },
        {
          uid: 102,
          envelope: {
            messageId: "<msg-102@test.com>",
            subject: "Second",
            from: [{ address: "c@test.com", name: "C" }],
            to: [{ address: "d@test.com", name: "D" }],
            date: new Date("2026-03-03"),
          },
          flags: new Set([]),
          bodyStructure: {
            childNodes: [{ type: "multipart/mixed" }],
          },
        },
      ];
      mockFetch.mockReturnValueOnce(
        (async function* () {
          for (const msg of messages) yield msg;
        })(),
      );

      const results = await service.searchEmails("INBOX", {}, { limit: 10 });
      expect(results).toHaveLength(2);
      expect(results[0].uid).toBe(101);
      expect(results[0].subject).toBe("First");
      expect(results[0].flags).toContain("\\Seen");
    });
  });

  describe("fetchEmail", () => {
    it("fetches a full email by UID", async () => {
      mockFetchOne.mockResolvedValueOnce({
        source: Buffer.from("raw email source"),
      });

      const email = await service.fetchEmail("INBOX", 12345);
      expect(email.subject).toBe("Test Subject");
      expect(email.textBody).toBe("Hello world");
      expect(email.attachments).toHaveLength(1);
      expect(email.attachments[0].filename).toBe("doc.pdf");
    });
  });

  describe("moveEmails", () => {
    it("moves emails to destination folder", async () => {
      mockMessageMove.mockResolvedValueOnce({ destination: "Archive" });

      await service.moveEmails("INBOX", [101, 102], "Archive");
      expect(mockMessageMove).toHaveBeenCalledWith("101,102", "Archive", {
        uid: true,
      });
    });
  });

  describe("markEmails", () => {
    it("adds flags to emails", async () => {
      await service.markEmails("INBOX", [101], ["\\Seen"], "add");
      expect(mockMessageFlagsAdd).toHaveBeenCalledWith("101", ["\\Seen"], { uid: true });
    });

    it("removes flags from emails", async () => {
      await service.markEmails("INBOX", [101], ["\\Seen"], "remove");
      expect(mockMessageFlagsRemove).toHaveBeenCalledWith("101", ["\\Seen"], { uid: true });
    });
  });

  describe("deleteEmails", () => {
    it("moves to Trash by default", async () => {
      mockMessageMove.mockResolvedValueOnce({ destination: "Trash" });

      await service.deleteEmails("INBOX", [101]);
      expect(mockMessageMove).toHaveBeenCalledWith("101", "Trash", {
        uid: true,
      });
    });

    it("permanently deletes when permanent flag set", async () => {
      await service.deleteEmails("INBOX", [101], true);
      expect(mockMessageDelete).toHaveBeenCalledWith("101", {
        uid: true,
      });
    });
  });

  describe("createFolder", () => {
    it("creates a new IMAP folder", async () => {
      await service.createFolder("Projects/Work");
      expect(mockMailboxCreate).toHaveBeenCalledWith("Projects/Work");
    });
  });

  describe("downloadAttachment", () => {
    it("downloads attachment by part ID", async () => {
      const content = Buffer.from("attachment-data");
      mockDownload.mockResolvedValueOnce({
        meta: {
          contentType: "application/pdf",
          filename: "doc.pdf",
          expectedSize: 1024,
        },
        content: {
          read: () => content,
          [Symbol.asyncIterator]: async function* () {
            yield content;
          },
        },
      });

      const result = await service.downloadAttachment("INBOX", 12345, "2");
      expect(result.filename).toBe("doc.pdf");
      expect(result.contentType).toBe("application/pdf");
      expect(mockDownload).toHaveBeenCalledWith("12345", "2", {
        uid: true,
      });
    });
  });

  describe("fetchRawEmail", () => {
    it("returns raw email source as string", async () => {
      mockFetchOne.mockResolvedValueOnce({
        source: Buffer.from("From: test@test.com\r\nSubject: Test\r\n\r\nBody"),
      });

      const raw = await service.fetchRawEmail("INBOX", 12345);
      expect(raw).toContain("From: test@test.com");
      expect(raw).toContain("Subject: Test");
    });
  });
});
