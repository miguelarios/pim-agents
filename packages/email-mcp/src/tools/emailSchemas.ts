/**
 * Valibot output schemas for the email tools. These drive the `outputSchema`
 * advertised in `tools/list` and validate `structuredContent` before it leaves
 * the server.
 *
 * They mirror `EmailSummary`, `EmailFull`, `FolderInfo` and `AttachmentData`
 * from `../services/ImapService.js`.
 */
import * as v from "valibot";

const address = v.object({
  name: v.optional(v.string()),
  address: v.string(),
});

export const emailSummarySchema = v.object({
  uid: v.number(),
  messageId: v.string(),
  subject: v.string(),
  from: address,
  to: v.array(address),
  date: v.string(),
  flags: v.array(v.string()),
  hasAttachments: v.boolean(),
});

/** `get_email` drops whichever body fields the requested `format` excludes. */
export const emailFullSchema = v.object({
  ...emailSummarySchema.entries,
  cc: v.optional(v.array(address)),
  inReplyTo: v.nullable(v.string()),
  references: v.array(v.string()),
  textBody: v.optional(v.string()),
  htmlBody: v.optional(v.string()),
  markdownBody: v.optional(v.string()),
  attachments: v.array(
    v.object({
      filename: v.string(),
      contentType: v.string(),
      size: v.number(),
      partId: v.string(),
    }),
  ),
});

export const searchResultSchema = v.object({
  emails: v.array(emailSummarySchema),
  count: v.number(),
});

export const folderListSchema = v.object({
  folders: v.array(
    v.object({
      path: v.string(),
      specialUse: v.optional(v.string()),
      delimiter: v.string(),
    }),
  ),
});

export const folderStatusSchema = v.object({
  total: v.number(),
  unseen: v.number(),
});

export const sendResultSchema = v.variant("status", [
  v.object({
    status: v.literal("sent"),
    messageId: v.string(),
    folder: v.string(),
  }),
  v.object({
    status: v.literal("draft"),
    uid: v.number(),
    folder: v.string(),
  }),
]);

export const moveResultSchema = v.object({
  status: v.literal("moved"),
  uids: v.array(v.number()),
  destination: v.string(),
});

export const markResultSchema = v.object({
  status: v.literal("updated"),
  uids: v.array(v.number()),
  flags: v.array(v.string()),
  action: v.picklist(["add", "remove"]),
});

export const deleteResultSchema = v.object({
  status: v.picklist(["permanently_deleted", "moved_to_trash"]),
  uids: v.array(v.number()),
});

export const createFolderResultSchema = v.object({
  status: v.literal("created"),
  path: v.string(),
});

export const attachmentSchema = v.object({
  filename: v.string(),
  contentType: v.string(),
  size: v.number(),
  /** Base64 payload, also returned as an embedded resource in `content`. */
  content: v.string(),
});

/**
 * Metadata only — the RFC 822 source itself rides in the result's embedded
 * resource block, so a multi-megabyte .eml is not duplicated in the payload.
 */
export const rawEmailSchema = v.object({
  uid: v.number(),
  folder: v.string(),
  size: v.number(),
});
