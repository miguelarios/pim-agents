/**
 * Reads the times a caller passes in, in PIM_TIMEZONE, the zone results are
 * given in. Before this, `new Date` read them: a date-only range bound became
 * UTC midnight (the previous evening west of Greenwich), and a date-time with
 * no offset became the host's wall-clock time, which is UTC in a container.
 * So `create_event` at "08:30" wrote 02:30 Chicago time.
 *
 * Each tool's time arguments are rewritten once, before its handler runs, to
 * UTC ISO instants. Handlers and the ICS helpers keep working in instants.
 *
 * - **Range bounds** (`start`/`end` of the read tools): a date is local
 *   midnight.
 * - **Event times and `occurrenceDate`:** a plain date is left as given. It
 *   names an all-day date, which the ICS layer reads by its calendar date.
 *   Local midnight would be the previous UTC date east of Greenwich.
 *
 * A value with an offset or `Z` is passed through untouched. Anything that does not parse is passed through
 * unchanged, so each tool's own validation still reports it.
 */
import { getTimezone, parseInTimezone } from "@miguelarios/pim-core";
import type { ToolDef } from "@miguelarios/pim-core/mcp";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
/** Already an instant: ends in Z or a UTC offset. */
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

type Args = Record<string, unknown>;

function zoned(value: unknown, timezone: string, keepDate: boolean): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (HAS_ZONE.test(trimmed)) return value;
  if (keepDate && DATE_ONLY.test(trimmed)) return value;
  const instant = parseInTimezone(value, timezone);
  return Number.isNaN(instant.getTime()) ? value : instant.toISOString();
}

function rewrite(args: Args, keys: string[], timezone: string, keepDate: boolean): Args {
  const out = { ...args };
  for (const key of keys) {
    if (key in out) out[key] = zoned(out[key], timezone, keepDate);
  }
  return out;
}

interface TimeArgs {
  range?: string[];
  event?: string[];
  batch?: boolean;
}

/** Which arguments of which tool are times, and of which kind. */
const TIME_ARGS: Record<string, TimeArgs> = {
  list_events: { range: ["start", "end"] },
  search_events: { range: ["start", "end"] },
  get_free_busy: { range: ["start", "end"] },
  find_free_slots: { range: ["start", "end"] },
  get_event: { event: ["occurrenceDate"] },
  create_event: { event: ["start", "end"] },
  update_event: { event: ["start", "end", "occurrenceDate"] },
  delete_event: { event: ["occurrenceDate"] },
  create_events_batch: { batch: true },
};

export function zoneArgs(name: string, args: Args, timezone: string = getTimezone()): Args {
  const spec = TIME_ARGS[name];
  if (!spec || args === null || typeof args !== "object") return args;
  let out = args;
  if (spec.range) out = rewrite(out, spec.range, timezone, false);
  if (spec.event) out = rewrite(out, spec.event, timezone, true);
  if (spec.batch && Array.isArray(out.events)) {
    out = {
      ...out,
      events: out.events.map((e) =>
        e && typeof e === "object" ? rewrite(e as Args, ["start", "end"], timezone, true) : e,
      ),
    };
  }
  return out;
}

/** `tool` with its time arguments read in PIM_TIMEZONE before its handler runs. */
export function withZonedArgs<S>(tool: ToolDef<S>): ToolDef<S> {
  if (!TIME_ARGS[tool.name]) return tool;
  const handler = tool.handler;
  return {
    ...tool,
    handler: (args, service, ctx) =>
      handler(zoneArgs(tool.name, args as Args) as never, service, ctx),
  } as ToolDef<S>;
}
