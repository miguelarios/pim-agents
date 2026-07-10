import { beforeEach, describe, expect, it, vi } from "vitest";
import { CardDavService } from "../services/CardDavService.js";

// Mock tsdav
vi.mock("tsdav", () => {
  const mockClient = {
    login: vi.fn().mockResolvedValue(undefined),
    fetchAddressBooks: vi.fn().mockResolvedValue([
      {
        displayName: "Contacts",
        url: "/dav/addressbooks/users/miguel/contacts/",
        ctag: "abc123",
      },
      {
        displayName: "Work",
        url: "/dav/addressbooks/users/miguel/work/",
        ctag: "def456",
      },
    ]),
    fetchVCards: vi.fn().mockResolvedValue([]),
    createVCard: vi.fn().mockResolvedValue({ ok: true }),
    updateVCard: vi.fn().mockResolvedValue({ ok: true }),
    deleteVCard: vi.fn().mockResolvedValue({ ok: true }),
  };
  return {
    DAVClient: vi.fn().mockImplementation(() => mockClient),
    __mockClient: mockClient,
  };
});

describe("CardDavService", () => {
  let service: CardDavService;

  beforeEach(() => {
    service = new CardDavService({
      url: "https://cloud.example.com/remote.php/dav/addressbooks/users/miguel/",
      username: "miguel",
      password: "secret",
    });
  });

  describe("connect", () => {
    it("creates a DAVClient and calls login", async () => {
      await service.connect();
      const { DAVClient } = await import("tsdav");
      expect(DAVClient).toHaveBeenCalledWith({
        serverUrl: "https://cloud.example.com/remote.php/dav/addressbooks/users/miguel/",
        credentials: { username: "miguel", password: "secret" },
        authMethod: "Basic",
        defaultAccountType: "carddav",
      });
    });
  });

  describe("listAddressBooks", () => {
    it("returns address books after connecting", async () => {
      await service.connect();
      const books = await service.listAddressBooks();
      expect(books).toHaveLength(2);
      expect(books[0].displayName).toBe("Contacts");
      expect(books[1].displayName).toBe("Work");
    });

    it("auto-connects if not connected", async () => {
      const books = await service.listAddressBooks();
      expect(books).toHaveLength(2);
    });
  });

  describe("fetchContacts", () => {
    it("fetches and parses vCards from an address book", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      __mockClient.fetchVCards.mockResolvedValueOnce([
        {
          url: "/dav/contacts/john.vcf",
          etag: '"etag1"',
          data: "BEGIN:VCARD\nVERSION:3.0\nUID:uid-1\nFN:John Doe\nEMAIL:john@test.com\nEND:VCARD",
        },
      ]);

      await service.connect();
      const contacts = await service.fetchContacts("/dav/addressbooks/users/miguel/contacts/");
      expect(contacts).toHaveLength(1);
      expect(contacts[0].uid).toBe("uid-1");
      expect(contacts[0].fullName).toBe("John Doe");
      expect(contacts[0].emails).toEqual([{ value: "john@test.com" }]);
    });
  });

  describe("createContact", () => {
    it("creates a vCard on the server", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      await service.connect();
      await service.createContact("/dav/addressbooks/users/miguel/contacts/", {
        uid: "new-1",
        fullName: "New Person",
        emails: [{ value: "new@test.com" }],
        phones: [],
        addresses: [],
        urls: [],
        otherProperties: [],
      });

      expect(__mockClient.createVCard).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: "new-1.vcf",
        }),
      );
    });
  });

  describe("updateContact", () => {
    it("updates an existing vCard with merge semantics", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      __mockClient.fetchVCards.mockResolvedValueOnce([
        {
          url: "/dav/contacts/uid-1.vcf",
          etag: '"etag1"',
          data: "BEGIN:VCARD\nVERSION:3.0\nUID:uid-1\nFN:Old Name\nEND:VCARD",
        },
      ]);

      await service.connect();
      await service.updateContact("/dav/addressbooks/users/miguel/contacts/", "uid-1", {
        fullName: "New Name",
        emails: [{ value: "new@test.com" }],
      });

      expect(__mockClient.updateVCard).toHaveBeenCalledWith(
        expect.objectContaining({
          vCard: expect.objectContaining({
            url: "/dav/contacts/uid-1.vcf",
            etag: '"etag1"',
          }),
        }),
      );
    });
  });

  describe("updateContact round-trip preservation", () => {
    it("preserves photo, name parts, org units, and social profiles", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      __mockClient.updateVCard.mockClear();
      const CARD = [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "UID:rt-2",
        "FN:Alice Smith",
        "N:Smith;Alice;Beth;Dr.;Jr.",
        "ORG:Acme Corp;Engineering",
        "PHOTO;ENCODING=b;TYPE=JPEG:dGVzdA==",
        "X-SOCIALPROFILE;type=twitter:https://twitter.com/example_user",
        "END:VCARD",
      ].join("\r\n");
      __mockClient.fetchVCards.mockResolvedValueOnce([
        { url: "https://dav.example.com/c/rt-2.vcf", etag: '"e1"', data: CARD },
      ]);
      __mockClient.updateVCard.mockResolvedValueOnce({ ok: true });

      await service.connect();
      await service.updateContact("https://dav.example.com/c/", "rt-2", { title: "Engineer" });

      const sent = __mockClient.updateVCard.mock.calls[0][0].vCard.data as string;
      expect(sent).toContain("PHOTO;ENCODING=b;TYPE=JPEG:dGVzdA==");
      expect(sent).toContain("N:Smith;Alice;Beth;Dr.;Jr.");
      expect(sent).toContain("ORG:Acme Corp;Engineering");
      expect(sent).toContain("X-SOCIALPROFILE;type=twitter:https://twitter.com/example_user");
      expect(sent).toContain("TITLE:Engineer");
    });
  });

  describe("deleteContact", () => {
    it("deletes a vCard by UID", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      __mockClient.fetchVCards.mockResolvedValueOnce([
        {
          url: "/dav/contacts/uid-1.vcf",
          etag: '"etag1"',
          data: "BEGIN:VCARD\nVERSION:3.0\nUID:uid-1\nFN:John Doe\nEND:VCARD",
        },
      ]);

      await service.connect();
      await service.deleteContact("/dav/addressbooks/users/miguel/contacts/", "uid-1");

      expect(__mockClient.deleteVCard).toHaveBeenCalledWith(
        expect.objectContaining({
          vCard: expect.objectContaining({
            url: "/dav/contacts/uid-1.vcf",
          }),
        }),
      );
    });

    it("throws ContactError when contact not found", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      __mockClient.fetchVCards.mockResolvedValueOnce([]);

      await service.connect();
      await expect(
        service.deleteContact("/dav/addressbooks/users/miguel/contacts/", "nonexistent"),
      ).rejects.toThrow("not found");
    });
  });

  describe("searchContacts", () => {
    it("filters contacts by query matching name, email, phone, or org", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      __mockClient.fetchVCards.mockResolvedValueOnce([
        {
          url: "/dav/contacts/1.vcf",
          etag: '"e1"',
          data: "BEGIN:VCARD\nVERSION:3.0\nUID:1\nFN:John Doe\nEMAIL:john@test.com\nORG:ACME\nEND:VCARD",
        },
        {
          url: "/dav/contacts/2.vcf",
          etag: '"e2"',
          data: "BEGIN:VCARD\nVERSION:3.0\nUID:2\nFN:Jane Smith\nEMAIL:jane@other.com\nEND:VCARD",
        },
        {
          url: "/dav/contacts/3.vcf",
          etag: '"e3"',
          data: "BEGIN:VCARD\nVERSION:3.0\nUID:3\nFN:Bob Acme\nEND:VCARD",
        },
      ]);

      await service.connect();
      const results = await service.searchContacts(
        "/dav/addressbooks/users/miguel/contacts/",
        "acme",
      );
      expect(results).toHaveLength(2);
      expect(results.map((c) => c.uid).sort()).toEqual(["1", "3"]);
    });
  });

  describe("resolveContact", () => {
    it("returns resolved shape for a single name match", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      __mockClient.fetchVCards.mockResolvedValueOnce([
        {
          url: "/dav/contacts/1.vcf",
          etag: '"e1"',
          data: "BEGIN:VCARD\nVERSION:3.0\nUID:1\nFN:John Doe\nEMAIL:john@test.com\nEMAIL:john2@test.com\nEND:VCARD",
        },
      ]);

      await service.connect();
      const result = await service.resolveContact(
        "/dav/addressbooks/users/miguel/contacts/",
        "John",
      );
      expect(result).toEqual({
        status: "resolved",
        fullName: "John Doe",
        email: "john@test.com",
      });
    });

    it("returns not_found shape when no match found", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      __mockClient.fetchVCards.mockResolvedValueOnce([]);

      await service.connect();
      const result = await service.resolveContact(
        "/dav/addressbooks/users/miguel/contacts/",
        "Nobody",
      );
      if (result.status !== "not_found")
        throw new Error(`expected not_found, got ${result.status}`);
      expect(result.message).toContain("Nobody");
    });

    it("returns not_found shape when match has no email", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      __mockClient.fetchVCards.mockResolvedValueOnce([
        {
          url: "/dav/contacts/1.vcf",
          etag: '"e1"',
          data: "BEGIN:VCARD\nVERSION:3.0\nUID:1\nFN:John Doe\nEND:VCARD",
        },
      ]);

      await service.connect();
      const result = await service.resolveContact(
        "/dav/addressbooks/users/miguel/contacts/",
        "John",
      );
      expect(result.status).toBe("not_found");
    });
  });

  describe("otherProperties preservation", () => {
    it("preserves otherProperties through update round-trip", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      __mockClient.updateVCard.mockClear();
      __mockClient.fetchVCards.mockResolvedValueOnce([
        {
          url: "/dav/contacts/uid-1.vcf",
          etag: '"etag1"',
          data: "BEGIN:VCARD\nVERSION:3.0\nUID:uid-1\nFN:Test\nEMAIL:test@test.com\nX-CUSTOM:keepme\nEND:VCARD",
        },
      ]);

      await service.connect();
      await service.updateContact("/dav/addressbooks/users/miguel/contacts/", "uid-1", {
        fullName: "Updated Name",
      });

      const updateCall = __mockClient.updateVCard.mock.calls[0][0];
      expect(updateCall.vCard.data).toContain("X-CUSTOM:keepme");
      expect(updateCall.vCard.data).toContain("FN:Updated Name");
    });
  });

  describe("multi-term search", () => {
    it("supports multi-term tokenized search with AND semantics", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      __mockClient.fetchVCards.mockResolvedValueOnce([
        {
          url: "/dav/contacts/1.vcf",
          etag: '"e1"',
          data: "BEGIN:VCARD\nVERSION:3.0\nUID:1\nFN:John Doe\nEMAIL;TYPE=work:john@acme.com\nORG:ACME\nEND:VCARD",
        },
        {
          url: "/dav/contacts/2.vcf",
          etag: '"e2"',
          data: "BEGIN:VCARD\nVERSION:3.0\nUID:2\nFN:Jane Acme\nEMAIL:jane@other.com\nEND:VCARD",
        },
      ]);

      await service.connect();
      const results = await service.searchContacts(
        "/dav/addressbooks/users/miguel/contacts/",
        "acme john",
      );
      expect(results).toHaveLength(1);
      expect(results[0].uid).toBe("1");
    });
  });
});

