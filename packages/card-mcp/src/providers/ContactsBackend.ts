/**
 * What the contact tools need from a backend, as an interface rather than the
 * concrete CardDavService (#53). See
 * docs/superpowers/specs/2026-10-18-multi-provider-backends-design.md.
 *
 * Contacts are already exchanged as pim-core's structured `Contact`, so unlike
 * cal-mcp the tool layer does not hand-edit vCard text. Two CardDAV traits
 * remain visible, and a non-CardDAV provider would treat them as opaque:
 *
 * - Address books are addressed by a URL string (`AddressBook.url`). For
 *   another provider it is whatever stable ID that provider gives a book.
 * - `LocatedContact` carries the stored object's location, version and raw
 *   `data`. Callers only pass a located contact back to the backend that
 *   produced it, as a lookup the backend can skip.
 */
import type { Contact } from "@miguelarios/pim-core";
import type {
  AddressBook,
  BookEntry,
  BookToSearch,
  ContactTransferOutcome,
  ContactUpdates,
  DetailLevel,
  LocatedContact,
  ResolveContactResult,
} from "./types.js";

export interface ContactsBackend {
  // ── Address books ─────────────────────────────────────────────────────────
  listAddressBooks(opts?: { includeCounts?: boolean }): Promise<AddressBook[]>;
  /** Contacts in one book, or undefined when the provider will not say. */
  countContacts(url: string): Promise<number | undefined>;
  /** Resolves a book name or URL to its URL. */
  findAddressBook(ref: string): Promise<string>;
  /** Resolves a book name or URL to the book's listing entry. */
  findAddressBookEntry(ref: string): Promise<AddressBook>;
  createAddressBook(opts: {
    displayName: string;
    description?: string;
    slug?: string;
  }): Promise<{ url: string; displayName: string }>;
  renameAddressBook(
    url: string,
    opts: { displayName?: string; description?: string },
  ): Promise<void>;
  deleteAddressBook(url: string): Promise<void>;

  // ── Contacts ──────────────────────────────────────────────────────────────
  fetchContacts(addressBookUrl: string, opts?: { detailLevel?: DetailLevel }): Promise<Contact[]>;
  /** Every contact in a book together with where each is stored. */
  fetchBook(addressBookUrl: string, opts?: { detailLevel?: DetailLevel }): Promise<BookEntry[]>;
  searchContacts(
    addressBookUrl: string,
    query: string,
    opts?: { detailLevel?: DetailLevel },
  ): Promise<Contact[]>;
  /** A name to an address: one match, several candidates, or none. */
  resolveContact(
    addressBook: string | Array<string | BookToSearch>,
    name: string,
  ): Promise<ResolveContactResult>;
  /** Finds which of `books` holds `uid`. */
  locateContact(uid: string, books: Array<string | BookToSearch>): Promise<LocatedContact>;
  createContact(addressBookUrl: string, contact: Contact): Promise<void>;
  updateContact(
    addressBookUrl: string,
    uid: string,
    updates: ContactUpdates,
    opts?: { located?: LocatedContact; allowGroup?: boolean },
  ): Promise<void>;
  deleteContact(
    addressBookUrl: string,
    uid: string,
    opts?: { located?: LocatedContact },
  ): Promise<void>;
  moveContacts(fromUrl: string, toUrl: string, uids: string[]): Promise<ContactTransferOutcome>;
  copyContacts(fromUrl: string, toUrl: string, uids: string[]): Promise<ContactTransferOutcome>;

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  disconnect(): Promise<void>;
}
