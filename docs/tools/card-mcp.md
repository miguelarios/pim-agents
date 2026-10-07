# Contacts MCP Tools

`@miguelarios/card-mcp` — CardDAV contacts server with 17 tools.

> Definitions are pulled directly from `packages/card-mcp/src/tools/contactTools.ts`, `packages/card-mcp/src/tools/groupTools.ts` and `packages/card-mcp/src/tools/addressBookTools.ts`. Output shapes from `packages/card-mcp/src/tools/*Schemas.ts`, `packages/card-mcp/src/services/CardDavService.ts` and `packages/core/src/vcard.ts`.

> All results carry validated `structuredContent` matching the tool's advertised `outputSchema`, with the same JSON serialized into a text block for clients that do not read structured output. Errors are returned as `isError: true` with a `{ error, message, retryable }` body.

## list_contacts

List or search contacts. Returns all contacts if no query provided, or filters by name/email/phone/org when query is given. With no `addressBook`, every book is read and each contact carries an `addressBook` label naming the book it came from.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | | Optional search query to filter contacts by name, email, phone, or organization. |
| `addressBook` | string | | Address book URL or display name (e.g. `Work`). If omitted, every address book in the account is searched. |
| `detail_level` | `"summary"` \| `"full"` | | Level of detail. `summary` (default) omits photo binary and raw `otherProperties`. `full` returns the complete parsed vCard shape. |
| `include_groups` | boolean | | Include contact groups (`kind: "group"`) in the results. Default `false`: groups are listed by `list_groups`. |

**Output**

```ts
{
  contacts: Contact[];
  count: number;
}
```

