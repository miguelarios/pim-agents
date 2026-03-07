# Phase 3: Calendar (CalDAV) MVP Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a multi-provider CalDAV MCP server with 9 tools for calendar CRUD, batch creation, ICS import, and availability search.

**Architecture:** Single `CalDavService` class with internal provider map routes by provider-prefixed calendar IDs (e.g., `mailbox/work`). Uses tsdav for CalDAV protocol, ical-generator for creating iCal, node-ical for parsing. Follows card-mcp patterns for service, tools, and MCP server wiring.

**Tech Stack:** TypeScript, tsdav, ical-generator, node-ical, @modelcontextprotocol/sdk, Vitest

**Design doc:** `docs/plans/2026-03-05-phase3-calendar-mvp-design.md`

---

### Task 1: Package Scaffolding

**Files:**
- Modify: `packages/cal-mcp/package.json`
- Modify: `packages/cal-mcp/tsconfig.json`
- Create: `packages/cal-mcp/src/bin/cli.ts` (placeholder)

**Step 1: Update package.json**

Replace the stub package.json with full config:

```json
{
  "name": "@miguelarios/cal-mcp",
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "cal-mcp": "dist/bin/cli.js"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "biome check .",
    "start": "node dist/bin/cli.js"
  },
  "dependencies": {
    "@miguelarios/pim-core": "*",
    "@modelcontextprotocol/sdk": "^1.12.0",
    "tsdav": "^2.1.0",
    "ical-generator": "^8.0.0",
    "node-ical": "^0.20.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

**Step 2: Update tsconfig.json**

Add project reference to core (same as card-mcp):

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

**Step 3: Create directory structure**

```bash
mkdir -p packages/cal-mcp/src/{services,tools,__tests__,bin}
```

**Step 4: Create placeholder cli.ts**

```typescript
#!/usr/bin/env node
console.error("cal-mcp: not yet wired");
```

**Step 5: Install dependencies**

```bash
npm install
```

Run: `cd packages/cal-mcp && npx tsc --noEmit`
Expected: May show errors for missing source files — that's OK at this stage. Verify dependencies resolve.

**Step 6: Commit**

```bash
git add packages/cal-mcp/
git commit -m "chore(cal-mcp): scaffold package with dependencies"
```

---

### Task 2: Core Library — CalDavConfig + CalendarError

**Files:**
- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/src/errors.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/src/__tests__/calDavConfig.test.ts`
- Modify: `packages/core/src/__tests__/errors.test.ts`

**Step 1: Write failing test for loadCalDavConfig**

Create `packages/core/src/__tests__/calDavConfig.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCalDavConfig } from "../config.js";

const VALID_ACCOUNTS = JSON.stringify([
  {
    id: "mailbox",
    url: "https://dav.mailbox.org/caldav/",
    username: "miguel@mailbox.org",
    password: "caldav-secret",
  },
  {
    id: "nextcloud",
    url: "https://cloud.example.com/remote.php/dav/calendars/miguel/",
    username: "miguel",
    password: "nc-secret",
  },
]);

describe("loadCalDavConfig", () => {
  beforeEach(() => {
    vi.stubEnv("CALDAV_ACCOUNTS", VALID_ACCOUNTS);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("loads valid CalDAV config from CALDAV_ACCOUNTS env var", () => {
    const config = loadCalDavConfig();
    expect(config.accounts).toHaveLength(2);
    expect(config.accounts[0].id).toBe("mailbox");
    expect(config.accounts[0].url).toBe("https://dav.mailbox.org/caldav/");
    expect(config.accounts[0].username).toBe("miguel@mailbox.org");
    expect(config.accounts[0].password).toBe("caldav-secret");
    expect(config.accounts[1].id).toBe("nextcloud");
  });

  it("throws ConfigurationError when CALDAV_ACCOUNTS is missing", () => {
    vi.stubEnv("CALDAV_ACCOUNTS", "");
    expect(() => loadCalDavConfig()).toThrow("CALDAV_ACCOUNTS");
  });

  it("throws ConfigurationError when CALDAV_ACCOUNTS is invalid JSON", () => {
    vi.stubEnv("CALDAV_ACCOUNTS", "not-json");
    expect(() => loadCalDavConfig()).toThrow();
  });

  it("throws ConfigurationError when account is missing required fields", () => {
    vi.stubEnv("CALDAV_ACCOUNTS", JSON.stringify([{ id: "test" }]));
    expect(() => loadCalDavConfig()).toThrow("Config validation failed");
  });

  it("throws ConfigurationError when accounts array is empty", () => {
    vi.stubEnv("CALDAV_ACCOUNTS", "[]");
    expect(() => loadCalDavConfig()).toThrow("Config validation failed");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run src/__tests__/calDavConfig.test.ts`
Expected: FAIL — `loadCalDavConfig` is not exported

**Step 3: Implement CalDavConfig and loadCalDavConfig**

Add to `packages/core/src/config.ts`:

```typescript
export interface CalDavAccount {
  id: string;
  url: string;
  username: string;
  password: string;
}

export interface CalDavConfig {
  accounts: CalDavAccount[];
}

const CalDavAccountSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1, "Account id cannot be empty")),
  url: v.pipe(v.string(), v.url("Account url must be a valid URL")),
  username: v.pipe(v.string(), v.minLength(1, "Account username cannot be empty")),
  password: v.pipe(v.string(), v.minLength(1, "Account password cannot be empty")),
});

const CalDavAccountsSchema = v.pipe(
  v.array(CalDavAccountSchema),
  v.minLength(1, "At least one CalDAV account is required"),
);

export function loadCalDavConfig(): CalDavConfig {
  const raw = process.env.CALDAV_ACCOUNTS;
  if (!raw) {
    throw new ConfigurationError("CALDAV_ACCOUNTS environment variable is required");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigurationError("CALDAV_ACCOUNTS must be valid JSON");
  }

  try {
    const accounts = v.parse(CalDavAccountsSchema, parsed);
    return { accounts };
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

**Step 4: Add CalendarError and error codes to errors.ts**

Add to the `ErrorCode` enum in `packages/core/src/errors.ts`:

```typescript
CALENDAR_NOT_FOUND = "CALENDAR_NOT_FOUND",
EVENT_NOT_FOUND = "EVENT_NOT_FOUND",
INVALID_ICS = "INVALID_ICS",
```

Add class after `EmailError`:

```typescript
export class CalendarError extends PimError {
  public readonly eventUid?: string;
  constructor(message: string, code: ErrorCode, eventUid?: string) {
    super(message, code, false);
    this.eventUid = eventUid;
  }
}
```

**Step 5: Update exports in index.ts**

Add to `packages/core/src/index.ts`:

```typescript
export {
  type CalDavAccount,
  type CalDavConfig,
  loadCalDavConfig,
} from "./config.js";

// Add CalendarError to the errors export block
```

**Step 6: Add CalendarError test to existing errors.test.ts**

Add a test case to `packages/core/src/__tests__/errors.test.ts`:

```typescript
it("creates CalendarError with event UID", () => {
  const error = new CalendarError("Event not found", ErrorCode.EVENT_NOT_FOUND, "evt-123");
  expect(error.message).toBe("Event not found");
  expect(error.code).toBe(ErrorCode.EVENT_NOT_FOUND);
  expect(error.eventUid).toBe("evt-123");
  expect(error.isRetryable).toBe(false);
});
```

**Step 7: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run`
Expected: All tests pass (existing + new calDavConfig + new CalendarError test)

**Step 8: Commit**

```bash
git add packages/core/
git commit -m "feat(core): add CalDavConfig, loadCalDavConfig, and CalendarError"
```

---

### Task 3: iCal Helpers — Parse and Generate

