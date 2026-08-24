import type { ServerContext } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { CONTACT_TOOLS } from "../tools/contactTools.js";

/** Minimal handler context: no multi-round-trip input responses carried. */
const emptyCtx = { mcpReq: { inputResponses: undefined } } as unknown as ServerContext;

/** Invokes one tool's handler directly, bypassing the MCP transport. */
function callTool(
  name: string,
  args: Record<string, unknown>,
  service: unknown,
  ctx: ServerContext = emptyCtx,
) {
  const tool = CONTACT_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  // test-only invocation of a heterogeneous handler
  return tool.handler(args as any, service as any, ctx) as Promise<any>;
}

describe("CONTACT_TOOLS definitions", () => {
  it("defines 6 tools", () => {
    expect(CONTACT_TOOLS).toHaveLength(6);
  });

  it("all tools have name, title, description, and inputSchema", () => {
    for (const tool of CONTACT_TOOLS) {
      expect(tool.name).toBeDefined();
      expect(tool.title, tool.name).toBeDefined();
      expect(tool.description).toBeDefined();
      expect(tool.inputSchema).toBeDefined();
      expect((tool.inputSchema as { type: string }).type).toBe("object");
    }
  });

  it("all tools declare an output schema", () => {
    for (const tool of CONTACT_TOOLS) {
      expect(tool.outputSchema, tool.name).toBeDefined();
    }
  });

  it("all tools declare a complete set of behaviour annotations", () => {
    for (const tool of CONTACT_TOOLS) {
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

  it("uses tool names the spec allows", () => {
    for (const tool of CONTACT_TOOLS) {
      expect(tool.name, tool.name).toMatch(/^[A-Za-z0-9_.-]{1,128}$/);
    }
  });

  it("defines the expected tool names", () => {
    const names = CONTACT_TOOLS.map((t) => t.name);
    expect(names).toContain("list_contacts");
    expect(names).toContain("get_contact");
    expect(names).toContain("create_contact");
    expect(names).toContain("update_contact");
    expect(names).toContain("delete_contact");
    expect(names).toContain("resolve_contact");
  });

  it("list_contacts has query and addressBook params", () => {
    const tool = CONTACT_TOOLS.find((t) => t.name === "list_contacts")!;
    expect((tool.inputSchema as any).properties).toHaveProperty("query");
    expect((tool.inputSchema as any).properties).toHaveProperty("addressBook");
  });

  it("create_contact requires fullName", () => {
    const tool = CONTACT_TOOLS.find((t) => t.name === "create_contact")!;
    expect((tool.inputSchema as any).required).toContain("fullName");
  });

  it("resolve_contact requires name", () => {
    const tool = CONTACT_TOOLS.find((t) => t.name === "resolve_contact")!;
    expect((tool.inputSchema as any).required).toContain("name");
  });

  it("create_contact has typed email/phone schemas and new fields", () => {
    const tool = CONTACT_TOOLS.find((t) => t.name === "create_contact")!;
    const props = (tool.inputSchema as any).properties as Record<string, any>;

    // emails should be array of objects with type and value
    expect(props.emails.type).toBe("array");
    expect(props.emails.items.type).toBe("object");
    expect(props.emails.items.properties.value).toBeDefined();
    expect(props.emails.items.properties.type).toBeDefined();

    // phones should be array of objects with type and value
    expect(props.phones.type).toBe("array");
    expect(props.phones.items.type).toBe("object");
    expect(props.phones.items.properties.value).toBeDefined();
    expect(props.phones.items.properties.type).toBeDefined();

    // new fields exist
    expect(props.addresses).toBeDefined();
    expect(props.urls).toBeDefined();
    expect(props.role).toBeDefined();
    expect(props.nickname).toBeDefined();
    expect(props.birthday).toBeDefined();
    expect(props.categories).toBeDefined();
  });

  it("update_contact has typed email/phone schemas and new fields", () => {
    const tool = CONTACT_TOOLS.find((t) => t.name === "update_contact")!;
    const props = (tool.inputSchema as any).properties as Record<string, any>;
    expect(props.emails.type).toBe("array");
    expect(props.emails.items.type).toBe("object");
    expect(props.addresses).toBeDefined();
    expect(props.urls).toBeDefined();
    expect(props.role).toBeDefined();
    expect(props.nickname).toBeDefined();
    expect(props.birthday).toBeDefined();
    expect(props.categories).toBeDefined();
  });

  it("read-only tools carry readOnlyHint; destructive tools carry destructiveHint", () => {
    const byName = Object.fromEntries(CONTACT_TOOLS.map((t) => [t.name, t]));
    for (const name of ["list_contacts", "get_contact", "resolve_contact"]) {
      expect(byName[name].annotations.readOnlyHint, name).toBe(true);
    }
    expect(byName.delete_contact.annotations.destructiveHint).toBe(true);
    expect(byName.create_contact.annotations.readOnlyHint).toBe(false);
    expect(byName.create_contact.annotations.idempotentHint).toBe(false);
  });
});

describe("contactTools detail_level wiring", () => {
  it("list_contacts passes detailLevel to service (default summary)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue([]);
    const fakeService = {
      listAddressBooks: vi.fn().mockResolvedValue([{ url: "book1", displayName: "x" }]),
      fetchContacts: fetchSpy,
      searchContacts: vi.fn().mockResolvedValue([]),
    };
    await callTool("list_contacts", {}, fakeService);
    expect(fetchSpy).toHaveBeenCalledWith("book1", { detailLevel: "summary" });
  });

  it("list_contacts respects explicit detail_level=full", async () => {
    const fetchSpy = vi.fn().mockResolvedValue([]);
    const fakeService = {
      listAddressBooks: vi.fn().mockResolvedValue([{ url: "book1", displayName: "x" }]),
      fetchContacts: fetchSpy,
      searchContacts: vi.fn().mockResolvedValue([]),
    };
    await callTool("list_contacts", { detail_level: "full" }, fakeService);
    expect(fetchSpy).toHaveBeenCalledWith("book1", { detailLevel: "full" });
  });

  it("get_contact passes detailLevel to service", async () => {
    const fetchSpy = vi.fn().mockResolvedValue([
      {
        uid: "u1",
        fullName: "X",
        emails: [],
        phones: [],
        addresses: [],
        urls: [],
        otherProperties: [],
      },
    ]);
    const fakeService = {
      listAddressBooks: vi.fn().mockResolvedValue([{ url: "book1", displayName: "x" }]),
      fetchContacts: fetchSpy,
    };
    await callTool("get_contact", { uid: "u1", detail_level: "full" }, fakeService);
    expect(fetchSpy).toHaveBeenCalledWith("book1", { detailLevel: "full" });
  });
});

describe("resolve_contact handler new shape", () => {
  it("returns resolved JSON on single match", async () => {
    const fakeService = {
      listAddressBooks: vi.fn().mockResolvedValue([{ url: "b", displayName: "x" }]),
      resolveContact: vi.fn().mockResolvedValue({
        status: "resolved",
        fullName: "Patrick",
        email: "n@t.com",
      }),
    };
    const res = await callTool("resolve_contact", { name: "Patrick" }, fakeService);
    expect(res.structuredContent).toEqual({
      status: "resolved",
      fullName: "Patrick",
      email: "n@t.com",
    });
    // The spec requires the serialized JSON alongside structuredContent.
    expect(JSON.parse(res.content[0].text)).toEqual(res.structuredContent);
  });

  it("returns ambiguous JSON with candidates array on multi-match", async () => {
    const fakeService = {
      listAddressBooks: vi.fn().mockResolvedValue([{ url: "b", displayName: "x" }]),
      resolveContact: vi.fn().mockResolvedValue({
        status: "ambiguous",
        candidates: [
          { fullName: "Alice Brown", email: "a@x.com", uid: "u1" },
          { fullName: "Alice Smith", email: "r@x.com", uid: "u2" },
        ],
      }),
    };
    const res = await callTool("resolve_contact", { name: "Alice" }, fakeService);
    expect(res.structuredContent.status).toBe("ambiguous");
    expect(res.structuredContent.candidates).toHaveLength(2);
  });

  it("returns not_found JSON with message", async () => {
    const fakeService = {
      listAddressBooks: vi.fn().mockResolvedValue([{ url: "b", displayName: "x" }]),
      resolveContact: vi.fn().mockResolvedValue({
        status: "not_found",
        message: 'No contact with email found matching "Nobody"',
      }),
    };
    const res = await callTool("resolve_contact", { name: "Nobody" }, fakeService);
    expect(res.structuredContent.status).toBe("not_found");
    expect(res.structuredContent.message).toContain("Nobody");
  });
});

describe("address book name resolution", () => {
  it("resolves a display name through the service", async () => {
    const fetchSpy = vi.fn().mockResolvedValue([]);
    const fakeService = {
      findAddressBook: vi.fn().mockResolvedValue("/dav/work/"),
      fetchContacts: fetchSpy,
    };
    await callTool("list_contacts", { addressBook: "Work" }, fakeService);
    expect(fakeService.findAddressBook).toHaveBeenCalledWith("Work");
    expect(fetchSpy).toHaveBeenCalledWith("/dav/work/", { detailLevel: "summary" });
  });

  it("passes a URL through the same resolution path", async () => {
    const fetchSpy = vi.fn().mockResolvedValue([]);
    const fakeService = {
      findAddressBook: vi.fn().mockImplementation(async (ref: string) => ref),
      fetchContacts: fetchSpy,
    };
    await callTool("list_contacts", { addressBook: "/dav/other/" }, fakeService);
    expect(fetchSpy).toHaveBeenCalledWith("/dav/other/", { detailLevel: "summary" });
  });

  it("still falls back to the first book when omitted", async () => {
    const fetchSpy = vi.fn().mockResolvedValue([]);
    const fakeService = {
      listAddressBooks: vi.fn().mockResolvedValue([{ url: "book1", displayName: "x" }]),
      findAddressBook: vi.fn(),
      fetchContacts: fetchSpy,
    };
    await callTool("list_contacts", {}, fakeService);
    expect(fakeService.findAddressBook).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith("book1", { detailLevel: "summary" });
  });

  it("surfaces an unknown name as ADDRESSBOOK_NOT_FOUND", async () => {
    const { ContactError, ErrorCode } = await import("@miguelarios/pim-core");
    const fakeService = {
      findAddressBook: vi
        .fn()
        .mockRejectedValue(
          new ContactError('No address book named "Nope"', ErrorCode.ADDRESSBOOK_NOT_FOUND),
        ),
      fetchContacts: vi.fn(),
    };
    const res = await callTool("list_contacts", { addressBook: "Nope" }, fakeService);
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe("ADDRESSBOOK_NOT_FOUND");
    expect(fakeService.fetchContacts).not.toHaveBeenCalled();
  });
});

describe("delete_contact confirmation gate", () => {
  const fakeService = () => ({
    listAddressBooks: vi.fn().mockResolvedValue([{ url: "b", displayName: "x" }]),
    deleteContact: vi.fn().mockResolvedValue(undefined),
  });

  it("asks for confirmation before deleting anything", async () => {
    const service = fakeService();
    const res = await callTool("delete_contact", { uid: "u1" }, service);
    expect(res.resultType).toBe("input_required");
    expect(res.inputRequests.confirm_delete_contact).toBeDefined();
    expect(service.deleteContact).not.toHaveBeenCalled();
  });

  it("deletes once the user confirms", async () => {
    const service = fakeService();
    const ctx = {
      mcpReq: {
        inputResponses: {
          confirm_delete_contact: { action: "accept", content: { confirm: true } },
        },
      },
    } as unknown as ServerContext;
    const res = await callTool("delete_contact", { uid: "u1" }, service, ctx);
    expect(res.structuredContent).toEqual({ status: "deleted", uid: "u1" });
    expect(service.deleteContact).toHaveBeenCalledWith("b", "u1");
  });

  it("does not delete, and does not re-ask, when the user declines", async () => {
    const service = fakeService();
    const ctx = {
      mcpReq: {
        inputResponses: { confirm_delete_contact: { action: "decline" } },
      },
    } as unknown as ServerContext;
    const res = await callTool("delete_contact", { uid: "u1" }, service, ctx);
    expect(res.isError).toBe(true);
    expect(res.resultType).toBeUndefined();
    expect(service.deleteContact).not.toHaveBeenCalled();
  });

  it("does not delete when the user answers no", async () => {
    const service = fakeService();
    const ctx = {
      mcpReq: {
        inputResponses: {
          confirm_delete_contact: { action: "accept", content: { confirm: false } },
        },
      },
    } as unknown as ServerContext;
    const res = await callTool("delete_contact", { uid: "u1" }, service, ctx);
    expect(res.isError).toBe(true);
    expect(service.deleteContact).not.toHaveBeenCalled();
  });

  it("skips confirmation when PIM_MCP_CONFIRM=off", async () => {
    const service = fakeService();
    vi.stubEnv("PIM_MCP_CONFIRM", "off");
    try {
      const res = await callTool("delete_contact", { uid: "u1" }, service);
      expect(res.structuredContent).toEqual({ status: "deleted", uid: "u1" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("tool errors", () => {
  it("surfaces the PimError code to the client", async () => {
    const service = {
      listAddressBooks: vi.fn().mockResolvedValue([{ url: "b", displayName: "x" }]),
      fetchContacts: vi.fn().mockResolvedValue([]),
    };
    const res = await callTool("get_contact", { uid: "missing" }, service);
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text)).toMatchObject({
      error: "CONTACT_NOT_FOUND",
      retryable: false,
    });
  });
});
