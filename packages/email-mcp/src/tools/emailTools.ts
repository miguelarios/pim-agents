import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import {
  type CallToolResult,
  type ToolDef,
  type ToolResult,
  confirmDestructive,
  fail,
  structured,
  toolError,
} from "@miguelarios/pim-core/mcp";
import { simpleParser } from "mailparser";
import { htmlToMarkdown } from "../htmlToMarkdown.js";
import { attachmentUri, rawEmailUri } from "../resources/imapResources.js";
import type { SearchParams } from "../search.js";
import type { EmailFull, ImapService } from "../services/ImapService.js";
import type { SmtpService } from "../services/SmtpService.js";
import {
  attachmentSchema,
  copyResultSchema,
  createFolderResultSchema,
  deleteFolderResultSchema,
  deleteResultSchema,
  emailFullSchema,
  folderListSchema,
  folderStatusSchema,
  markResultSchema,
  moveResultSchema,
  rawEmailSchema,
  renameFolderResultSchema,
  searchResultSchema,
  sendResultSchema,
  threadResultSchema,
} from "./emailSchemas.js";

/**
 * Bytes above which a payload comes back as a resource link rather than inline
 * base64.
 *
 * Matches `MAX_INLINE_CALENDAR_BYTES`, which has guarded calendar parts since
 * they were added — attachments are the payloads most likely to be large, so
 * there is no case for a looser limit here than the one text parts already
 * live under. Base64 inflates by a third on top of this, so the ceiling is
 * conservative by design.
 */
export const DEFAULT_MAX_INLINE_BYTES = 256 * 1024;

/**
 * The configured inline ceiling. `0` links everything; anything unparseable
 * falls back to the default rather than disabling the guard, since a typo in
 * an env var should not restore the unbounded behaviour.
 */
function maxInlineBytes(): number {
  const raw = process.env.EMAIL_MAX_INLINE_BYTES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_INLINE_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_INLINE_BYTES;
  return parsed;
}

/** Human-readable bytes, for the note that explains a link. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Both backing services, passed to every handler as one unit. */
export interface EmailServices {
  imap: ImapService;
  smtp: SmtpService;
}

/**
 * One attachment as the tool accepts it. `content` is a JSON string, so binary
 * needs `encoding: "base64"` to survive the trip — see {@link resolveAttachment}.
 */
type Attachment = {
  filename: string;
  path?: string;
  content?: string;
  contentType?: string;
  encoding?: "base64" | "utf8";
};

/** An attachment as the SMTP layer takes it, with `content` already decoded. */
type ResolvedAttachment = {
  filename: string;
  path?: string;
  content?: string | Buffer;
  contentType?: string;
};

/**
 * Decodes strict, canonical base64.
 *
 * `Buffer.from(s, "base64")` cannot be used as the check: it silently discards
 * anything outside the alphabet, so a typo'd payload becomes a shorter, valid
 * Buffer and the recipient gets a corrupt file with no error anywhere. The
 * alphabet and length are checked first, then a re-encode catches non-canonical
 * trailing bits that the regex alone would accept.
 *
 * Line wrapping is tolerated because base64 is routinely stored wrapped, and
 * an attachment rejected for containing newlines would be a puzzle to debug.
 */
function decodeBase64(value: string, filename: string): Buffer {
  const compact = value.replace(/\s+/g, "");
  const wellFormed = /^[A-Za-z0-9+/]*={0,2}$/.test(compact) && compact.length % 4 === 0;
  const decoded = wellFormed ? Buffer.from(compact, "base64") : undefined;
  if (!decoded || decoded.toString("base64") !== compact) {
    throw new Error(
      `attachment "${filename}" declares encoding "base64" but content is not valid base64`,
    );
  }
  return decoded;
}

/**
 * Applies `encoding` and drops it, so the SMTP layer receives bytes rather
 * than a second decoding instruction.
 *
 * `encoding` describes `content` only. Pairing it with `path` means the caller
 * believes it does something, so it is rejected rather than ignored — a silent
 * no-op here reads as "the file was attached the way I asked".
 */
function resolveAttachment(att: Attachment): ResolvedAttachment {
  const { encoding, ...rest } = att;
  if (encoding !== undefined && att.content === undefined) {
    throw new Error(
      att.path === undefined
        ? `attachment "${att.filename}" sets encoding but has no content to apply it to`
        : `attachment "${att.filename}" sets encoding, which describes content, but attaches a path — drop encoding, or pass the bytes as base64 content instead`,
    );
  }
  if (encoding === "base64" && att.content !== undefined) {
    return { ...rest, content: decodeBase64(att.content, att.filename) };
  }
  return rest;
}

function assertAttachmentPathAllowed(p: string): void {
  const allowedRoot = process.env.EMAIL_ATTACHMENT_DIR;
  if (!allowedRoot) {
    throw new Error(
      "attachments[].path is disabled — set EMAIL_ATTACHMENT_DIR to a directory to allow file attachments, or pass content instead",
    );
  }
  const root = realpathSync(resolve(allowedRoot));
  const target = realpathSync(resolve(p));
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`attachment path is outside EMAIL_ATTACHMENT_DIR: ${p}`);
  }
}

