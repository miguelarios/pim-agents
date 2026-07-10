import { randomUUID } from "node:crypto";
import {
  type Contact,
  ContactError,
  ErrorCode,
  type PostalAddress,
  type TypedValue,
  toPimError,
} from "@miguelarios/pim-core";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CardDavService } from "../services/CardDavService.js";

export const CONTACT_TOOLS: Tool[] = [
  {
    name: "list_contacts",
    description:
      "List or search contacts. Returns all contacts if no query provided, or filters by name/email/phone/org when query is given.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Optional search query to filter contacts by name, email, phone, or organization",
        },
        addressBook: {
          type: "string",
          description: "Address book URL. If omitted, uses the first available address book.",
        },
        detail_level: {
          type: "string",
          enum: ["summary", "full"],
          description:
            "Level of detail. 'summary' (default) omits photo binary and raw otherProperties. 'full' returns the complete parsed vCard shape.",
        },
      },
    },
  },
  {
    name: "get_contact",
    description: "Get full details of a single contact by UID.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        uid: {
          type: "string",
          description: "The unique identifier (UID) of the contact",
        },
        addressBook: {
          type: "string",
          description: "Address book URL. If omitted, uses the first available address book.",
        },
        detail_level: {
          type: "string",
          enum: ["summary", "full"],
          description:
            "Level of detail. 'summary' (default) omits photo binary and raw otherProperties. 'full' returns the complete parsed vCard shape.",
        },
      },
      required: ["uid"],
    },
  },
  {
    name: "create_contact",
    description: "Create a new contact with the specified details.",
    inputSchema: {
      type: "object",
      properties: {
        fullName: { type: "string", description: "Full display name (e.g., 'John Doe')" },
        firstName: { type: "string", description: "First/given name" },
        lastName: { type: "string", description: "Last/family name" },
        emails: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", description: "Email type (e.g., 'home', 'work')" },
              value: { type: "string", description: "Email address" },
            },
            required: ["value"],
          },
          description: "Email addresses with optional type",
        },
        phones: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", description: "Phone type (e.g., 'cell', 'home', 'work')" },
              value: { type: "string", description: "Phone number" },
            },
            required: ["value"],
          },
          description: "Phone numbers with optional type",
        },
        addresses: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", description: "Address type (e.g., 'home', 'work')" },
              street: { type: "string", description: "Street address" },
              city: { type: "string", description: "City" },
              state: { type: "string", description: "State/province" },
              postalCode: { type: "string", description: "Postal/ZIP code" },
              country: { type: "string", description: "Country" },
            },
          },
          description: "Postal addresses",
        },
        urls: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", description: "URL type (e.g., 'home', 'work')" },
              value: { type: "string", description: "URL" },
            },
            required: ["value"],
          },
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
        addressBook: {
          type: "string",
          description: "Address book URL. If omitted, uses the first available address book.",
        },
      },
      required: ["fullName"],
    },
  },
  {
    name: "update_contact",
    description:
      "Update an existing contact. Only provided fields are changed (merge update). Omitted fields keep their current values.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "The UID of the contact to update" },
        fullName: { type: "string", description: "New full display name" },
        firstName: { type: "string", description: "New first name" },
        lastName: { type: "string", description: "New last name" },
        emails: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", description: "Email type (e.g., 'home', 'work')" },
              value: { type: "string", description: "Email address" },
            },
            required: ["value"],
          },
          description: "New email addresses with optional type (replaces existing)",
        },
        phones: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", description: "Phone type (e.g., 'cell', 'home', 'work')" },
              value: { type: "string", description: "Phone number" },
            },
            required: ["value"],
          },
          description: "New phone numbers with optional type (replaces existing)",
        },
        addresses: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", description: "Address type (e.g., 'home', 'work')" },
              street: { type: "string", description: "Street address" },
              city: { type: "string", description: "City" },
              state: { type: "string", description: "State/province" },
              postalCode: { type: "string", description: "Postal/ZIP code" },
              country: { type: "string", description: "Country" },
            },
          },
          description: "New postal addresses (replaces existing)",
        },
        urls: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", description: "URL type (e.g., 'home', 'work')" },
              value: { type: "string", description: "URL" },
            },
            required: ["value"],
          },
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
        addressBook: {
          type: "string",
          description: "Address book URL. If omitted, uses the first available address book.",
        },
      },
      required: ["uid"],
    },
  },
  {
    name: "delete_contact",
    description: "Delete a contact by UID. This action cannot be undone.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "The UID of the contact to delete" },
        addressBook: {
          type: "string",
          description: "Address book URL. If omitted, uses the first available address book.",
        },
      },
      required: ["uid"],
    },
  },
  {
    name: "resolve_contact",
    description:
      "Given a person's name, resolve to email. Returns { status: 'resolved', fullName, email } on a single match; { status: 'ambiguous', candidates: [...] } when multiple contacts match (caller must disambiguate); { status: 'not_found', message } when no contact with email matches.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Name to search for (partial matches allowed)",
        },
        addressBook: {
          type: "string",
          description: "Address book URL. If omitted, uses the first available address book.",
        },
      },
      required: ["name"],
    },
  },
];

