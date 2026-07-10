import { appendFileSync } from "node:fs";
import URLCleaner from "@backrunner/url-cleaner";
import sanitize from "sanitize-html";
import TurndownService from "turndown";

// Supplemental tracking params not covered by uBlock/AdGuard lists
const SUPPLEMENTAL_TRACKING_PARAMS = ["_ke", "sc_cid", "campaign_id"];

// Lazy-init singleton — constructed on first use, reused thereafter
let cleanerInstance: URLCleaner | null = null;

function getCleaner(): URLCleaner {
  if (!cleanerInstance) {
    cleanerInstance = new URLCleaner({ useDefaultLists: true });
  }
  return cleanerInstance;
}

export async function disposeUrlCleaner(): Promise<void> {
  if (cleanerInstance) {
    await cleanerInstance.dispose();
    cleanerInstance = null;
  }
}

function stripSupplementalParams(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    let removed = false;
    for (const key of SUPPLEMENTAL_TRACKING_PARAMS) {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        removed = true;
      }
    }
    return removed ? url.toString() : urlStr;
  } catch {
    return urlStr;
  }
}

export async function cleanUrl(urlStr: string): Promise<string> {
  try {
    new URL(urlStr);
  } catch {
    return urlStr;
  }
  const cleaner = getCleaner();
  const result = await cleaner.cleanURLWithResult(urlStr);
  return stripSupplementalParams(result.url);
}

function isHiddenElement(style: string): boolean {
  const s = style.toLowerCase();
  if (!s.includes("display:none") && !s.includes("display: none")) {
    return false;
  }
  return (
    s.includes("height:0") ||
    s.includes("height: 0") ||
    s.includes("max-height:0") ||
    s.includes("max-height: 0") ||
    s.includes("overflow:hidden") ||
    s.includes("overflow: hidden") ||
    s.includes("opacity:0") ||
    s.includes("opacity: 0")
  );
}

export async function htmlToMarkdown(html: string): Promise<string> {
  // Step 1: Sanitize
  const clean = sanitize(html, {
    allowedTags: [
      "p",
      "br",
      "b",
      "i",
      "em",
      "strong",
      "a",
      "ul",
      "ol",
      "li",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "table",
      "tr",
      "td",
      "th",
      "thead",
      "tbody",
      "blockquote",
      "pre",
      "code",
      "hr",
      "span",
      "div",
      "img",
    ],
    allowedAttributes: {
      a: ["href"],
      img: ["src", "alt", "width", "height", "style"],
    },
    exclusiveFilter: (frame) => {
      // Remove tracking pixels
      if (frame.tag === "img") {
        const w = Number.parseInt(frame.attribs.width || "", 10);
        const h = Number.parseInt(frame.attribs.height || "", 10);
        if ((w >= 0 && w <= 1) || (h >= 0 && h <= 1)) return true;
        const style = frame.attribs.style || "";
        if (isHiddenElement(style)) return true;
      }
      // Remove hidden elements
      const style = frame.attribs?.style || "";
      if (style && isHiddenElement(style)) return true;
      return false;
    },
  });

  // Step 2: Convert to markdown
  const td = new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
  });

  // Override list item rule to use single space after bullet marker
  td.addRule("listItem", {
    filter: "li",
    replacement: (content, _node, options) => {
      const marker = `${options.bulletListMarker} `;
      const indented = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, "\n    ");
      return `${marker}${indented}${content.match(/\n+$/) ? "\n\n" : "\n"}`;
    },
  });

  let markdown = td.turndown(clean);

  // Step 3: Replace images
  // ![alt](url) → [Image: alt], ![](url) → removed
  markdown = markdown.replace(/!\[([^\]]*)\]\([^)]+\)/g, (_, alt) => {
    return alt ? `[Image: ${alt}]` : "";
  });

  // Step 3b: Remove ad images and logos (standalone or link-wrapped)
  // [[Image: Ad]](url) or [Image: Ad] — exact match
  // [[Image: *Logo]](url) or [Image: *Logo] — alt text ending in "Logo"
  markdown = markdown.replace(/\[?\[Image: (?:Ad|[^\]]*Logo)\]\]?(?:\([^)]*\))?/g, "");

  // Step 4: Resolve redirect URLs
  // Use ](url) pattern to catch nested brackets like [[Image: alt]](url)
  const urlPattern = /\]\((https?:\/\/[^)]+)\)/g;
  const urlMatches = [...markdown.matchAll(urlPattern)];
  if (urlMatches.length > 0) {
    // Filter out SSRF-risky targets (private IPs, localhost, reserved hostnames)
    // before they enter the resolve pool — they stay in the markdown as-is.
    const urls = [...new Set(urlMatches.map((m) => m[1]))].filter((u) => !isBlockedUrl(u));
    const resolved = await resolveUrls(urls);
    for (const [original, final] of resolved) {
      if (original !== final) {
        markdown = markdown.replaceAll(original, final);
      }
    }
  }

  // Step 5: Strip tracking params from all URLs
  const paramPattern = /\(https?:\/\/[^)]+\)/g;
  const paramMatches = [...markdown.matchAll(paramPattern)];
  if (paramMatches.length > 0) {
    const urls = [...new Set(paramMatches.map((m) => m[0].slice(1, -1)))];
    const cleaned = await Promise.all(urls.map((u) => cleanUrl(u)));
    const urlMap = new Map(urls.map((u, i) => [u, cleaned[i]]));
    for (const [original, clean] of urlMap) {
      if (original !== clean) {
        markdown = markdown.replaceAll(original, clean);
      }
    }
  }

  // Step 6: Post-process — collapse excessive newlines
  markdown = markdown.replace(/\n{3,}/g, "\n\n").trim();

  return markdown;
}

