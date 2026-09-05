import type { ServerContext } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { GROUP_TOOLS } from "../tools/groupTools.js";

const emptyCtx = { mcpReq: { inputResponses: undefined } } as unknown as ServerContext;
const confirmedCtx = {
  mcpReq: {
    inputResponses: {
      confirm_delete_group: { action: "accept", content: { confirm: true } },
    },
  },
} as unknown as ServerContext;

function callTool(
  name: string,
  args: Record<string, unknown>,
  service: unknown,
  ctx: ServerContext = emptyCtx,
) {
  const tool = GROUP_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  // test-only invocation of a heterogeneous handler
  return tool.handler(args as any, service as any, ctx) as Promise<any>;
}

const person = (uid: string, fullName: string, email?: string) => ({
  uid,
  fullName,
  emails: email ? [{ value: email }] : [],
  phones: [],
  addresses: [],
  urls: [],
  otherProperties: [],
});
const group = (uid: string, fullName: string, members: string[]) => ({
  ...person(uid, fullName),
  kind: "group" as const,
  members,
});

/** Two books: Personal holds a group and its members; Work holds one person. */
function fakeService() {
  const personal = [
    person("a", "Ada", "ada@x.io"),
    person("b", "Bob"),
    group("g1", "Book Club", ["a", "b", "ghost"]),
  ];
  const work = [person("w", "Wu", "wu@corp.io"), group("g2", "Team", ["w"])];
  const byUrl: Record<string, unknown[]> = { "/p/": personal, "/w/": work };
  return {
    listAddressBooks: vi.fn().mockResolvedValue([
      { url: "/p/", displayName: "Personal" },
      { url: "/w/", displayName: "Work" },
    ]),
    findAddressBook: vi.fn(async (ref: string) => (ref === "Work" ? "/w/" : "/p/")),
    fetchContacts: vi.fn(async (url: string) => byUrl[url] ?? []),
    locateContact: vi.fn(async (uid: string) => {
      const bookUrl = uid.startsWith("g2") || uid === "w" ? "/w/" : "/p/";
      return { bookUrl, url: `${bookUrl}${uid}.vcf`, etag: '"e"' };
    }),
    createContact: vi.fn().mockResolvedValue(undefined),
    updateContact: vi.fn().mockResolvedValue(undefined),
    deleteContact: vi.fn().mockResolvedValue(undefined),
  };
}

describe("GROUP_TOOLS definitions", () => {
  it("defines the five group tools with complete metadata", () => {
    expect(GROUP_TOOLS.map((t) => t.name)).toEqual([
      "list_groups",
      "get_group",
      "create_group",
      "update_group",
      "delete_group",
    ]);
    for (const tool of GROUP_TOOLS) {
      expect(tool.title, tool.name).toBeDefined();
      expect(tool.outputSchema, tool.name).toBeDefined();
      for (const hint of [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ] as const) {
        expect(typeof tool.annotations[hint], `${tool.name}.${hint}`).toBe("boolean");
      }
    }
    const byName = Object.fromEntries(GROUP_TOOLS.map((t) => [t.name, t]));
    expect(byName.list_groups.annotations.readOnlyHint).toBe(true);
    expect(byName.get_group.annotations.readOnlyHint).toBe(true);
    expect(byName.delete_group.annotations.destructiveHint).toBe(true);
    expect(byName.create_group.annotations.idempotentHint).toBe(false);
  });
});

describe("list_groups", () => {
  it("lists only groups, across every book, with member counts", async () => {
    const res = await callTool("list_groups", {}, fakeService());
    expect(res.structuredContent).toEqual({
      groups: [
        { uid: "g1", name: "Book Club", memberCount: 3, addressBook: "Personal" },
        { uid: "g2", name: "Team", memberCount: 1, addressBook: "Work" },
      ],
      count: 2,
    });
  });

  it("restricts to one book when named", async () => {
    const res = await callTool("list_groups", { addressBook: "Work" }, fakeService());
    expect(res.structuredContent.groups.map((g: any) => g.uid)).toEqual(["g2"]);
  });
});

describe("get_group", () => {
  it("expands members from the same book and reports UIDs it cannot find", async () => {
    const res = await callTool("get_group", { uid: "g1" }, fakeService());
    expect(res.structuredContent).toEqual({
      uid: "g1",
      name: "Book Club",
      addressBook: "Personal",
      members: [
        { uid: "a", fullName: "Ada", email: "ada@x.io" },
        { uid: "b", fullName: "Bob" },
      ],
      missingMembers: ["ghost"],
    });
  });

  it("fails as CONTACT_NOT_FOUND for an unknown UID", async () => {
    const res = await callTool("get_group", { uid: "nope" }, fakeService());
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe("CONTACT_NOT_FOUND");
  });

  it("refuses an individual's UID — it is not a group", async () => {
    const res = await callTool("get_group", { uid: "a" }, fakeService());
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).message).toMatch(/not a group/);
  });
});

