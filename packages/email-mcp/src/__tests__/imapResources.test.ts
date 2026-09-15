/**
 * `imap://` URI round-tripping and the `resources/read` handlers behind it.
 *
 * The builders and the parser are tested as a pair on purpose: the tools mint
 * these URIs and the resource handlers resolve them, so a change to one that
 * is not mirrored in the other silently breaks the link.
 */
import { describe, expect, it, vi } from "vitest";
import {
  attachmentUri,
  parseImapUri,
  rawEmailUri,
  readAttachmentResource,
  readRawEmailResource,
} from "../resources/imapResources.js";

describe("imap:// URI builders", () => {
  it("round-trips a plain folder, uid and part id", () => {
    const uri = attachmentUri("INBOX", 4471, "2");
    expect(uri).toBe("imap://INBOX/4471/2");
    expect(parseImapUri(uri)).toEqual({
      kind: "attachment",
      folder: "INBOX",
      uid: 4471,
      partId: "2",
    });
  });

  it("preserves folder case, which IMAP treats as significant", () => {
    // `imap:` is not a WHATWG "special" scheme, so the authority is not
    // lowercased the way an http:// host would be. INBOX/inbox are different
    // mailboxes, so this is load-bearing rather than incidental.
    expect(parseImapUri(attachmentUri("Sent Items", 1, "2"))).toMatchObject({
      folder: "Sent Items",
    });
    expect(parseImapUri(attachmentUri("iNbOx", 1, "2"))).toMatchObject({ folder: "iNbOx" });
  });

  it("round-trips a hierarchical folder without splitting it into path segments", () => {
    const uri = attachmentUri("Archive/2024", 99, "1.2");
    expect(parseImapUri(uri)).toEqual({
      kind: "attachment",
      folder: "Archive/2024",
      uid: 99,
      partId: "1.2",
    });
  });

  it("round-trips a raw message URI", () => {
    const uri = rawEmailUri("INBOX", 4471);
    expect(uri).toBe("imap://INBOX/4471.eml");
    expect(parseImapUri(uri)).toEqual({ kind: "raw", folder: "INBOX", uid: 4471 });
  });

  it("keeps the two URI shapes distinct", () => {
    expect(parseImapUri("imap://INBOX/12/2")).toMatchObject({ kind: "attachment" });
    expect(parseImapUri("imap://INBOX/12.eml")).toMatchObject({ kind: "raw" });
  });

  it.each([
    ["a foreign scheme", "https://example.com/INBOX/1/2"],
    ["a missing folder", "imap:///1/2"],
    ["a non-numeric uid", "imap://INBOX/not-a-uid/2"],
    ["a negative uid", "imap://INBOX/-3/2"],
    ["a fractional uid", "imap://INBOX/3.5/2"],
    ["an empty part id", "imap://INBOX/1/"],
    ["a trailing path segment", "imap://INBOX/1/2/3"],
    ["a bare folder", "imap://INBOX"],
  ])("rejects %s", (_label, uri) => {
    expect(parseImapUri(uri)).toBeUndefined();
  });
});

describe("readAttachmentResource", () => {
  const imap = () => ({
    downloadAttachment: vi.fn().mockResolvedValue({
      filename: "report.pdf",
      contentType: "application/pdf",
      size: 4,
      content: Buffer.from("PDF!"),
    }),
  });

  it("returns the bytes as base64 with the attachment's own mime type", async () => {
    const service = imap();
    const result = await readAttachmentResource(new URL("imap://INBOX/4471/2"), service as never);

    expect(service.downloadAttachment).toHaveBeenCalledWith("INBOX", 4471, "2");
    expect(result.contents).toHaveLength(1);
    // `name` is deliberately absent: ResourceContents is {uri, blob|text,
    // mimeType?, _meta?}, and the filename already rides on
    // download_attachment's structuredContent.
    expect(result.contents[0]).toMatchObject({
      uri: "imap://INBOX/4471/2",
      mimeType: "application/pdf",
      blob: Buffer.from("PDF!").toString("base64"),
    });
  });

  it("rejects a malformed URI without reaching IMAP", async () => {
    const service = imap();
    await expect(
      readAttachmentResource(new URL("imap://INBOX/not-a-uid/2"), service as never),
    ).rejects.toThrow(/not a valid attachment/i);
    expect(service.downloadAttachment).not.toHaveBeenCalled();
  });
});

describe("readRawEmailResource", () => {
  it("returns the source as text under message/rfc822", async () => {
    const service = {
      fetchRawEmail: vi.fn().mockResolvedValue("From: ada@example.com\r\n\r\nbody"),
    };
    const result = await readRawEmailResource(new URL("imap://INBOX/4471.eml"), service as never);

    expect(service.fetchRawEmail).toHaveBeenCalledWith("INBOX", 4471);
    expect(result.contents[0]).toMatchObject({
      uri: "imap://INBOX/4471.eml",
      mimeType: "message/rfc822",
      text: "From: ada@example.com\r\n\r\nbody",
    });
  });
});
