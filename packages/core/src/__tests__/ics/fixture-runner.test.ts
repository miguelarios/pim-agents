import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import "../../ics/_tz-init.js";
import { parseIcsEvents } from "../../ics/parse-events.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES_DIR = path.join(__dirname, "fixtures");

interface Oracle {
  range?: { start: string; end: string };
  timezone?: string;
  expected: unknown[];
}

function loadOracles(): Array<{ name: string; ics: string; oracle: Oracle }> {
  return (
    fs
      .readdirSync(FIXTURES_DIR)
      .filter((f) => f.endsWith(".oracle.json"))
      // Only event fixtures for this runner; vtodo/vjournal handled in their own runners.
      .filter((f) => !f.startsWith("vtodo_") && !f.startsWith("vjournal_"))
      .map((oracleFile) => {
        const name = oracleFile.replace(".oracle.json", "");
        const ics = fs.readFileSync(path.join(FIXTURES_DIR, `${name}.ics`), "utf-8");
        const oracle = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, oracleFile), "utf-8"));
        return { name, ics, oracle };
      })
  );
}

describe("parseIcsEvents fixture-runner", () => {
  for (const { name, ics, oracle } of loadOracles()) {
    it(name, () => {
      const result = parseIcsEvents(ics, oracle.range, oracle.timezone);
      expect(result).toEqual(oracle.expected);
    });
  }
});

// CI runs in UTC, where a host-local conversion (Date#getHours, ICAL.Time#toJSDate
// on a date-only value) is indistinguishable from a UTC one. Node honours a
// runtime TZ change, so replay every fixture with the host clock set elsewhere.
describe("parseIcsEvents fixture-runner, non-UTC host", () => {
  beforeAll(() => {
    vi.stubEnv("TZ", "America/Chicago");
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("really runs with a non-UTC host offset", () => {
    expect(new Date("2026-01-01T00:00:00Z").getTimezoneOffset()).not.toBe(0);
  });

  for (const { name, ics, oracle } of loadOracles()) {
    it(name, () => {
      const result = parseIcsEvents(ics, oracle.range, oracle.timezone);
      expect(result).toEqual(oracle.expected);
    });
  }
});
