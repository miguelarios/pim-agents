import { describe, expect, it } from "vitest";
import { type Contact, buildVCard, normalizeType, parseVCard } from "../vcard.js";

const SAMPLE_VCARD = `BEGIN:VCARD
VERSION:3.0
UID:abc-123
FN:John Doe
N:Doe;John;;;
EMAIL;TYPE=HOME:john@example.com
EMAIL;TYPE=WORK:john@work.com
TEL;TYPE=CELL:+1-555-0100
TEL;TYPE=HOME:+1-555-0100
ORG:ACME Inc
TITLE:Developer
NOTE:Met at conference
END:VCARD`;

describe("parseVCard", () => {
  it("parses a full vCard into a Contact object", () => {
    const contact = parseVCard(SAMPLE_VCARD);
    expect(contact.uid).toBe("abc-123");
    expect(contact.fullName).toBe("John Doe");
    expect(contact.lastName).toBe("Doe");
    expect(contact.firstName).toBe("John");
    expect(contact.emails).toEqual([
      { type: "home", value: "john@example.com" },
      { type: "work", value: "john@work.com" },
    ]);
    expect(contact.phones).toEqual([
      { type: "cell", value: "+1-555-0100" },
      { type: "home", value: "+1-555-0100" },
    ]);
    expect(contact.organization).toBe("ACME Inc");
    expect(contact.title).toBe("Developer");
    expect(contact.note).toBe("Met at conference");
  });

  it("handles minimal vCard with only UID and FN", () => {
    const minimal = `BEGIN:VCARD\nVERSION:3.0\nUID:min-1\nFN:Jane\nEND:VCARD`;
    const contact = parseVCard(minimal);
    expect(contact.uid).toBe("min-1");
    expect(contact.fullName).toBe("Jane");
    expect(contact.emails).toEqual([]);
    expect(contact.phones).toEqual([]);
  });

  it("extracts TYPE parameter from email/phone/url lines", () => {
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nUID:t1\nFN:Test\nEMAIL;TYPE=WORK:work@test.com\nEMAIL:plain@test.com\nTEL;TYPE=CELL:+1-555-0100\nTEL;TYPE=WORK;TYPE=VOICE:+1-555-0100\nURL;TYPE=home:https://example.com\nURL:https://other.com\nEND:VCARD`;
    const contact = parseVCard(vcard);
    expect(contact.emails).toEqual([
      { type: "work", value: "work@test.com" },
      { value: "plain@test.com" },
    ]);
    expect(contact.phones).toEqual([
      { type: "cell", value: "+1-555-0100" },
      { type: "work", value: "+1-555-0100" },
    ]);
    expect(contact.urls).toEqual([
      { type: "home", value: "https://example.com" },
      { value: "https://other.com" },
    ]);
  });

  it("parses ADR lines into PostalAddress objects", () => {
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nUID:a1\nFN:Addr Test\nADR;TYPE=home:;;123 Main St;Denver;CO;80202;US\nADR;TYPE=work:PO Box 100;Suite 2;456 Oak Ave;Austin;TX;73301;US\nEND:VCARD`;
    const contact = parseVCard(vcard);
    expect(contact.addresses).toEqual([
      {
        type: "home",
        street: "123 Main St",
        city: "Denver",
        state: "CO",
        postalCode: "80202",
        country: "US",
      },
      {
        type: "work",
        street: "PO Box 100, Suite 2, 456 Oak Ave",
        city: "Austin",
        state: "TX",
        postalCode: "73301",
        country: "US",
      },
    ]);
  });

  it("handles ADR with empty components", () => {
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nUID:a2\nFN:Minimal Addr\nADR:;;;;;;US\nEND:VCARD`;
    const contact = parseVCard(vcard);
    expect(contact.addresses).toEqual([{ country: "US" }]);
  });

  it("handles vCard 4.0", () => {
    const v4 = `BEGIN:VCARD\nVERSION:4.0\nUID:v4-1\nFN:V4 Person\nEMAIL:v4@test.com\nEND:VCARD`;
    const contact = parseVCard(v4);
    expect(contact.uid).toBe("v4-1");
    expect(contact.fullName).toBe("V4 Person");
    expect(contact.emails).toEqual([{ value: "v4@test.com" }]);
  });

  it("extracts ORG first component only, stripping trailing semicolons", () => {
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nUID:o1\nFN:Org Test\nORG:Acme Corp;Engineering;Platform\nEND:VCARD`;
    const contact = parseVCard(vcard);
    expect(contact.organization).toBe("Acme Corp");
  });

  it("parses ROLE, NICKNAME, BDAY, and CATEGORIES", () => {
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nUID:f1\nFN:Fields Test\nROLE:Project Lead\nNICKNAME:Johnny\nBDAY:1990-01-01\nCATEGORIES:Friends,Family,VIP\nEND:VCARD`;
    const contact = parseVCard(vcard);
    expect(contact.role).toBe("Project Lead");
    expect(contact.nickname).toBe("Johnny");
    expect(contact.birthday).toBe("1990-01-01");
    expect(contact.categories).toEqual(["Friends", "Family", "VIP"]);
  });

  it("extracts BDAY as-is without normalizing format", () => {
    const compact = `BEGIN:VCARD\nVERSION:3.0\nUID:b1\nFN:Compact\nBDAY:19900101\nEND:VCARD`;
    expect(parseVCard(compact).birthday).toBe("19900101");
    const partial = `BEGIN:VCARD\nVERSION:3.0\nUID:b2\nFN:Partial\nBDAY:--01-01\nEND:VCARD`;
    expect(parseVCard(partial).birthday).toBe("--01-01");
  });

  it("captures unknown properties in otherProperties", () => {
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nUID:r1\nFN:Raw Test\nX-CUSTOM-PROP:weird\nX-ANOTHER:value\nEND:VCARD`;
    const contact = parseVCard(vcard);
    expect(contact.otherProperties).toEqual(["X-CUSTOM-PROP:weird", "X-ANOTHER:value"]);
  });

  it("round-trips otherProperties through build and parse", () => {
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nUID:rt1\nFN:Roundtrip\nX-CUSTOM:hello\nEND:VCARD`;
    const contact = parseVCard(vcard);
    const rebuilt = buildVCard(contact);
    const reparsed = parseVCard(rebuilt);
    expect(reparsed.otherProperties).toEqual(contact.otherProperties);
    expect(reparsed.uid).toBe("rt1");
    expect(reparsed.fullName).toBe("Roundtrip");
  });
});

