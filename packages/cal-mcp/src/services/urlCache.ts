import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CachedObject {
  url: string;
  etag?: string;
}

type CacheShape = Record<string, Record<string, CachedObject>>;

// Persistent UID→URL cache keyed by calendar_id. Used by findCalendarObject
// so get/update/delete can target a single event instead of scanning the
// entire calendar. Primary driver: Mailbox.org's CalDAV ignores UID prop-
// filters on calendar-query REPORTs and returns every object (observed:
// 1127 objects / 107s on a real calendar).
//
// Cache is shared across MCP processes via a JSON file at
// $XDG_CACHE_HOME/cal-mcp/urls.json (falls back to ~/.cache/cal-mcp/urls.json).
// No TTL — entries are refreshed on every successful touch and invalidated
// on delete. Small footprint per entry (~120 bytes).

function cachePath(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "cal-mcp", "urls.json");
}

function readCache(): CacheShape {
  try {
    const raw = readFileSync(cachePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as CacheShape;
    return {};
  } catch {
    return {};
  }
}

function writeCache(cache: CacheShape): void {
  const path = cachePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache), { mode: 0o600 });
  } catch {
    // Ignore cache write failures — cache is an optimization, not a source
    // of truth. Don't let disk errors break the tool call.
  }
}

export function getCachedObject(calendarId: string, uid: string): CachedObject | null {
  const cache = readCache();
  return cache[calendarId]?.[uid] ?? null;
}

export function setCachedObject(calendarId: string, uid: string, obj: CachedObject): void {
  const cache = readCache();
  if (!cache[calendarId]) cache[calendarId] = {};
  cache[calendarId][uid] = obj;
  writeCache(cache);
}

export function deleteCachedObject(calendarId: string, uid: string): void {
  const cache = readCache();
  if (cache[calendarId]?.[uid]) {
    delete cache[calendarId][uid];
    writeCache(cache);
  }
}

/**
 * Rekeys a calendar's cached entries after a rename.
 *
 * A PROPPATCH changes the display name, and with it the `calendar_id` this
 * cache is keyed by — but not the object URLs underneath, so the entries stay
 * valid and only their key is stale. Correctness never depends on this:
 * `findCalendarObject` verifies UIDs after every fetch and falls back to a
 * scan. Without it, though, a rename would silently discard the cache that
 * exists to avoid full-calendar scans.
 *
 * Entries already under `newId` (a name reused after an earlier rename) are
 * kept — they were written against the same URLs the new name now resolves to.
 */
export function moveCachedCalendar(oldCalendarId: string, newCalendarId: string): void {
  if (oldCalendarId === newCalendarId) return;
  const cache = readCache();
  const moving = cache[oldCalendarId];
  if (!moving) return;
  cache[newCalendarId] = { ...moving, ...(cache[newCalendarId] ?? {}) };
  delete cache[oldCalendarId];
  writeCache(cache);
}

/** Drops every cached entry for a calendar — used when the collection is deleted. */
export function purgeCachedCalendar(calendarId: string): void {
  const cache = readCache();
  if (!cache[calendarId]) return;
  delete cache[calendarId];
  writeCache(cache);
}
