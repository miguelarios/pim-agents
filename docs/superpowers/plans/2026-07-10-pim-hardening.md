# PIM Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the data-destroying bugs, security holes, and doc drift found in the 2026-07-09 full-repo review, shipped as a sequence of small PRs.

**Architecture:** No new packages. Fixes land in `pim-core` (vCard escaping, contact round-trip fields, ICS master-update + timezone helpers) and are consumed by `card-mcp`, `cal-mcp`, and `email-mcp`. Every fix follows TDD against the existing Vitest mock harnesses. Versions bump once, at the end (PR 11).

**Tech Stack:** TypeScript strict ESM, Vitest (mocked tsdav/imapflow/mailparser/nodemailer), ical.js, Biome, Turborepo.

## Global Constraints

- **PR workflow:** One branch per PR (`fix/<slug>` or `chore/<slug>`), based on `main`, merged in order (PR 2 → 3 → 4 depend on each other; PR 5 → 6 → 7 likewise). Commit after every green test cycle — small, frequent commits. Do NOT bundle PRs together.
- **Before every PR push:** `npm test && npm run lint && npm run typecheck` from repo root — all must pass. Baseline is 393 tests passing.
- **PII:** Never commit real names, emails, phone numbers, or personal domains. Test data uses the canonical synthetic set: `Alice Smith`/`alice@example.com`/`+1-555-0100`, `Bob Jones`/`bob@example.com`, `Carol Davis`/`carol@example.com`, `123 Main St, Anytown, ST 00000`, `example.com`. The gitleaks pre-commit hook will block violations — fix the data, never `--no-verify`.
- **Code style:** Double quotes, 2-space indent, semicolons (Biome enforces). Valibot for validation, not Zod. Tests live in `src/__tests__/*.test.ts` next to source.
- **Version bumps happen only in PR 11.** PRs 1–10 must not touch `"version"` fields (exception: PR 1 changes how main.ts *reads* the version).
- **Commit trailer:** end commit messages with the standard Claude Code co-author trailer used in this repo.
- Where a task edits a function covered by existing tests, run the whole package suite (`cd packages/<pkg> && npx vitest run`), not just the new test file — several existing assertions will legitimately change (called out per task).

## PR Overview

| PR | Branch | Packages | Contents |
|----|--------|----------|----------|
| 1 | `chore/hygiene-sweep` | all | version-string fix, stale READMEs, delete stale tools.json, spec statuses, dep range |
| 2 | `fix/vcard-escaping` | core | RFC 6350 value escaping/unescaping |
| 3 | `fix/contact-roundtrip` | core, card | stop destroying PHOTO / N parts / ORG units / socialProfiles on update |
| 4 | `fix/carddav-http-errors` | card | check update/delete responses, 412 → CONTACT_CONFLICT, login-state fix |
| 5 | `fix/cal-master-update` | core, cal | update_event preserves RRULE/EXDATE/overrides/PARTSTAT/STATUS, bumps SEQUENCE |
| 6 | `fix/cal-timezones` | core, cal | get_today_events + find_free_slots respect PIM_TIMEZONE |
| 7 | `fix/cal-import-and-exceptions` | core, cal | import_ics per-UID split; delete_event exception removal via ical.js |
| 8 | `fix/email-attachments` | email | real MIME part IDs from bodyStructure; flags populated in get_email |
| 9 | `fix/email-imap-correctness` | email | Trash special-use, BCC draft round-trip, empty-uids guards |
| 10 | `fix/email-security` | email, cal, card | SSRF/private-IP block, attachment path restriction, tool annotations |
| 11 | `chore/release-0.7-wave` | all | version bumps, CHANGELOGs, tags, live smoke doc |

---

### Task 1.1: Server version strings read from package.json (PR 1)

**Files:**
- Modify: `packages/cal-mcp/src/main.ts` (declares `0.3.0`; package is `0.10.0`)
- Modify: `packages/email-mcp/src/main.ts`, `packages/card-mcp/src/main.ts` (same pattern, prevent future drift)

**Interfaces:**
- Produces: each `main.ts` exposes the real package version to the MCP `Server` constructor.

- [ ] **Step 1: Replace the hardcoded version literal in each main.ts**

In each `main.ts`, above the `new Server(...)` call, add:

```typescript
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };
```

and pass `version` where the string literal (e.g. `"0.3.0"`) was. Note: compiled output lives in `dist/`, so `../package.json` resolves to the package root from `dist/main.js`. Verify the relative path against each package's `outDir` in `tsconfig.json` before assuming — if `main.ts` compiles to `dist/src/main.js`, use `../../package.json`.

- [ ] **Step 2: Verify build + servers still construct**

Run: `npm run build && npm test`
Expected: build succeeds, 393 tests pass (main.ts has no unit tests — the build is the check).

- [ ] **Step 3: Commit**

```bash
git add packages/*/src/main.ts
git commit -m "fix: read MCP server version from package.json (cal-mcp declared 0.3.0 at v0.10.0)"
```

### Task 1.2: Docs hygiene (PR 1)

**Files:**
- Modify: `packages/email-mcp/README.md` — lists 10 tools with pre-0.2.0 name `list_emails`; missing `search_emails`, `send_draft`, `get_folder_status`; describes `download_attachment` by filename (now `partId`)
- Modify: `packages/cal-mcp/README.md` — lists 9 tools; missing `get_today_events`, `search_events`; omits `span`/`occurrence_date`, alarms, categories, `recurrence_rule`
- Delete: `packages/cal-mcp/cal-mcp-tools.json` — stale (still contains `span: "future"`, attendee `name`, missing `occurrence_date`/`alarms`/`categories`/`recurrence_rule`/`availability`)
- Modify: `docs/superpowers/specs/2026-04-13-card-mcp-parser-fixes-design.md` and `docs/superpowers/specs/2026-04-24-cal-mcp-icaljs-migration-design.md` — both say "Designed, pending implementation" but shipped
- Modify: `packages/card-mcp/package.json` — dependency `@miguelarios/pim-core: ^0.5.0` → `^0.6.0`

- [ ] **Step 1: Check nothing imports cal-mcp-tools.json, then delete it**

Run: `grep -rn "cal-mcp-tools" --include="*.ts" --include="*.json" packages/ .github/ | grep -v node_modules`
Expected: no source references (if any exist, update them to read tool definitions from `calendarTools.ts` instead). Then `git rm packages/cal-mcp/cal-mcp-tools.json`.

- [ ] **Step 2: Rewrite the two package READMEs from current code**