**Files:**
- Create: `packages/cal-mcp/src/ical.ts`
- Create: `packages/cal-mcp/src/__tests__/ical.test.ts`

**Note:** If `node-ical` doesn't have TypeScript types and causes build errors, create `packages/cal-mcp/src/types/node-ical.d.ts` with a minimal declaration:
```typescript
declare module "node-ical" {
  export interface VEvent {
    type: "VEVENT";
    uid: string;
    summary?: string;
    start?: Date;
    end?: Date;
    location?: string;
    description?: string;
    status?: string;
    transparency?: string;
    attendee?: Array<{ params: { CN?: string }; val: string }> | { params: { CN?: string }; val: string };
    organizer?: { params: { CN?: string }; val: string };
    rrule?: { toString(): string };
    created?: Date;
    lastmodified?: Date;
  }
  export interface CalendarComponent {
    type: string;
    [key: string]: unknown;
  }
  export function parseICS(icsData: string): Record<string, CalendarComponent | VEvent>;
}
```

**Step 1: Write failing tests for parseIcsEvents and generateEventIcs**

Create `packages/cal-mcp/src/__tests__/ical.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { generateEventIcs, parseIcsEvents } from "../ical.js";

const SAMPLE_ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:evt-1@example.com
DTSTART:20260310T140000Z
DTEND:20260310T150000Z
SUMMARY:Team Meeting
LOCATION:Office Room A
DESCRIPTION:Weekly standup
STATUS:CONFIRMED
TRANSP:OPAQUE
END:VEVENT
END:VCALENDAR`;

const MULTI_EVENT_ICS = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:evt-1@example.com
DTSTART:20260310T090000Z
DTEND:20260310T100000Z
SUMMARY:Morning Meeting
END:VEVENT
BEGIN:VEVENT
UID:evt-2@example.com
DTSTART:20260310T140000Z
DTEND:20260310T150000Z
SUMMARY:Afternoon Meeting
END:VEVENT
END:VCALENDAR`;

describe("parseIcsEvents", () => {
  it("parses a single VEVENT from iCalendar string", () => {
    const events = parseIcsEvents(SAMPLE_ICS);
    expect(events).toHaveLength(1);
    expect(events[0].uid).toBe("evt-1@example.com");
    expect(events[0].summary).toBe("Team Meeting");
    expect(events[0].location).toBe("Office Room A");
    expect(events[0].description).toBe("Weekly standup");
    expect(events[0].status).toBe("CONFIRMED");
    expect(events[0].transparency).toBe("OPAQUE");
    expect(events[0].start).toContain("2026-03-10");
    expect(events[0].end).toContain("2026-03-10");
  });

  it("parses multiple VEVENTs from iCalendar string", () => {
    const events = parseIcsEvents(MULTI_EVENT_ICS);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.summary).sort()).toEqual([
      "Afternoon Meeting",
      "Morning Meeting",
    ]);
  });

  it("returns empty array for iCalendar with no VEVENTs", () => {
    const events = parseIcsEvents("BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR");
    expect(events).toHaveLength(0);
  });

  it("returns empty array for empty string", () => {
    const events = parseIcsEvents("");
    expect(events).toHaveLength(0);
  });
});

describe("generateEventIcs", () => {
  it("generates valid iCalendar string with required fields", () => {
    const ics = generateEventIcs({
      summary: "Test Event",
      start: "2026-03-10T14:00:00Z",
      end: "2026-03-10T15:00:00Z",
    });
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("BEGIN:VEVENT");
    expect(ics).toContain("Test Event");
    expect(ics).toContain("END:VEVENT");
    expect(ics).toContain("END:VCALENDAR");
  });

  it("includes optional fields when provided", () => {
    const ics = generateEventIcs({
      summary: "Lunch",
      start: "2026-03-10T12:00:00Z",
      end: "2026-03-10T13:00:00Z",
      location: "Cafe",
      description: "Team lunch",
    });
    expect(ics).toContain("Cafe");
    expect(ics).toContain("Team lunch");
  });

  it("includes attendees when provided", () => {
    const ics = generateEventIcs({
      summary: "Meeting",
      start: "2026-03-10T14:00:00Z",
      end: "2026-03-10T15:00:00Z",
      attendees: [{ email: "bob@example.com", name: "Bob" }],
    });
    expect(ics).toContain("bob@example.com");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/cal-mcp && npx vitest run src/__tests__/ical.test.ts`
Expected: FAIL — module not found

**Step 3: Implement ical.ts**

Create `packages/cal-mcp/src/ical.ts`:

```typescript
import ical from "ical-generator";
import * as nodeIcal from "node-ical";

export interface ParsedEvent {
  uid: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  status?: string;
  transparency?: string;
  attendees?: Array<{ name?: string; email: string; status?: string }>;
  organizer?: { name?: string; email: string };
  recurrenceRule?: string;
  created?: string;
  lastModified?: string;
}

export interface EventCreateProps {
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
  attendees?: Array<{ email: string; name?: string }>;
}

export function parseIcsEvents(icsContent: string): ParsedEvent[] {
  if (!icsContent.trim()) return [];

  const parsed = nodeIcal.parseICS(icsContent);
  const events: ParsedEvent[] = [];

  for (const component of Object.values(parsed)) {
    if (component.type !== "VEVENT") continue;
    const vevent = component as nodeIcal.VEvent;

    const attendees: Array<{ name?: string; email: string; status?: string }> = [];
    if (vevent.attendee) {
      const attendeeList = Array.isArray(vevent.attendee)
        ? vevent.attendee
        : [vevent.attendee];
      for (const att of attendeeList) {
        const email = typeof att === "string"
          ? att.replace("mailto:", "")
          : (att.val || "").replace("mailto:", "");
        const name = typeof att === "string" ? undefined : att.params?.CN;
        attendees.push({ email, name });
      }
    }

    let organizer: { name?: string; email: string } | undefined;
    if (vevent.organizer) {
      const org = vevent.organizer;
      organizer = {
        email: (typeof org === "string" ? org : org.val || "").replace("mailto:", ""),
        name: typeof org === "string" ? undefined : org.params?.CN,
      };
    }

    events.push({
      uid: vevent.uid || "",
      summary: vevent.summary || "",
      start: vevent.start ? new Date(vevent.start).toISOString() : "",
      end: vevent.end ? new Date(vevent.end).toISOString() : "",
      location: vevent.location,
      description: vevent.description,
      status: vevent.status?.toUpperCase(),
      transparency: vevent.transparency?.toUpperCase(),
      attendees: attendees.length > 0 ? attendees : undefined,
      organizer,
      recurrenceRule: vevent.rrule?.toString(),
      created: vevent.created ? new Date(vevent.created).toISOString() : undefined,
      lastModified: vevent.lastmodified
        ? new Date(vevent.lastmodified).toISOString()
        : undefined,
    });
  }

  return events;
}

export function generateEventIcs(props: EventCreateProps): string {
  const calendar = ical({ name: "cal-mcp" });

  const eventOptions: Parameters<typeof calendar.createEvent>[0] = {
    start: new Date(props.start),
    end: new Date(props.end),
    summary: props.summary,
  };
  if (props.location) eventOptions.location = props.location;
  if (props.description) eventOptions.description = props.description;

  const event = calendar.createEvent(eventOptions);

  if (props.attendees) {
    for (const att of props.attendees) {
      event.createAttendee({ email: att.email, name: att.name });
    }
  }

  return calendar.toString();
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/cal-mcp && npx vitest run src/__tests__/ical.test.ts`
Expected: All pass. If `node-ical` type issues occur, create the `.d.ts` shim described above.

**Step 5: Commit**

```bash
git add packages/cal-mcp/src/ical.ts packages/cal-mcp/src/__tests__/ical.test.ts
git commit -m "feat(cal-mcp): add iCal parse and generate helpers"
```

