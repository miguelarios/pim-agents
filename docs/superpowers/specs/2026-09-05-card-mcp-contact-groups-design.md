# card-mcp: Contact Groups

**Date:** 2026-09-05
**Packages:** `@miguelarios/pim-core`, `@miguelarios/card-mcp`
**Depends on:** the cross-book lookup and field-clearing changes in card-mcp 0.8.0 and 0.9.0
**Issues:** #60 (groups)
**Status:** Designed and implemented

## Problem

A vCard with `KIND:group` (or Apple's vCard 3.0 `X-ADDRESSBOOKSERVER-KIND:group`) parsed
as an ordinary contact whose `MEMBER` lines landed in `otherProperties`. "Email the book
club" had no tool to answer it, and a group showed up in `list_contacts` as a person with
no email (issue #60).

## Groups

### Data model

`Contact` gains `kind?: "individual" | "group"` and `members?: string[]`. The parser reads
both the RFC 6350 form (`KIND`, `MEMBER:urn:uuid:…`) and the Apple/SabreDAV vCard 3.0 form
(`X-ADDRESSBOOKSERVER-KIND`, `X-ADDRESSBOOKSERVER-MEMBER`). The `urn:uuid:` prefix is
stripped so `members` holds plain UIDs — the currency every other contact tool already
speaks. A member with any other scheme (`mailto:`) is kept verbatim, scheme included: it
is not a UID, and rewriting it would lose information.

The builder writes the `X-ADDRESSBOOKSERVER-*` form. It emits `VERSION:3.0`, and that is the
form Apple Contacts, iCloud and SabreDAV-based servers (Nextcloud, Baïkal) read for 3.0
cards. Writing `KIND`/`MEMBER` into a 3.0 card was rejected: Apple clients ignore them
there. A member value that already carries a scheme is written as-is; a bare UID gets
`urn:uuid:`.

### Tools

Five tools in `groupTools.ts`, registered between the contact and address-book tools:

| Tool | Annotations | Notes |
|------|-------------|-------|
| `list_groups` | read-only | Across every book unless one is named; member counts only |
| `get_group` | read-only | Members resolved to `{uid, fullName, email?}`; `missingMembers` |
| `create_group` | write, non-idempotent | First book by default, like `create_contact` |
| `update_group` | write, idempotent | `name`, `addMembers`, `removeMembers` |
| `delete_group` | destructive, confirms | Deletes the group card only |

**Membership is validated against the group's own book.** On every server that implements
groups, a group can only refer to contacts in the same collection; a UID from another book
is a dangling reference the server will not resolve. So `create_group` and `update_group`
read the target book and refuse unknown UIDs by name, and refuse a group as a member —
nested groups are not something the clients that render groups understand.

**`get_group` reports dangling members rather than dropping them.** A member deleted
without the group being edited leaves a `MEMBER` line pointing nowhere. Silently omitting
it would make the group look smaller than the server says it is; `missingMembers` lets the
caller clean up with `update_group`.

**`update_group` is add/remove, not replace.** A distribution list is edited by "add Bob,
drop the old address"; a replace-the-whole-list form forces the caller to first fetch the
list and echo it back, and any mismatch silently drops members. Repeats and already-present
additions are ignored so the tool is idempotent.

**`delete_group` confirms with the name and member count.** The group is loaded before the
gate, so the question the user sees is one they can answer.

**`list_contacts` hides groups by default.** A group has an `FN` and so looks like a
contact, but showing "Book Club" between "Bob" and "Carol" is noise for the common case;
`include_groups: true` opts back in. `resolve_contact` needs no change: a group has no
`EMAIL` and was already filtered out.

Rejected: a `search_groups`/`get_group_by_name` tool. `list_groups` returns every group
with its name in one call; groups number in the tens, not the thousands.

## Relation to cross-book lookup

The group tools reuse the book-selection helpers from
`2026-09-05-card-mcp-cross-book-lookup-design.md`: reads cover every book unless one is
named, and a write on an unqualified UID locates the group's book first. `get_group` tags
its result with the same `addressBook` label the contact tools use.

## Testing

Unit tests per layer, as the repo convention: parser and builder in `pim-core`; the
group vCard round-trip against a mocked `tsdav`; every tool handler
through `dispatchTool`-style direct invocation with a fake service; and the group tools
over a real in-memory MCP client on both protocol eras, which is what proves the
`delete_group` confirmation round trip and the `get_group` output schema.
