/**
 * Address-book selection shared by the contact and group tools: which book(s) a read
 * covers, where a write on a known UID goes, and where a create lands.
 */
import { type Contact, ContactError, ErrorCode } from "@miguelarios/pim-core";
import type { AddressBook, CardDavService, LocatedContact } from "../services/CardDavService.js";

/**
 * Resolves the omitted-book default for `create_contact`, the one tool that
 * has to pick a single book: a new contact must land somewhere, and "the
 * first book" is the only default that does not need a second round trip.
 */
export async function resolveAddressBook(
  explicit: string | undefined,
  service: CardDavService,
): Promise<string> {
  if (explicit) return service.findAddressBook(explicit);
  const books = await service.listAddressBooks();
  if (books.length === 0) {
    throw new ContactError("No address books found", ErrorCode.ADDRESSBOOK_NOT_FOUND);
  }
  return books[0].url;
}

/** The one place the label rule lives: display name, or URL for a nameless book. */
function toBookRefs(books: AddressBook[]): BookRef[] {
  return books.map((b) => ({ url: b.url, label: b.displayName || b.url }));
}

/** The `addressBook` argument every read tool shares. */
export const ADDRESS_BOOK_PROP = {
  type: "string",
  description:
    "Address book URL or display name (e.g. 'Work'). If omitted, every address book in the account is searched.",
} as const;

/** A book to read, with the label its contacts are tagged with. */
export interface BookRef {
  url: string;
  label: string;
}

/**
 * The books a read should cover. An explicit reference names one book and
 * its contacts carry that reference back as their label; omitted means every
 * book in the account, labelled by display name, or URL for a nameless book,
 * so the label is always something the caller can pass back as
 * `addressBook`. The old default of "the first book" silently hid anyone
 * filed in a second one.
 */
export async function booksToSearch(
  explicit: string | undefined,
  service: CardDavService,
): Promise<BookRef[]> {
  if (explicit) return [{ url: await service.findAddressBook(explicit), label: explicit }];
  const books = await service.listAddressBooks();
  if (books.length === 0) {
    throw new ContactError("No address books found", ErrorCode.ADDRESSBOOK_NOT_FOUND);
  }
  return toBookRefs(books);
}

/** Reads every book concurrently and tags each contact with its book's label. */
export async function readAcrossBooks(
  books: BookRef[],
  read: (url: string) => Promise<Contact[]>,
): Promise<Array<Contact & { addressBook: string }>> {
  const perBook = await Promise.all(
    books.map(async (book) =>
      (await read(book.url)).map((contact) => ({ ...contact, addressBook: book.label })),
    ),
  );
  return perBook.flat();
}

/**
 * The book a write on a known UID should go to. With one book in the account
 * there is nothing to locate, and the write's own lookup will report a
 * missing UID; with several, the contact has to be found first, or the write
 * would land on whichever book sorted first and miss. When a lookup did run,
 * the vCard it found comes back as `located` so the write reuses that read
 * instead of fetching the winning book a second time. `label` is the book's
 * label under the same rule as reads, from the listing already in hand.
 */
export async function locateBookFor(
  uid: string,
  explicit: string | undefined,
  service: CardDavService,
): Promise<{ bookUrl: string; located?: LocatedContact; label: string }> {
  if (explicit) return { bookUrl: await service.findAddressBook(explicit), label: explicit };
  const books = await service.listAddressBooks();
  if (books.length === 0) {
    throw new ContactError("No address books found", ErrorCode.ADDRESSBOOK_NOT_FOUND);
  }
  if (books.length === 1) return { bookUrl: books[0].url, label: toBookRefs(books)[0].label };
  const located = await service.locateContact(uid, toBookRefs(books));
  const label = toBookRefs(books).find((b) => b.url === located.bookUrl)?.label ?? located.bookUrl;
  return { bookUrl: located.bookUrl, located, label };
}
