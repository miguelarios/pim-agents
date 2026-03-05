import { type EmailConfig, EmailError, ErrorCode, toPimError } from "@miguelarios/pim-core";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

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
  textBody?: string;
  htmlBody?: string;
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
}

export class ImapService {
  private config: EmailConfig;

  constructor(config: EmailConfig) {
    this.config = config;
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
    query: Record<string, unknown>,
    options: SearchOptions = {},
  ): Promise<EmailSummary[]> {
    const client = this.createClient();
    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);
      try {
        const searchCriteria = Object.keys(query).length > 0 ? query : { all: true };
        const searchResult = await client.search(searchCriteria as any, {
          uid: true,
        });
        const uids = searchResult || [];

        if (uids.length === 0) return [];

        const offset = options.offset ?? 0;
        const limit = options.limit ?? 50;
        const sliced = uids.slice(offset, offset + limit);

        const summaries: EmailSummary[] = [];
        const uidRange = sliced.join(",");

        for await (const msg of client.fetch(uidRange, {
          envelope: true,
          flags: true,
          bodyStructure: true,
          uid: true,
        })) {
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
            date: envelope.date?.toISOString() || "",
            flags: [...(msg.flags || [])],
            hasAttachments: hasAttachmentParts(msg.bodyStructure),
          });
        }
        return summaries;
      } finally {
        lock.release();
      }
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async fetchEmail(folder: string, uid: number): Promise<EmailFull> {
    const client = this.createClient();
    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);
      try {
        const fetchResult = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!fetchResult || !fetchResult.source) {
          throw new EmailError(`Email UID ${uid} not found`, ErrorCode.EMAIL_NOT_FOUND, uid);
        }

        const parsed = await simpleParser(fetchResult.source);
        return {
          uid,
          messageId: parsed.messageId || "",
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
          date: parsed.date?.toISOString() || "",
          flags: [],
          hasAttachments: (parsed.attachments?.length || 0) > 0,
          textBody: parsed.text || undefined,
          htmlBody: parsed.html || undefined,
          attachments: (parsed.attachments || []).map((att, index) => ({
            filename: att.filename || `attachment-${index}`,
            contentType: att.contentType || "application/octet-stream",
            size: att.size || 0,
            partId: String(index + 1),
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
}

function hasAttachmentParts(bodyStructure: any): boolean {
  if (!bodyStructure) return false;
  if (bodyStructure.type?.toLowerCase().includes("multipart/mixed")) return true;
  if (bodyStructure.childNodes) {
    return bodyStructure.childNodes.some((node: any) => hasAttachmentParts(node));
  }
  return false;
}
