import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEmailConfig } from "../config.js";

describe("loadEmailConfig", () => {
  beforeEach(() => {
    vi.stubEnv("IMAP_HOST", "imap.mailbox.org");
    vi.stubEnv("IMAP_PORT", "993");
    vi.stubEnv("IMAP_USER", "user@example.com");
    vi.stubEnv("IMAP_PASS", "imap-secret");
    vi.stubEnv("SMTP_HOST", "smtp.mailbox.org");
    vi.stubEnv("SMTP_PORT", "465");
    vi.stubEnv("SMTP_USER", "user@example.com");
    vi.stubEnv("SMTP_PASS", "smtp-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads valid email config from env vars", () => {
    const config = loadEmailConfig();
    expect(config.imap.host).toBe("imap.mailbox.org");
    expect(config.imap.port).toBe(993);
    expect(config.imap.user).toBe("user@example.com");
    expect(config.imap.pass).toBe("imap-secret");
    expect(config.imap.secure).toBe(true);
    expect(config.smtp.host).toBe("smtp.mailbox.org");
    expect(config.smtp.port).toBe(465);
    expect(config.smtp.user).toBe("user@example.com");
    expect(config.smtp.pass).toBe("smtp-secret");
    expect(config.smtp.secure).toBe(true);
  });

  it("uses default ports and secure when not specified", () => {
    vi.stubEnv("IMAP_PORT", "");
    vi.stubEnv("SMTP_PORT", "");
    const config = loadEmailConfig();
    expect(config.imap.port).toBe(993);
    expect(config.smtp.port).toBe(465);
  });

  it("reads optional SMTP_FROM_NAME", () => {
    vi.stubEnv("SMTP_FROM_NAME", "Miguel Rios");
    const config = loadEmailConfig();
    expect(config.fromName).toBe("Miguel Rios");
  });

  it("reads optional SMTP_ALLOWED_FROM as a trimmed list", () => {
    vi.stubEnv("SMTP_ALLOWED_FROM", "shared@example.com, alias@example.com, ");
    const config = loadEmailConfig();
    expect(config.allowedFrom).toEqual(["shared@example.com", "alias@example.com"]);
  });

  it("throws ConfigurationError when IMAP_HOST missing", () => {
    vi.stubEnv("IMAP_HOST", "");
    expect(() => loadEmailConfig()).toThrow("Config validation failed");
  });

  it("throws ConfigurationError when SMTP_PASS missing", () => {
    vi.stubEnv("SMTP_PASS", "");
    expect(() => loadEmailConfig()).toThrow("Config validation failed");
  });

  it("reads SMTP_AUTO_SENT as autoSent boolean", () => {
    vi.stubEnv("SMTP_AUTO_SENT", "true");
    const config = loadEmailConfig();
    expect(config.autoSent).toBe(true);
  });

  it("defaults autoSent to false when SMTP_AUTO_SENT is not set", () => {
    const config = loadEmailConfig();
    expect(config.autoSent).toBe(false);
  });
});
