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

/**
 * RFC 5256 makes the charset mandatory on SORT, so one is always sent. UTF-8
 * is the only charset imapflow's compiler ever asks for, and a server that
 * accepts only US-ASCII answers BADCHARSET — which lands in the catch below
 * and sends the caller back to client-side sorting rather than failing.
 */
const DEFAULT_CHARSET = "UTF-8";

/**
 * The compiled search key, plus the charset it has to be issued under.
 *
 * imapflow's compiler prepends a `CHARSET UTF-8` pair whenever a criteria
 * value contains non-ASCII and the connection has not enabled `UTF8=ACCEPT`,
 * because that is how RFC 3501 SEARCH takes a charset. SORT does not: RFC 5256
 * gives the charset its own slot between the sort keys and the search key, so
 * leaving the pair in place would emit
 * `UID SORT (REVERSE DATE) UTF-8 CHARSET UTF-8 SUBJECT "café"` — a syntax
 * error the server answers BAD. The pair is lifted out and its value used for
 * the slot instead, which is what makes an accented filter reach SORT at all.
 */
function compileSearchKey(
  client: ImapFlow,
  criteria: unknown,
): { charset: string; attributes: Attribute[] } {
  const { searchCompiler: compile } = require("imapflow/lib/search-compiler.js") as {
    searchCompiler: (connection: unknown, query: unknown) => Attribute[];
  };
  const keys = criteria && typeof criteria === "object" ? Object.keys(criteria) : [];
  // Mirrors imapflow's own search(): an empty query is "everything", which in
  // IMAP is the ALL key rather than an empty criteria list.
  if (keys.length === 0 || (keys.length === 1 && keys[0] === "all")) {
    return { charset: DEFAULT_CHARSET, attributes: [{ type: "ATOM", value: "ALL" }] };
  }

  const attributes = compile(client, criteria);
  if (
    attributes[0]?.type === "ATOM" &&
    String(attributes[0].value).toUpperCase() === "CHARSET" &&
    attributes[1] !== undefined
  ) {
    return { charset: String(attributes[1].value), attributes: attributes.slice(2) };
  }
  return { charset: DEFAULT_CHARSET, attributes };
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
    const { charset, attributes: searchAttributes } = compileSearchKey(client, criteria);
    const uids: number[] = [];
    const response = await (
      client as unknown as {
        exec: (
          command: string,
          attributes: unknown[],
          options: unknown,
        ) => Promise<{ next?: () => void }>;
      }
    ).exec("UID SORT", [sortKeys, { type: "ATOM", value: charset }, ...searchAttributes], {
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
