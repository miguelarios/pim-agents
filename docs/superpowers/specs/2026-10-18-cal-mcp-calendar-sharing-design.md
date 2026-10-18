# cal-mcp: calendar sharing (#47)

## Goal

Let an agent answer "who can see this calendar?" and, with the user's
confirmation, share a calendar or revoke someone's access, on the providers
cal-mcp already talks to.

## What the servers actually speak

Probed live on 2026-10-17/18 (read-only), with every property any dialect
uses requested in one `Depth: 0` PROPFIND:

| Server | `DAV:` header | Answers |
| --- | --- | --- |
| mailbox.org (Open-Xchange) | `access-control`, `calendarserver-sharing`, `resource-sharing` | `CS:invite` (organizer plus `CS:user` entries with `mailto:` href, common-name, `invite-*` state, `CS:access`), `D:invite` / `D:share-access` (principals), `CS:allowed-sharing-modes` |
| Nextcloud (SabreDAV) | `access-control`, `oc-resource-sharing`, `calendarserver-sharing` | `oc:invite` (`oc:user` entries with `principal:` hrefs) and `CS:allowed-sharing-modes`. `CS:invite` and `D:invite` are 404 despite the header |

So "calendarserver-sharing" in the header does not mean `CS:invite` works, and
the dialect has to be chosen from what the PROPFIND returns, not from OPTIONS.

## Decisions

- **One normalised shape** (`email` | `principal`, `name`, `access`, `status`)
  plus `protocol`, so a caller can tell which identifier the server wants back.
- **Preference order: CalendarServer → ownCloud → WebDAV Resource Sharing.**
  CalendarServer names sharees by address, which is what a person and an
  agent both hold. Open-Xchange answers both CS and WebDAV, and the CS form is
  the richer one. WebDAV-only is read but never written: no server we can test
  needs it, and writing it blind would be guesswork.
- **Writes use the dialect the read came back in**: `CS:share` set/remove, or
  `oc:share` set/remove (where read-write is an element and read is its
  absence).
- **Nextcloud gets principals, not addresses.** Its sharing backend resolves a
  `mailto:` sharee only when exactly one local user has that address, and
  otherwise drops it, so a share can "succeed" and do nothing. The tool
  refuses an address there with a `validation_error` that says what to pass.
  Principals are accepted in any form that reduces to `principals/…` (with or
  without `principal:`, a subpath install, a full URL), and user IDs may
  contain `@`. Resolving an address to a principal (a
  `principal-property-search`) is a possible follow-up.
- **Raw requests, not tsdav.** tsdav's XML conversion strips namespace
  prefixes, which merges `D:invite` and `CS:invite`. Parsing uses xml-js (now a
  direct dependency; it was already installed through tsdav) with a small
  namespace resolver, because Open-Xchange mixes default-namespace and prefixed
  elements inside the same property.
- **Both writes confirm.** Sharing usually emails the sharee an invitation,
  which unsharing does not take back. Unsharing removes someone's access. Both
  go through `confirmDestructive`. Only `unshare_calendar` is
  `destructiveHint: true`, since sharing grants rather than removes.
- **Writes return the re-read sharing**, so the result is what the server now
  reports rather than what was asked for. If that re-read fails after the
  write succeeded, the error says the change was applied, so a caller does not
  retry it and send a second invitation.
- **WebDAV Resource Sharing** `D:share-access` is read in both the draft's
  element form (`<D:read-write/>`) and Open-Xchange's text form.
- **Out of scope:** publishing (public read-only URLs), raw WebDAV ACL editing
  (`D:acl` / ACL method), accepting or declining invitations shared *to* this
  account, and address books (card-mcp).

## Verification

- Unit: parser fixtures for each dialect (scrubbed from the live responses),
  body builders parsed back, service requests via a stubbed `fetch`, tool
  gating, and a wire roundtrip on both protocol eras.
- Live, mailbox.org: `get_calendar_sharing` on three real calendars (one
  shared read-only with an accepted sharee, two unshared) matched the server.
  `share_calendar` without an elicitation-capable client is refused before any
  request is sent. A live share/unshare was deliberately not run, because it
  would email a real person.
