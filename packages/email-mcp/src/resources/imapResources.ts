/**
 * `imap://` resource URIs, and the `resources/read` handlers behind them.
 *
 * `download_attachment` and `get_email_raw` have always stamped these URIs onto
 * their embedded resource blocks, but nothing could resolve one — the URI was a
 * label on a payload the client had already been handed. Registering them as
 * real resources makes them addressable, so a client can fetch the bytes on its
 * own terms instead of only ever receiving them inline.
 *
 * The URI shape is this server's own, not RFC 5092's `imap://` URL: there the
 * authority names the *server*, because a URL has to be resolvable by a third
 * party. These never leave the session that minted them, so the authority is
 * spent on the mailbox instead, which is the part that varies per call.
 */
import { EmailError, ErrorCode } from "@miguelarios/pim-core";
import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import type { ImapService } from "../services/ImapService.js";

/** RFC 6570 template for one attachment: `imap://INBOX/4471/2`. */
export const ATTACHMENT_URI_TEMPLATE = "imap://{folder}/{uid}/{partId}";

/** RFC 6570 template for a message's RFC 822 source: `imap://INBOX/4471.eml`. */
export const RAW_EMAIL_URI_TEMPLATE = "imap://{folder}/{uid}.eml";

/** The IMAP surface these handlers need — narrowed so tests can pass a stub. */
type AttachmentReader = Pick<ImapService, "downloadAttachment">;
type RawEmailReader = Pick<ImapService, "fetchRawEmail">;

/**
 * The URI for one attachment.
 *
 * The folder occupies the authority, so it is percent-encoded whole: an IMAP
 * hierarchy delimiter inside it (`Archive/2024`) must not become a path
 * separator, or the parse would read `2024` as the uid.
 */
export function attachmentUri(folder: string, uid: number, partId: string): string {
  return `imap://${encodeURIComponent(folder)}/${uid}/${encodeURIComponent(partId)}`;
}

/** The URI for a message's RFC 822 source. */
export function rawEmailUri(folder: string, uid: number): string {
  return `imap://${encodeURIComponent(folder)}/${uid}.eml`;
}

/** What an `imap://` URI addresses, once parsed. */
export type ImapTarget =
  | { kind: "attachment"; folder: string; uid: number; partId: string }
  | { kind: "raw"; folder: string; uid: number };

/**
 * Parses an `imap://` URI, or returns `undefined` when it is not one of ours.
 *
 * Parsing goes through `URL` rather than the template variables the SDK hands
 * the read callback, so tool-minted and client-supplied URIs are read by the
 * same code. `imap:` is not a WHATWG "special" scheme, so the authority keeps
 * its case — which matters, because IMAP mailbox names are case-sensitive and
 * an http-style lowercasing would silently retarget `INBOX` to `inbox`.
 */
export function parseImapUri(uri: string | URL): ImapTarget | undefined {
  let url: URL;
  try {
    url = typeof uri === "string" ? new URL(uri) : uri;
  } catch {
    return undefined;
  }
  if (url.protocol !== "imap:") return undefined;

  const folder = decodeSegment(url.host);
  if (!folder) return undefined;

  const segments = url.pathname.replace(/^\//, "").split("/");

  if (segments.length === 1) {
    const raw = segments[0];
    if (!raw.endsWith(".eml")) return undefined;
    const uid = parseUid(raw.slice(0, -".eml".length));
    return uid === undefined ? undefined : { kind: "raw", folder, uid };
  }

  if (segments.length === 2) {
    const uid = parseUid(segments[0]);
    const partId = decodeSegment(segments[1]);
    if (uid === undefined || !partId) return undefined;
    return { kind: "attachment", folder, uid, partId };
  }

  return undefined;
}

/** Serves one attachment's bytes, base64-encoded under its own media type. */
export async function readAttachmentResource(uri: URL, imap: AttachmentReader) {
  const target = parseImapUri(uri);
  if (target?.kind !== "attachment") {
    throw new EmailError(
      `${uri.href} is not a valid attachment URI — expected imap://<folder>/<uid>/<partId>`,
      ErrorCode.INVALID_INPUT,
    );
  }

  const attachment = await imap.downloadAttachment(target.folder, target.uid, target.partId);
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: attachment.contentType,
        blob: attachment.content.toString("base64"),
      },
    ],
  };
}

/** Serves a message's RFC 822 source. */
export async function readRawEmailResource(uri: URL, imap: RawEmailReader) {
  const target = parseImapUri(uri);
  if (target?.kind !== "raw") {
    throw new EmailError(
      `${uri.href} is not a valid message URI — expected imap://<folder>/<uid>.eml`,
      ErrorCode.INVALID_INPUT,
    );
  }

  const raw = await imap.fetchRawEmail(target.folder, target.uid);
  return {
    contents: [{ uri: uri.href, mimeType: "message/rfc822", text: raw }],
  };
}

/**
 * Registers both templates against an {@link McpServer}.
 *
 * Neither template gets a `list` callback: enumerating every attachment in an
 * account would mean walking every message in every folder, and the useful
 * entry point is `search_emails` / `get_email` anyway. Clients still discover
 * the shapes through `resources/templates/list`.
 */
export function registerImapResources(
  server: McpServer,
  imap: AttachmentReader & RawEmailReader,
): void {
  server.registerResource(
    "email-attachment",
    new ResourceTemplate(ATTACHMENT_URI_TEMPLATE, { list: undefined }),
    {
      title: "Email Attachment",
      description:
        "One attachment's bytes, addressed by folder, message UID and MIME part ID. Part IDs come from get_email's attachment metadata.",
    },
    (uri) => readAttachmentResource(uri, imap),
  );

  server.registerResource(
    "email-source",
    new ResourceTemplate(RAW_EMAIL_URI_TEMPLATE, { list: undefined }),
    {
      title: "Email Source",
      description: "A message's raw RFC 822 source, addressed by folder and message UID.",
      mimeType: "message/rfc822",
    },
    (uri) => readRawEmailResource(uri, imap),
  );
}

/** A percent-decoded URI segment, or `undefined` when it is empty or malformed. */
function decodeSegment(segment: string): string | undefined {
  if (!segment) return undefined;
  try {
    return decodeURIComponent(segment) || undefined;
  } catch {
    return undefined;
  }
}

/** A UID, or `undefined` unless the text is a plain positive integer. */
function parseUid(text: string): number | undefined {
  if (!/^\d+$/.test(text)) return undefined;
  const uid = Number(text);
  return uid > 0 ? uid : undefined;
}
