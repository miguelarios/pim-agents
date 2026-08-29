/**
 * Judging DAV collection-level responses (MKCALENDAR, extended MKCOL,
 * PROPPATCH, DELETE) across the CardDAV and CalDAV servers.
 *
 * This module exists to distrust tsdav's response shapes, which lie in two
 * different ways depending on which branch a request takes:
 *
 * - **Plain failures** (a 403/405/501 to a create, a PROPPATCH rejected
 *   outright) take the non-XML branch and carry the transport's real `status`.
 *   Judging on the numeric status works there.
 * - **A `207 Multi-Status` is `davResponse.ok`**, so it takes the parsed
 *   branch, where the mapped `ok` is merely `!responseBody.error` — and when
 *   the failure lives only in `propstat/status` (the normal PROPPATCH failure
 *   shape, RFC 4918 §9.2) the mapped `status` falls back to the transport's
 *   **207**, which is 2xx. tsdav's propstat mapping keeps only the `prop`
 *   contents; each propstat's own status survives solely under `raw`.
 *
 * So "success = 2xx" alone cannot catch a refused rename. The rule applied
 * here is to judge on the numeric status *and* walk the raw propstat statuses,
 * treating an unreadable 207 as a failure to judge rather than a success.
 *
 * Nothing here imports tsdav — it inspects plain objects, so core keeps no DAV
 * client dependency.
 */
import type { PimError } from "./errors.js";

/** The collection operation being judged. Used verbatim in error messages. */
export type DavCollectionAction = "create" | "rename" | "update" | "delete";

export interface DavCollectionCheckOptions {
  /** Resource noun for messages, e.g. `"calendar"` or `"address book"`. */
  resource: string;
  /** Plural noun. Defaults to `resource + "s"`, which is right for both. */
  resourcePlural?: string;
  /** Builds the 404 error, so each server keeps its own NOT_FOUND code. */
  notFound: (url: string) => PimError;
  /** Builds every other error. */
  failed: (message: string) => PimError;
}

/**
 * Collects the propstat-level status lines from a raw tsdav multistatus, in
 * which keys arrive camelCased with namespace prefixes stripped.
 */
export function propstatStatusLines(raw: unknown): string[] {
  const multistatus = (raw as { multistatus?: { response?: unknown } } | null | undefined)
    ?.multistatus;
  if (!multistatus) return [];
  const responses = Array.isArray(multistatus.response)
    ? multistatus.response
    : [multistatus.response];
  const lines: string[] = [];
  for (const entry of responses) {
    const propstat = (entry as { propstat?: unknown } | null | undefined)?.propstat;
    if (!propstat) continue;
    for (const ps of Array.isArray(propstat) ? propstat : [propstat]) {
      const status = (ps as { status?: unknown } | null | undefined)?.status;
      if (typeof status === "string") lines.push(status);
    }
  }
  return lines;
}

/**
 * Throws unless `response` shows the collection operation actually succeeded.
 *
 * Never trusts tsdav's `ok`, and for PROPPATCH not the mapped `status` alone
 * either — see the module comment.
 */
export function checkDavCollectionResponse(
  response: unknown,
  action: DavCollectionAction,
  url: string,
  opts: DavCollectionCheckOptions,
): void {
  const { resource, notFound, failed } = opts;
  const resourcePlural = opts.resourcePlural ?? `${resource}s`;

  const res = response as
    | { status?: number; statusText?: string; raw?: unknown }
    | null
    | undefined;
  const statuses: Array<{ status: number; statusText: string }> = [];
  if (res && typeof res.status === "number") {
    statuses.push({ status: res.status, statusText: res.statusText ?? "" });
  }
  for (const line of propstatStatusLines(res?.raw)) {
    const match = /\b(\d{3})\b\s*(.*)$/.exec(line);
    if (match) statuses.push({ status: Number(match[1]), statusText: match[2] ?? "" });
  }

  // This helper exists to distrust tsdav's response shapes, so a response
  // carrying no status at all is a failure to judge, not a success.
  if (statuses.length === 0) {
    throw failed(`The server returned no usable status for the ${action} of ${url}`);
  }

  // A 207 is not itself a verdict — it is a wrapper saying "the answer is
  // inside". If the propstat statuses did not parse, the only status left is
  // that wrapper, and treating a 2xx envelope as success is exactly the
  // failure this walk exists to prevent. Not being able to look inside is a
  // reason to refuse, not to assume.
  if (res?.status === 207 && statuses.every((s) => s.status === 207)) {
    throw failed(
      `The server returned a 207 for the ${action} of ${url} with no readable per-property status — cannot confirm it succeeded`,
    );
  }

  for (const { status, statusText } of statuses) {
    if (status >= 200 && status <= 299) continue;
    if (action === "create" && status === 404) {
      // RFC 5689 §3: a 404 here is about a missing parent collection, not
      // about the resource being created — saying "not found" would name the
      // wrong thing.
      throw failed(`Cannot create ${url}: the parent collection does not exist`);
    }
    if (status === 404) {
      throw notFound(url);
    }
    if (action === "create" && status === 405) {
      throw failed(`A collection already exists at ${url}`);
    }
    if (action === "create" && (status === 403 || status === 501)) {
      throw failed(`The provider does not allow creating ${resourcePlural} here (HTTP ${status})`);
    }
    if (status === 403) {
      throw failed(
        `The server refused to ${action} ${url} — the ${resource} may be read-only (HTTP 403)`,
      );
    }
    throw failed(`Failed to ${action} ${resource} ${url}: HTTP ${status} ${statusText}`.trim());
  }
}