/** Lower-cased and trimmed, for comparing and de-duplicating addresses. */
function addressKey(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Works out who a reply-all goes to, from the message being replied to.
 *
 * Every address the account owns is dropped, so the sender is not copied back
 * to themselves, and an address that appears twice across the headers is kept
 * once — at the strongest position it held, since To outranks Cc.
 */
function deriveReplyAllRecipients(
  original: EmailFull,
  ownAddresses: string[],
): { to: string[]; cc: string[]; bcc: string[] } {
  // Seeding `placed` with our own addresses drops them and de-duplicates in
  // one pass: an address already "placed" is never emitted again.
  const placed = new Set(ownAddresses.map(addressKey));
  const take = (addresses: Array<{ address: string }> | undefined): string[] => {
    const out: string[] = [];
    for (const entry of addresses ?? []) {
      const address = entry?.address?.trim();
      if (!address) continue;
      const key = addressKey(address);
      if (placed.has(key)) continue;
      placed.add(key);
      out.push(address);
    }
    return out;
  };

  // RFC 5322 §3.6.2: Reply-To is precisely the author's statement of where
  // replies belong, so it replaces From rather than joining it.
  const authors = original.replyTo?.length ? original.replyTo : [original.from];
  const to = [...take(authors), ...take(original.to)];
  const cc = take(original.cc);
  // A received message never carries Bcc; one read back out of Sent or Drafts
  // does, and dropping it there would quietly narrow the thread.
  const bcc = take(original.bcc);

  // Everything on To was ours. Rather than send a message with an empty To
  // header, promote the Cc list — which is what a mail client does.
  if (to.length === 0 && cc.length > 0) {
    return { to: cc, cc: [], bcc };
  }
  return { to, cc, bcc };
}

/** Runs a handler body, converting anything thrown into a tool execution error. */
async function run(body: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (err) {
    return toolError(err);
  }
}

function invalid(message: string): CallToolResult {
  return fail("INVALID_INPUT", message);
}

const FOLDER_PROP = {
  type: "string",
  description: "IMAP folder. Defaults to INBOX.",
} as const;

const UIDS_PROP = (description: string) =>
  ({ type: "array", items: { type: "number" }, description }) as const;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const EMAIL_TOOLS: ReadonlyArray<ToolDef<EmailServices>> = [
  {
    name: "search_emails",
    title: "Search Emails",
    description:
      "Search and list emails in a folder. Returns email summaries with configurable sorting (default: date descending). All filters combine with AND logic. Use the dedicated fields (subject, from, to, etc.) for most searches. Sorting uses the server's native SORT command where the server supports it, which makes pagination exact at any size; where it does not, the result set is sorted here instead and for >1000 results a non-date sort is approximate (ordered within the page only).",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: 'IMAP folder path. Defaults to "INBOX".' },
        subject: {
          type: "string",
          description:
            "Search subject line. Multiple words are ANDed. Use -term to exclude. Use quotes for exact phrase: '\"weekly report\"'.",
        },
        from: {
          type: "string",
          description: "Match sender name or email address (substring match).",
        },
        to: {
          type: "string",
          description: "Match recipient name or email address (substring match).",
        },
        cc: { type: "string", description: "Match CC recipient (substring match)." },
        bcc: { type: "string", description: "Match BCC recipient (substring match)." },
        body: {
          type: "string",
          description:
            "Search body text. Multiple words are ANDed. Use -term to exclude. Use quotes for exact phrase: '\"project update\"'.",
        },
        hasWords: {
          type: "string",
          description:
            'Search all message content (headers + body, IMAP TEXT). Multiple words are ANDed. Use quotes for exact phrase. Use -term for exclusion. Examples: "budget", "report -draft", \'"quarterly report"\'.',
        },
        since: { type: "string", description: "Emails on or after this date (YYYY-MM-DD)." },
        before: { type: "string", description: "Emails before this date (YYYY-MM-DD)." },
        unread: {
          type: "boolean",
          description:
            'Filter by unread status. true matches unread only, false matches read only. Omit to match both — do not send false to mean "any".',
        },
        flagged: {
          type: "boolean",
          description:
            'Filter by flagged/starred status. true matches flagged only, false matches unflagged only. Omit to match both — do not send false to mean "any".',
        },
        hasAttachment: {
          type: "boolean",
          description:
            "true matches emails with attachments. false is not a filter (IMAP cannot express it) and matches both. Omit to match both.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter by IMAP keyword flags.",
        },
        limit: { type: "number", description: "Max results to return. Defaults to 50." },
        offset: {
          type: "number",
          description: "Number of results to skip for pagination. Defaults to 0.",
        },
        sortBy: {
          type: "string",
          enum: ["date", "from", "subject"],
          description: "Sort field. Defaults to date.",
        },
        sortOrder: {
          type: "string",
          enum: ["asc", "desc"],
          description: "Sort direction. Defaults to desc (newest first for date).",
        },
      },
    },
    outputSchema: searchResultSchema,
    handler: (
      args: SearchParams & {
        folder?: string;
        limit?: number;
        offset?: number;
        sortBy?: "date" | "from" | "subject";
        sortOrder?: "asc" | "desc";
      },
      { imap },
    ) =>
      run(async () => {
        const searchParams: SearchParams = {
          hasWords: args.hasWords,
          body: args.body,
          from: args.from,
          to: args.to,
          cc: args.cc,
          bcc: args.bcc,
          subject: args.subject,
          since: args.since,
          before: args.before,
          unread: args.unread,
          flagged: args.flagged,
          hasAttachment: args.hasAttachment,
          tags: args.tags,
        };
        const emails = await imap.searchEmails(args.folder || "INBOX", searchParams, {
          limit: args.limit || 50,
          offset: args.offset || 0,
          sortBy: args.sortBy ?? "date",
          sortOrder: args.sortOrder ?? "desc",
        });
        return structured({ emails, count: emails.length });
      }),
  },
  {
    name: "get_email",
    title: "Get Email",
    description:
      "Fetch a full email by UID including headers, body, and attachment metadata. Calendar invitations (text/calendar parts, even inline ones without a filename) are surfaced in calendarParts with their iTIP method and decoded iCalendar content. Returns body as markdown by default for token efficiency. Use format='html' or format='text' for raw content.",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "IMAP folder containing the email. Defaults to INBOX.",
        },
        uid: { type: "number", description: "The UID of the email to fetch." },
        format: {
          type: "string",
          enum: ["markdown", "html", "text"],
          description:
            "Body format to return. 'markdown' (default) converts HTML to clean markdown for token efficiency. 'html' returns raw HTML. 'text' returns plain text only.",
        },
      },
      required: ["uid"],
    },
    outputSchema: emailFullSchema,
    handler: (
      args: { folder?: string; uid: number; format?: "markdown" | "html" | "text" },
      { imap },
    ) =>
      run(async () => {
        const format = args.format || "markdown";
        const email = await imap.fetchEmail(args.folder || "INBOX", args.uid);

        if (format === "markdown") {
          try {
            if (email.htmlBody) {
              email.markdownBody = await htmlToMarkdown(email.htmlBody);
            } else if (email.textBody) {
              email.markdownBody = email.textBody;
            }
            delete email.htmlBody;
            delete email.textBody;
          } catch {
            // Conversion failed — fall back to returning raw bodies unchanged
          }
        } else if (format === "text") {
          delete email.htmlBody;
        } else if (format === "html") {
          delete email.textBody;
        }

        return structured(email);
      }),
  },
  {
    name: "get_thread",
    title: "Get Thread",
    description:
      "Fetch the whole conversation a message belongs to, oldest first. Given any message in a thread, this follows its References chain back to the root and finds everything that cites it — or uses the server's own thread id where the server keeps one. By default it looks in the message's folder and the account's Sent folder, so your own replies are part of the conversation rather than missing from it; pass folders to search elsewhere. Returns summaries, not bodies — use get_email for the text of any one message.",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "IMAP folder holding the message to start from. Defaults to INBOX.",
        },
        uid: {
          type: "number",
          description: "UID of any message in the thread — the root or any reply.",
        },
        folders: {
          type: "array",
          items: { type: "string" },
          description:
            "Folders to search for thread members. Defaults to the message's folder plus the account's Sent folder. Pass this to search an archive as well; a folder that cannot be opened is skipped rather than failing the call.",
        },
      },
      required: ["uid"],
    },
    outputSchema: threadResultSchema,
    handler: (args: { folder?: string; uid: number; folders?: string[] }, { imap }) =>
      run(async () => {
        const folder = args.folder || "INBOX";

        let folders: string[];
        if (args.folders !== undefined) {
          if (!Array.isArray(args.folders) || args.folders.length === 0) {
            return invalid("folders must be a non-empty array of folder paths");
          }
          folders = args.folders;
        } else {
          // Sent by default: a conversation with your own replies missing from
          // it is not the conversation. An account with no resolvable Sent
          // folder simply gets the one folder.
          folders = [folder];
          try {
            const sent = await imap.getSpecialUseFolder("\\Sent");
            if (sent !== folder) folders.push(sent);
          } catch {
            // No Sent folder to add.
          }
        }

        const thread = await imap.fetchThread(folder, args.uid, folders);
        return structured({
          rootMessageId: thread.rootMessageId,
          count: thread.messages.length,
          messages: thread.messages,
        });
      }),
  },
  {
    name: "send_email",
    title: "Send Email",
    description:
      "Compose and send an email, or save it as a draft. Supports replies with automatic threading — when replyToUid is provided, the tool fetches the original email and sets correct In-Reply-To/References headers and Re: subject prefix automatically. Set saveToDrafts to true to save to the Drafts folder instead of sending. Sending (but not saving a draft) asks the user to confirm first. Sent emails are automatically copied to the Sent folder.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "array",
          items: { type: "string" },
          description:
            "Recipient email addresses. Required unless replyAll is set, which derives them from the message being replied to. Giving it explicitly overrides the derived list.",
        },
        cc: {
          type: "array",
          items: { type: "string" },
          description:
            "CC email addresses. Under replyAll, omitting this derives the CC list from the original; giving it overrides that list.",
        },
        bcc: {
          type: "array",
          items: { type: "string" },
          description:
            "BCC email addresses. Under replyAll, omitting this carries over the original's BCC when there is one to carry — see replyAll.",
        },
        subject: {
          type: "string",
          description:
            "Email subject line. Required for new emails. When replyToUid is set and subject is omitted, automatically uses 'Re: <original subject>'. When provided explicitly, used as-is.",
        },
        text: { type: "string", description: "Plain text body." },
        html: { type: "string", description: "HTML body." },
        attachments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              filename: { type: "string" },
              path: {
                type: "string",
                description:
                  "File path to attach. Disabled unless the server has EMAIL_ATTACHMENT_DIR set to an allowed directory; the resolved path must be inside it. Use content instead if unavailable.",
              },
              content: { type: "string", description: "Content to attach, as a string." },
              encoding: {
                type: "string",
                enum: ["base64", "utf8"],
                description:
                  "How to read content. Use base64 to attach binary — a PDF or image, or an attachment fetched with download_attachment. Omitted or utf8 attaches content as text, which corrupts binary. Cannot be combined with path.",
              },
              contentType: {
                type: "string",
                description:
                  "MIME type, e.g. application/pdf. Defaults to a guess from filename, so set it when the filename has no extension or the guess would be wrong.",
              },
            },
            required: ["filename"],
          },
          description: "File attachments.",
        },
        replyToUid: {
          type: "number",
          description:
            "UID of the email to reply to. When set, the tool automatically fetches the original email's Message-ID and References chain, sets In-Reply-To and References headers, and prepends 'Re:' to the subject if not already present. The reply will appear threaded in all email clients.",
        },
        replyToFolder: {
          type: "string",
          description:
            "IMAP folder containing the email referenced by replyToUid. Defaults to INBOX.",
        },
        replyAll: {
          type: "boolean",
          description:
            "Reply to everyone on the original rather than only its sender. Requires replyToUid. To becomes the original's Reply-To (or its From) plus its To; CC becomes the original's CC; addresses this account owns are dropped so the reply is not sent back to the sender. When the original itself carries a BCC — which happens only for a message this account sent, read back from Sent or Drafts — those recipients are carried over too, and remain blind. An explicit to, cc or bcc overrides the corresponding derived list. Defaults to false.",
        },
        saveToDrafts: {
          type: "boolean",
          description:
            "When true, saves the composed email to the Drafts folder instead of sending it. The draft will appear in any email client and can be edited there. Defaults to false.",
        },
        from: {
          type: "string",
          description:
            "Optional visible From address. Must be SMTP_USER or listed in the server's SMTP_ALLOWED_FROM allowlist; anything else is rejected. SMTP envelope delivery still uses the account sender, so an address on a different domain than SMTP_USER may fail DMARC at the recipient.",
        },
        fromName: {
          type: "string",
          description:
            "Optional visible display name for the From header. Useful when multiple agents share one allowed sender address. Changes only the display name, never the address.",
        },
      },
    },
    outputSchema: sendResultSchema,
    handler: async (
      args: {
        to?: string[] | string;
        cc?: string[] | string;
        bcc?: string[] | string;
        subject?: string;
        text?: string;
        html?: string;
        attachments?: Attachment[];
        replyToUid?: number;
        replyToFolder?: string;
        replyAll?: boolean;
        saveToDrafts?: boolean;
        from?: string;
        fromName?: string;
      },
      { imap, smtp },
      ctx,
    ) => {
      const list = (value: string[] | string | undefined): string[] | undefined =>
        value == null ? undefined : Array.isArray(value) ? value : [value];
      let to = list(args.to);
      let cc = list(args.cc);
      let bcc = list(args.bcc);
      const saveToDrafts = args.saveToDrafts || false;
      const replyAll = args.replyAll || false;

      // Validation: subject required when not replying
      if (!args.subject && !args.replyToUid) {
        return invalid("subject is required when not replying to an existing email");
      }
      if (replyAll && args.replyToUid === undefined) {
        return invalid("replyAll requires replyToUid — there is no thread to reply to without it");
      }

      // Attachments are resolved before the gate, not inside the handler body.
      // Every failure here is the request being wrong, and a confirmation spent
      // on a send that was never going to happen is worse than no confirmation:
      // it teaches the user that confirming does not mean the mail went out.
      //
      // Shape is still checked before the path policy, so a request that
      // contradicts itself is answered on its own terms rather than with
      // whatever EMAIL_ATTACHMENT_DIR happens to be set to.
      let attachments: ResolvedAttachment[];
      try {
        attachments = (args.attachments ?? []).map((att) => {
          const resolved = resolveAttachment(att);
          if (resolved.path) assertAttachmentPathAllowed(resolved.path);
          return resolved;
        });
      } catch (err) {
        // `invalid` rather than a throw: these reach `toPimError`, which has no
        // pattern for them and would label plain caller error INTERNAL_ERROR.
        return invalid(err instanceof Error ? err.message : String(err));
      }

      // The original is fetched before the gate, not inside the handler body,
      // because under replyAll it is what decides the recipients — and a
      // confirmation that cannot name who the mail is going to is not a
      // confirmation. The cost is one extra FETCH per confirmation round trip.
      let original: EmailFull | undefined;
      if (args.replyToUid !== undefined) {
        try {
          original = await imap.fetchEmail(args.replyToFolder || "INBOX", args.replyToUid);
        } catch (err) {
          return toolError(err);
        }
      }

      if (replyAll && original) {
        const derived = deriveReplyAllRecipients(original, smtp.ownAddresses());
        // Per field, not all-or-nothing: an explicit `to` with a derived `cc`
        // is a real request ("reply to everyone, but send it to Ada").
        to ??= derived.to;
        cc ??= derived.cc;
        if (derived.bcc.length > 0) bcc ??= derived.bcc;

        // Checked on the effective recipients, after the overrides — not on
        // the derived ones before them. A caller who supplied `to` has named
        // someone, and the derivation finding only this account is then not a
        // problem to refuse over.
        if (to.length === 0 && (cc?.length ?? 0) === 0) {
          return invalid(
            "replyAll found no recipients other than this account — reply to the original's sender explicitly instead",
          );
        }
      }

      if (!to || to.length === 0) {
        return invalid(
          "to is required — pass recipient addresses, or set replyAll with replyToUid to derive them",
        );
      }

      // Saving a draft is reversible; actually putting mail on the wire is not.
      if (!saveToDrafts) {
        const recipients = [...to, ...(cc ?? []), ...(bcc ?? [])].join(", ");
        const gate = confirmDestructive(
          ctx,
          "confirm_send_email",
          `Send this email to ${recipients}${args.subject ? ` with subject "${args.subject}"` : ""}? This cannot be undone.`,
        );
        if (gate.status === "interrupt") return gate.result;
      }

      return run(async () => {
        let subject = args.subject;

        // Threading, from the original already fetched above.
        let inReplyTo: string | undefined;
        let references: string[] | undefined;
        if (original) {
          inReplyTo = original.messageId;
          references = [...(original.references || [])];
          if (original.messageId && !references.includes(original.messageId)) {
            references.push(original.messageId);
          }
          if (!subject) {
            const origSubject = original.subject || "";
            subject = origSubject.startsWith("Re:") ? origSubject : `Re: ${origSubject}`;
          }
        }

        // Compose RFC 822 message
        const from = smtp.formatFromHeader(smtp.resolveFromAddress(args.from), args.fromName);

        const messageOptions = {
          from,
          to,
          cc,
          bcc,
          subject: subject as string,
          text: args.text,
          html: args.html,
          attachments: args.attachments === undefined ? undefined : attachments,
          inReplyTo,
          references,
        };

        if (saveToDrafts) {
          // Draft mode: keep Bcc in the saved message so a later send_draft
          // can still deliver to it — the header is stripped at send time.
          const rawMessage = await smtp.composeRawMessage(messageOptions, { keepBcc: true });
          // APPEND to Drafts folder
          const draftsFolder = await imap.getSpecialUseFolder("\\Drafts");
          const appendResult = await imap.appendMessage(draftsFolder, rawMessage, [
            "\\Draft",
            "\\Seen",
          ]);
          return structured({
            status: "draft" as const,
            uid: appendResult.uid,
            folder: draftsFolder,
          });
        }

        // Send mode: SMTP send + APPEND to Sent (Bcc stripped per RFC 2822 default)
        const rawMessage = await smtp.composeRawMessage(messageOptions);
        const envelope = {
          from: smtp.config.smtp.user,
          to: [...to, ...(cc || []), ...(bcc || [])],
        };
        const sendResult = await smtp.sendRawMessage(rawMessage, envelope);

        let sentFolderPath = "Sent";
        if (!smtp.config.autoSent) {
          try {
            sentFolderPath = await imap.getSpecialUseFolder("\\Sent");
            await imap.appendMessage(sentFolderPath, rawMessage, ["\\Seen"]);
          } catch (appendError) {
            console.error("[email-mcp] Failed to copy to Sent folder:", appendError);
          }
        }

        return structured({
          status: "sent" as const,
          messageId: sendResult.messageId,
          folder: sentFolderPath,
        });
      });
    },
  },
  {
    name: "move_email",
    title: "Move Email",
    description: "Move one or more emails to a different IMAP folder.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Source IMAP folder. Defaults to INBOX." },
        uids: UIDS_PROP("UIDs of emails to move."),
        destination: { type: "string", description: "Destination folder path." },
      },
      required: ["uids", "destination"],
    },
    outputSchema: moveResultSchema,
    handler: (args: { folder?: string; uids: number[]; destination: string }, { imap }) =>
      run(async () => {
        if (!Array.isArray(args.uids) || args.uids.length === 0) {
          return invalid("uids must be a non-empty array of message UIDs");
        }
        await imap.moveEmails(args.folder || "INBOX", args.uids, args.destination);
        return structured({
          status: "moved" as const,
          uids: args.uids,
          destination: args.destination,
        });
      }),
  },
  {
    name: "copy_email",
    title: "Copy Email",
    description:
      "Copy one or more emails into another IMAP folder, leaving the originals where they are. Use move_email to relocate them instead. When the server supports UIDPLUS, the result pairs each source UID with the UID its copy took in the destination; otherwise only the source UIDs come back, and the copy still happened.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      // Not idempotent: a second call adds a second copy rather than doing
      // nothing, since each COPY allocates a fresh UID in the destination.
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Source IMAP folder. Defaults to INBOX." },
        uids: UIDS_PROP("UIDs of emails to copy. They remain in the source folder."),
        destination: {
          type: "string",
          description:
            "Destination folder path. It must already exist — create_folder first if not.",
        },
      },
      required: ["uids", "destination"],
    },
    outputSchema: copyResultSchema,
    handler: (args: { folder?: string; uids: number[]; destination: string }, { imap }) =>
      run(async () => {
        if (!Array.isArray(args.uids) || args.uids.length === 0) {
          return invalid("uids must be a non-empty array of message UIDs");
        }
        const folder = args.folder || "INBOX";
        // A self-copy is legal IMAP and duplicates every message in place,
        // which is never what a caller reaching for "copy to a folder" wants.
        if (folder === args.destination) {
          return invalid(
            `destination is the source folder (${folder}) — this would duplicate the messages in place`,
          );
        }
        const copied = await imap.copyEmails(folder, args.uids, args.destination);
        return structured({
          status: "copied" as const,
          uids: args.uids,
          destination: args.destination,
          ...(copied ? { copied } : {}),
        });
      }),
  },
  {
    name: "mark_email",
    title: "Mark Email",
    description:
      'Set or unset flags on one or more emails. Common flags: "\\Seen" (read), "\\Flagged" (starred).',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        folder: FOLDER_PROP,
        uids: UIDS_PROP("UIDs of emails to modify."),
        flags: {
          type: "array",
          items: { type: "string" },
          description: 'Flags to set/unset (e.g., "\\Seen", "\\Flagged").',
        },
        action: {
          type: "string",
          enum: ["add", "remove"],
          description: 'Whether to add or remove the flags. Defaults to "add".',
        },
      },
      required: ["uids", "flags"],
    },
    outputSchema: markResultSchema,
    handler: (
      args: { folder?: string; uids: number[]; flags: string[]; action?: "add" | "remove" },
      { imap },
    ) =>
      run(async () => {
        if (!Array.isArray(args.uids) || args.uids.length === 0) {
          return invalid("uids must be a non-empty array of message UIDs");
        }
        const action = args.action || "add";
        await imap.markEmails(args.folder || "INBOX", args.uids, args.flags, action);
        return structured({
          status: "updated" as const,
          uids: args.uids,
          flags: args.flags,
          action,
        });
      }),
  },
  {
    name: "delete_email",
    title: "Delete Email",
    description:
      "Delete one or more emails. Moves to Trash by default, or permanently deletes if specified. A permanent delete asks the user to confirm first.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        folder: FOLDER_PROP,
        uids: UIDS_PROP("UIDs of emails to delete."),
        permanent: {
          type: "boolean",
          description: "If true, permanently delete instead of moving to Trash. Defaults to false.",
        },
      },
      required: ["uids"],
    },
    outputSchema: deleteResultSchema,
    handler: async (
      args: { folder?: string; uids: number[]; permanent?: boolean },
      { imap },
      ctx,
    ) => {
      if (!Array.isArray(args.uids) || args.uids.length === 0) {
        return invalid("uids must be a non-empty array of message UIDs");
      }
      const permanent = args.permanent || false;

      // A Trash move is recoverable; an expunge is not.
      if (permanent) {
        const gate = confirmDestructive(
          ctx,
          "confirm_delete_email",
          `Permanently delete ${args.uids.length} email(s) from ${args.folder || "INBOX"}? They cannot be recovered.`,
        );
        if (gate.status === "interrupt") return gate.result;
      }

      return run(async () => {
        await imap.deleteEmails(args.folder || "INBOX", args.uids, permanent);
        return structured({
          status: permanent ? ("permanently_deleted" as const) : ("moved_to_trash" as const),
          uids: args.uids,
        });
      });
    },
  },
  {
    name: "list_folders",
    title: "List Folders",
    description:
      "List all IMAP folders with their paths and special-use flags (Inbox, Sent, Trash, etc.).",
    annotations: READ_ONLY,
    inputSchema: { type: "object", properties: {} },
    outputSchema: folderListSchema,
    handler: (_args: Record<string, never>, { imap }) =>
      run(async () => structured({ folders: await imap.listFolders() })),
  },
  {
    name: "create_folder",
    title: "Create Folder",
    description: "Create a new IMAP folder.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Folder path to create (e.g., 'Projects/Work')." },
      },
      required: ["path"],
    },
    outputSchema: createFolderResultSchema,
    handler: (args: { path: string }, { imap }) =>
      run(async () => {
        await imap.createFolder(args.path);
        return structured({ status: "created" as const, path: args.path });
      }),
  },
  {
    name: "rename_folder",
    title: "Rename Folder",
    description:
      "Rename an IMAP folder, or move it in the hierarchy by giving a newPath under a different parent. Child folders move with it. Renaming INBOX is special-cased by IMAP: the server moves INBOX's messages into the new folder and leaves an empty INBOX behind, and INBOX's children do not follow. The server may normalise the path it reports back, so use the returned newPath rather than assuming the requested one.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      // Not idempotent: the second call finds nothing at the old path and fails.
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Existing folder path to rename (e.g., 'Projects/Work').",
        },
        newPath: {
          type: "string",
          description:
            "New folder path. A path under a different parent moves the folder there, creating the parent only if the server does so implicitly — call create_folder first if it does not.",
        },
      },
      required: ["path", "newPath"],
    },
    outputSchema: renameFolderResultSchema,
    handler: (args: { path: string; newPath: string }, { imap }) =>
      run(async () => {
        // Checked before connecting: a blank path is a RENAME the server would
        // answer with a protocol error naming neither argument, and IMAP has no
        // way to express "rename to nothing".
        const path = typeof args.path === "string" ? args.path.trim() : "";
        const newPath = typeof args.newPath === "string" ? args.newPath.trim() : "";
        if (!path) return invalid("path must be a non-empty folder path");
        if (!newPath) return invalid("newPath must be a non-empty folder path");
        if (path === newPath) {
          return invalid(`newPath is already the folder's path: ${path}`);
        }
        const renamed = await imap.renameFolder(path, newPath);
        return structured({ status: "renamed" as const, ...renamed });
      }),
  },
  {
    name: "delete_folder",
    title: "Delete Folder",
    description:
      "Delete an IMAP folder and every message in it. This is irreversible — the messages are not moved to Trash — so the tool asks the user to confirm first, naming the folder and how many messages it holds. INBOX cannot be deleted. Whether a folder with sub-folders can be deleted is up to the server; many refuse, so delete or move the children first.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      // A second call finds nothing to delete and fails, but the account ends
      // up in the same state either way.
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Folder path to delete (e.g., 'Projects/Work')." },
      },
      required: ["path"],
    },
    outputSchema: deleteFolderResultSchema,
    handler: async (args: { path: string }, { imap }, ctx) => {
      const path = typeof args.path === "string" ? args.path.trim() : "";
      if (!path) return invalid("path must be a non-empty folder path");
      // RFC 3501 §6.3.4 makes deleting INBOX an error, and a server's reply to
      // it is a bare NO. Rejecting here spends no confirmation on a request
      // that was never going to succeed.
      if (path.toUpperCase() === "INBOX") {
        return invalid("INBOX cannot be deleted — IMAP reserves it");
      }

      // STATUS before the gate so the prompt says what is actually at stake:
      // "delete Projects/Work" and "delete Projects/Work and its 412 messages"
      // are different decisions. A folder the server will not count is still
      // worth confirming, so a failure here is not fatal — the delete itself
      // raises the real error.
      let messages: number | undefined;
      try {
        messages = (await imap.getFolderStatus(path)).total;
      } catch {
        messages = undefined;
      }

      const gate = confirmDestructive(
        ctx,
        "confirm_delete_folder",
        `Delete the folder ${path}${
          messages === undefined ? "" : ` and the ${messages} message(s) in it`
        }? This cannot be undone — the messages do not go to Trash.`,
      );
      if (gate.status === "interrupt") return gate.result;

      return run(async () => {
        await imap.deleteFolder(path);
        return structured({
          status: "deleted" as const,
          path,
          ...(messages === undefined ? {} : { messages }),
        });
      });
    },
  },
  {
    name: "download_attachment",
    title: "Download Attachment",
    description:
      "Download a specific attachment from an email. Returns the bytes as an embedded binary resource; structured output carries the filename, content type and size.",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        folder: FOLDER_PROP,
        uid: { type: "number", description: "UID of the email containing the attachment." },
        partId: {
          type: "string",
          description: "MIME part ID of the attachment (from get_email attachment metadata).",
        },
      },
      required: ["uid", "partId"],
    },
    outputSchema: attachmentSchema,
    handler: (args: { folder?: string; uid: number; partId: string }, { imap }) =>
      run(async () => {
        const folder = args.folder || "INBOX";
        const limit = maxInlineBytes();
        const attachment = await imap.downloadAttachment(folder, args.uid, args.partId, limit);
        const uri = attachmentUri(folder, args.uid, args.partId);
        const structuredContent = {
          filename: attachment.filename,
          contentType: attachment.contentType,
          size: attachment.size,
          uri,
          embedded: !attachment.oversized,
        };

        if (attachment.oversized) {
          // A link, not the bytes: base64 for a payload this size would be a
          // third larger again, and most clients put a tool result straight
          // into the model's context. The bytes stay one resources/read away.
          return {
            content: [
              {
                type: "text",
                text:
                  `${attachment.filename} is ${formatBytes(attachment.size)}, over the ` +
                  `${formatBytes(limit)} inline limit, so it was not embedded. Fetch the bytes ` +
                  `with resources/read on ${uri}, or raise EMAIL_MAX_INLINE_BYTES.`,
              },
              {
                type: "resource_link",
                uri,
                name: attachment.filename,
                mimeType: attachment.contentType,
                size: attachment.size,
              },
            ],
            structuredContent,
          };
        }

        return {
          // The bytes ride in the resource block only — repeating the base64 in
          // structuredContent would double the response. Same reasoning as
          // get_email_raw below.
          content: [
            {
              type: "resource",
              resource: {
                uri,
                mimeType: attachment.contentType,
                blob: attachment.content.toString("base64"),
              },
            },
          ],
          structuredContent,
        };
      }),
  },
  {
    name: "get_email_raw",
    title: "Get Raw Email",
    description:
      "Export an email as raw .eml (RFC 822 source). Useful for archival or forwarding. The source is returned as an embedded message/rfc822 resource.",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        folder: FOLDER_PROP,
        uid: { type: "number", description: "UID of the email to export." },
      },
      required: ["uid"],
    },
    outputSchema: rawEmailSchema,
    handler: (args: { folder?: string; uid: number }, { imap }) =>
      run(async () => {
        const folder = args.folder || "INBOX";
        const limit = maxInlineBytes();
        const raw = await imap.fetchRawEmail(folder, args.uid, limit);
        const uri = rawEmailUri(folder, args.uid);
        // `oversized` is the union's discriminant, so the branch below and the
        // flag here cannot disagree about what the caller was handed.
        const structuredContent = {
          uid: args.uid,
          folder,
          size: raw.size,
          uri,
          embedded: !raw.oversized,
        };

        if (raw.oversized) {
          return {
            content: [
              {
                type: "text",
                text:
                  `The source of UID ${args.uid} is ${formatBytes(raw.size)}, over the ` +
                  `${formatBytes(limit)} inline limit, so it was not embedded. Fetch it with ` +
                  `resources/read on ${uri}, or raise EMAIL_MAX_INLINE_BYTES.`,
              },
              {
                type: "resource_link",
                uri,
                name: `${args.uid}.eml`,
                mimeType: "message/rfc822",
                size: raw.size,
              },
            ],
            structuredContent,
          };
        }

        return {
          // The source rides in the resource block rather than being repeated
          // in both `content` and `structuredContent` — .eml payloads are large.
          content: [
            {
              type: "resource",
              resource: { uri, mimeType: "message/rfc822", text: raw.source },
            },
          ],
          structuredContent,
        };
      }),
  },
  {
    name: "get_folder_status",
    title: "Get Folder Status",
    description:
      "Get total and unread message counts for a folder via IMAP STATUS (single round-trip, no payload).",
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "IMAP folder path. Defaults to INBOX." },
      },
    },
    outputSchema: folderStatusSchema,
    handler: (args: { folder?: string }, { imap }) =>
      run(async () => structured(await imap.getFolderStatus(args.folder || "INBOX"))),
  },
  {
    name: "send_draft",
    title: "Send Draft",
    description:
      "Send an existing email draft from the Drafts folder. Fetches the draft's raw RFC 822 source, sends it via SMTP, copies it to the Sent folder, and removes it from Drafts. Asks the user to confirm before sending. The draft must already exist — use send_email with saveToDrafts: true to create one.",
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "number", description: "UID of the draft email in the Drafts folder." },
        folder: {
          type: "string",
          description: "IMAP folder containing the draft. Defaults to the server's Drafts folder.",
        },
      },
      required: ["uid"],
    },
    outputSchema: sendResultSchema,
    handler: async (args: { uid: number; folder?: string }, { imap, smtp }, ctx) => {
      const gate = confirmDestructive(
        ctx,
        "confirm_send_draft",
        `Send draft ${args.uid}? Once sent it cannot be recalled.`,
      );
      if (gate.status === "interrupt") return gate.result;

      return run(async () => {
        const draftFolder = args.folder || (await imap.getSpecialUseFolder("\\Drafts"));

        // Fetch raw source
        const rawSource = await imap.fetchRawSource(draftFolder, args.uid);

        // Parse headers for SMTP envelope
        const parsed = await simpleParser(rawSource);
        const toAddrs = (Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : [])
          .flatMap((addr) => addr.value)
          .map((a) => a.address)
          .filter((a): a is string => !!a);
        const ccAddrs = (Array.isArray(parsed.cc) ? parsed.cc : parsed.cc ? [parsed.cc] : [])
          .flatMap((addr) => addr.value)
          .map((a) => a.address)
          .filter((a): a is string => !!a);
        const bccAddrs = (Array.isArray(parsed.bcc) ? parsed.bcc : parsed.bcc ? [parsed.bcc] : [])
          .flatMap((addr) => addr.value)
          .map((a) => a.address)
          .filter((a): a is string => !!a);

        const allRecipients = [...toAddrs, ...ccAddrs, ...bccAddrs];
        if (allRecipients.length === 0) {
          return invalid("Draft has no recipients — cannot send");
        }

        // Send via SMTP. The envelope still carries bccAddrs (via
        // allRecipients) so the MTA delivers to them, but the Bcc header
        // itself must not go out on the wire — strip it from the
        // transmitted copy while keeping rawSource intact for the Sent
        // folder append below (so the sender keeps a record of who was bcc'd).
        const envelope = {
          from: smtp.config.smtp.user,
          to: allRecipients,
        };
        const sendResult = await smtp.sendRawMessage(stripBccHeader(rawSource), envelope);

        // Copy to Sent
        let sentFolderPath = "Sent";
        if (!smtp.config.autoSent) {
          try {
            sentFolderPath = await imap.getSpecialUseFolder("\\Sent");
            await imap.appendMessage(sentFolderPath, rawSource, ["\\Seen"]);
          } catch (appendError) {
            console.error("[email-mcp] Failed to copy to Sent folder:", appendError);
          }
        }

        // Delete draft (permanently — not move to Trash)
        await imap.deleteEmails(draftFolder, [args.uid], true);

        return structured({
          status: "sent" as const,
          messageId: sendResult.messageId,
          folder: sentFolderPath,
        });
      });
    },
  },
];

function stripBccHeader(raw: Buffer): Buffer {
  const str = raw.toString("latin1");
  const sep = str.indexOf("\r\n\r\n");
  if (sep === -1) return raw;
  const headers = str.slice(0, sep + 2).replace(/^bcc:[^\r\n]*(?:\r\n[ \t][^\r\n]*)*\r\n/gim, "");
  return Buffer.from(headers + str.slice(sep + 2), "latin1");
}
