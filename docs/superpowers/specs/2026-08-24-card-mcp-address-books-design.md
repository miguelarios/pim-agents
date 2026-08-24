# card-mcp: Address Book Management

**Date:** 2026-08-24
**Packages:** `@miguelarios/card-mcp`
**Issues:** #54 (list), #55 (create), #56 (rename), #57 (delete)
**Status:** Designed, pending implementation

## Problem

`card-mcp` can read and write contacts but cannot see or manage the collections that
hold them. Three concrete consequences:

1. **Address books are invisible to the model.** `CardDavService.listAddressBooks()`
   exists but is only ever called internally, by `resolveAddressBook`, to pick the first
   book. A client has no way to enumerate what books exist, so it cannot make an informed
   choice about where a contact should go.
2. **`addressBook` is a URL-only parameter.** Every contact tool takes
   `addressBook: string` and passes it straight to tsdav as a collection URL. A model that
   has never seen the account's URL layout can only omit the parameter and hope the first
   book is the right one — which `docs/testing/live-smoke.md` §4 already calls out as a
   footgun ("card-mcp defaults to the first address book it finds, which may not be
   PIM-Test").
3. **No lifecycle operations.** Creating, renaming, and deleting books requires leaving
   the tool entirely and using a provider web UI. This also blocks #58/#59 (move/copy
   between books), which need a destination that can be named and created.

## Solution

Four new tools, one new source file for each layer, no changes to `pim-core`.

| Tool | Annotations | Notes |
|------|-------------|-------|
| `list_address_books` | readOnly, idempotent | Optional per-book contact counts |
| `create_address_book` | write, non-idempotent | Extended MKCOL (RFC 5689) |
| `rename_address_book` | write, idempotent | PROPPATCH `displayname` / `addressbook-description` |
| `delete_address_book` | destructive, idempotent | Gated on `confirmDestructive` |

Plus one cross-cutting change: **`addressBook` accepts a display name as well as a URL**
on every tool that takes it. This is what makes the suite usable — `list_address_books`
returns `"Work"`, and the model can then pass `addressBook: "Work"` to `create_contact`
without ever handling a URL.

### Address book reference resolution

A single `resolveAddressBook(ref)` helper replaces the current one:

```
ref is undefined  → first address book (unchanged behaviour, back-compat)
ref looks like a URL (starts with "http://", "https://", or "/")
                  → used verbatim, no round-trip (unchanged behaviour)
otherwise         → case-insensitive exact match on displayName across listAddressBooks()
                    0 matches → ADDRESSBOOK_NOT_FOUND, message lists the known names
                    2+ matches → ADDRESSBOOK_NOT_FOUND, message lists the matching URLs
                                 so the caller can disambiguate with one
```

Existing callers are unaffected: URLs still pass through untouched and omission still
falls back to the first book. Name resolution costs one PROPFIND, only on the name path.

For the three write tools the target is **required** — no first-book fallback. Renaming
or deleting "whichever book happened to sort first" is not a thing a caller can mean.

### Creating a book

CardDAV collection creation is extended MKCOL: `MKCOL` with a body setting
`resourcetype` to `{collection, card:addressbook}`. tsdav exposes
`client.makeCollection()`, but it **cannot be used**: `makeCollection` passes no
`attributes`, and `davRequest` places `init.attributes` at the *document* level of the
xml-js compact object, where it is silently dropped rather than landing on the root
element. The emitted body is therefore `<d:mkcol>…<card:addressbook/>` with no `xmlns:d`
or `xmlns:card` — undeclared prefixes that a conformant server rejects.

So the service issues the request through `client.davRequest()` directly, putting
`_attributes` inside the root element the way tsdav's own `propfind` and `makeCalendar`
do:

```
MKCOL <homeUrl><slug>/
<d:mkcol xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:set><d:prop>
    <d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>
    <d:displayname>Work</d:displayname>
    <card:addressbook-description>…</card:addressbook-description>  <!-- when given -->
  </d:prop></d:set>
</d:mkcol>
```

