/**
 * Runs before every test file in every package (see each vitest.config.ts).
 *
 * The suite must behave the same on a developer's machine as in CI, but the
 * servers read their configuration from the environment, and a developer
 * running them locally usually has that configuration exported: accounts
 * (CALDAV_*, CARDDAV_*, IMAP_*, SMTP_*), switches like PIM_MCP_CONFIRM=off,
 * limits like EMAIL_MAX_INLINE_BYTES. Any of those changes what the code
 * under test does. Clearing them here gives every test CI's clean
 * environment; a test that needs one sets it with vi.stubEnv. The host's TZ
 * is left alone on purpose, since tests that depend on it pin PIM_TIMEZONE
 * and the ICS fixture runner replays under a second zone.
 */
const PIM_CONFIG = /^(CALDAV|CARDDAV|IMAP|SMTP|EMAIL|PIM)_/;

for (const key of Object.keys(process.env)) {
  if (PIM_CONFIG.test(key)) delete process.env[key];
}
