import { toPimError } from "@miguelarios/pim-core";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { parseSearchQuery } from "../search.js";
import type { ImapService } from "../services/ImapService.js";
import type { SmtpService } from "../services/SmtpService.js";

export const EMAIL_TOOLS: Tool[] = [
  {
    name: "list_emails",
    description:
      "Search and list emails in a folder. Supports structured query prefixes: from:, to:, subject:, is:unread/read/flagged, has:attachment, since:YYYY-MM-DD, before:YYYY-MM-DD. Plain text searches subject and body. Returns email summaries with UID, subject, sender, date, and flags.",
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "IMAP folder to search. Defaults to INBOX.",
        },
        query: {
          type: "string",
          description:
            'Search query with optional prefixes. Examples: "from:boss@work.com is:unread", "subject:meeting", "has:attachment". Plain text searches body.',
        },
        limit: {
          type: "number",
          description: "Max results to return. Defaults to 20.",
        },
        offset: {
          type: "number",
          description: "Number of results to skip for pagination. Defaults to 0.",
        },
      },
    },
  },
  {
    name: "get_email",
    description:
      "Fetch a full email by UID including headers, text/HTML body, and attachment metadata.",
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "IMAP folder containing the email. Defaults to INBOX.",
        },
        uid: {
          type: "number",
          description: "The UID of the email to fetch.",
        },
      },
      required: ["uid"],
    },
  },
  {
    name: "send_email",
    description:
      "Compose and send an email via SMTP. Supports to/cc/bcc, text and HTML body, and file attachments.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "array",
          items: { type: "string" },
          description: "Recipient email addresses.",
        },
        cc: {
          type: "array",
          items: { type: "string" },
          description: "CC email addresses.",
        },
        bcc: {
          type: "array",
          items: { type: "string" },
          description: "BCC email addresses.",
        },
        subject: {
          type: "string",
          description: "Email subject line.",
        },
        text: {
          type: "string",
          description: "Plain text body.",
        },
        html: {
          type: "string",
          description: "HTML body.",
        },
        attachments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              filename: { type: "string" },
              path: {
                type: "string",
                description: "File path to attach.",
              },
              content: {
                type: "string",
                description: "String content to attach.",
              },
            },
            required: ["filename"],
          },
          description: "File attachments.",
        },
      },
      required: ["to", "subject"],
    },
  },
  {
    name: "move_email",
    description: "Move one or more emails to a different IMAP folder.",
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "Source IMAP folder. Defaults to INBOX.",
        },
        uids: {
          type: "array",
          items: { type: "number" },
          description: "UIDs of emails to move.",
        },
        destination: {
          type: "string",
          description: "Destination folder path.",
        },
      },
      required: ["uids", "destination"],
    },
  },
  {
    name: "mark_email",
    description:
      'Set or unset flags on one or more emails. Common flags: "\\Seen" (read), "\\Flagged" (starred).',
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "IMAP folder. Defaults to INBOX.",
        },
        uids: {
          type: "array",
          items: { type: "number" },
          description: "UIDs of emails to modify.",
        },
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
  },
  {
    name: "delete_email",
    description:
      "Delete one or more emails. Moves to Trash by default, or permanently deletes if specified.",
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "IMAP folder. Defaults to INBOX.",
        },
        uids: {
          type: "array",
          items: { type: "number" },
          description: "UIDs of emails to delete.",
        },
        permanent: {
          type: "boolean",
          description: "If true, permanently delete instead of moving to Trash. Defaults to false.",
        },
      },
      required: ["uids"],
    },
  },
  {
    name: "list_folders",
    description:
      "List all IMAP folders with their paths and special-use flags (Inbox, Sent, Trash, etc.).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "create_folder",
    description: "Create a new IMAP folder.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Folder path to create (e.g., 'Projects/Work').",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "download_attachment",
    description:
      "Download a specific attachment from an email. Returns the attachment content as base64.",
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "IMAP folder. Defaults to INBOX.",
        },
        uid: {
          type: "number",
          description: "UID of the email containing the attachment.",
        },
        partId: {
          type: "string",
          description: "MIME part ID of the attachment (from get_email attachment metadata).",
        },
      },
      required: ["uid", "partId"],
    },
  },
  {
    name: "get_email_raw",
    description: "Export an email as raw .eml (RFC 822 source). Useful for archival or forwarding.",
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "IMAP folder. Defaults to INBOX.",
        },
        uid: {
          type: "number",
          description: "UID of the email to export.",
        },
      },
      required: ["uid"],
    },
  },
];

export async function handleEmailTool(
  name: string,
  args: Record<string, unknown>,
  imapService: ImapService,
  smtpService: SmtpService,
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}> {
  try {
    const folder = (args.folder as string) || "INBOX";

    switch (name) {
      case "list_emails": {
        const query = args.query ? parseSearchQuery(args.query as string) : {};
        const limit = (args.limit as number) || 20;
        const offset = (args.offset as number) || 0;
        const emails = await imapService.searchEmails(folder, query, {
          limit,
          offset,
        });
        return ok(JSON.stringify(emails, null, 2));
      }

      case "get_email": {
        const uid = args.uid as number;
        const email = await imapService.fetchEmail(folder, uid);
        return ok(JSON.stringify(email, null, 2));
      }

      case "send_email": {
        const result = await smtpService.sendEmail({
          to: args.to as string[],
          cc: args.cc as string[] | undefined,
          bcc: args.bcc as string[] | undefined,
          subject: args.subject as string,
          text: args.text as string | undefined,
          html: args.html as string | undefined,
          attachments: args.attachments as any[] | undefined,
        });
        return ok(JSON.stringify({ status: "sent", ...result }));
      }

      case "move_email": {
        const uids = args.uids as number[];
        const destination = args.destination as string;
        await imapService.moveEmails(folder, uids, destination);
        return ok(JSON.stringify({ status: "moved", uids, destination }));
      }

      case "mark_email": {
        const uids = args.uids as number[];
        const flags = args.flags as string[];
        const action = (args.action as "add" | "remove") || "add";
        await imapService.markEmails(folder, uids, flags, action);
        return ok(JSON.stringify({ status: "updated", uids, flags, action }));
      }

      case "delete_email": {
        const uids = args.uids as number[];
        const permanent = (args.permanent as boolean) || false;
        await imapService.deleteEmails(folder, uids, permanent);
        return ok(
          JSON.stringify({
            status: permanent ? "permanently_deleted" : "moved_to_trash",
            uids,
          }),
        );
      }

      case "list_folders": {
        const folders = await imapService.listFolders();
        return ok(JSON.stringify(folders, null, 2));
      }

      case "create_folder": {
        const path = args.path as string;
        await imapService.createFolder(path);
        return ok(JSON.stringify({ status: "created", path }));
      }

      case "download_attachment": {
        const uid = args.uid as number;
        const partId = args.partId as string;
        const attachment = await imapService.downloadAttachment(folder, uid, partId);
        return ok(
          JSON.stringify({
            filename: attachment.filename,
            contentType: attachment.contentType,
            size: attachment.size,
            content: attachment.content.toString("base64"),
          }),
        );
      }

      case "get_email_raw": {
        const uid = args.uid as number;
        const raw = await imapService.fetchRawEmail(folder, uid);
        return ok(raw);
      }

      default:
        return error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const pimError = toPimError(err instanceof Error ? err : new Error(String(err)));
    return error(`${pimError.message}${pimError.isRetryable ? " (retryable)" : ""}`);
  }
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function error(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
