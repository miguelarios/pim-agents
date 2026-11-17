export function getTimezone(): string {
  const envTz = process.env.PIM_TIMEZONE;
  if (envTz?.trim()) return envTz.trim();
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function formatInTimezone(isoUtcString: string, timezone: string): string {
  const date = new Date(isoUtcString);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "longOffset",
  });

  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour") === "24" ? "00" : get("hour");
  const minute = get("minute");
  const second = get("second");
  const tzName = get("timeZoneName"); // e.g., "GMT-05:00" or "GMT+01:00"

  // Parse offset from tzName (format: "GMT±HH:MM" or "GMT" for UTC)
  const offsetMatch = tzName.match(/GMT([+-]\d{2}:\d{2})/);
  const offset = offsetMatch ? offsetMatch[1] : "+00:00";

  return `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
}

function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

/** Calendar date of `date` as seen in `timeZone`. */
export function getLocalDateParts(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/** UTC instant of wall-clock (y, m, d, hh, mm) in `timeZone`. Month is 1-based; day may overflow. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  // Two-pass correction converges across DST transitions.
  let offset = tzOffsetMs(new Date(utcGuess), timeZone);
  offset = tzOffsetMs(new Date(utcGuess - offset), timeZone);
  return new Date(utcGuess - offset);
}

export interface ParsedTimestamp {
  date: Date;
  isUTC: boolean;
  hasExplicitTimezone: boolean;
  offsetMinutes?: number;
}

export function parseTimestamp(timestamp: string): ParsedTimestamp {
  const date = new Date(timestamp);

  if (timestamp.endsWith("Z")) {
    return { date, isUTC: true, hasExplicitTimezone: false };
  }

  const offsetMatch = timestamp.match(/([+-])(\d{2}):(\d{2})$/);
  if (offsetMatch) {
    const sign = offsetMatch[1] === "+" ? 1 : -1;
    const hours = Number.parseInt(offsetMatch[2], 10);
    const minutes = Number.parseInt(offsetMatch[3], 10);
    return {
      date,
      isUTC: false,
      hasExplicitTimezone: true,
      offsetMinutes: sign * (hours * 60 + minutes),
    };
  }

  return { date, isUTC: false, hasExplicitTimezone: false };
}

/** `timeZone` if Intl knows it, else "UTC". */
export function usableTimezone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;

/**
 * Reads a caller's date or date-time as the instant it means in `timeZone`.
 *
 * - A date (`2026-11-16`) is midnight in the zone. `new Date` would make it
 *   UTC midnight, which is the previous evening west of Greenwich.
 * - A date-time with no offset (`2026-11-16T08:30`) is wall-clock time in the
 *   zone. `new Date` would read it in the host's zone, usually UTC in a
 *   container.
 * - Anything with `Z` or an offset is already an instant and is kept as is.
 *
 * Returns an Invalid Date for what cannot be read, so callers keep their own
 * `Number.isNaN` checks. An unknown zone falls back to UTC.
 */
export function parseInTimezone(value: string, timeZone: string): Date {
  const m = value.trim().match(LOCAL_DATE_TIME);
  if (!m) return new Date(value);
  const [, y, mo, d, h = "0", mi = "0", s = "0"] = m;
  const [year, month, day] = [Number(y), Number(mo), Number(d)];
  // Reject what Date.UTC would silently roll over (month 13, Feb 30).
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return new Date(Number.NaN);
  const zone = usableTimezone(timeZone);
  const instant = zonedTimeToUtc(year, month, day, Number(h), Number(mi), zone);
  return new Date(instant.getTime() + Number(s) * 1000);
}
