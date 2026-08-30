# card-mcp: Moving and Copying Contacts Between Address Books

**Date:** 2026-08-29
**Packages:** `@miguelarios/card-mcp`
**Issues:** #58 (move), #59 (copy)
**Status:** Designed and implemented

## Problem

`card-mcp` can create, update and delete contacts, and since #64 it can manage address books
and address them by display name. What it cannot do is relocate a contact: getting a contact
from "Personal" into "Work" means reading it, re-creating it by hand from its fields, and
deleting the original — three tool calls, with the fields the model happens to echo back
rather than the ones actually stored.

`2026-08-24-card-mcp-address-books-design.md` parked this deliberately: *"Move/copy contacts
between books (#58, #59) — unblocked by this, delivered separately."* Naming books is what
makes a two-book operation usable at all, and that shipped in 0.6.0.

## Solution

Two tools, both on `CONTACT_TOOLS` — they are contact operations that happen to involve two
books, not address book operations:

| Tool | Annotations | Mechanism |
|------|-------------|-----------|
| `move_contacts` | write, idempotent, **not** destructive | DAV `MOVE` per contact |
| `copy_contacts` | write, non-idempotent, **not** destructive | read → new UID → `PUT` |

Neither gates on `confirmDestructive`. A move relocates a contact and a copy adds one;
neither destroys anything, which matches `cal-mcp`'s `move_event` (`destructiveHint: false`).

### Batch, not single

Both take `uids: string[]` rather than one UID. This is not speculative generality — it is
forced by how the service finds a contact. `findVCard` fetches **every** vCard in the book and
scans for a UID, so moving five contacts one call at a time means five full book reads. The
batch reads the source book once and builds a `uid → {url, etag, data}` map.

The cost is partial success, which is handled the way `cal-mcp`'s `import_ics` handles it:
report per contact. One unknown UID must not strand the contacts either side of it in the
list, so the result carries `transferred[]` and an optional `failed[]` rather than throwing.

### Move preserves the UID; copy does not

This is the central decision, and the two halves point in opposite directions on purpose.

**Move keeps the UID.** A moved contact is the same person filed somewhere else. Anything
already holding that UID stays correct.

**Copy mints a new UID**, returned as `newUid`. A copy is a second, independent vCard, and
two vCards sharing a UID inside one account is a sync hazard: servers and clients key on UID,
so the pair can be silently merged or one of them dropped. Desktop clients (Apple Contacts
among them) mint a new UID when duplicating a card for exactly this reason. Returning the new
UID means the caller can address the copy immediately rather than having to search for it.

### Mechanisms follow from that

**Move uses DAV `MOVE`**, through `fetch` with Basic auth — tsdav exposes no move helper, and
this is the same approach `cal-mcp`'s `moveEvent` already takes. Two properties matter:

- It is **atomic per contact**. A create-then-delete pair that fails between the two steps
  leaves the contact in *both* books, which is precisely the state a move exists to avoid.
- It relocates the stored bytes untouched, so nothing depends on parse/serialize fidelity.

`Overwrite: F` keeps a move from silently clobbering a contact already filed under that name
in the target. `If-Match` guards against the source changing between read and move.

A `412` is therefore ambiguous — either the `If-Match` failed or `Overwrite: F` refused an
existing destination. The source is re-read and the move retried once, which resolves the
first case; a surviving `412` is the second, and the error message names both possibilities
rather than guessing.

**Copy reads, re-UIDs and `PUT`s** through the existing `createContact`. The vCard is
round-tripped through `parseVCard`/`buildVCard` rather than having its `UID:` line rewritten
in raw text, because that round trip is already the codebase's contract — `updateContact`
depends on it, and #64 hardened it to preserve `PHOTO`, structured-name parts, `ORG` units and
unknown properties.

### Both books are required

Every single-contact tool takes an optional `addressBook` that falls back to the first book.
The transfer tools require **both** ends, for the reason the address book write tools require
theirs: moving out of whichever book happened to sort first is not a thing a caller can mean,
and getting it wrong relocates the wrong contacts. Both accept a display name or a URL.

Transferring into the source book is refused with `VALIDATION_FAILED`. Comparison is on
`collectionPath`, so a trailing slash does not defeat it.

## Output shape

```ts
{
  status: "moved" | "copied";
  from: string;          // resolved source book URL
  to: string;            // resolved target book URL
  transferred: Array<{ uid: string; newUid?: string }>;   // newUid on copies only
  failed?: Array<{ uid: string; message: string }>;       // omitted when empty
}
```

`from` and `to` are the *resolved* URLs, so a caller who passed display names can see which
collections were actually touched.

## Alternatives considered

**Implement move as copy-then-delete.** Simpler — one mechanism for both tools, no raw
`fetch` or hand-rolled auth, and testable purely through the tsdav mock. Rejected because it
is not atomic: a failure between the two steps duplicates the contact across both books, and
a move is the one operation whose entire purpose is that the contact ends up in exactly one
place.

**Use DAV `COPY` for copy, symmetric with `MOVE`.** Rejected: `COPY` preserves the UID, which
is the outcome the copy path is specifically trying to avoid. The asymmetry between the two
mechanisms is not an inconsistency — it *is* the semantic difference between relocating an
object and creating a new one.

**Preserve the UID on copy, or offer a `preserve_uid` flag.** Rejected: it exposes a footgun
as a parameter. A caller who genuinely wants the same UID in two places is describing a move.

**Single-contact tools (`move_contact`, `copy_contact`).** Rejected on cost: the per-contact
lookup scans the whole book, so the singular form makes the common case (relocating several
related contacts) quadratic in book size for no gain in clarity.

**Gate `move_contacts` on `confirmDestructive`.** Rejected: nothing is destroyed, and
`cal-mcp`'s `move_event` set the precedent. Over-gating trains callers to click through
confirmations, which devalues the ones on `delete_contact` and `delete_address_book`.

## Out of scope

- Moving or copying **between accounts** — card-mcp is single-account until #53.
- Transferring a whole book's contents in one call; the caller can list and pass the UIDs.
- Group membership (#60): if a moved contact belongs to a group, the group's member list is
  not rewritten, because groups are not modelled yet.
