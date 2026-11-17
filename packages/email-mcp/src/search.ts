import {
  ValidationError,
  getLocalDateParts,
  getTimezone,
  parseInTimezone,
  usableTimezone,
  zonedTimeToUtc,
} from "@miguelarios/pim-core";

export interface SearchParams {
  hasWords?: string;
  body?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  since?: string;
  before?: string;
  unread?: boolean;
  flagged?: boolean;
  hasAttachment?: boolean;
  tags?: string[];
}

interface ParsedToken {
  value: string;
  negated: boolean;
}

function parseTokens(value: string): ParsedToken[] {
  const tokens: ParsedToken[] = [];
  const regex = /-?"([^"]+)"|(\S+)/g;
  let match: RegExpExecArray | null = regex.exec(value);
  while (match !== null) {
    const raw = match[0];
    const isNegated = raw.startsWith("-");
    const text = match[1] || match[2];
    const cleaned = isNegated && !match[1] ? text.slice(1) : text;
    if (cleaned.length > 0) {
      tokens.push({ value: cleaned, negated: isNegated });
    }
    match = regex.exec(value);
  }
  return tokens;
}

/**
 * Build imapflow-compatible search criteria from structured params.
 * All params combine with AND logic.
 *
 * Base criteria (address fields, dates, boolean flags, tags) are folded into
 * each tokenized criterion so every IMAP SEARCH call is fully self-contained.
 * Returns a plain object when there are no tokenized criteria, an array of
 * folded objects when there are tokenized criteria, or { all: true } for empty.
 */
export function buildSearchCriteria(
  params: SearchParams,
  timezone: string = getTimezone(),
): Record<string, unknown> | Record<string, unknown>[] {
  const baseCriteria: Record<string, unknown> = {};
  const tokenizedCriteria: Record<string, unknown>[] = [];

  // Address fields → base criteria (no tokenization)
  const addressFields = ["from", "to", "cc", "bcc"] as const;
  for (const field of addressFields) {
    const value = filled(params[field]);
    if (value === undefined) continue;
    baseCriteria[field] = value;
  }

  // Date filters → base criteria
  const since = filled(params.since);
  if (since !== undefined) {
    baseCriteria.since = parseDate(since, "since", timezone);
  }
  const before = filled(params.before);
  if (before !== undefined) {
    baseCriteria.before = parseDate(before, "before", timezone);
  }

  // Boolean flags → base criteria
  if (params.unread !== undefined) {
    baseCriteria.seen = !params.unread;
  }
  if (params.flagged !== undefined) {
    baseCriteria.flagged = params.flagged;
  }

  // Attachment filter → base criteria
  if (params.hasAttachment === true) {
    baseCriteria.header = { "content-type": "multipart/mixed" };
  }

  // Tags → base criteria for single tag, tokenized for multiple (key collision)
  const tags = params.tags?.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  if (tags !== undefined) {
    if (tags.length === 1) {
      baseCriteria.keyword = tags[0];
    } else {
      for (const tag of tags) {
        tokenizedCriteria.push({ keyword: tag });
      }
    }
  }

  // Tokenized fields → subject/body/hasWords with NOT support
  const tokenizedFields: Array<{ param: keyof SearchParams; imapKey: string }> = [
    { param: "subject", imapKey: "subject" },
    { param: "body", imapKey: "body" },
    { param: "hasWords", imapKey: "text" },
  ];
  for (const { param, imapKey } of tokenizedFields) {
    const value = filled(params[param] as string | undefined);
    if (value === undefined) continue;
    const tokens = parseTokens(value);
    for (const token of tokens) {
      if (token.negated) {
        tokenizedCriteria.push({ not: { [imapKey]: token.value } });
      } else {
        tokenizedCriteria.push({ [imapKey]: token.value });
      }
    }
  }

  // No criteria at all → match all
  const hasBase = Object.keys(baseCriteria).length > 0;
  if (!hasBase && tokenizedCriteria.length === 0) {
    return { all: true };
  }

  // Base only, no tokenized → return merged base
  if (tokenizedCriteria.length === 0) {
    return baseCriteria;
  }

  // Tokenized only, no base → check for duplicates
  if (!hasBase) {
    if (tokenizedCriteria.length === 1) {
      return tokenizedCriteria[0];
    }
    return tokenizedCriteria;
  }

  // Both base and tokenized → fold base into each tokenized criterion
  return tokenizedCriteria.map((tc) => ({ ...baseCriteria, ...tc }));
}

/**
 * Narrows a string filter to a meaningful one, trimmed.
 *
 * A blank value is not a filter under any reading: nobody searches for the
 * empty sender. Discarding it keeps the server correct for clients that
 * materialize every optional property rather than omitting the ones the model
 * left unset — see the #101 regression tests. Booleans are deliberately not
 * normalized this way, because `false` is a legitimate query.
 */
function filled(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parses a date filter, rejecting one that cannot be read.
 *
 * `new Date("nonsense")` yields an Invalid Date, which serializes to `null` and
 * makes IMAP match nothing — a silent empty result rather than a usable error.
 */
function parseDate(value: string, field: "since" | "before", timezone: string): Date {
  // A date is midnight in PIM_TIMEZONE, not UTC midnight (the previous
  // evening west of Greenwich).
  const parsed = parseInTimezone(value, timezone);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(
      `${field} is not a valid date: ${JSON.stringify(value)}. Use YYYY-MM-DD.`,
      field,
    );
  }
  return parsed;
}

/**
 * Shapes the `since`/`before` instants from `buildSearchCriteria` for the
 * server at hand, because imapflow sends them in one of two UTC-bound ways:
 *
 * - **WITHIN** (Dovecot and others): as YOUNGER/OLDER seconds from now. That
 *   is exact, so the instants go as they are: local midnight stays local
 *   midnight.
 * - **Otherwise**: as SINCE/BEFORE dates taken from the instant's *UTC* date,
 *   and for a BEFORE off UTC midnight, the next one. Local midnight in Chicago
 *   is 06:00Z, so that would still work there, but east of UTC (22:00Z the
 *   day before) it would search a day early. So each instant becomes UTC
 *   midnight of its *local* date. A BEFORE that is not local midnight moves
 *   to the next day, as imapflow means, so the day it falls in is included.
 */
export function criteriaForServer(
  criteria: Record<string, unknown> | Record<string, unknown>[],
  hasWithin: boolean,
  timezone: string = getTimezone(),
): Record<string, unknown> | Record<string, unknown>[] {
  if (hasWithin) return criteria;
  const zone = usableTimezone(timezone);
  const localDay = (instant: Date, nextUnlessMidnight: boolean): Date => {
    const { year, month, day } = getLocalDateParts(instant, zone);
    const midnight = zonedTimeToUtc(year, month, day, 0, 0, zone).getTime();
    const bump = nextUnlessMidnight && instant.getTime() !== midnight ? 1 : 0;
    return new Date(Date.UTC(year, month - 1, day + bump));
  };
  const adapt = (one: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...one };
    if (out.since instanceof Date) out.since = localDay(out.since, false);
    if (out.before instanceof Date) out.before = localDay(out.before, true);
    return out;
  };
  return Array.isArray(criteria) ? criteria.map(adapt) : adapt(criteria);
}
