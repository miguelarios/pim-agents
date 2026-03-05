import { describe, expect, it, vi, beforeEach } from "vitest";
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
      const { __mockClient } = await import("tsdav") as any;
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
      expect(contacts[0].emails).toEqual(["john@test.com"]);
    });
  });

  describe("createContact", () => {
    it("creates a vCard on the server", async () => {
      const { __mockClient } = await import("tsdav") as any;
      await service.connect();
      await service.createContact("/dav/addressbooks/users/miguel/contacts/", {
        uid: "new-1",
        fullName: "New Person",
        emails: ["new@test.com"],
        phones: [],
      });

      expect(__mockClient.createVCard).toHaveBeenCalledWith(
        expect.objectContaining({
          filename: "new-1.vcf",
        })
      );
    });
  });

  describe("updateContact", () => {
    it("updates an existing vCard with merge semantics", async () => {
      const { __mockClient } = await import("tsdav") as any;
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
        emails: ["new@test.com"],
      });

      expect(__mockClient.updateVCard).toHaveBeenCalledWith(
        expect.objectContaining({
          vCard: expect.objectContaining({
            url: "/dav/contacts/uid-1.vcf",
            etag: '"etag1"',
          }),
        })
      );
    });
  });

  describe("deleteContact", () => {
    it("deletes a vCard by UID", async () => {
      const { __mockClient } = await import("tsdav") as any;
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
        })
      );
    });

    it("throws ContactError when contact not found", async () => {
      const { __mockClient } = await import("tsdav") as any;
      __mockClient.fetchVCards.mockResolvedValueOnce([]);

      await service.connect();
      await expect(
        service.deleteContact("/dav/addressbooks/users/miguel/contacts/", "nonexistent")
      ).rejects.toThrow("not found");
    });
  });
});