describe("buildVCard", () => {
  it("builds a valid vCard 3.0 string from a Contact", () => {
    const contact: Contact = {
      uid: "new-1",
      fullName: "Jane Smith",
      firstName: "Jane",
      lastName: "Smith",
      emails: [{ value: "jane@example.com" }],
      phones: [{ value: "+1-555-0100" }],
      addresses: [],
      urls: [],
      organization: "Widgets Co",
      title: "Manager",
      note: "A note",
      otherProperties: [],
    };
    const vcard = buildVCard(contact);
    expect(vcard).toContain("BEGIN:VCARD");
    expect(vcard).toContain("VERSION:3.0");
    expect(vcard).toContain("UID:new-1");
    expect(vcard).toContain("FN:Jane Smith");
    expect(vcard).toContain("N:Smith;Jane;;;");
    expect(vcard).toContain("EMAIL:jane@example.com");
    expect(vcard).toContain("TEL:+1-555-0100");
    expect(vcard).toContain("ORG:Widgets Co");
    expect(vcard).toContain("TITLE:Manager");
    expect(vcard).toContain("NOTE:A note");
    expect(vcard).toContain("END:VCARD");
  });

  it("builds typed EMAIL/TEL/URL lines with TYPE parameter", () => {
    const contact: Contact = {
      uid: "tb1",
      fullName: "Type Build",
      emails: [{ type: "work", value: "work@test.com" }, { value: "plain@test.com" }],
      phones: [{ type: "cell", value: "+1-555-0100" }],
      addresses: [],
      urls: [{ type: "home", value: "https://example.com" }],
      otherProperties: [],
    };
    const vcard = buildVCard(contact);
    expect(vcard).toContain("EMAIL;TYPE=work:work@test.com");
    expect(vcard).toContain("EMAIL:plain@test.com");
    expect(vcard).toContain("TEL;TYPE=cell:+1-555-0100");
    expect(vcard).toContain("URL;TYPE=home:https://example.com");
  });

  it("builds ADR lines from PostalAddress objects", () => {
    const contact: Contact = {
      uid: "ab1",
      fullName: "Addr Build",
      emails: [],
      phones: [],
      addresses: [
        {
          type: "home",
          street: "123 Main St",
          city: "Denver",
          state: "CO",
          postalCode: "80202",
          country: "US",
        },
      ],
      urls: [],
      otherProperties: [],
    };
    const vcard = buildVCard(contact);
    expect(vcard).toContain("ADR;TYPE=home:;;123 Main St;Denver;CO;80202;US");
  });

  it("builds ROLE, NICKNAME, BDAY, and CATEGORIES lines", () => {
    const contact: Contact = {
      uid: "sf1",
      fullName: "Simple Fields",
      emails: [],
      phones: [],
      addresses: [],
      urls: [],
      role: "Project Lead",
      nickname: "Johnny",
      birthday: "1990-01-01",
      categories: ["Friends", "Family"],
      otherProperties: [],
    };
    const vcard = buildVCard(contact);
    expect(vcard).toContain("ROLE:Project Lead");
    expect(vcard).toContain("NICKNAME:Johnny");
    expect(vcard).toContain("BDAY:1990-01-01");
    expect(vcard).toContain("CATEGORIES:Friends,Family");
  });

  it("builds vCard with only required fields", () => {
    const contact: Contact = {
      uid: "min-1",
      fullName: "Minimal",
      emails: [],
      phones: [],
      addresses: [],
      urls: [],
      otherProperties: [],
    };
    const vcard = buildVCard(contact);
    expect(vcard).toContain("FN:Minimal");
    expect(vcard).not.toContain("EMAIL");
    expect(vcard).not.toContain("TEL");
    expect(vcard).not.toContain("ORG");
  });
});