**URL derivation.** `client.account.homeUrl` (populated by `login()`) is the address book
home. The new collection URL is `homeUrl` + slug + `/`. The slug is derived from
`displayName` — lowercased, non-alphanumerics collapsed to `-`, trimmed — falling back to
`addressbook-<8 hex>` when that leaves nothing. If the slug collides with an existing
book's URL, `-2`, `-3`, … is appended. Callers who care can pass `slug` explicitly
(validated `^[a-z0-9][a-z0-9-]{0,62}$`).

**Provider support varies.** Baikal, Nextcloud, Radicale, Fastmail and iCloud implement
extended MKCOL; Google's CardDAV endpoint does not. A `403`/`405`/`501` is mapped to an
error that says so in plain language rather than surfacing a bare status code.

### Renaming a book

`PROPPATCH` with `<d:propertyupdate><d:set><d:prop><d:displayname>…`, and
`card:addressbook-description` when a description is given. At least one of the two must
be present, or the call is a no-op and is rejected as `VALIDATION_FAILED`.

### Deleting a book

Plain `DELETE` on the collection URL via `client.deleteObject({ url })`. This destroys
every contact in the book, so:

- The book is resolved **and its contacts counted** before the confirmation gate, so the
  prompt reads *"Permanently delete address book 'Work' (<url>) and all 128 contacts in
  it? This cannot be undone."* — a confirmation that names what is being destroyed.
- The gate is `confirmDestructive`, identical in mechanics to `delete_contact`
  (`PIM_MCP_CONFIRM=off` bypasses it).

### Response validation

`DAVResponse.ok` is computed as `!responseBody.error` — a `207 Multi-Status` whose
propstat carries `HTTP/1.1 403 Forbidden` still arrives with `ok: true`. Every DAV
response in this suite is therefore judged on the numeric `status` (success = 2xx), never
on `ok` alone. A single `checkCollectionResponse` helper in the service does this and maps
status to `PimError`:

| Status | Error |
|--------|-------|
| 403, 405, 501 (create) | `OPERATION_FAILED` — provider does not allow creating address books here |
| 405 (create, collection exists) | `OPERATION_FAILED` — a collection already exists at that URL |
| 403 (rename/delete) | `OPERATION_FAILED` — server refused; the book may be read-only |
| 404 | `ADDRESSBOOK_NOT_FOUND` |
| other non-2xx | `OPERATION_FAILED` with status and statusText |

### Contact counts

`include_counts: true` on `list_address_books` issues one `PROPFIND` per book at
`depth: 1` requesting only `d:getetag`, and counts the hrefs below the collection. No
vCard bodies are transferred — the expensive part of `fetchContacts` — but it is still N
round-trips, so it stays opt-in and off by default.

## Output shapes

```ts
// list_address_books
{
  addressBooks: Array<{
    displayName: string;
    url: string;
    description?: string;
    ctag?: string;
    syncToken?: string;
    contactCount?: number;   // only with include_counts: true
  }>;
  count: number;
}

// create_address_book / rename_address_book / delete_address_book
{ status: "created" | "renamed" | "deleted"; url: string; displayName?: string }
```

## Alternatives considered

**Reuse `writeResultSchema` (`{status, uid, fullName}`) for the book tools.** Rejected:
a book has no UID, and widening `status` to six values across two unrelated resource
types makes the contact result shape less legible for no gain.

**Auto-create a missing book on `create_contact`.** Rejected: silently creating a
collection because a name did not match is exactly the kind of surprise write that
`confirmDestructive` exists to prevent.

**Resolve names fuzzily (substring, like `searchContacts`).** Rejected for writes: `"work"`
matching both `Work` and `Work — Archive` and picking one is a data-loss shape. Exact,
case-insensitive matching with an explicit ambiguity error keeps the failure legible.

## Out of scope

- Move/copy contacts between books (#58, #59) — unblocked by this, delivered separately.
- Server-side `addressbook-query` search (#52) — `list_address_books` surfaces the
  `reports` set that work will key off, but nothing here changes the search path.
- Sharing/ACLs, and per-book colour or ordering properties.
