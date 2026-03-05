import * as v from "valibot";
import { ConfigurationError } from "./errors.js";

export interface CardDavConfig {
  url: string;
  username: string;
  password: string;
}

const CardDavEnvSchema = v.object({
  CARDDAV_URL: v.pipe(
    v.string("CARDDAV_URL is required"),
    v.url("CARDDAV_URL must be a valid URL"),
  ),
  CARDDAV_USER: v.pipe(
    v.string("CARDDAV_USER is required"),
    v.minLength(1, "CARDDAV_USER cannot be empty"),
  ),
  CARDDAV_PASS: v.pipe(
    v.string("CARDDAV_PASS is required"),
    v.minLength(1, "CARDDAV_PASS cannot be empty"),
  ),
});

export function loadCardDavConfig(): CardDavConfig {
  const env = {
    CARDDAV_URL: process.env.CARDDAV_URL,
    CARDDAV_USER: process.env.CARDDAV_USER,
    CARDDAV_PASS: process.env.CARDDAV_PASS,
  };

  try {
    const validated = v.parse(CardDavEnvSchema, env);
    return {
      url: validated.CARDDAV_URL,
      username: validated.CARDDAV_USER,
      password: validated.CARDDAV_PASS,
    };
  } catch (error) {
    if (v.isValiError(error)) {
      const messages = error.issues.map((issue) => {
        const path = issue.path?.map((p) => p.key).join(".") ?? "unknown";
        return `${path}: ${issue.message}`;
      });
      throw new ConfigurationError(`Config validation failed: ${messages.join("; ")}`);
    }
    throw error;
  }
}

export interface EmailConfig {
  imap: {
    host: string;
    port: number;
    user: string;
    pass: string;
    secure: boolean;
  };
  smtp: {
    host: string;
    port: number;
    user: string;
    pass: string;
    secure: boolean;
  };
  fromName?: string;
}

const EmailEnvSchema = v.object({
  IMAP_HOST: v.pipe(v.string("IMAP_HOST is required"), v.minLength(1, "IMAP_HOST cannot be empty")),
  IMAP_USER: v.pipe(v.string("IMAP_USER is required"), v.minLength(1, "IMAP_USER cannot be empty")),
  IMAP_PASS: v.pipe(v.string("IMAP_PASS is required"), v.minLength(1, "IMAP_PASS cannot be empty")),
  SMTP_HOST: v.pipe(v.string("SMTP_HOST is required"), v.minLength(1, "SMTP_HOST cannot be empty")),
  SMTP_USER: v.pipe(v.string("SMTP_USER is required"), v.minLength(1, "SMTP_USER cannot be empty")),
  SMTP_PASS: v.pipe(v.string("SMTP_PASS is required"), v.minLength(1, "SMTP_PASS cannot be empty")),
});

export function loadEmailConfig(): EmailConfig {
  const env = {
    IMAP_HOST: process.env.IMAP_HOST,
    IMAP_USER: process.env.IMAP_USER,
    IMAP_PASS: process.env.IMAP_PASS,
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
  };

  try {
    const validated = v.parse(EmailEnvSchema, env);
    const imapPort = Number.parseInt(process.env.IMAP_PORT || "993", 10);
    const smtpPort = Number.parseInt(process.env.SMTP_PORT || "465", 10);

    return {
      imap: {
        host: validated.IMAP_HOST,
        port: Number.isNaN(imapPort) ? 993 : imapPort,
        user: validated.IMAP_USER,
        pass: validated.IMAP_PASS,
        secure: process.env.IMAP_SECURE !== "false",
      },
      smtp: {
        host: validated.SMTP_HOST,
        port: Number.isNaN(smtpPort) ? 465 : smtpPort,
        user: validated.SMTP_USER,
        pass: validated.SMTP_PASS,
        secure: process.env.SMTP_SECURE !== "false",
      },
      fromName: process.env.SMTP_FROM_NAME || undefined,
    };
  } catch (error) {
    if (v.isValiError(error)) {
      const messages = error.issues.map((issue) => {
        const path = issue.path?.map((p) => p.key).join(".") ?? "unknown";
        return `${path}: ${issue.message}`;
      });
      throw new ConfigurationError(`Config validation failed: ${messages.join("; ")}`);
    }
    throw error;
  }
}
