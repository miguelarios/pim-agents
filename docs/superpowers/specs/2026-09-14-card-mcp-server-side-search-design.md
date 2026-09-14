# card-mcp: Server-side search

**Date:** 2026-09-14
**Packages:** `@miguelarios/card-mcp`
**Depends on:** the cross-book lookup in card-mcp 0.9.0 and the `located` card plumbing in 0.10.1
**Issues:** #52
**Status:** Designed and implemented

## Problem

Every search and every lookup by UID read the whole address book. tsdav's `fetchVCards`
is two round trips — an `addressbook-query` for etags, then a multiget for every body —
and the filtering happened here afterwards. `resolve_contact` with no book named did that
for every book in the account; `update_contact` and `delete_contact` on an unqualified UID
did it for every book just to find which one holds the card (issue #52).

## Design

### One filtered REPORT instead of fetch-then-filter

RFC 6352 §8.6 `addressbook-query` takes a `<filter>` and can return `address-data` in the
same response. `CardDavService.queryVCards` sends one such REPORT, with `getetag` and
`address-data` requested, and gets back only the matching cards with their bodies. Two
callers use it:

- **`searchContacts`** filters on the query's **longest token** across every searched
  property (`FN`, `N`, `NICKNAME`, `EMAIL`, `TEL`, `ORG`, `TITLE`, `ROLE`, `CATEGORIES`,
  `URL`, `ADR`), `match-type="contains"`, collation `i;unicode-casemap`, `test="anyof"`.
- **`findVCard`** (behind `updateContact`, `deleteContact` and `locateContact`) filters on
  `UID` with `match-type="equals"`.

### The client rule stays the authority

A `<filter>` has one level of `prop-filter`s, so "every token, each in any property" is not
expressible: `allof` over tokens would need each token to be its own `anyof` over
properties. Sending only the longest token is the most selective single filter the REPORT
can carry, and any card matching all tokens matches that one. The existing client rule
(`matchesQuery`) then runs over the result, so what a search returns is exactly what a
whole-book fetch would have returned, from a fraction of the transfer. The server narrows;
it never decides.

The same holds for UIDs: the required collations are case-insensitive and UIDs are not, so
the UID is re-checked on the card that comes back.

Rejected: trusting the server's result as-is. Servers differ on how `contains` treats
structured properties (`N`, `ADR`) and on case folding beyond ASCII. Re-filtering costs
nothing measurable and keeps the search's contract independent of the server.

### Fallback

The REPORT is mandatory in RFC 6352, but proxies and partial implementations exist. tsdav
reports any non-2xx as `Collection query failed: <status>`; on that, the service marks the
session as `serverSearch = false` and every later search or lookup fetches the whole book,
as before — one failed request per session, not one per search. A 207 whose entries carry
no `address-data` falls back for that call only: a server that answered without bodies has
not answered the question, and an empty result would read as "no match".

Any other error (network, TLS) is surfaced, not fallen back from — the fallback would fail
the same way and hide the cause.

`CARDDAV_SERVER_SEARCH=off` turns the REPORT off outright, for a server whose filter
matching is wrong rather than absent (returns a subset it should not). It is read in
`main.ts` and passed to the service as an option, not added to `pim-core`'s config: it is
a card-mcp behaviour switch, not a credential.

### What does not change

- `fetchContacts` and `fetchBook` (an unfiltered `list_contacts`, the group tools' member
  validation) still read the whole book; there is no filter to send.
- `countContacts` already used a PROPFIND for etags only.
- Searches with an empty query fetch the book without a REPORT.

## Testing

The shared tsdav mock rejects `addressBookQuery` by default, so the rest of the service
suite exercises the fallback every search and lookup must keep working. A dedicated block
asserts the REPORT's shape (properties, collation, match type, the longest token), that
the client rule still applies to server results, the UID re-check, the per-session and
per-call fallbacks, that a non-query error is surfaced, and that the option turns the
REPORT off. Tests that inject a bare `{ fetchVCards }` client construct the service with
`serverSearch: false`, since that client models a whole-book read.