Source of truth: the `EMAIL_TOOLS` array in `packages/email-mcp/src/tools/emailTools.ts` and `CALENDAR_TOOLS` in `packages/cal-mcp/src/tools/calendarTools.ts`, plus the current tables in the root `README.md` (12 email tools, 11 calendar tools) and `docs/tools/*.md`. Each package README needs: package description, tool table (name + one-line description matching the root README), env-var configuration block (copy the matching `mcpServers` JSON block from root README), and the optional env vars line (email: `IMAP_PORT`, `IMAP_SECURE`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM_NAME`; both: `PIM_TIMEZONE`).

- [ ] **Step 3: Update the two stale spec Status lines**

In each spec, change the `Status:` line to `Status: Implemented (card-mcp 0.3.0 / pim-core 0.5.0, PR #30)` and `Status: Implemented (cal-mcp 0.10.0 / pim-core 0.6.0, PR #35)` respectively.

- [ ] **Step 4: Bump card-mcp's pim-core range**

In `packages/card-mcp/package.json`: `"@miguelarios/pim-core": "^0.6.0"`.

- [ ] **Step 5: Verify, commit, open PR**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all green.

```bash
git add -A
git commit -m "docs: regenerate stale package READMEs, drop stale cal-mcp-tools.json, sync spec statuses"
gh pr create --title "chore: hygiene sweep — version strings, stale docs, dep range" --body "Fixes doc/version drift found in the 2026-07-09 review. No behavior changes."
```

---

### Task 2.1: vCard value escaping/unescaping in pim-core (PR 2)

**Files:**
- Modify: `packages/core/src/vcard.ts`
- Test: `packages/core/src/__tests__/vcard.test.ts`

**Interfaces:**
- Produces: `escapeVCardValue(value: string): string`, `unescapeVCardValue(value: string): string`, `splitUnescaped(value: string, delim: ";" | ","): string[]` — exported from `vcard.ts` (and re-exported via `packages/core/src/index.ts` if other vcard helpers are). Task 3.1 relies on `splitUnescaped` for N/ORG parsing.

**Why:** `buildVCard` interpolates raw values (a note containing a newline corrupts the card — and `END:VCARD\n...` in a note is an injection vector into the DAV store); `parseVCard` never unescapes, so notes come back with literal `\n` text.

- [ ] **Step 1: Write the failing tests**

Append to `vcard.test.ts`:

```typescript
describe("vCard value escaping", () => {
  it("escapes newline, semicolon, comma, backslash in built NOTE", () => {
    const built = buildVCard({
      uid: "esc-1",
      fullName: "Alice Smith",
      emails: [],
      phones: [],
      addresses: [],
      urls: [],
      note: "line1\nline2; with, punctuation\\slash",
      otherProperties: [],
    });
    expect(built).toContain("NOTE:line1\\nline2\\; with\\, punctuation\\\\slash");
    // no raw newline may appear inside the NOTE line
    const noteLine = built.split("\r\n").find((l) => l.startsWith("NOTE:"))!;
    expect(noteLine).not.toContain("\n");
  });

  it("a note containing END:VCARD cannot terminate the card", () => {
    const built = buildVCard({
      uid: "esc-2",
      fullName: "Alice Smith",
      emails: [],
      phones: [],
      addresses: [],
      urls: [],
      note: "END:VCARD\nBEGIN:VCARD\nFN:Injected",
      otherProperties: [],
    });
    expect(built.match(/^END:VCARD$/gm)).toHaveLength(1);
    expect(built.match(/^BEGIN:VCARD$/gm)).toHaveLength(1);
  });

  it("unescapes on parse and round-trips", () => {
    const original = {
      uid: "esc-3",
      fullName: "Smith; Alice, Jr.",
      emails: [],
      phones: [],
      addresses: [{ street: "123 Main St; Apt 4", city: "Anytown", state: "ST" }],
      urls: [],
      categories: ["family, close", "book club"],
      note: "line1\nline2",
      otherProperties: [],
    };
    const parsed = parseVCard(buildVCard(original as any));
    expect(parsed.fullName).toBe("Smith; Alice, Jr.");
    expect(parsed.note).toBe("line1\nline2");
    expect(parsed.addresses[0].street).toBe("123 Main St; Apt 4");
    expect(parsed.categories).toEqual(["family, close", "book club"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/core && npx vitest run src/__tests__/vcard.test.ts`
Expected: the three new tests FAIL (raw `;`/newline emitted, literal `\n` on parse).

- [ ] **Step 3: Implement escaping**

In `vcard.ts` add near the top:

```typescript
/** RFC 6350 §3.4 value escaping. Backslash first, then newline, semicolon, comma. */
export function escapeVCardValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

export function unescapeVCardValue(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

/** Split on a delimiter, honoring backslash escapes. */
export function splitUnescaped(value: string, delim: ";" | ","): string[] {
  const parts: string[] = [];
  let cur = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length) {
      cur += ch + value[i + 1];
      i++;
      continue;
    }
    if (ch === delim) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}
```

Apply in `buildVCard` (line numbers pre-change): `FN` (:199), `N` components (:203), `EMAIL`/`TEL`/`URL` values (:207-213), each `ADR` part (:216-224), `ORG` (:229), `TITLE`/`ROLE`/`NICKNAME`/`BDAY` (:231-241), each `CATEGORIES` item then join with `,` (:244), `NOTE` (:247), `X-SOCIALPROFILE` value (:254). For X-SOCIALPROFILE *params* (`type`, `x-user`), sanitize instead: `sp.type.replace(/[;:"]/g, "")`.

Apply unescaping in `parseVCard`: `fullName`, `title`, `note`, `role`, `nickname` (wrap the `extractFirst` results); `extractTypedAll` values (:302 → `unescapeVCardValue(value)`); `N` → `splitUnescaped(n, ";")` then unescape each part (:168); `CATEGORIES` → `splitUnescaped(categoriesRaw, ",")` then unescape+trim each (:131); `extractAddresses` → `splitUnescaped(...)` at :334 then unescape each part. Do NOT unescape `uid`, `birthday`, or raw `otherProperties` lines.

- [ ] **Step 4: Run the full core suite; update assertions that legitimately change**

Run: `cd packages/core && npx vitest run`
Expected: new tests pass. The iOS-golden test currently asserts the NOTE comes back with a literal `\n` two-character sequence (around `vcard.test.ts:524`) — update that expectation to a real newline (`"TI Intern\nGoing out friend..."` as an actual JS `\n`). Any other failures must be inspected individually: only expectations about escaped characters may change; anything else is a regression.

- [ ] **Step 5: Verify card-mcp still passes, commit, open PR**

Run: `cd ../card-mcp && npx vitest run && cd ../.. && npm run lint && npm run typecheck`

```bash
git add packages/core/src/vcard.ts packages/core/src/__tests__/vcard.test.ts
git commit -m "fix(pim-core): RFC 6350 vCard value escaping/unescaping"
gh pr create --title "fix(pim-core): vCard value escaping — corruption + injection fix" --body "buildVCard emitted raw newlines/semicolons/commas (card corruption + VCARD injection via NOTE); parseVCard never unescaped. Adds escapeVCardValue/unescapeVCardValue/splitUnescaped and applies them to every text field."
```

---

### Task 3.1: Preserve N components, ORG units, PHOTO, and socialProfiles across updates (PR 3)

**Files:**
- Modify: `packages/core/src/vcard.ts`
- Modify: `packages/card-mcp/src/services/CardDavService.ts:121-163` (merge), `:26-32` (applyDetailLevel)
- Test: `packages/core/src/__tests__/vcard.test.ts`, `packages/card-mcp/src/__tests__/CardDavService.test.ts`

**Interfaces:**
- Consumes: `escapeVCardValue`, `unescapeVCardValue`, `splitUnescaped` from Task 2.1.
- Produces: `Contact` gains optional fields `middleName?: string`, `namePrefix?: string`, `nameSuffix?: string`, `orgUnits?: string[]`, `photo?: string` (the raw, unfolded `PHOTO...` property line, prefix included). `updateContact` merge includes them plus the previously-dropped `socialProfiles`.

**Why:** Any `update_contact` today reserializes from the parsed Contact, which silently deletes the photo (PHOTO is stripped at parse), middle names/prefixes/suffixes (only 2 of 5 N components kept), ORG departments (first component only), and all social profiles (missing from the merge object entirely).

- [ ] **Step 1: Write the failing core test**

```typescript
describe("contact update round-trip preservation", () => {
  const CARD = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "UID:rt-1",
    "FN:Dr. Alice Beth Smith Jr.",
    "N:Smith;Alice;Beth;Dr.;Jr.",
    "ORG:Acme Corp;Engineering;Platform",
    "PHOTO;ENCODING=b;TYPE=JPEG:dGVzdC1waG90by1ieXRlcw==",
    "X-SOCIALPROFILE;type=twitter:https://twitter.com/example_user",
    "END:VCARD",
  ].join("\r\n");

  it("parses all N components, ORG units, and keeps raw PHOTO", () => {
    const c = parseVCard(CARD);
    expect(c.firstName).toBe("Alice");
    expect(c.lastName).toBe("Smith");
    expect(c.middleName).toBe("Beth");
    expect(c.namePrefix).toBe("Dr.");
    expect(c.nameSuffix).toBe("Jr.");
    expect(c.organization).toBe("Acme Corp");
    expect(c.orgUnits).toEqual(["Engineering", "Platform"]);
    expect(c.photo).toBe("PHOTO;ENCODING=b;TYPE=JPEG:dGVzdC1waG90by1ieXRlcw==");
  });

  it("buildVCard(parseVCard(x)) preserves N, ORG, PHOTO, X-SOCIALPROFILE", () => {
    const rebuilt = buildVCard(parseVCard(CARD));
    expect(rebuilt).toContain("N:Smith;Alice;Beth;Dr.;Jr.");
    expect(rebuilt).toContain("ORG:Acme Corp;Engineering;Platform");
    expect(rebuilt).toContain("PHOTO;ENCODING=b;TYPE=JPEG:dGVzdC1waG90by1ieXRlcw==");
    expect(rebuilt).toContain("X-SOCIALPROFILE;type=twitter:https://twitter.com/example_user");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/core && npx vitest run src/__tests__/vcard.test.ts`
Expected: FAIL — `middleName` undefined, `orgUnits` undefined, `photo` undefined, rebuilt card missing PHOTO and N suffix.

- [ ] **Step 3: Implement in vcard.ts**

1. Extend the `Contact` interface (after `lastName`): `middleName?: string; namePrefix?: string; nameSuffix?: string;` and (after `organization`): `orgUnits?: string[];` and (after `socialProfiles`): `photo?: string;`
2. Remove `"PHOTO"` from `APPLE_INTERNAL_PROPS` (:46). In `parseVCard`, capture the first PHOTO line verbatim (post-unfold): iterate `lines`, match `/^PHOTO[;:]/i` on the canonical (item-stripped) form, store the canonical line as `photo`. PHOTO must NOT land in `otherProperties` — add `"PHOTO"` to the `KNOWN` set (:134-154).
3. N parsing (:167-171): `const parts = splitUnescaped(n, ";").map(unescapeVCardValue);` then `lastName = parts[0] || undefined; firstName = parts[1] || undefined; middleName = parts[2] || undefined; namePrefix = parts[3] || undefined; nameSuffix = parts[4] || undefined;`
4. ORG parsing (:124): `const orgParts = orgRaw ? splitUnescaped(orgRaw, ";").map((p) => unescapeVCardValue(p).trim()) : [];` → `organization = orgParts[0] || undefined; orgUnits = orgParts.slice(1).filter(Boolean); // undefined when empty`
5. `buildVCard`: N line emits all five components when any is present:
```typescript
if (contact.lastName || contact.firstName || contact.middleName || contact.namePrefix || contact.nameSuffix) {
  const n = [contact.lastName, contact.firstName, contact.middleName, contact.namePrefix, contact.nameSuffix]
    .map((p) => escapeVCardValue(p ?? ""))
    .join(";");
  lines.push(`N:${n}`);
}
```
ORG: `lines.push(`ORG:${[contact.organization, ...(contact.orgUnits ?? [])].map((p) => escapeVCardValue(p ?? "")).join(";")}`);` (only when `contact.organization` set). PHOTO: `if (contact.photo) lines.push(contact.photo);` (raw line, before `otherProperties`).

- [ ] **Step 4: Fix the card-mcp merge + output stripping — failing test first**

Append to `CardDavService.test.ts` (follow the file's existing tsdav mock pattern — it mocks `DAVClient` with `fetchVCards`/`updateVCard` fns):

```typescript
it("updateContact preserves photo, name parts, org units, and social profiles", async () => {
  const CARD = [
    "BEGIN:VCARD", "VERSION:3.0", "UID:rt-2", "FN:Alice Smith",
    "N:Smith;Alice;Beth;Dr.;Jr.", "ORG:Acme Corp;Engineering",
    "PHOTO;ENCODING=b;TYPE=JPEG:dGVzdA==",
    "X-SOCIALPROFILE;type=twitter:https://twitter.com/example_user",
    "END:VCARD",
  ].join("\r\n");
  mockFetchVCards.mockResolvedValueOnce([{ url: "https://dav.example.com/c/rt-2.vcf", etag: '"e1"', data: CARD }]);
  mockUpdateVCard.mockResolvedValueOnce({ ok: true });

  await service.updateContact("https://dav.example.com/c/", "rt-2", { title: "Engineer" });

  const sent = mockUpdateVCard.mock.calls[0][0].vCard.data as string;
  expect(sent).toContain("PHOTO;ENCODING=b;TYPE=JPEG:dGVzdA==");
  expect(sent).toContain("N:Smith;Alice;Beth;Dr.;Jr.");
  expect(sent).toContain("ORG:Acme Corp;Engineering");
  expect(sent).toContain("X-SOCIALPROFILE;type=twitter:https://twitter.com/example_user");
  expect(sent).toContain("TITLE:Engineer");
});
```

Run it (expect FAIL), then in `CardDavService.ts` extend the `merged` object (:133-150) with:

```typescript
      middleName: updates.middleName ?? current.middleName,
      namePrefix: updates.namePrefix ?? current.namePrefix,
      nameSuffix: updates.nameSuffix ?? current.nameSuffix,
      orgUnits: updates.orgUnits ?? current.orgUnits,
      socialProfiles: updates.socialProfiles ?? current.socialProfiles,
      photo: current.photo,
```

And in `applyDetailLevel` (:26-32) strip `photo` in BOTH modes (tool output never carries photo binary — that was the point of the 25 MB fix; round-trip fidelity now lives at the parse layer, not the tool payload):

```typescript
function applyDetailLevel(contact: Contact, level: DetailLevel): Contact {
  const { photo: _photo, ...rest } = contact;
  if (level === "full") return rest;
  return { ...rest, otherProperties: [] };
}
```

- [ ] **Step 5: Run both package suites, commit, open PR**

Run: `cd packages/core && npx vitest run && cd ../card-mcp && npx vitest run`
Expected: all pass (if an existing test asserts PHOTO is stripped from parse output, update it to assert it is stripped from *tool/service* output but present on the parsed Contact).

```bash
git add packages/core packages/card-mcp
git commit -m "fix(card-mcp): stop destroying PHOTO/N-parts/ORG-units/socialProfiles on update"
gh pr create --title "fix: contact update round-trip preservation" --body "update_contact permanently deleted the photo, middle name/prefix/suffix, ORG departments, and all social profiles. Parse layer now retains them; tool payloads still exclude photo binary in both detail levels."
```

---

### Task 4.1: CardDAV update/delete must surface HTTP errors; failed login must not poison the client (PR 4)

**Files:**
- Modify: `packages/card-mcp/src/services/CardDavService.ts:42-57` (connect), `:152-159` (update), `:172-178` (delete)
- Test: `packages/card-mcp/src/__tests__/CardDavService.test.ts`

**Interfaces:**
- Consumes: `ContactError`, `ErrorCode` from pim-core (`ErrorCode.CONTACT_CONFLICT` exists and is currently unreachable).

**Why:** tsdav returns a fetch `Response` and does not throw on HTTP errors; only create checks `ok`. A 412 ETag conflict on update/delete currently reports success. Separately, `connect()` assigns `this.client` before `login()` — a failed login leaves a never-authenticated client that passes `ensureConnected` forever.

- [ ] **Step 1: Write the failing tests**

```typescript
describe("HTTP error surfacing", () => {
  const CARD = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:h-1\r\nFN:Alice Smith\r\nEND:VCARD";

  it("updateContact throws CONTACT_CONFLICT on 412", async () => {
    mockFetchVCards.mockResolvedValueOnce([{ url: "u", etag: '"e1"', data: CARD }]);
    mockUpdateVCard.mockResolvedValueOnce({ ok: false, status: 412, statusText: "Precondition Failed" });
    await expect(service.updateContact("book", "h-1", { title: "x" })).rejects.toMatchObject({
      code: "CONTACT_CONFLICT",
    });
  });

  it("deleteContact throws on 403 instead of reporting success", async () => {
    mockFetchVCards.mockResolvedValueOnce([{ url: "u", etag: '"e1"', data: CARD }]);
    mockDeleteVCard.mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden" });
    await expect(service.deleteContact("book", "h-1")).rejects.toThrow(/403/);
  });

  it("failed login does not leave a half-connected client", async () => {
    mockLogin.mockRejectedValueOnce(new Error("bad credentials"));
    await expect(service.connect()).rejects.toThrow();
    // second attempt must try login again, not silently reuse a dead client
    mockLogin.mockResolvedValueOnce(undefined);
    mockFetchAddressBooks.mockResolvedValueOnce([]);
    await service.listAddressBooks();
    expect(mockLogin).toHaveBeenCalledTimes(2);
  });
});
```

Adapt mock names (`mockLogin`, `mockDeleteVCard`, `mockFetchAddressBooks`) to whatever the existing `vi.mock("tsdav")` block in this file exposes; add any missing ones to that block.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/card-mcp && npx vitest run src/__tests__/CardDavService.test.ts`
Expected: first two FAIL (resolve successfully); third FAILS (login called once).

- [ ] **Step 3: Implement**

Add a private helper and use it after both calls:

```typescript
  private checkDavResponse(response: unknown, action: string, uid: string): void {
    const res = response as { ok?: boolean; status?: number; statusText?: string } | null;
    if (!res || res.ok !== false) return;
    if (res.status === 412) {
      throw new ContactError(
        `Contact ${uid} changed on the server since it was read (etag conflict) — re-read and retry`,
        ErrorCode.CONTACT_CONFLICT,
        uid,
      );
    }
    if (res.status === 404) {
      throw new ContactError(`Contact ${uid} not found`, ErrorCode.CONTACT_NOT_FOUND, uid);
    }
    throw new ContactError(
      `Failed to ${action} contact ${uid}: HTTP ${res.status} ${res.statusText ?? ""}`.trim(),
      ErrorCode.INTERNAL_ERROR,
      uid,
    );
  }
```

In `updateContact`: `const response = await client.updateVCard({...}); this.checkDavResponse(response, "update", uid);` — and in the catch, rethrow `ContactError` unchanged before `toPimError` (mirror `createContact`'s `if (error instanceof ContactError) throw error;`). Same for `deleteContact` with `"delete"`.

Fix `connect()` to assign only after login succeeds:

```typescript
  async connect(): Promise<void> {
    try {
      const client = new DAVClient({
        serverUrl: this.config.url,
        credentials: { username: this.config.username, password: this.config.password },
        authMethod: "Basic",
        defaultAccountType: "carddav",
      });
      await client.login();
      this.client = client;
    } catch (error) {
      this.client = null;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }
```

- [ ] **Step 4: Run, commit, open PR**

Run: `cd packages/card-mcp && npx vitest run` → all pass.

```bash
git add packages/card-mcp
git commit -m "fix(card-mcp): surface update/delete HTTP errors (412 -> CONTACT_CONFLICT); reset client on failed login"
gh pr create --title "fix(card-mcp): stop swallowing update/delete failures" --body "tsdav doesn't throw on HTTP errors; a 412 etag conflict reported success and ErrorCode.CONTACT_CONFLICT was unreachable. Also fixes half-connected client after failed login."
```

---

### Task 5.1: pim-core `updateMasterEventIcs` — targeted master-VEVENT mutation (PR 5)

**Files:**
- Modify: `packages/core/src/ics/components.ts` (new function + exported interface), `packages/core/src/ics/generate.ts` (export `toIcalTime`), `packages/core/src/ics/index.ts` or `packages/core/src/index.ts` (re-export — mirror how `createExceptionComponent` is exported)
- Test: `packages/core/src/__tests__/ics/components.test.ts`

**Interfaces:**
- Produces:
```typescript
export interface MasterEventUpdates {
  title?: string;
  start?: string;          // ISO 8601
  end?: string;
  all_day?: boolean;
  location?: string;       // "" removes the property
  description?: string;    // "" removes the property
  attendees?: Array<{ email: string }>;   // replaces the list (participation state of replaced attendees is reset — inherent)
  alarms?: Array<{ type: "relative" | "absolute"; trigger: number | string }>;
  categories?: string[];
  organizer?: { email: string; name?: string | null };
  availability?: "busy" | "free";
  timezone?: string;       // TZID for rewritten DTSTART/DTEND
}
export function updateMasterEventIcs(rawIcs: string, updates: MasterEventUpdates): string;
```
- Task 5.2 consumes this from `@miguelarios/pim-core`.

**Why:** `update_event` on the non-exception path regenerates the whole object via `generateEventIcs`, which never receives `recurrence_rule` — renaming a weekly meeting flattens it to a single event and wipes EXDATE/RDATE/exception overrides. It also resets attendee PARTSTAT to nothing, rewrites STATUS to CONFIRMED, and never bumps SEQUENCE. The fix: mutate only the fields being changed, in place.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/__tests__/ics/components.test.ts`:

```typescript
import { updateMasterEventIcs } from "../../ics/components.js";

const RECURRING_MASTER = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//test//EN",
  "BEGIN:VEVENT",
  "UID:weekly-1",
  "DTSTAMP:20260301T000000Z",
  "DTSTART:20260302T150000Z",
  "DTEND:20260302T153000Z",
  "SUMMARY:Weekly sync",
  "STATUS:TENTATIVE",
  "SEQUENCE:2",
  "RRULE:FREQ=WEEKLY;BYDAY=MO",
  "EXDATE:20260316T150000Z",
  "URL:https://example.com/meeting",
  "ORGANIZER;CN=alice:mailto:alice@example.com",
  "ATTENDEE;PARTSTAT=ACCEPTED;CN=Bob Jones:mailto:bob@example.com",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:weekly-1",
  "RECURRENCE-ID:20260309T150000Z",
  "DTSTAMP:20260301T000000Z",
  "DTSTART:20260309T160000Z",
  "DTEND:20260309T163000Z",
  "SUMMARY:Weekly sync (moved)",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("updateMasterEventIcs", () => {
  it("changes only the requested field and preserves everything else", () => {
    const out = updateMasterEventIcs(RECURRING_MASTER, { title: "Weekly sync v2" });
    expect(out).toContain("SUMMARY:Weekly sync v2");
    expect(out).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO");
    expect(out).toContain("EXDATE:20260316T150000Z");
    expect(out).toContain("RECURRENCE-ID:20260309T150000Z"); // exception override survives
    expect(out).toContain("PARTSTAT=ACCEPTED");              // attendee state survives
    expect(out).toContain("STATUS:TENTATIVE");               // status not rewritten
    expect(out).toContain("URL:https://example.com/meeting"); // unknown props survive
    expect(out).toContain("SEQUENCE:3");                     // bumped from 2
  });

  it("replaces the attendee list only when attendees are provided", () => {
    const out = updateMasterEventIcs(RECURRING_MASTER, {
      attendees: [{ email: "carol@example.com" }],
    });
    expect(out).toContain("mailto:carol@example.com");
    expect(out).not.toContain("mailto:bob@example.com");
  });

  it("rewrites DTSTART/DTEND when start/end provided, without touching RRULE", () => {
    const out = updateMasterEventIcs(RECURRING_MASTER, {
      start: "2026-03-02T16:00:00Z",
      end: "2026-03-02T16:30:00Z",
    });
    expect(out).toContain("DTSTART:20260302T160000Z");
    expect(out).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/core && npx vitest run src/__tests__/ics/components.test.ts`
Expected: FAIL — `updateMasterEventIcs` is not exported.

- [ ] **Step 3: Implement**

In `generate.ts`, change `function toIcalTime` to `export function toIcalTime`. In `components.ts`:

```typescript
import { toIcalTime } from "./generate.js";

export function updateMasterEventIcs(rawIcs: string, updates: MasterEventUpdates): string {
  const root = parseRoot(rawIcs);
  const master = root
    .getAllSubcomponents("vevent")
    .find((c) => !c.getFirstProperty("recurrence-id"));
  if (!master) throw new IcsParseError("No master VEVENT found in ICS", null);

  const currentDtstart = master.getFirstPropertyValue("dtstart");
  const currentAllDay = currentDtstart instanceof ICAL.Time ? currentDtstart.isDate : false;
  const allDay = updates.all_day ?? currentAllDay;

  if (updates.title !== undefined) master.updatePropertyWithValue("summary", updates.title);

  const setTime = (propName: "dtstart" | "dtend", iso: string) => {
    const t = toIcalTime(iso, allDay, updates.timezone);
    const prop = master.updatePropertyWithValue(propName, t);
    prop.removeParameter("tzid");
    prop.removeParameter("value");
    if (allDay) prop.setParameter("value", "DATE");
    else if (updates.timezone && ICAL.TimezoneService.get(updates.timezone)) {
      prop.setParameter("tzid", updates.timezone);
    }
  };
  if (updates.start !== undefined) setTime("dtstart", updates.start);
  if (updates.end !== undefined) setTime("dtend", updates.end);

  const setOrRemove = (propName: string, value: string | undefined) => {
    if (value === undefined) return;
    if (value === "") master.removeAllProperties(propName);
    else master.updatePropertyWithValue(propName, value);
  };
  setOrRemove("location", updates.location);
  setOrRemove("description", updates.description);

  if (updates.organizer) {
    const name =
      updates.organizer.name && updates.organizer.name.trim().length > 0
        ? updates.organizer.name
        : updates.organizer.email.split("@")[0];
    const orgProp = master.updatePropertyWithValue("organizer", `mailto:${updates.organizer.email}`);
    orgProp.setParameter("cn", name);
  }

  if (updates.attendees !== undefined) {
    master.removeAllProperties("attendee");
    for (const att of updates.attendees) {
      master.addPropertyWithValue("attendee", `mailto:${att.email}`);
    }
  }

  if (updates.categories !== undefined) {
    master.removeAllProperties("categories");
    if (updates.categories.length > 0) {
      master.addPropertyWithValue("categories", updates.categories.join(","));
    }
  }

  if (updates.availability === "free") master.updatePropertyWithValue("transp", "TRANSPARENT");
  else if (updates.availability === "busy") master.updatePropertyWithValue("transp", "OPAQUE");

  if (updates.alarms !== undefined) {
    for (const valarm of master.getAllSubcomponents("valarm")) {
      master.removeSubcomponent(valarm);
    }
    for (const alarm of updates.alarms) {
      const valarm = new ICAL.Component("valarm");
      valarm.updatePropertyWithValue("action", "DISPLAY");
      const summary = master.getFirstPropertyValue("summary");
      valarm.updatePropertyWithValue("description", typeof summary === "string" ? summary : "Reminder");
      if (alarm.type === "relative" && typeof alarm.trigger === "number") {
        valarm.updatePropertyWithValue("trigger", ICAL.Duration.fromSeconds(alarm.trigger));
      } else if (alarm.type === "absolute" && typeof alarm.trigger === "string") {
        valarm.updatePropertyWithValue("trigger", ICAL.Time.fromJSDate(new Date(alarm.trigger), true));
      }
      master.addSubcomponent(valarm);
    }
  }

  const seq = master.getFirstPropertyValue("sequence");
  master.updatePropertyWithValue("sequence", (typeof seq === "number" ? seq : 0) + 1);
  master.updatePropertyWithValue("dtstamp", ICAL.Time.now());

  return root.toString();
}
```

Note: ical.js serializes date-times in the form the ICAL.Time carries; the DTSTART assertion in the test uses the UTC `Z` form because `toIcalTime` without a registered TZID returns UTC. If serialization differs cosmetically (e.g. `DTSTART;VALUE=DATE-TIME:`), loosen the test to a regex on the timestamp digits — behavior, not formatting, is under test.

- [ ] **Step 4: Run, commit**

Run: `cd packages/core && npx vitest run`

```bash
git add packages/core
git commit -m "feat(pim-core): updateMasterEventIcs — targeted master VEVENT mutation preserving RRULE/EXDATE/overrides"
```

### Task 5.2: Wire update_event's non-exception path to updateMasterEventIcs (PR 5)

**Files:**
- Modify: `packages/cal-mcp/src/tools/calendarTools.ts:723-773` (the non-exception update path)
- Test: `packages/cal-mcp/src/__tests__/calendarTools.test.ts`

**Interfaces:**
- Consumes: `updateMasterEventIcs` from `@miguelarios/pim-core`; `service.fetchRawCalendarObject(calendar, uid)` → `{ data, url, etag }` (already used by the exception path at :646).

- [ ] **Step 1: Write the failing test (the exact bug: span "all" on a recurring event)**

Append to `calendarTools.test.ts` (uses the file's real-pim-core pattern — the mock service returns raw ICS and the test asserts on what reaches `updateEvent`, like the exception tests at :458-668):

```typescript
it("update_event span=all on a recurring event preserves RRULE, EXDATE, overrides, PARTSTAT, STATUS", async () => {
  const MASTER = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN",
    "BEGIN:VEVENT", "UID:weekly-9", "DTSTAMP:20260301T000000Z",
    "DTSTART:20260302T150000Z", "DTEND:20260302T153000Z",
    "SUMMARY:Weekly sync", "STATUS:TENTATIVE", "SEQUENCE:1",
    "RRULE:FREQ=WEEKLY;BYDAY=MO", "EXDATE:20260316T150000Z",
    "ORGANIZER;CN=alice:mailto:alice@example.com",
    "ATTENDEE;PARTSTAT=ACCEPTED:mailto:bob@example.com",
    "END:VEVENT",
    "BEGIN:VEVENT", "UID:weekly-9", "RECURRENCE-ID:20260309T150000Z",
    "DTSTAMP:20260301T000000Z", "DTSTART:20260309T160000Z", "DTEND:20260309T163000Z",
    "SUMMARY:Weekly sync (moved)", "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  mockService.getEventWithMeta.mockResolvedValueOnce({
    event: {
      uid: "weekly-9", calendar_id: "mailbox/Calendar", title: "Weekly sync",
      start: "2026-03-02T15:00:00.000Z", end: "2026-03-02T15:30:00.000Z",
      all_day: false, is_recurring: true, recurrence_rule: "FREQ=WEEKLY;BYDAY=MO",
      organizer: { email: "alice@example.com", name: "alice" },
      attendees: [{ email: "bob@example.com" }],
    },
    meta: { url: "https://dav.example.com/cal/weekly-9.ics", etag: '"e9"' },
  });
  mockService.fetchRawCalendarObject.mockResolvedValueOnce({
    data: MASTER, url: "https://dav.example.com/cal/weekly-9.ics", etag: '"e9"',
  });
  mockService.updateEvent.mockResolvedValueOnce({ uid: "weekly-9" });

  const result = await handleCalendarTool(mockService as any, "update_event", {
    calendar: "mailbox/Calendar", uid: "weekly-9", span: "all", title: "Weekly sync v2",
  });

  expect(result.isError).toBeFalsy();
  const sentIcs = mockService.updateEvent.mock.calls[0][2] as string;
  expect(sentIcs).toContain("SUMMARY:Weekly sync v2");
  expect(sentIcs).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO");
  expect(sentIcs).toContain("EXDATE:20260316T150000Z");
  expect(sentIcs).toContain("RECURRENCE-ID:20260309T150000Z");
  expect(sentIcs).toContain("PARTSTAT=ACCEPTED");
  expect(sentIcs).toContain("STATUS:TENTATIVE");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/cal-mcp && npx vitest run src/__tests__/calendarTools.test.ts`
Expected: FAIL — sent ICS has no RRULE (regenerated from scratch today).

- [ ] **Step 3: Replace the non-exception path**

Replace `calendarTools.ts:723-772` (from `const effectiveAttendees =` through `return ok({ event });`) with:

```typescript
        // Non-exception path (span "all", or non-recurring event): mutate the
        // existing object in place — preserves RRULE/EXDATE/RDATE, exception
        // overrides, attendee participation state, STATUS, and unknown props.
        const rawObj = await service.fetchRawCalendarObject(
          args.calendar as string,
          args.uid as string,
        );

        const updates: MasterEventUpdates = { timezone: getTimezone() };
        if (args.title !== undefined) updates.title = args.title as string;
        if (args.start !== undefined) updates.start = args.start as string;
        if (args.end !== undefined) updates.end = args.end as string;
        if (args.all_day !== undefined) updates.all_day = args.all_day as boolean;
        if (args.location !== undefined) updates.location = args.location as string;
        if (args.description !== undefined) updates.description = args.description as string;
        if (args.attendees !== undefined)
          updates.attendees = args.attendees as Array<{ email: string }>;
        if (args.alarms !== undefined)
          updates.alarms = args.alarms as Array<{
            type: "relative" | "absolute";
            trigger: number | string;
          }>;
        if (args.categories !== undefined) updates.categories = args.categories as string[];
        if (args.availability !== undefined)
          updates.availability = args.availability as "busy" | "free";

        // Inject ORGANIZER only when the event will have attendees but has none
        // (CalDAV scheduling servers reject ATTENDEE-without-ORGANIZER, RFC 6638).
        const effectiveAttendees = updates.attendees ?? existing.attendees;
        if (effectiveAttendees && effectiveAttendees.length > 0 && !existing.organizer) {
          updates.organizer = { email: service.getAccountEmail(args.calendar as string) };
        }

        const updatedIcs = updateMasterEventIcs(rawObj.data, updates);
        const event = await service.updateEvent(args.calendar as string, args.uid as string, updatedIcs, {
          url: rawObj.url,
          etag: rawObj.etag,
        });
        return ok({ event });
```

Import `updateMasterEventIcs` and `type MasterEventUpdates` from `@miguelarios/pim-core` at the top of the file (next to the existing `createExceptionComponent`/`combineIcsComponents` imports). The `meta` variable from `getEventWithMeta` becomes unused in this branch — keep it (the exception branch and the destructure still need `existing`); if Biome flags it, destructure as `const { event: existing } = ...` and fetch meta only where used.

- [ ] **Step 4: Run the full cal-mcp suite; reconcile existing update_event tests**

Run: `cd packages/cal-mcp && npx vitest run`
Existing non-recurring `update_event` tests asserted on `generateEventIcs` output reaching `updateEvent` and may assert `meta` was passed through from `getEventWithMeta`. Update them: the ICS now derives from `fetchRawCalendarObject` (mock must return raw ICS for those tests too) and `{url, etag}` comes from `rawObj`. Field-preservation semantics for non-recurring events are strictly better (STATUS/attendee params no longer reset) — assertions expecting `STATUS:CONFIRMED` rewrites should be updated to expect preservation.

- [ ] **Step 5: Commit, open PR**

```bash
git add packages/core packages/cal-mcp
git commit -m "fix(cal-mcp): update_event mutates in place — no more RRULE/exception/PARTSTAT destruction"
gh pr create --title "fix(cal-mcp): update_event span=all destroyed recurring series" --body "Renaming a weekly meeting flattened it to a single event (RRULE/EXDATE/overrides wiped), reset attendee PARTSTAT, forced STATUS:CONFIRMED, never bumped SEQUENCE. New pim-core updateMasterEventIcs mutates only requested fields."
```

---

### Task 6.1: Timezone-correct day bounds + preferred hours (PR 6)

**Files:**
- Modify: `packages/core/src/timezone.ts` (two new helpers), `packages/cal-mcp/src/tools/calendarTools.ts:548-563` (get_today_events), `packages/cal-mcp/src/services/CalDavService.ts:801-879` (preferred-hours split/sort)
- Test: `packages/core/src/__tests__/timezone.test.ts`, `packages/cal-mcp/src/__tests__/calendarTools.test.ts`, `packages/cal-mcp/src/__tests__/CalDavService.test.ts`

**Interfaces:**
- Produces (pim-core `timezone.ts`, re-export from the package index):
```typescript
export function getLocalDateParts(date: Date, timeZone: string): { year: number; month: number; day: number };
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date;  // month is 1-based
```

**Why:** `get_today_events` builds "today" from the server process's local clock (`new Date(y, m, d)`), and `find_free_slots` computes preferred-hour boundaries with `setUTCHours` — `preferred_start: "09:00"` means 09:00 UTC = 3–4 AM Chicago. All existing tests run under `PIM_TIMEZONE=UTC`, which is why this is invisible.

- [ ] **Step 1: Write failing core tests (include a DST boundary)**

Append to `timezone.test.ts`:

```typescript
import { getLocalDateParts, zonedTimeToUtc } from "../timezone.js";

describe("zonedTimeToUtc", () => {
  it("converts Chicago local time to the correct UTC instant (CST, UTC-6)", () => {
    expect(zonedTimeToUtc(2026, 1, 15, 9, 0, "America/Chicago").toISOString()).toBe(
      "2026-01-15T15:00:00.000Z",
    );
  });
  it("handles the spring-forward DST transition (CDT, UTC-5)", () => {
    expect(zonedTimeToUtc(2026, 3, 9, 9, 0, "America/Chicago").toISOString()).toBe(
      "2026-03-09T14:00:00.000Z",
    );
  });
  it("rolls over month boundaries via day overflow", () => {
    expect(zonedTimeToUtc(2026, 1, 32, 0, 0, "UTC").toISOString()).toBe(
      "2026-02-01T00:00:00.000Z",
    );
  });
});

describe("getLocalDateParts", () => {
  it("returns the calendar date in the target zone, not the host zone", () => {
    // 2026-07-10T03:00Z is still 2026-07-09 in Chicago (UTC-5)
    expect(getLocalDateParts(new Date("2026-07-10T03:00:00Z"), "America/Chicago")).toEqual({
      year: 2026, month: 7, day: 9,
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/core && npx vitest run src/__tests__/timezone.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement in timezone.ts**

```typescript
function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

/** Calendar date of `date` as seen in `timeZone`. */
export function getLocalDateParts(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/** UTC instant of wall-clock (y, m, d, hh, mm) in `timeZone`. Month is 1-based; day may overflow. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  // Two-pass correction converges across DST transitions.
  let offset = tzOffsetMs(new Date(utcGuess), timeZone);
  offset = tzOffsetMs(new Date(utcGuess - offset), timeZone);
  return new Date(utcGuess - offset);
}
```

- [ ] **Step 4: Fix get_today_events — failing test first**

```typescript
it("get_today_events computes day bounds in PIM_TIMEZONE, not host time", async () => {
  vi.stubEnv("PIM_TIMEZONE", "America/Chicago");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-10T03:00:00Z")); // still July 9 in Chicago
  mockService.listEvents.mockResolvedValueOnce([]);

  await handleCalendarTool(mockService as any, "get_today_events", {});

  const [, start, end] = mockService.listEvents.mock.calls[0];
  expect(start).toBe("2026-07-09T05:00:00.000Z"); // Chicago midnight (CDT)
  expect(end).toBe("2026-07-10T05:00:00.000Z");   // next midnight, exclusive
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
```

(Adapt the mock call target if `fetchEvents` routes through `listEventsFull`/`listEvents` differently for the no-calendar case — mirror the existing `get_today_events` test's mock.) Run → FAIL. Then replace the handler body (:551-560):

```typescript
        const tz = getTimezone();
        const now = new Date();
        const { year, month, day } = getLocalDateParts(now, tz);
        const todayStart = zonedTimeToUtc(year, month, day, 0, 0, tz).toISOString();
        const todayEnd = zonedTimeToUtc(year, month, day + 1, 0, 0, tz).toISOString();
```

(imports from `@miguelarios/pim-core`; note this also fixes the old 23:59:59 end that missed the last second — half-open `[start, next-midnight)` matches the RFC 4791 range convention used everywhere else).

- [ ] **Step 5: Fix find_free_slots preferred hours — failing test first**

In `CalDavService.test.ts`, add a test that constructs the service with a Chicago timezone and one busy event, asks for `preferredStart: "09:00"`/`preferredEnd: "17:00"`, and asserts a returned slot boundary lands at `T14:00:00.000Z` (9 AM CDT), not `T09:00:00.000Z`. Follow the existing findFreeSlots test setup in that file for mocks; check how the service obtains its timezone (`this.timezone` — set in the constructor from `getTimezone()`), and use `vi.stubEnv("PIM_TIMEZONE", "America/Chicago")` **before** constructing the service. Run → FAIL.

Then in `CalDavService.ts:801-876`, replace UTC-based boundary math:
- Day iteration: `const dayParts = getLocalDateParts(slotStart, this.timezone);` then for `d = 0..1`: `const prefS = zonedTimeToUtc(dayParts.year, dayParts.month, dayParts.day + d, prefStartH, prefStartM, this.timezone);` and same for `prefE` — replacing the `setUTCHours` block (:815-831).
- Preferred-window sort check (:865-875): replace `getUTCHours()/getUTCMinutes()` with local minutes via `Intl`:
```typescript
      const localMinutes = (d: Date): number => {
        const dtf = new Intl.DateTimeFormat("en-US", {
          timeZone: this.timezone,
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        const parts: Record<string, string> = {};
        for (const p of dtf.formatToParts(d)) parts[p.type] = p.value;
        return (parts.hour === "24" ? 0 : Number(parts.hour)) * 60 + Number(parts.minute);
      };
```
used as `const aMinutes = localMinutes(aDate);` etc.

- [ ] **Step 6: Run all suites, commit, open PR**

Run: `npm test` (existing UTC-based tests must still pass — under `PIM_TIMEZONE=UTC` the new math degenerates to the old behavior).

```bash
git add packages/core packages/cal-mcp
git commit -m "fix(cal-mcp): get_today_events and find_free_slots preferred hours respect PIM_TIMEZONE"
gh pr create --title "fix(cal-mcp): timezone-correct today bounds and preferred hours" --body "'today' was host-process local; preferred_start 09:00 meant 09:00 UTC (3-4 AM Chicago). Adds DST-safe zonedTimeToUtc/getLocalDateParts to pim-core; tests now include an America/Chicago matrix."
```

---

### Task 7.1: import_ics splits multi-UID files into per-UID objects (PR 7)

**Files:**
- Modify: `packages/core/src/ics/components.ts` (new `splitIcsByUid`), `packages/cal-mcp/src/tools/calendarTools.ts:871-888`
- Test: `packages/core/src/__tests__/ics/components.test.ts`, `packages/cal-mcp/src/__tests__/calendarTools.test.ts`

**Interfaces:**
- Produces: `export function splitIcsByUid(icsContent: string): Array<{ uid: string; ics: string }>` — one VCALENDAR per unique UID, each containing that UID's master + its RECURRENCE-ID overrides, with all VTIMEZONE subcomponents copied into each.

**Why:** `import_ics` PUTs the whole file as one object under the first UID — RFC 4791 §4.1 requires one UID per calendar object; SabreDAV (Nextcloud) rejects or corrupts multi-UID objects. It also reports `imported: parsed.length`, over-counting recurring events (master + N overrides parse to N+1 ParsedEvents).

- [ ] **Step 1: Failing core test**

```typescript
describe("splitIcsByUid", () => {
  const MULTI = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN",
    "BEGIN:VTIMEZONE", "TZID:America/Chicago", "BEGIN:STANDARD",
    "DTSTART:20261101T020000", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0600",
    "END:STANDARD", "END:VTIMEZONE",
    "BEGIN:VEVENT", "UID:a-1", "DTSTAMP:20260301T000000Z",
    "DTSTART:20260302T150000Z", "DTEND:20260302T153000Z", "SUMMARY:Event A",
    "RRULE:FREQ=WEEKLY", "END:VEVENT",
    "BEGIN:VEVENT", "UID:a-1", "RECURRENCE-ID:20260309T150000Z", "DTSTAMP:20260301T000000Z",
    "DTSTART:20260309T160000Z", "DTEND:20260309T163000Z", "SUMMARY:Event A moved", "END:VEVENT",
    "BEGIN:VEVENT", "UID:b-2", "DTSTAMP:20260301T000000Z",
    "DTSTART:20260401T150000Z", "DTEND:20260401T153000Z", "SUMMARY:Event B", "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

  it("groups master + overrides per UID and copies VTIMEZONE into each", () => {
    const groups = splitIcsByUid(MULTI);
    expect(groups.map((g) => g.uid).sort()).toEqual(["a-1", "b-2"]);
    const a = groups.find((g) => g.uid === "a-1")!.ics;
    expect(a.match(/BEGIN:VEVENT/g)).toHaveLength(2);   // master + override
    expect(a).toContain("TZID:America/Chicago");
    const b = groups.find((g) => g.uid === "b-2")!.ics;
    expect(b.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(b).not.toContain("Event A");
  });
});
```

Run → FAIL (not exported).

- [ ] **Step 2: Implement**

```typescript
export function splitIcsByUid(icsContent: string): Array<{ uid: string; ics: string }> {
  const root = parseRoot(icsContent);
  const timezones = root.getAllSubcomponents("vtimezone");
  const byUid = new Map<string, ICAL.Component[]>();
  for (const type of ["vevent", "vtodo"] as const) {
    for (const comp of root.getAllSubcomponents(type)) {
      const uid = comp.getFirstPropertyValue("uid");
      if (typeof uid !== "string" || !uid) continue;
      const list = byUid.get(uid) ?? [];
      list.push(comp);
      byUid.set(uid, list);
    }
  }
  const results: Array<{ uid: string; ics: string }> = [];
  for (const [uid, comps] of byUid) {
    const cal = new ICAL.Component(["vcalendar", [], []]);
    cal.updatePropertyWithValue("prodid", "-//pim-core//import-split//EN");
    cal.updatePropertyWithValue("version", "2.0");
    for (const tz of timezones) cal.addSubcomponent(ICAL.Component.fromString(tz.toString()));
    for (const comp of comps) cal.addSubcomponent(ICAL.Component.fromString(comp.toString()));
    results.push({ uid, ics: cal.toString() });
  }
  return results;
}
```

(The `Component.fromString(x.toString())` round-trip clones components so the source tree isn't mutated when re-parenting.) Run → PASS. Commit: `feat(pim-core): splitIcsByUid for RFC 4791-compliant multi-event import`.

- [ ] **Step 3: Failing cal-mcp handler test**

```typescript
it("import_ics PUTs one object per UID and reports unique-UID count", async () => {
  const MULTI = "..."; // same fixture as the core test — inline it here too
  mockService.createEvent.mockResolvedValue({ uid: "x" });
  mockService.getEvent.mockResolvedValue({ uid: "x" });

  const result = await handleCalendarTool(mockService as any, "import_ics", {
    calendar: "mailbox/PIM-Test", ics_content: MULTI,
  });

  expect(mockService.createEvent).toHaveBeenCalledTimes(2); // a-1 and b-2, not 1
  const payload = JSON.parse(result.content[0].text);
  expect(payload.imported).toBe(2); // unique UIDs, not 3 ParsedEvents
});
```

Run → FAIL. Then replace the `import_ics` case (:871-888):

```typescript
      case "import_ics": {
        const icsContent = args.ics_content as string;
        const groups = splitIcsByUid(icsContent);
        if (groups.length === 0) {
          return error("validation_error", "No events found in ICS content");
        }
        const importedEvents = [];
        const failed: Array<{ uid: string; message: string }> = [];
        for (const group of groups) {
          try {
            await service.createEvent(args.calendar as string, group.ics, group.uid);
            try {
              importedEvents.push(await service.getEvent(args.calendar as string, group.uid));
            } catch {
              importedEvents.push({ uid: group.uid });
            }
          } catch (err) {
            failed.push({ uid: group.uid, message: err instanceof Error ? err.message : String(err) });
          }
        }
        return ok({
          imported: importedEvents.length,
          ...(failed.length > 0 ? { failed } : {}),
          events: importedEvents,
        });
      }
```

Import `splitIcsByUid` from pim-core; `parseIcsEvents` may become unused in this file — remove the import if so. Run full cal-mcp suite → reconcile any existing import_ics assertions (imported count semantics changed from ParsedEvents to unique UIDs — that's the fix). Commit: `fix(cal-mcp): import_ics splits multi-UID files into per-UID objects`.

### Task 7.2: delete_event span=this removes overrides via ical.js, not regex (PR 7)

**Files:**
- Modify: `packages/core/src/ics/components.ts` (new `removeExceptionFromIcs`), `packages/cal-mcp/src/tools/calendarTools.ts:800-812`
- Test: `packages/core/src/__tests__/ics/components.test.ts`

**Interfaces:**
- Produces: `export function removeExceptionFromIcs(icsContent: string, occurrenceDate: string, allDay: boolean): string` — removes any VEVENT/VTODO whose RECURRENCE-ID matches the occurrence (epoch comparison for timed, Y-M-D comparison for all-day — same convention as `addExdateToIcs`).

**Why:** The current regex builds the RECURRENCE-ID in UTC `...Z` form; a stored override written as `RECURRENCE-ID;TZID=America/Chicago:20260305T100000` (Apple/Thunderbird/Nextcloud clients) never matches — the EXDATE is added but the orphaned override VEVENT remains → ghost events.

- [ ] **Step 1: Failing test — TZID-form override**

```typescript
describe("removeExceptionFromIcs", () => {
  it("removes a TZID-form override that the old regex missed", () => {
    const ICS = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN",
      "BEGIN:VTIMEZONE", "TZID:America/Chicago", "BEGIN:DAYLIGHT",
      "DTSTART:20260308T030000", "TZOFFSETFROM:-0600", "TZOFFSETTO:-0500",
      "END:DAYLIGHT", "END:VTIMEZONE",
      "BEGIN:VEVENT", "UID:tz-1", "DTSTAMP:20260301T000000Z",
      "DTSTART;TZID=America/Chicago:20260302T100000", "DTEND;TZID=America/Chicago:20260302T103000",
      "SUMMARY:Standup", "RRULE:FREQ=WEEKLY;BYDAY=MO", "END:VEVENT",
      "BEGIN:VEVENT", "UID:tz-1",
      "RECURRENCE-ID;TZID=America/Chicago:20260309T100000",
      "DTSTAMP:20260301T000000Z",
      "DTSTART;TZID=America/Chicago:20260309T110000", "DTEND;TZID=America/Chicago:20260309T113000",
      "SUMMARY:Standup (moved)", "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    // 2026-03-09 10:00 Chicago (CDT, UTC-5) = 15:00Z
    const out = removeExceptionFromIcs(ICS, "2026-03-09T15:00:00.000Z", false);
    expect(out).not.toContain("Standup (moved)");
    expect(out).toContain("RRULE:FREQ=WEEKLY;BYDAY=MO"); // master untouched
  });
});
```

Run → FAIL.

- [ ] **Step 2: Implement**

```typescript
export function removeExceptionFromIcs(
  icsContent: string,
  occurrenceDate: string,
  allDay: boolean,
): string {
  const root = parseRoot(icsContent);
  const target = ICAL.Time.fromJSDate(new Date(occurrenceDate), true);
  const targetMs = target.toJSDate().getTime();
  const targetYmd = `${target.year}-${String(target.month).padStart(2, "0")}-${String(target.day).padStart(2, "0")}`;
  let removed = false;
  for (const type of ["vevent", "vtodo"] as const) {
    for (const comp of root.getAllSubcomponents(type)) {
      const recurId = comp.getFirstPropertyValue("recurrence-id");
      if (!(recurId instanceof ICAL.Time)) continue;
      const matches =
        allDay && recurId.isDate
          ? `${recurId.year}-${String(recurId.month).padStart(2, "0")}-${String(recurId.day).padStart(2, "0")}` === targetYmd
          : recurId.toJSDate().getTime() === targetMs;
      if (matches) {
        root.removeSubcomponent(comp);
        removed = true;
      }
    }
  }
  return removed ? root.toString() : icsContent;
}
```

(ical.js resolves `RECURRENCE-ID;TZID=...` to the correct instant when the VTIMEZONE is present, so epoch comparison covers both UTC and TZID forms.) Run → PASS.

- [ ] **Step 3: Wire into delete_event**

Replace `calendarTools.ts:800-812` (the `recIdDate`/`formattedRecId`/`exceptionRegex` block) with:

```typescript
            updatedIcs = removeExceptionFromIcs(updatedIcs, occurrenceDate, existing.all_day);
```

(after the existing `addExdateToIcs` call — order is interchangeable, both parse the ICS). Import `removeExceptionFromIcs` from pim-core. Run the full cal-mcp suite — the existing UTC-form delete-exception test (`calendarTools.test.ts:635` area) must still pass.

- [ ] **Step 4: Commit, open PR**

```bash
git add packages/core packages/cal-mcp
git commit -m "fix(cal-mcp): remove recurrence overrides via ical.js matching (TZID-form RECURRENCE-ID support)"
gh pr create --title "fix(cal-mcp): import_ics multi-UID split + robust exception removal" --body "import_ics violated RFC 4791 one-UID-per-object (SabreDAV rejects); delete_event span=this left ghost overrides when RECURRENCE-ID used TZID form."
```

---

### Task 8.1: Real MIME part IDs + flags in get_email (PR 8)

**Files:**
- Modify: `packages/email-mcp/src/services/ImapService.ts:196-252` (fetchEmail), `:511-518` (hasAttachmentParts)
- Test: `packages/email-mcp/src/__tests__/ImapService.test.ts`

**Interfaces:**
- Produces: `EmailFull.attachments[].partId` is now the IMAP bodystructure part path (e.g. `"2"`, `"1.2"`) — exactly what `client.download(uid, partId)` expects. `EmailFull.flags` is populated. New module-private `collectAttachmentParts(bodyStructure): Array<{ part: string; filename?: string; contentType: string; size: number }>`.

**Why:** `partId` today is `String(index + 1)` into mailparser's attachments array. For the ubiquitous `multipart/mixed(multipart/alternative, attachment)` layout the attachment is part `"2"` but get_email reports `"1"` — `download_attachment` returns the message body instead of the attachment, essentially always. And `flags: []` is hardcoded, so agents conclude every fetched email is unread.

- [ ] **Step 1: Write the failing test**

```typescript
describe("fetchEmail attachment part IDs", () => {
  it("reports bodystructure part paths, not array indices", async () => {
    mockFetchOne.mockResolvedValueOnce({
      source: Buffer.from("raw"),
      flags: new Set(["\\Seen", "\\Flagged"]),
      bodyStructure: {
        type: "multipart/mixed",
        childNodes: [
          {
            type: "multipart/alternative",
            part: "1",
            childNodes: [
              { type: "text/plain", part: "1.1", size: 20 },
              { type: "text/html", part: "1.2", size: 40 },
            ],
          },
          {
            type: "application/pdf",
            part: "2",
            size: 1024,
            disposition: "attachment",
            dispositionParameters: { filename: "doc.pdf" },
          },
        ],
      },
    });

    const email = await service.fetchEmail("INBOX", 42);

    expect(email.attachments).toEqual([
      { filename: "doc.pdf", contentType: "application/pdf", size: 1024, partId: "2" },
    ]);
    expect(email.flags).toEqual(expect.arrayContaining(["\\Seen", "\\Flagged"]));
    expect(email.hasAttachments).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/email-mcp && npx vitest run src/__tests__/ImapService.test.ts`
Expected: FAIL — partId is `"1"` (mailparser mock has one attachment at index 0) and flags is `[]`.

- [ ] **Step 3: Implement**

Add below `hasAttachmentParts`:

```typescript
interface BodyStructureAttachment {
  part: string;
  filename?: string;
  contentType: string;
  size: number;
}

function collectAttachmentParts(node: any, out: BodyStructureAttachment[] = []): BodyStructureAttachment[] {
  if (!node) return out;
  if (node.childNodes?.length) {
    for (const child of node.childNodes) collectAttachmentParts(child, out);
    return out;
  }
  const disposition = String(node.disposition ?? "").toLowerCase();
  const filename: string | undefined =
    node.dispositionParameters?.filename ?? node.parameters?.name;
  const type = String(node.type ?? "").toLowerCase();
  if (type.startsWith("multipart/")) return out;
  if (disposition === "attachment" || (filename && disposition !== "inline")) {
    out.push({
      part: String(node.part ?? "1"),
      filename,
      contentType: node.type || "application/octet-stream",
      size: node.size ?? 0,
    });
  }
  return out;
}
```

In `fetchEmail`: change the fetchOne query (:202) to `{ source: true, bodyStructure: true, flags: true }`; then:

```typescript
        const attachmentParts = collectAttachmentParts(fetchResult.bodyStructure);
```

and in the returned object replace `flags: []` with `flags: [...(fetchResult.flags ?? [])]`, replace `hasAttachments: (parsed.attachments?.length || 0) > 0` with `hasAttachments: attachmentParts.length > 0`, and replace the mailparser-index attachments mapping (:236-241) with:

```typescript
          attachments: attachmentParts.map((att, index) => ({
            filename: att.filename || `attachment-${index}`,
            contentType: att.contentType,
            size: att.size,
            partId: att.part,
          })),
```

Also replace `hasAttachmentParts`'s body (:511-518) with `return collectAttachmentParts(bodyStructure).length > 0;` so search summaries use the same (more accurate) detection — the old version matched any `multipart/mixed` even with no real attachment.

- [ ] **Step 4: Run the full email suite; reconcile**

Run: `cd packages/email-mcp && npx vitest run`
Existing fetchEmail tests whose fetchOne mocks return no `bodyStructure` will now report `attachments: []` — extend those mocks with a `bodyStructure` when the test is about attachments; tests asserting `hasAttachments` from the summary path may need their bodyStructure fixtures adjusted (a bare `multipart/mixed` with no attachment child now correctly reports `false`).

- [ ] **Step 5: Commit, open PR**

```bash
git add packages/email-mcp
git commit -m "fix(email-mcp): attachment partId from bodystructure part paths; populate flags in get_email"
gh pr create --title "fix(email-mcp): download_attachment fetched the wrong MIME part" --body "get_email's partId was an array index; client.download expects a bodystructure part path — the documented get_email -> download_attachment workflow returned the message body instead of the attachment. Also populates flags (was hardcoded [])."
```

---

### Task 9.1: Trash special-use resolution, BCC-safe drafts, empty-uids guards (PR 9)

**Files:**
- Modify: `packages/email-mcp/src/services/ImapService.ts` (`FALLBACK_NAMES`, `getSpecialUseFolder` caching, `deleteEmails`), `packages/email-mcp/src/services/SmtpService.ts:92-112` (composeRawMessage keepBcc), `packages/email-mcp/src/tools/emailTools.ts` (send_email draft path, send_draft Bcc strip, uids guards)
- Test: `packages/email-mcp/src/__tests__/ImapService.test.ts`, `SmtpService.test.ts`, `emailTools.test.ts`

**Interfaces:**
- Consumes: existing `getSpecialUseFolder(flag)` pattern (`\\Sent`/`\\Drafts` fallbacks at ImapService.ts:395-398).
- Produces: `composeRawMessage(options, { keepBcc?: boolean })` — second optional param; `getSpecialUseFolder` gains a per-instance result cache.

- [ ] **Step 1: Trash resolution — failing test**

```typescript
it("deleteEmails (non-permanent) moves to the special-use trash folder, not hardcoded 'Trash'", async () => {
  mockList.mockResolvedValueOnce([
    { path: "INBOX", specialUse: "\\Inbox", delimiter: "/" },
    { path: "Deleted Items", specialUse: "\\Trash", delimiter: "/" },
  ]);
  await service.deleteEmails("INBOX", [1, 2], false);
  expect(mockMessageMove).toHaveBeenCalledWith("1,2", "Deleted Items", { uid: true });
});
```

Run → FAIL (moves to `"Trash"`). Implement: add to `FALLBACK_NAMES`: `"\\Trash": ["Trash", "Deleted Items", "Deleted Messages", "INBOX.Trash"],`. Add caching to `getSpecialUseFolder`:

```typescript
  private specialUseCache = new Map<string, string>();

  async getSpecialUseFolder(flag: string): Promise<string> {
    const cached = this.specialUseCache.get(flag);
    if (cached) return cached;
    // ...existing lookup body; before each successful `return path`:
    //   this.specialUseCache.set(flag, path);
  }
```

In `deleteEmails`, before `createClient()`: `const trashFolder = permanent ? null : await this.getSpecialUseFolder("\\Trash");` and use `trashFolder!` in the move call. Run → PASS. Commit: `fix(email-mcp): resolve trash via special-use flag with fallbacks (was hardcoded "Trash")`.

- [ ] **Step 2: BCC-safe draft round-trip — failing tests**

In `SmtpService.test.ts` (the file already verifies Bcc is stripped by default at :170-186 — keep that test):

```typescript
it("composeRawMessage keeps the Bcc header when keepBcc is set", async () => {
  const raw = await service.composeRawMessage(
    { from: "alice@example.com", to: ["bob@example.com"], bcc: ["carol@example.com"], subject: "s", text: "b" },
    { keepBcc: true },
  );
  expect(raw.toString()).toMatch(/^bcc:.*carol@example\.com/im);
});
```

In `emailTools.test.ts` (follow the existing send_draft test's mock setup):

```typescript
it("send_draft delivers to Bcc recipients but strips the Bcc header from the transmitted message", async () => {
  const draftRaw = Buffer.from(
    "From: alice@example.com\r\nTo: bob@example.com\r\nBcc: carol@example.com\r\nSubject: s\r\nMessage-ID: <d1@example.com>\r\n\r\nbody",
  );
  // mock fetchRawSource -> draftRaw, sendRawMessage -> {messageId}, per existing pattern
  await handleEmailTool(/* ... send_draft, uid: 7 ... */);
  const [sentRaw, envelope] = mockSendRawMessage.mock.calls[0];
  expect(envelope.to).toContain("carol@example.com");          // envelope keeps bcc
  expect(sentRaw.toString()).not.toMatch(/^bcc:/im);            // header stripped from wire message
});
```

Run → the compose test FAILS (no second param); the send_draft test FAILS (Bcc header transmitted). Implement:

1. `SmtpService.composeRawMessage(options, opts: { keepBcc?: boolean } = {})` — pass `keepBcc: opts.keepBcc === true` into the MailComposer mail object (nodemailer's `keepBcc` message option). Verify against the actual current body of composeRawMessage and thread the option through however MailComposer is constructed there.
2. `emailTools.ts` send_email draft branch (:501-511): call `composeRawMessage({...}, { keepBcc: true })` **only when `saveToDrafts` is true** — build the message after the branch decision or compose twice; simplest: move the `composeRawMessage` call inside each branch (draft: keepBcc; send: default strip).
3. `emailTools.ts` send_draft (:630-635): strip the Bcc header before SMTP transmission but keep `rawSource` intact for the Sent-folder append (sender keeps a record of who was bcc'd):

```typescript
function stripBccHeader(raw: Buffer): Buffer {
  const str = raw.toString("latin1");
  const sep = str.indexOf("\r\n\r\n");
  if (sep === -1) return raw;
  const headers = str.slice(0, sep + 2).replace(/^bcc:[^\r\n]*(?:\r\n[ \t][^\r\n]*)*\r\n/gim, "");
  return Buffer.from(headers + str.slice(sep + 2), "latin1");
}
```

`const sendResult = await smtpService.sendRawMessage(stripBccHeader(rawSource), envelope);` (the envelope already includes `bccAddrs` — that part was correct). Run → PASS. Commit: `fix(email-mcp): preserve Bcc through the draft round-trip without leaking it on the wire`.

- [ ] **Step 3: Empty-uids guards — failing test**

```typescript
it.each(["move_email", "mark_email", "delete_email"])("%s rejects an empty uids array", async (tool) => {
  const result = await handleEmailTool(/* tool, { uids: [], ...minimal args } */);
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/uids must be a non-empty array/);
});
```

Run → FAIL (empty string passed as IMAP range → opaque error or mock passes). Implement at the top of the `move_email`, `mark_email`, and `delete_email` cases in `emailTools.ts`:

```typescript
        const uids = args.uids as number[];
        if (!Array.isArray(uids) || uids.length === 0) {
          return error("uids must be a non-empty array of message UIDs");
        }
```

Run → PASS.

- [ ] **Step 4: Full suite, commit, open PR**

Run: `cd packages/email-mcp && npx vitest run && cd ../.. && npm run lint && npm run typecheck`

```bash
git add packages/email-mcp
git commit -m "fix(email-mcp): empty-uids guards on move/mark/delete"
gh pr create --title "fix(email-mcp): IMAP correctness batch — trash resolution, BCC drafts, uids guards" --body "Trash was hardcoded (breaks Exchange/dot-namespace servers); BCC recipients silently vanished in the save-draft -> send_draft round-trip; empty uids arrays produced opaque IMAP errors."
```

---

### Task 10.1: Block private/reserved targets in URL resolution + kill switch (PR 10)

**Files:**
- Modify: `packages/email-mcp/src/htmlToMarkdown.ts` (URL guard around the resolve pipeline, ~:196-216)
- Test: `packages/email-mcp/src/__tests__/htmlToMarkdown.test.ts`

**Interfaces:**
- Produces: `export function isBlockedUrl(raw: string): boolean` (exported for testing); env var `URL_RESOLVE_DISABLE` (`"1"`/`"true"`) skips all network resolution while keeping markdown conversion.

**Why:** Rendering an email to markdown fires real GETs at every link — an email embedding a link to a private-range host (e.g. `http://192.168.x.x/...` or a `172.16.0.0/12` address) gets fetched from inside the home network (SSRF), and every tracker link registers a "click". Full defense (DNS-rebinding, redirect-hop inspection) is out of scope; blocking the initial URL's literal-IP/reserved-name targets plus an opt-out closes the worst of it. Document the residual risk in a code comment.

- [ ] **Step 1: Failing tests**

```typescript
import { isBlockedUrl } from "../htmlToMarkdown.js";

describe("isBlockedUrl", () => {
  it.each([
    "http://192.168.1.10/admin",
    "http://10.0.0.5/",
    "http://172.16.0.5/admin",
    "http://127.0.0.1:8080/",
    "http://169.254.169.254/latest/meta-data",
    "http://localhost/x",
    "http://nas.local/x",
    "http://intranet/x",
    "ftp://example.com/x",
    "http://[::1]/x",
  ])("blocks %s", (url) => {
    expect(isBlockedUrl(url)).toBe(true);
  });

  it.each(["https://example.com/a", "http://news.example.org/b?c=1"])("allows %s", (url) => {
    expect(isBlockedUrl(url)).toBe(false);
  });
});
```

Run → FAIL (not exported).

- [ ] **Step 2: Implement**

```typescript
const BLOCKED_HOST_SUFFIXES = [".local", ".internal", ".lan", ".home", ".arpa"];

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/**
 * Guard against SSRF via email-embedded links. Checks the *initial* URL only —
 * redirect hops and DNS rebinding are not inspected (accepted residual risk;
 * set URL_RESOLVE_DISABLE=1 to turn off resolution entirely).
 */
export function isBlockedUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return true;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || !host.includes(".")) return true;
  if (BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) return true;
  if (isPrivateIpv4(host)) return true;
  if (host.includes(":")) {
    // IPv6 literal: block loopback, link-local, unique-local
    if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  }
  return false;
}
```

Wire it in at the point URLs are collected for resolution (before they enter the resolve pool, ~:196-216): filter `isBlockedUrl` out of the candidate set so blocked links stay as-is in the markdown. Add the kill switch where resolution begins: `if (process.env.URL_RESOLVE_DISABLE === "1" || process.env.URL_RESOLVE_DISABLE === "true") { /* skip resolution, still convert */ }` — locate the entry to the resolve phase in `convertToMarkdown`/`resolveUrls` and short-circuit there.

- [ ] **Step 3: Run, commit**

Run: `cd packages/email-mcp && npx vitest run src/__tests__/htmlToMarkdown.test.ts`

```bash
git add packages/email-mcp/src/htmlToMarkdown.ts packages/email-mcp/src/__tests__/htmlToMarkdown.test.ts
git commit -m "fix(email-mcp): block private/reserved URL targets in link resolution; add URL_RESOLVE_DISABLE"
```

### Task 10.2: Restrict attachment file paths (PR 10)

**Files:**
- Modify: `packages/email-mcp/src/tools/emailTools.ts` (send_email attachments handling, ~:456 + schema description at ~:158-175)
- Test: `packages/email-mcp/src/__tests__/emailTools.test.ts`

**Why:** `attachments[].path` reaches nodemailer unchecked — a prompt-injected agent (email content is untrusted input) can attach `~/.ssh/id_rsa` to an outgoing mail. Path attachments become opt-in via `EMAIL_ATTACHMENT_DIR`.

- [ ] **Step 1: Failing tests**

```typescript
describe("attachment path restriction", () => {
  it("rejects path attachments when EMAIL_ATTACHMENT_DIR is unset", async () => {
    vi.stubEnv("EMAIL_ATTACHMENT_DIR", "");
    const result = await handleEmailTool(/* send_email with attachments: [{ filename: "a.txt", path: "/etc/passwd" }] and minimal to/subject/text */);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/EMAIL_ATTACHMENT_DIR/);
    vi.unstubAllEnvs();
  });

  it("rejects paths that escape EMAIL_ATTACHMENT_DIR", async () => {
    vi.stubEnv("EMAIL_ATTACHMENT_DIR", "/tmp/attachments");
    const result = await handleEmailTool(/* ... path: "/tmp/attachments/../../etc/passwd" ... */);
    expect(result.isError).toBe(true);
    vi.unstubAllEnvs();
  });
});
```

Run → FAIL (message sends).

- [ ] **Step 2: Implement**

In `emailTools.ts`:

```typescript
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

function assertAttachmentPathAllowed(p: string): void {
  const allowedRoot = process.env.EMAIL_ATTACHMENT_DIR;
  if (!allowedRoot) {
    throw new Error(
      "attachments[].path is disabled — set EMAIL_ATTACHMENT_DIR to a directory to allow file attachments, or pass content instead",
    );
  }
  const root = realpathSync(resolve(allowedRoot));
  const target = realpathSync(resolve(p));
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`attachment path is outside EMAIL_ATTACHMENT_DIR: ${p}`);
  }
}
```

In the send_email case, after reading `attachments` (:456): `for (const att of attachments ?? []) { if (att.path) assertAttachmentPathAllowed(att.path); }`. (`realpathSync` throwing ENOENT for a missing file is fine — the catch-all handler surfaces it.) Update the `path` property description in the tool schema to mention EMAIL_ATTACHMENT_DIR. Run → PASS. Commit: `fix(email-mcp): attachment paths restricted to EMAIL_ATTACHMENT_DIR (arbitrary-file-read guard)`.

### Task 10.3: MCP tool annotations on all three servers (PR 10)

**Files:**
- Modify: `packages/email-mcp/src/tools/emailTools.ts`, `packages/cal-mcp/src/tools/calendarTools.ts`, `packages/card-mcp/src/tools/contactTools.ts` (tool definition arrays)
- Test: one schema test per package (existing tool-definition test files)

- [ ] **Step 1: Failing tests (one per package, in the existing definition-test style)**

```typescript
it("read-only tools carry readOnlyHint; destructive tools carry destructiveHint", () => {
  const byName = Object.fromEntries(EMAIL_TOOLS.map((t) => [t.name, t as any]));
  for (const name of ["search_emails", "get_email", "list_folders", "download_attachment", "get_email_raw", "get_folder_status"]) {
    expect(byName[name].annotations?.readOnlyHint, name).toBe(true);
  }
  expect(byName.delete_email.annotations?.destructiveHint).toBe(true);
  expect(byName.send_email.annotations?.readOnlyHint).toBeFalsy();
});
```

Analogous for `CALENDAR_TOOLS` (read-only: `list_calendars`, `list_events`, `get_today_events`, `search_events`, `get_event`, `find_free_slots`; destructive: `delete_event`) and `CONTACT_TOOLS` (read-only: `list_contacts`, `get_contact`, `resolve_contact`; destructive: `delete_contact`). Run → FAIL.

- [ ] **Step 2: Implement**

Add to each tool definition object: `annotations: { readOnlyHint: true }` on the read-only tools; `annotations: { destructiveHint: true }` on `delete_email`, `delete_event`, `delete_contact`. The MCP SDK's `Tool` type accepts `annotations` (verify the installed `@modelcontextprotocol/sdk` version exposes it; if the local type is older, type the array element accordingly rather than casting the whole array). Run → PASS.

- [ ] **Step 3: Full suite, commit, open PR**

Run: `npm test && npm run lint && npm run typecheck`

```bash
git add packages/email-mcp packages/cal-mcp packages/card-mcp
git commit -m "feat: MCP tool annotations (readOnlyHint/destructiveHint) across all servers"
gh pr create --title "fix(email-mcp): security batch — SSRF guard, attachment path restriction, tool annotations" --body "Markdown rendering fetched every link in an email (SSRF into private ranges, tracker-click side effects) — now blocks private/reserved targets with URL_RESOLVE_DISABLE opt-out. attachments[].path was an arbitrary-file-read channel — now gated by EMAIL_ATTACHMENT_DIR. All tools now carry MCP annotations so clients can gate destructive calls."
```

---

### Task 11.1: Version bumps, changelogs, tags (PR 11)

**Files:**
- Modify: all four `packages/*/package.json`
- Create: `packages/core/CHANGELOG.md`, `packages/card-mcp/CHANGELOG.md`, `packages/cal-mcp/CHANGELOG.md`, `packages/email-mcp/CHANGELOG.md`

- [ ] **Step 1: Bump versions and dependency ranges**

| Package | New version | Why |
|---|---|---|
| pim-core | 0.7.0 | escaping, Contact fields, updateMasterEventIcs, splitIcsByUid, removeExceptionFromIcs, tz helpers |
| card-mcp | 0.4.0 | round-trip preservation, HTTP error surfacing (behavioral) |
| cal-mcp | 0.11.0 | update path rewrite, tz fixes, import split |
| email-mcp | 0.10.0 | partId fix, trash/BCC/flags, security guards |

Update `@miguelarios/pim-core` dependency to `^0.7.0` in all three server packages.

- [ ] **Step 2: Write CHANGELOG.md per package**

Format: `# Changelog`, then `## <version> (2026-07-XX)` with the bullet list from the table above expanded per package (one bullet per merged PR, linking the PR number). Add a final line: `Earlier releases: see git tags and docs/superpowers/specs/.` Mark breaking changes explicitly: card-mcp 0.4.0 (update semantics now preserve fields that were previously silently dropped — strictly a fix, but payload shapes gain `middleName`/`orgUnits`/etc.), email-mcp 0.10.0 (`attachments[].path` now requires `EMAIL_ATTACHMENT_DIR`; partId values changed meaning).

- [ ] **Step 3: Verify, commit, PR, tag**

Run: `npm test && npm run lint && npm run typecheck && npm run build`

```bash
git add -A
git commit -m "chore(release): pim-core 0.7.0, card-mcp 0.4.0, cal-mcp 0.11.0, email-mcp 0.10.0"
gh pr create --title "chore: release wave for hardening fixes" --body "Version bumps + changelogs for PRs 2-10."
```

After merge to main, tag in publish order (core first — CI publishes on tag push):

```bash
git checkout main && git pull
git tag pim-core/v0.7.0 && git push origin pim-core/v0.7.0
# wait for the pim-core publish workflow to succeed (gh run watch), then:
git tag card-mcp/v0.4.0 cal-mcp/v0.11.0 email-mcp/v0.10.0
git push origin card-mcp/v0.4.0 cal-mcp/v0.11.0 email-mcp/v0.10.0
```

### Task 11.2: Live smoke-test guide + write-matrix verification (PR 11, doc + manual verification)

**Files:**
- Create: `docs/testing/live-smoke.md`

- [ ] **Step 1: Write the guide.** Contents (committed, PII-free):

1. **Prerequisites:** mcporter servers `email`, `calendars`, `contacts` configured (env-interpolated creds from `~/.zshenv` — never committed); dedicated write targets that already exist: calendars `mailbox/PIM-Test` + `nextcloud/PIM-Test`, Nextcloud `PIM-Test` address book, mailbox `PIM-Test` IMAP folder. Rule: **reads may touch real data; writes go only to PIM-Test targets; test entities use canonical synthetic data (Alice Smith / alice@example.com / +1-555-0100); send_email tests target the account's own address only.**
2. **Output hygiene:** session outputs stay out of the repo; a server quirk worth keeping becomes a scrubbed fixture + oracle in `packages/core/src/__tests__/ics/fixtures/` per existing convention.
3. **Calendar write matrix** (run per provider, `mailbox/PIM-Test` and `nextcloud/PIM-Test`): create timed event → get → update title (span default) → verify RRULE-less update OK; create recurring weekly event with `recurrence_rule: "FREQ=WEEKLY;BYDAY=MO"` → update title with `span: "all"` → **get and verify `recurrence_rule` survived** (the PR 5 fix); update one occurrence with `span: "this"` + `occurrence_date` → list and verify the exception; delete one occurrence with `span: "this"` → list and verify EXDATE; `import_ics` with a 2-UID file → verify 2 objects; all-day event round-trip; `find_free_slots` with `preferred_start: "09:00"` and verify boundaries land on 9 AM local (PR 6 fix); delete everything created.
4. **Contacts write matrix** (Nextcloud PIM-Test book — pass the book URL explicitly since card-mcp defaults to the first book): create Alice Smith with phone/email/address/note-with-newline → get (verify note round-trip, PR 2) → update title only → get full and verify nothing else changed (PR 3) → resolve_contact ambiguity with two synthetic contacts → delete both. Copy one real iOS contact into PIM-Test manually, update it via the tool, verify in the Nextcloud UI that the photo survived (PR 3) — then delete the copy.
5. **Email matrix** (PIM-Test folder + self-addressed sends): `get_folder_status`, `search_emails` with subject tokens, send self-addressed with attachment via content, `get_email` → verify flags populated (PR 8) and partId → `download_attachment` returns the actual attachment bytes (PR 8); draft with bcc to own alias → `send_draft` → verify bcc delivery and no Bcc header in received copy (PR 9); `delete_email` non-permanent → verify it lands in the server's trash (PR 9); verify markdown conversion of a real newsletter completes with private-IP links left unresolved (PR 10).
6. **mcporter invocation crib:** `mcporter call 'calendars.create_event(calendar: "mailbox/PIM-Test", title: "Smoke recurring", start: "...", end: "...", recurrence_rule: "FREQ=WEEKLY;BYDAY=MO")' --output json` — function-call syntax, `--output json`.

- [ ] **Step 2: Run the matrix against the published versions** (after 11.1's tags publish; bump the pinned versions in `~/.mcporter/mcporter.json` to `@0.11.0`/`@0.10.0`/`@0.4.0` and `mcporter daemon restart`). Record pass/fail per line item in the session (not the repo). Any failure → file it and fix before closing the plan.

- [ ] **Step 3: Commit the doc**

```bash
git add docs/testing/live-smoke.md
git commit -m "docs: live smoke-test guide (PIM-Test targets, PII rules, per-fix verification matrix)"
```

---

## Explicitly Out of Scope (follow-up plans, tracked in Todoist)

- Docker integration-test harness (Greenmail + Baïkal/Radicale) and CI wiring — separate plan; biggest remaining structural gap.
- Robustness pass: timeouts/AbortSignal, retry-on-retryable, structured `{code, message, isRetryable}` error payloads, valibot tool-arg validation, `limit` params, `list_address_books` tool.
- Feature backlog: email `get_thread`/forward/reply-all/folder ops; calendar `span:"future"`, free-busy REPORT, calendar filtering; card-mcp multi-account + server-side search; multi-provider architecture.
- EXDATE TZID-form emission (P2 — currently always UTC-form; most servers accept it) and vCard line folding on output (P3).
- Remaining P2/P3 review findings, deliberately deferred (fold into the robustness plan): exception-override with `start` but no `end` can yield DTEND < DTSTART (`components.ts:79`); all-calendar fetch fails entirely if one calendar errors (`Promise.all` at `calendarTools.ts:32`); cancelled events still block `find_free_slots`; urlCache sync whole-file rewrite per occurrence; duplicate/empty calendar display-name collisions; `create_event` UID recovery via regex (`generateEventIcs` should return the uid); `toPimError` substring misclassification ("auth" matches "author"); email `since`/`before` UTC-midnight off-by-one for non-UTC users; `hasAttachment: false` silently ignored in search; `get_email` `format` unvalidated (text-only request on HTML-only mail returns no body); `fromName` quote injection; markdown URL regex breaks on parentheses; `get_email_raw` UTF-8 mojibake on non-UTF-8 mail; `appendMessage` returns `uid: 0` without UIDPLUS with no hint.