type FetchResult =
  | { url: string; resolved: string; status: "ok" }
  | { url: string; resolved: string; status: "timeout" }
  | { url: string; resolved: string; status: "error"; error: string };

const POOL_SIZE = 10;
const MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT = 10000;

const BLOCKED_HOST_SUFFIXES = [".local", ".internal", ".lan", ".home", ".arpa"];

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/**
 * Guard against SSRF via email-embedded links. Checks the *initial* URL only —
 * redirect hops and DNS rebinding are not inspected (accepted residual risk;
 * set URL_RESOLVE_DISABLE=1 to turn off resolution entirely).
 */
export function isBlockedUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return true;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return true;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || !host.includes(".")) return true;
  if (BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) return true;
  if (isPrivateIpv4(host)) return true;
  if (host.includes(":")) {
    // IPv6 literal (brackets already stripped). Any dot-free host is already
    // blocked above by the single-label check, but these explicit rules also
    // catch dotted forms — e.g. ::ffff:169.254.169.254 — that some runtimes
    // preserve instead of normalizing to hex (::ffff:a9fe:a9fe).
    if (host === "::1") return true; // loopback
    if (/^fe[89ab][0-9a-f]:/i.test(host)) return true; // link-local fe80::/10
    if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true; // unique-local fc00::/7
    // IPv4-mapped IPv6 (::ffff:a.b.c.d or ::ffff:hhhh:hhhh) — unwrap and re-check.
    const mapped = /^::ffff:(.+)$/i.exec(host);
    if (mapped) {
      const tail = mapped[1];
      let ipv4: string | undefined;
      if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) {
        ipv4 = tail;
      } else {
        const hx = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(tail);
        if (hx) {
          const hi = Number.parseInt(hx[1], 16);
          const lo = Number.parseInt(hx[2], 16);
          ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        }
      }
      if (ipv4 && isPrivateIpv4(ipv4)) return true;
    }
  }
  return false;
}

async function fetchOne(
  url: string,
  timeoutMs: number,
  log: (msg: string) => void,
): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    controller.abort();
    const elapsed = Date.now() - start;
    if (url !== res.url) {
      log(`RESOLVE ${url} → ${res.url} (${elapsed}ms)`);
    }
    return { url, resolved: res.url, status: "ok" };
  } catch (err) {
    clearTimeout(timer);
    const elapsed = Date.now() - start;
    if (err instanceof Error && err.name === "AbortError") {
      log(`TIMEOUT ${url} after ${timeoutMs}ms (elapsed ${elapsed}ms, kept original)`);
      return { url, resolved: url, status: "timeout" };
    }
    const reason = err instanceof Error ? err.message : String(err);
    log(`ERROR ${url} ${reason} (${elapsed}ms, kept original)`);
    return { url, resolved: url, status: "error", error: reason };
  }
}

