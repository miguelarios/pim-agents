import type { ServerContext } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { ADDRESS_BOOK_TOOLS } from "../tools/addressBookTools.js";

/** Minimal handler context: no multi-round-trip input responses carried. */
const emptyCtx = { mcpReq: { inputResponses: undefined } } as unknown as ServerContext;

const confirmCtx = (key: string, answer: unknown) =>
  ({ mcpReq: { inputResponses: { [key]: answer } } }) as unknown as ServerContext;

/** Invokes one tool's handler directly, bypassing the MCP transport. */
function callTool(
  name: string,
  args: Record<string, unknown>,
  service: unknown,
  ctx: ServerContext = emptyCtx,
) {
  const tool = ADDRESS_BOOK_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  // test-only invocation of a heterogeneous handler
  return tool.handler(args as any, service as any, ctx) as Promise<any>;
}

const fakeService = () => ({
  listAddressBooks: vi.fn().mockResolvedValue([
    { displayName: "Personal", url: "/dav/personal/", ctag: "c1" },
    { displayName: "Work", url: "/dav/work/", ctag: "c2", contactCount: 3 },
  ]),
  findAddressBook: vi.fn().mockResolvedValue("/dav/work/"),
  createAddressBook: vi.fn().mockResolvedValue({ url: "/dav/team/", displayName: "Team" }),
  renameAddressBook: vi.fn().mockResolvedValue(undefined),
  deleteAddressBook: vi.fn().mockResolvedValue(undefined),
  countContacts: vi.fn().mockResolvedValue(128),
});

describe("ADDRESS_BOOK_TOOLS definitions", () => {
  it("defines the four tools with complete annotations", () => {
    expect(ADDRESS_BOOK_TOOLS.map((t) => t.name)).toEqual([
      "list_address_books",
      "create_address_book",
      "rename_address_book",
      "delete_address_book",
    ]);
    for (const tool of ADDRESS_BOOK_TOOLS) {
      expect(tool.title, tool.name).toBeTruthy();
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
  });

  it("requires the target on every write tool — no first-book fallback", () => {
    for (const [name, required] of [
      ["create_address_book", "displayName"],
      ["rename_address_book", "addressBook"],
      ["delete_address_book", "addressBook"],
    ] as const) {
      const tool = ADDRESS_BOOK_TOOLS.find((t) => t.name === name)!;
      expect((tool.inputSchema as { required?: string[] }).required, name).toContain(required);
    }
  });
});

describe("list_address_books", () => {
  it("returns the books and a count", async () => {
    const service = fakeService();
    const res = await callTool("list_address_books", {}, service);
    expect(res.structuredContent.count).toBe(2);
    expect(res.structuredContent.addressBooks[1]).toMatchObject({
      displayName: "Work",
      url: "/dav/work/",
    });
    expect(service.listAddressBooks).toHaveBeenCalledWith({ includeCounts: false });
  });

  it("passes include_counts through as includeCounts", async () => {
    const service = fakeService();
    await callTool("list_address_books", { include_counts: true }, service);
    expect(service.listAddressBooks).toHaveBeenCalledWith({ includeCounts: true });
  });
});

describe("create_address_book", () => {
  it("creates and reports the new book", async () => {
    const service = fakeService();
    const res = await callTool(
      "create_address_book",
      { displayName: "Team", description: "d" },
      service,
    );
    expect(service.createAddressBook).toHaveBeenCalledWith({
      displayName: "Team",
      description: "d",
      slug: undefined,
    });
    expect(res.structuredContent).toEqual({
      status: "created",
      url: "/dav/team/",
      displayName: "Team",
    });
  });

  it("maps a service failure to a tool error", async () => {
    const { ContactError, ErrorCode } = await import("@miguelarios/pim-core");
    const service = fakeService();
    service.createAddressBook.mockRejectedValue(
      new ContactError("already exists", ErrorCode.OPERATION_FAILED),
    );
    const res = await callTool("create_address_book", { displayName: "Work" }, service);
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe("OPERATION_FAILED");
  });
});

describe("rename_address_book", () => {
  it("resolves the reference and renames", async () => {
    const service = fakeService();
    const res = await callTool(
      "rename_address_book",
      { addressBook: "Work", displayName: "Clients" },
      service,
    );
    expect(service.findAddressBook).toHaveBeenCalledWith("Work");
    expect(service.renameAddressBook).toHaveBeenCalledWith("/dav/work/", {
      displayName: "Clients",
      description: undefined,
    });
    expect(res.structuredContent).toEqual({
      status: "renamed",
      url: "/dav/work/",
      displayName: "Clients",
    });
  });
});

describe("delete_address_book confirmation gate", () => {
  it("asks before deleting, naming the book and its contact count", async () => {
    const service = fakeService();
    const res = await callTool("delete_address_book", { addressBook: "Work" }, service);
    expect(res.resultType).toBe("input_required");
    const request = res.inputRequests.confirm_delete_address_book;
    expect(request).toBeDefined();
    const serialized = JSON.stringify(request);
    expect(serialized).toContain("Work");
    expect(serialized).toContain("128");
    expect(service.deleteAddressBook).not.toHaveBeenCalled();
  });

  it("deletes once the user confirms", async () => {
    const service = fakeService();
    const res = await callTool(
      "delete_address_book",
      { addressBook: "Work" },
      service,
      confirmCtx("confirm_delete_address_book", { action: "accept", content: { confirm: true } }),
    );
    expect(service.deleteAddressBook).toHaveBeenCalledWith("/dav/work/");
    expect(res.structuredContent).toEqual({
      status: "deleted",
      url: "/dav/work/",
      displayName: "Work",
    });
  });

  it("does not delete when the user declines", async () => {
    const service = fakeService();
    const res = await callTool(
      "delete_address_book",
      { addressBook: "Work" },
      service,
      confirmCtx("confirm_delete_address_book", { action: "decline" }),
    );
    expect(res.isError).toBe(true);
    expect(service.deleteAddressBook).not.toHaveBeenCalled();
  });

  it("still prompts, without a number, when the count is unavailable", async () => {
    const service = fakeService();
    service.countContacts.mockResolvedValue(undefined);
    const res = await callTool("delete_address_book", { addressBook: "Work" }, service);
    expect(res.resultType).toBe("input_required");
    expect(JSON.stringify(res.inputRequests.confirm_delete_address_book)).toContain(
      "every contact",
    );
  });
});
