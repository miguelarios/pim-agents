export interface Contact {
  uid: string;
  fullName: string;
  firstName?: string;
  lastName?: string;
  emails: string[];
  phones: string[];
  organization?: string;
  title?: string;
  note?: string;
}

export function parseVCard(data: string): Contact {
  const lines = unfoldLines(data);

  const uid = extractFirst(lines, "UID") ?? "";
  const fullName = extractFirst(lines, "FN") ?? "";
  const n = extractFirst(lines, "N");
  const emails = extractAll(lines, "EMAIL");
  const phones = extractAll(lines, "TEL");
  const organization = extractFirst(lines, "ORG");
  const title = extractFirst(lines, "TITLE");
  const note = extractFirst(lines, "NOTE");

  let firstName: string | undefined;
  let lastName: string | undefined;
  if (n) {
    const parts = n.split(";");
    lastName = parts[0] || undefined;
    firstName = parts[1] || undefined;
  }

  return { uid, fullName, firstName, lastName, emails, phones, organization, title, note };
}

export function buildVCard(contact: Contact): string {
  const lines: string[] = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `UID:${contact.uid}`,
    `FN:${contact.fullName}`,
  ];

  if (contact.lastName || contact.firstName) {
    lines.push(`N:${contact.lastName ?? ""};${contact.firstName ?? ""};;;`);
  }

  for (const email of contact.emails) {
    lines.push(`EMAIL:${email}`);
  }
  for (const phone of contact.phones) {
    lines.push(`TEL:${phone}`);
  }
  if (contact.organization) {
    lines.push(`ORG:${contact.organization}`);
  }
  if (contact.title) {
    lines.push(`TITLE:${contact.title}`);
  }
  if (contact.note) {
    lines.push(`NOTE:${contact.note}`);
  }

  lines.push("END:VCARD");
  return lines.join("\r\n");
}

/** Unfold continuation lines per RFC 6350 */
function unfoldLines(data: string): string[] {
  return data.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
}

/** Extract first matching property value (ignoring parameters like ;TYPE=HOME) */
function extractFirst(lines: string[], property: string): string | undefined {
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.startsWith(`${property}:`) || upper.startsWith(`${property};`)) {
      const colonIndex = line.indexOf(":");
      if (colonIndex !== -1) {
        return line.slice(colonIndex + 1).trim();
      }
    }
  }
  return undefined;
}

/** Extract all values for a property (e.g., multiple EMAIL lines) */
function extractAll(lines: string[], property: string): string[] {
  const results: string[] = [];
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.startsWith(`${property}:`) || upper.startsWith(`${property};`)) {
      const colonIndex = line.indexOf(":");
      if (colonIndex !== -1) {
        results.push(line.slice(colonIndex + 1).trim());
      }
    }
  }
  return results;
}
