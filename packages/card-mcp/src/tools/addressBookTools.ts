import { type ToolDef, confirmDestructive, structured, toolError } from "@miguelarios/pim-core/mcp";
import type { CardDavService } from "../services/CardDavService.js";
import { addressBookListSchema, addressBookWriteResultSchema } from "./addressBookSchemas.js";

/**
 * Unlike the contact tools' optional addressBook, the write tools require
 * their target: renaming or deleting "whichever book happened to sort first"
 * is not a thing a caller can mean.
 */
const TARGET_BOOK_PROP = {
  type: "string",
  description: "Address book URL or display name (e.g. 'Work').",
} as const;

type ListArgs = { include_counts?: boolean };
type CreateArgs = { displayName: string; description?: string; slug?: string };
type RenameArgs = { addressBook: string; displayName?: string; description?: string };
type DeleteArgs = { addressBook: string };

export const ADDRESS_BOOK_TOOLS: ReadonlyArray<ToolDef<CardDavService>> = [
  {
    name: "list_address_books",
    title: "List Address Books",
    description:
      "List the account's address books — name, URL, and metadata. Pass the returned name (or URL) as addressBook to any contact tool.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        include_counts: {
          type: "boolean",
          description:
            "Also count the contacts in each book (one extra request per book). Default false.",
        },
      },
    },
    outputSchema: addressBookListSchema,
    handler: async (args: ListArgs, service) => {
      try {
        const addressBooks = await service.listAddressBooks({
          includeCounts: args.include_counts ?? false,
        });
        return structured({ addressBooks, count: addressBooks.length });
      } catch (err) {
        return toolError(err);
      }
    },
  },
  {
    name: "create_address_book",
    title: "Create Address Book",
    description:
      "Create a new address book. The URL is derived from the display name unless an explicit slug is given. Fails if a book with that name already exists.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        displayName: { type: "string", description: "Display name for the new address book" },
        description: { type: "string", description: "Optional address book description" },
        slug: {
          type: "string",
          description:
            "Optional URL path segment (lowercase letters, digits, hyphens). Derived from displayName when omitted.",
        },
      },
      required: ["displayName"],
    },
    outputSchema: addressBookWriteResultSchema,
    handler: async (args: CreateArgs, service) => {
      try {
        const { url, displayName } = await service.createAddressBook({
          displayName: args.displayName,
          description: args.description,
          slug: args.slug,
        });
        return structured({ status: "created" as const, url, displayName });
      } catch (err) {
        return toolError(err);
      }
    },
  },
  {
    name: "rename_address_book",
    title: "Rename Address Book",
    description:
      "Rename an address book and/or update its description. At least one of displayName or description must be given.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        addressBook: TARGET_BOOK_PROP,
        displayName: { type: "string", description: "New display name" },
        description: { type: "string", description: "New description" },
      },
      required: ["addressBook"],
    },
    outputSchema: addressBookWriteResultSchema,
    handler: async (args: RenameArgs, service) => {
      try {
        const url = await service.findAddressBook(args.addressBook);
        await service.renameAddressBook(url, {
          displayName: args.displayName,
          description: args.description,
        });
        return structured({
          status: "renamed" as const,
          url,
          ...(args.displayName !== undefined ? { displayName: args.displayName } : {}),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  },
  {
    name: "delete_address_book",
    title: "Delete Address Book",
    description:
      "Delete an address book and every contact in it. This cannot be undone, and asks the user to confirm before deleting. The contact count in the confirmation is read when the prompt is built, so it describes the book at that moment rather than guaranteeing what the delete will remove.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        addressBook: TARGET_BOOK_PROP,
      },
      required: ["addressBook"],
    },
    outputSchema: addressBookWriteResultSchema,
    handler: async (args: DeleteArgs, service, ctx) => {
      let book: { displayName: string; url: string };
      let count: number | undefined;
      try {
        // Resolved and counted before the gate, so the confirmation names what
        // is actually being destroyed. The whole entry is resolved rather than
        // just the URL: echoing back the caller's own reference would name a
        // URL twice when the caller passed one, which is the case where a
        // human most needs to be told what the thing is called. The confirmed
        // retry re-enters here and repeats both — two cheap requests, accepted
        // for a stateless handler.
        book = await service.findAddressBookEntry(args.addressBook);
        count = await service.countContacts(book.url);
      } catch (err) {
        return toolError(err);
      }

      const contactsClause =
        count !== undefined ? `all ${count} contacts in it` : "every contact in it";
      const label = book.displayName ? `"${book.displayName}" (${book.url})` : book.url;
      const gate = confirmDestructive(
        ctx,
        "confirm_delete_address_book",
        `Permanently delete address book ${label} and ${contactsClause}? This cannot be undone.`,
      );
      if (gate.status === "interrupt") return gate.result;

      try {
        await service.deleteAddressBook(book.url);
        return structured({
          status: "deleted" as const,
          url: book.url,
          ...(book.displayName ? { displayName: book.displayName } : {}),
        });
      } catch (err) {
        return toolError(err);
      }
    },
  },
];
