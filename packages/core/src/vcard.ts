export interface TypedValue {
  type?: string;
  value: string;
}

export interface PostalAddress {
  type?: string;
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export interface SocialProfile {
  type: string;
  handle?: string;
  url?: string;
}

export interface Contact {
  uid: string;
  fullName: string;
  firstName?: string;
  lastName?: string;
  middleName?: string;
  namePrefix?: string;
  nameSuffix?: string;
  emails: TypedValue[];
  phones: TypedValue[];
  addresses: PostalAddress[];
  urls: TypedValue[];
  organization?: string;
  orgUnits?: string[];
  title?: string;
  role?: string;
  nickname?: string;
  birthday?: string;
  categories?: string[];
  note?: string;
  socialProfiles?: SocialProfile[];
  photo?: string;
  /**
   * `group` for a contact group (RFC 6350 `KIND:group`, or Apple's vCard 3.0
   * `X-ADDRESSBOOKSERVER-KIND:group`). Unset means an individual.
   */
  kind?: "individual" | "group";
  /**
   * Member UIDs of a group, with the `urn:uuid:` prefix stripped. A member
   * expressed as anything other than a UID urn (e.g. `mailto:`) is kept
   * verbatim, scheme included.
   */
  members?: string[];
  otherProperties: string[];
}

/** RFC 6350 §6.6.5 `MEMBER` values are URIs; contacts are referred to by UID urn. */
const UID_URN = "urn:uuid:";

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

const TYPE_NOISE_TOKENS = new Set(["internet", "voice", "pref"]);

const APPLE_INTERNAL_PROPS = new Set([
  "PRODID",
  "REV",
  "X-IMAGETYPE",
  "X-IMAGEHASH",
  "X-SHARED-PHOTO-DISPLAY-PREF",
  "X-ADDRESSING-GRAMMAR",
  "X-ABADR",
]);

/**
 * Strip Apple iOS "itemN." group prefix from a line.
 * Returns both the canonical line and the group id (or undefined).
 * "item1.ADR;type=HOME:..." -> { canonical: "ADR;type=HOME:...", group: "item1" }
 * "EMAIL:foo@bar" -> { canonical: "EMAIL:foo@bar", group: undefined }
 */
function stripItemPrefix(line: string): { canonical: string; group: string | undefined } {
  const match = /^(item\d+)\.(.+)$/i.exec(line);
  if (!match) return { canonical: line, group: undefined };
  return { canonical: match[2], group: match[1].toLowerCase() };
}

/**
 * Decode an Apple X-ABLabel value.
 * "_$!<HomePage>!$_" -> "homepage"
 * "School" -> "school"
 */
function decodeABLabel(raw: string): string {
  const wrapped = /^_\$!<(.+)>!\$_$/.exec(raw.trim());
  return (wrapped ? wrapped[1] : raw.trim()).toLowerCase();
}

/**
 * Build a map of group id (e.g. "item1") -> decoded X-ABLabel value.
 */
function buildAbLabelMap(lines: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of lines) {
    const { canonical, group } = stripItemPrefix(rawLine);
    if (!group) continue;
    const upper = canonical.toUpperCase();
    if (!upper.startsWith("X-ABLABEL:") && !upper.startsWith("X-ABLABEL;")) continue;
    const colonIndex = canonical.indexOf(":");
    if (colonIndex === -1) continue;
    const decoded = decodeABLabel(canonical.slice(colonIndex + 1));
    if (decoded) map.set(group, decoded);
  }
  return map;
}

/**
 * Normalize a raw TYPE parameter value into a clean label.
 * - Splits on comma or semicolon
 * - Lowercases all tokens
 * - Strips surrounding double-quote characters (from TYPE="internet" RFC 6868 form)
 * - Drops noise tokens: internet, voice, pref
 * - Joins remaining tokens with "/"
 * Returns undefined when no meaningful token remains.
 */
export function normalizeType(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const tokens = raw
    .split(/[,;]/)
    .map((tok) => tok.trim().replace(/^"|"$/g, "").toLowerCase())
    .filter((tok) => tok.length > 0 && !TYPE_NOISE_TOKENS.has(tok));
  if (tokens.length === 0) return undefined;
  return tokens.join("/");
}

