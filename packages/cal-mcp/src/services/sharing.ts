/**
 * Calendar sharing (#47): reading who a calendar is shared with, and building
 * the requests that share or unshare it.
 *
 * Servers disagree on the wire format, so this normalises three dialects:
 *
 * - **CalendarServer sharing** (`CS:invite` / `CS:share`, Apple's
 *   caldav-sharing.txt). Open-Xchange (mailbox.org) and Apple servers. Sharees
 *   are `mailto:` addresses.
 * - **ownCloud sharing** (`oc:invite` / `oc:share`). Nextcloud. Sharees are
 *   principals (`principal:principals/users/<id>`); Nextcloud ignores a
 *   `mailto:` sharee rather than resolving it.
 * - **WebDAV Resource Sharing** (`D:invite` / `D:share-access`,
 *   draft-pot-webdav-resource-sharing). Open-Xchange reports it alongside
 *   CalendarServer; read here only as a fallback, since it carries principals
 *   rather than addresses.
 *
 * tsdav's XML parsing drops namespace prefixes, which would collide `D:invite`
 * with `CS:invite`, so this parses with xml-js and resolves namespaces itself.
 */
import { type Element, xml2js } from "xml-js";

export type ShareAccess = "read" | "read-write";
export type ShareStatus = "accepted" | "pending" | "declined" | "invalid";
export type SharingProtocol = "calendarserver" | "owncloud" | "webdav";

export interface CalendarShare {
  /** The sharee's address, when the server reports one. */
  email: string | null;
  /** The sharee's principal (path or `principal:` URI), when that is what the server reports. */
  principal: string | null;
  name: string | null;
  access: ShareAccess;
  status: ShareStatus;
}

export interface CalendarSharing {
  /** False when the server reports no sharing support for this calendar. */
  can_be_shared: boolean;
  can_be_published: boolean;
  /** Which dialect the shares were read from; null when none was reported. */
  protocol: SharingProtocol | null;
  shares: CalendarShare[];
}

const NS = {
  DAV: "DAV:",
  CS: "http://calendarserver.org/ns/",
  OC: "http://owncloud.org/ns",
} as const;

