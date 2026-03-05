import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEmailConfig } from "../config.js";

describe("loadEmailConfig", () => {
  beforeEach(() => {
    vi.stubEnv("IMAP_HOST", "imap.mailbox.org");
    vi.stubEnv("IMAP_PORT", "993");
    vi.stubEnv("IMAP_USER", "miguel@mailbox.org");
    vi.stubEnv("IMAP_PASS", "imap-secret");
    vi.stubEnv("SMTP_HOST", "smtp.mailbox.org");
    vi.stubEnv("SMTP_PORT", "465");
    vi.stubEnv("SMTP_USER", "miguel@mailbox.org");
    vi.stubEnv("SMTP_PASS", "smtp-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads valid email config from env vars", () => {
    const config = loadEmailConfig();
    expect(config.imap.host).toBe("imap.mailbox.org");
    expect(config.imap.port).toBe(993);
    expect(config.imap.user).toBe("miguel@mailbox.org");
    expect(config.imap.pass).toBe("imap-secret");
    expect(config.imap.secure).toBe(true);
    expect(config.smtp.host).toBe("smtp.mailbox.org");
    expect(config.smtp.port).toBe(465);
    expect(config.smtp.user).toBe("miguel@mailbox.org");
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

  it("throws ConfigurationError when IMAP_HOST missing", () => {
    vi.stubEnv("IMAP_HOST", "");
    expect(() => loadEmailConfig()).toThrow("Config validation failed");
  });

  it("throws ConfigurationError when SMTP_PASS missing", () => {
    vi.stubEnv("SMTP_PASS", "");
    expect(() => loadEmailConfig()).toThrow("Config validation failed");
  });
});
