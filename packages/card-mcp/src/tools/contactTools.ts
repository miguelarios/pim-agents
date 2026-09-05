import { randomUUID } from "node:crypto";
import { type Contact, ContactError, ErrorCode } from "@miguelarios/pim-core";
import { type ToolDef, confirmDestructive, structured, toolError } from "@miguelarios/pim-core/mcp";
import {
  type CardDavService,
  type ContactUpdates,
  duplicateContactError,
} from "../services/CardDavService.js";
import { booksToSearch, locateBookFor, readAcrossBooks, resolveAddressBook } from "./books.js";
import {
  contactListSchema,
  contactSchema,
  resolveResultSchema,
  transferResultSchema,
  writeResultSchema,
} from "./contactSchemas.js";

const ADDRESS_BOOK_PROP = {
  type: "string",
  description:
    "Address book URL or display name (e.g. 'Work'). If omitted, every address book in the account is searched.",
} as const;

/**
 * The write tools locate rather than search: an omitted book means "find the
 * one book holding this UID", and a UID in two books is a conflict, never an
 * update-everywhere.
 */
const WRITE_BOOK_PROP = {
  type: "string",
  description:
    "Address book URL or display name (e.g. 'Work') holding the contact. If omitted, every address book is checked to locate the UID; fails if more than one holds it.",
} as const;

/** `create_contact` has to land somewhere, so its omitted-book default differs. */
const CREATE_BOOK_PROP = {
  type: "string",
  description:
    "Address book URL or display name (e.g. 'Work') to create the contact in. If omitted, uses the first available address book.",
} as const;

const DETAIL_LEVEL_PROP = {
  type: "string",
  enum: ["summary", "full"],
  description:
    "Level of detail. 'summary' (default) omits photo binary and raw otherProperties. 'full' returns the complete parsed vCard shape.",
} as const;

const TYPED_VALUE_ITEMS = (typeDesc: string, valueDesc: string) =>
  ({
    type: "object",
    properties: {
      type: { type: "string", description: typeDesc },
      value: { type: "string", description: valueDesc },
    },
    required: ["value"],
  }) as const;

const ADDRESS_ITEMS = {
  type: "object",
  properties: {
    type: { type: "string", description: "Address type (e.g., 'home', 'work')" },
    street: { type: "string", description: "Street address" },
    city: { type: "string", description: "City" },
    state: { type: "string", description: "State/province" },
    postalCode: { type: "string", description: "Postal/ZIP code" },
    country: { type: "string", description: "Country" },
  },
} as const;

const SOCIAL_PROFILE_ITEMS = {
  type: "object",
  properties: {
    type: { type: "string", description: "Network (e.g., 'twitter', 'linkedin', 'mastodon')" },
    handle: { type: "string", description: "Username on that network" },
    url: { type: "string", description: "Profile URL" },
  },
  required: ["type"],
} as const;

/**
 * Marks a JSON Schema property nullable, so `update_contact` can clear it.
 * Absent keeps the stored value; `null` clears it; a value replaces it.
 */
function nullable<T extends { type: string; description: string }>(
  prop: T,
): Omit<T, "type"> & { type: [T["type"], "null"] } {
  const { type, description, ...rest } = prop;
  return {
    ...rest,
    type: [type, "null"],
    description: `${description}. Pass null to clear.`,
  } as any;
}

const TRANSFER_UIDS_PROP = {
  type: "array",
  items: { type: "string", description: "UID of a contact to transfer" },
  // minItems lets a client reject the empty case before a round trip; the
  // service still refuses it, since the schema is advice and not a guarantee.
  minItems: 1,
  description:
    "UIDs of the contacts to transfer. Repeats are ignored. The source book is read once for the whole batch.",
} as const;

/**
 * Unlike the single-contact tools' optional `addressBook`, a transfer names
 * both ends. Moving out of whichever book happened to sort first is not a
 * thing a caller can mean, and getting it wrong relocates the wrong contacts.
 */
const SOURCE_BOOK_PROP = {
  type: "string",
  description: "Source address book URL or display name (e.g. 'Personal').",
} as const;

const TARGET_BOOK_PROP = {
  type: "string",
  description:
    "Target address book URL or display name (e.g. 'Work'). Must differ from the source.",
} as const;

type ListArgs = { query?: string; addressBook?: string; detail_level?: "summary" | "full" };
type GetArgs = { uid: string; addressBook?: string; detail_level?: "summary" | "full" };
/**
 * The `Contact` fields `update_contact` can write, and the single source of
 * truth for both the arg type and the copy loop in its handler. Deriving the
 * types from `Contact` through `Pick` is what makes drift a compile error: a
 * name that is not a `Contact` key, or a field whose type changes there, stops
 * the build instead of being silently swallowed by a cast.
 */
