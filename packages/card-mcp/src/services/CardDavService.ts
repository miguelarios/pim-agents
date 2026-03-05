import { type CardDavConfig, type Contact, ConnectionError, ContactError, ErrorCode, buildVCard, parseVCard, toPimError } from "@miguelarios/pim-core";
import { DAVClient } from "tsdav";

export interface AddressBook {
  displayName: string;
  url: string;
  ctag?: string;
}

export class CardDavService {
  private client: DAVClient | null = null;
  private config: CardDavConfig;

  constructor(config: CardDavConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    try {
      this.client = new DAVClient({
        serverUrl: this.config.url,
        credentials: {
          username: this.config.username,
          password: this.config.password,
        },
        authMethod: "Basic",
        defaultAccountType: "carddav",
      });
      await this.client.login();
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async ensureConnected(): Promise<DAVClient> {
    if (!this.client) {
      await this.connect();
    }
    if (!this.client) {
      throw new ConnectionError("Failed to establish CardDAV connection");
    }
    return this.client;
  }

  async listAddressBooks(): Promise<AddressBook[]> {
    const client = await this.ensureConnected();
    try {
      const books = await client.fetchAddressBooks();
      return books.map((book) => ({
        displayName: book.displayName ?? "",
        url: book.url,
        ctag: book.ctag,
      }));
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async fetchContacts(addressBookUrl: string): Promise<Contact[]> {
    const client = await this.ensureConnected();
    try {
      const vcards = await client.fetchVCards({
        addressBook: { url: addressBookUrl } as any,
      });
      return vcards
        .filter((v) => v.data)
        .map((v) => parseVCard(v.data!));
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async createContact(addressBookUrl: string, contact: Contact): Promise<void> {
    const client = await this.ensureConnected();
    const vCardString = buildVCard(contact);
    try {
      const response = await client.createVCard({
        addressBook: { url: addressBookUrl } as any,
        vCardString,
        filename: `${contact.uid}.vcf`,
      });
      if (response && !(response as any).ok) {
        throw new Error(`Failed to create contact: ${(response as any).statusText ?? "unknown error"}`);
      }
    } catch (error) {
      if (error instanceof ContactError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async updateContact(
    addressBookUrl: string,
    uid: string,
    updates: Partial<Omit<Contact, "uid">>
  ): Promise<void> {
    const client = await this.ensureConnected();
    const existing = await this.findVCard(addressBookUrl, uid);
    if (!existing) {
      throw new ContactError(`Contact ${uid} not found`, ErrorCode.CONTACT_NOT_FOUND, uid);
    }

    const current = parseVCard(existing.data!);
    const merged: Contact = {
      uid: current.uid,
      fullName: updates.fullName ?? current.fullName,
      firstName: updates.firstName ?? current.firstName,
      lastName: updates.lastName ?? current.lastName,
      emails: updates.emails ?? current.emails,
      phones: updates.phones ?? current.phones,
      organization: updates.organization ?? current.organization,
      title: updates.title ?? current.title,
      note: updates.note ?? current.note,
    };

    try {
      await client.updateVCard({
        vCard: {
          url: existing.url,
          etag: existing.etag,
          data: buildVCard(merged),
        },
      });
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async deleteContact(addressBookUrl: string, uid: string): Promise<void> {
    const client = await this.ensureConnected();
    const existing = await this.findVCard(addressBookUrl, uid);
    if (!existing) {
      throw new ContactError(`Contact ${uid} not found`, ErrorCode.CONTACT_NOT_FOUND, uid);
    }

    try {
      await client.deleteVCard({
        vCard: { url: existing.url, etag: existing.etag },
      });
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async disconnect(): Promise<void> {
    this.client = null;
  }

  private async findVCard(
    addressBookUrl: string,
    uid: string
  ): Promise<{ url: string; etag?: string; data?: string } | undefined> {
    const client = await this.ensureConnected();
    const vcards = await client.fetchVCards({
      addressBook: { url: addressBookUrl } as any,
    });
    return vcards.find((v) => {
      if (!v.data) return false;
      const parsed = parseVCard(v.data);
      return parsed.uid === uid;
    }) as { url: string; etag?: string; data?: string } | undefined;
  }
}
