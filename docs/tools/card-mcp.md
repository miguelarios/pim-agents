# Contacts MCP Tools

`@miguelarios/card-mcp` — CardDAV contacts server with 6 tools.

> Definitions are pulled directly from `packages/card-mcp/src/tools/contactTools.ts`. Output shapes from `packages/card-mcp/src/services/CardDavService.ts` and `packages/core/src/vcard.ts`.

> All results carry validated `structuredContent` matching the tool's advertised `outputSchema`, with the same JSON serialized into a text block for clients that do not read structured output. Errors are returned as `isError: true` with a `{ error, message, retryable }` body.

## list_contacts

List or search contacts. Returns all contacts if no query provided, or filters by name/email/phone/org when query is given.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | | Optional search query to filter contacts by name, email, phone, or organization. |
| `addressBook` | string | | Address book URL. If omitted, uses the first available address book. |
| `detail_level` | `"summary"` \| `"full"` | | Level of detail. `summary` (default) omits photo binary and raw `otherProperties`. `full` returns the complete parsed vCard shape. |

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
| `addressBook` | string | | Address book URL. If omitted, uses the first available address book. |
| `detail_level` | `"summary"` \| `"full"` | | Level of detail. `summary` (default) omits photo binary and raw `otherProperties`. `full` returns the complete parsed vCard shape. |

**Output**

`Contact` — single contact object. See [Contact shape](#contact-shape) below. Errors with `CONTACT_NOT_FOUND` when the UID is missing.

## create_contact

Create a new contact with the specified details.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fullName` | string | yes | Full display name (e.g., `"John Doe"`). |
| `firstName` | string | | First/given name. |
| `lastName` | string | | Last/family name. |
| `emails` | `{ type?: string, value: string }[]` | | Email addresses with optional type. |
| `phones` | `{ type?: string, value: string }[]` | | Phone numbers with optional type. |
| `addresses` | `{ type?, street?, city?, state?, postalCode?, country? }[]` | | Postal addresses. |
| `urls` | `{ type?: string, value: string }[]` | | URLs with optional type. |
| `organization` | string | | Company/organization name. |
| `title` | string | | Job title. |
| `role` | string | | Role/function within organization. |
| `nickname` | string | | Nickname. |
| `birthday` | string | | Birthday (YYYY-MM-DD). |
| `categories` | string[] | | Contact categories/tags. |
| `note` | string | | Free-text note. |
| `addressBook` | string | | Address book URL. If omitted, uses the first available address book. |

**Output**

```json
{ "status": "created", "uid": "<generated-uuid>", "fullName": "<value>" }
```

## update_contact

Update an existing contact. Only provided fields are changed (merge update). Omitted fields keep their current values.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uid` | string | yes | The UID of the contact to update. |
| `fullName` | string | | New full display name. |
| `firstName` | string | | New first name. |
| `lastName` | string | | New last name. |
| `emails` | `{ type?: string, value: string }[]` | | New email addresses with optional type (replaces existing). |
| `phones` | `{ type?: string, value: string }[]` | | New phone numbers with optional type (replaces existing). |
| `addresses` | `{ type?, street?, city?, state?, postalCode?, country? }[]` | | New postal addresses (replaces existing). |
| `urls` | `{ type?: string, value: string }[]` | | New URLs with optional type (replaces existing). |
| `organization` | string | | New organization. |
| `title` | string | | New job title. |
| `role` | string | | New role/function within organization. |
| `nickname` | string | | New nickname. |
| `birthday` | string | | New birthday (YYYY-MM-DD). |
| `categories` | string[] | | New contact categories/tags (replaces existing). |
| `note` | string | | New note. |
| `addressBook` | string | | Address book URL. If omitted, uses the first available address book. |

**Output**

```json
{ "status": "updated", "uid": "<value>" }
```

## delete_contact

Delete a contact by UID. This action cannot be undone.

> **Asks for confirmation.** This deletes the contact permanently. The client prompts the user before the operation runs; declining returns an error and changes nothing. Set `PIM_MCP_CONFIRM=off` to skip.

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `uid` | string | yes | The UID of the contact to delete. |
| `addressBook` | string | | Address book URL. If omitted, uses the first available address book. |

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
| `addressBook` | string | | Address book URL. If omitted, uses the first available address book. |

**Output** — `ResolveContactResult` discriminated union:

```ts
| { status: "resolved";  fullName: string; email: string }
| { status: "ambiguous"; candidates: Array<{ fullName: string; email: string; uid: string }> }
| { status: "not_found"; message: string }
```

## Contact shape

`list_contacts` and `get_contact` return contacts in the following shape (`packages/core/src/vcard.ts`):

```ts
interface Contact {
  uid: string;
  fullName: string;
  firstName?: string;
  lastName?: string;
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
  title?: string;
  role?: string;
  nickname?: string;
  birthday?: string;
  categories?: string[];
  note?: string;
  socialProfiles?: { type: string; handle?: string; url?: string }[];
  otherProperties: string[]; // raw vCard lines, only populated when detail_level: "full"
}
```