---

### Task 4: CalDavService — Constructor + listCalendars

**Files:**
- Create: `packages/cal-mcp/src/services/CalDavService.ts`
- Create: `packages/cal-mcp/src/__tests__/CalDavService.test.ts`

**Step 1: Write failing tests**

Create `packages/cal-mcp/src/__tests__/CalDavService.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CalDavService } from "../services/CalDavService.js";

// Mock tsdav — same pattern as card-mcp
vi.mock("tsdav", () => {
  const mockClient = {
    login: vi.fn().mockResolvedValue(undefined),
    fetchCalendars: vi.fn().mockResolvedValue([
      {
        displayName: "Work",
        url: "/caldav/work/",
        ctag: "ctag-1",
        components: ["VEVENT"],
      },
      {
        displayName: "Personal",
        url: "/caldav/personal/",
        ctag: "ctag-2",
        components: ["VEVENT"],
      },
    ]),
    fetchCalendarObjects: vi.fn().mockResolvedValue([]),
    createCalendarObject: vi.fn().mockResolvedValue({ ok: true }),
    updateCalendarObject: vi.fn().mockResolvedValue({ ok: true }),
    deleteCalendarObject: vi.fn().mockResolvedValue({ ok: true }),
  };
  return {
    DAVClient: vi.fn().mockImplementation(() => mockClient),
    __mockClient: mockClient,
  };
});

// Mock ical helpers
vi.mock("../ical.js", () => ({
  parseIcsEvents: vi.fn().mockReturnValue([]),
  generateEventIcs: vi.fn().mockReturnValue("BEGIN:VCALENDAR\nEND:VCALENDAR"),
}));

const TEST_CONFIG = {
  accounts: [
    {
      id: "mailbox",
      url: "https://dav.mailbox.org/caldav/",
      username: "miguel@mailbox.org",
      password: "secret-1",
    },
    {
      id: "nextcloud",
      url: "https://cloud.example.com/remote.php/dav/calendars/miguel/",
      username: "miguel",
      password: "secret-2",
    },
  ],
};

describe("CalDavService", () => {
  let service: CalDavService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new CalDavService(TEST_CONFIG);
  });

  describe("listCalendars", () => {
    it("fetches calendars from all providers and returns provider-prefixed IDs", async () => {
      const calendars = await service.listCalendars();
      // 2 calendars per provider × 2 providers = 4
      expect(calendars).toHaveLength(4);

      // Check mailbox calendars
      const mailboxCals = calendars.filter((c) => c.calendarId.startsWith("mailbox/"));
      expect(mailboxCals).toHaveLength(2);
      expect(mailboxCals[0].calendarId).toBe("mailbox/Work");
      expect(mailboxCals[0].displayName).toBe("Work");

      // Check nextcloud calendars
      const ncCals = calendars.filter((c) => c.calendarId.startsWith("nextcloud/"));
      expect(ncCals).toHaveLength(2);
    });

    it("creates DAVClient with correct config per provider", async () => {
      const { DAVClient } = await import("tsdav");
      await service.listCalendars();

      expect(DAVClient).toHaveBeenCalledTimes(2);
      expect(DAVClient).toHaveBeenCalledWith(
        expect.objectContaining({
          serverUrl: "https://dav.mailbox.org/caldav/",
          credentials: { username: "miguel@mailbox.org", password: "secret-1" },
          authMethod: "Basic",
          defaultAccountType: "caldav",
        }),
      );
      expect(DAVClient).toHaveBeenCalledWith(
        expect.objectContaining({
          serverUrl: "https://cloud.example.com/remote.php/dav/calendars/miguel/",
        }),
      );
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/cal-mcp && npx vitest run src/__tests__/CalDavService.test.ts`
Expected: FAIL — CalDavService not found

**Step 3: Implement CalDavService constructor + listCalendars**

Create `packages/cal-mcp/src/services/CalDavService.ts`:

```typescript
import {
  type CalDavAccount,
  type CalDavConfig,
  CalendarError,
  ErrorCode,
  toPimError,
} from "@miguelarios/pim-core";
import { DAVClient } from "tsdav";
import { type ParsedEvent, parseIcsEvents } from "../ical.js";

export interface CalendarInfo {
  calendarId: string;
  displayName: string;
  url: string;
  ctag?: string;
  providerId: string;
}

export interface EventSummary {
  uid: string;
  calendarId: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
  status?: string;
  isRecurring: boolean;
}

export interface EventFull extends EventSummary {
  description?: string;
  attendees?: Array<{ name?: string; email: string; status?: string }>;
  organizer?: { name?: string; email: string };
  recurrenceRule?: string;
  transparency?: string;
  created?: string;
  lastModified?: string;
}

export interface FreeSlot {
  start: string;
  end: string;
  duration: number;
}

export class CalDavService {
  private accounts: Map<string, CalDavAccount>;

  constructor(config: CalDavConfig) {
    this.accounts = new Map(config.accounts.map((a) => [a.id, a]));
  }

  private createClient(account: CalDavAccount): DAVClient {
    return new DAVClient({
      serverUrl: account.url,
      credentials: {
        username: account.username,
        password: account.password,
      },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
  }

  private resolveAccount(calendarId: string): { account: CalDavAccount; calendarName: string } {
    const slashIndex = calendarId.indexOf("/");
    if (slashIndex === -1) {
      throw new CalendarError(
        `Invalid calendar ID "${calendarId}" — must be "provider/calendar"`,
        ErrorCode.CALENDAR_NOT_FOUND,
      );
    }
    const providerId = calendarId.substring(0, slashIndex);
    const calendarName = calendarId.substring(slashIndex + 1);
    const account = this.accounts.get(providerId);
    if (!account) {
      throw new CalendarError(
        `Unknown provider "${providerId}"`,
        ErrorCode.CALENDAR_NOT_FOUND,
      );
    }
    return { account, calendarName };
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const allCalendars: CalendarInfo[] = [];

    for (const [providerId, account] of this.accounts) {
      const client = this.createClient(account);
      try {
        await client.login();
        const calendars = await client.fetchCalendars();
        for (const cal of calendars) {
          const displayName =
            (typeof cal.displayName === "string" ? cal.displayName : "") || "";
          allCalendars.push({
            calendarId: `${providerId}/${displayName}`,
            displayName,
            url: cal.url,
            ctag: cal.ctag,
            providerId,
          });
        }
      } catch (error) {
        throw toPimError(error instanceof Error ? error : new Error(String(error)));
      }
    }

    return allCalendars;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/cal-mcp && npx vitest run src/__tests__/CalDavService.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/cal-mcp/src/services/ packages/cal-mcp/src/__tests__/CalDavService.test.ts
git commit -m "feat(cal-mcp): add CalDavService with listCalendars"
```

---

### Task 5: CalDavService — listEvents

**Files:**
- Modify: `packages/cal-mcp/src/services/CalDavService.ts`
- Modify: `packages/cal-mcp/src/__tests__/CalDavService.test.ts`

**Step 1: Write failing test**

Add to `CalDavService.test.ts` inside the main describe:

