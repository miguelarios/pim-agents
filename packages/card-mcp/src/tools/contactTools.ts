import { randomUUID } from "node:crypto";
import { type Contact, ContactError, ErrorCode } from "@miguelarios/pim-core";
import { type ToolDef, confirmDestructive, structured, toolError } from "@miguelarios/pim-core/mcp";
import type { CardDavService } from "../services/CardDavService.js";
import {
  contactListSchema,
  contactSchema,
  resolveResultSchema,
  writeResultSchema,
} from "./contactSchemas.js";

const ADDRESS_BOOK_PROP = {
  type: "string",
  description:
    "Address book URL or display name (e.g. 'Work'). If omitted, uses the first available address book.",
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
  "emails",
  "phones",
  "addresses",
  "urls",
  "organization",
  "title",
  "role",
  "nickname",
  "birthday",
  "categories",
  "note",
] as const;

type UpdatableField = (typeof UPDATABLE_FIELDS)[number];

/** `addressBook` is not a contact field — it selects which book to act on. */
type ContactFields = Partial<Pick<Contact, UpdatableField>> & { addressBook?: string };

type ContactUpdates = Partial<Omit<Contact, "uid" | "otherProperties">>;

type CreateArgs = ContactFields & { fullName: string };
type UpdateArgs = ContactFields & { uid: string };
type DeleteArgs = { uid: string; addressBook?: string };
type ResolveArgs = { name: string; addressBook?: string };

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
        const addressBookUrl = await resolveAddressBook(args.addressBook, service);
        const detailLevel = args.detail_level ?? "summary";
        const contacts = args.query
          ? await service.searchContacts(addressBookUrl, args.query, { detailLevel })
          : await service.fetchContacts(addressBookUrl, { detailLevel });
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
        const addressBookUrl = await resolveAddressBook(args.addressBook, service);
        const detailLevel = args.detail_level ?? "summary";
        const contacts = await service.fetchContacts(addressBookUrl, { detailLevel });
        const contact = contacts.find((c) => c.uid === args.uid);
        if (!contact) {
          throw new ContactError(
            `Contact ${args.uid} not found`,
            ErrorCode.CONTACT_NOT_FOUND,
            args.uid,
          );
        }
        return structured(contact);
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
        addressBook: ADDRESS_BOOK_PROP,
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
          emails: args.emails ?? [],
          phones: args.phones ?? [],
          addresses: args.addresses ?? [],
          urls: args.urls ?? [],
          organization: args.organization,
          title: args.title,
          role: args.role,
          nickname: args.nickname,
          birthday: args.birthday,
          categories: args.categories,
          note: args.note,
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
      "Update an existing contact. Only provided fields are changed (merge update). Omitted fields keep their current values.",
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
        firstName: { type: "string", description: "New first name" },
        lastName: { type: "string", description: "New last name" },
        emails: {
          type: "array",
          items: TYPED_VALUE_ITEMS("Email type (e.g., 'home', 'work')", "Email address"),
          description: "New email addresses with optional type (replaces existing)",
        },
        phones: {
          type: "array",
          items: TYPED_VALUE_ITEMS("Phone type (e.g., 'cell', 'home', 'work')", "Phone number"),
          description: "New phone numbers with optional type (replaces existing)",
        },
        addresses: {
          type: "array",
          items: ADDRESS_ITEMS,
          description: "New postal addresses (replaces existing)",
        },
        urls: {
          type: "array",
          items: TYPED_VALUE_ITEMS("URL type (e.g., 'home', 'work')", "URL"),
          description: "New URLs with optional type (replaces existing)",
        },
        organization: { type: "string", description: "New organization" },
        title: { type: "string", description: "New job title" },
        role: { type: "string", description: "New role/function within organization" },
        nickname: { type: "string", description: "New nickname" },
        birthday: { type: "string", description: "New birthday (YYYY-MM-DD)" },
        categories: {
          type: "array",
          items: { type: "string" },
          description: "New contact categories/tags (replaces existing)",
        },
        note: { type: "string", description: "New note" },
        addressBook: ADDRESS_BOOK_PROP,
      },
      required: ["uid"],
    },
    outputSchema: writeResultSchema,
    handler: async (args: UpdateArgs, service) => {
      try {
        const addressBookUrl = await resolveAddressBook(args.addressBook, service);
        const updates: ContactUpdates = {};
        for (const field of UPDATABLE_FIELDS) {
          copyDefined(updates, args, field);
        }

        await service.updateContact(addressBookUrl, args.uid, updates);
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
        addressBook: ADDRESS_BOOK_PROP,
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
        const addressBookUrl = await resolveAddressBook(args.addressBook, service);
        await service.deleteContact(addressBookUrl, args.uid);
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
        const addressBookUrl = await resolveAddressBook(args.addressBook, service);
        return structured(await service.resolveContact(addressBookUrl, args.name));
      } catch (err) {
        return toolError(err);
      }
    },
  },
];

async function resolveAddressBook(
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