export async function handleContactTool(
  name: string,
  args: Record<string, unknown>,
  service: CardDavService,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const addressBookUrl = await resolveAddressBook(
      args.addressBook as string | undefined,
      service,
    );

    switch (name) {
      case "list_contacts": {
        const query = args.query as string | undefined;
        const detailLevel = (args.detail_level as "summary" | "full" | undefined) ?? "summary";
        const contacts = query
          ? await service.searchContacts(addressBookUrl, query, { detailLevel })
          : await service.fetchContacts(addressBookUrl, { detailLevel });
        return ok(JSON.stringify(contacts, null, 2));
      }

      case "get_contact": {
        const uid = args.uid as string;
        const detailLevel = (args.detail_level as "summary" | "full" | undefined) ?? "summary";
        const contacts = await service.fetchContacts(addressBookUrl, { detailLevel });
        const contact = contacts.find((c) => c.uid === uid);
        if (!contact) {
          throw new ContactError(`Contact ${uid} not found`, ErrorCode.CONTACT_NOT_FOUND, uid);
        }
        return ok(JSON.stringify(contact, null, 2));
      }

      case "create_contact": {
        const contact: Contact = {
          uid: randomUUID(),
          fullName: args.fullName as string,
          firstName: args.firstName as string | undefined,
          lastName: args.lastName as string | undefined,
          emails: (args.emails as TypedValue[]) ?? [],
          phones: (args.phones as TypedValue[]) ?? [],
          addresses: (args.addresses as PostalAddress[]) ?? [],
          urls: (args.urls as TypedValue[]) ?? [],
          organization: args.organization as string | undefined,
          title: args.title as string | undefined,
          role: args.role as string | undefined,
          nickname: args.nickname as string | undefined,
          birthday: args.birthday as string | undefined,
          categories: args.categories as string[] | undefined,
          note: args.note as string | undefined,
          otherProperties: [],
        };
        await service.createContact(addressBookUrl, contact);
        return ok(
          JSON.stringify({ status: "created", uid: contact.uid, fullName: contact.fullName }),
        );
      }

      case "update_contact": {
        const uid = args.uid as string;
        const updates: Partial<Omit<Contact, "uid" | "otherProperties">> = {};
        if (args.fullName !== undefined) updates.fullName = args.fullName as string;
        if (args.firstName !== undefined) updates.firstName = args.firstName as string;
        if (args.lastName !== undefined) updates.lastName = args.lastName as string;
        if (args.emails !== undefined) updates.emails = args.emails as TypedValue[];
        if (args.phones !== undefined) updates.phones = args.phones as TypedValue[];
        if (args.addresses !== undefined) updates.addresses = args.addresses as PostalAddress[];
        if (args.urls !== undefined) updates.urls = args.urls as TypedValue[];
        if (args.organization !== undefined) updates.organization = args.organization as string;
        if (args.title !== undefined) updates.title = args.title as string;
        if (args.role !== undefined) updates.role = args.role as string;
        if (args.nickname !== undefined) updates.nickname = args.nickname as string;
        if (args.birthday !== undefined) updates.birthday = args.birthday as string;
        if (args.categories !== undefined) updates.categories = args.categories as string[];
        if (args.note !== undefined) updates.note = args.note as string;

        await service.updateContact(addressBookUrl, uid, updates);
        return ok(JSON.stringify({ status: "updated", uid }));
      }

      case "delete_contact": {
        const uid = args.uid as string;
        await service.deleteContact(addressBookUrl, uid);
        return ok(JSON.stringify({ status: "deleted", uid }));
      }

      case "resolve_contact": {
        const name = args.name as string;
        const result = await service.resolveContact(addressBookUrl, name);
        return ok(JSON.stringify(result));
      }

      default:
        return error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const pimError = toPimError(err instanceof Error ? err : new Error(String(err)));
    return error(`${pimError.message}${pimError.isRetryable ? " (retryable)" : ""}`);
  }
}

async function resolveAddressBook(
  explicit: string | undefined,
  service: CardDavService,
): Promise<string> {
  if (explicit) return explicit;
  const books = await service.listAddressBooks();
  if (books.length === 0) {
    throw new ContactError("No address books found", ErrorCode.ADDRESSBOOK_NOT_FOUND);
  }
  return books[0].url;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function error(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