describe("buildVCard ORG line", () => {
  const base: Contact = {
    uid: "o1",
    fullName: "X",
    emails: [],
    phones: [],
    addresses: [],
    urls: [],
    otherProperties: [],
  };

  it("writes ORG with an empty first component when only orgUnits are set", () => {
    const built = buildVCard({ ...base, orgUnits: ["Engineering", "Platform"] });
    expect(built).toContain("ORG:;Engineering;Platform");
    expect(parseVCard(built).orgUnits).toEqual(["Engineering", "Platform"]);
    expect(parseVCard(built).organization).toBeUndefined();
  });

  it("writes no ORG line when neither is set", () => {
    expect(buildVCard(base)).not.toContain("ORG:");
  });
});

describe("buildVCard round-trip", () => {
  it("preserves socialProfiles through parse -> build -> parse", () => {
    const original = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "UID:test-rt",
      "FN:Patrick",
      "X-SOCIALPROFILE;type=Instagram;x-user=example_user:x-apple:example_user",
      "X-SOCIALPROFILE;type=twitter;x-user=testhandle:http://twitter.com/testhandle",
      "END:VCARD",
    ].join("\r\n");
    const first = parseVCard(original);
    const rebuilt = buildVCard(first);
    const second = parseVCard(rebuilt);
    expect(second.socialProfiles).toEqual(first.socialProfiles);
  });

  it("serializes socialProfiles with handle and url when present", () => {
    const contact = {
      uid: "u",
      fullName: "X",
      emails: [],
      phones: [],
      addresses: [],
      urls: [],
      otherProperties: [],
      socialProfiles: [
        { type: "twitter", handle: "a", url: "https://twitter.com/a" },
        { type: "instagram", handle: "b" },
      ],
    };
    const built = buildVCard(contact as any);
    expect(built).toContain("X-SOCIALPROFILE;type=twitter;x-user=a:https://twitter.com/a");
    expect(built).toContain("X-SOCIALPROFILE;type=instagram;x-user=b:x-apple:b");
  });
});

