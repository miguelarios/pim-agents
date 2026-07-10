import {
  type CardDavConfig,
  ConnectionError,
  type Contact,
  ContactError,
  ErrorCode,
  buildVCard,
  parseVCard,
  toPimError,
} from "@miguelarios/pim-core";
import { DAVClient } from "tsdav";

export interface AddressBook {
  displayName: string;
  url: string;
  ctag?: string;
}

export type DetailLevel = "summary" | "full";

export type ResolveContactResult =
  | { status: "resolved"; fullName: string; email: string }
  | { status: "ambiguous"; candidates: Array<{ fullName: string; email: string; uid: string }> }
  | { status: "not_found"; message: string };

function applyDetailLevel(contact: Contact, level: DetailLevel): Contact {
  const { photo: _photo, ...rest } = contact;
  if (level === "full") return rest;
  return { ...rest, otherProperties: [] };
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
        displayName: (typeof book.displayName === "string" ? book.displayName : "") ?? "",
        url: book.url,
        ctag: book.ctag,
      }));
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async fetchContacts(
    addressBookUrl: string,
    opts: { detailLevel?: DetailLevel } = {},
  ): Promise<Contact[]> {
    const detailLevel = opts.detailLevel ?? "summary";
    const client = await this.ensureConnected();
    try {
      const vcards = await client.fetchVCards({
        addressBook: { url: addressBookUrl } as any,
      });
      return vcards
        .filter((v) => v.data)
        .map((v) => applyDetailLevel(parseVCard(v.data!), detailLevel));
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
        throw new Error(
          `Failed to create contact: ${(response as any).statusText ?? "unknown error"}`,
        );
      }
    } catch (error) {
      if (error instanceof ContactError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async updateContact(
    addressBookUrl: string,
    uid: string,
    updates: Partial<Omit<Contact, "uid" | "otherProperties">>,
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
      middleName: updates.middleName ?? current.middleName,
      namePrefix: updates.namePrefix ?? current.namePrefix,
      nameSuffix: updates.nameSuffix ?? current.nameSuffix,
      emails: updates.emails ?? current.emails,
      phones: updates.phones ?? current.phones,
      addresses: updates.addresses ?? current.addresses,
      urls: updates.urls ?? current.urls,
      organization: updates.organization ?? current.organization,
      orgUnits: updates.orgUnits ?? current.orgUnits,
      title: updates.title ?? current.title,
      role: updates.role ?? current.role,
      nickname: updates.nickname ?? current.nickname,
      birthday: updates.birthday ?? current.birthday,
      categories: updates.categories ?? current.categories,
      note: updates.note ?? current.note,
      socialProfiles: updates.socialProfiles ?? current.socialProfiles,
      photo: current.photo,
      otherProperties: current.otherProperties,
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

  async searchContacts(
    addressBookUrl: string,
    query: string,
    opts: { detailLevel?: DetailLevel } = {},
  ): Promise<Contact[]> {
    const contacts = await this.fetchContacts(addressBookUrl, opts);
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return contacts;

    return contacts.filter((c) => {
      const searchable = [
        c.fullName,
        c.firstName,
        c.lastName,
        c.organization,
        c.title,
        c.role,
        c.nickname,
        ...(c.categories ?? []),
        ...c.emails.map((e) => e.value),
        ...c.phones.map((e) => e.value),
        ...c.urls.map((u) => u.value),
        ...c.addresses.map((a) =>
          [a.street, a.city, a.state, a.postalCode, a.country].filter(Boolean).join(" "),
        ),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return tokens.every((token) => searchable.includes(token));
    });
  }

  async resolveContact(addressBookUrl: string, name: string): Promise<ResolveContactResult> {
    const matches = await this.searchContacts(addressBookUrl, name);
    const withEmail = matches.filter((c) => c.emails.length > 0);
    if (withEmail.length === 0) {
      return {
        status: "not_found",
        message: `No contact with email found matching "${name}"`,
      };
    }
    if (withEmail.length === 1) {
      const c = withEmail[0];
      return {
        status: "resolved",
        fullName: c.fullName,
        email: c.emails[0].value,
      };
    }
    const candidates = [...withEmail]
      .sort((a, b) => a.fullName.localeCompare(b.fullName))
      .map((c) => ({
        fullName: c.fullName,
        email: c.emails[0].value,
        uid: c.uid,
      }));
    return { status: "ambiguous", candidates };
  }

  async disconnect(): Promise<void> {
    this.client = null;
  }

  private async findVCard(
    addressBookUrl: string,
    uid: string,
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
