# card-mcp: Searching Every Address Book When None Is Named

**Date:** 2026-09-05
**Packages:** `@miguelarios/card-mcp`
**Status:** Designed and implemented

## Problem

`list_contacts`, `get_contact` and `resolve_contact` defaulted to whichever address book
sorted first when `addressBook` was omitted. For a name resolution — "what is Bob's email"
— omitting the book is the normal case, and a Bob filed in `Work` simply went missing when
`Personal` sorted first. The same default sent `update_contact` and `delete_contact` to the
wrong book, where the UID was not found.

## Solution

When `addressBook` is omitted, the read tools cover every book in the account, read
concurrently, and each returned contact carries an `addressBook` label. The label is the
book's display name, or its URL when it has none, or — when the caller named a book —
exactly the reference they gave. The rule is that the label is always something the caller
can pass straight back as `addressBook` to any contact tool.

`update_contact` and `delete_contact` on an unqualified UID call the new
`CardDavService.locateContact(uid, bookUrls)` first. One hit is the answer. Two hits means
a UID duplicated across books, which is a state a write cannot safely act on — it would
land on whichever book sorted first — so it fails as `CONTACT_CONFLICT` (the contact *was*
found; a caller that offers to create a missing contact must not do so here) naming both
URLs. `get_contact` applies the same rule on the read side rather than returning whichever
book sorted first — and, since it counts matches rather than books, a UID duplicated *within*
one book (corrupt data) is now a conflict too, where `.find()` used to take the first card. A single-book account skips the lookup entirely, and on a multi-book
account the vCard the lookup found is handed to the write as `located`, so the winning book
is read once, not twice.

`create_contact` keeps the first-book default. A new contact has to land somewhere, and
"the first book" is the only default that needs no second round trip; its parameter
description says so, separately from the read tools' description.

`resolveContact` takes one URL or several, so the resolution rules (single match, sorted
candidates, not-found) run once over the merged matches rather than per book.

The book-selection helpers (`booksToSearch`, `readAcrossBooks`, `locateBookFor`,
`resolveAddressBook`) live in `tools/books.ts` so later tool files can share them.

## Rejected

- **An `all` sentinel value for `addressBook`.** Omitted already has to mean something,
  and "search everything" is the only meaning under which a name lookup is correct.
- **Locating on every write, even with one book.** The write's own lookup already reports
  a missing UID; the extra fetch would buy nothing.
- **`Promise.allSettled` with per-book failures on reads.** Reading every book means one
  unreachable book now fails a whole `list_contacts`, where before only an explicit
  reference to it did. Partial results with a `failed[]` are the shape `move_contacts` uses
  and would fit here too, but silently returning a subset of the account's contacts is a
  worse default for a name lookup than an error the caller can see. Revisit if it bites.

## Deferred

Server-side `addressbook-query` (#52). Reading N books is N full fetches; this change does
not make that worse per book, and the fix belongs with the REPORT work. The same cost lands
on the write path: `update_contact` and `delete_contact` on an unqualified UID in a
multi-book account scan every book to locate it, where before they read one (wrong, but
cheap) default book. Correctness wins, and #52 would cut both the read and the locate to a
UID-filtered REPORT per book.
