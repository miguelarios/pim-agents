/**
 * Contact groups: vCards with `KIND:group` (or Apple's vCard 3.0
 * `X-ADDRESSBOOKSERVER-KIND:group`) whose `MEMBER` lines name other
 * contacts by UID. A group lives in one address book and, on every server
 * that implements them, can only refer to contacts in that same book — so
 * membership is validated against the group's book, never the account.
 */
import { randomUUID } from "node:crypto";
import {
  type Contact,
  ContactError,
  ErrorCode,
  ValidationError,
  isGroup,
} from "@miguelarios/pim-core";
import { type ToolDef, confirmDestructive, structured, toolError } from "@miguelarios/pim-core/mcp";
import type { CardDavService } from "../services/CardDavService.js";
import {
  bookLabel,
  booksToSearch,
  locateBookFor,
  readAcrossBooks,
  resolveAddressBook,
} from "./books.js";
import { groupDetailSchema, groupListSchema, groupWriteResultSchema } from "./groupSchemas.js";

const ADDRESS_BOOK_PROP = {
  type: "string",
  description:
    "Address book URL or display name (e.g. 'Work'). If omitted, every address book in the account is searched.",
} as const;

const MEMBER_UIDS_PROP = (description: string) =>
  ({
    type: "array",
    items: { type: "string", description: "UID of a contact in the group's address book" },
    description,
  }) as const;

type ListArgs = { addressBook?: string };
type GetArgs = { uid: string; addressBook?: string };
type CreateArgs = { name: string; members?: string[]; addressBook?: string };
type UpdateArgs = {
  uid: string;
  name?: string;
  addMembers?: string[];
  removeMembers?: string[];
  addressBook?: string;
};
type DeleteArgs = { uid: string; addressBook?: string };

/**
 * Loads a group and the book it lives in. The whole book is read, since the
 * members have to come from the same fetch anyway, and an individual's UID
 * is refused rather than treated as an empty group.
 */
async function loadGroup(
  uid: string,
  explicit: string | undefined,
  service: CardDavService,
): Promise<{ bookUrl: string; group: Contact; book: Contact[] }> {
  // Groups always need the whole book (members come from the same fetch), so
  // the located vCard is not reused here; only the book URL is.
  const { bookUrl } = await locateBookFor(uid, explicit, service);
  const book = await service.fetchContacts(bookUrl, { detailLevel: "summary" });
  const group = book.find((c) => c.uid === uid);
  if (!group) {
    throw new ContactError(`Group ${uid} not found`, ErrorCode.CONTACT_NOT_FOUND, uid);
  }
  if (!isGroup(group)) {
    throw new ValidationError(`Contact ${uid} (${group.fullName}) is not a group`, "uid");
  }
  return { bookUrl, group, book };
}

/**
 * Every UID must name an individual in the book: a UID from another book
 * would be a dangling reference on the server, and a nested group is not
 * something the clients that render groups understand.
 */
function assertMembersInBook(uids: string[], book: Contact[]): void {
  const byUid = new Map(book.map((c) => [c.uid, c]));
  const missing = uids.filter((uid) => !byUid.has(uid));
  if (missing.length > 0) {
    throw new ValidationError(
      `Members must be contacts in the group's address book; not found there: ${missing.join(", ")}`,
    );
  }
  const groups = uids.filter((uid) => isGroup(byUid.get(uid) as Contact));
  if (groups.length > 0) {
    throw new ValidationError(`A group cannot contain another group: ${groups.join(", ")}`);
  }
}

const dedupe = (uids: string[]): string[] => [...new Set(uids)];

