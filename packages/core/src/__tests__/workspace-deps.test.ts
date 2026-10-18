import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * In the workspace every server links pim-core locally, so a stale range in a
 * server's package.json passes every other test and only breaks once
 * published: npm then resolves the old core, and cal-mcp, which returns core's
 * `/ics` objects as they are, would emit field names its schema rejects.
 */
const packagesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (dir: string) =>
  JSON.parse(fs.readFileSync(path.join(packagesDir, dir, "package.json"), "utf8"));

const parse = (v: string) => v.split(".").map(Number) as [number, number, number];

/** Whether `^range` admits `version`, for plain `x.y.z` versions. */
function caretAdmits(range: string, version: string): boolean {
  const [rMaj, rMin, rPat] = parse(range);
  const [vMaj, vMin, vPat] = parse(version);
  if (rMaj !== vMaj) return false;
  if (rMaj === 0 && rMin !== vMin) return false;
  if (vMin !== rMin) return vMin > rMin;
  return vPat >= rPat;
}

describe("workspace dependency ranges", () => {
  const core = read("core");

  it.each(["cal-mcp", "card-mcp", "email-mcp"])(
    "%s depends on a pim-core range that admits the workspace version",
    (server) => {
      const range: string = read(server).dependencies["@miguelarios/pim-core"];
      expect(range, server).toMatch(/^\^\d+\.\d+\.\d+$/);
      expect(caretAdmits(range.slice(1), core.version), `${range} vs ${core.version}`).toBe(true);
    },
  );
});