```typescript
describe("listEvents", () => {
  it("fetches events with time range and returns EventSummary array", async () => {
    const { __mockClient } = (await import("tsdav")) as any;
    const { parseIcsEvents } = await import("../ical.js");
    (parseIcsEvents as any).mockReturnValue([
      {
        uid: "evt-1",
        summary: "Team Meeting",
        start: "2026-03-10T14:00:00.000Z",
        end: "2026-03-10T15:00:00.000Z",
        location: "Office",
        status: "CONFIRMED",
        recurrenceRule: undefined,
      },
    ]);
    __mockClient.fetchCalendarObjects.mockResolvedValue([
      { data: "BEGIN:VCALENDAR...END:VCALENDAR", url: "/cal/evt-1.ics", etag: '"e1"' },
    ]);

    const events = await service.listEvents(
      "mailbox/Work",
      "2026-03-10T00:00:00Z",
      "2026-03-10T23:59:59Z",
    );

    expect(events).toHaveLength(1);
    expect(events[0].uid).toBe("evt-1");
    expect(events[0].calendarId).toBe("mailbox/Work");
    expect(events[0].summary).toBe("Team Meeting");
    expect(events[0].isRecurring).toBe(false);

    expect(__mockClient.fetchCalendarObjects).toHaveBeenCalledWith(
      expect.objectContaining({
        timeRange: {
          start: "2026-03-10T00:00:00Z",
          end: "2026-03-10T23:59:59Z",
        },
        expand: true,
      }),
    );
  });

  it("throws CalendarError for unknown provider", async () => {
    await expect(
      service.listEvents("unknown/cal", "2026-03-10T00:00:00Z", "2026-03-10T23:59:59Z"),
    ).rejects.toThrow("Unknown provider");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/cal-mcp && npx vitest run src/__tests__/CalDavService.test.ts`
Expected: FAIL — `listEvents` is not a function

**Step 3: Implement listEvents**

Add to `CalDavService` class:

```typescript
async listEvents(calendarId: string, start: string, end: string): Promise<EventSummary[]> {
  const { account, calendarName } = this.resolveAccount(calendarId);
  const client = this.createClient(account);

  try {
    await client.login();
    const calendars = await client.fetchCalendars();
    const calendar = calendars.find(
      (c) => (typeof c.displayName === "string" ? c.displayName : "") === calendarName,
    );
    if (!calendar) {
      throw new CalendarError(
        `Calendar "${calendarName}" not found on provider "${account.id}"`,
        ErrorCode.CALENDAR_NOT_FOUND,
      );
    }

    const objects = await client.fetchCalendarObjects({
      calendar,
      timeRange: { start, end },
      expand: true,
    });

    const summaries: EventSummary[] = [];
    for (const obj of objects) {
      if (!obj.data) continue;
      const parsed = parseIcsEvents(obj.data);
      for (const event of parsed) {
        summaries.push({
          uid: event.uid,
          calendarId,
          summary: event.summary,
          start: event.start,
          end: event.end,
          location: event.location,
          status: event.status,
          isRecurring: !!event.recurrenceRule,
        });
      }
    }

    return summaries;
  } catch (error) {
    if (error instanceof CalendarError) throw error;
    throw toPimError(error instanceof Error ? error : new Error(String(error)));
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/cal-mcp && npx vitest run src/__tests__/CalDavService.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/cal-mcp/src/
git commit -m "feat(cal-mcp): add CalDavService.listEvents with time-range"
```

---

### Task 6: CalDavService — getEvent + CRUD

**Files:**
- Modify: `packages/cal-mcp/src/services/CalDavService.ts`
- Modify: `packages/cal-mcp/src/__tests__/CalDavService.test.ts`

**Step 1: Write failing tests for getEvent, createEvent, updateEvent, deleteEvent**

Add to `CalDavService.test.ts`:

```typescript
describe("getEvent", () => {
  it("fetches a single event by UID and returns full details", async () => {
    const { __mockClient } = (await import("tsdav")) as any;
    const { parseIcsEvents } = await import("../ical.js");
    (parseIcsEvents as any).mockReturnValue([
      {
        uid: "evt-1",
        summary: "Team Meeting",
        start: "2026-03-10T14:00:00.000Z",
        end: "2026-03-10T15:00:00.000Z",
        location: "Office",
        description: "Weekly standup",
        status: "CONFIRMED",
        transparency: "OPAQUE",
        attendees: [{ email: "bob@example.com", name: "Bob" }],
        organizer: { email: "miguel@example.com", name: "Miguel" },
        recurrenceRule: undefined,
      },
    ]);
    __mockClient.fetchCalendarObjects.mockResolvedValue([
      { data: "BEGIN:VCALENDAR...END:VCALENDAR", url: "/cal/evt-1.ics", etag: '"e1"' },
    ]);

    const event = await service.getEvent("mailbox/Work", "evt-1");

    expect(event.uid).toBe("evt-1");
    expect(event.calendarId).toBe("mailbox/Work");
    expect(event.description).toBe("Weekly standup");
    expect(event.attendees).toHaveLength(1);
    expect(event.organizer?.email).toBe("miguel@example.com");
  });

  it("throws CalendarError when event not found", async () => {
    const { __mockClient } = (await import("tsdav")) as any;
    const { parseIcsEvents } = await import("../ical.js");
    (parseIcsEvents as any).mockReturnValue([
      { uid: "other-event", summary: "Other" },
    ]);
    __mockClient.fetchCalendarObjects.mockResolvedValue([
      { data: "...", url: "/cal/other.ics", etag: '"e1"' },
    ]);

    await expect(service.getEvent("mailbox/Work", "evt-missing")).rejects.toThrow("not found");
  });
});

describe("createEvent", () => {
  it("creates a calendar object with generated iCal string", async () => {
    const { __mockClient } = (await import("tsdav")) as any;

    await service.createEvent("mailbox/Work", "BEGIN:VCALENDAR\nEND:VCALENDAR");

    expect(__mockClient.createCalendarObject).toHaveBeenCalledWith(
      expect.objectContaining({
        iCalString: "BEGIN:VCALENDAR\nEND:VCALENDAR",
      }),
    );
  });
});

describe("updateEvent", () => {
  it("updates an existing calendar object by UID", async () => {
    const { __mockClient } = (await import("tsdav")) as any;
    const { parseIcsEvents } = await import("../ical.js");
    (parseIcsEvents as any).mockReturnValue([{ uid: "evt-1" }]);
    __mockClient.fetchCalendarObjects.mockResolvedValue([
      { data: "...", url: "/cal/evt-1.ics", etag: '"e1"' },
    ]);

    await service.updateEvent("mailbox/Work", "evt-1", "BEGIN:VCALENDAR\nUPDATED\nEND:VCALENDAR");

    expect(__mockClient.updateCalendarObject).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarObject: expect.objectContaining({
          url: "/cal/evt-1.ics",
          etag: '"e1"',
          data: "BEGIN:VCALENDAR\nUPDATED\nEND:VCALENDAR",
        }),
      }),
    );
  });

  it("throws CalendarError when event to update is not found", async () => {
    const { __mockClient } = (await import("tsdav")) as any;
    const { parseIcsEvents } = await import("../ical.js");
    (parseIcsEvents as any).mockReturnValue([]);
    __mockClient.fetchCalendarObjects.mockResolvedValue([]);

    await expect(
      service.updateEvent("mailbox/Work", "missing", "..."),
    ).rejects.toThrow("not found");
  });
});

describe("deleteEvent", () => {
  it("deletes a calendar object by UID", async () => {
    const { __mockClient } = (await import("tsdav")) as any;
    const { parseIcsEvents } = await import("../ical.js");
    (parseIcsEvents as any).mockReturnValue([{ uid: "evt-1" }]);
    __mockClient.fetchCalendarObjects.mockResolvedValue([
      { data: "...", url: "/cal/evt-1.ics", etag: '"e1"' },
    ]);

    await service.deleteEvent("mailbox/Work", "evt-1");

    expect(__mockClient.deleteCalendarObject).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarObject: expect.objectContaining({
          url: "/cal/evt-1.ics",
          etag: '"e1"',
        }),
      }),
    );
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/cal-mcp && npx vitest run src/__tests__/CalDavService.test.ts`
Expected: FAIL — methods not found

**Step 3: Implement getEvent, createEvent, updateEvent, deleteEvent**

