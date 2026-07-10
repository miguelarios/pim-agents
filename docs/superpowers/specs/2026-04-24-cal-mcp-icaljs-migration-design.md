# cal-mcp: Migrate ICS parsing/generation to ical.js (via pim-core)

**Date:** 2026-04-24
**Packages:** `@miguelarios/pim-core` + `@miguelarios/cal-mcp`
**Status:** Implemented (cal-mcp 0.10.0 / pim-core 0.6.0, PR #35)
**Related:** Todoist task `6gQGcqcMCRHj8Jj4` under the Calendar MCP project.

## Problem

`cal-mcp` uses `node-ical` for parsing and `ical-generator` for serialization. Both libraries have produced silent-data bugs that required workaround patches rather than root-cause fixes:

- **v0.7.2** — TZID drift across Node builds / container tzdata. `node-ical`'s TZID resolution is non-deterministic across environments. Fixed by `extractDtstartWallClockFromIcs` — an 80-line regex-based ICS re-parser that bypasses `node-ical`'s interpretation entirely.
- **v0.7.3** — EXDATE filtering. `node-ical`'s EXDATE support is incomplete (no TZID-bearing EXDATE, no multi-line, no comma-separated). Fixed by `extractExdatesFromIcs` — a second regex-based re-parser.
- **v0.8.6** — `mailto:` case-sensitivity. `ical-generator` emits `MAILTO:`, `node-ical` strips lowercase `mailto:`. Generic instance of "parser and generator disagree about ICS shape" — a class of bug that persists as long as the two libraries are used together.

Additional correctness gaps that exist today but have no patch:

- DST transitions mid-RRULE are handled via a per-occurrence `Intl.DateTimeFormat` reconversion workaround (`correctOccurrenceUtc`), not via proper VTIMEZONE interpretation.
- `generateEventIcs` never emits a VTIMEZONE block, which strict CalDAV servers and Apple clients expect.
- RDATE (alternate-date additions to a recurring series) is not supported on read.
- Multiple RRULEs in one VEVENT are silently truncated to the first.
- Floating-time events (no TZID, no `Z`) are treated as UTC, not as viewer-local per RFC 5545 §3.3.5.
- VTODO and VJOURNAL components are not parsed at all.

The brittleness is structural: `node-ical` + `ical-generator` is two libraries' worth of surface area, with three separate workaround helpers (~80 lines) patching parser deficiencies, six `(vevent as any)` escape hatches in `parseIcsEvents` where `node-ical`'s types don't expose required fields, and three instances of `icsString.replace("END:VEVENT", …)` string surgery in `generateEventIcs` / `createExceptionVevent` / `addExdateToIcs` because `ical-generator` doesn't emit RRULE, CATEGORIES, or EXDATE where they belong.

## Solution

Migrate to `ical.js` (Mozilla, MPL 2.0) — the library Thunderbird uses for calendar parsing. It handles VTIMEZONE, DST, RRULE expansion, EXDATE, RDATE, exceptions via RECURRENCE-ID, and round-trip serialization natively.

The migration takes the opportunity to:

1. **Relocate ICS logic to `@miguelarios/pim-core`** under a dedicated `ics` submodule. Both `cal-mcp` and the future `tasks-mcp` (separate package, not built today but anticipated per Todoist task and GitHub issue #16) will import from the shared module. `cal-mcp` becomes purely a CalDAV transport + MCP tool layer — no ICS string manipulation.
2. **Fix all seven correctness gaps** listed above as part of the migration, since each is either a natural consequence of using `ical.js` properly (items 1, 3, 4, 5) or a small follow-on change enabled by it (items 2, 6, 7). Behavior tests that assert the *old* (incorrect) behavior are updated with the correct expectations.

Two PRs:

- **PR1** — `pim-core` v0.6.0. New `ics/` submodule implemented on `ical.js`, full fixture+oracle test suite covering all 7 correctness items, ready for consumption.
- **PR2** — `cal-mcp` v0.10.0. Delete `src/ical.ts` and `src/__tests__/ical.test.ts`. Flip imports to `@miguelarios/pim-core/ics`. Remove `node-ical` and `ical-generator` from `package.json`. Bump `@miguelarios/pim-core` peer to `^0.6.0`.

## Architecture

### Package layout

```
packages/core (@miguelarios/pim-core, 0.5.0 → 0.6.0)
└── src/
    ├── ics/                          ← NEW submodule
    │   ├── index.ts                  ← public barrel
    │   ├── types.ts                  ← ParsedEvent, ParsedTodo, ParsedJournal, ParsedAlarm, TimeRange, EventCreateProps
    │   ├── parse-events.ts           ← parseIcsEvents (uses ICAL.Event)
    │   ├── parse-todos.ts            ← parseIcsTodos
    │   ├── parse-journals.ts         ← parseIcsJournals
    │   ├── generate.ts               ← generateEventIcs (emits VTIMEZONE)
    │   ├── components.ts             ← createExceptionComponent, combineIcsComponents, addExdateToIcs
    │   ├── rrule.ts                  ← normalizeRecurrenceRule
    │   ├── errors.ts                 ← IcsParseError, IcsGenerateError
    │   └── _shared.ts                ← internal helpers (parseAttendees, parseOrganizer, parseAlarms, parseCategories, parseGeo, formatTriggerHuman)
    └── __tests__/ics/
        ├── fixtures/                 ← borrowed ical.js fixtures (MPL 2.0 headers preserved) + synthesized + *.oracle.json pairs
        ├── fixture-runner.test.ts
        ├── parse-events.unit.test.ts
        ├── parse-todos.unit.test.ts
        ├── parse-journals.unit.test.ts
        ├── generate.test.ts
        ├── generate-vtimezone.test.ts
        ├── components.test.ts
        ├── rrule.test.ts
        └── errors.test.ts

packages/cal-mcp (@miguelarios/cal-mcp, 0.9.0 → 0.10.0)
├── src/ical.ts                       ← DELETED
├── src/services/CalDavService.ts     ← imports from @miguelarios/pim-core/ics
├── src/tools/calendarTools.ts        ← imports from @miguelarios/pim-core/ics
└── src/__tests__/ical.test.ts        ← DELETED (superseded by pim-core tests)
```

### Dependency changes

- `pim-core`: add `ical.js ^2.2.1` and `@touch4it/ical-timezones ^1.9.0` (the latter sourced for VTIMEZONE blocks emitted by `generateEventIcs` per item 2 — provides pre-built VTIMEZONE strings for the IANA set).
- `cal-mcp`: remove `node-ical` and `ical-generator`; bump `@miguelarios/pim-core` peer to `^0.6.0`.

### `pim-core` package export map

```json
"exports": {
  ".": "./dist/index.js",
  "./ics": "./dist/ics/index.js"
}
```

Call sites use `import { parseIcsEvents } from "@miguelarios/pim-core/ics"`. Submodule path gives namespace-style grouping without object-wrapping the function exports.

## Components

### Public API (from `@miguelarios/pim-core/ics`)

**Types:**
- `ParsedAlarm` — unchanged from current `cal-mcp/src/ical.ts`.
- `ParsedEvent` — current shape plus one new optional field `rdates: string[] | null` (item 4 RDATE support).
- `ParsedTodo` — new. Fields: `uid`, `title`, `due`, `completed`, `percent_complete`, `priority`, `status`, `description`, `categories`, `attendees`, `organizer`, `alarms`, `recurrence_rule`, `created`, `last_modified`, `occurrence_date`.
- `ParsedJournal` — new. Fields: `uid`, `title`, `date`, `description`, `categories`, `status`, `created`, `last_modified`.
- `TimeRange` — unchanged.
- `EventCreateProps` — unchanged.

**Parse functions:**
- `parseIcsEvents(ics: string, range?: TimeRange, timezone?: string): ParsedEvent[]`
- `parseIcsTodos(ics: string): ParsedTodo[]`
- `parseIcsJournals(ics: string): ParsedJournal[]`

**Generate:**
- `generateEventIcs(props: EventCreateProps): string` — emits a VTIMEZONE block when `props.timezone` is set.

**Update helpers:**
- `createExceptionComponent(masterIcs: string, componentType: "vevent" | "vtodo", occurrenceDate: string, overrides: ExceptionOverrides, allDay: boolean): string` — replaces today's `createExceptionVevent` with a generalized component-type parameter so future `tasks-mcp` can reuse for VTODO exceptions.
- `combineIcsComponents(masterIcs: string, exceptionComponent: string): string` — parses both sides as `ICAL.Component`, replaces any existing subcomponent with matching UID + RECURRENCE-ID, adds the new one.
- `addExdateToIcs(ics: string, occurrenceDate: string, allDay: boolean): string` — parses, appends EXDATE via `addProperty`, serializes.

**RRULE:**
- `normalizeRecurrenceRule(rule: string): string | null` — unchanged signature and behavior, but internal validation via `ICAL.Recur.fromString(rule)` replaces the hand-rolled regex.

**Errors:**
- `IcsParseError` — thrown by all parse functions on structurally invalid input.
- `IcsGenerateError` — thrown by `generateEventIcs` on invalid inputs (bad RRULE, bad ISO date, attendees-without-organizer).

### Internal helpers (not re-exported)

`_shared.ts` exposes property extractors that take an `ICAL.Component` and return the shared property shape:

- `parseAttendees(component)` → `Array<Attendee>`
- `parseOrganizer(component)` → `Organizer | null`
- `parseAlarms(component)` → `ParsedAlarm[]`
- `parseCategories(component)` → `string[]`
- `parseGeo(component)` → `{ latitude, longitude } | null`
- `formatTriggerHuman(seconds)` → `string`

Consumed identically by `parse-events.ts`, `parse-todos.ts`, and `parse-journals.ts` because these properties have identical syntax across VEVENT/VTODO/VJOURNAL per the spec. Asymmetry lives only at the top-level dispatch (where the three component types legitimately differ); symmetry lives in the shared extractors.

### What the migration removes

From `cal-mcp/src/ical.ts` (entire file deleted, no equivalent in pim-core):

- `getTzOffsetMs` — ical.js carries timezone context in `ICAL.Time` instances.
- `extractWallClockInTz` — same.
- `wallClockInTzToUtc` — same.
- `correctOccurrenceUtc` — `ICAL.Event.iterator()` already returns correct UTCs.
- `extractDtstartWallClockFromIcs` — ical.js reads DTSTART + VTIMEZONE deterministically.
- `extractExdatesFromIcs` — ical.js handles all EXDATE forms natively.

Six helpers, ~180 lines of workaround code, all gone.

## Data Flow

### `parseIcsEvents(ics, range, timezone)` — recurring VEVENT with exceptions and TZID

1. `ICAL.Component.fromString(ics)` → root vcalendar component. On parse error, catch and rethrow as `IcsParseError`.
2. `root.getAllSubcomponents("vevent")` → array of VEVENT components (master + zero or more exceptions).
3. Group by UID.
4. For each UID group:
   - Instantiate `const event = new ICAL.Event(master)`.
   - For each exception VEVENT in the group: `event.relateException(new ICAL.Event(exVevent))`.
   - If `event.isRecurring()` and `range` provided:
     - `const it = event.iterator()`
     - While `next = it.next()` is before `range.end`:
       - `const details = event.getOccurrenceDetails(next)` — returns `{ startDate, endDate, item }`. If an exception matches this occurrence's RECURRENCE-ID, `details.item` is the exception; otherwise it's the master.
       - Emit `ParsedEvent` using the effective component's shared properties + the occurrence's start/end.
     - EXDATEs are skipped automatically by the iterator. RDATEs are emitted automatically.
   - Else (non-recurring or no range): emit master as one `ParsedEvent`; emit each exception as one `ParsedEvent` with `occurrence_date` set from its RECURRENCE-ID.
5. Return accumulated `ParsedEvent[]`.

Nothing in this flow references tzdata fallbacks, occurrence-level UTC reconversion, or raw-ICS regex extraction.

### `generateEventIcs(props)` — recurring event with TZID

1. `new ICAL.Component(["vcalendar", [], []])`.
2. Set `prodid`, `version` (`2.0`).
3. If `props.timezone`: fetch `ICAL.TimezoneService.get(props.timezone).component`, add as subcomponent (emits VTIMEZONE block — item 2).
4. Create VEVENT subcomponent. Set UID, SUMMARY, STATUS, DTSTART, DTEND (with TZID parameter if `props.timezone`).
5. Set optional properties (LOCATION, DESCRIPTION, TRANSP, ORGANIZER, URL, CATEGORIES) via `addPropertyWithValue`. No string replacement.
6. For each attendee: build an ATTENDEE property via `ICAL.Property` with correct CUTYPE/PARTSTAT/ROLE params.
7. If `props.recurrence_rule`: `vevent.addProperty(ICAL.Property.fromString(`RRULE:${normalizeRecurrenceRule(rule)}`))`.
8. For each alarm: build a VALARM subcomponent with TRIGGER/ACTION properties.
9. Return `calendar.toString()`.

### `combineIcsComponents(masterIcs, exceptionComponent)` — the update hot path

1. `masterRoot = ICAL.Component.fromString(masterIcs)`.
2. Parse `exceptionComponent` (which is just the VEVENT/VTODO block) by wrapping it in a synthetic VCALENDAR and extracting the first subcomponent.
3. Read the exception's RECURRENCE-ID value.
4. Find any existing subcomponent in `masterRoot` with matching UID + RECURRENCE-ID. If present, remove via `masterRoot.removeSubcomponent(existing)`.
5. `masterRoot.addSubcomponent(exceptionComponent)`.
6. Return `masterRoot.toString()`.

Round-trip preserves unknown X- properties and server-added lines that the current regex implementation can lose when its match boundaries are off.

## Error Handling

### Parse-phase errors

**Structurally invalid ICS** — `ICAL.parse` throws. Caught by each parse function and rethrown as `IcsParseError` with `cause: originalError`. Current behavior (`node-ical` returns `{}`) silently drops malformed calendars; the new typed error is strictly better for callers.

**Individual component malformed within an otherwise-valid calendar** — e.g., one bad VEVENT among 50. Each parse function iterates with per-component try/catch and skips malformed ones. Matches current `node-ical` behavior (silent skip). Return shape stays `ParsedEvent[]` — no diagnostics array in this migration. If diagnostics become useful later, add a sibling `parseIcsEventsWithDiagnostics` without touching the existing export. YAGNI applies.

**Missing VTIMEZONE for a referenced TZID** — ical.js's `TimezoneService` is initialized at module load with the full IANA tzdata set (covers every real CalDAV server). For the rare case of a non-IANA custom TZID with no inline VTIMEZONE block, ical.js's built-in fallback treats the time as floating, which matches what the user sees in the ICS content.

**Invalid RRULE on a VEVENT** — `ICAL.Recur.fromString` throws. Caught at per-event granularity; the event is emitted as non-recurring (matches current observable behavior where `rrule.js` returns `[]` for unparseable rules, making the event look non-recurring).

### Generate-phase errors

`generateEventIcs` throws `IcsGenerateError` up front for:

- `props.start` / `props.end` not a valid ISO timestamp.
- `props.recurrence_rule` not a valid RRULE (reuses `normalizeRecurrenceRule`).
- `props.attendees` non-empty but `props.organizer` missing (RFC 6638; strict CalDAV servers 412 otherwise).

Current tool-layer code already enforces the organizer rule in `cal-mcp/src/tools/calendarTools.ts`. Moving the check into `generateEventIcs` means any future caller gets the same safety.

### Update-helper errors

`combineIcsComponents` and `addExdateToIcs` parse their input; if the input is structurally invalid, they throw `IcsParseError`. Current regex-based implementations silently produce broken output on parse failure — this is strictly better.

### Explicitly rejected approaches

- No automatic repair of malformed input. If the server sends garbage, refuse to parse rather than heuristically patch. Repair-on-parse hides server bugs.
- No fallback to a different parsing library on ical.js errors. One library, one failure mode.
- No `null` returns on top-level parse failures. Downstream needs to distinguish "empty calendar" from "unreadable content" — typed errors are the discriminator.

## Testing

### Fixture corpus

Borrowed verbatim from ical.js's test suite at `src/test/` (MPL 2.0; each file keeps its original content plus an `MPL-2.0` header comment noting origin):

- `recur_instances.ics` — recurring with EXDATEs and RECURRENCE-ID exceptions.
- `timezone_from_file.ics` — VEVENT with custom VTIMEZONE block.
- `daily_recur.ics` — DAILY with UNTIL.
- `minimal.ics` — smallest legal VEVENT.
- `rdate_exdate.ics` — RDATE + EXDATE on a recurring event (covers items 3 and 4).
- `multiple_rrules.ics` — VEVENT with two RRULEs (covers item 5 directly).
- `recur_instances_finite.ics` — finite COUNT-based RRULE.
- `parserv2.ics` — ical.js's own stress test with unusual property params.
- `forced_types.ics` — properties with explicit `VALUE=` typing.
- `utc_negative_zero.ics` — edge case for TZ offset handling.

Plus synthesized fixtures we write ourselves:

- `dst_transition.ics` — RRULE crossing a DST boundary. ical.js's test suite doesn't have a focused one; this is the item-1 regression test.
- `vtodo_basic.ics` — minimal VTODO.
- `vtodo_with_due_completed.ics` — VTODO with DUE and COMPLETED.
- `vjournal_basic.ics` — minimal VJOURNAL.

Total: ~14 fixture files. Location: `packages/core/src/__tests__/ics/fixtures/`.

### Oracle files

Each fixture is paired with a hand-written `*.oracle.json` file containing the expected `ParsedEvent[]` / `ParsedTodo[]` / `ParsedJournal[]` output. Oracles are derived from RFC 5545 first principles — read the ICS, compute correct output by hand, commit the oracle, then implement the parser until tests pass. TDD in the strict sense: oracle commits precede implementation commits.

```
fixtures/
├── recur_instances.ics
├── recur_instances.oracle.json
├── dst_transition.ics
├── dst_transition.oracle.json
├── …
```

### Test file layout

```
packages/core/src/__tests__/ics/
├── fixtures/                          ← 14 files + paired oracles
├── fixture-runner.test.ts             ← data-driven: for each fixture, parse + deep-equal against oracle
├── parse-events.unit.test.ts          ← targeted cases not warranting a fixture
├── parse-todos.unit.test.ts
├── parse-journals.unit.test.ts
├── generate.test.ts                   ← round-trip: generate → parse → assert shape preserved
├── generate-vtimezone.test.ts         ← asserts output contains BEGIN:VTIMEZONE…END:VTIMEZONE (item 2)
├── components.test.ts                 ← createExceptionComponent, combine, addExdate
├── rrule.test.ts                      ← normalizeRecurrenceRule, valid + invalid
└── errors.test.ts                     ← IcsParseError / IcsGenerateError propagation
```

### Correctness-item coverage map

Each of the 7 correctness items has a test that would fail against today's `cal-mcp/src/ical.ts` and pass after migration:

1. **DST-correct RRULE expansion** → `dst_transition.ics` oracle asserts 3am-EST → 3am-EDT transition produces correct wall-clock occurrences.
2. **VTIMEZONE emission on generate** → `generate-vtimezone.test.ts` asserts output includes the block.
3. **Multi-line / TZID-bearing EXDATE** → covered by `recur_instances.ics` oracle plus a dedicated unit test.
4. **RDATE support** → `rdate.ics` oracle includes RDATEs in the occurrence list.
5. **Multiple RRULEs in one VEVENT** → dedicated unit test with a synthesized ICS (rare enough not to warrant a fixture file).
6. **Floating-time correctness** → dedicated unit test. Oracle: floating `DTSTART:20260601T090000` (no Z, no TZID) with `parseIcsEvents(ics, undefined, "America/Chicago")` resolves to `2026-06-01T14:00:00Z`, not `2026-06-01T09:00:00Z`. Asserts the intentional behavior change.
7. **VTODO/VJOURNAL parsing** → entire `parse-todos.unit.test.ts` and `parse-journals.unit.test.ts` plus their fixtures.

### `cal-mcp` test handling in PR2

- Delete `cal-mcp/src/__tests__/ical.test.ts` (1627 lines; superseded by pim-core coverage).
- Keep `CalDavService.test.ts` and `calendarTools.test.ts` — they test CalDAV transport and MCP tool surface, not ICS parsing. Their existing mocks use hand-written ICS strings; update only where item-6 (floating-time) makes an existing expectation semantically wrong.
- No new integration fixtures in `cal-mcp`. The contract between the two packages is `parseIcsEvents: (ics) => ParsedEvent[]` — fully covered in pim-core.

### Pre-PR2 live-calendar smoke test

Before flipping `cal-mcp` imports in PR2, run pim-core's full fixture+oracle suite *extended* with a local-only dataset of live-captured ICS from the actual Mailbox.org and Nextcloud calendars. One-time check, not committed (PII + assumption is that fixture coverage is sufficient).

Outcome rules:

- **Smoke passes clean** → ship PR2 with the ical.js-borrowed corpus alone. Lazy-augmentation posture holds.
- **Smoke fails on a nuance specific to our servers** → add scrubbed Mailbox.org- or Nextcloud-specific fixtures to the committed corpus to cover the nuance, then ship.

This honors the "CalDAV is old, I'm not solving new problems" framing: fixtures reflecting real server quirks only land when a real server quirk is observed.

## What this migration explicitly does *not* do

- Add Google Calendar / Apple iCloud / Outlook provider support. That is a separate Todoist task (`6gQGcqjJWHxwXPRW`) and is architecturally orthogonal to ICS parsing.
- Build `tasks-mcp`. VTODO/VJOURNAL parsers ship in pim-core as part of this migration (`wide move` decision), but no consuming package is built in this work. When `tasks-mcp` lands, it imports the already-available parsers from `@miguelarios/pim-core/ics`.
- Change the `span:future` RRULE splitting / exception / EXDATE features on `update_event` / `delete_event`. Those are separate Todoist items; they consume the ICS primitives this migration ships and become easier to implement, but they are not in scope here.
- Refactor `cal-mcp/src/services/CalDavService.ts` beyond swapping its `ical.js` imports.
- Add a diagnostics array to parse-function return shapes. Defer to a follow-up if diagnostics prove useful.

## Risks and mitigations

**Risk: the oracle files are wrong.**

Oracle files are hand-written from the RFC and can themselves contain mistakes. Mitigation: each oracle is reviewed in isolation against the spec before the corresponding implementation lands; the borrowed ical.js fixtures come with the library's own tests that exercise the same inputs (cross-check against ical.js's assertions before writing our oracle).

**Risk: a downstream caller silently depends on today's incorrect floating-time behavior (item 6).**

The only downstream caller today is `cal-mcp` itself. `cal-mcp`'s tests that exercise floating-time code paths will fail when the new behavior ships; we update them to assert the new (correct) behavior in PR2. No external consumers of `pim-core` exist outside the monorepo.

**Risk: `ical.js` has its own bugs we inherit.**

Trade-off: inheriting ical.js bugs (well-known, fixable upstream, used in Thunderbird's production codebase) is strictly preferable to maintaining `node-ical` + `ical-generator` workarounds (two libraries, inconsistent coverage, no shared maintainer). Fallback is upstream-PR-if-critical, regex-workaround-locally-if-blocker.

**Risk: PR1 lands but PR2 stalls, leaving pim-core with a new module nobody uses.**

Mitigation: PR2 is mechanical (delete file, flip imports). Target PR2 merge within one week of PR1 merge. If genuinely blocked, pim-core `ics` is still a valid published module — the future `tasks-mcp` consumes it regardless.

## Outcome

- ~35% less source code at the same capability (740 lines → ~470), or ~20% less while also adding VTODO and VJOURNAL parsing.
- Six workaround helpers deleted (~180 lines).
- Three regex-on-raw-ICS surgical-edit patterns eliminated from `generateEventIcs` / `createExceptionVevent` / `addExdateToIcs`.
- Six `(vevent as any)` escape hatches replaced with properly-typed ical.js interfaces.
- Two dependencies removed (`node-ical`, `ical-generator`), one added (`ical.js`).
- Seven pre-existing correctness gaps closed with explicit test coverage.
- `cal-mcp` simplified to CalDAV transport + MCP tool surface; future `tasks-mcp` has a ready-to-use VTODO parser without duplication risk.
