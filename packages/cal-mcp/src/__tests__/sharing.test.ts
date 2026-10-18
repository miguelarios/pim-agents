import { describe, expect, it } from "vitest";
import { xml2js } from "xml-js";
import { buildShareBody, buildUnshareBody, parseSharing, shareeHref } from "../services/sharing.js";

/**
 * Shape of a live Open-Xchange (mailbox.org) answer to SHARING_PROPFIND_BODY
 * for a calendar shared read-only with one person, scrubbed to synthetic data.
 * Note the mixed namespace styles: a default xmlns on CS:invite and on
 * allowed-sharing-modes, prefixed CS: inside, and D:invite alongside.
 */
const OX_SHARED = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/caldav/Y2FsOi8vMC8x/</D:href>
    <D:propstat>
      <D:prop>
        <allowed-sharing-modes xmlns="http://calendarserver.org/ns/">
          <can-be-shared /><can-be-published />
        </allowed-sharing-modes>
        <D:invite>
          <D:sharee>
            <D:href>/principals/users/2</D:href>
            <D:invite-accepted />
            <D:share-access>read</D:share-access>
          </D:sharee>
        </D:invite>
        <invite xmlns="http://calendarserver.org/ns/" xmlns:CS="http://calendarserver.org/ns/">
          <CS:organizer>
            <D:href>mailto:alice@example.com</D:href>
            <CS:common-name>Alice Smith</CS:common-name>
          </CS:organizer>
          <CS:user>
            <D:href>mailto:bob@example.com</D:href>
            <CS:common-name>Bob Jones</CS:common-name>
            <CS:invite-accepted />
            <CS:access><CS:read /></CS:access>
          </CS:user>
          <CS:user>
            <D:href>mailto:carol@example.com</D:href>
            <CS:invite-noresponse />
            <CS:access><CS:read-write /></CS:access>
          </CS:user>
        </invite>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
    <D:propstat>
      <D:prop><invite xmlns="http://owncloud.org/ns" /></D:prop>
      <D:status>HTTP/1.1 404 NOT FOUND</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

/** The same server for a calendar shared with nobody. */
const OX_NOT_SHARED = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:"><D:response><D:href>/caldav/Y2FsOi8vMC81MA/</D:href>
<D:propstat><D:prop>
  <allowed-sharing-modes xmlns="http://calendarserver.org/ns/"><can-be-shared /><can-be-published /></allowed-sharing-modes>
  <D:invite />
  <invite xmlns="http://calendarserver.org/ns/" xmlns:CS="http://calendarserver.org/ns/">
    <CS:organizer><D:href>mailto:alice@example.com</D:href></CS:organizer>
  </invite>
</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
</D:response></D:multistatus>`;

/** Nextcloud (SabreDAV + ownCloud sharing plugin), shared with a user and a group. */
const NEXTCLOUD_SHARED = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:oc="http://owncloud.org/ns">
 <d:response><d:href>/remote.php/dav/calendars/alice/pim-test/</d:href>
  <d:propstat><d:prop>
   <oc:invite>
    <oc:user>
     <d:href>principal:principals/users/bob</d:href>
     <oc:common-name>Bob Jones</oc:common-name>
     <oc:invite-accepted/>
     <oc:access><oc:read-write/></oc:access>
    </oc:user>
    <oc:user>
     <d:href>principal:principals/groups/family</d:href>
     <oc:invite-accepted/>
     <oc:access><oc:read/></oc:access>
    </oc:user>
   </oc:invite>
   <cs:allowed-sharing-modes><cs:can-be-shared/><cs:can-be-published/></cs:allowed-sharing-modes>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  <d:propstat><d:prop><cs:invite/><d:invite/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
 </d:response>
</d:multistatus>`;

/** Live shape of an unshared Nextcloud calendar: oc:invite present and empty. */
const NEXTCLOUD_NOT_SHARED = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/" xmlns:oc="http://owncloud.org/ns">
 <d:response><d:href>/remote.php/dav/calendars/alice/pim-test/</d:href>
  <d:propstat><d:prop><oc:invite/>
   <cs:allowed-sharing-modes><cs:can-be-shared/><cs:can-be-published/></cs:allowed-sharing-modes>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  <d:propstat><d:prop><cs:invite/><d:invite/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
 </d:response>