Add to `CalDavService` class. Add a helper method `findCalendar` and `findCalendarObject` to DRY up calendar + object lookup:

```typescript
private async findCalendar(
  client: DAVClient,
  calendarName: string,
  providerId: string,
): Promise<any> {
  const calendars = await client.fetchCalendars();
  const calendar = calendars.find(
    (c) => (typeof c.displayName === "string" ? c.displayName : "") === calendarName,
  );
  if (!calendar) {
    throw new CalendarError(
      `Calendar "${calendarName}" not found on provider "${providerId}"`,
      ErrorCode.CALENDAR_NOT_FOUND,
    );
  }
  return calendar;
}

private async findCalendarObject(
  client: DAVClient,
  calendar: any,
  uid: string,
): Promise<{ url: string; etag?: string; data?: string }> {
  const objects = await client.fetchCalendarObjects({ calendar });
  for (const obj of objects) {
    if (!obj.data) continue;
    const events = parseIcsEvents(obj.data);
    if (events.some((e) => e.uid === uid)) {
      return obj as { url: string; etag?: string; data?: string };
    }
  }
  throw new CalendarError(`Event "${uid}" not found`, ErrorCode.EVENT_NOT_FOUND, uid);
}

async getEvent(calendarId: string, uid: string): Promise<EventFull> {
  const { account, calendarName } = this.resolveAccount(calendarId);
  const client = this.createClient(account);

  try {
    await client.login();
    const calendar = await this.findCalendar(client, calendarName, account.id);
    const obj = await this.findCalendarObject(client, calendar, uid);
    const parsed = parseIcsEvents(obj.data!);
    const event = parsed.find((e) => e.uid === uid);
    if (!event) {
      throw new CalendarError(`Event "${uid}" not found`, ErrorCode.EVENT_NOT_FOUND, uid);
    }

    return {
      uid: event.uid,
      calendarId,
      summary: event.summary,
      start: event.start,
      end: event.end,
      location: event.location,
      status: event.status,
      isRecurring: !!event.recurrenceRule,
      description: event.description,
      attendees: event.attendees,
      organizer: event.organizer,
      recurrenceRule: event.recurrenceRule,
      transparency: event.transparency,
      created: event.created,
      lastModified: event.lastModified,
    };
  } catch (error) {
    if (error instanceof CalendarError) throw error;
    throw toPimError(error instanceof Error ? error : new Error(String(error)));
  }
}

async createEvent(calendarId: string, icalString: string): Promise<void> {
  const { account, calendarName } = this.resolveAccount(calendarId);
  const client = this.createClient(account);

  try {
    await client.login();
    const calendar = await this.findCalendar(client, calendarName, account.id);
    await client.createCalendarObject({
      calendar,
      iCalString: icalString,
      filename: `${crypto.randomUUID()}.ics`,
    });
  } catch (error) {
    if (error instanceof CalendarError) throw error;
    throw toPimError(error instanceof Error ? error : new Error(String(error)));
  }
}

async updateEvent(calendarId: string, uid: string, icalString: string): Promise<void> {
  const { account, calendarName } = this.resolveAccount(calendarId);
  const client = this.createClient(account);

  try {
    await client.login();
    const calendar = await this.findCalendar(client, calendarName, account.id);
    const obj = await this.findCalendarObject(client, calendar, uid);
    await client.updateCalendarObject({
      calendarObject: {
        url: obj.url,
        etag: obj.etag,
        data: icalString,
      },
    });
  } catch (error) {
    if (error instanceof CalendarError) throw error;
    throw toPimError(error instanceof Error ? error : new Error(String(error)));
  }
}

async deleteEvent(calendarId: string, uid: string): Promise<void> {
  const { account, calendarName } = this.resolveAccount(calendarId);
  const client = this.createClient(account);

  try {
    await client.login();
    const calendar = await this.findCalendar(client, calendarName, account.id);
    const obj = await this.findCalendarObject(client, calendar, uid);
    await client.deleteCalendarObject({
      calendarObject: {
        url: obj.url,
        etag: obj.etag,
      },
    });
  } catch (error) {
    if (error instanceof CalendarError) throw error;
    throw toPimError(error instanceof Error ? error : new Error(String(error)));
  }
}
```

Add `import { randomUUID } from "node:crypto";` at top (or use `crypto.randomUUID()`).

Also refactor `listEvents` to use the shared `findCalendar` helper.

**Step 4: Run tests to verify they pass**

Run: `cd packages/cal-mcp && npx vitest run src/__tests__/CalDavService.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/cal-mcp/src/
git commit -m "feat(cal-mcp): add CalDavService CRUD operations"
```

---

### Task 7: CalDavService — findFreeSlots

**Files:**
- Modify: `packages/cal-mcp/src/services/CalDavService.ts`
- Modify: `packages/cal-mcp/src/__tests__/CalDavService.test.ts`

**Step 1: Write failing tests**

Add to `CalDavService.test.ts`:

