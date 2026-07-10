# card-mcp: Parser & Output Quality Fixes

**Date:** 2026-04-13
**Packages:** `@miguelarios/pim-core` + `@miguelarios/card-mcp`
**Status:** Implemented (card-mcp 0.3.0 / pim-core 0.5.0, PR #30)

## Problem

QA via mcporter against a 636-contact production address book surfaced multiple output-quality defects:

1. **iOS `itemN.` group syntax is silently dropped.** Properties like `item1.ADR;type=HOME;type=pref:;;789 Pine Rd;Anytown;ST;00000;United States` fall into `otherProperties` as raw strings instead of being parsed into `addresses[]`. The iOS Contacts app writes phones, emails, URLs, addresses, and X-SOCIALPROFILE using this grouping pattern, so most iOS contacts have empty `addresses[]` arrays today.
2. **TYPE param value noise.** `emails[].type` and `phones[].type` surface as `"internet,work,pref"` and `"cell,voice,pref"` — RFC-level format tokens (`internet`, `voice`) and priority modifiers (`pref`) that are meaningless to consumers.
3. **Quote-wrapped TYPE values.** Older macOS 12.6 exports produce `TYPE="internet"` — current regex captures the leading `"` into the typed value (`"\"internet"`).
4. **Massive list payloads.** `list_contacts` returns 25 MB for 636 contacts because embedded `PHOTO;ENCODING=b` JPEG binaries and encrypted Apple `X-ADDRESSING-GRAMMAR` blobs pass through raw.
5. **`resolve_contact` silent ambiguity.** "Alice" matches four contacts; tool returns Alice Brown with no indication the other three exist. For a `send email to [name]` workflow this is a silent wrong-answer risk.
6. **`X-SOCIALPROFILE` not parsed.** Phone shows Instagram / Twitter for contacts; output buries them in `otherProperties`.

## Solution

All fixes land in `@miguelarios/pim-core` (parser) + `@miguelarios/card-mcp` (tool shape). No new dependencies — the hand-rolled parser absorbs all changes.

### 1. Strip `itemN.` group prefix

In `parseVCard`, before property-name dispatch (vcard.ts:53-78), detect and strip any leading `itemN.` token. Preserve the group ID (`itemN`) in a side-map keyed to the property, so X-ABLabel can be joined back to its property (see §3).

After stripping, `item1.ADR;type=HOME:...` is handled as `ADR;type=HOME:...` and lands in the existing `addresses[]` parser.

### 2. TYPE value normalization

After parsing TYPE params, normalize before emitting:

```
1. Split tokens (comma or semicolon separated)
2. Lowercase
3. Strip quote wrappers (fixes TYPE="internet" → internet)
4. Drop noise tokens: { "internet", "voice", "pref" }
5. If >1 token remains, join with "/" (e.g., "home/fax")
6. If 0 tokens remain after strip, fall back to "other"
```

Examples:
- `"internet,work,pref"` → `"work"`
- `"cell,voice,pref"` → `"cell"`
- `"internet,home"` → `"home"`
- `"home,fax"` → `"home/fax"`
- `"\"internet"` → `"internet"` (single-char quote wrapper stripped)

Applied uniformly to EMAIL, TEL, ADR, URL, X-SOCIALPROFILE.

### 3. Apple `X-ABLabel` resolution

iOS emits custom labels as:
```
item3.URL;type=pref:https://example.com
item3.X-ABLabel:_$!<HomePage>!$_
```

Rule: within a group (same `itemN` prefix), if `X-ABLabel` is present, it overrides the TYPE param and becomes the `type` value. Decode:

- If the label matches `_$!<(.+)>!$_`: extract the inner text, lowercase it
- Otherwise: use the label value as-is, lowercased
- If X-ABLabel is absent: fall through to normalized TYPE (§2)

Apple's standard wrapper forms (`_$!<HomePage>!$_`, `_$!<School>!$_`, etc.) → `"homepage"`, `"school"`. Custom labels pass through unchanged.

### 4. New field: `socialProfiles[]`

Extend the `Contact` interface:

```ts
export interface SocialProfile {
  type: string;     // "instagram", "twitter", "facebook", etc. (lowercased)
  handle?: string;  // from x-user param
  url?: string;     // the value after colon if it's a real URL; omit if x-apple: prefix
}

export interface Contact {
  // ...existing fields...
  socialProfiles?: SocialProfile[];
}
```

Parse `X-SOCIALPROFILE;type=<name>[;x-user=<handle>]:<url>` into this field. `x-apple:` values are app-deeplinks — drop the `url` field when the value starts with `x-apple:` (keep `type` and `handle`).

`buildVCard` round-trips the field using the same encoding.

### 5. `detail_level` param on list_contacts / get_contact

New optional parameter, **default `"summary"`** (breaking):

- `"summary"`: drops `otherProperties` entirely and drops any `photo` data. All structured fields (including new `socialProfiles`) are kept.
- `"full"`: current shape — preserves everything including raw `otherProperties` and photo binaries.

`resolve_contact` does not receive this param; it already returns a projection.

**Rationale:** `otherProperties` is a raw pass-through for round-trip integrity. LLM consumers should not see it by default. `summary` mode reduces the 25 MB full-list payload to ~2 MB (photos dominate). Callers who need round-trip fidelity (update flows) use `full`.

Additionally, a handful of Apple internal properties are known noise even in `full`:
- `PHOTO;ENCODING=b:...` — binary photo data
- `X-ADDRESSING-GRAMMAR` — encrypted Apple blob
- `PRODID`, `REV`, `X-IMAGEHASH`, `X-IMAGETYPE`, `X-SHARED-PHOTO-DISPLAY-PREF`, `X-ABADR`

These are stripped from `otherProperties` in **both** summary and full modes (they carry no semantic value for any consumer). Round-trip preservation of these is not required — they're regenerated by the CardDAV server or the client.

### 6. `resolve_contact` return shape (breaking)

Replace the current silent-best-guess behavior:

```ts
// Before
{ fullName: "Alice Brown", email: "alice@example.com" }

// After
{ status: "resolved" | "ambiguous" | "not_found",
  fullName?: string,                                       // only on "resolved"
  email?: string,                                          // only on "resolved"
  candidates?: Array<{ fullName: string; email: string; uid: string }>,  // only on "ambiguous"
  message?: string                                         // only on "not_found"
}
```

Rules:
- 0 matches → `{status: "not_found", message}`
- 1 match → `{status: "resolved", fullName, email}`
- >1 matches → `{status: "ambiguous", candidates: [...]}` (all matches enumerated, no silent best-guess)

## Contract example (Patrick Wilson, summary mode, after fixes)

```json
{
  "uid": "00000000-0000-0000-0000-000000000001",
  "fullName": "Patrick Wilson",
  "firstName": "Patrick",
  "lastName": "Wilson",
  "nickname": "Alice",
  "emails": [
    {"type": "work", "value": "alice@example.com"},
    {"type": "home", "value": "alice@example.com"}
  ],
  "phones": [
    {"type": "cell", "value": "+1-555-0100"},
    {"type": "work", "value": "+1-555-0100"}
  ],
  "addresses": [
    {"type": "home", "street": "789 Pine Rd", "city": "Anytown",
     "state": "TX", "postalCode": "00000", "country": "United States"}
  ],
  "urls": [],
  "socialProfiles": [
    {"type": "instagram", "handle": "example_user"},
    {"type": "twitter", "handle": "testhandle", "url": "http://twitter.com/testhandle"}
  ],
  "birthday": "1990-01-01",
  "note": "TI Intern\\nGoing out friend\\nDallas\\nFriends\\n"
}
```

Matches the iOS Contacts app view 1:1.

## Versioning

- `@miguelarios/pim-core` → **0.5.0** — parser output shape changes (properties that lived in `otherProperties` now move to structured fields; new `socialProfiles` field on `Contact`). Technically breaking for any consumer inspecting `otherProperties`.
- `@miguelarios/card-mcp` → **0.3.0** — breaking: `detail_level="summary"` default, `resolve_contact` shape change.

## Testing (TDD)

One failing test per fix before implementation:

**`packages/core/src/__tests__/vcard.test.ts`** (new tests):
- `itemN.` prefix strip on ADR, TEL, EMAIL, URL, X-SOCIALPROFILE (5 tests)
- TYPE normalization: noise token drop, quote wrap strip, multi-type join, zero-token fallback (4 tests)
- X-ABLabel resolution: wrapped form `_$!<HomePage>!$_`, raw form `School`, fallthrough when absent (3 tests)
- X-SOCIALPROFILE parse: Instagram with x-user + http URL, x-apple: URL drop, unknown type (3 tests)
- Apple internals stripped in `parseVCard` output (1 test — asserts PRODID/REV/X-IMAGEHASH/X-IMAGETYPE/X-SHARED-PHOTO-DISPLAY-PREF/X-ADDRESSING-GRAMMAR never appear in `otherProperties`)
- Round-trip: iOS vCard golden (Patrick-shaped) → parse → build → parse — data matches on second parse. Built vCard will be ungrouped (no `itemN.`), that's acceptable.

**`packages/card-mcp/src/__tests__/CardDavService.test.ts`** (new tests):
- `detail_level="summary"` on `getContact` drops `otherProperties` and photo (1 test)
- `detail_level="full"` preserves `otherProperties` minus the Apple-internal strip list (1 test)
- `detail_level="summary"` on `listContacts` reduces payload (1 test)

**`packages/card-mcp/src/__tests__/contactTools.test.ts`** (update existing `resolveContact` tests):
- `resolveContact` resolved path — 1 match (1 test)
- `resolveContact` ambiguous path — 2+ matches, `candidates[]` populated in alphabetical `fullName` order (1 test)
- `resolveContact` not-found path — status field present (1 test)

Total new/changed: ~23 tests.

## Non-Goals

- **Not swapping to a vCard library.** Hand-rolled parser stays — fixes total ~80 LOC across vcard.ts and CardDavService.ts. Adopting `vcard4` / `vcf` / `ical.js` would require remapping Contact interface, reworking existing 17 tests, and adding a dependency. Revisit only if further edge cases surface.
- **No pagination on `list_contacts`.** Summary mode cuts payload by ~90% — should be enough for practical contexts. Revisit if specific use cases surface.
- **X-ABLabel custom-label matching is literal.** If Apple emits something outside the `_$!<...>!$_` wrapper, we pass the raw label through lowercased — we don't try to normalize `"HomePage"` and `"Home Page"` into the same value.
- **No handling of vCard 4.0 line folding edge cases** beyond what the parser already does. We're targeting iOS-compatible vCard 3.0 output.

## Rollout

1. Core parser fixes ship together in pim-core 0.5.0.
2. card-mcp 0.3.0 bumps core dep to `^0.5.0` and adds `detail_level` + new `resolve_contact` shape.
3. All existing card-mcp tests get updated for the new summary default.
4. Release notes call out the two breaking changes (summary default, resolve_contact shape) for any downstream consumer.
