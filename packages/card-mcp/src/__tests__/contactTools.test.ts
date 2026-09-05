import type { ServerContext } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";
import { CONTACT_TOOLS, UPDATABLE_FIELDS } from "../tools/contactTools.js";

/** Minimal handler context: no multi-round-trip input responses carried. */
const emptyCtx = { mcpReq: { inputResponses: undefined } } as unknown as ServerContext;
/** A context in which the user has already accepted `confirm_delete_contact`. */
const confirmedCtx = {
  mcpReq: {
    inputResponses: {
      confirm_delete_contact: { action: "accept", content: { confirm: true } },
    },
  },
} as unknown as ServerContext;

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
  it("defines 8 tools", () => {
    expect(CONTACT_TOOLS).toHaveLength(8);
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
    expect(props.emails.type).toEqual(["array", "null"]);
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

  it("searches every book when omitted, tagging each contact with its book", async () => {
    const mk = (uid: string) => ({
      uid,
      fullName: uid,
      emails: [],
      phones: [],
      addresses: [],
      urls: [],
      otherProperties: [],
    });
    const fetchSpy = vi.fn(async (url: string) => (url === "book1" ? [mk("a")] : [mk("b")]));
    const fakeService = {
      listAddressBooks: vi.fn().mockResolvedValue([
        { url: "book1", displayName: "Personal" },
        { url: "book2", displayName: "" },
      ]),
      findAddressBook: vi.fn(),
      fetchContacts: fetchSpy,
    };
    const res = await callTool("list_contacts", {}, fakeService);
    expect(fakeService.findAddressBook).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith("book1", { detailLevel: "summary" });
    expect(fetchSpy).toHaveBeenCalledWith("book2", { detailLevel: "summary" });
    expect(res.structuredContent.count).toBe(2);
    // A nameless book is tagged with its URL, so the tag is always something
    // the caller can pass straight back as `addressBook`.
    expect(res.structuredContent.contacts.map((c: any) => c.addressBook)).toEqual([
      "Personal",
      "book2",
    ]);
  });

  it("tags contacts from an explicit book with the reference the caller gave", async () => {
    const fakeService = {
      findAddressBook: vi.fn().mockResolvedValue("/dav/work/"),
      fetchContacts: vi.fn().mockResolvedValue([
        {
          uid: "a",
          fullName: "A",
          emails: [],
          phones: [],
          addresses: [],
          urls: [],
          otherProperties: [],
        },
      ]),
    };
    const res = await callTool("list_contacts", { addressBook: "Work" }, fakeService);
    expect(res.structuredContent.contacts[0].addressBook).toBe("Work");
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

describe("update_contact field forwarding", () => {
  const fakeService = () => ({
    listAddressBooks: vi.fn().mockResolvedValue([{ url: "b", displayName: "x" }]),
    findAddressBook: vi.fn().mockResolvedValue("b"),
    updateContact: vi.fn().mockResolvedValue(undefined),
  });

  it("forwards exactly the supplied fields and nothing else", async () => {
    const service = fakeService();
    const res = await callTool(
      "update_contact",
      { uid: "u1", note: "", emails: [{ type: "work", value: "a@b.c" }] },
      service,
    );

    expect(res.structuredContent).toEqual({ status: "updated", uid: "u1" });
    expect(service.updateContact).toHaveBeenCalledTimes(1);
    const [, uid, updates] = service.updateContact.mock.calls[0];
    expect(uid).toBe("u1");
    // Exact key set: an omitted field must not reach the merge as `undefined`,
    // and a supplied-but-falsy one (note: "") must survive.
    expect(Object.keys(updates).sort()).toEqual(["emails", "note"]);
    expect(updates).toEqual({ note: "", emails: [{ type: "work", value: "a@b.c" }] });
  });

  it("carries every updatable field through when all are supplied", async () => {
    const service = fakeService();
    const args = {
      uid: "u1",
      fullName: "Ada Lovelace",
      firstName: "Ada",
      lastName: "Lovelace",
      emails: [{ value: "ada@example.com" }],
      phones: [{ type: "cell", value: "+1 555 0100" }],
      addresses: [{ type: "home", street: "1 Analytical Way", city: "London" }],
      urls: [{ value: "https://example.com" }],
      organization: "Analytical Engines",
      title: "Countess",
      role: "Mathematician",
      nickname: "Ada",
      birthday: "1815-12-10",
      categories: ["friends"],
      note: "First programmer",
    };
    await callTool("update_contact", args, service);

    const { uid: _uid, ...expected } = args;
    expect(service.updateContact.mock.calls[0][2]).toEqual(expected);
  });

  it("never forwards addressBook — it selects the book, it is not a contact field", async () => {
    const service = fakeService();
    await callTool("update_contact", { uid: "u1", addressBook: "b", note: "n" }, service);
    expect(service.updateContact.mock.calls[0][2]).toEqual({ note: "n" });
  });

  it("every writable property in the input schema is an updatable field", () => {
    const tool = CONTACT_TOOLS.find((t) => t.name === "update_contact")!;
    const properties = Object.keys(
      (tool.inputSchema as { properties: Record<string, unknown> }).properties,
    );
    // uid identifies the contact and addressBook selects the book; every other
    // advertised property has to be one the handler actually copies, or the
    // tool accepts input it silently drops.
    const advertised = properties.filter((p) => p !== "uid" && p !== "addressBook").sort();
    expect(advertised).toEqual([...UPDATABLE_FIELDS].sort());
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

describe("move_contacts / copy_contacts", () => {
  const transferService = () => ({
    findAddressBook: vi.fn(async (ref: string) =>
      ref === "Work" ? "/dav/work/" : ref === "Personal" ? "/dav/personal/" : ref,
    ),
    moveContacts: vi.fn().mockResolvedValue({ transferred: [{ uid: "u1" }], failed: [] }),
    copyContacts: vi
      .fn()
      .mockResolvedValue({ transferred: [{ uid: "u1", newUid: "new-1" }], failed: [] }),
  });

  it("defines both tools as non-destructive writes", () => {
    for (const name of ["move_contacts", "copy_contacts"]) {
      const tool = CONTACT_TOOLS.find((t) => t.name === name)!;
      expect(tool, name).toBeDefined();
      expect(tool.outputSchema, name).toBeDefined();
      // Neither destroys data: move relocates, copy adds.
      expect(tool.annotations.destructiveHint, name).toBe(false);
      expect(tool.annotations.readOnlyHint, name).toBe(false);
    }
  });

  it("requires both books and the uids — neither end defaults", () => {
    for (const name of ["move_contacts", "copy_contacts"]) {
      const tool = CONTACT_TOOLS.find((t) => t.name === name)!;
      const required = (tool.inputSchema as { required?: string[] }).required ?? [];
      expect(required.sort(), name).toEqual(["addressBook", "targetAddressBook", "uids"]);
    }
  });

  it("resolves both books by display name and reports the resolved URLs", async () => {
    const service = transferService();
    const res = await callTool(
      "move_contacts",
      { uids: ["u1"], addressBook: "Personal", targetAddressBook: "Work" },
      service,
    );

    expect(service.findAddressBook).toHaveBeenCalledWith("Personal");
    expect(service.findAddressBook).toHaveBeenCalledWith("Work");
    expect(service.moveContacts).toHaveBeenCalledWith("/dav/personal/", "/dav/work/", ["u1"]);
    expect(res.structuredContent).toEqual({
      status: "moved",
      from: "/dav/personal/",
      to: "/dav/work/",
      transferred: [{ uid: "u1" }],
    });
  });

  it("returns the copy's new UID", async () => {
    const service = transferService();
    const res = await callTool(
      "copy_contacts",
      { uids: ["u1"], addressBook: "Personal", targetAddressBook: "Work" },
      service,
    );

    expect(res.structuredContent.status).toBe("copied");
    expect(res.structuredContent.transferred).toEqual([{ uid: "u1", newUid: "new-1" }]);
  });

  it("omits `failed` entirely when everything transferred", async () => {
    const service = transferService();
    const res = await callTool(
      "move_contacts",
      { uids: ["u1"], addressBook: "Personal", targetAddressBook: "Work" },
      service,
    );
    expect(res.structuredContent).not.toHaveProperty("failed");
  });

  it("surfaces partial failures alongside what did transfer", async () => {
    const service = transferService();
    service.moveContacts.mockResolvedValue({
      transferred: [{ uid: "u1" }],
      failed: [{ uid: "u2", message: "Contact u2 not found in the source address book" }],
    });

    const res = await callTool(
      "move_contacts",
      { uids: ["u1", "u2"], addressBook: "Personal", targetAddressBook: "Work" },
      service,
    );

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.transferred).toEqual([{ uid: "u1" }]);
    expect(res.structuredContent.failed).toEqual([
      { uid: "u2", message: "Contact u2 not found in the source address book" },
    ]);
  });

  it("reports a same-book transfer as an error", async () => {
    const service = transferService();
    class Invalid extends Error {
      code = "VALIDATION_FAILED";
    }
    service.moveContacts.mockRejectedValue(
      new Invalid("The source and target address books are the same — pick a different target"),
    );

    const res = await callTool(
      "move_contacts",
      { uids: ["u1"], addressBook: "Work", targetAddressBook: "Work" },
      service,
    );

    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).message).toMatch(/same/);
  });
});

describe("update_contact field clearing", () => {
  const fakeService = () => ({
    listAddressBooks: vi.fn().mockResolvedValue([{ url: "b", displayName: "x" }]),
    findAddressBook: vi.fn().mockResolvedValue("b"),
    updateContact: vi.fn().mockResolvedValue(undefined),
  });

  it("every optional field in the schema accepts null so it can be cleared", () => {
    const tool = CONTACT_TOOLS.find((t) => t.name === "update_contact")!;
    const props = (tool.inputSchema as any).properties as Record<string, any>;
    for (const field of UPDATABLE_FIELDS) {
      if (field === "fullName") {
        expect(props.fullName.type, "fullName").toBe("string");
        continue;
      }
      expect(props[field].type, field).toContain("null");
    }
  });

  it("forwards null through to the service rather than dropping it", async () => {
    const service = fakeService();
    await callTool("update_contact", { uid: "u1", note: null, phones: null }, service);
    expect(service.updateContact.mock.calls[0][2]).toEqual({ note: null, phones: null });
  });

  it("exposes the structured-name, org-unit and social-profile fields", () => {
    const tool = CONTACT_TOOLS.find((t) => t.name === "update_contact")!;
    const props = (tool.inputSchema as any).properties as Record<string, any>;
    for (const field of ["middleName", "namePrefix", "nameSuffix", "orgUnits", "socialProfiles"]) {
      expect(props[field], field).toBeDefined();
    }
    expect(props.socialProfiles.items.required).toEqual(["type"]);
  });
});

describe("create_contact extended fields", () => {
  it("forwards name parts, org units and social profiles to the service", async () => {
    const service = {
      listAddressBooks: vi.fn().mockResolvedValue([{ url: "b", displayName: "x" }]),
      createContact: vi.fn().mockResolvedValue(undefined),
    };
    await callTool(
      "create_contact",
      {
        fullName: "Dr. Ada B. Lovelace Jr.",
        middleName: "B.",
        namePrefix: "Dr.",
        nameSuffix: "Jr.",
        organization: "Acme",
        orgUnits: ["Engineering", "Platform"],
        socialProfiles: [{ type: "twitter", handle: "ada" }],
      },
      service,
    );
    const contact = service.createContact.mock.calls[0][1];
    expect(contact).toMatchObject({
      middleName: "B.",
      namePrefix: "Dr.",
      nameSuffix: "Jr.",
      orgUnits: ["Engineering", "Platform"],
      socialProfiles: [{ type: "twitter", handle: "ada" }],
    });
  });
});

describe("cross-book lookup when addressBook is omitted", () => {
  const mk = (uid: string) => ({
    uid,
    fullName: uid,
    emails: [],
    phones: [],
    addresses: [],
    urls: [],
    otherProperties: [],
  });
  const twoBooks = () => ({
    listAddressBooks: vi.fn().mockResolvedValue([
      { url: "book1", displayName: "Personal" },
      { url: "book2", displayName: "Work" },
    ]),
    fetchContacts: vi.fn(async (url: string) => (url === "book2" ? [mk("w1")] : [mk("p1")])),
    searchContacts: vi.fn(async (url: string) => (url === "book2" ? [mk("w1")] : [])),
    resolveContact: vi.fn().mockResolvedValue({ status: "not_found", message: "no" }),
    locateContact: vi.fn().mockResolvedValue("book2"),
    updateContact: vi.fn().mockResolvedValue(undefined),
    deleteContact: vi.fn().mockResolvedValue(undefined),
  });

  it("list_contacts with a query searches each book and merges", async () => {
    const service = twoBooks();
    const res = await callTool("list_contacts", { query: "w" }, service);
    expect(service.searchContacts).toHaveBeenCalledTimes(2);
    expect(res.structuredContent.contacts).toEqual([{ ...mk("w1"), addressBook: "Work" }]);
  });

  it("get_contact finds a contact filed in a later book", async () => {
    const service = twoBooks();
    const res = await callTool("get_contact", { uid: "w1" }, service);
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual({ ...mk("w1"), addressBook: "Work" });
  });

  it("resolve_contact passes every book URL to the service", async () => {
    const service = twoBooks();
    await callTool("resolve_contact", { name: "w" }, service);
    expect(service.resolveContact).toHaveBeenCalledWith(["book1", "book2"], "w");
  });

  it("update_contact locates the contact's book first", async () => {
    const service = twoBooks();
    await callTool("update_contact", { uid: "w1", note: "n" }, service);
    expect(service.locateContact).toHaveBeenCalledWith("w1", ["book1", "book2"]);
    expect(service.updateContact).toHaveBeenCalledWith("book2", "w1", { note: "n" });
  });

  it("delete_contact locates the contact's book first", async () => {
    const service = twoBooks();
    await callTool("delete_contact", { uid: "w1" }, service, confirmedCtx);
    expect(service.locateContact).toHaveBeenCalledWith("w1", ["book1", "book2"]);
    expect(service.deleteContact).toHaveBeenCalledWith("book2", "w1");
  });

  it("does not locate when the account has a single book", async () => {
    const service = twoBooks();
    service.listAddressBooks.mockResolvedValue([{ url: "only", displayName: "Only" }]);
    await callTool("update_contact", { uid: "w1", note: "n" }, service);
    expect(service.locateContact).not.toHaveBeenCalled();
    expect(service.updateContact).toHaveBeenCalledWith("only", "w1", { note: "n" });
  });
});