```typescript
describe("findFreeSlots", () => {
  const mockEvents = (events: Array<{ start: string; end: string; status?: string; transparency?: string }>) => {
    const { __mockClient } = require("tsdav") as any;
    const { parseIcsEvents } = require("../ical.js") as any;

    // For each listEvents call, return these events
    __mockClient.fetchCalendarObjects.mockResolvedValue(
      events.map((e, i) => ({ data: `ics-${i}`, url: `/cal/evt-${i}.ics`, etag: `"e${i}"` })),
    );
    parseIcsEvents.mockReturnValue(
      events.map((e, i) => ({
        uid: `evt-${i}`,
        summary: `Event ${i}`,
        start: e.start,
        end: e.end,
        status: e.status || "CONFIRMED",
        transparency: e.transparency || "OPAQUE",
        recurrenceRule: undefined,
      })),
    );
  };

  it("finds free slots between events", async () => {
    const { __mockClient } = (await import("tsdav")) as any;
    const { parseIcsEvents } = (await import("../ical.js")) as any;

    __mockClient.fetchCalendarObjects.mockResolvedValue([
      { data: "ics-0", url: "/cal/evt-0.ics", etag: '"e0"' },
      { data: "ics-1", url: "/cal/evt-1.ics", etag: '"e1"' },
    ]);
    // Each object parsed returns one event
    parseIcsEvents
      .mockReturnValueOnce([{
        uid: "evt-0", summary: "Morning", start: "2026-03-10T09:00:00.000Z",
        end: "2026-03-10T10:00:00.000Z", status: "CONFIRMED", transparency: "OPAQUE",
      }])
      .mockReturnValueOnce([{
        uid: "evt-1", summary: "Afternoon", start: "2026-03-10T14:00:00.000Z",
        end: "2026-03-10T15:00:00.000Z", status: "CONFIRMED", transparency: "OPAQUE",
      }]);

    const slots = await service.findFreeSlots(
      ["mailbox/Work"],
      "2026-03-10T08:00:00Z",
      "2026-03-10T17:00:00Z",
      30,
    );

    // Free: 08:00-09:00, 10:00-14:00, 15:00-17:00 — all >= 30 min
    expect(slots.length).toBeGreaterThanOrEqual(3);
    expect(slots[0].duration).toBeGreaterThanOrEqual(30);
  });

  it("ignores transparent events (TRANSP:TRANSPARENT)", async () => {
    const { __mockClient } = (await import("tsdav")) as any;
    const { parseIcsEvents } = (await import("../ical.js")) as any;

    __mockClient.fetchCalendarObjects.mockResolvedValue([
      { data: "ics-0", url: "/cal/evt-0.ics", etag: '"e0"' },
    ]);
    parseIcsEvents.mockReturnValue([{
      uid: "evt-0", summary: "All Day Free", start: "2026-03-10T08:00:00.000Z",
      end: "2026-03-10T17:00:00.000Z", status: "CONFIRMED", transparency: "TRANSPARENT",
    }]);

    const slots = await service.findFreeSlots(
      ["mailbox/Work"],
      "2026-03-10T08:00:00Z",
      "2026-03-10T17:00:00Z",
      30,
    );

    // Transparent event doesn't block — entire range is free
    expect(slots.length).toBe(1);
    expect(slots[0].duration).toBe(540); // 9 hours
  });

  it("treats tentative as busy by default", async () => {
    const { __mockClient } = (await import("tsdav")) as any;
    const { parseIcsEvents } = (await import("../ical.js")) as any;

    __mockClient.fetchCalendarObjects.mockResolvedValue([
      { data: "ics-0", url: "/cal/evt-0.ics", etag: '"e0"' },
    ]);
    parseIcsEvents.mockReturnValue([{
      uid: "evt-0", summary: "Maybe Meeting", start: "2026-03-10T09:00:00.000Z",
      end: "2026-03-10T17:00:00.000Z", status: "TENTATIVE", transparency: "OPAQUE",
    }]);

    const slots = await service.findFreeSlots(
      ["mailbox/Work"],
      "2026-03-10T08:00:00Z",
      "2026-03-10T17:00:00Z",
      30,
    );

    // Tentative blocks by default — only 08:00-09:00 is free
    expect(slots).toHaveLength(1);
    expect(slots[0].duration).toBe(60);
  });

  it("ignores tentative events when ignore_tentative is true", async () => {
    const { __mockClient } = (await import("tsdav")) as any;
    const { parseIcsEvents } = (await import("../ical.js")) as any;

    __mockClient.fetchCalendarObjects.mockResolvedValue([
      { data: "ics-0", url: "/cal/evt-0.ics", etag: '"e0"' },
    ]);
    parseIcsEvents.mockReturnValue([{
      uid: "evt-0", summary: "Maybe Meeting", start: "2026-03-10T09:00:00.000Z",
      end: "2026-03-10T17:00:00.000Z", status: "TENTATIVE", transparency: "OPAQUE",
    }]);

    const slots = await service.findFreeSlots(
      ["mailbox/Work"],
      "2026-03-10T08:00:00Z",
      "2026-03-10T17:00:00Z",
      30,
      { ignoreTentative: true },
    );

    // Tentative ignored — entire range is free
    expect(slots).toHaveLength(1);
    expect(slots[0].duration).toBe(540);
  });

  it("sorts preferred-hours slots first", async () => {
    const { __mockClient } = (await import("tsdav")) as any;
    const { parseIcsEvents } = (await import("../ical.js")) as any;

    __mockClient.fetchCalendarObjects.mockResolvedValue([]);
    parseIcsEvents.mockReturnValue([]);

    const slots = await service.findFreeSlots(
      ["mailbox/Work"],
      "2026-03-10T06:00:00Z",
      "2026-03-10T20:00:00Z",
      30,
      { preferredStart: "09:00", preferredEnd: "17:00" },
    );

    // Should have slots, with preferred-hours slots first
    expect(slots.length).toBeGreaterThanOrEqual(1);
    // First slot should start at or after 09:00
    const firstSlotHour = new Date(slots[0].start).getUTCHours();
    expect(firstSlotHour).toBeGreaterThanOrEqual(9);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `cd packages/cal-mcp && npx vitest run src/__tests__/CalDavService.test.ts`
Expected: FAIL — `findFreeSlots` is not a function

**Step 3: Implement findFreeSlots**

Add to `CalDavService`:

```typescript
export interface FindFreeSlotsOptions {
  ignoreTentative?: boolean;
  preferredStart?: string; // "HH:MM"
  preferredEnd?: string;   // "HH:MM"
}

// In the class:
async findFreeSlots(
  calendarIds: string[],
  start: string,
  end: string,
  durationMinutes: number,
  options: FindFreeSlotsOptions = {},
): Promise<FreeSlot[]> {
  // 1. Fetch all events across specified calendars
  const allEvents: Array<{ start: string; end: string; status?: string; transparency?: string }> = [];

  for (const calendarId of calendarIds) {
    try {
      const events = await this.listEvents(calendarId, start, end);
      // Get full details for status/transparency — but listEvents already fetches parsed events
      // We need transparency info, so we need to access the raw parsed data
      const { account, calendarName } = this.resolveAccount(calendarId);
      const client = this.createClient(account);
      await client.login();
      const calendar = await this.findCalendar(client, calendarName, account.id);
      const objects = await client.fetchCalendarObjects({
        calendar,
        timeRange: { start, end },
        expand: true,
      });

      for (const obj of objects) {
        if (!obj.data) continue;
        const parsed = parseIcsEvents(obj.data);
        for (const event of parsed) {
          allEvents.push({
            start: event.start,
            end: event.end,
            status: event.status,
            transparency: event.transparency,
          });
        }
      }
    } catch (error) {
      if (error instanceof CalendarError) throw error;
      throw toPimError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  // 2. Filter events
  const busyIntervals = allEvents.filter((e) => {
    // Always skip transparent events
    if (e.transparency === "TRANSPARENT") return false;
    // Skip tentative if ignore_tentative
    if (options.ignoreTentative && e.status === "TENTATIVE") return false;
    return true;
  });

  // 3. Merge overlapping busy intervals
  const sorted = busyIntervals
    .map((e) => ({ start: new Date(e.start).getTime(), end: new Date(e.end).getTime() }))
    .sort((a, b) => a.start - b.start);

  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of sorted) {
    if (merged.length > 0 && interval.start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }

  // 4. Find gaps >= durationMinutes
  const rangeStart = new Date(start).getTime();
  const rangeEnd = new Date(end).getTime();
  const durationMs = durationMinutes * 60 * 1000;

  const freeSlots: FreeSlot[] = [];
  let cursor = rangeStart;

  for (const busy of merged) {
    if (busy.start > cursor) {
      const gapMs = busy.start - cursor;
      if (gapMs >= durationMs) {
        freeSlots.push({
          start: new Date(cursor).toISOString(),
          end: new Date(busy.start).toISOString(),
          duration: Math.round(gapMs / 60000),
        });
      }
    }
    cursor = Math.max(cursor, busy.end);
  }

  // Check final gap
  if (rangeEnd > cursor) {
    const gapMs = rangeEnd - cursor;
    if (gapMs >= durationMs) {
      freeSlots.push({
        start: new Date(cursor).toISOString(),
        end: new Date(rangeEnd).toISOString(),
        duration: Math.round(gapMs / 60000),
      });
    }
  }

  // 5. Sort by preferred hours
  if (options.preferredStart && options.preferredEnd) {
    const [prefStartH, prefStartM] = options.preferredStart.split(":").map(Number);
    const [prefEndH, prefEndM] = options.preferredEnd.split(":").map(Number);
    const prefStartMinutes = prefStartH * 60 + prefStartM;
    const prefEndMinutes = prefEndH * 60 + prefEndM;

    freeSlots.sort((a, b) => {
      const aDate = new Date(a.start);
      const bDate = new Date(b.start);
      const aMinutes = aDate.getUTCHours() * 60 + aDate.getUTCMinutes();
      const bMinutes = bDate.getUTCHours() * 60 + bDate.getUTCMinutes();
      const aInPref = aMinutes >= prefStartMinutes && aMinutes < prefEndMinutes;
      const bInPref = bMinutes >= prefStartMinutes && bMinutes < prefEndMinutes;

      if (aInPref && !bInPref) return -1;
      if (!aInPref && bInPref) return 1;
      return aDate.getTime() - bDate.getTime();
    });
  }

  return freeSlots;
}
```

**Step 4: Run tests to verify they pass**

Run: `cd packages/cal-mcp && npx vitest run src/__tests__/CalDavService.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/cal-mcp/src/
git commit -m "feat(cal-mcp): add CalDavService.findFreeSlots with tentative handling"
```

---

### Task 8: Calendar Tools — Definitions + CRUD Handler

**Files:**
- Create: `packages/cal-mcp/src/tools/calendarTools.ts`
- Create: `packages/cal-mcp/src/__tests__/calendarTools.test.ts`

**Step 1: Write failing tests**

Create `packages/cal-mcp/src/__tests__/calendarTools.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CALENDAR_TOOLS, handleCalendarTool } from "../tools/calendarTools.js";

const mockService = {
  listCalendars: vi.fn(),
  listEvents: vi.fn(),
  getEvent: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  findFreeSlots: vi.fn(),
};

describe("calendarTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports 9 tool definitions", () => {
    expect(CALENDAR_TOOLS).toHaveLength(9);
    const names = CALENDAR_TOOLS.map((t) => t.name);
    expect(names).toContain("list_calendars");
    expect(names).toContain("list_events");
    expect(names).toContain("get_event");
    expect(names).toContain("create_event");
    expect(names).toContain("update_event");
    expect(names).toContain("delete_event");
    expect(names).toContain("create_events_batch");
    expect(names).toContain("import_ics");
    expect(names).toContain("find_free_slots");
  });

  describe("handleCalendarTool", () => {
    it("handles list_calendars", async () => {
      mockService.listCalendars.mockResolvedValue([
        { calendarId: "mailbox/Work", displayName: "Work", url: "/cal/work/", providerId: "mailbox" },
      ]);

      const result = await handleCalendarTool("list_calendars", {}, mockService as any);
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text)).toHaveLength(1);
    });

    it("handles list_events", async () => {
      mockService.listEvents.mockResolvedValue([
        { uid: "evt-1", calendarId: "mailbox/Work", summary: "Meeting", start: "2026-03-10T14:00:00Z", end: "2026-03-10T15:00:00Z" },
      ]);

      const result = await handleCalendarTool("list_events", {
        calendar: "mailbox/Work",
        start: "2026-03-10T00:00:00Z",
        end: "2026-03-10T23:59:59Z",
      }, mockService as any);

      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].summary).toBe("Meeting");
    });

    it("handles get_event", async () => {
      mockService.getEvent.mockResolvedValue({
        uid: "evt-1", calendarId: "mailbox/Work", summary: "Meeting",
      });

      const result = await handleCalendarTool("get_event", {
        calendar: "mailbox/Work", uid: "evt-1",
      }, mockService as any);

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text).uid).toBe("evt-1");
    });

    it("handles create_event", async () => {
      mockService.createEvent.mockResolvedValue(undefined);

      const result = await handleCalendarTool("create_event", {
        calendar: "mailbox/Work",
        summary: "New Event",
        start: "2026-03-10T14:00:00Z",
        end: "2026-03-10T15:00:00Z",
      }, mockService as any);

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text).status).toBe("created");
    });

    it("handles delete_event", async () => {
      mockService.deleteEvent.mockResolvedValue(undefined);

      const result = await handleCalendarTool("delete_event", {
        calendar: "mailbox/Work", uid: "evt-1",
      }, mockService as any);

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content[0].text).status).toBe("deleted");
    });

    it("returns error for unknown tool", async () => {
      const result = await handleCalendarTool("unknown_tool", {}, mockService as any);
      expect(result.isError).toBe(true);
    });

    it("catches service errors and returns error response", async () => {
      mockService.listCalendars.mockRejectedValue(new Error("Connection failed"));

      const result = await handleCalendarTool("list_calendars", {}, mockService as any);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Connection failed");
    });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/cal-mcp && npx vitest run src/__tests__/calendarTools.test.ts`
Expected: FAIL — module not found

**Step 3: Implement calendarTools.ts**

Create `packages/cal-mcp/src/tools/calendarTools.ts`:

```typescript
import { toPimError } from "@miguelarios/pim-core";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { generateEventIcs, parseIcsEvents } from "../ical.js";
import type { CalDavService } from "../services/CalDavService.js";

