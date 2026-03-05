import { afterEach, describe, expect, it, vi } from "vitest";
import { type CardDavConfig, loadCardDavConfig } from "../config.js";

describe("loadCardDavConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads valid CardDAV config from env vars", () => {
    vi.stubEnv(
      "CARDDAV_URL",
      "https://cloud.example.com/remote.php/dav/addressbooks/users/miguel/",
    );
    vi.stubEnv("CARDDAV_USER", "miguel");
    vi.stubEnv("CARDDAV_PASS", "secret-app-password");

    const config = loadCardDavConfig();
    expect(config.url).toBe("https://cloud.example.com/remote.php/dav/addressbooks/users/miguel/");
    expect(config.username).toBe("miguel");
    expect(config.password).toBe("secret-app-password");
  });

  it("throws ConfigurationError when CARDDAV_URL is missing", () => {
    vi.stubEnv("CARDDAV_USER", "miguel");
    vi.stubEnv("CARDDAV_PASS", "secret");
    delete process.env.CARDDAV_URL;

    expect(() => loadCardDavConfig()).toThrow("CARDDAV_URL");
  });

  it("throws ConfigurationError when CARDDAV_USER is missing", () => {
    vi.stubEnv("CARDDAV_URL", "https://cloud.example.com/dav/");
    vi.stubEnv("CARDDAV_PASS", "secret");
    delete process.env.CARDDAV_USER;

    expect(() => loadCardDavConfig()).toThrow("CARDDAV_USER");
  });

  it("throws ConfigurationError when CARDDAV_PASS is missing", () => {
    vi.stubEnv("CARDDAV_URL", "https://cloud.example.com/dav/");
    vi.stubEnv("CARDDAV_USER", "miguel");
    delete process.env.CARDDAV_PASS;

    expect(() => loadCardDavConfig()).toThrow("CARDDAV_PASS");
  });

  it("throws ConfigurationError when CARDDAV_URL is not a valid URL", () => {
    vi.stubEnv("CARDDAV_URL", "not-a-url");
    vi.stubEnv("CARDDAV_USER", "miguel");
    vi.stubEnv("CARDDAV_PASS", "secret");

    expect(() => loadCardDavConfig()).toThrow();
  });
});