export function parseVCard(data: string): Contact {
  const lines = unfoldLines(data);
  const abLabels = buildAbLabelMap(lines);

  const uid = extractFirst(lines, "UID") ?? "";
  const fullNameRaw = extractFirst(lines, "FN") ?? "";
  const fullName = unescapeVCardValue(fullNameRaw);
  const n = extractFirst(lines, "N");
  const emails = extractTypedAll(lines, "EMAIL", abLabels);
  const phones = extractTypedAll(lines, "TEL", abLabels);
  const urls = extractTypedAll(lines, "URL", abLabels);
  const orgRaw = extractFirst(lines, "ORG");
  const orgParts = orgRaw
    ? splitUnescaped(orgRaw, ";").map((p) => unescapeVCardValue(p).trim())
    : [];
  const organization = orgParts[0] || undefined;
  const orgUnitsParsed = orgParts.slice(1).filter(Boolean);
  const orgUnits: string[] | undefined = orgUnitsParsed.length > 0 ? orgUnitsParsed : undefined;
  const titleRaw = extractFirst(lines, "TITLE");
  const title = titleRaw !== undefined ? unescapeVCardValue(titleRaw) : undefined;
  const noteRaw = extractFirst(lines, "NOTE");
  const note = noteRaw !== undefined ? unescapeVCardValue(noteRaw) : undefined;
  const roleRaw = extractFirst(lines, "ROLE");
  const role = roleRaw !== undefined ? unescapeVCardValue(roleRaw) : undefined;
  const nicknameRaw = extractFirst(lines, "NICKNAME");
  const nickname = nicknameRaw !== undefined ? unescapeVCardValue(nicknameRaw) : undefined;
  const birthday = extractFirst(lines, "BDAY");
  const categoriesRaw = extractFirst(lines, "CATEGORIES");
  const categories = categoriesRaw
    ? splitUnescaped(categoriesRaw, ",").map((c) => unescapeVCardValue(c.trim()))
    : undefined;
  const socialProfiles = extractSocialProfiles(lines);
  const kindRaw = extractFirst(lines, "KIND") ?? extractFirst(lines, "X-ADDRESSBOOKSERVER-KIND");
  const kind = kindRaw?.toLowerCase() === "group" ? "group" : undefined;
  // Only a group's KIND/MEMBER lines are parsed into fields. Any other KIND
  // (org, location, an explicit individual) and any MEMBER on a non-group
  // stay raw in otherProperties, since the builder would not write them back.
  const memberValues =
    kind === "group"
      ? [...extractAll(lines, "MEMBER"), ...extractAll(lines, "X-ADDRESSBOOKSERVER-MEMBER")]
      : [];
  // Deduplicated: a card that carries both the RFC and the Apple form for
  // compatibility would otherwise list every member twice.
  const members =
    memberValues.length > 0
      ? [
          ...new Set(
            memberValues.map((m) =>
              m.toLowerCase().startsWith(UID_URN) ? m.slice(UID_URN.length) : m,
            ),
          ),
        ]
      : undefined;

  let photo: string | undefined;
  for (const rawLine of lines) {
    const { canonical } = stripItemPrefix(rawLine);
    if (/^PHOTO[;:]/i.test(canonical)) {
      photo = canonical;
      break;
    }
  }

  const KNOWN = new Set([
    "BEGIN",
    "END",
    "VERSION",
    "UID",
    "FN",
    "N",
    "EMAIL",
    "TEL",
    "ORG",
    "TITLE",
    "NOTE",
    "ADR",
    "URL",
    "BDAY",
    "NICKNAME",
    "CATEGORIES",
    "ROLE",
    "X-ABLABEL",
    "X-SOCIALPROFILE",
    "PHOTO",
  ]);
  const GROUP_PROPS = new Set([
    "KIND",
    "MEMBER",
    "X-ADDRESSBOOKSERVER-KIND",
    "X-ADDRESSBOOKSERVER-MEMBER",
  ]);
  const otherProperties: string[] = [];
  for (const rawLine of lines) {
    const { canonical: line } = stripItemPrefix(rawLine);
    const propName = line.split(/[:;]/)[0].toUpperCase();
    if (KNOWN.has(propName) || APPLE_INTERNAL_PROPS.has(propName)) continue;
    if (kind === "group" && GROUP_PROPS.has(propName)) continue;
    if (rawLine.trim()) {
      otherProperties.push(rawLine);
    }
  }

  let firstName: string | undefined;
  let lastName: string | undefined;
  let middleName: string | undefined;
  let namePrefix: string | undefined;
  let nameSuffix: string | undefined;
  if (n) {
    const parts = splitUnescaped(n, ";").map(unescapeVCardValue);
    lastName = parts[0] || undefined;
    firstName = parts[1] || undefined;
    middleName = parts[2] || undefined;
    namePrefix = parts[3] || undefined;
    nameSuffix = parts[4] || undefined;
  }

  return {
    uid,
    fullName,
    firstName,
    lastName,
    middleName,
    namePrefix,
    nameSuffix,
    emails,
    phones,
    addresses: extractAddresses(lines, abLabels),
    urls,
    organization,
    orgUnits,
    title,
    role,
    nickname,
    birthday,
    categories,
    note,
    photo,
    socialProfiles: socialProfiles.length > 0 ? socialProfiles : undefined,
    kind,
    members,
    otherProperties,
  };
}

