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
  // The formatted parts stop at seconds, so compare against the whole second.
  return asUtc - (date.getTime() - date.getUTCMilliseconds());
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

const LOCAL_DATE_TIME =
  /^(\d{4})-(\d{2})(?:-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?)?$/;

/**
 * The instant wall-clock time `wallMs` (UTC fields standing for local ones)
 * names in `timeZone`, disambiguated the way Temporal's "compatible" mode
 * is. In a fall-back overlap it takes the earlier instant. In a
 * spring-forward gap it moves forward by the gap, so a date whose midnight is
 * skipped (Santiago, Azores) still starts on that date, not at 23:00 the day
 * before.
 */
function wallClockToUtc(wallMs: number, timeZone: string): number {
  const HOUR = 3_600_000;
  // The offsets on either side of any transition near this wall time.
  const before = tzOffsetMs(new Date(wallMs - 12 * HOUR), timeZone);
  const after = tzOffsetMs(new Date(wallMs + 12 * HOUR), timeZone);
  const candidates = [wallMs - before, wallMs - after];
  const exact = candidates.filter((t) => t + tzOffsetMs(new Date(t), timeZone) === wallMs);
  if (exact.length > 0) return Math.min(...exact);
  // A gap: no instant shows this wall time. The later reading is "forward by
  // the gap".
  return Math.max(...candidates);
}

/**
 * Reads a caller's date or date-time as the instant it means in `timeZone`.
 *
 * - A date (`2026-11-16`) or year-month (`2026-11`) means midnight in the
 *   zone. `new Date` would make it UTC midnight, which is the previous
 *   evening west of Greenwich.
 * - A date-time with no offset (`2026-11-16T08:30`, or with a space) means
 *   wall-clock time in the zone. `new Date` would read it in the host's zone,
 *   usually UTC in a container.
 * - A wall time DST skips moves forward by the gap, and one it repeats takes
 *   the earlier instant.
 * - Anything with `Z` or an offset is already an instant and is kept as is,
 *   and other forms are left to `new Date`.
 *
 * Returns an Invalid Date for what cannot be read, including an out-of-range
 * day, hour, minute or second, so callers keep their own `Number.isNaN`
 * checks. `24:00` means the next midnight, as it does for `new Date`. An
 * unknown zone falls back to UTC.
 */
export function parseInTimezone(value: string, timeZone: string): Date {
  const m = value.trim().match(LOCAL_DATE_TIME);
  if (!m) return new Date(value);
  const [, y, mo, d = "01", h = "00", mi = "00", s = "00", frac = ""] = m;
  const [year, month, day] = [Number(y), Number(mo), Number(d)];
  const [hour, minute, second] = [Number(h), Number(mi), Number(s)];
  const invalid = new Date(Number.NaN);
  // Reject what Date.UTC would silently roll over (month 13, Feb 30, 25:00).
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return invalid;
  const isEndOfDay = hour === 24 && minute === 0 && second === 0 && !/[1-9]/.test(frac);
  if ((hour > 23 && !isEndOfDay) || minute > 59 || second > 59) return invalid;
  const ms = frac ? Math.round(Number(`0${frac}`) * 1000) : 0;
  const wallMs = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  return new Date(wallClockToUtc(wallMs, usableTimezone(timeZone)));
}