describe("CardDavService detail_level", () => {
  const sampleVCard = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "UID:uid-1",
    "FN:Jane",
    "EMAIL;TYPE=WORK:jane@example.com",
    "PHOTO;ENCODING=b;TYPE=JPEG:fakebinary",
    "X-CUSTOM-EXT:keep-me",
    "END:VCARD",
  ].join("\r\n");

  it('fetchContacts with detail_level="summary" drops otherProperties and photo', async () => {
    const service = new CardDavService({
      url: "https://x",
      username: "u",
      password: "p",
    });
    (service as any).client = {
      fetchVCards: vi.fn().mockResolvedValue([{ url: "x", data: sampleVCard, etag: "" }]),
    };
    const contacts = await service.fetchContacts("book", { detailLevel: "summary" });
    expect(contacts).toHaveLength(1);
    expect(contacts[0].otherProperties).toEqual([]);
    expect(JSON.stringify(contacts[0])).not.toContain("fakebinary");
    expect(contacts[0].emails[0].value).toBe("jane@example.com");
  });

  it('fetchContacts with detail_level="full" preserves otherProperties (minus Apple internals stripped by parser)', async () => {
    const service = new CardDavService({
      url: "https://x",
      username: "u",
      password: "p",
    });
    (service as any).client = {
      fetchVCards: vi.fn().mockResolvedValue([{ url: "x", data: sampleVCard, etag: "" }]),
    };
    const contacts = await service.fetchContacts("book", { detailLevel: "full" });
    expect(contacts[0].otherProperties.join("|")).toContain("X-CUSTOM-EXT");
    expect(contacts[0].otherProperties.join("|")).not.toContain("PHOTO");
  });

  it("fetchContacts defaults to summary when detail_level omitted", async () => {
    const service = new CardDavService({
      url: "https://x",
      username: "u",
      password: "p",
    });
    (service as any).client = {
      fetchVCards: vi.fn().mockResolvedValue([{ url: "x", data: sampleVCard, etag: "" }]),
    };
    const contacts = await service.fetchContacts("book");
    expect(contacts[0].otherProperties).toEqual([]);
  });
});