export const CALENDAR_TOOLS: Tool[] = [
  {
    name: "list_calendars",
    description: "List all calendars across all configured CalDAV providers. Returns provider-prefixed IDs (e.g., mailbox/work).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_events",
    description: "Query events in a calendar by date range. Expands recurring events.",
    inputSchema: {
      type: "object",
      properties: {
        calendar: { type: "string", description: "Provider-prefixed calendar ID (e.g., mailbox/Work)" },
        start: { type: "string", description: "Start of date range (ISO 8601)" },
        end: { type: "string", description: "End of date range (ISO 8601)" },
      },
      required: ["calendar", "start", "end"],
    },
  },
  {
    name: "get_event",
    description: "Get full details of a single event by calendar and UID.",
    inputSchema: {
      type: "object",
      properties: {
        calendar: { type: "string", description: "Provider-prefixed calendar ID" },
        uid: { type: "string", description: "Event UID" },
      },
      required: ["calendar", "uid"],
    },
  },
  {
    name: "create_event",
    description: "Create a new calendar event.",
    inputSchema: {
      type: "object",
      properties: {
        calendar: { type: "string", description: "Provider-prefixed calendar ID" },
        summary: { type: "string", description: "Event title" },
        start: { type: "string", description: "Start time (ISO 8601)" },
        end: { type: "string", description: "End time (ISO 8601)" },
        location: { type: "string", description: "Event location" },
        description: { type: "string", description: "Event description" },
        attendees: {
          type: "array",
          items: {
            type: "object",
            properties: {
              email: { type: "string" },
              name: { type: "string" },
            },
            required: ["email"],
          },
          description: "List of attendees",
        },
      },
      required: ["calendar", "summary", "start", "end"],
    },
  },
  {
    name: "update_event",
    description: "Update an existing event. Only provided fields are changed.",
    inputSchema: {
      type: "object",
      properties: {
        calendar: { type: "string", description: "Provider-prefixed calendar ID" },
        uid: { type: "string", description: "Event UID to update" },
        summary: { type: "string", description: "New event title" },
        start: { type: "string", description: "New start time (ISO 8601)" },
        end: { type: "string", description: "New end time (ISO 8601)" },
        location: { type: "string", description: "New location" },
        description: { type: "string", description: "New description" },
        attendees: {
          type: "array",
          items: {
            type: "object",
            properties: {
              email: { type: "string" },
              name: { type: "string" },
            },
            required: ["email"],
          },
          description: "New attendee list (replaces existing)",
        },
      },
      required: ["calendar", "uid"],
    },
  },
  {
    name: "delete_event",
    description: "Delete a calendar event by UID.",
    inputSchema: {
      type: "object",
      properties: {
        calendar: { type: "string", description: "Provider-prefixed calendar ID" },
        uid: { type: "string", description: "Event UID to delete" },
      },
      required: ["calendar", "uid"],
    },
  },
  {
    name: "create_events_batch",
    description: "Create multiple events at once. Returns created event count.",
    inputSchema: {
      type: "object",
      properties: {
        calendar: { type: "string", description: "Provider-prefixed calendar ID" },
        events: {
          type: "array",
          items: {
            type: "object",
            properties: {
              summary: { type: "string" },
              start: { type: "string" },
              end: { type: "string" },
              location: { type: "string" },
              description: { type: "string" },
            },
            required: ["summary", "start", "end"],
          },
          description: "Array of events to create",
        },
      },
      required: ["calendar", "events"],
    },
  },
  {
    name: "import_ics",
    description: "Import events from iCalendar (.ics) content into a calendar.",
    inputSchema: {
      type: "object",
      properties: {
        calendar: { type: "string", description: "Provider-prefixed calendar ID" },
        icsContent: { type: "string", description: "Raw iCalendar content string" },
      },
      required: ["calendar", "icsContent"],
    },
  },
  {
    name: "find_free_slots",
    description: "Find available time slots across specified calendars. Returns free windows matching the requested duration.",
    inputSchema: {
      type: "object",
      properties: {
        calendars: {
          type: "array",
          items: { type: "string" },
          description: "Provider-prefixed calendar IDs to check availability against",
        },
        start: { type: "string", description: "Start of search range (ISO 8601)" },
        end: { type: "string", description: "End of search range (ISO 8601)" },
        duration: { type: "number", description: "Minimum slot duration in minutes" },
        preferredStart: { type: "string", description: "Preferred earliest time (HH:MM, e.g., 08:00)" },
        preferredEnd: { type: "string", description: "Preferred latest time (HH:MM, e.g., 17:00)" },
        ignore_tentative: { type: "boolean", description: "If true, tentative events don't block slots (default: false)" },
      },
      required: ["calendars", "start", "end", "duration"],
    },
  },
];