describe("normalizeType", () => {
  it("drops internet/voice/pref noise tokens", () => {
    expect(normalizeType("internet,work,pref")).toBe("work");
    expect(normalizeType("cell,voice,pref")).toBe("cell");
    expect(normalizeType("internet,home")).toBe("home");
  });

  it("strips surrounding double quotes from TYPE values", () => {
    expect(normalizeType('"internet')).toBe(undefined); // noise-only after strip
    expect(normalizeType('"work"')).toBe("work");
    expect(normalizeType('"internet","work"')).toBe("work");
  });

  it("joins multiple meaningful tokens with /", () => {
    expect(normalizeType("home,fax")).toBe("home/fax");
    expect(normalizeType("work,cell")).toBe("work/cell");
  });

  it("lowercases input tokens", () => {
    expect(normalizeType("HOME")).toBe("home");
    expect(normalizeType("Work,CELL")).toBe("work/cell");
  });

  it("returns undefined when empty or only noise", () => {
    expect(normalizeType("")).toBe(undefined);
    expect(normalizeType("internet,pref,voice")).toBe(undefined);
    expect(normalizeType(undefined)).toBe(undefined);
  });

  it("handles semicolon-separated input", () => {
    expect(normalizeType("home;fax")).toBe("home/fax");
  });
});

describe("parseVCard with iOS itemN groups", () => {
  it("parses item1.ADR into addresses[]", () => {
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "UID:test-1",
      "FN:Patrick Wilson",
      "item1.ADR;type=HOME;type=pref:;;789 Pine Rd;Anytown;ST;00000;United States",
      "item1.X-ABADR:us",
      "END:VCARD",
    ].join("\r\n");
    const contact = parseVCard(vcard);
    expect(contact.addresses).toHaveLength(1);
    expect(contact.addresses[0]).toMatchObject({
      type: "home",
      street: "789 Pine Rd",
      city: "Anytown",
      state: "ST",
      postalCode: "00000",
      country: "United States",
    });
  });

  it("parses itemN.EMAIL and itemN.TEL with clean types", () => {
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "UID:test-2",
      "FN:Patrick Wilson",
      "item2.EMAIL;type=INTERNET;type=work;type=pref:alice@example.com",
      "item3.TEL;type=CELL;type=VOICE;type=pref:+1-555-0100",
      "END:VCARD",
    ].join("\r\n");
    const contact = parseVCard(vcard);
    expect(contact.emails).toEqual([{ type: "work", value: "alice@example.com" }]);
    expect(contact.phones).toEqual([{ type: "cell", value: "+1-555-0100" }]);
  });

  it("parses itemN.URL", () => {
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "UID:test-3",
      "FN:X",
      "item1.URL;type=WORK:https://example.com",
      "END:VCARD",
    ].join("\r\n");
    const contact = parseVCard(vcard);
    expect(contact.urls).toEqual([{ type: "work", value: "https://example.com" }]);
  });
});

describe("parseVCard X-ABLabel resolution", () => {
  it("decodes _$!<HomePage>!$_ wrapped label for URL type", () => {
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "UID:test-1",
      "FN:X",
      "item1.URL;type=pref:https://example.com",
      "item1.X-ABLabel:_$!<HomePage>!$_",
      "END:VCARD",
    ].join("\r\n");
    const contact = parseVCard(vcard);
    expect(contact.urls).toEqual([{ type: "homepage", value: "https://example.com" }]);
  });

  it("uses raw X-ABLabel when no wrapper syntax", () => {
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "UID:test-2",
      "FN:X",
      "item1.TEL;type=voice:+1-555-0100",
      "item1.X-ABLabel:School",
      "END:VCARD",
    ].join("\r\n");
    const contact = parseVCard(vcard);
    expect(contact.phones).toEqual([{ type: "school", value: "+1-555-0100" }]);
  });

  it("falls through to normalized TYPE when X-ABLabel absent", () => {
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "UID:test-3",
      "FN:X",
      "item1.EMAIL;type=INTERNET;type=HOME:foo@bar.com",
      "END:VCARD",
    ].join("\r\n");
    const contact = parseVCard(vcard);
    expect(contact.emails).toEqual([{ type: "home", value: "foo@bar.com" }]);
  });

  it("falls back to TYPE when X-ABLabel is empty", () => {
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "UID:test-4",
      "FN:X",
      "item1.EMAIL;type=WORK:a@b.com",
      "item1.X-ABLabel:",
      "END:VCARD",
    ].join("\r\n");
    const contact = parseVCard(vcard);
    expect(contact.emails).toEqual([{ type: "work", value: "a@b.com" }]);
  });
});

