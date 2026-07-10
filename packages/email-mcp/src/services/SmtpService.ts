import { type EmailConfig, toPimError } from "@miguelarios/pim-core";
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";

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
      const from = this.config.fromName
        ? `"${this.config.fromName}" <${this.config.smtp.user}>`
        : this.config.smtp.user;

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
        messageId: info.messageId,
        accepted: info.accepted as string[],
        rejected: info.rejected as string[],
      };
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
