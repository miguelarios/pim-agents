import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
const mockStatus = vi.fn();
const mockGetMailboxLock = vi.fn();
const mockAppend = vi.fn();
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
    status: mockStatus,
    append: mockAppend,
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
      expect(results[1].uid).toBe(102);
      expect(results[1].subject).toBe("Second");
    });

    it("returns results sorted by date descending", async () => {
      mockSearch.mockResolvedValueOnce([101, 102, 103]);

      const messages = [
        {
          uid: 101,
          envelope: {
            messageId: "<msg-101@test.com>",
            subject: "Old",
            from: [{ address: "a@test.com", name: "A" }],
            to: [{ address: "b@test.com", name: "B" }],
            date: new Date("2026-03-01"),
          },
          flags: new Set([]),
          bodyStructure: { type: "text/plain" },
        },
        {
          uid: 102,
          envelope: {
            messageId: "<msg-102@test.com>",
            subject: "Newest",
            from: [{ address: "c@test.com", name: "C" }],
            to: [{ address: "d@test.com", name: "D" }],
            date: new Date("2026-03-10"),
          },
          flags: new Set([]),
          bodyStructure: { type: "text/plain" },
        },
        {
          uid: 103,
          envelope: {
            messageId: "<msg-103@test.com>",
            subject: "Middle",
            from: [{ address: "e@test.com", name: "E" }],
            to: [{ address: "f@test.com", name: "F" }],
            date: new Date("2026-03-05"),
          },
          flags: new Set([]),
          bodyStructure: { type: "text/plain" },
        },
      ];
      mockFetch.mockReturnValueOnce(
        (async function* () {
          for (const msg of messages) yield msg;
        })(),
      );

      const results = await service.searchEmails("INBOX", {}, { limit: 10 });
      expect(results[0].subject).toBe("Newest");
      expect(results[1].subject).toBe("Middle");
      expect(results[2].subject).toBe("Old");
    });

    it("passes search criteria from SearchParams to IMAP", async () => {
      mockSearch.mockResolvedValueOnce([]);

      await service.searchEmails("INBOX", { from: "boss@work.com", unread: true });
      expect(mockSearch).toHaveBeenCalledWith(
        { from: "boss@work.com", seen: false },
        { uid: true },
      );
    });

    it("intersects UIDs when criteria has duplicate keys (multi-word subject)", async () => {
      // First search: subject "dinner" → UIDs [101, 102, 103]
      mockSearch.mockResolvedValueOnce([101, 102, 103]);
      // Second search: subject "movie" → UIDs [102, 103, 104]
      mockSearch.mockResolvedValueOnce([102, 103, 104]);

      const messages = [
        {
          uid: 102,
          envelope: {
            messageId: "<msg-102@test.com>",
            subject: "Dinner and a movie",
            from: [{ address: "a@test.com", name: "A" }],
            to: [{ address: "b@test.com", name: "B" }],
            date: new Date("2026-03-04"),
          },
          flags: new Set([]),
          bodyStructure: { type: "text/plain" },
        },
        {
          uid: 103,
          envelope: {
            messageId: "<msg-103@test.com>",
            subject: "Movie dinner plans",
            from: [{ address: "c@test.com", name: "C" }],
            to: [{ address: "d@test.com", name: "D" }],
            date: new Date("2026-03-03"),
          },
          flags: new Set([]),
          bodyStructure: { type: "text/plain" },
        },
      ];
      mockFetch.mockReturnValueOnce(
        (async function* () {
          for (const msg of messages) yield msg;
        })(),
      );

      const results = await service.searchEmails("INBOX", { subject: "dinner movie" });

      // Should have called search twice — once per token
      expect(mockSearch).toHaveBeenCalledTimes(2);
      expect(mockSearch).toHaveBeenCalledWith({ subject: "dinner" }, { uid: true });
      expect(mockSearch).toHaveBeenCalledWith({ subject: "movie" }, { uid: true });

      // Should return only the intersection: UIDs 102 and 103
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.uid).sort()).toEqual([102, 103]);
    });

    it("sorts by date ascending when sortOrder is asc", async () => {
      mockSearch.mockResolvedValueOnce([101, 102, 103]);

      const messages = [
        {
          uid: 101,
          envelope: {
            messageId: "<msg-101@test.com>",
            subject: "Old",
            from: [{ address: "a@test.com", name: "A" }],
            to: [{ address: "b@test.com", name: "B" }],
            date: new Date("2026-03-01"),
          },
          flags: new Set([]),
          bodyStructure: { type: "text/plain" },
        },
        {
          uid: 102,
          envelope: {
            messageId: "<msg-102@test.com>",
            subject: "Newest",
            from: [{ address: "c@test.com", name: "C" }],
            to: [{ address: "d@test.com", name: "D" }],
            date: new Date("2026-03-10"),
          },
          flags: new Set([]),
          bodyStructure: { type: "text/plain" },
        },
        {
          uid: 103,
          envelope: {
            messageId: "<msg-103@test.com>",
            subject: "Middle",
            from: [{ address: "e@test.com", name: "E" }],
            to: [{ address: "f@test.com", name: "F" }],
            date: new Date("2026-03-05"),
          },
          flags: new Set([]),
          bodyStructure: { type: "text/plain" },
        },
      ];
      mockFetch.mockReturnValueOnce(
        (async function* () {
          for (const msg of messages) yield msg;
        })(),
      );

      const results = await service.searchEmails(
        "INBOX",
        {},
        { limit: 10, sortBy: "date", sortOrder: "asc" },
      );
      expect(results[0].subject).toBe("Old");
      expect(results[1].subject).toBe("Middle");
      expect(results[2].subject).toBe("Newest");
    });

    it("sorts by from name (case-insensitive)", async () => {
      mockSearch.mockResolvedValueOnce([101, 102, 103]);

      const messages = [
        {
          uid: 101,
          envelope: {
            messageId: "<msg-101@test.com>",
            subject: "S1",
            from: [{ address: "charlie@test.com", name: "Charlie" }],
            to: [{ address: "x@test.com", name: "X" }],
            date: new Date("2026-03-01"),
          },
          flags: new Set([]),
          bodyStructure: { type: "text/plain" },
        },
        {
          uid: 102,
          envelope: {
            messageId: "<msg-102@test.com>",
            subject: "S2",
            from: [{ address: "alice@test.com", name: "alice" }],
            to: [{ address: "x@test.com", name: "X" }],
            date: new Date("2026-03-02"),
          },
          flags: new Set([]),
          bodyStructure: { type: "text/plain" },
        },
        {
          uid: 103,
          envelope: {
            messageId: "<msg-103@test.com>",
            subject: "S3",
            from: [{ address: "bob@test.com", name: "Bob" }],
            to: [{ address: "x@test.com", name: "X" }],
            date: new Date("2026-03-03"),
          },
          flags: new Set([]),
          bodyStructure: { type: "text/plain" },
        },
      ];
      mockFetch.mockReturnValueOnce(
        (async function* () {
          for (const msg of messages) yield msg;
        })(),
      );

      const results = await service.searchEmails(
        "INBOX",
        {},
        { limit: 10, sortBy: "from", sortOrder: "asc" },
      );
      expect(results[0].from.name).toBe("alice");
      expect(results[1].from.name).toBe("Bob");
      expect(results[2].from.name).toBe("Charlie");
    });

    it("sorts by from address when name is undefined", async () => {
      mockSearch.mockResolvedValueOnce([101, 102]);

      const messages = [
        {
          uid: 101,
          envelope: {
            messageId: "<msg-101@test.com>",
            subject: "S1",
            from: [{ address: "zoe@test.com", name: undefined }],
            to: [{ address: "x@test.com", name: "X" }],
            date: new Date("2026-03-01"),
          },
          flags: new Set([]),
          bodyStructure: { type: "text/plain" },
        },
        {
          uid: 102,
          envelope: {
            messageId: "<msg-102@test.com>",
            subject: "S2",
            from: [{ address: "alice@test.com", name: "Alice" }],
            to: [{ address: "x@test.com", name: "X" }],
            date: new Date("2026-03-02"),
          },
          flags: new Set([]),
          bodyStructure: { type: "text/plain" },
        },
      ];
      mockFetch.mockReturnValueOnce(
        (async function* () {
          for (const msg of messages) yield msg;
        })(),
      );

      const results = await service.searchEmails(
        "INBOX",
        {},
        { limit: 10, sortBy: "from", sortOrder: "asc" },
      );
      expect(results[0].from.name).toBe("Alice");
      expect(results[1].from.address).toBe("zoe@test.com");
    });

    it("sorts by subject (case-insensitive)", async () => {
      mockSearch.mockResolvedValueOnce([101, 102, 103]);

      const messages = [
        {
          uid: 101,
          envelope: {
            messageId: "<msg-101@test.com>",
            subject: "Zulu",
            from: [{ address: "a@test.com", name: "A" }],
            to: [{ address: "x@test.com", name: "X" }],
            date: new Date("2026-03-01"),
          },
          flags: new Set([]),
          bodyStructure: { type: "text/plain" },
        },
        {
          uid: 102,
          envelope: {
            messageId: "<msg-102@test.com>",
            subject: "alpha",
            from: [{ address: "b@test.com", name: "B" }],
            to: [{ address: "x@test.com", name: "X" }],
            date: new Date("2026-03-02"),
          },
          flags: new Set([]),
          bodyStructure: { type: "text/plain" },
        },
        {
          uid: 103,
          envelope: {
            messageId: "<msg-103@test.com>",
            subject: "Bravo",
            from: [{ address: "c@test.com", name: "C" }],
            to: [{ address: "x@test.com", name: "X" }],
            date: new Date("2026-03-03"),
          },
          flags: new Set([]),
          bodyStructure: { type: "text/plain" },
        },
      ];
      mockFetch.mockReturnValueOnce(
        (async function* () {
          for (const msg of messages) yield msg;
        })(),
      );

      const results = await service.searchEmails(
        "INBOX",
        {},
        { limit: 10, sortBy: "subject", sortOrder: "asc" },
      );
      expect(results[0].subject).toBe("alpha");
      expect(results[1].subject).toBe("Bravo");
      expect(results[2].subject).toBe("Zulu");
    });

    it("Tier 2: sorts within page when >1000 UIDs with non-date sortBy", async () => {
      const allUids = Array.from({ length: 1500 }, (_, i) => i + 1);
      mockSearch.mockResolvedValueOnce(allUids);

      // After reversing and slicing offset=0 limit=2: [1500, 1499]
      const fetchedMessages = [
        {
          uid: 1500,
          envelope: {
            messageId: "<msg-1500@test.com>",
            subject: "Zulu",
            from: [{ address: "a@test.com", name: "A" }],
            to: [{ address: "b@test.com", name: "B" }],
            date: new Date("2026-03-05"),
          },
          flags: new Set([]),
          bodyStructure: { type: "text/plain" },
        },
        {
          uid: 1499,
          envelope: {
            messageId: "<msg-1499@test.com>",
            subject: "Alpha",
            from: [{ address: "c@test.com", name: "C" }],
            to: [{ address: "d@test.com", name: "D" }],
            date: new Date("2026-03-10"),
          },
          flags: new Set([]),
          bodyStructure: { type: "text/plain" },
        },
      ];
      mockFetch.mockReturnValueOnce(
        (async function* () {
          for (const msg of fetchedMessages) yield msg;
        })(),
      );

      const results = await service.searchEmails(
        "INBOX",
        {},
        { limit: 2, offset: 0, sortBy: "subject", sortOrder: "asc" },
      );
      expect(results).toHaveLength(2);
      expect(results[0].subject).toBe("Alpha");
      expect(results[1].subject).toBe("Zulu");
    });

    it("Tier 2: fetches only the paginated slice when >1000 UIDs are returned", async () => {
      // Generate 1500 ascending UIDs: [1, 2, ..., 1500]
      const allUids = Array.from({ length: 1500 }, (_, i) => i + 1);
      mockSearch.mockResolvedValueOnce(allUids);

      // After reversing: [1500, 1499, ..., 1]
      // With offset=0, limit=2 the slice is [1500, 1499]
      // fetchSummaries is called with those two UIDs
      const fetchedMessages = [
        {
          uid: 1500,
          envelope: {
            messageId: "<msg-1500@test.com>",
            subject: "Older",
            from: [{ address: "a@test.com", name: "A" }],
            to: [{ address: "b@test.com", name: "B" }],
            date: new Date("2026-03-05"),
          },
          flags: new Set([]),
          bodyStructure: { type: "text/plain" },
        },
        {
          uid: 1499,
          envelope: {
            messageId: "<msg-1499@test.com>",
            subject: "Newest",
            from: [{ address: "c@test.com", name: "C" }],
            to: [{ address: "d@test.com", name: "D" }],
            date: new Date("2026-03-10"),
          },
          flags: new Set([]),
          bodyStructure: { type: "text/plain" },
        },
      ];
      mockFetch.mockReturnValueOnce(
        (async function* () {
          for (const msg of fetchedMessages) yield msg;
        })(),
      );

      const results = await service.searchEmails("INBOX", {}, { limit: 2, offset: 0 });

      // Only 2 messages fetched, not all 1500
      expect(results).toHaveLength(2);

      // fetch was called with only the sliced UIDs, not all 1500
      expect(mockFetch).toHaveBeenCalledWith(
        "1500,1499",
        expect.objectContaining({ envelope: true, uid: true }),
        { uid: true },
      );

      // Results sorted by date descending
      expect(results[0].subject).toBe("Newest");
      expect(results[1].subject).toBe("Older");
    });

    it("folds base criteria into each IMAP SEARCH call for tokenized fields", async () => {
      // First search: from + subject "dinner" → UIDs [101, 102]
      mockSearch.mockResolvedValueOnce([101, 102]);
      // Second search: from + subject "movie" → UIDs [102, 103]
      mockSearch.mockResolvedValueOnce([102, 103]);

      const messages = [
        {
          uid: 102,
          envelope: {
            messageId: "<msg-102@test.com>",
            subject: "Dinner and a movie",
            from: [{ address: "alice@test.com", name: "Alice" }],
            to: [{ address: "b@test.com", name: "B" }],
            date: new Date("2026-03-04"),
          },
          flags: new Set([]),
          bodyStructure: { type: "text/plain" },
        },
      ];
      mockFetch.mockReturnValueOnce(
        (async function* () {
          for (const msg of messages) yield msg;
        })(),
      );

      const results = await service.searchEmails("INBOX", {
        from: "alice@test.com",
        subject: "dinner movie",
      });

      // Should have called search twice — each with from folded in
      expect(mockSearch).toHaveBeenCalledTimes(2);
      expect(mockSearch).toHaveBeenCalledWith(
        { from: "alice@test.com", subject: "dinner" },
        { uid: true },
      );
      expect(mockSearch).toHaveBeenCalledWith(
        { from: "alice@test.com", subject: "movie" },
        { uid: true },
      );

      // Intersection: only UID 102
      expect(results).toHaveLength(1);
      expect(results[0].uid).toBe(102);
    });
  });

  describe("fetchEmail", () => {
    it("fetches a full email by UID", async () => {
      mockFetchOne.mockResolvedValueOnce({
        source: Buffer.from("raw email source"),
        bodyStructure: {
          type: "multipart/mixed",
          childNodes: [
            { type: "text/plain", part: "1", size: 20 },
            {
              type: "application/pdf",
              part: "2",
              size: 1024,
              disposition: "attachment",
              dispositionParameters: { filename: "doc.pdf" },
            },
          ],
        },
      });

      const email = await service.fetchEmail("INBOX", 12345);
      expect(email.subject).toBe("Test Subject");
      expect(email.textBody).toBe("Hello world");
      expect(email.attachments).toHaveLength(1);
      expect(email.attachments[0].filename).toBe("doc.pdf");
    });

    it("returns inReplyTo and references from parsed email", async () => {
      const { simpleParser } = await import("mailparser");
      vi.mocked(simpleParser).mockResolvedValueOnce({
        messageId: "<msg-1@test.com>",
        subject: "Re: Original",
        from: { value: [{ address: "sender@test.com", name: "Sender" }] },
        to: { value: [{ address: "recipient@test.com", name: "Recipient" }] },
        cc: null,
        date: new Date("2026-03-04T12:00:00Z"),
        text: "Reply body",
        html: null,
        attachments: [],
        inReplyTo: "<original@test.com>",
        references: ["<root@test.com>", "<original@test.com>"],
      } as any);

      mockFetchOne.mockResolvedValueOnce({
        source: Buffer.from("raw email"),
        uid: 42,
      });

      const email = await service.fetchEmail("INBOX", 42);
      expect(email.inReplyTo).toBe("<original@test.com>");
      expect(email.references).toEqual(["<root@test.com>", "<original@test.com>"]);
    });

    it("returns null inReplyTo and empty references for non-reply emails", async () => {
      mockFetchOne.mockResolvedValueOnce({
        source: Buffer.from("raw email"),
        uid: 10,
      });

      const email = await service.fetchEmail("INBOX", 10);
      expect(email.inReplyTo).toBeNull();
      expect(email.references).toEqual([]);
    });
  });

  describe("fetchEmail attachment part IDs", () => {
    it("reports bodystructure part paths, not array indices", async () => {
      mockFetchOne.mockResolvedValueOnce({
        source: Buffer.from("raw"),
        flags: new Set(["\\Seen", "\\Flagged"]),
        bodyStructure: {
          type: "multipart/mixed",
          childNodes: [
            {
              type: "multipart/alternative",
              part: "1",
              childNodes: [
                { type: "text/plain", part: "1.1", size: 20 },
                { type: "text/html", part: "1.2", size: 40 },
              ],
            },
            {
              type: "application/pdf",
              part: "2",
              size: 1024,
              disposition: "attachment",
              dispositionParameters: { filename: "doc.pdf" },
            },
          ],
        },
      });

      const email = await service.fetchEmail("INBOX", 42);

      expect(email.attachments).toEqual([
        { filename: "doc.pdf", contentType: "application/pdf", size: 1024, partId: "2" },
      ]);
      expect(email.flags).toEqual(expect.arrayContaining(["\\Seen", "\\Flagged"]));
      expect(email.hasAttachments).toBe(true);
    });
  });

  describe("fetchEmail calendar parts", () => {
    const ICS = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:invite-1@test.com",
      "DTSTART:20260815T140000Z",
      "SUMMARY:Planning sync",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    /** Parsed-message shape with a decoded inline calendar part and no filename. */
    function parsedWithCalendar(attachments: unknown[]) {
      return {
        messageId: "<invite@test.com>",
        subject: "Invitation",
        from: { value: [{ address: "organizer@test.com", name: "Organizer" }] },
        to: { value: [{ address: "attendee@test.com", name: "Attendee" }] },
        cc: null,
        date: new Date("2026-08-10T12:00:00Z"),
        text: "You are invited.",
        html: null,
        attachments,
      } as any;
    }

    it("surfaces an inline base64 text/calendar part with no filename or disposition", async () => {
      const { simpleParser } = await import("mailparser");
      vi.mocked(simpleParser).mockResolvedValueOnce(
        parsedWithCalendar([
          {
            contentType: "text/calendar",
            filename: undefined,
            size: ICS.length,
            content: Buffer.from(ICS, "utf-8"),
          },
        ]),
      );
      mockFetchOne.mockResolvedValueOnce({
        source: Buffer.from("raw"),
        bodyStructure: {
          type: "multipart/alternative",
          childNodes: [
            { type: "text/plain", part: "1", size: 20 },
            {
              type: "text/calendar",
              part: "2",
              size: 228,
              encoding: "base64",
              parameters: { charset: "utf-8", method: "REQUEST" },
            },
          ],
        },
      });

      const email = await service.fetchEmail("INBOX", 42);

      expect(email.hasAttachments).toBe(true);
      expect(email.attachments).toEqual([
        expect.objectContaining({ contentType: "text/calendar", partId: "2" }),
      ]);
      expect(email.calendarParts).toEqual([
        {
          partId: "2",
          contentType: "text/calendar",
          method: "REQUEST",
          filename: null,
          size: 228,
          content: expect.stringContaining("BEGIN:VCALENDAR"),
        },
      ]);
    });

    it("surfaces a quoted-printable inline calendar part", async () => {
      const { simpleParser } = await import("mailparser");
      vi.mocked(simpleParser).mockResolvedValueOnce(
        parsedWithCalendar([
          {
            contentType: "text/calendar",
            filename: undefined,
            size: ICS.length,
            content: Buffer.from(ICS, "utf-8"),
          },
        ]),
      );
      mockFetchOne.mockResolvedValueOnce({
        source: Buffer.from("raw"),
        bodyStructure: {
          type: "multipart/alternative",
          childNodes: [
            { type: "text/plain", part: "1", size: 20 },
            {
              type: "text/calendar",
              part: "2",
              size: 180,
              encoding: "quoted-printable",
              parameters: { charset: "utf-8", method: "REQUEST" },
            },
          ],
        },
      });

      const email = await service.fetchEmail("INBOX", 42);
      expect(email.hasAttachments).toBe(true);
      expect(email.calendarParts?.[0].content).toContain("BEGIN:VCALENDAR");
      expect(email.calendarParts?.[0].method).toBe("REQUEST");
    });

    it("lists a calendar part that is a proper attachment exactly once per array", async () => {
      const { simpleParser } = await import("mailparser");
      vi.mocked(simpleParser).mockResolvedValueOnce(
        parsedWithCalendar([
          {
            contentType: "text/calendar",
            filename: "invite.ics",
            size: ICS.length,
            content: Buffer.from(ICS, "utf-8"),
          },
        ]),
      );
      mockFetchOne.mockResolvedValueOnce({
        source: Buffer.from("raw"),
        bodyStructure: {
          type: "multipart/mixed",
          childNodes: [
            { type: "text/plain", part: "1", size: 20 },
            {
              type: "text/calendar",
              part: "2",
              size: 228,
              disposition: "attachment",
              dispositionParameters: { filename: "invite.ics" },
              parameters: { method: "REQUEST" },
            },
          ],
        },
      });

      const email = await service.fetchEmail("INBOX", 42);

      expect(email.attachments).toEqual([
        { filename: "invite.ics", contentType: "text/calendar", size: 228, partId: "2" },
      ]);
      expect(email.calendarParts).toHaveLength(1);
      expect(email.calendarParts?.[0].filename).toBe("invite.ics");
    });

    it("handles a non-multipart message whose entire body is text/calendar", async () => {
      const { simpleParser } = await import("mailparser");
      vi.mocked(simpleParser).mockResolvedValueOnce(
        parsedWithCalendar([
          {
            contentType: "text/calendar",
            filename: undefined,
            size: ICS.length,
            content: Buffer.from(ICS, "utf-8"),
          },
        ]),
      );
      mockFetchOne.mockResolvedValueOnce({
        source: Buffer.from("raw"),
        bodyStructure: {
          type: "text/calendar",
          size: 228,
          encoding: "base64",
          parameters: { charset: "utf-8", method: "REQUEST" },
        },
      });

      const email = await service.fetchEmail("INBOX", 42);
      expect(email.hasAttachments).toBe(true);
      expect(email.calendarParts?.[0].partId).toBe("1");
      expect(email.calendarParts?.[0].content).toContain("BEGIN:VCALENDAR");
    });

    it("omits content and sets truncated for oversized calendar parts", async () => {
      const bigIcs = `BEGIN:VCALENDAR\r\nDESCRIPTION:${"x".repeat(300 * 1024)}\r\nEND:VCALENDAR`;
      const { simpleParser } = await import("mailparser");
      vi.mocked(simpleParser).mockResolvedValueOnce(
        parsedWithCalendar([
          {
            contentType: "text/calendar",
            filename: undefined,
            size: bigIcs.length,
            content: Buffer.from(bigIcs, "utf-8"),
          },
        ]),
      );
      mockFetchOne.mockResolvedValueOnce({
        source: Buffer.from("raw"),
        bodyStructure: {
          type: "multipart/alternative",
          childNodes: [
            { type: "text/plain", part: "1", size: 20 },
            {
              type: "text/calendar",
              part: "2",
              size: 410_000,
              encoding: "base64",
              parameters: { method: "REQUEST" },
            },
          ],
        },
      });

      const email = await service.fetchEmail("INBOX", 42);
      expect(email.calendarParts?.[0].content).toBeUndefined();
      expect(email.calendarParts?.[0].truncated).toBe(true);
      expect(email.calendarParts?.[0].partId).toBe("2");
      expect(email.calendarParts?.[0].method).toBe("REQUEST");
    });

    it("falls back to metadata-only entries when decoded parts cannot be correlated", async () => {
      const { simpleParser } = await import("mailparser");
      vi.mocked(simpleParser).mockResolvedValueOnce(
        parsedWithCalendar([
          {
            contentType: "text/calendar",
            filename: undefined,
            size: ICS.length,
            content: Buffer.from(ICS, "utf-8"),
          },
        ]),
      );
      mockFetchOne.mockResolvedValueOnce({
        source: Buffer.from("raw"),
        bodyStructure: {
          type: "multipart/mixed",
          childNodes: [
            {
              type: "text/calendar",
              part: "1",
              size: 228,
              encoding: "base64",
              parameters: { method: "REQUEST" },
            },
            {
              type: "text/calendar",
              part: "2",
              size: 190,
              encoding: "base64",
              parameters: { method: "REPLY" },
            },
          ],
        },
      });

      const email = await service.fetchEmail("INBOX", 42);
      expect(email.calendarParts).toHaveLength(2);
      for (const part of email.calendarParts ?? []) {
        expect(part.content).toBeUndefined();
      }
    });

    it("pairs decoded content with the right part when several calendar parts exist", async () => {
      const replyIcs = ICS.replace("METHOD:REQUEST", "METHOD:REPLY");
      const { simpleParser } = await import("mailparser");
      vi.mocked(simpleParser).mockResolvedValueOnce(
        parsedWithCalendar([
          {
            contentType: "text/calendar",
            filename: undefined,
            size: ICS.length,
            content: Buffer.from(ICS, "utf-8"),
          },
          {
            contentType: "text/calendar",
            filename: undefined,
            size: replyIcs.length,
            content: Buffer.from(replyIcs, "utf-8"),
          },
        ]),
      );
      mockFetchOne.mockResolvedValueOnce({
        source: Buffer.from("raw"),
        bodyStructure: {
          type: "multipart/mixed",
          childNodes: [
            {
              type: "text/calendar",
              part: "1",
              size: 228,
              encoding: "base64",
              parameters: { method: "REQUEST" },
            },
            {
              type: "text/calendar",
              part: "2",
              size: 226,
              encoding: "base64",
              parameters: { method: "REPLY" },
            },
          ],
        },
      });

      const email = await service.fetchEmail("INBOX", 42);
      expect(email.calendarParts).toHaveLength(2);
      expect(email.calendarParts?.[0].method).toBe("REQUEST");
      expect(email.calendarParts?.[0].content).toContain("METHOD:REQUEST");
      expect(email.calendarParts?.[1].method).toBe("REPLY");
      expect(email.calendarParts?.[1].content).toContain("METHOD:REPLY");
    });

    it("omits calendarParts entirely for emails without calendar parts", async () => {
      mockFetchOne.mockResolvedValueOnce({
        source: Buffer.from("raw"),
        bodyStructure: {
          type: "multipart/mixed",
          childNodes: [
            { type: "text/plain", part: "1", size: 20 },
            {
              type: "application/pdf",
              part: "2",
              size: 1024,
              disposition: "attachment",
              dispositionParameters: { filename: "doc.pdf" },
            },
          ],
        },
      });

      const email = await service.fetchEmail("INBOX", 42);
      expect(email.calendarParts).toBeUndefined();
    });

    it("search summaries report hasAttachments for inline calendar invitations", async () => {
      mockSearch.mockResolvedValueOnce([7]);
      mockFetch.mockReturnValueOnce(
        (async function* () {
          yield {
            uid: 7,
            envelope: {
              messageId: "<invite@test.com>",
              subject: "Invitation",
              from: [{ address: "organizer@test.com", name: "Organizer" }],
              to: [{ address: "attendee@test.com", name: "Attendee" }],
              date: new Date("2026-08-10"),
            },
            flags: new Set([]),
            bodyStructure: {
              type: "multipart/alternative",
              childNodes: [
                { type: "text/plain", part: "1", size: 20 },
                {
                  type: "text/calendar",
                  part: "2",
                  size: 228,
                  encoding: "base64",
                  parameters: { method: "REQUEST" },
                },
              ],
            },
          };
        })(),
      );

      const results = await service.searchEmails("INBOX", { subject: "Invitation" });
      expect(results).toHaveLength(1);
      expect(results[0].hasAttachments).toBe(true);
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
      mockList.mockResolvedValueOnce([
        { path: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
        { path: "Trash", specialUse: "\\Trash", delimiter: "/" },
      ]);
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

    it("deleteEmails (non-permanent) moves to the special-use trash folder, not hardcoded 'Trash'", async () => {
      mockList.mockResolvedValueOnce([
        { path: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
        { path: "Deleted Items", specialUse: "\\Trash", delimiter: "/" },
      ]);
      await service.deleteEmails("INBOX", [1, 2], false);
      expect(mockMessageMove).toHaveBeenCalledWith("1,2", "Deleted Items", { uid: true });
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

  describe("getFolderStatus", () => {
    it("returns total and unseen counts", async () => {
      mockStatus.mockResolvedValueOnce({ messages: 42, unseen: 5 });

      const result = await service.getFolderStatus("INBOX");
      expect(result).toEqual({ total: 42, unseen: 5 });
      expect(mockStatus).toHaveBeenCalledWith("INBOX", {
        messages: true,
        unseen: true,
      });
    });

    it("does not require a mailbox lock", async () => {
      mockStatus.mockResolvedValueOnce({ messages: 0, unseen: 0 });

      await service.getFolderStatus("INBOX");
      expect(mockGetMailboxLock).not.toHaveBeenCalled();
    });
  });

  describe("appendMessage", () => {
    it("appends a raw message to a folder with flags", async () => {
      mockAppend.mockResolvedValueOnce({ uid: 123 });

      const raw = Buffer.from("Subject: Test\r\n\r\nHello");
      const result = await service.appendMessage("Sent", raw, ["\\Seen"]);

      expect(result).toEqual({ uid: 123 });
      expect(mockAppend).toHaveBeenCalledWith("Sent", raw, ["\\Seen"]);
    });

    it("returns uid 0 when server does not support UIDPLUS", async () => {
      mockAppend.mockResolvedValueOnce(false);

      const raw = Buffer.from("Subject: Test\r\n\r\nHello");
      const result = await service.appendMessage("Drafts", raw, ["\\Draft", "\\Seen"]);

      expect(result).toEqual({ uid: 0 });
    });
  });

  describe("fetchRawSource", () => {
    it("fetches raw RFC 822 source as Buffer", async () => {
      const rawContent = Buffer.from("Subject: Test\r\n\r\nHello world");
      mockFetchOne.mockResolvedValueOnce({
        source: rawContent,
        uid: 42,
      });

      const result = await service.fetchRawSource("INBOX", 42);
      expect(result).toEqual(rawContent);
    });

    it("throws EMAIL_NOT_FOUND for missing UID", async () => {
      mockFetchOne.mockResolvedValueOnce(null);

      await expect(service.fetchRawSource("INBOX", 999)).rejects.toThrow("not found");
    });
  });

  describe("timezone formatting", () => {
    const originalTz = process.env.PIM_TIMEZONE;

    beforeAll(() => {
      process.env.PIM_TIMEZONE = "America/Chicago";
    });

    afterAll(() => {
      if (originalTz !== undefined) {
        process.env.PIM_TIMEZONE = originalTz;
      } else {
        delete process.env.PIM_TIMEZONE;
      }
    });

    it("formats searchEmails dates in user timezone", async () => {
      mockSearch.mockResolvedValueOnce([101]);

      const messages = [
        {
          uid: 101,
          envelope: {
            messageId: "<msg-tz@test.com>",
            subject: "TZ Test",
            from: [{ address: "a@test.com", name: "A" }],
            to: [{ address: "b@test.com", name: "B" }],
            date: new Date("2026-03-04T18:00:00Z"),
          },
          flags: new Set([]),
          bodyStructure: { type: "text/plain" },
        },
      ];
      mockFetch.mockReturnValueOnce(
        (async function* () {
          for (const msg of messages) yield msg;
        })(),
      );

      const results = await service.searchEmails("INBOX", {}, { limit: 10 });
      expect(results[0].date).toBe("2026-03-04T12:00:00-06:00");
    });

    it("formats fetchEmail dates in user timezone", async () => {
      mockFetchOne.mockResolvedValueOnce({
        source: Buffer.from("raw email source"),
      });

      const results = await service.fetchEmail("INBOX", 1);
      // Default mock has date: new Date("2026-03-04T12:00:00Z")
      // America/Chicago in March (CST) = UTC-6
      expect(results.date).toBe("2026-03-04T06:00:00-06:00");
    });
  });

  describe("getSpecialUseFolder", () => {
    it("finds Sent folder by special-use flag", async () => {
      mockList.mockResolvedValueOnce([
        { path: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
        { path: "Sent Messages", specialUse: "\\Sent", delimiter: "/" },
        { path: "Trash", specialUse: "\\Trash", delimiter: "/" },
      ]);

      const folder = await service.getSpecialUseFolder("\\Sent");
      expect(folder).toBe("Sent Messages");
    });

    it("finds Drafts folder by special-use flag", async () => {
      mockList.mockResolvedValueOnce([
        { path: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
        { path: "Drafts", specialUse: "\\Drafts", delimiter: "/" },
      ]);

      const folder = await service.getSpecialUseFolder("\\Drafts");
      expect(folder).toBe("Drafts");
    });

    it("falls back to common names when no special-use flag for Sent", async () => {
      mockList.mockResolvedValueOnce([
        { path: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
        { path: "Sent", delimiter: "/" },
        { path: "Trash", delimiter: "/" },
      ]);

      const folder = await service.getSpecialUseFolder("\\Sent");
      expect(folder).toBe("Sent");
    });

    it("falls back to 'Sent Items' when 'Sent' not found", async () => {
      mockList.mockResolvedValueOnce([
        { path: "INBOX", delimiter: "/" },
        { path: "Sent Items", delimiter: "/" },
      ]);

      const folder = await service.getSpecialUseFolder("\\Sent");
      expect(folder).toBe("Sent Items");
    });

    it("falls back to 'INBOX.Drafts' for Drafts", async () => {
      mockList.mockResolvedValueOnce([
        { path: "INBOX", delimiter: "." },
        { path: "INBOX.Drafts", delimiter: "." },
      ]);

      const folder = await service.getSpecialUseFolder("\\Drafts");
      expect(folder).toBe("INBOX.Drafts");
    });

    it("throws FOLDER_NOT_FOUND when no match", async () => {
      mockList.mockResolvedValueOnce([{ path: "INBOX", delimiter: "/" }]);

      await expect(service.getSpecialUseFolder("\\Sent")).rejects.toThrow("FOLDER_NOT_FOUND");
    });
  });
});