export const UPDATABLE_FIELDS = [
  "fullName",
  "firstName",
  "lastName",
  "middleName",
  "namePrefix",
  "nameSuffix",
  "emails",
  "phones",
  "addresses",
  "urls",
  "organization",
  "orgUnits",
  "title",
  "role",
  "nickname",
  "birthday",
  "categories",
  "note",
  "socialProfiles",
] as const;

type UpdatableField = (typeof UPDATABLE_FIELDS)[number];

/** `addressBook` is not a contact field — it selects which book to act on. */
type CreateArgs = Partial<Pick<Contact, UpdatableField>> & {
  fullName: string;
  addressBook?: string;
};
type UpdateArgs = Pick<ContactUpdates, UpdatableField> & { uid: string; addressBook?: string };
type DeleteArgs = { uid: string; addressBook?: string };
type ResolveArgs = { name: string; addressBook?: string };
type TransferArgs = { uids: string[]; addressBook: string; targetAddressBook: string };

/**
 * Copies one field across when the caller supplied it. The generic `K` is what
 * types this: inside the function both sides are the same `T[K]`, where a loop
 * over a union of keys would widen them to unrelated value types and force a
 * cast.
 */
function copyDefined<T, K extends keyof T>(target: Partial<T>, source: Partial<T>, key: K): void {
  const value = source[key];
  if (value !== undefined) target[key] = value;
}

