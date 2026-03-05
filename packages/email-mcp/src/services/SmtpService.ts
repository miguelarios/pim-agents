import { type EmailConfig, toPimError } from "@miguelarios/pim-core";
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

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

export class SmtpService {
	private config: EmailConfig;

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
			throw toPimError(
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}
}