describe("parseVCard X-SOCIALPROFILE", () => {
  it("parses Instagram entry with x-user handle and x-apple URL (drops URL)", () => {
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "UID:test-1",
      "FN:X",
      "X-SOCIALPROFILE;type=Instagram;x-user=example_user:x-apple:example_user",
      "END:VCARD",
    ].join("\r\n");
    const contact = parseVCard(vcard);
    expect(contact.socialProfiles).toEqual([{ type: "instagram", handle: "example_user" }]);
  });

  it("keeps URL when value is http(s)", () => {
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "UID:test-2",
      "FN:X",
      "X-SOCIALPROFILE;type=twitter;x-user=testhandle:http://twitter.com/testhandle",
      "END:VCARD",
    ].join("\r\n");
    const contact = parseVCard(vcard);
    expect(contact.socialProfiles).toEqual([
      { type: "twitter", handle: "testhandle", url: "http://twitter.com/testhandle" },
    ]);
  });

  it("handles multiple social profiles and preserves order", () => {
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "UID:test-3",
      "FN:X",
      "X-SOCIALPROFILE;type=Instagram;x-user=foo:x-apple:foo",
      "X-SOCIALPROFILE;type=LinkedIn;x-user=bar:https://linkedin.com/in/bar",
      "END:VCARD",
    ].join("\r\n");
    const contact = parseVCard(vcard);
    expect(contact.socialProfiles).toHaveLength(2);
    expect(contact.socialProfiles?.[0].type).toBe("instagram");
    expect(contact.socialProfiles?.[1].type).toBe("linkedin");
    expect(contact.socialProfiles?.[1].url).toBe("https://linkedin.com/in/bar");
  });
});

describe("parseVCard Apple internals filtering", () => {
  it("strips photo, prodid, rev, and other Apple internals from otherProperties", () => {
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "UID:test-1",
      "FN:X",
      "PRODID:-//Apple Inc.//iOS 26.0//EN",
      "REV:2024-09-16T22:05:13Z",
      "PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQAASABIAAD",
      "X-IMAGETYPE:PHOTO",
      "X-IMAGEHASH:+t54yzQVDfamrN6MVyxA7A==",
      "X-SHARED-PHOTO-DISPLAY-PREF:AUTOUPDATE",
      "item1.X-ADDRESSING-GRAMMAR:encryptedbase64blob==",
      "item1.X-ABADR:us",
      "X-UNKNOWN-CUSTOM:preserve-me",
      "END:VCARD",
    ].join("\r\n");
    const contact = parseVCard(vcard);
    const joined = contact.otherProperties.join("|");
    expect(joined).not.toContain("PRODID");
    expect(joined).not.toContain("REV:");
    expect(joined).not.toContain("PHOTO;");
    expect(joined).not.toContain("X-IMAGETYPE");
    expect(joined).not.toContain("X-IMAGEHASH");
    expect(joined).not.toContain("X-SHARED-PHOTO-DISPLAY-PREF");
    expect(joined).not.toContain("X-ADDRESSING-GRAMMAR");
    expect(joined).not.toContain("X-ABADR");
    expect(joined).toContain("X-UNKNOWN-CUSTOM");
  });
});

