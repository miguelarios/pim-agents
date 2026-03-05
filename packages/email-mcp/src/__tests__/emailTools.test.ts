import { describe, expect, it } from "vitest";
import { EMAIL_TOOLS } from "../tools/emailTools.js";

describe("EMAIL_TOOLS definitions", () => {
	it("defines 10 tools", () => {
		expect(EMAIL_TOOLS).toHaveLength(10);
	});

	it("all tools have name, description, and inputSchema", () => {
		for (const tool of EMAIL_TOOLS) {
			expect(tool.name).toBeDefined();
			expect(tool.description).toBeDefined();
			expect(tool.inputSchema).toBeDefined();
			expect(tool.inputSchema.type).toBe("object");
		}
	});

	it("defines the expected tool names", () => {
		const names = EMAIL_TOOLS.map((t) => t.name);
		expect(names).toContain("list_emails");
		expect(names).toContain("get_email");
		expect(names).toContain("send_email");
		expect(names).toContain("move_email");
		expect(names).toContain("mark_email");
		expect(names).toContain("delete_email");
		expect(names).toContain("list_folders");
		expect(names).toContain("create_folder");
		expect(names).toContain("download_attachment");
		expect(names).toContain("get_email_raw");
	});

	it("send_email requires to and subject", () => {
		const tool = EMAIL_TOOLS.find((t) => t.name === "send_email")!;
		expect(tool.inputSchema.required).toContain("to");
		expect(tool.inputSchema.required).toContain("subject");
	});

	it("list_emails has folder and query params", () => {
		const tool = EMAIL_TOOLS.find((t) => t.name === "list_emails")!;
		expect(tool.inputSchema.properties).toHaveProperty("folder");
		expect(tool.inputSchema.properties).toHaveProperty("query");
	});

	it("get_email requires folder and uid", () => {
		const tool = EMAIL_TOOLS.find((t) => t.name === "get_email")!;
		expect(tool.inputSchema.required).toContain("uid");
	});

	it("download_attachment requires uid and partId", () => {
		const tool = EMAIL_TOOLS.find(
			(t) => t.name === "download_attachment",
		)!;
		expect(tool.inputSchema.required).toContain("uid");
		expect(tool.inputSchema.required).toContain("partId");
	});
});
