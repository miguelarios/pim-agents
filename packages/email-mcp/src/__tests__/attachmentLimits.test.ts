/**
 * The ceiling on inline attachment and message-source payloads.
 *
 * Without one, `download_attachment` on a 10 MB PDF emits ~13.3 MB of base64
 * in a single tool result — which most clients put straight into the model's
 * context. Calendar parts have been guarded this way since they were added
 * (`MAX_INLINE_CALENDAR_BYTES`); these tests hold the same line for
 * attachments and `.eml` sources, which are the payloads most likely to be
 * large in the first place.
 */
import { dispatchTool } from "@miguelarios/pim-core/mcp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_INLINE_BYTES, EMAIL_TOOLS } from "../tools/emailTools.js";

const call = (name: string, args: Record<string, unknown>, imap: unknown) =>
  dispatchTool(EMAIL_TOOLS, name, args, { imap, smtp: {} } as never) as Promise<any>;

const SMALL = Buffer.from("PDF!");

/** An IMAP stub whose `downloadAttachment` honours the `maxBytes` it is given. */
const imapWith = (content: Buffer, declaredSize = content.length) => ({
  downloadAttachment: vi.fn(async (_f: string, _u: number, partId: string, maxBytes?: number) => {
    const base = {
      filename: "report.pdf",
      contentType: "application/pdf",
      size: declaredSize,
      partId,
    };
    if (maxBytes !== undefined && declaredSize > maxBytes) {
      return { ...base, oversized: true as const };
    }
    return { ...base, oversized: false as const, content };
  }),
});

const originalEnv = process.env.EMAIL_MAX_INLINE_BYTES;
beforeEach(() => {
  process.env.EMAIL_MAX_INLINE_BYTES = undefined;
  delete process.env.EMAIL_MAX_INLINE_BYTES;
});
afterEach(() => {
  if (originalEnv === undefined) delete process.env.EMAIL_MAX_INLINE_BYTES;
  else process.env.EMAIL_MAX_INLINE_BYTES = originalEnv;
});

describe("download_attachment size ceiling", () => {
  it("embeds a small attachment's bytes, as before", async () => {
    const imap = imapWith(SMALL);
    const result = await call("download_attachment", { uid: 1, partId: "2" }, imap);

    const block = result.content.find((c: any) => c.type === "resource");
    expect(block.resource.blob).toBe(SMALL.toString("base64"));
    expect(result.structuredContent).toMatchObject({
      filename: "report.pdf",
      embedded: true,
      uri: "imap://INBOX/1/2",
    });
  });

  it("passes the ceiling down so oversized bytes are never pulled off the server", async () => {
    const imap = imapWith(SMALL);
    await call("download_attachment", { uid: 1, partId: "2" }, imap);

    expect(imap.downloadAttachment).toHaveBeenCalledWith("INBOX", 1, "2", DEFAULT_MAX_INLINE_BYTES);
  });

  it("returns a resolvable link instead of base64 when the attachment is oversized", async () => {
    const huge = DEFAULT_MAX_INLINE_BYTES + 1;
    const result = await call(
      "download_attachment",
      { uid: 4471, partId: "2" },
      imapWith(SMALL, huge),
    );

    expect(result.content.some((c: any) => c.type === "resource")).toBe(false);
    const link = result.content.find((c: any) => c.type === "resource_link");
    expect(link).toMatchObject({
      uri: "imap://INBOX/4471/2",
      name: "report.pdf",
      mimeType: "application/pdf",
      size: huge,
    });
    expect(result.structuredContent).toMatchObject({ embedded: false, size: huge });
  });

  it("explains the link in text, so the model knows the bytes are still reachable", async () => {
    const result = await call(
      "download_attachment",
      { uid: 4471, partId: "2" },
      imapWith(SMALL, DEFAULT_MAX_INLINE_BYTES + 1),
    );

    const text = result.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");
    expect(text).toMatch(/resources\/read/);
    expect(text).toContain("imap://INBOX/4471/2");
  });

  it("honours EMAIL_MAX_INLINE_BYTES", async () => {
    process.env.EMAIL_MAX_INLINE_BYTES = "2";
    const imap = imapWith(SMALL, 4);
    const result = await call("download_attachment", { uid: 1, partId: "2" }, imap);

    expect(imap.downloadAttachment).toHaveBeenCalledWith("INBOX", 1, "2", 2);
    expect(result.structuredContent).toMatchObject({ embedded: false });
  });

  it("treats 0 as always-link", async () => {
    process.env.EMAIL_MAX_INLINE_BYTES = "0";
    const result = await call("download_attachment", { uid: 1, partId: "2" }, imapWith(SMALL, 4));
    expect(result.structuredContent).toMatchObject({ embedded: false });
  });

  it.each(["not-a-number", "-1", ""])("falls back to the default for %o", async (value) => {
    process.env.EMAIL_MAX_INLINE_BYTES = value;
    const imap = imapWith(SMALL);
    await call("download_attachment", { uid: 1, partId: "2" }, imap);
    expect(imap.downloadAttachment).toHaveBeenCalledWith("INBOX", 1, "2", DEFAULT_MAX_INLINE_BYTES);
  });
});

describe("get_email_raw size ceiling", () => {
  const rawImap = (source: string | undefined, size: number) => ({
    fetchRawEmail: vi.fn(async (_f: string, _u: number, maxBytes?: number) =>
      maxBytes !== undefined && size > maxBytes
        ? { size, oversized: true as const }
        : { size, oversized: false as const, source },
    ),
  });

  it("embeds a small message's source", async () => {
    const result = await call("get_email_raw", { uid: 1 }, rawImap("From: a@b\r\n\r\nhi", 15));

    const block = result.content.find((c: any) => c.type === "resource");
    expect(block.resource.text).toContain("From: a@b");
    expect(result.structuredContent).toMatchObject({ embedded: true, uri: "imap://INBOX/1.eml" });
  });

  it("returns a link for an oversized message rather than the source", async () => {
    const huge = DEFAULT_MAX_INLINE_BYTES + 1;
    const result = await call("get_email_raw", { uid: 4471 }, rawImap(undefined, huge));

    expect(result.content.some((c: any) => c.type === "resource")).toBe(false);
    expect(result.content.find((c: any) => c.type === "resource_link")).toMatchObject({
      uri: "imap://INBOX/4471.eml",
      mimeType: "message/rfc822",
      size: huge,
    });
    expect(result.structuredContent).toMatchObject({ embedded: false, size: huge });
  });
});