async function pooledResolve(
  urls: string[],
  concurrency: number,
  fetchFn: (url: string) => Promise<FetchResult>,
): Promise<FetchResult[]> {
  if (urls.length === 0) return [];

  const results: FetchResult[] = [];
  const queue = [...urls];
  const inFlight = new Map<Promise<FetchResult>, number>();

  function startNext(): void {
    if (queue.length === 0) return;
    const url = queue.shift()!;
    // promise is referenced inside callbacks — safe because they run asynchronously,
    // after inFlight.set(promise, 1) has executed
    const promise = fetchFn(url)
      .then((result) => {
        inFlight.delete(promise);
        results.push(result);
        return result;
      })
      .catch((err) => {
        // Safety net — fetchOne should never reject, but guard against it
        inFlight.delete(promise);
        const fallback: FetchResult = { url, resolved: url, status: "error", error: String(err) };
        results.push(fallback);
        return fallback;
      });
    inFlight.set(promise, 1);
  }

  // Fill initial slots
  const initialBatch = Math.min(concurrency, queue.length);
  for (let i = 0; i < initialBatch; i++) {
    startNext();
  }

  // Process remaining URLs as slots free up
  while (inFlight.size > 0) {
    await Promise.race([...inFlight.keys()]);
    // Slot freed — fill it
    while (inFlight.size < concurrency && queue.length > 0) {
      startNext();
    }
  }

  return results;
}

async function resolveUrls(urls: string[]): Promise<Map<string, string>> {
  if (process.env.URL_RESOLVE_DISABLE === "1" || process.env.URL_RESOLVE_DISABLE === "true") {
    // Kill switch: skip all network resolution entirely (no fetches at all).
    // Markdown conversion still proceeds; links stay as their original URLs.
    return new Map();
  }

  const debug = process.env.DEBUG_URL_RESOLVE === "1";
  const timeoutMs = debug
    ? Number.parseInt(process.env.URL_RESOLVE_TIMEOUT || String(DEFAULT_TIMEOUT), 10)
    : DEFAULT_TIMEOUT;
  const logFile = process.env.URL_RESOLVE_LOG || "/tmp/url-resolve.log";
  const log = debug
    ? (msg: string) => {
        const line = `[url-resolve] ${new Date().toISOString()} ${msg}\n`;
        try {
          appendFileSync(logFile, line);
        } catch {
          process.stderr.write(line);
        }
      }
    : (_msg: string) => {};

  const resolved = new Map<string, string>();
  let remaining = [...urls];
  let totalResolved = 0;
  let totalErrors = 0;
  let retryRounds = 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS && remaining.length > 0; attempt++) {
    if (attempt > 0) retryRounds++;

    const results = await pooledResolve(remaining, POOL_SIZE, (url) =>
      fetchOne(url, timeoutMs, log),
    );

    const timedOut: string[] = [];
    for (const r of results) {
      if (r.status === "ok") {
        resolved.set(r.url, r.resolved);
        totalResolved++;
      } else if (r.status === "timeout") {
        timedOut.push(r.url);
        // Set fallback now — will be overwritten if a later attempt succeeds
        resolved.set(r.url, r.resolved);
      } else {
        // Permanent error — don't retry
        resolved.set(r.url, r.resolved);
        totalErrors++;
      }
    }

    remaining = timedOut;
  }

  // remaining.length = URLs still timed out after all attempts
  if (debug) {
    const retryInfo =
      retryRounds > 0 ? `, ${retryRounds} retry round${retryRounds > 1 ? "s" : ""}` : "";
    log(
      `Summary: ${totalResolved}/${urls.length} resolved, ${remaining.length} timeout (${timeoutMs}ms), ${totalErrors} errors${retryInfo}`,
    );
  }

  return resolved;
}
