/**
 * get_thread: assembling a conversation from References, from a server-side
 * thread id where one exists, and across the folders replies land in.
 */
import { dispatchTool } from "@miguelarios/pim-core/mcp";
import type { ServerContext } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMAIL_TOOLS } from "../tools/emailTools.js";

const CTX = { mcpReq: { inputResponses: undefined } } as unknown as ServerContext;

const summary = (uid: number, messageId: string, date: string, subject = "Budget") => ({
  uid,
  messageId,
  subject,
  from: { address: "ada@example.com" },
  to: [{ address: "user@test.com" }],
  date,
  flags: [],
  hasAttachments: false,
});

const mockFetchThread = vi.fn();
const mockGetSpecialUseFolder = vi.fn();

const imap = { fetchThread: mockFetchThread, getSpecialUseFolder: mockGetSpecialUseFolder } as any;

const getThread = (args: Record<string, unknown>) =>
  dispatchTool(EMAIL_TOOLS, "get_thread", args, { imap } as any, CTX) as Promise<any>;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSpecialUseFolder.mockResolvedValue("Sent");
  mockFetchThread.mockResolvedValue({
    rootMessageId: "<root@test.com>",
    messages: [
      { ...summary(1, "<root@test.com>", "2026-03-01T10:00:00.000Z"), folder: "INBOX" },
      { ...summary(7, "<reply@test.com>", "2026-03-02T10:00:00.000Z"), folder: "Sent" },
    ],
  });
});

describe("get_thread", () => {
  it("is declared read-only, with a title and an output schema", () => {
    const tool = EMAIL_TOOLS.find((t) => t.name === "get_thread")!;
    expect(tool.title).toBeTruthy();
    expect(tool.outputSchema).toBeDefined();
    expect(tool.inputSchema.required).toEqual(["uid"]);
    expect(tool.annotations.readOnlyHint).toBe(true);
  });

  it("returns the conversation with a count and the root message id", async () => {
    const result = await getThread({ uid: 1 });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent.rootMessageId).toBe("<root@test.com>");
    expect(result.structuredContent.count).toBe(2);
    expect(result.structuredContent.messages.map((m: any) => m.uid)).toEqual([1, 7]);
  });

  it("searches the anchor folder and the Sent folder by default", async () => {
    await getThread({ uid: 1 });

    expect(mockFetchThread).toHaveBeenCalledWith("INBOX", 1, ["INBOX", "Sent"]);
  });

  it("does not list the Sent folder twice when it is the anchor folder", async () => {
    await getThread({ folder: "Sent", uid: 1 });

    expect(mockFetchThread).toHaveBeenCalledWith("Sent", 1, ["Sent"]);
  });

  it("searches only the anchor folder when Sent cannot be resolved", async () => {
    mockGetSpecialUseFolder.mockRejectedValueOnce(new Error("FOLDER_NOT_FOUND"));

    await getThread({ uid: 1 });

    expect(mockFetchThread).toHaveBeenCalledWith("INBOX", 1, ["INBOX"]);
  });

  it("uses an explicit folder list as given, without adding Sent", async () => {
    await getThread({ uid: 1, folders: ["INBOX", "Archive"] });

    expect(mockFetchThread).toHaveBeenCalledWith("INBOX", 1, ["INBOX", "Archive"]);
    expect(mockGetSpecialUseFolder).not.toHaveBeenCalled();
  });

  it("rejects an empty explicit folder list", async () => {
    const result = await getThread({ uid: 1, folders: [] });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/folders must be a non-empty/);
    expect(mockFetchThread).not.toHaveBeenCalled();
  });

  it("surfaces a missing anchor message as a tool error", async () => {
    mockFetchThread.mockRejectedValueOnce(new Error("Email UID 99 not found"));

    const result = await getThread({ uid: 99 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/);
  });
});