describe("create_group", () => {
  it("creates a KIND:group card in the first book with the given members", async () => {
    const service = fakeService();
    const res = await callTool("create_group", { name: "Chess", members: ["a", "b"] }, service);
    expect(res.structuredContent).toMatchObject({ status: "created", name: "Chess" });
    expect(typeof res.structuredContent.uid).toBe("string");
    const [url, contact] = service.createContact.mock.calls[0];
    expect(url).toBe("/p/");
    expect(contact).toMatchObject({ fullName: "Chess", kind: "group", members: ["a", "b"] });
  });

  it("rejects members that are not in the target book", async () => {
    const service = fakeService();
    const res = await callTool("create_group", { name: "X", members: ["a", "w"] }, service);
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).message).toContain("w");
    expect(service.createContact).not.toHaveBeenCalled();
  });

  it("rejects a group as a member", async () => {
    const service = fakeService();
    const res = await callTool("create_group", { name: "X", members: ["g1"] }, service);
    expect(res.isError).toBe(true);
    expect(service.createContact).not.toHaveBeenCalled();
  });

  it("defaults to no members", async () => {
    const service = fakeService();
    await callTool("create_group", { name: "Empty", addressBook: "Work" }, service);
    expect(service.createContact.mock.calls[0][0]).toBe("/w/");
    expect(service.createContact.mock.calls[0][1].members).toEqual([]);
  });
});

describe("update_group", () => {
  it("rejects the group itself as a member", async () => {
    const service = fakeService();
    const res = await callTool("update_group", { uid: "g1", addMembers: ["g1"] }, service);
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).message).toMatch(/cannot contain another group/);
    expect(service.updateContact).not.toHaveBeenCalled();
  });

  it("refuses a UID that is both added and removed", async () => {
    const service = fakeService();
    const res = await callTool(
      "update_group",
      { uid: "g1", addMembers: ["b"], removeMembers: ["b"] },
      service,
    );
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).message).toContain("b");
    expect(service.updateContact).not.toHaveBeenCalled();
  });

  it("adds and removes members, ignoring repeats, and can rename", async () => {
    const service = fakeService();
    const res = await callTool(
      "update_group",
      { uid: "g1", name: "Readers", addMembers: ["b", "b"], removeMembers: ["ghost"] },
      service,
    );
    expect(res.structuredContent).toEqual({
      status: "updated",
      uid: "g1",
      name: "Readers",
      memberCount: 2,
    });
    expect(service.updateContact).toHaveBeenCalledWith("/p/", "g1", {
      fullName: "Readers",
      members: ["a", "b"],
    });
  });

  it("renames without touching membership", async () => {
    const service = fakeService();
    const res = await callTool("update_group", { uid: "g1", name: "Readers" }, service);
    expect(res.structuredContent).toEqual({
      status: "updated",
      uid: "g1",
      name: "Readers",
      memberCount: 3,
    });
    expect(service.updateContact).toHaveBeenCalledWith("/p/", "g1", {
      fullName: "Readers",
      members: ["a", "b", "ghost"],
    });
  });

  it("rejects adding a member from another book", async () => {
    const service = fakeService();
    const res = await callTool("update_group", { uid: "g1", addMembers: ["w"] }, service);
    expect(res.isError).toBe(true);
    expect(service.updateContact).not.toHaveBeenCalled();
  });

  it("requires something to change", async () => {
    const res = await callTool("update_group", { uid: "g1" }, fakeService());
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe("VALIDATION_FAILED");
  });
});

describe("delete_group", () => {
  it("asks for confirmation naming the group, then deletes only the group card", async () => {
    const service = fakeService();
    const first = await callTool("delete_group", { uid: "g1" }, service);
    expect(first.resultType).toBe("input_required");
    expect(JSON.stringify(first.inputRequests.confirm_delete_group)).toContain("Book Club");
    expect(service.deleteContact).not.toHaveBeenCalled();

    const res = await callTool("delete_group", { uid: "g1" }, service, confirmedCtx);
    expect(res.structuredContent).toEqual({
      status: "deleted",
      uid: "g1",
      name: "Book Club",
      memberCount: 3,
    });
    expect(service.deleteContact).toHaveBeenCalledWith("/p/", "g1");
  });
});