export function buildVCard(contact: Contact): string {
  const lines: string[] = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `UID:${contact.uid}`,
    `FN:${escapeVCardValue(contact.fullName)}`,
  ];

  if (
    contact.lastName ||
    contact.firstName ||
    contact.middleName ||
    contact.namePrefix ||
    contact.nameSuffix
  ) {
    const n = [
      contact.lastName,
      contact.firstName,
      contact.middleName,
      contact.namePrefix,
      contact.nameSuffix,
    ]
      .map((p) => escapeVCardValue(p ?? ""))
      .join(";");
    lines.push(`N:${n}`);
  }

  for (const email of contact.emails) {
    const value = escapeVCardValue(email.value);
    lines.push(email.type ? `EMAIL;TYPE=${email.type}:${value}` : `EMAIL:${value}`);
  }
  for (const phone of contact.phones) {
    const value = escapeVCardValue(phone.value);
    lines.push(phone.type ? `TEL;TYPE=${phone.type}:${value}` : `TEL:${value}`);
  }
  for (const url of contact.urls) {
    const value = escapeVCardValue(url.value);
    lines.push(url.type ? `URL;TYPE=${url.type}:${value}` : `URL:${value}`);
  }
  for (const addr of contact.addresses) {
    const parts = [
      "",
      "",
      addr.street ?? "",
      addr.city ?? "",
      addr.state ?? "",
      addr.postalCode ?? "",
      addr.country ?? "",
    ].map(escapeVCardValue);
    const line = addr.type ? `ADR;TYPE=${addr.type}:${parts.join(";")}` : `ADR:${parts.join(";")}`;
    lines.push(line);
  }
  // Gated on either part, like N: is on its five. Gating on `organization`
  // alone dropped the units whenever it was empty — clearing the company
  // silently lost the department too.
  if (contact.organization || (contact.orgUnits && contact.orgUnits.length > 0)) {
    const orgLine = [contact.organization ?? "", ...(contact.orgUnits ?? [])]
      .map(escapeVCardValue)
      .join(";");
    lines.push(`ORG:${orgLine}`);
  }
  if (contact.title) {
    lines.push(`TITLE:${escapeVCardValue(contact.title)}`);
  }
  if (contact.role) {
    lines.push(`ROLE:${escapeVCardValue(contact.role)}`);
  }
  if (contact.nickname) {
    lines.push(`NICKNAME:${escapeVCardValue(contact.nickname)}`);
  }
  if (contact.birthday) {
    lines.push(`BDAY:${escapeVCardValue(contact.birthday)}`);
  }
  if (contact.categories && contact.categories.length > 0) {
    lines.push(`CATEGORIES:${contact.categories.map(escapeVCardValue).join(",")}`);
  }
  if (contact.note) {
    lines.push(`NOTE:${escapeVCardValue(contact.note)}`);
  }
  if (contact.socialProfiles) {
    for (const sp of contact.socialProfiles) {
      const parts: string[] = [`type=${sp.type.replace(/[;:"]/g, "")}`];
      if (sp.handle) parts.push(`x-user=${sp.handle.replace(/[;:"]/g, "")}`);
      const params = parts.join(";");
      const rawValue = sp.url ?? (sp.handle ? `x-apple:${sp.handle}` : "");
      const value = escapeVCardValue(rawValue);
      lines.push(`X-SOCIALPROFILE;${params}:${value}`);
    }
  }
  // Groups are written in the vCard 3.0 form, since that is the VERSION this
  // builder emits: Apple, iCloud and SabreDAV-based servers all read it.
  if (contact.kind === "group") {
    lines.push("X-ADDRESSBOOKSERVER-KIND:group");
    for (const member of contact.members ?? []) {
      const uri = /^[a-z][a-z0-9+.-]*:/i.test(member) ? member : `${UID_URN}${member}`;
      lines.push(`X-ADDRESSBOOKSERVER-MEMBER:${uri}`);
    }
  }
  if (contact.photo) {
    lines.push(contact.photo);
  }
  for (const raw of contact.otherProperties) {
    lines.push(raw);
  }

  lines.push("END:VCARD");
  return lines.join("\r\n");
}

