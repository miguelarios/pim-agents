# card-mcp Address Book Management — Implementation Plan

> **For agentic workers:** steps use checkbox (`- [x]`) syntax for tracking. Design doc:
> `docs/superpowers/specs/2026-08-24-card-mcp-address-books-design.md`.

**Goal:** Give `card-mcp` the four address-book lifecycle tools (#54 list, #55 create,
#56 rename, #57 delete) and let every `addressBook` parameter take a display name instead
of a URL.

**Architecture:** Service methods land in `CardDavService`; the four tools live in a new
`tools/addressBookTools.ts` with valibot output schemas in `tools/addressBookSchemas.ts`;
`tools/index.ts` becomes the single source of registration order. No `pim-core` changes —
the existing `ErrorCode` vocabulary and MCP facade cover everything.

**Tech Stack:** TypeScript strict ESM, Vitest (`vi.mock("tsdav")`), Biome, tsdav 2.1.x,
`@modelcontextprotocol/server` v2.

## Global Constraints

- **Branch:** `claude/v1-roadmap-planning-t3kzob`, restarted from `origin/main` after
  PR #63's squash-merge (this plan's docs commit rebased on top). Commit after every
  green test cycle.
- **Before pushing:** `npm test && npm run lint && npm run typecheck` from the repo root,
  all green.
- **TDD:** failing test first, then implementation. No exceptions.
- **PII:** synthetic data only — `Alice Smith`/`alice@example.com`, `example.com`, and
  book names `Personal`/`Work`/`PIM-Test`.
- **Style:** double quotes, 2-space indent, semicolons, valibot (not Zod).
- **Do not use `client.makeCollection()`** — it emits MKCOL XML with no namespace
  declarations (see the design doc). Use `client.davRequest()` with `_attributes` inside
  the root element.
- **Never judge a DAV response on `ok` alone** — `ok` is `!responseBody.error`, so a 207
  wrapping a 403 propstat reports `ok: true`. Check the numeric `status` — and for
  PROPPATCH not the mapped `status` alone either: a propstat-level failure leaves it at
  207 (a 2xx), so walk `raw.multistatus.response[].propstat[].status` too (see the
  design doc's response-validation section).

## File Structure

**Created:**
- `packages/card-mcp/src/tools/addressBookSchemas.ts` — valibot output schemas
- `packages/card-mcp/src/tools/addressBookTools.ts` — the four `ToolDef`s
- `packages/card-mcp/src/tools/index.ts` — `CARD_TOOLS` (registration order)
- `packages/card-mcp/src/__tests__/addressBookTools.test.ts`

**Modified:**
- `packages/card-mcp/src/services/CardDavService.ts` — create/rename/delete/count + `findAddressBook`
- `packages/card-mcp/src/tools/contactTools.ts` — `resolveAddressBook` accepts a name
- `packages/card-mcp/src/main.ts` — register `CARD_TOOLS`, update `instructions`
- `packages/card-mcp/src/__tests__/CardDavService.test.ts` — extended tsdav mock + new cases
- `packages/card-mcp/src/__tests__/contactTools.test.ts` — name-resolution cases
- `packages/card-mcp/src/__tests__/roundtrip.test.ts` — `CARD_TOOLS`, new fake methods
- `packages/card-mcp/package.json` — 0.5.0 → 0.6.0
- `packages/card-mcp/CHANGELOG.md`, `packages/card-mcp/README.md`
- `docs/tools/card-mcp.md`, `docs/testing/live-smoke.md` (§4)

---

## Task 1: Extend the tsdav mock (foundation)

**Files:** `packages/card-mcp/src/__tests__/CardDavService.test.ts`

- [x] **Step 1.1:** Add to the `vi.mock("tsdav")` client: `account: { homeUrl: "/dav/addressbooks/users/miguel/", rootUrl: "/dav/" }`, `davRequest: vi.fn().mockResolvedValue([{ ok: true, status: 201, statusText: "Created" }])`, `deleteObject: vi.fn().mockResolvedValue({ ok: true, status: 204 })`, `propfind: vi.fn().mockResolvedValue([])`.
- [x] **Step 1.2:** Run the suite — still green, nothing uses them yet.

## Task 2: `findAddressBook` — resolve a name or URL to a URL

**Files:** `CardDavService.ts`, `CardDavService.test.ts`

- [x] **Step 2.1: Failing tests.** `findAddressBook("Work")` → the Work URL; `findAddressBook("work")` → same (case-insensitive); `findAddressBook("/dav/…/contacts/")` and `findAddressBook("https://…")` → returned verbatim **without** calling `fetchAddressBooks`; unknown name → `ContactError` with `ADDRESSBOOK_NOT_FOUND` whose message lists `Contacts, Work`; two books both named `Work` → `ADDRESSBOOK_NOT_FOUND` listing both URLs.
- [x] **Step 2.2:** Implement `async findAddressBook(ref: string): Promise<string>` on the service. URL detection: `/^(https?:\/\/|\/)/`.
- [x] **Step 2.3:** Commit — `feat(card-mcp): resolve an address book by display name`.

## Task 3: Contact tools accept a book name

**Files:** `contactTools.ts`, `contactTools.test.ts`

- [x] **Step 3.1: Failing tests.** `list_contacts` with `addressBook: "Work"` calls `fetchContacts` with the Work URL; with a URL, passes it through; omitted, still uses the first book; an unknown name returns `isError` with `ADDRESSBOOK_NOT_FOUND`.
- [x] **Step 3.2:** Change `resolveAddressBook(explicit, service)` to delegate to `service.findAddressBook(explicit)` when `explicit` is set; keep the first-book fallback and its `ADDRESSBOOK_NOT_FOUND` for the empty-account case.
- [x] **Step 3.3:** Update the `ADDRESS_BOOK_PROP` description: *"Address book URL or display name (e.g. 'Work'). If omitted, uses the first available address book."*
- [x] **Step 3.4:** Full package suite, then commit — `feat(card-mcp): accept an address book name wherever a URL was required`.

## Task 4: `listAddressBooks` gains description, syncToken, and opt-in counts

**Files:** `CardDavService.ts`, `CardDavService.test.ts`

- [x] **Step 4.1: Failing tests.** Existing shape still returned (displayName/url/ctag); `description` and `syncToken` surface when tsdav supplies them; `listAddressBooks({ includeCounts: true })` issues one `propfind` per book at `depth: "1"` with only `d:getetag` and sets `contactCount` from the hrefs below the collection; without the flag, `propfind` is never called; a book whose count PROPFIND rejects yields `contactCount: undefined`, not a failed call.
- [x] **Step 4.2:** Widen the `AddressBook` interface and implement. Count = responses whose `href` is not the collection URL itself (compare with trailing slashes normalised).
- [x] **Step 4.3:** Commit — `feat(card-mcp): surface description, sync token, and opt-in contact counts`.

## Task 5: `createAddressBook`

**Files:** `CardDavService.ts`, `CardDavService.test.ts`

- [x] **Step 5.1: Failing tests.**
  - `createAddressBook({ displayName: "Work Contacts" })` calls `davRequest` with `method: "MKCOL"`, url `<homeUrl>work-contacts/`, and a body whose root element carries `xmlns:d`/`xmlns:card` and whose prop sets `resourcetype` to collection + `card:addressbook` and `displayname` to `Work Contacts`.
  - A `description` adds `card:addressbook-description`.
  - An explicit `slug` is used as given; an invalid slug (`"Bad Slug"`, `"../escape"`) throws `ValidationError` before any request.
  - A displayName that slugifies to nothing (`"!!!"`) falls back to `addressbook-<hex>`.
  - A displayName that case-insensitively equals an existing book's (`"work"` vs `Work`)
    → `OPERATION_FAILED` naming the existing book's URL, and **no request is issued** —
    a duplicate name would make name resolution ambiguous forever.
  - A *differently named* book that slugifies to an existing book's slug becomes `…-2`.
  - Status 405 → `OPERATION_FAILED` mentioning that a collection already exists; 403/501 → `OPERATION_FAILED` naming the provider limitation; both without `ok: false` being present on the response (the 207-lies case).
  - Returns `{ url, displayName }`.
- [x] **Step 5.2:** Implement, including a `checkCollectionResponse(status, statusText, action, url)` helper used by tasks 5–7.
- [x] **Step 5.3:** Commit — `feat(card-mcp): create address books via extended MKCOL`.

## Task 6: `renameAddressBook`

**Files:** `CardDavService.ts`, `CardDavService.test.ts`

- [x] **Step 6.1: Failing tests.** `PROPPATCH` to the book URL with a namespaced `d:propertyupdate` body setting `displayname`; `description` sets `card:addressbook-description`; neither given → `ValidationError`, no request; 404 → `ADDRESSBOOK_NOT_FOUND`. The propstat-failure case must use the shape tsdav actually produces — `{ ok: true, status: 207, raw: { multistatus: { response: { propstat: { status: "HTTP/1.1 403 Forbidden" } } } } }` (keys camelCased, namespaces stripped) — and expect `OPERATION_FAILED`: the mapped `status` stays 207 (a 2xx) in this shape, so the implementation has to walk the raw propstat statuses, and a mock with `status: 403` would pass against code that misses exactly this case.
- [x] **Step 6.2:** Implement.
- [x] **Step 6.3:** Commit — `feat(card-mcp): rename an address book via PROPPATCH`.

## Task 7: `deleteAddressBook`

**Files:** `CardDavService.ts`, `CardDavService.test.ts`

- [x] **Step 7.1: Failing tests.** Calls `deleteObject` with the book URL; 404 → `ADDRESSBOOK_NOT_FOUND`; 403 → `OPERATION_FAILED` mentioning a read-only book; 204 and 200 both succeed.
- [x] **Step 7.2:** Implement.
- [x] **Step 7.3:** Commit — `feat(card-mcp): delete an address book collection`.

## Task 8: Output schemas

**Files:** `tools/addressBookSchemas.ts`

- [x] **Step 8.1:** `addressBookListSchema` (`{ addressBooks: [...], count }`) and `addressBookWriteResultSchema` (`{ status: picklist(["created","renamed","deleted"]), url, displayName? }`), mirroring the shapes in the design doc. Optional fields via `v.optional`.
- [x] **Step 8.2:** No standalone test — the schemas are exercised through the tool tests and the roundtrip suite, which validate `structuredContent` against the advertised schema.

## Task 9: The four tools

**Files:** `tools/addressBookTools.ts`, `__tests__/addressBookTools.test.ts`

- [x] **Step 9.1: Failing tests** (via `dispatchTool`, mirroring `contactTools.test.ts`):
  - `list_address_books` returns `{ addressBooks, count }`; `include_counts: true` reaches the service as `{ includeCounts: true }`.
  - `create_address_book` returns `{ status: "created", url, displayName }`; a service throw becomes `isError` with the mapped code.
  - `rename_address_book` resolves `addressBook` through `findAddressBook` and returns `{ status: "renamed", url, displayName }`.
  - `delete_address_book` returns `input_required` on the first call, deletes on the confirmed retry, and returns `CONFIRMATION_DECLINED` without deleting when declined — the `delete_contact` test cases, retargeted.
  - `delete_address_book`'s elicitation message names the book and its contact count.
  - `create_address_book`/`rename_address_book`/`delete_address_book` all require their target — omitting it is a schema rejection, not a first-book fallback.
- [x] **Step 9.2:** Implement the four `ToolDef`s. Annotations: list = `readOnlyHint: true, destructiveHint: false, idempotentHint: true`; create = all-write, `idempotentHint: false`; rename = write, `idempotentHint: true`; delete = `destructiveHint: true, idempotentHint: true`. `openWorldHint: true` throughout.
- [x] **Step 9.3:** For delete: resolve the book and count its contacts **before** `confirmDestructive`, so the prompt names both. (The confirmed retry re-enters the handler and re-resolves + re-counts — accepted, per the design doc.)
- [x] **Step 9.4:** Commit — `feat(card-mcp): add the address book management tools`.

## Task 10: Registration and wire conformance

**Files:** `tools/index.ts`, `main.ts`, `__tests__/roundtrip.test.ts`

- [x] **Step 10.1:** `tools/index.ts` exports `CARD_TOOLS = [...CONTACT_TOOLS, ...ADDRESS_BOOK_TOOLS]` and re-exports both arrays.
- [x] **Step 10.2:** `main.ts` registers `CARD_TOOLS`; extend `instructions` with a sentence on address books ("call list_address_books to discover books, then pass the name as addressBook").
- [x] **Step 10.3:** Roundtrip test: swap `CONTACT_TOOLS` for `CARD_TOOLS` in the three list assertions, add the new methods to `fakeService()`, and add a `delete_address_book` confirm-then-delete case on both eras.
- [x] **Step 10.4:** `npm test && npm run lint && npm run typecheck`, then commit — `test(card-mcp): drive the address book tools over the wire`.

## Task 11: Docs and release

**Files:** README, CHANGELOG, `docs/tools/card-mcp.md`, `docs/testing/live-smoke.md`, `package.json`

- [x] **Step 11.1:** `docs/tools/card-mcp.md` — four new tool sections in the house format (parameter tables, output blocks), and note on the `addressBook` parameter that a display name is accepted.
- [x] **Step 11.2:** README tool table gains the four rows; the confirmation paragraph names `delete_address_book` alongside `delete_contact`.
- [x] **Step 11.3:** `docs/testing/live-smoke.md` §4 — steps for create → list (with counts) → rename → put a contact in it by name → delete, and drop the "pass the URL explicitly" caveat now that names work.
- [x] **Step 11.4:** `package.json` 0.5.0 → 0.6.0 and a `## 0.6.0 (2026-08-24)` CHANGELOG section. Per `CLAUDE.md`, merging is the release.
- [x] **Step 11.5:** Commit — `docs(card-mcp): document address book management` + `chore(release): card-mcp 0.6.0`.

---

## Verification

- [x] `npm test` — the 3 card-mcp suites plus the new one, all green
- [x] `npm run lint && npm run typecheck` green
- [ ] `list_address_books` → `create_address_book` → `create_contact` with the new book's
      **name** → `rename_address_book` → `delete_address_book` runs end to end against a
      live server (live-smoke §4)
- [ ] Closes #54, #55, #56, #57 (on merge)