describe("CardDavService.resolveContact", () => {
  const mkVCard = (uid: string, fn: string, email?: string) =>
    [
      "BEGIN:VCARD",
      "VERSION:3.0",
      `UID:${uid}`,
      `FN:${fn}`,
      email ? `EMAIL;TYPE=WORK:${email}` : "",
      "END:VCARD",
    ]
      .filter(Boolean)
      .join("\r\n");

  it("returns resolved shape on single match", async () => {
    const service = new CardDavService({ url: "x", username: "u", password: "p" });
    (service as any).client = {
      fetchVCards: vi
        .fn()
        .mockResolvedValue([
          { url: "1", data: mkVCard("u1", "Patrick Wilson", "n@t.com"), etag: "" },
        ]),
    };
    const r = await service.resolveContact("book", "Patrick");
    expect(r).toEqual({
      status: "resolved",
      fullName: "Patrick Wilson",
      email: "n@t.com",
    });
  });

  it("returns ambiguous shape with candidates sorted by fullName on multi-match", async () => {
    const service = new CardDavService({ url: "x", username: "u", password: "p" });
    (service as any).client = {
      fetchVCards: vi.fn().mockResolvedValue([
        { url: "1", data: mkVCard("u1", "Alice Smith", "r@x.com"), etag: "" },
        { url: "2", data: mkVCard("u2", "Alice Brown", "a@y.com"), etag: "" },
        { url: "3", data: mkVCard("u3", "Alice Lee", "w@z.com"), etag: "" },
      ]),
    };
    const r = await service.resolveContact("book", "Alice");
    if (r.status !== "ambiguous") throw new Error(`expected ambiguous, got ${r.status}`);
    expect(r.candidates.map((c) => c.fullName)).toEqual([
      "Alice Brown",
      "Alice Lee",
      "Alice Smith",
    ]);
    expect(r.candidates[0]).toMatchObject({
      fullName: "Alice Brown",
      email: "a@y.com",
      uid: "u2",
    });
  });

  it("returns not_found shape when no match", async () => {
    const service = new CardDavService({ url: "x", username: "u", password: "p" });
    (service as any).client = {
      fetchVCards: vi.fn().mockResolvedValue([]),
    };
    const r = await service.resolveContact("book", "Nobody");
    if (r.status !== "not_found") throw new Error(`expected not_found, got ${r.status}`);
    expect(r.message).toContain("Nobody");
  });

  it("ambiguous candidates skip contacts without email", async () => {
    const service = new CardDavService({ url: "x", username: "u", password: "p" });
    (service as any).client = {
      fetchVCards: vi.fn().mockResolvedValue([
        { url: "1", data: mkVCard("u1", "Alice One", "one@x.com"), etag: "" },
        { url: "2", data: mkVCard("u2", "Alice Two"), etag: "" },
        { url: "3", data: mkVCard("u3", "Alice Three", "three@x.com"), etag: "" },
      ]),
    };
    const r = await service.resolveContact("book", "Alice");
    if (r.status !== "ambiguous") throw new Error(`expected ambiguous, got ${r.status}`);
    expect(r.candidates.length).toBe(2);
    expect(r.candidates.every((c) => c.email.length > 0)).toBe(true);
  });
});