export const CONTACT_TOOLS: ReadonlyArray<ToolDef<CardDavService>> = [
  {
    name: "list_contacts",
    title: "List Contacts",
    description:
      "List or search contacts. Returns all contacts if no query provided, or filters by name/email/phone/org when query is given.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Optional search query to filter contacts by name, email, phone, or organization",
        },
        addressBook: ADDRESS_BOOK_PROP,
        detail_level: DETAIL_LEVEL_PROP,
      },
    },
    outputSchema: contactListSchema,
    handler: async (args: ListArgs, service) => {
      try {
        const books = await booksToSearch(args.addressBook, service);
        const detailLevel = args.detail_level ?? "summary";
        const query = args.query;
        const contacts = await readAcrossBooks(books, (url) =>
          query
            ? service.searchContacts(url, query, { detailLevel })
            : service.fetchContacts(url, { detailLevel }),
        );
        return structured({ contacts, count: contacts.length });
      } catch (err) {
        return toolError(err);
      }
    },
  },
  {
    name: "get_contact",
    title: "Get Contact",
    description: "Get full details of a single contact by UID.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "The unique identifier (UID) of the contact" },
        addressBook: ADDRESS_BOOK_PROP,
        detail_level: DETAIL_LEVEL_PROP,
      },
      required: ["uid"],
    },
    outputSchema: contactSchema,
    handler: async (args: GetArgs, service) => {
      try {
        const books = await booksToSearch(args.addressBook, service);
        const detailLevel = args.detail_level ?? "summary";
        const contacts = await readAcrossBooks(books, (url) =>
          service.fetchContacts(url, { detailLevel }),
        );
        const matches = contacts.filter((c) => c.uid === args.uid);
        if (matches.length === 0) {
          throw new ContactError(
            `Contact ${args.uid} not found`,
            ErrorCode.CONTACT_NOT_FOUND,
            args.uid,
          );
        }
        // Reads treat a UID duplicated across books the way writes do: a
        // conflict to surface, not a coin toss on whichever book sorted first.
        if (matches.length > 1) {
          throw duplicateContactError(
            args.uid,
            matches.map((c) => c.addressBook),
          );
        }
        return structured(matches[0]);
      } catch (err) {
        return toolError(err);
      }
    },
  },
  {
    name: "create_contact",
    title: "Create Contact",
    description: "Create a new contact with the specified details.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        fullName: { type: "string", description: "Full display name (e.g., 'John Doe')" },
        firstName: { type: "string", description: "First/given name" },
        lastName: { type: "string", description: "Last/family name" },
        middleName: { type: "string", description: "Middle name(s)" },
        namePrefix: { type: "string", description: "Honorific prefix (e.g., 'Dr.')" },
        nameSuffix: { type: "string", description: "Honorific suffix (e.g., 'Jr.')" },
        emails: {
          type: "array",
          items: TYPED_VALUE_ITEMS("Email type (e.g., 'home', 'work')", "Email address"),
          description: "Email addresses with optional type",
        },
        phones: {
          type: "array",
          items: TYPED_VALUE_ITEMS("Phone type (e.g., 'cell', 'home', 'work')", "Phone number"),
          description: "Phone numbers with optional type",
        },
        addresses: {
          type: "array",
          items: ADDRESS_ITEMS,
          description: "Postal addresses",
        },
        urls: {
          type: "array",
          items: TYPED_VALUE_ITEMS("URL type (e.g., 'home', 'work')", "URL"),
          description: "URLs with optional type",
        },
        organization: { type: "string", description: "Company/organization name" },
        orgUnits: {
          type: "array",
          items: { type: "string" },
          description: "Organizational units within the organization (e.g., ['Engineering'])",
        },
        title: { type: "string", description: "Job title" },
        role: { type: "string", description: "Role/function within organization" },
        nickname: { type: "string", description: "Nickname" },
        birthday: { type: "string", description: "Birthday (YYYY-MM-DD)" },
        categories: {
          type: "array",
          items: { type: "string" },
          description: "Contact categories/tags",
        },
        note: { type: "string", description: "Free-text note" },
        socialProfiles: {
          type: "array",
          items: SOCIAL_PROFILE_ITEMS,
          description: "Social media profiles",
        },
        addressBook: CREATE_BOOK_PROP,
      },
      required: ["fullName"],
    },
    outputSchema: writeResultSchema,
    handler: async (args: CreateArgs, service) => {
      try {
        const addressBookUrl = await resolveAddressBook(args.addressBook, service);
        const contact: Contact = {
          uid: randomUUID(),
          fullName: args.fullName,
          firstName: args.firstName,
          lastName: args.lastName,
          middleName: args.middleName,
          namePrefix: args.namePrefix,
          nameSuffix: args.nameSuffix,
          emails: args.emails ?? [],
          phones: args.phones ?? [],
          addresses: args.addresses ?? [],
          urls: args.urls ?? [],
          organization: args.organization,
          orgUnits: args.orgUnits,
          title: args.title,
          role: args.role,
          nickname: args.nickname,
          birthday: args.birthday,
          categories: args.categories,
          note: args.note,
          socialProfiles: args.socialProfiles,
          otherProperties: [],
        };
        await service.createContact(addressBookUrl, contact);
        return structured({
          status: "created" as const,
          uid: contact.uid,
          fullName: contact.fullName,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  },
  {
    name: "update_contact",
    title: "Update Contact",
    description:
      "Update an existing contact. Only provided fields are changed (merge update). Omitted fields keep their current values; pass null to clear a field.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "The UID of the contact to update" },
        fullName: { type: "string", description: "New full display name" },
        firstName: nullable({ type: "string", description: "New first name" }),
        lastName: nullable({ type: "string", description: "New last name" }),
        middleName: nullable({ type: "string", description: "New middle name(s)" }),
        namePrefix: nullable({ type: "string", description: "New honorific prefix" }),
        nameSuffix: nullable({ type: "string", description: "New honorific suffix" }),
        emails: nullable({
          type: "array",
          items: TYPED_VALUE_ITEMS("Email type (e.g., 'home', 'work')", "Email address"),
          description: "New email addresses with optional type (replaces existing)",
        }),
        phones: nullable({
          type: "array",
          items: TYPED_VALUE_ITEMS("Phone type (e.g., 'cell', 'home', 'work')", "Phone number"),
          description: "New phone numbers with optional type (replaces existing)",
        }),
        addresses: nullable({
          type: "array",
          items: ADDRESS_ITEMS,
          description: "New postal addresses (replaces existing)",
        }),
        urls: nullable({
          type: "array",
          items: TYPED_VALUE_ITEMS("URL type (e.g., 'home', 'work')", "URL"),
          description: "New URLs with optional type (replaces existing)",
        }),
        organization: nullable({ type: "string", description: "New organization" }),
        orgUnits: nullable({
          type: "array",
          items: { type: "string" },
          description: "New organizational units (replaces existing)",
        }),
        title: nullable({ type: "string", description: "New job title" }),
        role: nullable({ type: "string", description: "New role/function within organization" }),
        nickname: nullable({ type: "string", description: "New nickname" }),
        birthday: nullable({ type: "string", description: "New birthday (YYYY-MM-DD)" }),
        categories: nullable({
          type: "array",
          items: { type: "string" },
          description: "New contact categories/tags (replaces existing)",
        }),
        note: nullable({ type: "string", description: "New note" }),
        socialProfiles: nullable({
          type: "array",
          items: SOCIAL_PROFILE_ITEMS,
          description: "New social media profiles (replaces existing)",
        }),
        addressBook: WRITE_BOOK_PROP,
      },
      required: ["uid"],
    },
    outputSchema: writeResultSchema,
    handler: async (args: UpdateArgs, service) => {
      try {
        const { bookUrl, located } = await locateBookFor(args.uid, args.addressBook, service);
        const updates: ContactUpdates = {};
        for (const field of UPDATABLE_FIELDS) {
          copyDefined(updates, args, field);
        }

        await service.updateContact(bookUrl, args.uid, updates, { located });
        return structured({ status: "updated" as const, uid: args.uid });
      } catch (err) {
        return toolError(err);
      }
    },
  },
  {
    name: "delete_contact",
    title: "Delete Contact",
    description:
      "Delete a contact by UID. This action cannot be undone, and asks the user to confirm before deleting.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "The UID of the contact to delete" },
        addressBook: WRITE_BOOK_PROP,
      },
      required: ["uid"],
    },
    outputSchema: writeResultSchema,
    handler: async (args: DeleteArgs, service, ctx) => {
      const gate = confirmDestructive(
        ctx,
        "confirm_delete_contact",
        `Permanently delete contact ${args.uid}? This cannot be undone.`,
      );
      if (gate.status === "interrupt") return gate.result;

      try {
        const { bookUrl, located } = await locateBookFor(args.uid, args.addressBook, service);
        await service.deleteContact(bookUrl, args.uid, { located });
        return structured({ status: "deleted" as const, uid: args.uid });
      } catch (err) {
        return toolError(err);
      }
    },
  },
  {
    name: "resolve_contact",
    title: "Resolve Contact to Email",
    description:
      "Given a person's name, resolve to email. Returns { status: 'resolved', fullName, email } on a single match; { status: 'ambiguous', candidates: [...] } when multiple contacts match (caller must disambiguate); { status: 'not_found', message } when no contact with email matches.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name to search for (partial matches allowed)" },
        addressBook: ADDRESS_BOOK_PROP,
      },
      required: ["name"],
    },
    outputSchema: resolveResultSchema,
    handler: async (args: ResolveArgs, service) => {
      try {
        const books = await booksToSearch(args.addressBook, service);
        return structured(
          await service.resolveContact(
            books.map((b) => b.url),
            args.name,
          ),
        );
      } catch (err) {
        return toolError(err);
      }
    },
  },
  {
    name: "move_contacts",
    title: "Move Contacts",
    description:
      "Move contacts to another address book. Each contact keeps its UID — it is the same person, filed somewhere else. Both address books must be named; neither defaults. Reports per contact, so one unknown UID does not strand the rest of the batch. Retrying a move that already succeeded reports its UIDs as not found in the source, because they are no longer there — that is a completed move, not a failed one.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        uids: TRANSFER_UIDS_PROP,
        addressBook: SOURCE_BOOK_PROP,
        targetAddressBook: TARGET_BOOK_PROP,
      },
      required: ["uids", "addressBook", "targetAddressBook"],
    },
    outputSchema: transferResultSchema,
    handler: async (args: TransferArgs, service) => {
      try {
        const [from, to] = await Promise.all([
          service.findAddressBook(args.addressBook),
          service.findAddressBook(args.targetAddressBook),
        ]);
        const outcome = await service.moveContacts(from, to, args.uids);
        return structured({
          status: "moved" as const,
          from,
          to,
          transferred: outcome.transferred,
          ...(outcome.failed.length > 0 ? { failed: outcome.failed } : {}),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  },
  {
    name: "copy_contacts",
    title: "Copy Contacts",
    description:
      "Copy contacts into another address book, leaving the originals in place. Each copy is a new contact and gets a new UID, returned as newUid — two vCards sharing a UID in one account is a sync hazard. Both address books must be named; neither defaults.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        uids: TRANSFER_UIDS_PROP,
        addressBook: SOURCE_BOOK_PROP,
        targetAddressBook: TARGET_BOOK_PROP,
      },
      required: ["uids", "addressBook", "targetAddressBook"],
    },
    outputSchema: transferResultSchema,
    handler: async (args: TransferArgs, service) => {
      try {
        const [from, to] = await Promise.all([
          service.findAddressBook(args.addressBook),
          service.findAddressBook(args.targetAddressBook),
        ]);
        const outcome = await service.copyContacts(from, to, args.uids);
        return structured({
          status: "copied" as const,
          from,
          to,
          transferred: outcome.transferred,
          ...(outcome.failed.length > 0 ? { failed: outcome.failed } : {}),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  },
];