/** Unfold continuation lines per RFC 6350 */
function unfoldLines(data: string): string[] {
  return data
    .replace(/\r\n[ \t]/g, "")
    .replace(/\n[ \t]/g, "")
    .split(/\r?\n/);
}

/** Extract first matching property value (ignoring parameters like ;TYPE=HOME) */
function extractFirst(lines: string[], property: string): string | undefined {
  for (const rawLine of lines) {
    const { canonical: line } = stripItemPrefix(rawLine);
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

/** Extract every value of a property, parameters ignored, unescaped. */
function extractAll(lines: string[], property: string): string[] {
  const results: string[] = [];
  for (const rawLine of lines) {
    const { canonical: line } = stripItemPrefix(rawLine);
    const upper = line.toUpperCase();
    if (!upper.startsWith(`${property}:`) && !upper.startsWith(`${property};`)) continue;
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const value = unescapeVCardValue(line.slice(colonIndex + 1).trim());
    if (value) results.push(value);
  }
  return results;
}

/** Extract all values for a property with optional TYPE parameter */
function extractTypedAll(
  lines: string[],
  property: string,
  abLabels: Map<string, string>,
): TypedValue[] {
  const results: TypedValue[] = [];
  for (const rawLine of lines) {
    const { canonical: line, group } = stripItemPrefix(rawLine);
    const upper = line.toUpperCase();
    if (upper.startsWith(`${property}:`) || upper.startsWith(`${property};`)) {
      const colonIndex = line.indexOf(":");
      if (colonIndex === -1) continue;
      const value = unescapeVCardValue(line.slice(colonIndex + 1).trim());
      const paramSection = line.slice(property.length, colonIndex);
      const typeMatches: string[] = [];
      for (const match of paramSection.matchAll(/TYPE=([^;:]+)/gi)) {
        typeMatches.push(match[1]);
      }
      const labelOverride = group ? abLabels.get(group) : undefined;
      const type = labelOverride ?? normalizeType(typeMatches.join(","));
      results.push(type ? { type, value } : { value });
    }
  }
  return results;
}

/** Extract ADR lines into PostalAddress objects */
function extractAddresses(lines: string[], abLabels: Map<string, string>): PostalAddress[] {
  const results: PostalAddress[] = [];
  for (const rawLine of lines) {
    const { canonical: line, group } = stripItemPrefix(rawLine);
    const upper = line.toUpperCase();
    if (!upper.startsWith("ADR:") && !upper.startsWith("ADR;")) continue;
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;

    const paramSection = line.slice(3, colonIndex);
    const typeMatches: string[] = [];
    for (const match of paramSection.matchAll(/TYPE=([^;:]+)/gi)) {
      typeMatches.push(match[1]);
    }
    const labelOverride = group ? abLabels.get(group) : undefined;
    const type = labelOverride ?? normalizeType(typeMatches.join(","));

    const parts = splitUnescaped(line.slice(colonIndex + 1), ";").map(unescapeVCardValue);
    const streetParts = [parts[0], parts[1], parts[2]].filter(Boolean);
    const street = streetParts.join(", ") || undefined;
    const city = parts[3] || undefined;
    const state = parts[4] || undefined;
    const postalCode = parts[5] || undefined;
    const country = parts[6] || undefined;

    const addr: PostalAddress = {};
    if (type) addr.type = type;
    if (street) addr.street = street;
    if (city) addr.city = city;
    if (state) addr.state = state;
    if (postalCode) addr.postalCode = postalCode;
    if (country) addr.country = country;
    results.push(addr);
  }
  return results;
}

/** Extract X-SOCIALPROFILE lines into SocialProfile objects */
function extractSocialProfiles(lines: string[]): SocialProfile[] {
  const results: SocialProfile[] = [];
  for (const rawLine of lines) {
    const { canonical: line } = stripItemPrefix(rawLine);
    const upper = line.toUpperCase();
    if (!upper.startsWith("X-SOCIALPROFILE;") && !upper.startsWith("X-SOCIALPROFILE:")) continue;
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) continue;
    const paramSection = line.slice("X-SOCIALPROFILE".length, colonIndex);
    const value = line.slice(colonIndex + 1).trim();

    const typeMatch = /type=([^;:]+)/i.exec(paramSection);
    const userMatch = /x-user=([^;:]+)/i.exec(paramSection);
    const type = typeMatch ? typeMatch[1].trim().toLowerCase() : "";
    if (!type) continue;

    const profile: SocialProfile = { type };
    if (userMatch) profile.handle = userMatch[1].trim();
    if (value && !/^x-apple:/i.test(value)) profile.url = value;
    results.push(profile);
  }
  return results;
}