describe("parseVCard iOS golden (Patrick-shaped)", () => {
  it("matches the iOS Contacts phone view 1:1", () => {
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "PRODID:-//Apple Inc.//iOS 26.0//EN",
      "N:Wilson;Patrick;;;",
      "FN:Patrick Wilson",
      "NICKNAME:Alice",
      "item2.EMAIL;type=INTERNET;type=WORK;type=pref:alice@example.com",
      "item3.EMAIL;type=INTERNET;type=HOME:alice@example.com",
      "item4.TEL;type=CELL;type=VOICE;type=pref:+1-555-0100",
      "item5.TEL;type=WORK;type=VOICE:+1-555-0100",
      "item1.ADR;type=HOME;type=pref:;;789 Pine Rd;Anytown;ST;00000;United States",
      "item1.X-ABADR:us",
      "BDAY:1990-01-01",
      "NOTE:TI Intern\\nGoing out friend\\nDallas\\nFriends\\n",
      "X-SOCIALPROFILE;type=Instagram;x-user=example_user:x-apple:example_user",
      "X-SOCIALPROFILE;type=twitter;x-user=testhandle:http://twitter.com/testhandle",
      "PHOTO;ENCODING=b;TYPE=JPEG:fakebase64photodata",
      "REV:2024-09-16T22:05:13Z",
      "X-IMAGETYPE:PHOTO",
      "X-IMAGEHASH:+t54yzQVDfamrN6MVyxA7A==",
      "X-SHARED-PHOTO-DISPLAY-PREF:AUTOUPDATE",
      "UID:00000000-0000-0000-0000-000000000001",
      "END:VCARD",
    ].join("\r\n");

    const contact = parseVCard(vcard);

    expect(contact).toMatchObject({
      uid: "00000000-0000-0000-0000-000000000001",
      fullName: "Patrick Wilson",
      firstName: "Patrick",
      lastName: "Wilson",
      nickname: "Alice",
      emails: [
        { type: "work", value: "alice@example.com" },
        { type: "home", value: "alice@example.com" },
      ],
      phones: [
        { type: "cell", value: "+1-555-0100" },
        { type: "work", value: "+1-555-0100" },
      ],
      addresses: [
        {
          type: "home",
          street: "789 Pine Rd",
          city: "Anytown",
          state: "ST",
          postalCode: "00000",
          country: "United States",
        },
      ],
      birthday: "1990-01-01",
      socialProfiles: [
        { type: "instagram", handle: "example_user" },
        { type: "twitter", handle: "testhandle", url: "http://twitter.com/testhandle" },
      ],
    });
    expect(contact.note).toBe("TI Intern\nGoing out friend\nDallas\nFriends\n");
    const op = contact.otherProperties.join("|");
    expect(op).not.toContain("PRODID");
    expect(op).not.toContain("REV:");
    expect(op).not.toContain("PHOTO");
    expect(op).not.toContain("X-IMAGETYPE");
    expect(op).not.toContain("X-IMAGEHASH");
    expect(op).not.toContain("X-SHARED-PHOTO-DISPLAY-PREF");
    expect(op).not.toContain("X-ABADR");
  });
});

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

  it("round-trips an ORG name containing a comma without a stray backslash", () => {
    const built = buildVCard({
      uid: "esc-org-1",
      fullName: "Alice Smith",
      emails: [],
      phones: [],
      addresses: [],
      urls: [],
      organization: "Doe, Inc",
      otherProperties: [],
    });
    expect(parseVCard(built).organization).toBe("Doe, Inc");
  });

  it("round-trips the first ORG component when the org name contains a semicolon", () => {
    const built = buildVCard({
      uid: "esc-org-2",
      fullName: "Alice Smith",
      emails: [],
      phones: [],
      addresses: [],
      urls: [],
      organization: "Acme; Holdings",
      otherProperties: [],
    });
    expect(parseVCard(built).organization).toBe("Acme; Holdings");
  });
});

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