export const GROUP_TOOLS: ReadonlyArray<ToolDef<CardDavService>> = [
  {
    name: "list_groups",
    title: "List Contact Groups",
    description:
      "List contact groups (distribution lists) with their member counts. Pass the UID to get_group for the members.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: { addressBook: ADDRESS_BOOK_PROP },
    },
    outputSchema: groupListSchema,
    handler: async (args: ListArgs, service) => {
      try {
        const books = await booksToSearch(args.addressBook, service);
        const contacts = await readAcrossBooks(books, (url) =>
          service.fetchContacts(url, { detailLevel: "summary" }),
        );
        const groups = contacts.filter(isGroup).map((g) => ({
          uid: g.uid,
          name: g.fullName,
          memberCount: g.members?.length ?? 0,
          addressBook: g.addressBook,
        }));
        return structured({ groups, count: groups.length });
      } catch (err) {
        return toolError(err);
      }
    },
  },
  {
    name: "get_group",
    title: "Get Contact Group",
    description:
      "Get a contact group with its members resolved to contacts (UID, name, first email). Member UIDs the address book no longer holds are listed under missingMembers.",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "The UID of the group" },
        addressBook: ADDRESS_BOOK_PROP,
      },
      required: ["uid"],
    },
    outputSchema: groupDetailSchema,
    handler: async (args: GetArgs, service) => {
      try {
        const { bookUrl, group, book } = await loadGroup(args.uid, args.addressBook, service);
        const byUid = new Map(book.map((c) => [c.uid, c]));
        const members: Array<{ uid: string; fullName: string; email?: string }> = [];
        const missingMembers: string[] = [];
        for (const uid of group.members ?? []) {
          const member = byUid.get(uid);
          if (!member) {
            missingMembers.push(uid);
            continue;
          }
          const email = member.emails[0]?.value;
          members.push({ uid, fullName: member.fullName, ...(email ? { email } : {}) });
        }
        return structured({
          uid: group.uid,
          name: group.fullName,
          addressBook: await bookLabel(bookUrl, args.addressBook, service),
          members,
          missingMembers,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  },
  {
    name: "create_group",
    title: "Create Contact Group",
    description:
      "Create a contact group. Members are UIDs of contacts already in the same address book.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Group name (e.g., 'Book Club')" },
        members: MEMBER_UIDS_PROP("Initial member UIDs. Default: none."),
        addressBook: {
          type: "string",
          description:
            "Address book URL or display name to create the group in. If omitted, uses the first available address book.",
        },
      },
      required: ["name"],
    },
    outputSchema: groupWriteResultSchema,
    handler: async (args: CreateArgs, service) => {
      try {
        const bookUrl = await resolveAddressBook(args.addressBook, service);
        const members = dedupe(args.members ?? []);
        if (members.length > 0) {
          const book = await service.fetchContacts(bookUrl, { detailLevel: "summary" });
          assertMembersInBook(members, book);
        }
        const group: Contact = {
          uid: randomUUID(),
          fullName: args.name,
          kind: "group",
          members,
          emails: [],
          phones: [],
          addresses: [],
          urls: [],
          otherProperties: [],
        };
        await service.createContact(bookUrl, group);
        return structured({
          status: "created" as const,
          uid: group.uid,
          name: group.fullName,
          memberCount: members.length,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  },
  {
    name: "update_group",
    title: "Update Contact Group",
    description:
      "Rename a contact group and/or add and remove members. Members are UIDs of contacts in the group's address book. Repeats and already-present additions are ignored.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "The UID of the group" },
        name: { type: "string", description: "New group name" },
        addMembers: MEMBER_UIDS_PROP("UIDs to add"),
        removeMembers: MEMBER_UIDS_PROP("UIDs to remove"),
        addressBook: ADDRESS_BOOK_PROP,
      },
      required: ["uid"],
    },
    outputSchema: groupWriteResultSchema,
    handler: async (args: UpdateArgs, service) => {
      try {
        const add = dedupe(args.addMembers ?? []);
        const remove = new Set(args.removeMembers ?? []);
        if (args.name === undefined && add.length === 0 && remove.size === 0) {
          throw new ValidationError("Nothing to update: pass name, addMembers, or removeMembers");
        }
        const { bookUrl, group, book } = await loadGroup(args.uid, args.addressBook, service);
        assertMembersInBook(add, book);
        const members = dedupe([...(group.members ?? []), ...add]).filter(
          (uid) => !remove.has(uid),
        );
        const name = args.name ?? group.fullName;
        // The merge re-reads the stored card and only overlays these fields,
        // so `kind: "group"` survives a rename: nothing here can demote a
        // group to an individual.
        await service.updateContact(bookUrl, group.uid, {
          ...(args.name !== undefined ? { fullName: args.name } : {}),
          members,
        });
        return structured({
          status: "updated" as const,
          uid: group.uid,
          name,
          memberCount: members.length,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  },
  {
    name: "delete_group",
    title: "Delete Contact Group",
    description:
      "Delete a contact group. The member contacts are not deleted. This cannot be undone, and asks the user to confirm first.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "The UID of the group" },
        addressBook: ADDRESS_BOOK_PROP,
      },
      required: ["uid"],
    },
    outputSchema: groupWriteResultSchema,
    handler: async (args: DeleteArgs, service, ctx) => {
      // The group is loaded before the gate so the prompt can name it: "delete
      // group Book Club (3 members)" is a question the user can answer, a bare
      // UID is not.
      let loaded: Awaited<ReturnType<typeof loadGroup>>;
      try {
        loaded = await loadGroup(args.uid, args.addressBook, service);
      } catch (err) {
        return toolError(err);
      }
      const { bookUrl, group } = loaded;
      const gate = confirmDestructive(
        ctx,
        "confirm_delete_group",
        `Delete the group "${group.fullName}" (${group.members?.length ?? 0} members)? The member contacts are kept. This cannot be undone.`,
      );
      if (gate.status === "interrupt") return gate.result;

      try {
        await service.deleteContact(bookUrl, group.uid);
        return structured({ status: "deleted" as const, uid: group.uid, name: group.fullName });
      } catch (err) {
        return toolError(err);
      }
    },
  },
];
