import { randomUUID } from "node:crypto";
import { type EmailConfig, toPimError } from "@miguelarios/pim-core";
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";

/**
 * The Message-ID header of an RFC 5322 message, from its header block only
 * (up to the first blank line), with folded continuation lines unfolded.
 */
function headerMessageId(raw: Buffer): string | undefined {
  const text = raw.toString("latin1");
  const end = text.search(/\r?\n\r?\n/);
  const headers = (end === -1 ? text : text.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
  const match = /^message-id:[ \t]*(.+?)[ \t]*$/im.exec(headers);
  return match?.[1] || undefined;
}

/**
 * The message as given when it already has a Message-ID, otherwise with one
 * prepended on the sender's domain. A draft saved by another client may have
 * none; giving it one before it is both sent and filed in Sent keeps the two
 * copies, and the ID send_draft reports, the same.
 */
export function ensureMessageId(raw: Buffer, senderAddress: string): Buffer {
  if (headerMessageId(raw)) return raw;
  const domain = senderAddress.split("@")[1] || "localhost";
  return Buffer.concat([Buffer.from(`Message-ID: <${randomUUID()}@${domain}>\r\n`, "latin1"), raw]);
}

export interface SendEmailOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    path?: string;
    content?: string | Buffer;
    contentType?: string;
  }>;
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
}

export interface ComposeOptions {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    path?: string;
    content?: string | Buffer;
    contentType?: string;
  }>;
  inReplyTo?: string;
  references?: string[];
}

export class SmtpService {
  readonly config: EmailConfig;

  constructor(config: EmailConfig) {
    this.config = config;
  }

  private normalizedAllowedFromAddresses(): string[] {
    return Array.from(
      new Set(
        [this.config.smtp.user, ...(this.config.allowedFrom || [])]
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean),
      ),
    );
  }

  /**
   * Every address this account counts as "us", lower-cased: the mailbox being
   * read, the submitting SMTP account, and anything SMTP_ALLOWED_FROM adds.
   *
   * Used to keep a reply-all from addressing the sender back to themselves —
   * IMAP_USER and SMTP_USER are usually the same, but nothing requires it, and
   * an allow-listed alias is just as much "us" for that purpose.
   */
  ownAddresses(): string[] {
    return Array.from(
      new Set(
        [this.config.imap.user, this.config.smtp.user, ...(this.config.allowedFrom || [])]
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean),
      ),
    );
  }

  resolveFromAddress(requestedFrom?: string): string {
    const fallback = this.config.smtp.user;
    if (!requestedFrom) return fallback;

    const normalizedRequested = requestedFrom.trim().toLowerCase();
    if (!normalizedRequested) return fallback;

    if (!this.normalizedAllowedFromAddresses().includes(normalizedRequested)) {
      throw toPimError(
        new Error(
          `Requested from address is not allowed: ${requestedFrom}. Allowed addresses: ${this.normalizedAllowedFromAddresses().join(", ")}`,
        ),
      );
    }

    return requestedFrom.trim();
  }

  formatFromHeader(fromAddress: string, displayName?: string): string {
    const effectiveName = displayName?.trim() || this.config.fromName;
    return effectiveName ? `"${effectiveName}" <${fromAddress}>` : fromAddress;
  }

  private createTransporter(): Transporter {
    return nodemailer.createTransport({
      host: this.config.smtp.host,
      port: this.config.smtp.port,
      secure: this.config.smtp.secure,
      auth: {
        user: this.config.smtp.user,
        pass: this.config.smtp.pass,
      },
    });
  }

  async sendEmail(options: SendEmailOptions): Promise<SendResult> {
    const transporter = this.createTransporter();
    try {
      const from = this.formatFromHeader(this.resolveFromAddress());

      const info = await transporter.sendMail({
        from,
        to: options.to.join(", "),
        cc: options.cc?.join(", "),
        bcc: options.bcc?.join(", "),
        subject: options.subject,
        text: options.text,
        html: options.html,
        attachments: options.attachments,
      });

      return {
        messageId: info.messageId,
        accepted: info.accepted as string[],
        rejected: info.rejected as string[],
      };
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async composeRawMessage(
    options: ComposeOptions,
    opts: { keepBcc?: boolean } = {},
  ): Promise<Buffer> {
    const composer = new MailComposer({
      from: options.from,
      to: options.to.join(", "),
      cc: options.cc?.join(", "),
      bcc: options.bcc?.join(", "),
      subject: options.subject,
      text: options.text,
      html: options.html,
      attachments: options.attachments,
      inReplyTo: options.inReplyTo,
      references: options.references?.join(" "),
    });

    // MailComposer doesn't forward a `keepBcc` mail option through to the
    // underlying MimeNode constructor (it only threads `newline`), so the
    // only way to keep Bcc in the generated headers is to set the flag
    // directly on the compiled MimeNode before building.
    const message = composer.compile();
    if (opts.keepBcc === true) {
      (message as unknown as { keepBcc: boolean }).keepBcc = true;
    }

    return new Promise<Buffer>((resolve, reject) => {
      message.build((err, built) => {
        if (err) reject(err);
        else resolve(built);
      });
    });
  }

  async sendRawMessage(
    rawSource: Buffer,
    envelope: { from: string; to: string[] },
  ): Promise<SendResult> {
    const transporter = this.createTransporter();
    try {
      const info = await transporter.sendMail({
        envelope,
        raw: rawSource,
      });

      return {
        // nodemailer does not parse a `raw` message, so info.messageId is an
        // id it invented and never sent (#130). Report the one on the wire.
        messageId: headerMessageId(rawSource) ?? info.messageId,
        accepted: info.accepted as string[],
        rejected: info.rejected as string[],
      };
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