export async function handleCalendarTool(
  name: string,
  args: Record<string, unknown>,
  service: CalDavService,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    switch (name) {
      case "list_calendars": {
        const calendars = await service.listCalendars();
        return ok(JSON.stringify(calendars, null, 2));
      }

      case "list_events": {
        const events = await service.listEvents(
          args.calendar as string,
          args.start as string,
          args.end as string,
        );
        return ok(JSON.stringify(events, null, 2));
      }

      case "get_event": {
        const event = await service.getEvent(
          args.calendar as string,
          args.uid as string,
        );
        return ok(JSON.stringify(event, null, 2));
      }

      case "create_event": {
        const icsString = generateEventIcs({
          summary: args.summary as string,
          start: args.start as string,
          end: args.end as string,
          location: args.location as string | undefined,
          description: args.description as string | undefined,
          attendees: args.attendees as Array<{ email: string; name?: string }> | undefined,
        });
        await service.createEvent(args.calendar as string, icsString);
        return ok(JSON.stringify({ status: "created" }));
      }

      case "update_event": {
        // Fetch existing, merge updates, generate new iCal
        const existing = await service.getEvent(
          args.calendar as string,
          args.uid as string,
        );
        const icsString = generateEventIcs({
          summary: (args.summary as string) ?? existing.summary,
          start: (args.start as string) ?? existing.start,
          end: (args.end as string) ?? existing.end,
          location: (args.location as string) ?? existing.location,
          description: (args.description as string) ?? existing.description,
          attendees: (args.attendees as Array<{ email: string; name?: string }>) ?? existing.attendees,
        });
        await service.updateEvent(args.calendar as string, args.uid as string, icsString);
        return ok(JSON.stringify({ status: "updated", uid: args.uid }));
      }

      case "delete_event": {
        await service.deleteEvent(args.calendar as string, args.uid as string);
        return ok(JSON.stringify({ status: "deleted", uid: args.uid }));
      }

      case "create_events_batch": {
        const events = args.events as Array<{
          summary: string; start: string; end: string;
          location?: string; description?: string;
        }>;
        let created = 0;
        for (const event of events) {
          const icsString = generateEventIcs(event);
          await service.createEvent(args.calendar as string, icsString);
          created++;
        }
        return ok(JSON.stringify({ status: "created", count: created }));
      }

      case "import_ics": {
        const icsContent = args.icsContent as string;
        // Validate it has events
        const parsed = parseIcsEvents(icsContent);
        if (parsed.length === 0) {
          return error("No events found in ICS content");
        }
        // Create each event individually (each may be a separate VCALENDAR)
        // Or pass the whole content if it's a single VCALENDAR
        await service.createEvent(args.calendar as string, icsContent);
        return ok(JSON.stringify({ status: "imported", count: parsed.length }));
      }

      case "find_free_slots": {
        const slots = await service.findFreeSlots(
          args.calendars as string[],
          args.start as string,
          args.end as string,
          args.duration as number,
          {
            preferredStart: args.preferredStart as string | undefined,
            preferredEnd: args.preferredEnd as string | undefined,
            ignoreTentative: (args.ignore_tentative as boolean) ?? false,
          },
        );
        return ok(JSON.stringify(slots, null, 2));
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

Run: `cd packages/cal-mcp && npx vitest run src/__tests__/calendarTools.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/cal-mcp/src/tools/ packages/cal-mcp/src/__tests__/calendarTools.test.ts
git commit -m "feat(cal-mcp): add 9 calendar tool definitions and handler"
```

---

### Task 9: MCP Server Wiring

**Files:**
- Modify: `packages/cal-mcp/src/main.ts`
- Modify: `packages/cal-mcp/src/bin/cli.ts`

**Step 1: Implement main.ts**

Replace `packages/cal-mcp/src/main.ts`:

```typescript
import { loadCalDavConfig } from "@miguelarios/pim-core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CalDavService } from "./services/CalDavService.js";
import { CALENDAR_TOOLS, handleCalendarTool } from "./tools/calendarTools.js";

export async function createServer(): Promise<Server> {
  const config = loadCalDavConfig();
  const service = new CalDavService(config);

  const server = new Server(
    { name: "@miguelarios/cal-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: CALENDAR_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleCalendarTool(name, (args ?? {}) as Record<string, unknown>, service);
  });

  const handleShutdown = async () => {
    process.exit(0);
  };
  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);

  server.onerror = (error) => {
    console.error("[cal-mcp] Server error:", error.message);
  };

  return server;
}

export async function startServer(): Promise<void> {
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[cal-mcp] Server started on stdio");
}
```

**Step 2: Implement cli.ts**

Replace `packages/cal-mcp/src/bin/cli.ts`:

```typescript
#!/usr/bin/env node
import { startServer } from "../main.js";

startServer().catch((error) => {
  console.error("[cal-mcp] Fatal error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
```

**Step 3: Commit**

```bash
git add packages/cal-mcp/src/main.ts packages/cal-mcp/src/bin/cli.ts
git commit -m "feat(cal-mcp): wire MCP server with CalDavService and tools"
```

---

### Task 10: Build Verification + Format + Final Commit

**Step 1: Run typecheck**

Run: `npx turbo run typecheck --force`
Expected: All 4 packages pass. Fix any type issues (likely `node-ical` types — create shim if needed).

**Step 2: Run all tests**

Run: `npm test`
Expected: All tests pass. Core tests (existing) + cal-mcp tests (new) + card-mcp tests + email-mcp tests.

**Step 3: Run lint and format**

Run: `npm run format && npm run lint`
Expected: Clean. Fix any Biome issues.

**Step 4: Run build**

Run: `npx turbo run build --force`
Expected: All packages build successfully.

**Step 5: Verify cal-mcp test count**

Run: `cd packages/cal-mcp && npx vitest run`
Expected: ~30-40 tests across 3 test files (ical.test.ts, CalDavService.test.ts, calendarTools.test.ts).

**Step 6: Final commit if any formatting changes**

```bash
git add -A
git commit -m "style: apply biome formatting to cal-mcp"
```

---

## Summary

| Task | What | Tests |
|------|------|-------|
| 1 | Package scaffolding | — |
| 2 | Core: CalDavConfig + CalendarError | ~6 config + 1 error |
| 3 | iCal helpers (parse + generate) | ~7 |
| 4 | CalDavService: constructor + listCalendars | ~3 |
| 5 | CalDavService: listEvents | ~2 |
| 6 | CalDavService: CRUD (get/create/update/delete) | ~5 |
| 7 | CalDavService: findFreeSlots | ~5 |
| 8 | Calendar tools: definitions + handler | ~8 |
| 9 | MCP server wiring | — |
| 10 | Build verification + format | — |

**Estimated total: ~37 new tests, ~115 total across all packages.**
