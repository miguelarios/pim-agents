# Phase 2: Email (IMAP/SMTP) MVP Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build `@miguelarios/email-mcp` — a 10-tool MCP server for IMAP read/search/manage + SMTP send against Mailbox.org.

**Architecture:** Two service classes (ImapService wrapping imapflow, SmtpService wrapping nodemailer) with simple connect-per-request lifecycle, a search query parser, and MCP tool definitions following the exact card-mcp patterns. New error codes and config loader added to pim-core.

**Tech Stack:** TypeScript, imapflow, nodemailer, mailparser, @modelcontextprotocol/sdk, valibot, vitest

**Reference implementations:**
- `packages/card-mcp/` — MCP server pattern, service layer, tool definitions, testing
- `packages/core/` — error hierarchy, config loader, exports
- Design doc: `docs/plans/2026-03-04-phase2-email-mvp-design.md`

---

## Task 1: Extend pim-core with Email Error Codes and Config

**Files:**
- Modify: `packages/core/src/errors.ts`
- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/src/__tests__/emailConfig.test.ts`

**Step 1: Write failing tests for email config loader**

Create `packages/core/src/__tests__/emailConfig.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEmailConfig } from "../config.js";

describe("loadEmailConfig", () => {
  beforeEach(() => {
    vi.stubEnv("IMAP_HOST", "imap.mailbox.org");
    vi.stubEnv("IMAP_PORT", "993");
    vi.stubEnv("IMAP_USER", "miguel@mailbox.org");
    vi.stubEnv("IMAP_PASS", "imap-secret");
    vi.stubEnv("SMTP_HOST", "smtp.mailbox.org");
    vi.stubEnv("SMTP_PORT", "465");
    vi.stubEnv("SMTP_USER", "miguel@mailbox.org");
    vi.stubEnv("SMTP_PASS", "smtp-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads valid email config from env vars", () => {
    const config = loadEmailConfig();
    expect(config.imap.host).toBe("imap.mailbox.org");
    expect(config.imap.port).toBe(993);
    expect(config.imap.user).toBe("miguel@mailbox.org");
    expect(config.imap.pass).toBe("imap-secret");
    expect(config.imap.secure).toBe(true);
    expect(config.smtp.host).toBe("smtp.mailbox.org");
    expect(config.smtp.port).toBe(465);
    expect(config.smtp.user).toBe("miguel@mailbox.org");
    expect(config.smtp.pass).toBe("smtp-secret");
    expect(config.smtp.secure).toBe(true);
  });

  it("uses default ports and secure when not specified", () => {
    vi.stubEnv("IMAP_PORT", "");
    vi.stubEnv("SMTP_PORT", "");
    const config = loadEmailConfig();
    expect(config.imap.port).toBe(993);
    expect(config.smtp.port).toBe(465);
  });

  it("reads optional SMTP_FROM_NAME", () => {
    vi.stubEnv("SMTP_FROM_NAME", "Miguel Rios");
    const config = loadEmailConfig();
    expect(config.fromName).toBe("Miguel Rios");
  });

  it("throws ConfigurationError when IMAP_HOST missing", () => {
    vi.stubEnv("IMAP_HOST", "");
    expect(() => loadEmailConfig()).toThrow("Config validation failed");
  });

  it("throws ConfigurationError when SMTP_PASS missing", () => {
    vi.stubEnv("SMTP_PASS", "");
    expect(() => loadEmailConfig()).toThrow("Config validation failed");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/mrios/Nextcloud/01-Projects/pim-agents && npx vitest run packages/core/src/__tests__/emailConfig.test.ts`
Expected: FAIL — `loadEmailConfig` does not exist

**Step 3: Add email error codes to errors.ts**

Add to the `ErrorCode` enum in `packages/core/src/errors.ts`:

```typescript
  EMAIL_NOT_FOUND = "EMAIL_NOT_FOUND",
  FOLDER_NOT_FOUND = "FOLDER_NOT_FOUND",
  SEND_FAILED = "SEND_FAILED",
  ATTACHMENT_NOT_FOUND = "ATTACHMENT_NOT_FOUND",
```

Add the `EmailError` class after `ContactError`:

```typescript
export class EmailError extends PimError {
  public readonly emailUid?: number;
  constructor(message: string, code: ErrorCode, emailUid?: number) {
    super(message, code, false);
    this.emailUid = emailUid;
  }
}
```

**Step 4: Add EmailConfig and loadEmailConfig to config.ts**

Add to `packages/core/src/config.ts`:

```typescript
export interface EmailConfig {
  imap: {
    host: string;
    port: number;
    user: string;
    pass: string;
    secure: boolean;
  };
  smtp: {
    host: string;
    port: number;
    user: string;
    pass: string;
    secure: boolean;
  };
  fromName?: string;
}

const EmailEnvSchema = v.object({
  IMAP_HOST: v.pipe(
    v.string("IMAP_HOST is required"),
    v.minLength(1, "IMAP_HOST cannot be empty"),
  ),
  IMAP_USER: v.pipe(
    v.string("IMAP_USER is required"),
    v.minLength(1, "IMAP_USER cannot be empty"),
  ),
  IMAP_PASS: v.pipe(
    v.string("IMAP_PASS is required"),
    v.minLength(1, "IMAP_PASS cannot be empty"),
  ),
  SMTP_HOST: v.pipe(
    v.string("SMTP_HOST is required"),
    v.minLength(1, "SMTP_HOST cannot be empty"),
  ),
  SMTP_USER: v.pipe(
    v.string("SMTP_USER is required"),
    v.minLength(1, "SMTP_USER cannot be empty"),
  ),
  SMTP_PASS: v.pipe(
    v.string("SMTP_PASS is required"),
    v.minLength(1, "SMTP_PASS cannot be empty"),
  ),
});

export function loadEmailConfig(): EmailConfig {
  const env = {
    IMAP_HOST: process.env.IMAP_HOST,
    IMAP_USER: process.env.IMAP_USER,
    IMAP_PASS: process.env.IMAP_PASS,
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
  };

  try {
    const validated = v.parse(EmailEnvSchema, env);
    const imapPort = Number.parseInt(process.env.IMAP_PORT || "993", 10);
    const smtpPort = Number.parseInt(process.env.SMTP_PORT || "465", 10);

    return {
      imap: {
        host: validated.IMAP_HOST,
        port: Number.isNaN(imapPort) ? 993 : imapPort,
        user: validated.IMAP_USER,
        pass: validated.IMAP_PASS,
        secure: process.env.IMAP_SECURE !== "false",
      },
      smtp: {
        host: validated.SMTP_HOST,
        port: Number.isNaN(smtpPort) ? 465 : smtpPort,
        user: validated.SMTP_USER,
        pass: validated.SMTP_PASS,
        secure: process.env.SMTP_SECURE !== "false",
      },
      fromName: process.env.SMTP_FROM_NAME || undefined,
    };
  } catch (error) {
    if (v.isValiError(error)) {
      const messages = error.issues.map((issue) => {
        const path = issue.path?.map((p) => p.key).join(".") ?? "unknown";
        return `${path}: ${issue.message}`;
      });
      throw new ConfigurationError(`Config validation failed: ${messages.join("; ")}`);
    }
    throw error;
  }
}
```

**Step 5: Update index.ts exports**

Add to `packages/core/src/index.ts`:

```typescript
export {
  type EmailConfig,
  loadEmailConfig,
} from "./config.js";

export {
  EmailError,
} from "./errors.js";
```

(Also add `EmailError` to the existing errors export block.)

**Step 6: Run tests to verify they pass**

Run: `cd /Users/mrios/Nextcloud/01-Projects/pim-agents && npx vitest run packages/core/`
Expected: All core tests pass (existing + new emailConfig tests)

**Step 7: Commit**

```bash
git add packages/core/src/errors.ts packages/core/src/config.ts packages/core/src/index.ts packages/core/src/__tests__/emailConfig.test.ts
git commit -m "feat(core): add EmailConfig, loadEmailConfig, and email error codes"
```

---

## Task 2: Scaffold email-mcp Package

**Files:**
- Modify: `packages/email-mcp/package.json`
- Modify: `packages/email-mcp/tsconfig.json`
- Create: `packages/email-mcp/vitest.config.ts`
- Create: `packages/email-mcp/src/bin/cli.ts`
- Modify: `.env.example` (add email env vars)

**Step 1: Update email-mcp package.json**

Replace `packages/email-mcp/package.json` with:

```json
{
  "name": "@miguelarios/email-mcp",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "email-mcp": "dist/bin/cli.js"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "start": "node dist/bin/cli.js"
  },
  "dependencies": {
    "@miguelarios/pim-core": "*",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "imapflow": "^1.0.0",
    "mailparser": "^3.7.0",
    "nodemailer": "^6.9.0"
  },
  "devDependencies": {
    "@types/nodemailer": "^6.4.0",
    "@types/node": "^20.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

**Step 2: Update tsconfig.json to reference core**

Replace `packages/email-mcp/tsconfig.json` with:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"],
  "references": [
    { "path": "../core" }
  ]
}
```

**Step 3: Create vitest.config.ts**

Create `packages/email-mcp/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
  },
});
```

**Step 4: Create CLI entrypoint**

Create `packages/email-mcp/src/bin/cli.ts`:

```typescript
#!/usr/bin/env node
import { startServer } from "../main.js";

startServer().catch((error) => {
  console.error("[email-mcp] Fatal error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
```

**Step 5: Create placeholder main.ts**

Replace `packages/email-mcp/src/main.ts` with:

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export async function createServer(): Promise<Server> {
  const server = new Server(
    { name: "@miguelarios/email-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.onerror = (error) => {
    console.error("[email-mcp] Server error:", error.message);
  };

  return server;
}

export async function startServer(): Promise<void> {
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[email-mcp] Server started on stdio");
}
```

**Step 6: Update .env.example**

Append to root `.env.example`:

```
# email-mcp configuration
IMAP_HOST=imap.mailbox.org
IMAP_PORT=993
IMAP_USER=your-email@mailbox.org
IMAP_PASS=your-imap-app-password
SMTP_HOST=smtp.mailbox.org
SMTP_PORT=465
SMTP_USER=your-email@mailbox.org
SMTP_PASS=your-smtp-app-password
SMTP_FROM_NAME="Your Name"
```

**Step 7: Install dependencies**

Run: `cd /Users/mrios/Nextcloud/01-Projects/pim-agents && npm install`
Expected: All dependencies installed, no errors

**Step 8: Verify build and typecheck**

Run: `cd /Users/mrios/Nextcloud/01-Projects/pim-agents && npx turbo run build typecheck`
Expected: All packages build and typecheck successfully

**Step 9: Commit**

```bash
git add packages/email-mcp/ .env.example package-lock.json
git commit -m "chore(email-mcp): scaffold package with deps, cli, and placeholder server"
```

---

## Task 3: Search Query Parser

**Files:**
- Create: `packages/email-mcp/src/search.ts`
- Create: `packages/email-mcp/src/__tests__/search.test.ts`

**Step 1: Write failing tests for the search parser**

Create `packages/email-mcp/src/__tests__/search.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { parseSearchQuery } from "../search.js";

describe("parseSearchQuery", () => {
  it("parses from: prefix", () => {
    const result = parseSearchQuery("from:boss@work.com");
    expect(result).toEqual({ from: "boss@work.com" });
  });

  it("parses to: prefix", () => {
    const result = parseSearchQuery("to:someone@test.com");
    expect(result).toEqual({ to: "someone@test.com" });
  });

  it("parses subject: prefix", () => {
    const result = parseSearchQuery("subject:meeting notes");
    expect(result).toEqual({ subject: "meeting notes" });
  });

  it("parses is:unread flag", () => {
    const result = parseSearchQuery("is:unread");
    expect(result).toEqual({ seen: false });
  });

  it("parses is:read flag", () => {
    const result = parseSearchQuery("is:read");
    expect(result).toEqual({ seen: true });
  });

  it("parses is:flagged flag", () => {
    const result = parseSearchQuery("is:flagged");
    expect(result).toEqual({ flagged: true });
  });

  it("parses has:attachment", () => {
    const result = parseSearchQuery("has:attachment");
    expect(result).toEqual({ header: { "content-type": "multipart/mixed" } });
  });

  it("parses since: date filter", () => {
    const result = parseSearchQuery("since:2026-01-15");
    expect(result).toEqual({ since: new Date("2026-01-15") });
  });

  it("parses before: date filter", () => {
    const result = parseSearchQuery("before:2026-03-01");
    expect(result).toEqual({ before: new Date("2026-03-01") });
  });

  it("treats plain text as body/subject search", () => {
    const result = parseSearchQuery("important project");
    expect(result).toEqual({ body: "important project" });
  });

  it("combines multiple prefixes", () => {
    const result = parseSearchQuery("from:boss@work.com is:unread");
    expect(result).toEqual({ from: "boss@work.com", seen: false });
  });

  it("combines prefix with plain text", () => {
    const result = parseSearchQuery("from:boss@work.com urgent deadline");
    expect(result).toEqual({ from: "boss@work.com", body: "urgent deadline" });
  });

  it("returns empty object for empty query", () => {
    const result = parseSearchQuery("");
    expect(result).toEqual({});
  });

  it("returns empty object for whitespace-only query", () => {
    const result = parseSearchQuery("   ");
    expect(result).toEqual({});
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/mrios/Nextcloud/01-Projects/pim-agents && npx vitest run packages/email-mcp/src/__tests__/search.test.ts`
Expected: FAIL — `parseSearchQuery` does not exist

**Step 3: Implement search query parser**

Create `packages/email-mcp/src/search.ts`:

```typescript
/**
 * Parses structured search query strings into imapflow-compatible search criteria.
 *
 * Supported prefixes:
 * - from:address     → IMAP FROM filter
 * - to:address       → IMAP TO filter
 * - subject:text     → IMAP SUBJECT filter
 * - is:unread/read/flagged → flag filters
 * - has:attachment    → Content-Type header check
 * - since:YYYY-MM-DD → date range start
 * - before:YYYY-MM-DD → date range end
 * - plain text        → IMAP BODY search
 */
export function parseSearchQuery(query: string): Record<string, unknown> {
  const trimmed = query.trim();
  if (!trimmed) return {};

  const criteria: Record<string, unknown> = {};
  const plainParts: string[] = [];

  // Tokenize: split on spaces but keep "subject:multi word" together
  // Strategy: scan for known prefixes, consume their values
  const tokens = trimmed.split(/\s+/);
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];
    const colonIndex = token.indexOf(":");

    if (colonIndex > 0) {
      const prefix = token.substring(0, colonIndex).toLowerCase();
      const value = token.substring(colonIndex + 1);

      switch (prefix) {
        case "from":
          criteria.from = value;
          i++;
          break;
        case "to":
          criteria.to = value;
          i++;
          break;
        case "subject": {
          // Subject may contain spaces — consume remaining tokens until next prefix
          const subjectParts = [value];
          i++;
          while (i < tokens.length && !isPrefix(tokens[i])) {
            subjectParts.push(tokens[i]);
            i++;
          }
          criteria.subject = subjectParts.join(" ");
          break;
        }
        case "is":
          switch (value.toLowerCase()) {
            case "unread":
              criteria.seen = false;
              break;
            case "read":
              criteria.seen = true;
              break;
            case "flagged":
              criteria.flagged = true;
              break;
          }
          i++;
          break;
        case "has":
          if (value.toLowerCase() === "attachment") {
            criteria.header = { "content-type": "multipart/mixed" };
          }
          i++;
          break;
        case "since":
          criteria.since = new Date(value);
          i++;
          break;
        case "before":
          criteria.before = new Date(value);
          i++;
          break;
        default:
          // Unknown prefix, treat as plain text
          plainParts.push(token);
          i++;
          break;
      }
    } else {
      plainParts.push(token);
      i++;
    }
  }

  if (plainParts.length > 0) {
    criteria.body = plainParts.join(" ");
  }

  return criteria;
}

const KNOWN_PREFIXES = new Set(["from", "to", "subject", "is", "has", "since", "before"]);

function isPrefix(token: string): boolean {
  const colonIndex = token.indexOf(":");
  if (colonIndex <= 0) return false;
  return KNOWN_PREFIXES.has(token.substring(0, colonIndex).toLowerCase());
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /Users/mrios/Nextcloud/01-Projects/pim-agents && npx vitest run packages/email-mcp/src/__tests__/search.test.ts`
Expected: All 15 tests pass

**Step 5: Commit**

```bash
git add packages/email-mcp/src/search.ts packages/email-mcp/src/__tests__/search.test.ts
git commit -m "feat(email-mcp): add search query parser with prefix support"
```

---

## Task 4: ImapService — Core IMAP Operations

**Files:**
- Create: `packages/email-mcp/src/services/ImapService.ts`
- Create: `packages/email-mcp/src/__tests__/ImapService.test.ts`

**Step 1: Write failing tests for ImapService**

Create `packages/email-mcp/src/__tests__/ImapService.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImapService } from "../services/ImapService.js";

// Mock imapflow
const mockFetchOne = vi.fn();
const mockFetch = vi.fn();
const mockSearch = vi.fn();
const mockMessageMove = vi.fn();
const mockMessageDelete = vi.fn();
const mockMessageFlagsAdd = vi.fn();
const mockMessageFlagsRemove = vi.fn();
const mockList = vi.fn();
const mockMailboxCreate = vi.fn();
const mockDownload = vi.fn();
const mockGetMailboxLock = vi.fn();
const mockConnect = vi.fn();
const mockLogout = vi.fn();

vi.mock("imapflow", () => ({
  ImapFlow: vi.fn().mockImplementation(() => ({
    connect: mockConnect,
    logout: mockLogout,
    getMailboxLock: mockGetMailboxLock.mockResolvedValue({ release: vi.fn() }),
    fetchOne: mockFetchOne,
    fetch: mockFetch,
    search: mockSearch,
    messageMove: mockMessageMove,
    messageDelete: mockMessageDelete,
    messageFlagsAdd: mockMessageFlagsAdd,
    messageFlagsRemove: mockMessageFlagsRemove,
    list: mockList,
    mailboxCreate: mockMailboxCreate,
    download: mockDownload,
    mailbox: { exists: 100 },
  })),
}));

// Mock mailparser
vi.mock("mailparser", () => ({
  simpleParser: vi.fn().mockResolvedValue({
    messageId: "<msg-1@test.com>",
    subject: "Test Subject",
    from: { value: [{ address: "sender@test.com", name: "Sender" }] },
    to: { value: [{ address: "recipient@test.com", name: "Recipient" }] },
    cc: null,
    date: new Date("2026-03-04T12:00:00Z"),
    text: "Hello world",
    html: "<p>Hello world</p>",
    attachments: [
      {
        filename: "doc.pdf",
        contentType: "application/pdf",
        size: 1024,
        content: Buffer.from("pdf-content"),
      },
    ],
  }),
}));

const testConfig = {
  imap: { host: "imap.test.com", port: 993, user: "user@test.com", pass: "secret", secure: true },
  smtp: { host: "smtp.test.com", port: 465, user: "user@test.com", pass: "secret", secure: true },
};

describe("ImapService", () => {
  let service: ImapService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ImapService(testConfig);
  });

  describe("listFolders", () => {
    it("returns list of IMAP folders", async () => {
      mockList.mockResolvedValueOnce([
        { path: "INBOX", specialUse: "\\Inbox", delimiter: "/", listed: true, subscribed: true },
        { path: "Sent", specialUse: "\\Sent", delimiter: "/", listed: true, subscribed: true },
        { path: "Trash", specialUse: "\\Trash", delimiter: "/", listed: true, subscribed: true },
      ]);

      const folders = await service.listFolders();
      expect(folders).toHaveLength(3);
      expect(folders[0]).toEqual({
        path: "INBOX",
        specialUse: "\\Inbox",
        delimiter: "/",
      });
      expect(mockConnect).toHaveBeenCalled();
      expect(mockLogout).toHaveBeenCalled();
    });
  });

  describe("searchEmails", () => {
    it("searches emails and returns summaries", async () => {
      mockSearch.mockResolvedValueOnce([101, 102]);

      // Mock fetch to return an async iterable
      const messages = [
        {
          uid: 101,
          envelope: {
            messageId: "<msg-101@test.com>",
            subject: "First",
            from: [{ address: "a@test.com", name: "A" }],
            to: [{ address: "b@test.com", name: "B" }],
            date: new Date("2026-03-04"),
          },
          flags: new Set(["\\Seen"]),
          bodyStructure: { type: "text/plain" },
        },
        {
          uid: 102,
          envelope: {
            messageId: "<msg-102@test.com>",
            subject: "Second",
            from: [{ address: "c@test.com", name: "C" }],
            to: [{ address: "d@test.com", name: "D" }],
            date: new Date("2026-03-03"),
          },
          flags: new Set([]),
          bodyStructure: { childNodes: [{ type: "multipart/mixed" }] },
        },
      ];
      mockFetch.mockReturnValueOnce((async function* () {
        for (const msg of messages) yield msg;
      })());

      const results = await service.searchEmails("INBOX", {}, { limit: 10 });
      expect(results).toHaveLength(2);
      expect(results[0].uid).toBe(101);
      expect(results[0].subject).toBe("First");
      expect(results[0].flags).toContain("\\Seen");
    });
  });

  describe("fetchEmail", () => {
    it("fetches a full email by UID", async () => {
      mockFetchOne.mockResolvedValueOnce({
        source: Buffer.from("raw email source"),
      });

      const email = await service.fetchEmail("INBOX", 12345);
      expect(email.subject).toBe("Test Subject");
      expect(email.textBody).toBe("Hello world");
      expect(email.attachments).toHaveLength(1);
      expect(email.attachments[0].filename).toBe("doc.pdf");
    });
  });

  describe("moveEmails", () => {
    it("moves emails to destination folder", async () => {
      mockMessageMove.mockResolvedValueOnce({ destination: "Archive" });

      await service.moveEmails("INBOX", [101, 102], "Archive");
      expect(mockMessageMove).toHaveBeenCalledWith("101,102", "Archive", { uid: true });
    });
  });

  describe("markEmails", () => {
    it("adds flags to emails", async () => {
      await service.markEmails("INBOX", [101], ["\\Seen"], "add");
      expect(mockMessageFlagsAdd).toHaveBeenCalledWith("101", ["\\Seen"], { uid: true });
    });

    it("removes flags from emails", async () => {
      await service.markEmails("INBOX", [101], ["\\Seen"], "remove");
      expect(mockMessageFlagsRemove).toHaveBeenCalledWith("101", ["\\Seen"], { uid: true });
    });
  });

  describe("deleteEmails", () => {
    it("moves to Trash by default", async () => {
      mockMessageMove.mockResolvedValueOnce({ destination: "Trash" });

      await service.deleteEmails("INBOX", [101]);
      expect(mockMessageMove).toHaveBeenCalledWith("101", "Trash", { uid: true });
    });

    it("permanently deletes when permanent flag set", async () => {
      await service.deleteEmails("INBOX", [101], true);
      expect(mockMessageDelete).toHaveBeenCalledWith("101", { uid: true });
    });
  });

  describe("createFolder", () => {
    it("creates a new IMAP folder", async () => {
      await service.createFolder("Projects/Work");
      expect(mockMailboxCreate).toHaveBeenCalledWith("Projects/Work");
    });
  });

  describe("downloadAttachment", () => {
    it("downloads attachment by part ID", async () => {
      const content = Buffer.from("attachment-data");
      mockDownload.mockResolvedValueOnce({
        meta: { contentType: "application/pdf", filename: "doc.pdf", expectedSize: 1024 },
        content: { read: () => content, [Symbol.asyncIterator]: async function* () { yield content; } },
      });

      const result = await service.downloadAttachment("INBOX", 12345, "2");
      expect(result.filename).toBe("doc.pdf");
      expect(result.contentType).toBe("application/pdf");
      expect(mockDownload).toHaveBeenCalledWith("12345", "2", { uid: true });
    });
  });

  describe("fetchRawEmail", () => {
    it("returns raw email source as string", async () => {
      mockFetchOne.mockResolvedValueOnce({
        source: Buffer.from("From: test@test.com\r\nSubject: Test\r\n\r\nBody"),
      });

      const raw = await service.fetchRawEmail("INBOX", 12345);
      expect(raw).toContain("From: test@test.com");
      expect(raw).toContain("Subject: Test");
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/mrios/Nextcloud/01-Projects/pim-agents && npx vitest run packages/email-mcp/src/__tests__/ImapService.test.ts`
Expected: FAIL — `ImapService` does not exist

**Step 3: Implement ImapService**

Create `packages/email-mcp/src/services/ImapService.ts`:

```typescript
import { type EmailConfig, EmailError, ErrorCode, toPimError } from "@miguelarios/pim-core";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

export interface EmailSummary {
  uid: number;
  messageId: string;
  subject: string;
  from: { name?: string; address: string };
  to: Array<{ name?: string; address: string }>;
  date: string;
  flags: string[];
  hasAttachments: boolean;
}

export interface EmailFull extends EmailSummary {
  cc?: Array<{ name?: string; address: string }>;
  textBody?: string;
  htmlBody?: string;
  attachments: Array<{
    filename: string;
    contentType: string;
    size: number;
    partId: string;
  }>;
}

export interface FolderInfo {
  path: string;
  specialUse?: string;
  delimiter: string;
}

export interface AttachmentData {
  filename: string;
  contentType: string;
  size: number;
  content: Buffer;
}

export interface SearchOptions {
  limit?: number;
  offset?: number;
}

export class ImapService {
  private config: EmailConfig;

  constructor(config: EmailConfig) {
    this.config = config;
  }

  private createClient(): ImapFlow {
    return new ImapFlow({
      host: this.config.imap.host,
      port: this.config.imap.port,
      secure: this.config.imap.secure,
      auth: {
        user: this.config.imap.user,
        pass: this.config.imap.pass,
      },
      logger: false,
    });
  }

  async listFolders(): Promise<FolderInfo[]> {
    const client = this.createClient();
    try {
      await client.connect();
      const mailboxes = await client.list();
      return mailboxes.map((mb) => ({
        path: mb.path,
        specialUse: mb.specialUse || undefined,
        delimiter: mb.delimiter,
      }));
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async searchEmails(
    folder: string,
    query: Record<string, unknown>,
    options: SearchOptions = {},
  ): Promise<EmailSummary[]> {
    const client = this.createClient();
    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);
      try {
        const searchCriteria = Object.keys(query).length > 0 ? query : { all: true };
        const uids = await client.search(searchCriteria as any, { uid: true });

        if (uids.length === 0) return [];

        const offset = options.offset ?? 0;
        const limit = options.limit ?? 50;
        const sliced = uids.slice(offset, offset + limit);

        const summaries: EmailSummary[] = [];
        const uidRange = sliced.join(",");

        for await (const msg of client.fetch(uidRange, {
          envelope: true,
          flags: true,
          bodyStructure: true,
          uid: true,
        })) {
          summaries.push({
            uid: msg.uid,
            messageId: msg.envelope.messageId || "",
            subject: msg.envelope.subject || "",
            from: msg.envelope.from?.[0]
              ? { name: msg.envelope.from[0].name, address: msg.envelope.from[0].address || "" }
              : { address: "unknown" },
            to: (msg.envelope.to || []).map((a: any) => ({
              name: a.name,
              address: a.address || "",
            })),
            date: msg.envelope.date?.toISOString() || "",
            flags: [...(msg.flags || [])],
            hasAttachments: hasAttachmentParts(msg.bodyStructure),
          });
        }
        return summaries;
      } finally {
        lock.release();
      }
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async fetchEmail(folder: string, uid: number): Promise<EmailFull> {
    const client = this.createClient();
    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);
      try {
        const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!message?.source) {
          throw new EmailError(`Email UID ${uid} not found`, ErrorCode.EMAIL_NOT_FOUND, uid);
        }

        const parsed = await simpleParser(message.source);
        return {
          uid,
          messageId: parsed.messageId || "",
          subject: parsed.subject || "",
          from: parsed.from?.value?.[0]
            ? { name: parsed.from.value[0].name, address: parsed.from.value[0].address || "" }
            : { address: "unknown" },
          to: (parsed.to?.value || []).map((a) => ({
            name: a.name,
            address: a.address || "",
          })),
          cc: parsed.cc?.value?.map((a) => ({ name: a.name, address: a.address || "" })),
          date: parsed.date?.toISOString() || "",
          flags: [],
          hasAttachments: (parsed.attachments?.length || 0) > 0,
          textBody: parsed.text || undefined,
          htmlBody: parsed.html || undefined,
          attachments: (parsed.attachments || []).map((att, index) => ({
            filename: att.filename || `attachment-${index}`,
            contentType: att.contentType || "application/octet-stream",
            size: att.size || 0,
            partId: String(index + 1),
          })),
        };
      } finally {
        lock.release();
      }
    } catch (error) {
      if (error instanceof EmailError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async fetchRawEmail(folder: string, uid: number): Promise<string> {
    const client = this.createClient();
    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);
      try {
        const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!message?.source) {
          throw new EmailError(`Email UID ${uid} not found`, ErrorCode.EMAIL_NOT_FOUND, uid);
        }
        return message.source.toString();
      } finally {
        lock.release();
      }
    } catch (error) {
      if (error instanceof EmailError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async moveEmails(folder: string, uids: number[], destination: string): Promise<void> {
    const client = this.createClient();
    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);
      try {
        await client.messageMove(uids.join(","), destination, { uid: true });
      } finally {
        lock.release();
      }
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async markEmails(
    folder: string,
    uids: number[],
    flags: string[],
    action: "add" | "remove",
  ): Promise<void> {
    const client = this.createClient();
    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);
      try {
        const uidRange = uids.join(",");
        if (action === "add") {
          await client.messageFlagsAdd(uidRange, flags, { uid: true });
        } else {
          await client.messageFlagsRemove(uidRange, flags, { uid: true });
        }
      } finally {
        lock.release();
      }
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async deleteEmails(folder: string, uids: number[], permanent = false): Promise<void> {
    const client = this.createClient();
    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);
      try {
        const uidRange = uids.join(",");
        if (permanent) {
          await client.messageDelete(uidRange, { uid: true });
        } else {
          await client.messageMove(uidRange, "Trash", { uid: true });
        }
      } finally {
        lock.release();
      }
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async createFolder(path: string): Promise<void> {
    const client = this.createClient();
    try {
      await client.connect();
      await client.mailboxCreate(path);
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async downloadAttachment(
    folder: string,
    uid: number,
    partId: string,
  ): Promise<AttachmentData> {
    const client = this.createClient();
    try {
      await client.connect();
      const lock = await client.getMailboxLock(folder);
      try {
        const { meta, content } = await client.download(String(uid), partId, { uid: true });
        if (!content) {
          throw new EmailError(
            `Attachment ${partId} not found for email ${uid}`,
            ErrorCode.ATTACHMENT_NOT_FOUND,
            uid,
          );
        }

        const chunks: Buffer[] = [];
        for await (const chunk of content) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }

        return {
          filename: meta.filename || `attachment-${partId}`,
          contentType: meta.contentType || "application/octet-stream",
          size: meta.expectedSize || Buffer.concat(chunks).length,
          content: Buffer.concat(chunks),
        };
      } finally {
        lock.release();
      }
    } catch (error) {
      if (error instanceof EmailError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      await client.logout().catch(() => {});
    }
  }
}

function hasAttachmentParts(bodyStructure: any): boolean {
  if (!bodyStructure) return false;
  if (bodyStructure.type?.toLowerCase().includes("multipart/mixed")) return true;
  if (bodyStructure.childNodes) {
    return bodyStructure.childNodes.some((node: any) => hasAttachmentParts(node));
  }
  return false;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /Users/mrios/Nextcloud/01-Projects/pim-agents && npx vitest run packages/email-mcp/src/__tests__/ImapService.test.ts`
Expected: All ImapService tests pass

**Step 5: Commit**

```bash
git add packages/email-mcp/src/services/ImapService.ts packages/email-mcp/src/__tests__/ImapService.test.ts
git commit -m "feat(email-mcp): add ImapService with search, fetch, move, delete, flags, folders"
```

---

## Task 5: SmtpService — Email Sending

**Files:**
- Create: `packages/email-mcp/src/services/SmtpService.ts`
- Create: `packages/email-mcp/src/__tests__/SmtpService.test.ts`

**Step 1: Write failing tests for SmtpService**

Create `packages/email-mcp/src/__tests__/SmtpService.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SmtpService } from "../services/SmtpService.js";

const mockSendMail = vi.fn();
const mockVerify = vi.fn();

vi.mock("nodemailer", () => ({
  createTransport: vi.fn().mockReturnValue({
    sendMail: mockSendMail,
    verify: mockVerify,
  }),
}));

const testConfig = {
  imap: { host: "imap.test.com", port: 993, user: "user@test.com", pass: "secret", secure: true },
  smtp: { host: "smtp.test.com", port: 465, user: "user@test.com", pass: "secret", secure: true },
  fromName: "Test User",
};

describe("SmtpService", () => {
  let service: SmtpService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMail.mockResolvedValue({
      messageId: "<sent-1@test.com>",
      accepted: ["recipient@test.com"],
      rejected: [],
    });
    mockVerify.mockResolvedValue(true);
    service = new SmtpService(testConfig);
  });

  describe("sendEmail", () => {
    it("sends a basic email", async () => {
      const result = await service.sendEmail({
        to: ["recipient@test.com"],
        subject: "Test Subject",
        text: "Hello world",
      });

      expect(result.messageId).toBe("<sent-1@test.com>");
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: '"Test User" <user@test.com>',
          to: "recipient@test.com",
          subject: "Test Subject",
          text: "Hello world",
        }),
      );
    });

    it("sends with cc and bcc", async () => {
      await service.sendEmail({
        to: ["a@test.com"],
        cc: ["b@test.com"],
        bcc: ["c@test.com"],
        subject: "Test",
        text: "Hello",
      });

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          cc: "b@test.com",
          bcc: "c@test.com",
        }),
      );
    });

    it("sends with HTML body", async () => {
      await service.sendEmail({
        to: ["a@test.com"],
        subject: "Test",
        html: "<h1>Hello</h1>",
      });

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: "<h1>Hello</h1>",
        }),
      );
    });

    it("sends with attachments", async () => {
      await service.sendEmail({
        to: ["a@test.com"],
        subject: "Test",
        text: "See attached",
        attachments: [{ filename: "doc.pdf", path: "/tmp/doc.pdf" }],
      });

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: [{ filename: "doc.pdf", path: "/tmp/doc.pdf" }],
        }),
      );
    });

    it("uses email address only when no fromName configured", async () => {
      const noNameService = new SmtpService({
        ...testConfig,
        fromName: undefined,
      });

      await noNameService.sendEmail({
        to: ["a@test.com"],
        subject: "Test",
        text: "Hello",
      });

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "user@test.com",
        }),
      );
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/mrios/Nextcloud/01-Projects/pim-agents && npx vitest run packages/email-mcp/src/__tests__/SmtpService.test.ts`
Expected: FAIL — `SmtpService` does not exist

**Step 3: Implement SmtpService**

Create `packages/email-mcp/src/services/SmtpService.ts`:

```typescript
import { type EmailConfig, EmailError, ErrorCode, toPimError } from "@miguelarios/pim-core";
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";

export interface SendEmailOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{
    filename: string;
    path?: string;
    content?: string | Buffer;
    contentType?: string;
  }>;
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
}

export class SmtpService {
  private config: EmailConfig;

  constructor(config: EmailConfig) {
    this.config = config;
  }

  private createTransporter(): Transporter {
    return nodemailer.createTransport({
      host: this.config.smtp.host,
      port: this.config.smtp.port,
      secure: this.config.smtp.secure,
      auth: {
        user: this.config.smtp.user,
        pass: this.config.smtp.pass,
      },
    });
  }

  async sendEmail(options: SendEmailOptions): Promise<SendResult> {
    const transporter = this.createTransporter();
    try {
      const from = this.config.fromName
        ? `"${this.config.fromName}" <${this.config.smtp.user}>`
        : this.config.smtp.user;

      const info = await transporter.sendMail({
        from,
        to: options.to.join(", "),
        cc: options.cc?.join(", "),
        bcc: options.bcc?.join(", "),
        subject: options.subject,
        text: options.text,
        html: options.html,
        attachments: options.attachments,
      });

      return {
        messageId: info.messageId,
        accepted: info.accepted as string[],
        rejected: info.rejected as string[],
      };
    } catch (error) {
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /Users/mrios/Nextcloud/01-Projects/pim-agents && npx vitest run packages/email-mcp/src/__tests__/SmtpService.test.ts`
Expected: All SmtpService tests pass

**Step 5: Commit**

```bash
git add packages/email-mcp/src/services/SmtpService.ts packages/email-mcp/src/__tests__/SmtpService.test.ts
git commit -m "feat(email-mcp): add SmtpService for SMTP email sending"
```

---

## Task 6: MCP Tool Definitions and Handler

**Files:**
- Create: `packages/email-mcp/src/tools/emailTools.ts`
- Create: `packages/email-mcp/src/__tests__/emailTools.test.ts`

**Step 1: Write failing tests for tool definitions**

Create `packages/email-mcp/src/__tests__/emailTools.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { EMAIL_TOOLS } from "../tools/emailTools.js";

describe("EMAIL_TOOLS definitions", () => {
  it("defines 10 tools", () => {
    expect(EMAIL_TOOLS).toHaveLength(10);
  });

  it("all tools have name, description, and inputSchema", () => {
    for (const tool of EMAIL_TOOLS) {
      expect(tool.name).toBeDefined();
      expect(tool.description).toBeDefined();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("defines the expected tool names", () => {
    const names = EMAIL_TOOLS.map((t) => t.name);
    expect(names).toContain("list_emails");
    expect(names).toContain("get_email");
    expect(names).toContain("send_email");
    expect(names).toContain("move_email");
    expect(names).toContain("mark_email");
    expect(names).toContain("delete_email");
    expect(names).toContain("list_folders");
    expect(names).toContain("create_folder");
    expect(names).toContain("download_attachment");
    expect(names).toContain("get_email_raw");
  });

  it("send_email requires to and subject", () => {
    const tool = EMAIL_TOOLS.find((t) => t.name === "send_email")!;
    expect(tool.inputSchema.required).toContain("to");
    expect(tool.inputSchema.required).toContain("subject");
  });

  it("list_emails has folder and query params", () => {
    const tool = EMAIL_TOOLS.find((t) => t.name === "list_emails")!;
    expect(tool.inputSchema.properties).toHaveProperty("folder");
    expect(tool.inputSchema.properties).toHaveProperty("query");
  });

  it("get_email requires folder and uid", () => {
    const tool = EMAIL_TOOLS.find((t) => t.name === "get_email")!;
    expect(tool.inputSchema.required).toContain("uid");
  });

  it("download_attachment requires uid and partId", () => {
    const tool = EMAIL_TOOLS.find((t) => t.name === "download_attachment")!;
    expect(tool.inputSchema.required).toContain("uid");
    expect(tool.inputSchema.required).toContain("partId");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/mrios/Nextcloud/01-Projects/pim-agents && npx vitest run packages/email-mcp/src/__tests__/emailTools.test.ts`
Expected: FAIL — `EMAIL_TOOLS` does not exist

**Step 3: Implement tool definitions and handler**

Create `packages/email-mcp/src/tools/emailTools.ts`:

```typescript
import { EmailError, ErrorCode, toPimError } from "@miguelarios/pim-core";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { parseSearchQuery } from "../search.js";
import type { ImapService } from "../services/ImapService.js";
import type { SmtpService } from "../services/SmtpService.js";

export const EMAIL_TOOLS: Tool[] = [
  {
    name: "list_emails",
    description:
      "Search and list emails in a folder. Supports structured query prefixes: from:, to:, subject:, is:unread/read/flagged, has:attachment, since:YYYY-MM-DD, before:YYYY-MM-DD. Plain text searches subject and body. Returns email summaries with UID, subject, sender, date, and flags.",
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "IMAP folder to search. Defaults to INBOX.",
        },
        query: {
          type: "string",
          description:
            'Search query with optional prefixes. Examples: "from:boss@work.com is:unread", "subject:meeting", "has:attachment". Plain text searches body.',
        },
        limit: {
          type: "number",
          description: "Max results to return. Defaults to 20.",
        },
        offset: {
          type: "number",
          description: "Number of results to skip for pagination. Defaults to 0.",
        },
      },
    },
  },
  {
    name: "get_email",
    description:
      "Fetch a full email by UID including headers, text/HTML body, and attachment metadata.",
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "IMAP folder containing the email. Defaults to INBOX.",
        },
        uid: {
          type: "number",
          description: "The UID of the email to fetch.",
        },
      },
      required: ["uid"],
    },
  },
  {
    name: "send_email",
    description:
      "Compose and send an email via SMTP. Supports to/cc/bcc, text and HTML body, and file attachments.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "array",
          items: { type: "string" },
          description: "Recipient email addresses.",
        },
        cc: {
          type: "array",
          items: { type: "string" },
          description: "CC email addresses.",
        },
        bcc: {
          type: "array",
          items: { type: "string" },
          description: "BCC email addresses.",
        },
        subject: {
          type: "string",
          description: "Email subject line.",
        },
        text: {
          type: "string",
          description: "Plain text body.",
        },
        html: {
          type: "string",
          description: "HTML body.",
        },
        attachments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              filename: { type: "string" },
              path: { type: "string", description: "File path to attach." },
              content: { type: "string", description: "String content to attach." },
            },
            required: ["filename"],
          },
          description: "File attachments.",
        },
      },
      required: ["to", "subject"],
    },
  },
  {
    name: "move_email",
    description: "Move one or more emails to a different IMAP folder.",
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "Source IMAP folder. Defaults to INBOX.",
        },
        uids: {
          type: "array",
          items: { type: "number" },
          description: "UIDs of emails to move.",
        },
        destination: {
          type: "string",
          description: "Destination folder path.",
        },
      },
      required: ["uids", "destination"],
    },
  },
  {
    name: "mark_email",
    description:
      'Set or unset flags on one or more emails. Common flags: "\\Seen" (read), "\\Flagged" (starred).',
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "IMAP folder. Defaults to INBOX.",
        },
        uids: {
          type: "array",
          items: { type: "number" },
          description: "UIDs of emails to modify.",
        },
        flags: {
          type: "array",
          items: { type: "string" },
          description: 'Flags to set/unset (e.g., "\\Seen", "\\Flagged").',
        },
        action: {
          type: "string",
          enum: ["add", "remove"],
          description: 'Whether to add or remove the flags. Defaults to "add".',
        },
      },
      required: ["uids", "flags"],
    },
  },
  {
    name: "delete_email",
    description:
      "Delete one or more emails. Moves to Trash by default, or permanently deletes if specified.",
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "IMAP folder. Defaults to INBOX.",
        },
        uids: {
          type: "array",
          items: { type: "number" },
          description: "UIDs of emails to delete.",
        },
        permanent: {
          type: "boolean",
          description: "If true, permanently delete instead of moving to Trash. Defaults to false.",
        },
      },
      required: ["uids"],
    },
  },
  {
    name: "list_folders",
    description: "List all IMAP folders with their paths and special-use flags (Inbox, Sent, Trash, etc.).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "create_folder",
    description: "Create a new IMAP folder.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Folder path to create (e.g., 'Projects/Work').",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "download_attachment",
    description:
      "Download a specific attachment from an email. Returns the attachment content as base64.",
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "IMAP folder. Defaults to INBOX.",
        },
        uid: {
          type: "number",
          description: "UID of the email containing the attachment.",
        },
        partId: {
          type: "string",
          description: "MIME part ID of the attachment (from get_email attachment metadata).",
        },
      },
      required: ["uid", "partId"],
    },
  },
  {
    name: "get_email_raw",
    description: "Export an email as raw .eml (RFC 822 source). Useful for archival or forwarding.",
    inputSchema: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description: "IMAP folder. Defaults to INBOX.",
        },
        uid: {
          type: "number",
          description: "UID of the email to export.",
        },
      },
      required: ["uid"],
    },
  },
];

export async function handleEmailTool(
  name: string,
  args: Record<string, unknown>,
  imapService: ImapService,
  smtpService: SmtpService,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const folder = (args.folder as string) || "INBOX";

    switch (name) {
      case "list_emails": {
        const query = args.query ? parseSearchQuery(args.query as string) : {};
        const limit = (args.limit as number) || 20;
        const offset = (args.offset as number) || 0;
        const emails = await imapService.searchEmails(folder, query, { limit, offset });
        return ok(JSON.stringify(emails, null, 2));
      }

      case "get_email": {
        const uid = args.uid as number;
        const email = await imapService.fetchEmail(folder, uid);
        return ok(JSON.stringify(email, null, 2));
      }

      case "send_email": {
        const result = await smtpService.sendEmail({
          to: args.to as string[],
          cc: args.cc as string[] | undefined,
          bcc: args.bcc as string[] | undefined,
          subject: args.subject as string,
          text: args.text as string | undefined,
          html: args.html as string | undefined,
          attachments: args.attachments as any[] | undefined,
        });
        return ok(JSON.stringify({ status: "sent", ...result }));
      }

      case "move_email": {
        const uids = args.uids as number[];
        const destination = args.destination as string;
        await imapService.moveEmails(folder, uids, destination);
        return ok(JSON.stringify({ status: "moved", uids, destination }));
      }

      case "mark_email": {
        const uids = args.uids as number[];
        const flags = args.flags as string[];
        const action = (args.action as "add" | "remove") || "add";
        await imapService.markEmails(folder, uids, flags, action);
        return ok(JSON.stringify({ status: "updated", uids, flags, action }));
      }

      case "delete_email": {
        const uids = args.uids as number[];
        const permanent = (args.permanent as boolean) || false;
        await imapService.deleteEmails(folder, uids, permanent);
        return ok(
          JSON.stringify({
            status: permanent ? "permanently_deleted" : "moved_to_trash",
            uids,
          }),
        );
      }

      case "list_folders": {
        const folders = await imapService.listFolders();
        return ok(JSON.stringify(folders, null, 2));
      }

      case "create_folder": {
        const path = args.path as string;
        await imapService.createFolder(path);
        return ok(JSON.stringify({ status: "created", path }));
      }

      case "download_attachment": {
        const uid = args.uid as number;
        const partId = args.partId as string;
        const attachment = await imapService.downloadAttachment(folder, uid, partId);
        return ok(
          JSON.stringify({
            filename: attachment.filename,
            contentType: attachment.contentType,
            size: attachment.size,
            content: attachment.content.toString("base64"),
          }),
        );
      }

      case "get_email_raw": {
        const uid = args.uid as number;
        const raw = await imapService.fetchRawEmail(folder, uid);
        return ok(raw);
      }

      default:
        return error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const pimError = toPimError(err instanceof Error ? err : new Error(String(err)));
    return error(`${pimError.message}${pimError.isRetryable ? " (retryable)" : ""}`);
  }
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function error(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
```

**Step 4: Run tests to verify they pass**

Run: `cd /Users/mrios/Nextcloud/01-Projects/pim-agents && npx vitest run packages/email-mcp/src/__tests__/emailTools.test.ts`
Expected: All tool definition tests pass

**Step 5: Commit**

```bash
git add packages/email-mcp/src/tools/emailTools.ts packages/email-mcp/src/__tests__/emailTools.test.ts
git commit -m "feat(email-mcp): add 10 MCP tool definitions and handler"
```

---

## Task 7: MCP Server Main + Wire Everything Together

**Files:**
- Modify: `packages/email-mcp/src/main.ts`

**Step 1: Update main.ts to wire services and tools**

Replace `packages/email-mcp/src/main.ts` with:

```typescript
import { loadEmailConfig, toPimError } from "@miguelarios/pim-core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ImapService } from "./services/ImapService.js";
import { SmtpService } from "./services/SmtpService.js";
import { EMAIL_TOOLS, handleEmailTool } from "./tools/emailTools.js";

export async function createServer(): Promise<Server> {
  const config = loadEmailConfig();
  const imapService = new ImapService(config);
  const smtpService = new SmtpService(config);

  const server = new Server(
    { name: "@miguelarios/email-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: EMAIL_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleEmailTool(name, (args ?? {}) as Record<string, unknown>, imapService, smtpService);
  });

  const handleShutdown = async () => {
    process.exit(0);
  };
  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);

  server.onerror = (error) => {
    console.error("[email-mcp] Server error:", error.message);
  };

  return server;
}

export async function startServer(): Promise<void> {
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[email-mcp] Server started on stdio");
}
```

**Step 2: Verify build and typecheck**

Run: `cd /Users/mrios/Nextcloud/01-Projects/pim-agents && npx turbo run build typecheck`
Expected: All packages build and typecheck successfully

**Step 3: Run all email-mcp tests**

Run: `cd /Users/mrios/Nextcloud/01-Projects/pim-agents && npx vitest run packages/email-mcp/`
Expected: All tests pass

**Step 4: Run full test suite**

Run: `cd /Users/mrios/Nextcloud/01-Projects/pim-agents && npx vitest run`
Expected: All tests pass across all packages

**Step 5: Commit**

```bash
git add packages/email-mcp/src/main.ts
git commit -m "feat(email-mcp): wire MCP server with IMAP and SMTP services"
```

---

## Task 8: Format, Lint, CI Check

**Step 1: Run biome format**

Run: `cd /Users/mrios/Nextcloud/01-Projects/pim-agents && npx biome check --write .`
Expected: Formatting applied, no errors

**Step 2: Run typecheck**

Run: `cd /Users/mrios/Nextcloud/01-Projects/pim-agents && npx turbo run typecheck`
Expected: No type errors

**Step 3: Run full test suite**

Run: `cd /Users/mrios/Nextcloud/01-Projects/pim-agents && npx vitest run`
Expected: All tests pass

**Step 4: Commit formatting changes if any**

```bash
git add -A
git commit -m "style: apply biome formatting to email-mcp"
```

(Only if there are formatting changes.)

---

## Task 9: Update CLAUDE.md and .env.example

**Files:**
- Modify: `CLAUDE.md`
- Verify: `.env.example` (already updated in Task 2)

**Step 1: Update CLAUDE.md to reflect Phase 2 completion**

Add email-mcp to the package descriptions and update the phase status in `CLAUDE.md`.

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md with email-mcp package info"
```

---

## Task 10: Push and Verify CI

**Step 1: Push to GitHub**

Run: `cd /Users/mrios/Nextcloud/01-Projects/pim-agents && git push origin main`

**Step 2: Verify CI passes**

Run: `gh run list --limit 1`
Expected: CI workflow passes (lint, typecheck, test on Node 20+22)