See [Contact shape](#contact-shape) below.

## get_contact

Get full details of a single contact by UID.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uid` | string | yes | The unique identifier (UID) of the contact. |
| `addressBook` | string | | Address book URL or display name (e.g. `Work`). If omitted, every address book in the account is searched. |
| `detail_level` | `"summary"` \| `"full"` | | Level of detail. `summary` (default) omits photo binary and raw `otherProperties`. `full` returns the complete parsed vCard shape. |

**Output**

`Contact` — single contact object. See [Contact shape](#contact-shape) below. Errors with `CONTACT_NOT_FOUND` when the UID is missing, and with `CONTACT_CONFLICT` (naming the books) when more than one searched book holds the UID.

## create_contact

Create a new contact with the specified details.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fullName` | string | yes | Full display name (e.g., `"John Doe"`). |
| `firstName` | string | | First/given name. |
| `lastName` | string | | Last/family name. |
| `middleName` | string | | Middle name(s). |
| `namePrefix` | string | | Honorific prefix (e.g., `"Dr."`). |
| `nameSuffix` | string | | Honorific suffix (e.g., `"Jr."`). |
| `emails` | `{ type?: string, value: string }[]` | | Email addresses with optional type. |
| `phones` | `{ type?: string, value: string }[]` | | Phone numbers with optional type. |
| `addresses` | `{ type?, street?, city?, state?, postalCode?, country? }[]` | | Postal addresses. |
| `urls` | `{ type?: string, value: string }[]` | | URLs with optional type. |
| `organization` | string | | Company/organization name. |
| `orgUnits` | string[] | | Organizational units within the organization (e.g., `["Engineering"]`). |
| `title` | string | | Job title. |
| `role` | string | | Role/function within organization. |
| `nickname` | string | | Nickname. |
| `birthday` | string | | Birthday (YYYY-MM-DD). |
| `categories` | string[] | | Contact categories/tags. |
| `note` | string | | Free-text note. |
| `socialProfiles` | `{ type: string, handle?: string, url?: string }[]` | | Social media profiles. `type` is the network (e.g., `twitter`, `linkedin`, `mastodon`). |
| `addressBook` | string | | Address book URL or display name (e.g. `Work`) to create the contact in. If omitted, uses the first available address book. |

**Output**

```json
{ "status": "created", "uid": "<generated-uuid>", "fullName": "<value>" }
```

## update_contact

Update an existing contact. Only provided fields are changed (merge update). Omitted fields keep their current values; pass `null` to clear a field.

Every field except `uid` and `fullName` accepts `null` (FN is required on every vCard, so `fullName` cannot be cleared). A group is refused — edit it with [`update_group`](#update_group).

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uid` | string | yes | The UID of the contact to update. |
| `fullName` | string | | New full display name. |
| `firstName` | string \| null | | New first name. |
| `lastName` | string \| null | | New last name. |
| `middleName` | string \| null | | New middle name(s). |
| `namePrefix` | string \| null | | New honorific prefix. |
| `nameSuffix` | string \| null | | New honorific suffix. |
| `emails` | `{ type?: string, value: string }[]` \| null | | New email addresses with optional type (replaces existing). |
| `phones` | `{ type?: string, value: string }[]` \| null | | New phone numbers with optional type (replaces existing). |
| `addresses` | `{ type?, street?, city?, state?, postalCode?, country? }[]` \| null | | New postal addresses (replaces existing). |
| `urls` | `{ type?: string, value: string }[]` \| null | | New URLs with optional type (replaces existing). |
| `organization` | string \| null | | New organization. |
| `orgUnits` | string[] \| null | | New organizational units (replaces existing). |
| `title` | string \| null | | New job title. |
| `role` | string \| null | | New role/function within organization. |
| `nickname` | string \| null | | New nickname. |
| `birthday` | string \| null | | New birthday (YYYY-MM-DD). |
| `categories` | string[] \| null | | New contact categories/tags (replaces existing). |
| `note` | string \| null | | New note. |
| `socialProfiles` | `{ type: string, handle?: string, url?: string }[]` \| null | | New social media profiles (replaces existing). |
| `addressBook` | string | | Address book URL or display name (e.g. `Work`) holding the contact. If omitted, every address book is checked to locate the UID; fails if more than one holds it. |

**Output**

```json
{ "status": "updated", "uid": "<value>" }
```

## delete_contact

Delete a contact by UID. This action cannot be undone.

> **Asks for confirmation.** The prompt names the contact by UID. The client prompts the user before the operation runs; declining returns an error and changes nothing. Set `PIM_MCP_CONFIRM=off` to skip.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uid` | string | yes | The UID of the contact to delete. |
| `addressBook` | string | | Address book URL or display name (e.g. `Work`) holding the contact. If omitted, every address book is checked to locate the UID; fails if more than one holds it. |

**Output**

```json
{ "status": "deleted", "uid": "<value>" }
```

## resolve_contact

Given a person's name, resolve to email. Returns `{ status: 'resolved', fullName, email }` on a single match; `{ status: 'ambiguous', candidates: [...] }` when multiple contacts match (caller must disambiguate); `{ status: 'not_found', message }` when no contact with email matches.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Name to search for (partial matches allowed). |
| `addressBook` | string | | Address book URL or display name (e.g. `Work`). If omitted, every address book in the account is searched. |

Groups and contacts without an email are never returned.

**Output** — `ResolveContactResult` discriminated union:

```ts
| { status: "resolved";  fullName: string; email: string }
| { status: "ambiguous"; candidates: Array<{ fullName: string; email: string; uid: string; addressBook?: string }> }
| { status: "not_found"; message: string }
```

## move_contacts

Move contacts to another address book. Each contact **keeps its UID** — it is the same person, filed somewhere else — so anything already referring to that UID stays correct.

Issues a DAV `MOVE` per contact, which is atomic: a create-then-delete pair that failed between the two steps would leave the contact in *both* books, which is the state a move exists to avoid. `Overwrite: F` means a move will not clobber a contact already filed under that name in the target.

Both address books are required and neither defaults — moving out of whichever book happened to sort first is not a thing a caller can mean. Each accepts a display name or a URL. Transferring into the source book is refused. Groups are refused per entry (their members must stay in the same book). Retrying a move that already succeeded reports its UIDs as not found in the source — that is a completed move, not a failed one.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uids` | string[] | yes | UIDs of the contacts to transfer. Repeats are ignored. The source book is read once for the whole batch. At least one. |
| `addressBook` | string | yes | Source address book URL or display name (e.g. `Personal`). |
| `targetAddressBook` | string | yes | Target address book URL or display name (e.g. `Work`). Must differ from the source. |

**Output**

See [Transfer results](#transfer-results) — `status: "moved"`, and no `newUid`.

## copy_contacts

Copy contacts into another address book, leaving the originals in place.

**Each copy is a new contact and gets a new UID**, returned as `newUid`. Two vCards sharing a UID inside one account is a sync hazard — servers and clients key on UID, so the pair can be silently merged or one of them dropped. Desktop clients mint a new UID when duplicating a card for the same reason. Both address books must be named; neither defaults. Groups are refused per entry.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uids` | string[] | yes | UIDs of the contacts to transfer. Repeats are ignored. The source book is read once for the whole batch. At least one. |
| `addressBook` | string | yes | Source address book URL or display name (e.g. `Personal`). |
| `targetAddressBook` | string | yes | Target address book URL or display name (e.g. `Work`). Must differ from the source. |

**Output**

See [Transfer results](#transfer-results) — `status: "copied"`, with `newUid` set on every entry.

## Transfer results

`move_contacts` and `copy_contacts` share one result shape. A batch can partly succeed: one unknown UID does not strand the contacts either side of it, so the result reports per contact rather than as a bare count.

```ts
{
  status: "moved" | "copied";
  from: string;          // resolved source address book URL
  to: string;            // resolved target address book URL
  transferred: Array<{
    uid: string;         // the original UID
    newUid?: string;     // copies only — the copy's fresh UID
  }>;
  failed?: Array<{ uid: string; message: string }>;   // omitted when everything transferred
}
```

`from` and `to` are the *resolved* URLs, so a caller who passed display names can see which collections were actually touched.

## list_groups

List contact groups (distribution lists) with their member counts. Pass the UID to `get_group` for the members.

A group is a vCard with `KIND:group` (or Apple's vCard 3.0 `X-ADDRESSBOOKSERVER-KIND:group`) whose `MEMBER` lines name other contacts by UID. A group lives in one address book and can only refer to contacts in that same book.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `addressBook` | string | | Address book URL or display name (e.g. `Work`). If omitted, every address book in the account is searched. |

**Output**

```ts
{
  groups: Array<{
    uid: string;
    name: string;
    memberCount: number;
    addressBook: string;   // display name, or URL for a nameless book
  }>;
  count: number;
}
```

## get_group

Get a contact group with its members resolved to contacts (UID, name, first email). Member UIDs the address book no longer holds are listed under `missingMembers` rather than dropped. A UID that names an individual rather than a group is refused.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uid` | string | yes | The UID of the group. |
| `addressBook` | string | | Address book URL or display name (e.g. `Work`). If omitted, every address book in the account is searched. |

**Output**

```ts
{
  uid: string;
  name: string;
  addressBook: string;
  members: Array<{
    uid: string;
    fullName: string;
    email?: string;        // the member's first email address
  }>;
  missingMembers: string[];
}
```

## create_group

Create a contact group. Members are UIDs of contacts already in the same address book.

Every member must be an individual in the group's book: a UID from another book, or another group, is refused. Repeated UIDs are collapsed.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | yes | Group name (e.g., `"Book Club"`). |
| `members` | string[] | | Initial member UIDs. Default: none. |
| `addressBook` | string | | Address book URL or display name to create the group in. If omitted, uses the first available address book. |

**Output**

See [Group write results](#group-write-results) — `status: "created"`.

## update_group

Rename a contact group and/or add and remove members. Members are UIDs of contacts in the group's address book. Repeats and already-present additions are ignored.

At least one of `name`, `addMembers` or `removeMembers` must be given, and a UID cannot appear in both `addMembers` and `removeMembers`. Added members are validated the same way as in `create_group`.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uid` | string | yes | The UID of the group. |
| `name` | string | | New group name. |
| `addMembers` | string[] | | UIDs to add. |
| `removeMembers` | string[] | | UIDs to remove. |
| `addressBook` | string | | Address book URL or display name (e.g. `Work`). If omitted, every address book in the account is searched. |

**Output**

See [Group write results](#group-write-results) — `status: "updated"`, with the resulting `name` and `memberCount`.

## delete_group

Delete a contact group. The member contacts are not deleted. This cannot be undone.

> **Asks for confirmation.** The prompt names the group and its member count, and says the member contacts are kept. Declining returns an error and changes nothing. Set `PIM_MCP_CONFIRM=off` to skip.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uid` | string | yes | The UID of the group. |
| `addressBook` | string | | Address book URL or display name (e.g. `Work`). If omitted, every address book in the account is searched. |

**Output**

See [Group write results](#group-write-results) — `status: "deleted"`.

## Group write results

`create_group`, `update_group` and `delete_group` share one result shape:

```ts
{
  status: "created" | "updated" | "deleted";
  uid: string;
  name: string;
  memberCount: number;
}
```

## list_address_books

List the account's address books — name, URL, and metadata. Pass the returned name (or URL) as `addressBook` to any contact tool.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `include_counts` | boolean | | Also count the contacts in each book (one extra request per book). Default `false`. |

**Output**

```ts
{
  addressBooks: Array<{
    displayName: string;
    url: string;
    description?: string;
    ctag?: string;
    syncToken?: string;
    contactCount?: number; // only with include_counts: true
  }>;
  count: number;
}
```

## create_address_book

Create a new address book via extended MKCOL (RFC 5689). The URL is derived from the display name unless an explicit `slug` is given.

Creation is refused when a book with the same display name already exists (case-insensitive) — a duplicate name would make that name ambiguous to every later `addressBook` reference. Providers vary: Baikal, Nextcloud, Radicale, Fastmail and iCloud support this; Google's CardDAV endpoint does not, and the error says so.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `displayName` | string | yes | Display name for the new address book. |
| `description` | string | | Optional address book description. |
| `slug` | string | | Optional URL path segment (lowercase letters, digits, hyphens). Derived from `displayName` when omitted. |

**Output**

```ts
{ status: "created"; url: string; displayName?: string }
```

## rename_address_book

Rename an address book and/or update its description (PROPPATCH). At least one of `displayName` or `description` must be given. A new name another book already has is refused (case-insensitive, exempting the book itself, so a case-only rename goes through), as is an empty name.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `addressBook` | string | yes | Address book URL or display name (e.g. `Work`). |
| `displayName` | string | | New display name. |
| `description` | string | | New description. |

**Output**

```ts
{ status: "renamed"; url: string; displayName?: string }
```

## delete_address_book

Delete an address book **and every contact in it**.

> **Asks for confirmation.** The prompt names the book — by its display name even when the reference given was a URL — and its contact count. The count is read when the prompt is built, so it describes the book at that moment rather than guaranteeing what the delete removes. Declining returns an error and changes nothing. Set `PIM_MCP_CONFIRM=off` to skip.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `addressBook` | string | yes | Address book URL or display name (e.g. `Work`). |

**Output**

```ts
{ status: "deleted"; url: string; displayName?: string }
```

## Contact shape

`list_contacts` and `get_contact` return contacts in the following shape (`packages/core/src/vcard.ts`, plus the `addressBook` label added by the tool):

```ts
interface Contact {
  uid: string;
  addressBook?: string;   // book the contact was read from: display name, or URL for a nameless book
  fullName: string;
  firstName?: string;
  lastName?: string;
  middleName?: string;
  namePrefix?: string;
  nameSuffix?: string;
  emails: { type?: string; value: string }[];
  phones: { type?: string; value: string }[];
  addresses: {
    type?: string;
    street?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  }[];
  urls: { type?: string; value: string }[];
  organization?: string;
  orgUnits?: string[];
  title?: string;
  role?: string;
  nickname?: string;
  birthday?: string;
  categories?: string[];
  note?: string;
  socialProfiles?: { type: string; handle?: string; url?: string }[];
  photo?: string;          // omitted at detail_level: "summary"
  kind?: "group";          // set only on groups (list_contacts with include_groups: true)
  members?: string[];      // a group's member UIDs
  otherProperties: string[]; // raw vCard lines, only populated when detail_level: "full"
}
```
