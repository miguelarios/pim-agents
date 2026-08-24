import { randomBytes } from "node:crypto";
import {
  type CardDavConfig,
  ConnectionError,
  type Contact,
  ContactError,
  ErrorCode,
  ValidationError,
  buildVCard,
  parseVCard,
  toPimError,
} from "@miguelarios/pim-core";
import { DAVClient } from "tsdav";

export interface AddressBook {
  displayName: string;
  url: string;
  ctag?: string;
  description?: string;
  syncToken?: string;
  contactCount?: number;
}

/** Whether an address-book reference is a URL rather than a display name. */
function isUrlRef(ref: string): boolean {
  return /^(https?:\/\/|\/)/.test(ref);
}

/** Derives a URL slug from a display name; falls back to a random one when nothing survives. */
function slugify(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `addressbook-${randomBytes(4).toString("hex")}`;
}

/**
 * Collects the propstat-level status lines from a raw tsdav multistatus, in
 * which keys arrive camelCased with namespace prefixes stripped.
 */
function propstatStatusLines(raw: unknown): string[] {
  const multistatus = (raw as { multistatus?: { response?: unknown } } | null | undefined)
    ?.multistatus;
  if (!multistatus) return [];
  const responses = Array.isArray(multistatus.response)
    ? multistatus.response
    : [multistatus.response];
  const lines: string[] = [];
  for (const entry of responses) {
    const propstat = (entry as { propstat?: unknown } | null | undefined)?.propstat;
    if (!propstat) continue;
    for (const ps of Array.isArray(propstat) ? propstat : [propstat]) {
      const status = (ps as { status?: unknown } | null | undefined)?.status;
      if (typeof status === "string") lines.push(status);
    }
  }
  return lines;
}

