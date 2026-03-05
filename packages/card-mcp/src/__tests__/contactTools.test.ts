import { describe, expect, it } from "vitest";
import { CONTACT_TOOLS } from "../tools/contactTools.js";

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
});
