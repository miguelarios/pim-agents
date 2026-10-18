/**
 * The data shapes every contacts backend speaks, independent of protocol.
 * They used to live in CardDavService.ts and are still re-exported from there.
 */
import type { Contact } from "@miguelarios/pim-core";

export interface AddressBook {
  displayName: string;
  url: string;
  ctag?: string;
  description?: string;
  syncToken?: string;
  contactCount?: number;
}

export type DetailLevel = "summary" | "full";

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
  /** Always present: a hit without a body is not a hit. */
  data: string;
}

export interface BookEntry {
  contact: Contact;
  located: LocatedContact;
}

export interface BookToSearch {
  url: string;
  label: string;
}

export type ResolveContactResult =
  | { status: "resolved"; fullName: string; email: string }
  | {
      status: "ambiguous";
      candidates: Array<{ fullName: string; email: string; uid: string; addressBook?: string }>;
    }
  | { status: "not_found"; message: string };

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
