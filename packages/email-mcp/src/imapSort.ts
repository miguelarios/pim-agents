/**
 * Native IMAP SORT (RFC 5256).
 *
 * A server that advertises SORT will order a result set itself, which is both
 * faster and more correct than fetching envelopes to sort them here: the whole
 * mailbox is ordered, not just the page, so pagination is exact rather than
 * approximate on a large folder.
 *
 * imapflow has no SORT command — its public surface stops at `search()` — so
 * this drives `exec` and the search compiler directly. Both are internal to
 * imapflow, which is why every entry point here fails soft: a server that
 * rejects the command, a client version that moved the compiler, or anything
 * else unexpected returns `null` and leaves the caller on its existing
 * client-side path.
 */
import { createRequire } from "node:module";
import type { ImapFlow } from "imapflow";

const require = createRequire(import.meta.url);

/** RFC 5256 §3 sort keys, for the fields `search_emails` exposes. */
const SORT_KEYS = {
  date: "DATE",
  from: "FROM",
  subject: "SUBJECT",
} as const;

export type SortField = keyof typeof SORT_KEYS;

type Attribute = { type: string; value: string };

function searchCompiler(client: ImapFlow, criteria: unknown): Attribute[] {
  const { searchCompiler: compile } = require("imapflow/lib/search-compiler.js") as {
    searchCompiler: (connection: unknown, query: unknown) => Attribute[];
  };
  const keys = criteria && typeof criteria === "object" ? Object.keys(criteria) : [];
  // Mirrors imapflow's own search(): an empty query is "everything", which in
  // IMAP is the ALL key rather than an empty criteria list.
  if (keys.length === 0 || (keys.length === 1 && keys[0] === "all")) {
    return [{ type: "ATOM", value: "ALL" }];
  }
  return compile(client, criteria);
}

/** True when the connected server advertises RFC 5256 SORT. */
export function supportsSort(client: ImapFlow): boolean {
  try {
    return client.capabilities?.has("SORT") === true;
  } catch {
    return false;
  }
}

/**
 * Issues `UID SORT` for one search criteria object, returning UIDs in the
 * server's order, or `null` when the command could not be used.
 *
 * The charset is UTF-8 because the criteria may carry non-ASCII — a subject
 * filter, say. A server that only accepts US-ASCII answers BADCHARSET, which
 * lands in the catch below and sends the caller back to client-side sorting
 * rather than failing the search.
 */
export async function uidSort(
  client: ImapFlow,
  criteria: unknown,
  sortBy: SortField,
  sortOrder: "asc" | "desc",
): Promise<number[] | null> {
  if (!supportsSort(client)) return null;

  const key = SORT_KEYS[sortBy];
  if (!key) return null;

  // RFC 5256: REVERSE prefixes an individual key, it is not a global flag.
  const sortKeys: Attribute[] =
    sortOrder === "desc"
      ? [
          { type: "ATOM", value: "REVERSE" },
          { type: "ATOM", value: key },
        ]
      : [{ type: "ATOM", value: key }];

  try {
    const searchAttributes = searchCompiler(client, criteria);
    const uids: number[] = [];
    const response = await (
      client as unknown as {
        exec: (
          command: string,
          attributes: unknown[],
          options: unknown,
        ) => Promise<{ next?: () => void }>;
      }
    ).exec("UID SORT", [sortKeys, { type: "ATOM", value: "UTF-8" }, ...searchAttributes], {
      untagged: {
        SORT: async (untagged: { attributes?: Array<{ value?: unknown }> }) => {
          for (const attribute of untagged?.attributes ?? []) {
            // Only digit strings. CONDSTORE can append a (MODSEQ n) group, and
            // `Number("")` is 0, so neither a keyword nor an empty attribute
            // may be allowed to become a UID.
            const raw = attribute?.value;
            if (typeof raw !== "string" || !/^\d+$/.test(raw)) continue;
            uids.push(Number(raw));
          }
        },
      },
    });
    // imapflow's own commands call this to release the response; skipping it
    // would leave the connection waiting on a reader that never runs.
    response?.next?.();
    return uids;
  } catch {
    return null;
  }
}
