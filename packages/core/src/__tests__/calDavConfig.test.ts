import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCalDavConfig } from "../config.js";

/**
 * Blank every CALDAV_* variable the host shell exports, so a machine with real
 * accounts configured sees the same environment as CI. stubEnv with undefined
 * deletes the key; unstubAllEnvs in afterEach restores the originals.
 */
function clearHostCalDavEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CALDAV_")) vi.stubEnv(key, undefined);
  }
}

describe("loadCalDavConfig", () => {
  beforeEach(() => {
    clearHostCalDavEnv();
    vi.stubEnv("CALDAV_MAILBOX_URL", "https://dav.mailbox.org/caldav/");
    vi.stubEnv("CALDAV_MAILBOX_USER", "user@example.com");
    vi.stubEnv("CALDAV_MAILBOX_PASS", "caldav-secret");
    vi.stubEnv(
      "CALDAV_NEXTCLOUD_URL",
      "https://cloud.example.com/remote.php/dav/calendars/miguel/",
    );
    vi.stubEnv("CALDAV_NEXTCLOUD_USER", "miguel");
    vi.stubEnv("CALDAV_NEXTCLOUD_PASS", "nc-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads valid CalDAV config from prefixed env vars", () => {
    const config = loadCalDavConfig();
    expect(config.accounts).toHaveLength(2);

    const mailbox = config.accounts.find((a) => a.id === "mailbox");
    expect(mailbox).toBeDefined();
    expect(mailbox!.url).toBe("https://dav.mailbox.org/caldav/");
    expect(mailbox!.username).toBe("user@example.com");
    expect(mailbox!.password).toBe("caldav-secret");

    const nextcloud = config.accounts.find((a) => a.id === "nextcloud");
    expect(nextcloud).toBeDefined();
    expect(nextcloud!.username).toBe("miguel");
  });

  it("lowercases the account ID from env var name", () => {
    const config = loadCalDavConfig();
    const ids = config.accounts.map((a) => a.id);
    expect(ids).toContain("mailbox");
    expect(ids).toContain("nextcloud");
  });

  it("throws when no CalDAV env vars are set", () => {
    clearHostCalDavEnv();
    expect(() => loadCalDavConfig()).toThrow("No CalDAV accounts found");
  });

  it("throws when USER is missing for an account", () => {
    vi.stubEnv("CALDAV_MAILBOX_USER", "");
    expect(() => loadCalDavConfig()).toThrow("CALDAV_MAILBOX_USER is required");
  });

  it("throws when PASS is missing for an account", () => {
    vi.stubEnv("CALDAV_MAILBOX_PASS", "");
    expect(() => loadCalDavConfig()).toThrow("CALDAV_MAILBOX_PASS is required");
  });

  it("throws when URL is not a valid URL", () => {
    vi.stubEnv("CALDAV_MAILBOX_URL", "not-a-url");
    expect(() => loadCalDavConfig()).toThrow("CALDAV_MAILBOX_URL must be a valid URL");
  });

  it("works with a single account", () => {
    clearHostCalDavEnv();
    vi.stubEnv("CALDAV_WORK_URL", "https://cal.work.com/dav/");
    vi.stubEnv("CALDAV_WORK_USER", "user");
    vi.stubEnv("CALDAV_WORK_PASS", "pass");

    const config = loadCalDavConfig();
    expect(config.accounts).toHaveLength(1);
    expect(config.accounts[0].id).toBe("work");
  });
});
