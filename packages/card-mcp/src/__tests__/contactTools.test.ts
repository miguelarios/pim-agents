import { describe, expect, it, vi } from "vitest";
import { CONTACT_TOOLS, handleContactTool } from "../tools/contactTools.js";

describe("CONTACT_TOOLS definitions", () => {
  it("defines 6 tools", () => {
    expect(CONTACT_TOOLS).toHaveLength(6);
  });

  it("all tools have name, description, and inputSchema", () => {
    for (const tool of CONTACT_TOOLS) {
      expect(tool.name).toBeDefined();
      expect(tool.description).toBeDefined();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
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
    expect(tool.inputSchema.properties).toHaveProperty("query");
    expect(tool.inputSchema.properties).toHaveProperty("addressBook");
  });

  it("create_contact requires fullName", () => {
    const tool = CONTACT_TOOLS.find((t) => t.name === "create_contact")!;
    expect(tool.inputSchema.required).toContain("fullName");
  });

  it("resolve_contact requires name", () => {
    const tool = CONTACT_TOOLS.find((t) => t.name === "resolve_contact")!;
    expect(tool.inputSchema.required).toContain("name");
  });

  it("create_contact has typed email/phone schemas and new fields", () => {
    const tool = CONTACT_TOOLS.find((t) => t.name === "create_contact")!;
    const props = tool.inputSchema.properties as Record<string, any>;

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
    const props = tool.inputSchema.properties as Record<string, any>;
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
    const byName = Object.fromEntries(CONTACT_TOOLS.map((t) => [t.name, t as any]));
    for (const name of ["list_contacts", "get_contact", "resolve_contact"]) {
      expect(byName[name].annotations?.readOnlyHint, name).toBe(true);
    }
    expect(byName.delete_contact.annotations?.destructiveHint).toBe(true);
    expect(byName.create_contact.annotations?.readOnlyHint).toBeFalsy();
  });
});

describe("contactTools detail_level wiring", () => {
  it("list_contacts passes detailLevel to service (default summary)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue([]);
    const fakeService = {
      listAddressBooks: vi.fn().mockResolvedValue([{ url: "book1", displayName: "x" }]),
      fetchContacts: fetchSpy,
      searchContacts: vi.fn().mockResolvedValue([]),
    } as any;
    await handleContactTool("list_contacts", {}, fakeService);
    expect(fetchSpy).toHaveBeenCalledWith("book1", { detailLevel: "summary" });
  });

  it("list_contacts respects explicit detail_level=full", async () => {
    const fetchSpy = vi.fn().mockResolvedValue([]);
    const fakeService = {
      listAddressBooks: vi.fn().mockResolvedValue([{ url: "book1", displayName: "x" }]),
      fetchContacts: fetchSpy,
      searchContacts: vi.fn().mockResolvedValue([]),
    } as any;
    await handleContactTool("list_contacts", { detail_level: "full" }, fakeService);
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
    } as any;
    await handleContactTool("get_contact", { uid: "u1", detail_level: "full" }, fakeService);
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
    } as any;
    const res = await handleContactTool("resolve_contact", { name: "Patrick" }, fakeService);
    const body = JSON.parse(res.content[0].text);
    expect(body).toEqual({ status: "resolved", fullName: "Patrick", email: "n@t.com" });
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
    } as any;
    const res = await handleContactTool("resolve_contact", { name: "Alice" }, fakeService);
    const body = JSON.parse(res.content[0].text);
    expect(body.status).toBe("ambiguous");
    expect(body.candidates).toHaveLength(2);
  });

  it("returns not_found JSON with message", async () => {
    const fakeService = {
      listAddressBooks: vi.fn().mockResolvedValue([{ url: "b", displayName: "x" }]),
      resolveContact: vi.fn().mockResolvedValue({
        status: "not_found",
        message: 'No contact with email found matching "Nobody"',
      }),
    } as any;
    const res = await handleContactTool("resolve_contact", { name: "Nobody" }, fakeService);
    const body = JSON.parse(res.content[0].text);
    expect(body.status).toBe("not_found");
    expect(body.message).toContain("Nobody");
  });
});
