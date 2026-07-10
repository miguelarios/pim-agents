import {
  type EmailConfig,
  EmailError,
  ErrorCode,
  formatInTimezone,
  getTimezone,
  toPimError,
} from "@miguelarios/pim-core";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { type SearchParams, buildSearchCriteria } from "../search.js";

export interface EmailSummary {
  uid: number;
  messageId: string;
  subject: string;
  from: { name?: string; address: string };
  to: Array<{ name?: string; address: string }>;
  date: string;
  flags: string[];
  hasAttachments: boolean;
}

export interface EmailFull extends EmailSummary {
  cc?: Array<{ name?: string; address: string }>;
  inReplyTo: string | null;
  references: string[];
  textBody?: string;
  htmlBody?: string;
  markdownBody?: string;
  attachments: Array<{
    filename: string;
    contentType: string;
    size: number;
    partId: string;
  }>;
}

export interface FolderInfo {
  path: string;
  specialUse?: string;
  delimiter: string;
}

export interface AttachmentData {
  filename: string;
  contentType: string;
  size: number;
  content: Buffer;
}

export interface SearchOptions {
  limit?: number;
  offset?: number;
  sortBy?: "date" | "from" | "subject";
  sortOrder?: "asc" | "desc";
}

export class ImapService {
  private config: EmailConfig;
  private timezone: string;

  constructor(config: EmailConfig) {
    this.config = config;
    this.timezone = getTimezone();
  }

  private createClient(): ImapFlow {
    return new ImapFlow({
      host: this.config.imap.host,
      port: this.config.imap.port,
      secure: this.config.imap.secure,
      auth: {
        user: this.config.imap.user,
        pass: this.config.imap.pass,
      },
      logger: false,
    });
  }

  async listFolders(): Promise<FolderInfo[]> {
    const client = this.createClient();
    try {
      await client.connect();
      const mailboxes = await client.list();
      return mailboxes.map((mb) => ({
        path: mb.path,
        specialUse: mb.specialUse || undefined,
        delimiter: mb.delimiter,
      }));
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async searchEmails(
    folder: string,
    params: SearchParams = {},
    options: SearchOptions = {},
  ): Promise<EmailSummary[]> {
    const client = this.createClient();
    const criteria = buildSearchCriteria(params);
    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);
      try {
        // imapflow's search() accepts a single SearchObject, not an array.
        // When buildSearchCriteria returns an array (duplicate keys like
        // multiple subject tokens), run each search separately and intersect.
        let uids: number[];
        if (Array.isArray(criteria)) {
          const uidSets = await Promise.all(
            criteria.map((c) => client.search(c as any, { uid: true })),
          );
          const firstSet = new Set(uidSets[0] || []);
          for (let i = 1; i < uidSets.length; i++) {
            const nextSet = new Set(uidSets[i] || []);
            for (const uid of firstSet) {
              if (!nextSet.has(uid)) firstSet.delete(uid);
            }
          }
          uids = [...firstSet];
        } else {
          const searchResult = await client.search(criteria as any, { uid: true });
          uids = searchResult || [];
        }

        if (uids.length === 0) return [];

        const offset = options.offset ?? 0;
        const limit = options.limit ?? 50;
        const sortBy = options.sortBy ?? "date";
        const sortOrder = options.sortOrder ?? "desc";

        if (uids.length <= 1000) {
          // Tier 1: fetch all envelopes, sort, paginate
          const allSummaries = await this.fetchSummaries(client, uids);
          allSummaries.sort((a, b) => compareSummaries(a, b, sortBy, sortOrder));
          return allSummaries.slice(offset, offset + limit);
        }
        // Tier 2: reverse UIDs (approximate newest-first), slice, fetch, sort page
        // Note: for non-date sortBy, sort is best-effort (within page only)
        uids.reverse();
        const fetchUids = uids.slice(offset, offset + limit);
        const summaries = await this.fetchSummaries(client, fetchUids);
        return summaries.sort((a, b) => compareSummaries(a, b, sortBy, sortOrder));
      } finally {
        lock.release();
      }
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await client.logout().catch(() => {});
    }
  }

  private async fetchSummaries(client: ImapFlow, uids: number[]): Promise<EmailSummary[]> {
    const summaries: EmailSummary[] = [];
    const uidRange = uids.join(",");

    for await (const msg of client.fetch(
      uidRange,
      {
        envelope: true,
        flags: true,
        bodyStructure: true,
        uid: true,
      },
      { uid: true },
    )) {
      const envelope = msg.envelope!;
      summaries.push({
        uid: msg.uid,
        messageId: envelope.messageId || "",
        subject: envelope.subject || "",
        from: envelope.from?.[0]
          ? {
              name: envelope.from[0].name,
              address: envelope.from[0].address || "",
            }
          : { address: "unknown" },
        to: (envelope.to || []).map((a: any) => ({
          name: a.name,
          address: a.address || "",
        })),
        date: envelope.date ? formatInTimezone(envelope.date.toISOString(), this.timezone) : "",
        flags: [...(msg.flags || [])],
        hasAttachments: hasAttachmentParts(msg.bodyStructure),
      });
    }
    return summaries;
  }

