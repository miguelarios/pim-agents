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
});