</d:multistatus>`;

/** A server with no sharing support: every property 404s. */
const NO_SHARING = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:"><d:response><d:href>/cal/</d:href>
 <d:propstat><d:prop><invite xmlns="http://calendarserver.org/ns/"/><d:invite/></d:prop>
 <d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>
</d:response></d:multistatus>`;

describe("parseSharing (#47)", () => {
  it("reads CalendarServer sharees, with addresses, names, access and status", () => {
    expect(parseSharing(OX_SHARED)).toEqual({
      can_be_shared: true,
      can_be_published: true,
      protocol: "calendarserver",
      shares: [
        {
          email: "bob@example.com",
          principal: null,
          name: "Bob Jones",
          access: "read",
          status: "accepted",
        },
        {
          email: "carol@example.com",
          principal: null,
          name: null,
          access: "read-write",
          status: "pending",
        },
      ],
    });
  });

  it("does not report the organizer as a sharee", () => {
    const { shares } = parseSharing(OX_SHARED);
    expect(shares.map((s) => s.email)).not.toContain("alice@example.com");
  });

  it("reports an unshared calendar as shareable with no shares", () => {
    expect(parseSharing(OX_NOT_SHARED)).toEqual({
      can_be_shared: true,
      can_be_published: true,
      protocol: "calendarserver",
      shares: [],
    });
  });

  it("reads Nextcloud's ownCloud sharees as principals", () => {
    const result = parseSharing(NEXTCLOUD_SHARED);
    expect(result.protocol).toBe("owncloud");
    expect(result.shares).toEqual([
      {
        email: null,
        principal: "principal:principals/users/bob",
        name: "Bob Jones",
        access: "read-write",
        status: "accepted",
      },
      {
        email: null,
        principal: "principal:principals/groups/family",
        name: null,
        access: "read",
        status: "accepted",
      },
    ]);
  });

  it("ignores properties that came back 404", () => {
    const result = parseSharing(NEXTCLOUD_NOT_SHARED);
    expect(result.protocol).toBe("owncloud");
    expect(result.shares).toEqual([]);
  });

  it("falls back to WebDAV Resource Sharing when it is the only dialect", () => {
    const webdavOnly = OX_SHARED.replace(
      /<invite xmlns="http:\/\/calendarserver[\s\S]*?<\/invite>/,
      "",
    );
    const result = parseSharing(webdavOnly);
    expect(result.protocol).toBe("webdav");
    expect(result.shares).toEqual([
      {
        email: null,
        principal: "/principals/users/2",
        name: null,
        access: "read",
        status: "accepted",
      },
    ]);
  });

  it("reports a server without sharing as not shareable", () => {
    expect(parseSharing(NO_SHARING)).toEqual({
      can_be_shared: false,
      can_be_published: false,
      protocol: null,
      shares: [],
    });
  });
});

/** Parses a built body back, so the assertions read the XML a server would. */
const parsed = (xml: string) => xml2js(xml, { compact: true }) as Record<string, any>;