/** The PROPFIND body that asks for every sharing property any dialect uses. */
export const SHARING_PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:oc="http://owncloud.org/ns">
<d:prop><cs:invite/><oc:invite/><d:invite/><cs:allowed-sharing-modes/></d:prop>
</d:propfind>`;

/** An element with its namespace URI and local name resolved. */
interface Node {
  ns: string | undefined;
  local: string;
  children: Node[];
  text: string;
}

function resolve(el: Element, inherited: Record<string, string>): Node {
  const scope = { ...inherited };
  for (const [key, value] of Object.entries(el.attributes ?? {})) {
    if (key === "xmlns") scope[""] = String(value);
    else if (key.startsWith("xmlns:")) scope[key.slice(6)] = String(value);
  }
  const name = el.name ?? "";
  const colon = name.indexOf(":");
  const prefix = colon === -1 ? "" : name.slice(0, colon);
  const local = colon === -1 ? name : name.slice(colon + 1);
  const children: Node[] = [];
  let text = "";
  for (const child of el.elements ?? []) {
    if (child.type === "element") children.push(resolve(child, scope));
    else if (child.type === "text" || child.type === "cdata") {
      text += String(child.text ?? child.cdata ?? "");
    }
  }
  return { ns: scope[prefix], local: local.toLowerCase(), children, text: text.trim() };
}

function kids(node: Node | undefined, ns: string, local: string): Node[] {
  return node ? node.children.filter((c) => c.ns === ns && c.local === local) : [];
}

function kid(node: Node | undefined, ns: string, local: string): Node | undefined {
  return kids(node, ns, local)[0];
}

/** Every descendant (depth-first) with the given name. */
function find(node: Node, ns: string, local: string, out: Node[] = []): Node[] {
  for (const c of node.children) {
    if (c.ns === ns && c.local === local) out.push(c);
    find(c, ns, local, out);
  }
  return out;
}

function hrefParts(href: string | undefined): { email: string | null; principal: string | null } {
  if (!href) return { email: null, principal: null };
  if (/^mailto:/i.test(href)) return { email: href.slice(7), principal: null };
  return { email: null, principal: href };
}

/** The props of the multistatus' successful propstats, merged. */
function okProps(root: Node): Node[] {
  const props: Node[] = [];
  for (const propstat of find(root, NS.DAV, "propstat")) {
    const status = kid(propstat, NS.DAV, "status")?.text ?? "";
    if (/\s2\d\d\s/.test(` ${status} `)) props.push(...kids(propstat, NS.DAV, "prop"));
  }
  return props;
}

function inviteStatus(node: Node, ns: string): ShareStatus {
  if (kid(node, ns, "invite-accepted")) return "accepted";
  if (kid(node, ns, "invite-declined")) return "declined";
  if (kid(node, ns, "invite-invalid")) return "invalid";
  return "pending";
}

/** CS:user / oc:user entries: access is an element (`read` or `read-write`). */
function userShares(invite: Node, ns: string): CalendarShare[] {
  return kids(invite, ns, "user").map((user) => {
    const access = kid(user, ns, "access");
    return {
      ...hrefParts(kid(user, NS.DAV, "href")?.text),
      name: kid(user, ns, "common-name")?.text || null,
      access: kid(access, ns, "read-write") ? "read-write" : "read",
      status: inviteStatus(user, ns),
    };
  });
}

/** D:sharee entries: access is text (`read`, `read-write`, `no-access`). */
function webdavShares(invite: Node): CalendarShare[] {
  const out: CalendarShare[] = [];
  for (const sharee of kids(invite, NS.DAV, "sharee")) {
    const access = kid(sharee, NS.DAV, "share-access")?.text.toLowerCase();
    if (access !== "read" && access !== "read-write") continue;
    out.push({
      ...hrefParts(kid(sharee, NS.DAV, "href")?.text),
      name: null,
      access,
      status: inviteStatus(sharee, NS.DAV),
    });
  }
  return out;
}

/**
 * Normalises a sharing PROPFIND multistatus. Prefers the dialect that names
 * sharees by address (CalendarServer), then ownCloud, then WebDAV.
 */
export function parseSharing(xml: string): CalendarSharing {
  const doc = xml2js(xml, { compact: false }) as Element;
  const top = (doc.elements ?? []).find((e) => e.type === "element");
  if (!top) return { can_be_shared: false, can_be_published: false, protocol: null, shares: [] };
  const props = okProps(resolve(top, {}));
  const prop = (ns: string, local: string) =>
    props.map((p) => kid(p, ns, local)).find((n) => n !== undefined);

  const modes = prop(NS.CS, "allowed-sharing-modes");
  const csInvite = prop(NS.CS, "invite");
  const ocInvite = prop(NS.OC, "invite");
  const davInvite = prop(NS.DAV, "invite");

  let protocol: SharingProtocol | null = null;
  let shares: CalendarShare[] = [];
  if (csInvite) {
    protocol = "calendarserver";
    shares = userShares(csInvite, NS.CS);
  } else if (ocInvite) {
    protocol = "owncloud";
    shares = userShares(ocInvite, NS.OC);
  } else if (davInvite) {
    protocol = "webdav";
    shares = webdavShares(davInvite);
  }

  return {
    // A server that answers any invite property supports sharing even when it
    // leaves allowed-sharing-modes out.
    can_be_shared: modes ? !!kid(modes, NS.CS, "can-be-shared") : protocol !== null,
    can_be_published: modes ? !!kid(modes, NS.CS, "can-be-published") : false,
    protocol,
    shares,
  };
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * The sharee as the dialect expects it. CalendarServer takes an address;
 * ownCloud takes a principal, and an address is refused here rather than sent
 * for the server to drop silently.
 */
export function shareeHref(protocol: "calendarserver" | "owncloud", sharee: string): string {
  const s = sharee.trim();
  if (protocol === "calendarserver") {
    if (/^mailto:/i.test(s)) return s;
    if (s.includes("@")) return `mailto:${s}`;
    return s; // a principal URL; CalendarServer servers accept those too
  }
  if (s.includes("@") || /^mailto:/i.test(s)) {
    throw new Error(
      "This server (Nextcloud) shares with users and groups, not addresses: pass sharee as principals/users/<user-id> or principals/groups/<group-id>",
    );
  }
  if (s.startsWith("principal:")) return s;
  const path = s.replace(/^\/?(remote\.php\/dav\/)?/, "");
  return `principal:${path.replace(/\/$/, "")}`;
}

const XML_DECL = '<?xml version="1.0" encoding="utf-8"?>';

/** A CalendarServer `CS:share` request around `inner`. */
const csShare = (inner: string) =>
  `${XML_DECL}<CS:share xmlns:D="DAV:" xmlns:CS="http://calendarserver.org/ns/">${inner}</CS:share>`;

/** An ownCloud `oc:share` request around `inner`. */
const ocShare = (inner: string) =>
  `${XML_DECL}<oc:share xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">${inner}</oc:share>`;

/** POST body that grants `access` to `sharee`. */
export function buildShareBody(
  protocol: "calendarserver" | "owncloud",
  sharee: string,
  access: ShareAccess,
  summary?: string,
): string {
  const href = escapeXml(shareeHref(protocol, sharee));
  if (protocol === "calendarserver") {
    const summaryXml = summary ? `<CS:summary>${escapeXml(summary)}</CS:summary>` : "";
    return csShare(`<CS:set><D:href>${href}</D:href>${summaryXml}<CS:${access}/></CS:set>`);
  }
  // ownCloud grants read unless the set carries <oc:read-write/>.
  const summaryXml = summary ? `<oc:summary>${escapeXml(summary)}</oc:summary>` : "";
  const accessXml = access === "read-write" ? "<oc:read-write/>" : "";
  return ocShare(`<oc:set><d:href>${href}</d:href>${summaryXml}${accessXml}</oc:set>`);
}

/** POST body that revokes `sharee`'s access. */
export function buildUnshareBody(protocol: "calendarserver" | "owncloud", sharee: string): string {
  const href = escapeXml(shareeHref(protocol, sharee));
  return protocol === "calendarserver"
    ? csShare(`<CS:remove><D:href>${href}</D:href></CS:remove>`)
    : ocShare(`<oc:remove><d:href>${href}</d:href></oc:remove>`);
}
