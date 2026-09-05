import { randomBytes, randomUUID } from "node:crypto";
import {
  type CardDavConfig,
  ConnectionError,
  type Contact,
  ContactError,
  ErrorCode,
  ValidationError,
  buildVCard,
  checkDavCollectionResponse,
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

/** Normalises a URL or href to a comparable path: origin stripped, trailing slashes trimmed. */
function collectionPath(ref: string): string {
  try {
    return new URL(ref, "http://placeholder.invalid").pathname.replace(/\/+$/, "");
  } catch {
    return ref.replace(/\/+$/, "");
  }
}

/**
 * Wiring for the shared DAV collection response checker, so every collection
 * verb in this service keeps speaking ContactError.
 */
const BOOK_DAV_CHECK = {
  resource: "address book",
  notFound: (url: string) =>
    new ContactError(`Address book not found: ${url}`, ErrorCode.ADDRESSBOOK_NOT_FOUND),
  failed: (message: string) => new ContactError(message, ErrorCode.OPERATION_FAILED),
};

export type DetailLevel = "summary" | "full";

/** One contact that reached the target book. `newUid` is set for copies only. */
export interface ContactTransferred {
  uid: string;
  newUid?: string;
}

export interface ContactTransferFailure {
  uid: string;
  message: string;
}

/**
 * A batch transfer reports per contact rather than failing whole: one unknown
 * UID should not strand the contacts either side of it in the list.
 */
export interface ContactTransferOutcome {
  transferred: ContactTransferred[];
  failed: ContactTransferFailure[];
}

/**
 * A contact found by {@link CardDavService.locateContact}: the book it lives
 * in plus the vCard's own URL, etag and data. Passing it back to
 * `updateContact`/`deleteContact` as `located` lets the write reuse the read
 * that found it instead of fetching the book again.
 */
export interface LocatedContact {
  bookUrl: string;
  url: string;
  etag?: string;
  data?: string;
}

export type ResolveContactResult =
  | { status: "resolved"; fullName: string; email: string }
  | { status: "ambiguous"; candidates: Array<{ fullName: string; email: string; uid: string }> }
  | { status: "not_found"; message: string };

function applyDetailLevel(contact: Contact, level: DetailLevel): Contact {
  const { photo: _photo, ...rest } = contact;
  if (level === "full") return rest;
  return { ...rest, otherProperties: [] };
}

/**
 * Fields `updateContact` can write. Three states per field, matching what a
 * merge update has to distinguish: absent (`undefined`) keeps the stored
 * value, `null` clears it, anything else replaces it. Without the `null`
 * state a stale phone or note could never be removed short of deleting and
 * recreating the contact, because "not supplied" and "empty" would collapse
 * into the same thing.
 */
export type ContactUpdates = {
  [K in keyof Omit<Contact, "uid" | "otherProperties" | "photo" | "fullName">]?: Contact[K] | null;
} & { fullName?: string };

/** Fields that are arrays on `Contact`, so clearing them means `[]` rather than `undefined`. */
const REQUIRED_ARRAY_FIELDS = ["emails", "phones", "addresses", "urls"] as const;

function mergeContactUpdates(current: Contact, updates: ContactUpdates): Contact {
  const merged: Contact = { ...current };
  for (const key of Object.keys(updates) as Array<keyof ContactUpdates>) {
    const value = updates[key];
    if (value === undefined) continue;
    if (value === null) {
      if ((REQUIRED_ARRAY_FIELDS as ReadonlyArray<string>).includes(key)) {
        (merged as unknown as Record<string, unknown>)[key] = [];
      } else {
        delete (merged as unknown as Record<string, unknown>)[key];
      }
      continue;
    }
    (merged as unknown as Record<string, unknown>)[key] = value;
  }
  // `photo` and `otherProperties` are never writable here; they ride along untouched.
  merged.uid = current.uid;
  merged.photo = current.photo;
  merged.otherProperties = current.otherProperties;
  return merged;
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
        displayName: typeof book.displayName === "string" ? book.displayName : "",
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
    if (isUrlRef(ref.trim())) return ref.trim();
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
    // Trimmed before matching: a trailing space is an easy thing for a model
    // to produce, and reporting "no book named 'Work '" while listing `Work`
    // as a known name reads as self-contradictory to whoever receives it.
    const trimmed = ref.trim();
    const books = await this.listAddressBooks();
    if (isUrlRef(trimmed)) {
      const match = books.find((b) => collectionPath(b.url) === collectionPath(trimmed));
      return match ?? { displayName: "", url: trimmed };
    }
    const wanted = trimmed.toLowerCase();
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
    // A book with no display name cannot be addressed by name — which is the
    // point of this whole surface — so creating one is refused rather than
    // quietly given a generated slug and left unreachable.
    if (opts.displayName.trim() === "") {
      throw new ValidationError("displayName cannot be empty", "displayName");
    }
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
    if (opts.slug !== undefined && taken.has(collectionPath(base + opts.slug))) {
      // An explicit slug is a request for a specific URL. Suffixing it would
      // hand back a different one than was asked for, observable only by
      // reading the result, so this refuses instead.
      throw new ContactError(
        `A collection already exists at the requested slug "${opts.slug}" (${base}${opts.slug}/)`,
        ErrorCode.OPERATION_FAILED,
      );
    }
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
      checkDavCollectionResponse(response, "create", url, BOOK_DAV_CHECK);
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
      checkDavCollectionResponse(response, "rename", url, BOOK_DAV_CHECK);
    } catch (error) {
      // No ValidationError branch: the only one this method throws happens
      // before the try, so a branch for it here would be dead code implying a
      // path that does not exist.
      if (error instanceof ContactError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Deletes an address book collection — and with it every contact inside. */
  async deleteAddressBook(url: string): Promise<void> {
    const client = await this.ensureConnected();
    try {
      const response = await client.deleteObject({ url });
      checkDavCollectionResponse(response, "delete", url, BOOK_DAV_CHECK);
    } catch (error) {
      if (error instanceof ContactError) throw error;
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
    updates: ContactUpdates,
    opts: { located?: LocatedContact } = {},
  ): Promise<void> {
    // The tool schema already keeps fullName non-nullable; this guards a direct
    // caller, since a cleared FN would otherwise serialise as "FN:undefined".
    // Checked before the fetch, so an invalid request pays for no round trip.
    if (updates.fullName === null) {
      throw new ValidationError(
        "fullName cannot be cleared: FN is required on every vCard",
        "fullName",
      );
    }
    const client = await this.ensureConnected();
    const existing = opts.located ?? (await this.findVCard(addressBookUrl, uid));
    if (!existing) {
      throw new ContactError(`Contact ${uid} not found`, ErrorCode.CONTACT_NOT_FOUND, uid);
    }

    const merged = mergeContactUpdates(parseVCard(existing.data!), updates);

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

  async deleteContact(
    addressBookUrl: string,
    uid: string,
    opts: { located?: LocatedContact } = {},
  ): Promise<void> {
    const client = await this.ensureConnected();
    const existing = opts.located ?? (await this.findVCard(addressBookUrl, uid));
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

  /**
   * Resolves a name to an email across one book or several. A name the user
   * did not qualify with a book means "whoever I know by that name", so the
   * default caller passes every book; a match filed in "Work" must not go
   * missing because "Personal" happened to sort first.
   */
  async resolveContact(
    addressBookUrl: string | string[],
    name: string,
  ): Promise<ResolveContactResult> {
    const urls = Array.isArray(addressBookUrl) ? addressBookUrl : [addressBookUrl];
    const matches = (await Promise.all(urls.map((url) => this.searchContacts(url, name)))).flat();
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

  /**
   * Finds which of the given books holds a UID. Used when a caller names a
   * contact but not its book. A UID is meant to be unique across an account,
   * so one hit is the answer; two is a state this cannot safely act on (the
   * write would land on whichever book came first), so it fails naming both
   * so the caller can pass one explicitly.
   */
  async locateContact(uid: string, bookUrls: string[]): Promise<LocatedContact> {
    const hits = (
      await Promise.all(
        bookUrls.map(async (bookUrl) => {
          const found = await this.findVCard(bookUrl, uid);
          return found ? { bookUrl, ...found } : undefined;
        }),
      )
    ).filter((hit): hit is LocatedContact => hit !== undefined);
    if (hits.length === 1) return hits[0];
    if (hits.length === 0) {
      throw new ContactError(
        `Contact ${uid} not found in any address book`,
        ErrorCode.CONTACT_NOT_FOUND,
        uid,
      );
    }
    // The contact was found, twice: CONTACT_CONFLICT, not NOT_FOUND, so a
    // caller that offers to create a missing contact does not do so here.
    throw new ContactError(
      `Contact ${uid} exists in more than one address book — pass addressBook to pick one of: ${hits
        .map((h) => h.bookUrl)
        .join(", ")}`,
      ErrorCode.CONTACT_CONFLICT,
      uid,
    );
  }

  /**
   * Moves contacts to another address book with DAV `MOVE`.
   *
   * `MOVE` is used rather than create-then-delete because it is atomic per
   * contact: a create/delete pair that fails between the two steps leaves the
   * same contact in both books, which is exactly the state a move is supposed
   * to avoid. It also relocates the stored vCard bytes untouched, so nothing
   * depends on parse/serialize fidelity.
   *
   * The UID is deliberately preserved: a moved contact is the same person
   * filed somewhere else, not a new one, so anything already referring to that
   * UID stays correct.
   */
  async moveContacts(
    fromUrl: string,
    toUrl: string,
    uids: string[],
  ): Promise<ContactTransferOutcome> {
    const sources = await this.loadTransferSources(fromUrl, toUrl, uids);
    const transferred: ContactTransferred[] = [];
    const failed: ContactTransferFailure[] = [];

    for (const uid of new Set(uids)) {
      const source = sources.get(uid);
      if (!source) {
        failed.push({ uid, message: `Contact ${uid} not found in the source address book` });
        continue;
      }

      try {
        const destination = this.transferDestination(toUrl, source.url);
        let response = await this.davMove(source.url, destination, source.etag);

        // A 412 here is ambiguous: either the source changed since it was read
        // (If-Match) or Overwrite: F refused an existing destination. Re-read
        // and retry once, which resolves the first case; a second 412 is the
        // second case and is reported as such.
        if (response.status === 412) {
          const fresh = await this.findVCard(fromUrl, uid);
          if (!fresh) {
            // The contact left the source between the batch read and this
            // retry. Falling through would report the generic 412 message,
            // which names the two causes this is not.
            failed.push({
              uid,
              message: `Contact ${uid} is no longer in the source address book — it was moved or deleted while this batch was running`,
            });
            continue;
          }
          response = await this.davMove(fresh.url, destination, fresh.etag);
        }

        if (!response.ok) {
          failed.push({ uid, message: this.transferFailureMessage("move", uid, response) });
          continue;
        }
        transferred.push({ uid });
      } catch (error) {
        failed.push({ uid, message: error instanceof Error ? error.message : String(error) });
      }
    }

    return { transferred, failed };
  }

  /**
   * Copies contacts into another address book, giving each copy a fresh UID.
   *
   * The new UID is the point of the operation rather than an implementation
   * detail: a copy is a second, independent vCard, and two vCards sharing a
   * UID within one account is a sync hazard — servers and clients key on UID,
   * so the pair can be silently merged or one of them dropped. Desktop clients
   * mint a new UID when duplicating a card for the same reason. The new UID is
   * returned so the caller can address the copy immediately.
   *
   * The vCard is round-tripped through `parseVCard`/`buildVCard` rather than
   * having its UID line rewritten in the raw text, because that round trip is
   * already the codebase's contract (it is what `updateContact` relies on) and
   * preserves `PHOTO` and unknown properties.
   */
  async copyContacts(
    fromUrl: string,
    toUrl: string,
    uids: string[],
  ): Promise<ContactTransferOutcome> {
    const sources = await this.loadTransferSources(fromUrl, toUrl, uids);
    const transferred: ContactTransferred[] = [];
    const failed: ContactTransferFailure[] = [];

    for (const uid of new Set(uids)) {
      const source = sources.get(uid);
      if (!source?.data) {
        failed.push({ uid, message: `Contact ${uid} not found in the source address book` });
        continue;
      }

      try {
        const copy: Contact = { ...parseVCard(source.data), uid: randomUUID() };
        await this.createContact(toUrl, copy);
        transferred.push({ uid, newUid: copy.uid });
      } catch (error) {
        failed.push({ uid, message: error instanceof Error ? error.message : String(error) });
      }
    }

    return { transferred, failed };
  }

  /**
   * Validates a transfer and reads the source book once.
   *
   * One `fetchVCards` for the whole batch rather than one per contact: the
   * per-contact lookup path scans every vCard in the book, so a ten-contact
   * move would otherwise re-read the entire book ten times.
   */
  private async loadTransferSources(
    fromUrl: string,
    toUrl: string,
    uids: string[],
  ): Promise<Map<string, { url: string; etag?: string; data?: string }>> {
    if (uids.length === 0) {
      throw new ValidationError("uids must name at least one contact", "uids");
    }
    if (collectionPath(fromUrl) === collectionPath(toUrl)) {
      throw new ValidationError(
        "The source and target address books are the same — pick a different target",
        "targetAddressBook",
      );
    }

    const client = await this.ensureConnected();
    try {
      const vcards = await client.fetchVCards({ addressBook: { url: fromUrl } as any });
      const byUid = new Map<string, { url: string; etag?: string; data?: string }>();
      for (const vcard of vcards) {
        if (!vcard.data) continue;
        const parsed = parseVCard(vcard.data);
        if (parsed.uid) {
          byUid.set(parsed.uid, {
            url: vcard.url,
            etag: vcard.etag,
            data: vcard.data,
          });
        }
      }
      return byUid;
    } catch (error) {
      if (error instanceof ContactError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** The destination URL for a moved vCard: the target book plus its filename. */
  private transferDestination(toUrl: string, sourceUrl: string): string {
    const filename = new URL(sourceUrl, this.config.url).pathname.split("/").pop();
    if (!filename) {
      throw new ContactError(
        `Cannot derive a filename from ${sourceUrl}`,
        ErrorCode.OPERATION_FAILED,
      );
    }
    const resolved = new URL(toUrl, this.config.url).toString();
    // A collection URL must end in "/" before joining: RFC 3986 relative
    // resolution replaces the last segment of a base that does not, so
    // ".../work" + "u1.vcf" resolves to ".../u1.vcf" — one directory above the
    // target book. findAddressBook returns a URL ref verbatim, so a caller
    // writing the book URL without a trailing slash reaches here directly.
    const base = resolved.endsWith("/") ? resolved : `${resolved}/`;
    return new URL(filename, base).toString();
  }

  /**
   * Issues the `MOVE`. tsdav exposes no move helper, so this goes out through
   * `fetch` with Basic auth — the same approach cal-mcp's `moveEvent` uses.
   * `Overwrite: F` keeps a move from silently clobbering a contact already
   * filed under that name in the target.
   */
  private async davMove(
    sourceUrl: string,
    destination: string,
    etag?: string,
  ): Promise<{ ok: boolean; status: number; statusText: string }> {
    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64")}`,
      Destination: destination,
      Overwrite: "F",
    };
    if (etag) headers["If-Match"] = etag;

    // No trailing-slash normalisation here, unlike transferDestination:
    // sourceUrl is always an object URL (.../<uid>.vcf) from fetchVCards, not
    // a collection reference, so there is no last segment to lose. The
    // asymmetry is deliberate — the sibling function got this wrong.
    const response = await fetch(new URL(sourceUrl, this.config.url).toString(), {
      method: "MOVE",
      headers,
    });
    return { ok: response.ok, status: response.status, statusText: response.statusText };
  }

  private transferFailureMessage(
    action: "move" | "copy",
    uid: string,
    response: { status: number; statusText: string },
  ): string {
    if (response.status === 412) {
      return `Failed to ${action} contact ${uid}: a contact already exists at that name in the target address book, or the source changed while it was being read (HTTP 412)`;
    }
    if (response.status === 403) {
      return `Failed to ${action} contact ${uid}: the server refused it — the source or target address book may be read-only (HTTP 403)`;
    }
    return `Failed to ${action} contact ${uid}: HTTP ${response.status} ${response.statusText}`.trim();
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