/** Normalises a URL or href to a comparable path: origin stripped, trailing slashes trimmed. */
function collectionPath(ref: string): string {
  try {
    return new URL(ref, "http://placeholder.invalid").pathname.replace(/\/+$/, "");
  } catch {
    return ref.replace(/\/+$/, "");
  }
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
      const client = new DAVClient({
        serverUrl: this.config.url,
        credentials: {
          username: this.config.username,
          password: this.config.password,
        },
        authMethod: "Basic",
        defaultAccountType: "carddav",
      });
      await client.login();
      this.client = client;
    } catch (error) {
      this.client = null;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private checkDavResponse(response: unknown, action: string, uid: string): void {
    const res = response as { ok?: boolean; status?: number; statusText?: string } | null;
    if (!res || res.ok !== false) return;
    if (res.status === 412) {
      throw new ContactError(
        `Contact ${uid} changed on the server since it was read (etag conflict) — re-read and retry`,
        ErrorCode.CONTACT_CONFLICT,
        uid,
      );
    }
    if (res.status === 404) {
      throw new ContactError(`Contact ${uid} not found`, ErrorCode.CONTACT_NOT_FOUND, uid);
    }
    throw new ContactError(
      `Failed to ${action} contact ${uid}: HTTP ${res.status} ${res.statusText ?? ""}`.trim(),
      ErrorCode.INTERNAL_ERROR,
      uid,
    );
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

  async listAddressBooks(opts: { includeCounts?: boolean } = {}): Promise<AddressBook[]> {
    const client = await this.ensureConnected();
    try {
      const books = await client.fetchAddressBooks();
      const mapped: AddressBook[] = books.map((book) => ({
        displayName: (typeof book.displayName === "string" ? book.displayName : "") ?? "",
        url: book.url,
        ctag: book.ctag,
        ...(typeof book.description === "string" ? { description: book.description } : {}),
        ...(typeof book.syncToken === "string" ? { syncToken: book.syncToken } : {}),
      }));
      if (opts.includeCounts) {
        await Promise.all(
          mapped.map(async (book) => {
            const count = await this.countContacts(book.url);
            if (count !== undefined) book.contactCount = count;
          }),
        );
      }
      return mapped;
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Counts the resources in a collection with a single depth-1 PROPFIND asking
   * only for etags — no vCard bodies cross the wire. Returns `undefined` rather
   * than failing when the server refuses, so an unreadable book degrades to a
   * missing count instead of a failed listing.
   */
  async countContacts(url: string): Promise<number | undefined> {
    const client = await this.ensureConnected();
    try {
      const responses = await client.propfind({
        url,
        props: { "d:getetag": {} },
        depth: "1",
      });
      const self = collectionPath(url);
      return responses.filter((r) => r.href && collectionPath(r.href) !== self).length;
    } catch {
      return undefined;
    }
  }

  /**
   * Resolves an address-book reference — a URL or a display name — to a URL.
   *
   * URLs pass through verbatim with no round-trip. Names match case-insensitively
   * and exactly against the account's books; anything else fails with the known
   * names (or, on a duplicate name, the matching URLs) so the caller can correct
   * itself in one step. Fuzzy matching is deliberately absent: "work" silently
   * picking one of two similar books is a data-loss shape on the write paths.
   */
  async findAddressBook(ref: string): Promise<string> {
    if (isUrlRef(ref)) return ref;
    return (await this.findAddressBookEntry(ref)).url;
  }

  /**
   * Resolves a reference to the book's whole entry, so a caller can name what
   * it is about to act on rather than echoing back whatever string it was
   * given. Unlike {@link findAddressBook} this always lists, including for a
   * URL — recovering the display name is the point.
   *
   * A URL the account does not list still resolves: the caller may know about
   * a book we cannot see. It comes back with an empty `displayName` rather
   * than the URL standing in for one, so callers can tell "no name known"
   * from a name.
   */
  async findAddressBookEntry(ref: string): Promise<AddressBook> {
    const books = await this.listAddressBooks();
    if (isUrlRef(ref)) {
      const match = books.find((b) => collectionPath(b.url) === collectionPath(ref));
      return match ?? { displayName: "", url: ref };
    }
    const wanted = ref.toLowerCase();
    const matches = books.filter((b) => b.displayName.toLowerCase() === wanted);
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
      const known = books
        .map((b) => b.displayName)
        .filter(Boolean)
        .join(", ");
      throw new ContactError(
        `No address book named "${ref}". Known address books: ${known || "(none)"}`,
        ErrorCode.ADDRESSBOOK_NOT_FOUND,
      );
    }
    throw new ContactError(
      `Multiple address books are named "${ref}" — pass one of these URLs instead: ${matches
        .map((b) => b.url)
        .join(", ")}`,
      ErrorCode.ADDRESSBOOK_NOT_FOUND,
    );
  }

  /**
   * Creates an address book via extended MKCOL (RFC 5689).
   *
   * tsdav's `makeCollection` cannot be used: it passes no `attributes`, and
   * `davRequest` drops document-level attributes, so its MKCOL body carries
   * undeclared `d:`/`card:` prefixes that a conformant server rejects. The
   * request therefore goes through `davRequest` directly, with the namespace
   * declarations as `_attributes` inside the root element — the same pattern
   * tsdav's own `makeCalendar` uses.
   */
  async createAddressBook(opts: {
    displayName: string;
    description?: string;
    slug?: string;
  }): Promise<{ url: string; displayName: string }> {
    const client = await this.ensureConnected();
    if (opts.slug !== undefined && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(opts.slug)) {
      throw new ValidationError(
        `Invalid slug "${opts.slug}" — use lowercase letters, digits and hyphens, starting with a letter or digit`,
        "slug",
      );
    }

    const books = await this.listAddressBooks();
    // A second book with the same display name would make that name ambiguous
    // to findAddressBook on every subsequent call, so duplicates are refused
    // rather than suffixed — that also keeps a retried create from minting one.
    //
    // This snapshot predates the MKCOL, which looks racy but is not: the slug
    // is derived deterministically from the display name, so two concurrent
    // creates of the same name target the same URL and the server fails the
    // loser with 405. The check is a legible early error, not the guard.

    const duplicate = books.find(
      (b) => b.displayName.toLowerCase() === opts.displayName.toLowerCase(),
    );
    if (duplicate) {
      throw new ContactError(
        `An address book named "${duplicate.displayName}" already exists at ${duplicate.url}`,
        ErrorCode.OPERATION_FAILED,
      );
    }

    const homeUrl = (client as { account?: { homeUrl?: string } }).account?.homeUrl;
    if (!homeUrl) {
      throw new ContactError(
        "The account has no address book home URL — cannot derive a location for the new book",
        ErrorCode.OPERATION_FAILED,
      );
    }
    const base = homeUrl.endsWith("/") ? homeUrl : `${homeUrl}/`;
    const taken = new Set(books.map((b) => collectionPath(b.url)));
    const slug = opts.slug ?? slugify(opts.displayName);
    let candidate = slug;
    for (let n = 2; taken.has(collectionPath(base + candidate)); n++) {
      candidate = `${slug}-${n}`;
    }
    const url = `${base}${candidate}/`;

    try {
      const [response] = await client.davRequest({
        url,
        init: {
          method: "MKCOL",
          headers: {},
          body: {
            "d:mkcol": {
              _attributes: {
                "xmlns:d": "DAV:",
                "xmlns:card": "urn:ietf:params:xml:ns:carddav",
              },
              "d:set": {
                "d:prop": {
                  "d:resourcetype": { "d:collection": {}, "card:addressbook": {} },
                  "d:displayname": opts.displayName,
                  ...(opts.description !== undefined
                    ? { "card:addressbook-description": opts.description }
                    : {}),
                },
              },
            },
          },
        },
      });
      this.checkCollectionResponse(response, "create", url);
      return { url, displayName: opts.displayName };
    } catch (error) {
      if (error instanceof ContactError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Renames an address book and/or updates its description via PROPPATCH.
   * At least one of the two must be given — an empty update is a caller bug,
   * not a no-op worth a round trip.
   */
  async renameAddressBook(
    url: string,
    opts: { displayName?: string; description?: string },
  ): Promise<void> {
    if (opts.displayName === undefined && opts.description === undefined) {
      throw new ValidationError("Nothing to change — provide a displayName and/or a description");
    }
    const client = await this.ensureConnected();
    try {
      const [response] = await client.davRequest({
        url,
        init: {
          method: "PROPPATCH",
          headers: {},
          body: {
            "d:propertyupdate": {
              _attributes: {
                "xmlns:d": "DAV:",
                "xmlns:card": "urn:ietf:params:xml:ns:carddav",
              },
              "d:set": {
                "d:prop": {
                  ...(opts.displayName !== undefined ? { "d:displayname": opts.displayName } : {}),
                  ...(opts.description !== undefined
                    ? { "card:addressbook-description": opts.description }
                    : {}),
                },
              },
            },
          },
        },
      });
      this.checkCollectionResponse(response, "rename", url);
    } catch (error) {
      if (error instanceof ContactError || error instanceof ValidationError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Deletes an address book collection — and with it every contact inside. */
  async deleteAddressBook(url: string): Promise<void> {
    const client = await this.ensureConnected();
    try {
      const response = await client.deleteObject({ url });
      this.checkCollectionResponse(response, "delete", url);
    } catch (error) {
      if (error instanceof ContactError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Judges a collection-level DAV response. Never trusts `ok` — tsdav computes
   * it as `!responseBody.error`, so a 207 wrapping a failed propstat reports
   * `ok: true` — and for PROPPATCH not the mapped `status` alone either: a
   * propstat-level failure leaves it at the transport's 207 (a 2xx), with the
   * real statuses surviving only under `raw`. So this walks the raw propstat
   * statuses too.
   */
  private checkCollectionResponse(
    response: unknown,
    action: "create" | "rename" | "delete",
    url: string,
  ): void {
    const res = response as
      | { status?: number; statusText?: string; raw?: unknown }
      | null
      | undefined;
    const statuses: Array<{ status: number; statusText: string }> = [];
    if (res && typeof res.status === "number") {
      statuses.push({ status: res.status, statusText: res.statusText ?? "" });
    }
    for (const line of propstatStatusLines(res?.raw)) {
      const match = /\b(\d{3})\b\s*(.*)$/.exec(line);
      if (match) statuses.push({ status: Number(match[1]), statusText: match[2] ?? "" });
    }

    // This helper exists to distrust tsdav's response shapes, so a response
    // carrying no status at all is a failure to judge, not a success.
    if (statuses.length === 0) {
      throw new ContactError(
        `The server returned no usable status for the ${action} of ${url}`,
        ErrorCode.OPERATION_FAILED,
      );
    }

    for (const { status, statusText } of statuses) {
      if (status >= 200 && status <= 299) continue;
      if (status === 404) {
        throw new ContactError(`Address book not found: ${url}`, ErrorCode.ADDRESSBOOK_NOT_FOUND);
      }
      if (action === "create" && status === 405) {
        throw new ContactError(`A collection already exists at ${url}`, ErrorCode.OPERATION_FAILED);
      }
      if (action === "create" && (status === 403 || status === 501)) {
        throw new ContactError(
          `The provider does not allow creating address books here (HTTP ${status})`,
          ErrorCode.OPERATION_FAILED,
        );
      }
      if (status === 403) {
        throw new ContactError(
          `The server refused to ${action} ${url} — the address book may be read-only (HTTP 403)`,
          ErrorCode.OPERATION_FAILED,
        );
      }
      throw new ContactError(
        `Failed to ${action} address book ${url}: HTTP ${status} ${statusText}`.trim(),
        ErrorCode.OPERATION_FAILED,
      );
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
      const response = await client.updateVCard({
        vCard: {
          url: existing.url,
          etag: existing.etag,
          data: buildVCard(merged),
        },
      });
      this.checkDavResponse(response, "update", uid);
    } catch (error) {
      if (error instanceof ContactError) throw error;
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
      const response = await client.deleteVCard({
        vCard: { url: existing.url, etag: existing.etag },
      });
      this.checkDavResponse(response, "delete", uid);
    } catch (error) {
      if (error instanceof ContactError) throw error;
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
