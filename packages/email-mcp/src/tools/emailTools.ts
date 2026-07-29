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
import type { SearchParams } from "../search.js";
import type { ImapService } from "../services/ImapService.js";
import type { SmtpService } from "../services/SmtpService.js";
import {
  attachmentSchema,
  createFolderResultSchema,
  deleteResultSchema,
  emailFullSchema,
  folderListSchema,
  folderStatusSchema,
  markResultSchema,
  moveResultSchema,
  rawEmailSchema,
  searchResultSchema,
  sendResultSchema,
} from "./emailSchemas.js";

/** Both backing services, passed to every handler as one unit. */
export interface EmailServices {
  imap: ImapService;
  smtp: SmtpService;
}

type Attachment = { filename: string; path?: string; content?: string };

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
      "Search and list emails in a folder. Returns email summaries with configurable sorting (default: date descending). All filters combine with AND logic. Use the dedicated fields (subject, from, to, etc.) for most searches. Note: for result sets >1000, non-date sort fields are approximate (sorted within page only).",
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
        unread: { type: "boolean", description: "Filter by unread status." },
        flagged: { type: "boolean", description: "Filter by flagged/starred status." },
        hasAttachment: { type: "boolean", description: "Filter for emails with attachments." },
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
      "Fetch a full email by UID including headers, body, and attachment metadata. Returns body as markdown by default for token efficiency. Use format='html' or format='text' for raw content.",
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
          description: "Recipient email addresses.",
        },
        cc: { type: "array", items: { type: "string" }, description: "CC email addresses." },
        bcc: { type: "array", items: { type: "string" }, description: "BCC email addresses." },
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
              content: { type: "string", description: "String content to attach." },
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
      required: ["to"],
    },
    outputSchema: sendResultSchema,
    handler: async (
      args: {
        to: string[] | string;
        cc?: string[] | string;
        bcc?: string[] | string;
        subject?: string;
        text?: string;
        html?: string;
        attachments?: Attachment[];
        replyToUid?: number;
        replyToFolder?: string;
        saveToDrafts?: boolean;
        from?: string;
        fromName?: string;
      },
      { imap, smtp },
      ctx,
    ) => {
      const to = Array.isArray(args.to) ? args.to : [args.to];
      const cc = args.cc == null ? undefined : Array.isArray(args.cc) ? args.cc : [args.cc];
      const bcc = args.bcc == null ? undefined : Array.isArray(args.bcc) ? args.bcc : [args.bcc];
      const saveToDrafts = args.saveToDrafts || false;

      // Validation: subject required when not replying
      if (!args.subject && !args.replyToUid) {
        return invalid("subject is required when not replying to an existing email");
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
        for (const att of args.attachments ?? []) {
          if (att.path) assertAttachmentPathAllowed(att.path);
        }
        const replyToFolder = args.replyToFolder || "INBOX";
        let subject = args.subject;

        // Threading: fetch original email for reply context
        let inReplyTo: string | undefined;
        let references: string[] | undefined;
        if (args.replyToUid) {
          const original = await imap.fetchEmail(replyToFolder, args.replyToUid);
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
          attachments: args.attachments,
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
        const attachment = await imap.downloadAttachment(folder, args.uid, args.partId);
        return {
          // The bytes ride in the resource block only — repeating the base64 in
          // structuredContent would double the response for large attachments.
          // Same reasoning as get_email_raw below.
          content: [
            {
              type: "resource",
              resource: {
                uri: `imap://${encodeURIComponent(folder)}/${args.uid}/${encodeURIComponent(args.partId)}`,
                mimeType: attachment.contentType,
                blob: attachment.content.toString("base64"),
              },
            },
          ],
          structuredContent: {
            filename: attachment.filename,
            contentType: attachment.contentType,
            size: attachment.size,
          },
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
        const raw = await imap.fetchRawEmail(folder, args.uid);
        return {
          // The source rides in the resource block rather than being repeated
          // in both `content` and `structuredContent` — .eml payloads are large.
          content: [
            {
              type: "resource",
              resource: {
                uri: `imap://${encodeURIComponent(folder)}/${args.uid}.eml`,
                mimeType: "message/rfc822",
                text: raw,
              },
            },
          ],
          structuredContent: { uid: args.uid, folder, size: raw.length },
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
