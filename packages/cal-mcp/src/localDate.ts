/**
 * The calendar date an all-day value names, as `YYYY-MM-DD`.
 *
 * The ICS layer reads an all-day value by its *UTC* date, which is only right
 * for a plain date (`2026-11-16`, anchored at UTC midnight). A date-time read
 * in TZ, such as midnight in Berlin (23:00Z the day before), would
 * land on the wrong day. So everything except a plain date is reduced to its
 * local date first, and the plain date is kept as written.
 */
import {
  formatInTimezone,
  getLocalDateParts,
  parseInTimezone,
  usableTimezone,
} from "@miguelarios/pim-core";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function allDayDate(value: string, timezone: string): string {
  const trimmed = value.trim();
  if (DATE_ONLY.test(trimmed)) return trimmed;
  const zone = usableTimezone(timezone);
  const instant = parseInTimezone(trimmed, zone);
  if (Number.isNaN(instant.getTime())) return value;
  const { year, month, day } = getLocalDateParts(instant, zone);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** A time for a prompt the user reads: a plain date as is, anything else local with its offset. */
export function displayTime(value: string, timezone: string): string {
  if (DATE_ONLY.test(value.trim())) return value;
  const ms = Date.parse(value);
  return Number.isNaN(ms)
    ? value
    : formatInTimezone(new Date(ms).toISOString(), usableTimezone(timezone));
}

/** Whether `value` is a plain date (`YYYY-MM-DD`), with no time part. */
export function isDateOnly(value: string): boolean {
  return DATE_ONLY.test(value.trim());
}
