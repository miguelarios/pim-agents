import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCalDavConfig } from "../config.js";

const VALID_ACCOUNTS = JSON.stringify([
  {
    id: "mailbox",
    url: "https://dav.mailbox.org/caldav/",
    username: "miguel@mailbox.org",
    password: "caldav-secret",
  },
  {
    id: "nextcloud",
    url: "https://cloud.example.com/remote.php/dav/calendars/miguel/",
    username: "miguel",
    password: "nc-secret",
  },
]);

describe("loadCalDavConfig", () => {
  beforeEach(() => {
    vi.stubEnv("CALDAV_ACCOUNTS", VALID_ACCOUNTS);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads valid CalDAV config from CALDAV_ACCOUNTS env var", () => {
    const config = loadCalDavConfig();
    expect(config.accounts).toHaveLength(2);
    expect(config.accounts[0].id).toBe("mailbox");
    expect(config.accounts[0].url).toBe("https://dav.mailbox.org/caldav/");
    expect(config.accounts[0].username).toBe("miguel@mailbox.org");
    expect(config.accounts[0].password).toBe("caldav-secret");
    expect(config.accounts[1].id).toBe("nextcloud");
  });

  it("throws ConfigurationError when CALDAV_ACCOUNTS is missing", () => {
    vi.stubEnv("CALDAV_ACCOUNTS", "");
    expect(() => loadCalDavConfig()).toThrow("CALDAV_ACCOUNTS");
  });

  it("throws ConfigurationError when CALDAV_ACCOUNTS is invalid JSON", () => {
    vi.stubEnv("CALDAV_ACCOUNTS", "not-json");
    expect(() => loadCalDavConfig()).toThrow();
  });

  it("throws ConfigurationError when account is missing required fields", () => {
    vi.stubEnv("CALDAV_ACCOUNTS", JSON.stringify([{ id: "test" }]));
    expect(() => loadCalDavConfig()).toThrow("Config validation failed");
  });

  it("throws ConfigurationError when accounts array is empty", () => {
    vi.stubEnv("CALDAV_ACCOUNTS", "[]");
    expect(() => loadCalDavConfig()).toThrow("Config validation failed");
  });
});
