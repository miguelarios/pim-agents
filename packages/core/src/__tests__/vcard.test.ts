import { describe, expect, it } from "vitest";
import { type Contact, buildVCard, parseVCard } from "../vcard.js";

const SAMPLE_VCARD = `BEGIN:VCARD
VERSION:3.0
UID:abc-123
FN:John Doe
N:Doe;John;;;
EMAIL;TYPE=HOME:john@example.com
EMAIL;TYPE=WORK:john@work.com
TEL;TYPE=CELL:+1-555-123-4567
TEL;TYPE=HOME:+1-555-999-8888
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
    expect(contact.emails).toEqual(["john@example.com", "john@work.com"]);
    expect(contact.phones).toEqual(["+1-555-123-4567", "+1-555-999-8888"]);
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

  it("handles vCard 4.0", () => {
    const v4 = `BEGIN:VCARD\nVERSION:4.0\nUID:v4-1\nFN:V4 Person\nEMAIL:v4@test.com\nEND:VCARD`;
    const contact = parseVCard(v4);
    expect(contact.uid).toBe("v4-1");
    expect(contact.fullName).toBe("V4 Person");
    expect(contact.emails).toEqual(["v4@test.com"]);
  });
});

describe("buildVCard", () => {
  it("builds a valid vCard 3.0 string from a Contact", () => {
    const contact: Contact = {
      uid: "new-1",
      fullName: "Jane Smith",
      firstName: "Jane",
      lastName: "Smith",
      emails: ["jane@example.com"],
      phones: ["+1-555-000-1111"],
      organization: "Widgets Co",
      title: "Manager",
      note: "A note",
    };
    const vcard = buildVCard(contact);
    expect(vcard).toContain("BEGIN:VCARD");
    expect(vcard).toContain("VERSION:3.0");
    expect(vcard).toContain("UID:new-1");
    expect(vcard).toContain("FN:Jane Smith");
    expect(vcard).toContain("N:Smith;Jane;;;");
    expect(vcard).toContain("EMAIL:jane@example.com");
    expect(vcard).toContain("TEL:+1-555-000-1111");
    expect(vcard).toContain("ORG:Widgets Co");
    expect(vcard).toContain("TITLE:Manager");
    expect(vcard).toContain("NOTE:A note");
    expect(vcard).toContain("END:VCARD");
  });

  it("builds vCard with only required fields", () => {
    const contact: Contact = {
      uid: "min-1",
      fullName: "Minimal",
      emails: [],
      phones: [],
    };
    const vcard = buildVCard(contact);
    expect(vcard).toContain("FN:Minimal");
    expect(vcard).not.toContain("EMAIL");
    expect(vcard).not.toContain("TEL");
    expect(vcard).not.toContain("ORG");
  });
});