  async fetchEmail(folder: string, uid: number): Promise<EmailFull> {
    const client = this.createClient();
    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);
      try {
        const fetchResult = await client.fetchOne(
          String(uid),
          { source: true, bodyStructure: true, flags: true },
          { uid: true },
        );
        if (!fetchResult || !fetchResult.source) {
          throw new EmailError(`Email UID ${uid} not found`, ErrorCode.EMAIL_NOT_FOUND, uid);
        }

        const parsed = await simpleParser(fetchResult.source);
        const attachmentParts = collectAttachmentParts(fetchResult.bodyStructure);
        return {
          uid,
          messageId: parsed.messageId || "",
          inReplyTo: parsed.inReplyTo || null,
          references: parsed.references
            ? Array.isArray(parsed.references)
              ? parsed.references
              : [parsed.references]
            : [],
          subject: parsed.subject || "",
          from: parsed.from?.value?.[0]
            ? {
                name: parsed.from.value[0].name,
                address: parsed.from.value[0].address || "",
              }
            : { address: "unknown" },
          to: (Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : [])
            .flatMap((addr) => addr.value)
            .map((a: any) => ({ name: a.name, address: a.address || "" })),
          cc:
            (Array.isArray(parsed.cc) ? parsed.cc : parsed.cc ? [parsed.cc] : [])
              .flatMap((addr) => addr.value)
              .map((a: any) => ({ name: a.name, address: a.address || "" })) || undefined,
          date: parsed.date ? formatInTimezone(parsed.date.toISOString(), this.timezone) : "",
          flags: [...(fetchResult.flags ?? [])],
          hasAttachments: attachmentParts.length > 0,
          textBody: parsed.text || undefined,
          htmlBody: parsed.html || undefined,
          attachments: attachmentParts.map((att, index) => ({
            filename: att.filename || `attachment-${index}`,
            contentType: att.contentType,
            size: att.size,
            partId: att.part,
          })),
        };
      } finally {
        lock.release();
      }
    } catch (error) {
      if (error instanceof EmailError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async fetchRawEmail(folder: string, uid: number): Promise<string> {
    const client = this.createClient();
    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);
      try {
        const fetchResult = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!fetchResult || !fetchResult.source) {
          throw new EmailError(`Email UID ${uid} not found`, ErrorCode.EMAIL_NOT_FOUND, uid);
        }
        return fetchResult.source.toString();
      } finally {
        lock.release();
      }
    } catch (error) {
      if (error instanceof EmailError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async moveEmails(folder: string, uids: number[], destination: string): Promise<void> {
    const client = this.createClient();
    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);
      try {
        await client.messageMove(uids.join(","), destination, {
          uid: true,
        });
      } finally {
        lock.release();
      }
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async markEmails(
    folder: string,
    uids: number[],
    flags: string[],
    action: "add" | "remove",
  ): Promise<void> {
    const client = this.createClient();
    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);
      try {
        const uidRange = uids.join(",");
        if (action === "add") {
          await client.messageFlagsAdd(uidRange, flags, { uid: true });
        } else {
          await client.messageFlagsRemove(uidRange, flags, {
            uid: true,
          });
        }
      } finally {
        lock.release();
      }
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async deleteEmails(folder: string, uids: number[], permanent = false): Promise<void> {
    const client = this.createClient();
    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);
      try {
        const uidRange = uids.join(",");
        if (permanent) {
          await client.messageDelete(uidRange, { uid: true });
        } else {
          await client.messageMove(uidRange, "Trash", { uid: true });
        }
      } finally {
        lock.release();
      }
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async createFolder(path: string): Promise<void> {
    const client = this.createClient();
    try {
      await client.connect();
      await client.mailboxCreate(path);
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async downloadAttachment(folder: string, uid: number, partId: string): Promise<AttachmentData> {
    const client = this.createClient();
    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);
      try {
        const { meta, content } = await client.download(String(uid), partId, { uid: true });
        if (!content) {
          throw new EmailError(
            `Attachment ${partId} not found for email ${uid}`,
            ErrorCode.ATTACHMENT_NOT_FOUND,
            uid,
          );
        }

        const chunks: Buffer[] = [];
        for await (const chunk of content) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }

        return {
          filename: meta.filename || `attachment-${partId}`,
          contentType: meta.contentType || "application/octet-stream",
          size: meta.expectedSize || Buffer.concat(chunks).length,
          content: Buffer.concat(chunks),
        };
      } finally {
        lock.release();
      }
    } catch (error) {
      if (error instanceof EmailError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await client.logout().catch(() => {});
    }
  }

  private static FALLBACK_NAMES: Record<string, string[]> = {
    "\\Sent": ["Sent", "Sent Messages", "Sent Items", "INBOX.Sent"],
    "\\Drafts": ["Drafts", "Draft", "INBOX.Drafts"],
  };

  async getSpecialUseFolder(flag: string): Promise<string> {
    const client = this.createClient();
    try {
      await client.connect();
      const mailboxes = await client.list();

      // Try special-use flag first
      const byFlag = mailboxes.find((mb) => mb.specialUse === flag);
      if (byFlag) return byFlag.path;

      // Fallback to common names
      const fallbacks = ImapService.FALLBACK_NAMES[flag] || [];
      const paths = new Set(mailboxes.map((mb) => mb.path));
      for (const name of fallbacks) {
        if (paths.has(name)) return name;
      }

      throw new EmailError(
        `FOLDER_NOT_FOUND: No folder found for ${flag}`,
        ErrorCode.FOLDER_NOT_FOUND,
      );
    } catch (error) {
      if (error instanceof EmailError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async appendMessage(
    folder: string,
    rawSource: Buffer,
    flags: string[],
  ): Promise<{ uid: number }> {
    const client = this.createClient();
    try {
      await client.connect();
      const result = await (client as any).append(folder, rawSource, flags);
      // ImapFlow returns { uid } when UIDPLUS is supported, false otherwise
      return { uid: result && typeof result === "object" && "uid" in result ? result.uid : 0 };
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async fetchRawSource(folder: string, uid: number): Promise<Buffer> {
    const client = this.createClient();
    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);
      try {
        const fetchResult = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!fetchResult || !fetchResult.source) {
          throw new EmailError(`Email UID ${uid} not found`, ErrorCode.EMAIL_NOT_FOUND, uid);
        }
        return Buffer.isBuffer(fetchResult.source)
          ? fetchResult.source
          : Buffer.from(fetchResult.source);
      } finally {
        lock.release();
      }
    } catch (error) {
      if (error instanceof EmailError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async getFolderStatus(folder: string): Promise<{ total: number; unseen: number }> {
    const client = this.createClient();
    try {
      await client.connect();
      const status = await client.status(folder, { messages: true, unseen: true });
      return { total: status.messages ?? 0, unseen: status.unseen ?? 0 };
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await client.logout().catch(() => {});
    }
  }
}

function compareSummaries(
  a: EmailSummary,
  b: EmailSummary,
  sortBy: "date" | "from" | "subject",
  sortOrder: "asc" | "desc",
): number {
  const direction = sortOrder === "desc" ? -1 : 1;

  switch (sortBy) {
    case "from": {
      const aKey = a.from.name ?? a.from.address;
      const bKey = b.from.name ?? b.from.address;
      return direction * aKey.localeCompare(bKey, undefined, { sensitivity: "base" });
    }
    case "subject":
      return direction * a.subject.localeCompare(b.subject, undefined, { sensitivity: "base" });
    default: {
      const aTime = new Date(a.date).getTime();
      const bTime = new Date(b.date).getTime();
      const aVal = Number.isNaN(aTime) ? 0 : aTime;
      const bVal = Number.isNaN(bTime) ? 0 : bTime;
      return direction * (aVal - bVal);
    }
  }
}

function hasAttachmentParts(bodyStructure: any): boolean {
  return collectAttachmentParts(bodyStructure).length > 0;
}

interface BodyStructureAttachment {
  part: string;
  filename?: string;
  contentType: string;
  size: number;
}

function collectAttachmentParts(
  node: any,
  out: BodyStructureAttachment[] = [],
): BodyStructureAttachment[] {
  if (!node) return out;
  if (node.childNodes?.length) {
    for (const child of node.childNodes) collectAttachmentParts(child, out);
    return out;
  }
  const disposition = String(node.disposition ?? "").toLowerCase();
  const filename: string | undefined =
    node.dispositionParameters?.filename ?? node.parameters?.name;
  const type = String(node.type ?? "").toLowerCase();
  if (type.startsWith("multipart/")) return out;
  if (disposition === "attachment" || (filename && disposition !== "inline")) {
    out.push({
      part: String(node.part ?? "1"),
      filename,
      contentType: node.type || "application/octet-stream",
      size: node.size ?? 0,
    });
  }
  return out;
}
