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
    account: { homeUrl: "/dav/addressbooks/users/miguel/", rootUrl: "/dav/" },
    davRequest: vi.fn().mockResolvedValue([{ ok: true, status: 201, statusText: "Created" }]),
    deleteObject: vi.fn().mockResolvedValue({ ok: true, status: 204, statusText: "No Content" }),
    propfind: vi.fn().mockResolvedValue([]),
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

  describe("listAddressBooks metadata and counts", () => {
    it("surfaces description and syncToken when tsdav supplies them", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      __mockClient.fetchAddressBooks.mockResolvedValueOnce([
        {
          displayName: "Contacts",
          url: "/dav/a/contacts/",
          ctag: "c1",
          description: "Team contacts",
          syncToken: "sync-9",
        },
      ]);
      const [book] = await service.listAddressBooks();
      expect(book.description).toBe("Team contacts");
      expect(book.syncToken).toBe("sync-9");
    });

    it("does not issue count PROPFINDs unless asked", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      __mockClient.propfind.mockClear();
      const books = await service.listAddressBooks();
      expect(books[0].contactCount).toBeUndefined();
      expect(__mockClient.propfind).not.toHaveBeenCalled();
    });

    it("counts contacts per book with one depth-1 getetag PROPFIND each", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      __mockClient.propfind.mockClear();
      __mockClient.propfind.mockResolvedValue([
        { href: "/dav/addressbooks/users/miguel/contacts/" },
        { href: "/dav/addressbooks/users/miguel/contacts/a.vcf" },
        { href: "/dav/addressbooks/users/miguel/contacts/b.vcf" },
      ]);
      const books = await service.listAddressBooks({ includeCounts: true });
      expect(books[0].contactCount).toBe(2);
      expect(__mockClient.propfind).toHaveBeenCalledTimes(2);
      const call = __mockClient.propfind.mock.calls[0][0];
      expect(call.depth).toBe("1");
      expect(Object.keys(call.props)).toEqual(["d:getetag"]);
    });

    it("leaves contactCount undefined for a book whose count PROPFIND rejects", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      __mockClient.propfind.mockClear();
      __mockClient.propfind.mockRejectedValue(new Error("boom"));
      const books = await service.listAddressBooks({ includeCounts: true });
      expect(books).toHaveLength(2);
      expect(books[0].contactCount).toBeUndefined();
    });
  });

  describe("createAddressBook", () => {
    it("issues an extended MKCOL with namespaces on the root element", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      const result = await service.createAddressBook({ displayName: "Work Contacts" });

      expect(result.url).toBe("/dav/addressbooks/users/miguel/work-contacts/");
      expect(result.displayName).toBe("Work Contacts");
      expect(__mockClient.davRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "/dav/addressbooks/users/miguel/work-contacts/",
          init: expect.objectContaining({
            method: "MKCOL",
            body: {
              "d:mkcol": {
                _attributes: {
                  "xmlns:d": "DAV:",
                  "xmlns:card": "urn:ietf:params:xml:ns:carddav",
                },
                "d:set": {
                  "d:prop": {
                    "d:resourcetype": { "d:collection": {}, "card:addressbook": {} },
                    "d:displayname": "Work Contacts",
                  },
                },
              },
            },
          }),
        }),
      );
    });

    it("adds addressbook-description when a description is given", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      await service.createAddressBook({ displayName: "Team", description: "Shared team book" });
      const body = __mockClient.davRequest.mock.calls.at(-1)[0].init.body;
      expect(body["d:mkcol"]["d:set"]["d:prop"]["card:addressbook-description"]).toBe(
        "Shared team book",
      );
    });

    it("uses an explicit slug as given", async () => {
      const result = await service.createAddressBook({ displayName: "Team", slug: "team-x" });
      expect(result.url).toBe("/dav/addressbooks/users/miguel/team-x/");
    });

    it.each([["Bad Slug"], ["../escape"], ["-leading"]])(
      "rejects the invalid slug %s before any request",
      async (slug) => {
        const { __mockClient } = (await import("tsdav")) as any;
        __mockClient.davRequest.mockClear();
        await expect(service.createAddressBook({ displayName: "Team", slug })).rejects.toMatchObject(
          { code: "VALIDATION_FAILED" },
        );
        expect(__mockClient.davRequest).not.toHaveBeenCalled();
      },
    );

    it("falls back to a generated slug when the name slugifies to nothing", async () => {
      const result = await service.createAddressBook({ displayName: "!!!" });
      expect(result.url).toMatch(/\/addressbook-[0-9a-f]{8}\/$/);
    });

    it("refuses a display name that already exists, case-insensitively, without a request", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      __mockClient.davRequest.mockClear();
      await expect(service.createAddressBook({ displayName: "work" })).rejects.toMatchObject({
        code: "OPERATION_FAILED",
        message: expect.stringContaining("/dav/addressbooks/users/miguel/work/"),
      });
      expect(__mockClient.davRequest).not.toHaveBeenCalled();
    });

    it("suffixes the slug when a differently named book slugifies to it", async () => {
      // "Work!" slugifies to "work", colliding with the existing Work book's URL.
      const result = await service.createAddressBook({ displayName: "Work!" });
      expect(result.url).toBe("/dav/addressbooks/users/miguel/work-2/");
    });

    it("maps 405 to a collection-already-exists failure", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      __mockClient.davRequest.mockResolvedValueOnce([
        { ok: true, status: 405, statusText: "Method Not Allowed" },
      ]);
      await expect(service.createAddressBook({ displayName: "Team" })).rejects.toMatchObject({
        code: "OPERATION_FAILED",
        message: expect.stringContaining("already exists"),
      });
    });

    it.each([[403], [501]])("maps %s to a provider-limitation failure", async (status) => {
      const { __mockClient } = (await import("tsdav")) as any;
      __mockClient.davRequest.mockResolvedValueOnce([{ ok: true, status, statusText: "Nope" }]);
      await expect(service.createAddressBook({ displayName: "Team" })).rejects.toMatchObject({
        code: "OPERATION_FAILED",
        message: expect.stringContaining("does not allow creating address books"),
      });
    });
  });

  describe("findAddressBook", () => {
    it("resolves a display name to its URL", async () => {
      await expect(service.findAddressBook("Work")).resolves.toBe(
        "/dav/addressbooks/users/miguel/work/",
      );
    });

    it("matches names case-insensitively", async () => {
      await expect(service.findAddressBook("work")).resolves.toBe(
        "/dav/addressbooks/users/miguel/work/",
      );
    });

    it("returns URLs verbatim without listing books", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      await service.connect();
      __mockClient.fetchAddressBooks.mockClear();
      await expect(service.findAddressBook("/dav/addressbooks/users/miguel/other/")).resolves.toBe(
        "/dav/addressbooks/users/miguel/other/",
      );
      await expect(service.findAddressBook("https://dav.example.com/books/a/")).resolves.toBe(
        "https://dav.example.com/books/a/",
      );
      expect(__mockClient.fetchAddressBooks).not.toHaveBeenCalled();
    });

    it("lists the known names when no book matches", async () => {
      await expect(service.findAddressBook("Personal")).rejects.toMatchObject({
        code: "ADDRESSBOOK_NOT_FOUND",
        message: expect.stringContaining("Contacts, Work"),
      });
    });

    it("lists the matching URLs when two books share the name", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      __mockClient.fetchAddressBooks.mockResolvedValueOnce([
        { displayName: "Work", url: "/dav/a/work/", ctag: "1" },
        { displayName: "work", url: "/dav/b/work/", ctag: "2" },
      ]);
      await expect(service.findAddressBook("Work")).rejects.toMatchObject({
        code: "ADDRESSBOOK_NOT_FOUND",
        message: expect.stringMatching(/\/dav\/a\/work\/.*\/dav\/b\/work\//s),
      });
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

  describe("HTTP error surfacing", () => {
    const CARD = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:h-1\r\nFN:Alice Smith\r\nEND:VCARD";

    it("updateContact throws CONTACT_CONFLICT on 412", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      __mockClient.fetchVCards.mockResolvedValueOnce([{ url: "u", etag: '"e1"', data: CARD }]);
      __mockClient.updateVCard.mockResolvedValueOnce({
        ok: false,
        status: 412,
        statusText: "Precondition Failed",
      });

      await service.connect();
      await expect(service.updateContact("book", "h-1", { title: "x" })).rejects.toMatchObject({
        code: "CONTACT_CONFLICT",
      });
    });

    it("deleteContact throws on 403 instead of reporting success", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      __mockClient.fetchVCards.mockResolvedValueOnce([{ url: "u", etag: '"e1"', data: CARD }]);
      __mockClient.deleteVCard.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: "Forbidden",
      });

      await service.connect();
      await expect(service.deleteContact("book", "h-1")).rejects.toThrow(/403/);
    });

    it("failed login does not leave a half-connected client", async () => {
      const { __mockClient } = (await import("tsdav")) as any;
      __mockClient.login.mockClear();
      __mockClient.login.mockRejectedValueOnce(new Error("bad credentials"));
      await expect(service.connect()).rejects.toThrow();

      // second attempt must try login again, not silently reuse a dead client
      __mockClient.login.mockResolvedValueOnce(undefined);
      __mockClient.fetchAddressBooks.mockResolvedValueOnce([]);
      await service.listAddressBooks();
      expect(__mockClient.login).toHaveBeenCalledTimes(2);
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