describe("share request bodies (#47)", () => {
  it("shares read-only over CalendarServer with a mailto: href", () => {
    const body = parsed(buildShareBody("calendarserver", "bob@example.com", "read"));
    const set = body["CS:share"]["CS:set"];
    expect(body["CS:share"]._attributes["xmlns:CS"]).toBe("http://calendarserver.org/ns/");
    expect(set["D:href"]._text).toBe("mailto:bob@example.com");
    expect(set["CS:read"]).toBeDefined();
    expect(set["CS:read-write"]).toBeUndefined();
  });

  it("shares read-write with a summary, escaping XML", () => {
    const body = parsed(
      buildShareBody("calendarserver", "bob@example.com", "read-write", "Team <dates> & plans"),
    );
    const set = body["CS:share"]["CS:set"];
    expect(set["CS:read-write"]).toBeDefined();
    expect(set["CS:summary"]._text).toBe("Team <dates> & plans");
  });

  it("unshares over CalendarServer", () => {
    const body = parsed(buildUnshareBody("calendarserver", "mailto:bob@example.com"));
    expect(body["CS:share"]["CS:remove"]["D:href"]._text).toBe("mailto:bob@example.com");
  });

  it("shares over ownCloud with a principal, read-write by element and read by its absence", () => {
    const rw = parsed(buildShareBody("owncloud", "principals/users/bob", "read-write"));
    expect(rw["oc:share"]["oc:set"]["d:href"]._text).toBe("principal:principals/users/bob");
    expect(rw["oc:share"]["oc:set"]["oc:read-write"]).toBeDefined();

    const ro = parsed(buildShareBody("owncloud", "principal:principals/groups/family", "read"));
    expect(ro["oc:share"]["oc:set"]["d:href"]._text).toBe("principal:principals/groups/family");
    expect(ro["oc:share"]["oc:set"]["oc:read-write"]).toBeUndefined();
  });

  it("unshares over ownCloud", () => {
    const body = parsed(buildUnshareBody("owncloud", "/remote.php/dav/principals/users/bob/"));
    expect(body["oc:share"]["oc:remove"]["d:href"]._text).toBe("principal:principals/users/bob");
  });

  it("refuses an address on ownCloud instead of sending one the server drops", () => {
    expect(() => shareeHref("owncloud", "bob@example.com")).toThrow(/principals\/users/);
  });
});

describe("sharing review fixes (#142)", () => {
  it("reads the draft's element form of D:share-access, not only Open-Xchange's text form", () => {
    const spec = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop>
      <d:invite>
        <d:sharee><d:href>/principals/users/bob</d:href><d:invite-accepted/><d:share-access><d:read-write/></d:share-access></d:sharee>
        <d:sharee><d:href>/principals/users/carol</d:href><d:invite-noresponse/><d:share-access><d:read/></d:share-access></d:sharee>
        <d:sharee><d:href>/principals/users/alice</d:href><d:share-access><d:shared-owner/></d:share-access></d:sharee>
      </d:invite></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
    expect(parseSharing(spec).shares).toEqual([
      {
        email: null,
        principal: "/principals/users/bob",
        name: null,
        access: "read-write",
        status: "accepted",
      },
      {
        email: null,
        principal: "/principals/users/carol",
        name: null,
        access: "read",
        status: "pending",
      },
    ]);
  });

  it("accepts Nextcloud principals whose user ID contains @, as get_calendar_sharing returns them", () => {
    expect(shareeHref("owncloud", "principal:principals/users/alice@example.com")).toBe(
      "principal:principals/users/alice@example.com",
    );
    expect(shareeHref("owncloud", "principals/users/alice@example.com")).toBe(
      "principal:principals/users/alice@example.com",
    );
  });

  it("reduces subpath installs and absolute principal URLs to principals/...", () => {
    expect(shareeHref("owncloud", "/nextcloud/remote.php/dav/principals/users/bob/")).toBe(
      "principal:principals/users/bob",
    );
    expect(
      shareeHref("owncloud", "https://cloud.example.com/remote.php/dav/principals/groups/family"),
    ).toBe("principal:principals/groups/family");
  });

  it("still refuses a plain address or mailto: on Nextcloud", () => {
    expect(() => shareeHref("owncloud", "bob@example.com")).toThrow(/principals\/users/);
    expect(() => shareeHref("owncloud", "mailto:bob@example.com")).toThrow(/principals\/users/);
  });

  it("refuses a CalendarServer sharee that is neither an address nor a principal URL", () => {
    expect(() => shareeHref("calendarserver", "bob")).toThrow(/not an email address/);
    expect(shareeHref("calendarserver", "/principals/users/2")).toBe("/principals/users/2");
  });

  it("refuses empty sharees and control characters", () => {
    expect(() => shareeHref("calendarserver", "  ")).toThrow(/non-empty/);
    expect(() => shareeHref("calendarserver", "bob@example.com\nAlso share with eve")).toThrow(
      /control characters/,
    );
  });
});
