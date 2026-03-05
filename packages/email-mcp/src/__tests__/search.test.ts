import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "../search.js";

describe("parseSearchQuery", () => {
	it("parses from: prefix", () => {
		const result = parseSearchQuery("from:boss@work.com");
		expect(result).toEqual({ from: "boss@work.com" });
	});

	it("parses to: prefix", () => {
		const result = parseSearchQuery("to:someone@test.com");
		expect(result).toEqual({ to: "someone@test.com" });
	});

	it("parses subject: prefix", () => {
		const result = parseSearchQuery("subject:meeting notes");
		expect(result).toEqual({ subject: "meeting notes" });
	});

	it("parses is:unread flag", () => {
		const result = parseSearchQuery("is:unread");
		expect(result).toEqual({ seen: false });
	});

	it("parses is:read flag", () => {
		const result = parseSearchQuery("is:read");
		expect(result).toEqual({ seen: true });
	});

	it("parses is:flagged flag", () => {
		const result = parseSearchQuery("is:flagged");
		expect(result).toEqual({ flagged: true });
	});

	it("parses has:attachment", () => {
		const result = parseSearchQuery("has:attachment");
		expect(result).toEqual({
			header: { "content-type": "multipart/mixed" },
		});
	});

	it("parses since: date filter", () => {
		const result = parseSearchQuery("since:2026-01-15");
		expect(result).toEqual({ since: new Date("2026-01-15") });
	});

	it("parses before: date filter", () => {
		const result = parseSearchQuery("before:2026-03-01");
		expect(result).toEqual({ before: new Date("2026-03-01") });
	});

	it("treats plain text as body/subject search", () => {
		const result = parseSearchQuery("important project");
		expect(result).toEqual({ body: "important project" });
	});

	it("combines multiple prefixes", () => {
		const result = parseSearchQuery("from:boss@work.com is:unread");
		expect(result).toEqual({ from: "boss@work.com", seen: false });
	});

	it("combines prefix with plain text", () => {
		const result = parseSearchQuery("from:boss@work.com urgent deadline");
		expect(result).toEqual({
			from: "boss@work.com",
			body: "urgent deadline",
		});
	});

	it("returns empty object for empty query", () => {
		const result = parseSearchQuery("");
		expect(result).toEqual({});
	});

	it("returns empty object for whitespace-only query", () => {
		const result = parseSearchQuery("   ");
		expect(result).toEqual({});
	});
});