describe("parseVCard contact groups", () => {
  it("parses a vCard 4.0 KIND:group with MEMBER urns", () => {
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "UID:g1",
      "FN:Book Club",
      "KIND:group",
      "MEMBER:urn:uuid:aaa",
      "MEMBER:urn:uuid:bbb",
      "END:VCARD",
    ].join("\r\n");
    const c = parseVCard(vcard);
    expect(c.kind).toBe("group");
    expect(c.members).toEqual(["aaa", "bbb"]);
    expect(c.otherProperties).toEqual([]);
  });

  it("parses the Apple vCard 3.0 X-ADDRESSBOOKSERVER form", () => {
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "UID:g2",
      "FN:Family",
      "N:Family;;;;",
      "X-ADDRESSBOOKSERVER-KIND:group",
      "X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:ccc",
      "END:VCARD",
    ].join("\r\n");
    const c = parseVCard(vcard);
    expect(c.kind).toBe("group");
    expect(c.members).toEqual(["ccc"]);
    expect(c.otherProperties).toEqual([]);
  });

  it("dedupes urn members case-insensitively, keeping the first spelling", () => {
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "UID:g5",
      "FN:Case",
      "KIND:group",
      "MEMBER:urn:uuid:ABC-1",
      "X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:abc-1",
      "X-ADDRESSBOOKSERVER-MEMBER:mailto:X@y.z",
      "X-ADDRESSBOOKSERVER-MEMBER:mailto:x@y.z",
      "END:VCARD",
    ].join("\r\n");
    // Only urns are case-insensitive; a mailto: is kept as written.
    expect(parseVCard(vcard).members).toEqual(["ABC-1", "mailto:X@y.z", "mailto:x@y.z"]);
  });

  it("keeps a non-group KIND raw so it survives a round trip", () => {
    for (const kindLine of ["KIND:org", "KIND:individual", "X-ADDRESSBOOKSERVER-KIND:location"]) {
      const c = parseVCard(`BEGIN:VCARD\nVERSION:4.0\nUID:k1\nFN:Acme\n${kindLine}\nEND:VCARD`);
      expect(c.kind, kindLine).toBeUndefined();
      expect(c.otherProperties, kindLine).toEqual([kindLine]);
      expect(buildVCard(c), kindLine).toContain(`\r\n${kindLine}\r\n`);
    }
  });

  it("keeps MEMBER lines on a non-group raw rather than parsing them", () => {
    const c = parseVCard(
      "BEGIN:VCARD\nVERSION:4.0\nUID:k2\nFN:Odd\nMEMBER:urn:uuid:aaa\nEND:VCARD",
    );
    expect(c.members).toBeUndefined();
    expect(c.otherProperties).toEqual(["MEMBER:urn:uuid:aaa"]);
    expect(buildVCard(c)).toContain("MEMBER:urn:uuid:aaa");
  });

  it("dedupes members when a card carries both forms", () => {
    const vcard = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "UID:g4",
      "FN:Both",
      "KIND:group",
      "MEMBER:urn:uuid:aaa",
      "X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:aaa",
      "X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:bbb",
      "END:VCARD",
    ].join("\r\n");
    expect(parseVCard(vcard).members).toEqual(["aaa", "bbb"]);
  });

  it("leaves kind and members unset on an individual", () => {
    const c = parseVCard("BEGIN:VCARD\nVERSION:3.0\nUID:i1\nFN:Jane\nEND:VCARD");
    expect(c.kind).toBeUndefined();
    expect(c.members).toBeUndefined();
  });

  it("keeps a member without a urn:uuid prefix verbatim", () => {
    const c = parseVCard(
      "BEGIN:VCARD\nVERSION:3.0\nUID:g3\nFN:G\nX-ADDRESSBOOKSERVER-KIND:group\nX-ADDRESSBOOKSERVER-MEMBER:mailto:x@y.z\nEND:VCARD",
    );
    expect(c.members).toEqual(["mailto:x@y.z"]);
  });
});

describe("buildVCard contact groups", () => {
  const group: Contact = {
    uid: "g1",
    fullName: "Book Club",
    kind: "group",
    members: ["aaa", "bbb"],
    emails: [],
    phones: [],
    addresses: [],
    urls: [],
    otherProperties: [],
  };

  it("writes the vCard 3.0 Apple form, one MEMBER line per UID", () => {
    const built = buildVCard(group);
    expect(built).toContain("X-ADDRESSBOOKSERVER-KIND:group");
    expect(built).toContain("X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:aaa");
    expect(built).toContain("X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:bbb");
    expect(built).not.toMatch(/^KIND:/m);
  });

  it("round-trips through parse", () => {
    const again = parseVCard(buildVCard(group));
    expect(again.kind).toBe("group");
    expect(again.members).toEqual(["aaa", "bbb"]);
  });

  it("writes no group lines for an individual", () => {
    const built = buildVCard({ ...group, kind: undefined, members: undefined });
    expect(built).not.toContain("ADDRESSBOOKSERVER");
  });

  it("escapes member values on write and unescapes them on read", () => {
    const built = buildVCard({ ...group, members: ["odd;uid\nline", "mailto:a,b@x.y"] });
    expect(built).toContain("X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:odd\\;uid\\nline");
    expect(built).toContain("X-ADDRESSBOOKSERVER-MEMBER:mailto:a\\,b@x.y");
    expect(
      built.split("\r\n").filter((l) => l.startsWith("X-ADDRESSBOOKSERVER-MEMBER")),
    ).toHaveLength(2);
    expect(parseVCard(built).members).toEqual(["odd;uid\nline", "mailto:a,b@x.y"]);
  });

  it("does not prefix a member that already carries a scheme", () => {
    const built = buildVCard({ ...group, members: ["mailto:x@y.z", "urn:uuid:ddd"] });
    expect(built).toContain("X-ADDRESSBOOKSERVER-MEMBER:mailto:x@y.z");
    expect(built).toContain("X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:ddd");
    expect(built).not.toContain("urn:uuid:urn:uuid");
  });
});
