import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanUrl, disposeUrlCleaner, htmlToMarkdown, isBlockedUrl } from "../htmlToMarkdown.js";

describe("isBlockedUrl", () => {
  it.each([
    "http://192.168.1.10/admin",
    "http://10.0.0.5/",
    "http://172.16.0.5/admin",
    "http://127.0.0.1:8080/",
    "http://169.254.169.254/latest/meta-data",
    "http://localhost/x",
    "http://nas.local/x",
    "http://intranet/x",
    "ftp://example.com/x",
    "http://[::1]/x",
    // IPv4-mapped IPv6 literals must not bypass the private-IPv4 guard
    "http://[::ffff:169.254.169.254]/x",
    "http://[::ffff:127.0.0.1]/x",
    "http://[::ffff:192.168.1.1]/x",
    // Link-local is fe80::/10 (fe80::–febf::), not just literal fe80:
    "http://[fe80::1]/x",
    "http://[febf::1]/x",
  ])("blocks %s", (url) => {
    expect(isBlockedUrl(url)).toBe(true);
  });

  it.each(["https://example.com/a", "http://news.example.org/b?c=1"])("allows %s", (url) => {
    expect(isBlockedUrl(url)).toBe(false);
  });
});

describe("cleanUrl", () => {
  it("strips utm params", async () => {
    const url =
      "https://example.com/page?utm_source=email&utm_medium=newsletter&utm_campaign=spring&id=42";
    const result = await cleanUrl(url);
    expect(result).toBe("https://example.com/page?id=42");
  });

  it("strips Klaviyo _kx param", async () => {
    const url = "https://cdn.shopify.com/recipe.pdf?v=1773944942&_kx=BQ9YKnD8Hac1eUYa5CUsKsPXk0t1";
    const result = await cleanUrl(url);
    expect(result).toBe("https://cdn.shopify.com/recipe.pdf?v=1773944942");
  });

  it("strips Google Ads srsltid param", async () => {
    const url = "https://stealthhealthcontainers.com/?srsltid=AfmBOoqhC98&_kx=BQ9YKnD8Hac1";
    const result = await cleanUrl(url);
    expect(result).toBe("https://stealthhealthcontainers.com/");
  });

  it("strips supplemental params _ke and sc_cid", async () => {
    const url = "https://example.com/page?_ke=abc123&sc_cid=snap456&id=42";
    const result = await cleanUrl(url);
    expect(result).toBe("https://example.com/page?id=42");
  });

  it("strips fbclid and gclid", async () => {
    const url = "https://example.com/?fbclid=fb1&gclid=gc1&keep=yes";
    const result = await cleanUrl(url);
    expect(result).toBe("https://example.com/?keep=yes");
  });

  it("strips HubSpot and Marketo params", async () => {
    const url = "https://example.com/?_hsenc=hs1&_hsmi=hm1&mkt_tok=mt1&keep=yes";
    const result = await cleanUrl(url);
    expect(result).toBe("https://example.com/?keep=yes");
  });

  it("preserves functional params like Google Calendar", async () => {
    const url =
      "https://calendar.google.com/calendar/event?action=RESPOND&eid=abc123&rst=1&tok=xyz789&ctz=America%2FLos_Angeles&hl=en&es=0";
    const result = await cleanUrl(url);
    expect(result).toBe(url);
  });

  it("returns malformed URLs as-is", async () => {
    expect(await cleanUrl("not-a-url")).toBe("not-a-url");
    expect(await cleanUrl("")).toBe("");
  });

  it("handles URLs with no query params", async () => {
    const url = "https://example.com/page";
    const result = await cleanUrl(url);
    expect(result).toBe("https://example.com/page");
  });
});

// Mock fetch globally so no real network calls happen
const mockFetch = vi.fn().mockImplementation(async (url: string) => ({
  url, // by default, "no redirect" — resolved URL equals input
}));
vi.stubGlobal("fetch", mockFetch);

afterAll(async () => {
  await disposeUrlCleaner();
});

describe("htmlToMarkdown", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    // Default: no redirects (resolved URL = input URL)
    mockFetch.mockImplementation(async (url: string) => ({ url }));
  });

  it("converts basic HTML to markdown", async () => {
    const result = await htmlToMarkdown("<p>Hello <strong>world</strong></p>");
    expect(result).toContain("Hello **world**");
  });

  it("strips style tags", async () => {
    const result = await htmlToMarkdown("<style>.foo{color:red}</style><p>Content</p>");
    expect(result).not.toContain(".foo");
    expect(result).not.toContain("color");
    expect(result).toContain("Content");
  });

  it("strips script tags", async () => {
    const result = await htmlToMarkdown('<script>alert("xss")</script><p>Safe</p>');
    expect(result).not.toContain("alert");
    expect(result).toContain("Safe");
  });

  it("converts headings", async () => {
    const result = await htmlToMarkdown("<h2>Title</h2><p>Text</p>");
    expect(result).toContain("## Title");
  });

  it("converts lists", async () => {
    const result = await htmlToMarkdown("<ul><li>One</li><li>Two</li></ul>");
    expect(result).toContain("- One");
    expect(result).toContain("- Two");
  });

  it("converts links", async () => {
    const result = await htmlToMarkdown('<a href="https://example.com">Click</a>');
    expect(result).toContain("[Click](https://example.com)");
  });

  it("collapses excessive blank lines", async () => {
    const result = await htmlToMarkdown("<p>A</p><br><br><br><br><br><p>B</p>");
    // Should not have more than 2 consecutive newlines
    expect(result).not.toMatch(/\n{4,}/);
    expect(result).toContain("A");
    expect(result).toContain("B");
  });

  it("removes tracking pixels (width=1 height=1)", async () => {
    const result = await htmlToMarkdown(
      '<p>Content</p><img width="1" height="1" src="https://track.example.com/pixel.gif">',
    );
    expect(result).toContain("Content");
    expect(result).not.toContain("track.example.com");
    expect(result).not.toContain("pixel");
  });

  it("removes hidden preview text divs", async () => {
    const result = await htmlToMarkdown(
      '<div style="display:none;max-height:0;overflow:hidden">Preview text here</div><p>Real content</p>',
    );
    expect(result).not.toContain("Preview text here");
    expect(result).toContain("Real content");
  });

  it("removes Google Calendar hidden spans", async () => {
    const result = await htmlToMarkdown(
      '<span style="display: none; font-size: 1px; color: #fff; line-height: 1px; height: 0; max-height: 0; width: 0; max-width: 0; opacity: 0; overflow: hidden;">Hidden gcal text</span><p>Visible</p>',
    );
    expect(result).not.toContain("Hidden gcal text");
    expect(result).toContain("Visible");
  });

  it("replaces images with [Image: alt]", async () => {
    const result = await htmlToMarkdown(
      '<img src="https://example.com/photo.jpg" alt="Spring Minestrone" width="600" height="400">',
    );
    expect(result).toContain("[Image: Spring Minestrone]");
    expect(result).not.toContain("https://example.com/photo.jpg");
  });

  it("removes images with no alt text", async () => {
    const result = await htmlToMarkdown(
      '<img src="https://example.com/spacer.gif" width="600" height="10"><p>Content</p>',
    );
    expect(result).not.toContain("spacer.gif");
    expect(result).toContain("Content");
  });

  it("strips linked ad images and their wrapping links", async () => {
    const result = await htmlToMarkdown(
      '<p>Content</p><a href="https://ad-tracker.example.com/click"><img src="https://ad.example.com/banner.jpg" alt="Ad" width="600" height="100"></a><p>More</p>',
    );
    expect(result).not.toContain("Ad");
    expect(result).not.toContain("ad-tracker.example.com");
    expect(result).toContain("Content");
    expect(result).toContain("More");
    expect(mockFetch).not.toHaveBeenCalledWith(
      "https://ad-tracker.example.com/click",
      expect.anything(),
    );
  });

  it("strips linked logo images and their wrapping links", async () => {
    const result = await htmlToMarkdown(
      '<p>Content</p><a href="https://example.com/track"><img src="https://example.com/li.png" alt="LiveIntent Logo" width="80" height="20"></a><a href="https://example.com/choices"><img src="https://example.com/ac.png" alt="AdChoices Logo" width="80" height="20"></a>',
    );
    expect(result).not.toContain("Logo");
    expect(result).not.toContain("LiveIntent");
    expect(result).not.toContain("AdChoices");
    expect(result).toContain("Content");
  });

  it("keeps non-ad images intact", async () => {
    const result = await htmlToMarkdown(
      '<img src="https://example.com/food.jpg" alt="Spring Minestrone" width="600" height="400"><p>Recipe below</p>',
    );
    expect(result).toContain("[Image: Spring Minestrone]");
    expect(result).toContain("Recipe below");
  });

  it("resolves redirect URLs", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "https://redirect.example.com/abc123") {
        return { url: "https://real.example.com/page" };
      }
      return { url };
    });

    const result = await htmlToMarkdown(
      '<a href="https://redirect.example.com/abc123">Click here</a>',
    );
    expect(result).toContain("[Click here](https://real.example.com/page)");
    expect(result).not.toContain("redirect.example.com");
  });

  it("resolves redirect URLs in image-wrapped links (nested brackets)", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("redirect.example.com")) {
        return { url: "https://real.example.com/page" };
      }
      return { url };
    });

    const result = await htmlToMarkdown(
      '<a href="https://redirect.example.com/abc123"><img src="https://img.example.com/photo.jpg" alt="Photo" width="600" height="400"></a>',
    );
    expect(result).toContain("(https://real.example.com/page)");
    expect(result).not.toContain("redirect.example.com");
  });

  it("keeps original URL on fetch error", async () => {
    mockFetch.mockImplementation(async () => {
      throw new Error("Network error");
    });

    const result = await htmlToMarkdown('<a href="https://example.com/page">Link</a>');
    expect(result).toContain("[Link](https://example.com/page)");
  });

  it("does not retry permanent fetch errors", async () => {
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      callCount++;
      throw new TypeError("fetch failed");
    });

    await htmlToMarkdown('<a href="https://broken.example.com/1">Link</a>');
    // Should only be called once — permanent errors are not retried
    expect(callCount).toBe(1);
  });

  it("strips tracking params from resolved URLs", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("redirect.example.com")) {
        return {
          url: "https://cooking.example.com/recipe?campaign_id=58&utm_source=email&id=123",
        };
      }
      return { url };
    });

    const result = await htmlToMarkdown('<a href="https://redirect.example.com/xyz">Recipe</a>');
    expect(result).toContain("id=123");
    expect(result).not.toContain("campaign_id");
    expect(result).not.toContain("utm_source");
  });

  it("preserves functional URL params after resolution", async () => {
    mockFetch.mockImplementation(async (url: string) => ({ url }));

    const result = await htmlToMarkdown(
      '<a href="https://calendar.google.com/calendar/event?action=RESPOND&eid=abc&rst=1&tok=xyz">Yes</a>',
    );
    expect(result).toContain("action=RESPOND");
    expect(result).toContain("eid=abc");
    expect(result).toContain("rst=1");
    expect(result).toContain("tok=xyz");
  });

  describe("DEBUG_URL_RESOLVE logging", () => {
    const logFile = join(tmpdir(), `url-resolve-test-${process.pid}.log`);

    beforeEach(() => {
      vi.stubEnv("URL_RESOLVE_LOG", logFile);
      if (existsSync(logFile)) unlinkSync(logFile);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      if (existsSync(logFile)) unlinkSync(logFile);
    });

    function readLog(): string {
      return existsSync(logFile) ? readFileSync(logFile, "utf-8") : "";
    }

    it("logs nothing when DEBUG_URL_RESOLVE is not set", async () => {
      mockFetch.mockImplementation(async (url: string) => ({ url }));
      await htmlToMarkdown('<a href="https://example.com">Link</a>');
      expect(readLog()).toBe("");
    });

    it("logs resolved URLs when DEBUG_URL_RESOLVE=1", async () => {
      vi.stubEnv("DEBUG_URL_RESOLVE", "1");
      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("redirect")) return { url: "https://final.example.com/page" };
        return { url };
      });

      await htmlToMarkdown('<a href="https://redirect.example.com/abc">Link</a>');
      const output = readLog();
      expect(output).toContain("[url-resolve]");
      expect(output).toContain("https://redirect.example.com/abc");
      expect(output).toContain("https://final.example.com/page");
      expect(output).toContain("ms)");
    });

    it("logs TIMEOUT with threshold when fetch times out", async () => {
      vi.stubEnv("DEBUG_URL_RESOLVE", "1");
      mockFetch.mockImplementation(async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      });

      await htmlToMarkdown('<a href="https://slow.example.com/abc">Link</a>');
      const output = readLog();
      expect(output).toContain("TIMEOUT");
      expect(output).toContain("10000ms");
      expect(output).toContain("kept original");
    });

    it("logs ERROR for non-timeout failures", async () => {
      vi.stubEnv("DEBUG_URL_RESOLVE", "1");
      mockFetch.mockImplementation(async () => {
        throw new TypeError("fetch failed");
      });

      await htmlToMarkdown('<a href="https://broken.example.com/abc">Link</a>');
      const output = readLog();
      expect(output).toContain("ERROR");
      expect(output).toContain("fetch failed");
      expect(output).toContain("kept original");
    });

    it("logs summary line with counts", async () => {
      vi.stubEnv("DEBUG_URL_RESOLVE", "1");
      const urlAttempts = new Map<string, number>();
      mockFetch.mockImplementation(async (url: string) => {
        const count = (urlAttempts.get(url) || 0) + 1;
        urlAttempts.set(url, count);
        if (url.includes("b.example.com")) {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        return { url: "https://resolved.example.com" };
      });

      await htmlToMarkdown(
        '<a href="https://a.example.com/1">A</a> <a href="https://b.example.com/2">B</a>',
      );
      const output = readLog();
      expect(output).toContain("Summary:");
      expect(output).toMatch(/1.*resolved/);
      expect(output).toMatch(/1.*timeout/);
      // b.example.com always times out, so retry count = MAX_ATTEMPTS
      expect(urlAttempts.get("https://b.example.com/2")).toBe(3);
    });

    it("uses URL_RESOLVE_TIMEOUT when debug is enabled", async () => {
      vi.stubEnv("DEBUG_URL_RESOLVE", "1");
      vi.stubEnv("URL_RESOLVE_TIMEOUT", "15000");
      mockFetch.mockImplementation(async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      });

      await htmlToMarkdown('<a href="https://slow.example.com/abc">Link</a>');
      const output = readLog();
      expect(output).toContain("15000ms");
    });
  });

  it("limits concurrent URL fetches to pool size", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    mockFetch.mockImplementation(async (url: string) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      // Simulate async work so concurrency is observable
      await new Promise((r) => setTimeout(r, 10));
      concurrent--;
      return { url };
    });

    // Create 25 unique URLs — more than POOL_SIZE (10)
    const links = Array.from(
      { length: 25 },
      (_, i) => `<a href="https://example.com/${i}">Link ${i}</a>`,
    ).join(" ");

    await htmlToMarkdown(links);

    expect(maxConcurrent).toBeLessThanOrEqual(10);
    expect(maxConcurrent).toBeGreaterThan(1); // sanity: not accidentally serialized
  });

  it("retries timed-out URLs up to MAX_ATTEMPTS", async () => {
    const attempts = new Map<string, number>();

    mockFetch.mockImplementation(async (url: string) => {
      const count = (attempts.get(url) || 0) + 1;
      attempts.set(url, count);
      if (url.includes("flaky") && count < 3) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      return { url: url.includes("flaky") ? "https://resolved.example.com" : url };
    });

    const result = await htmlToMarkdown(
      '<a href="https://flaky.example.com/1">Flaky</a> <a href="https://ok.example.com/2">OK</a>',
    );

    // Flaky URL should have been attempted 3 times and eventually resolved
    expect(attempts.get("https://flaky.example.com/1")).toBe(3);
    // OK URL should only be attempted once
    expect(attempts.get("https://ok.example.com/2")).toBe(1);
    // Final result should contain the resolved URL
    expect(result).toContain("https://resolved.example.com");
  });

  it("keeps original URL after MAX_ATTEMPTS exhausted", async () => {
    mockFetch.mockImplementation(async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    });

    const result = await htmlToMarkdown('<a href="https://always-slow.example.com/1">Link</a>');

    // After 3 failed attempts, keeps original URL
    expect(result).toContain("https://always-slow.example.com/1");
    // Total attempts should be MAX_ATTEMPTS = 3
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("handles emails with no links without errors", async () => {
    mockFetch.mockImplementation(async (url: string) => ({ url }));
    const result = await htmlToMarkdown("<p>No links here</p>");
    expect(result).toContain("No links here");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("uses GET method for URL resolution", async () => {
    mockFetch.mockResolvedValue({ url: "https://resolved.example.com/page" });
    await htmlToMarkdown('<a href="https://tracker.example.com/click">Link</a>');
    expect(mockFetch).toHaveBeenCalledWith(
      "https://tracker.example.com/click",
      expect.objectContaining({ method: "GET" }),
    );
  });

  describe("SSRF guard on link resolution", () => {
    it("does not fetch private-range link targets and leaves them as-is", async () => {
      const result = await htmlToMarkdown('<a href="http://192.168.1.10/admin">Router</a>');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(result).toContain("[Router](http://192.168.1.10/admin)");
    });

    it("does not fetch localhost/.local/.internal link targets", async () => {
      const result = await htmlToMarkdown(
        '<a href="http://nas.local/share">NAS</a> <a href="http://localhost:8080/x">Local</a>',
      );
      expect(mockFetch).not.toHaveBeenCalled();
      expect(result).toContain("[NAS](http://nas.local/share)");
      expect(result).toContain("[Local](http://localhost:8080/x)");
    });

    it("still fetches normal public URLs alongside blocked ones", async () => {
      mockFetch.mockImplementation(async (url: string) => {
        if (url === "https://redirect.example.com/abc") {
          return { url: "https://real.example.com/page" };
        }
        return { url };
      });

      const result = await htmlToMarkdown(
        '<a href="http://192.168.1.10/admin">Router</a> <a href="https://redirect.example.com/abc">Click</a>',
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith("https://redirect.example.com/abc", expect.anything());
      expect(result).toContain("[Router](http://192.168.1.10/admin)");
      expect(result).toContain("[Click](https://real.example.com/page)");
    });
  });

  describe("URL_RESOLVE_DISABLE kill switch", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("skips network resolution when URL_RESOLVE_DISABLE=1 but still converts markdown", async () => {
      vi.stubEnv("URL_RESOLVE_DISABLE", "1");
      const result = await htmlToMarkdown(
        '<a href="https://redirect.example.com/abc">Click here</a>',
      );
      expect(mockFetch).not.toHaveBeenCalled();
      expect(result).toContain("[Click here](https://redirect.example.com/abc)");
    });

    it("skips network resolution when URL_RESOLVE_DISABLE=true", async () => {
      vi.stubEnv("URL_RESOLVE_DISABLE", "true");
      const result = await htmlToMarkdown('<a href="https://redirect.example.com/abc">Link</a>');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(result).toContain("[Link](https://redirect.example.com/abc)");
    });

    it("resolves normally when URL_RESOLVE_DISABLE is unset", async () => {
      mockFetch.mockImplementation(async (url: string) => {
        if (url === "https://redirect.example.com/abc") {
          return { url: "https://real.example.com/page" };
        }
        return { url };
      });
      const result = await htmlToMarkdown(
        '<a href="https://redirect.example.com/abc">Click here</a>',
      );
      expect(mockFetch).toHaveBeenCalled();
      expect(result).toContain("[Click here](https://real.example.com/page)");
    });
  });

  it("dramatically reduces NYT newsletter size", async () => {
    const fixturePath = resolve(__dirname, "__fixtures__/nyt-example.html");
    const html = readFileSync(fixturePath, "utf-8");

    // Mock fetch: no redirects (just test sanitize+turndown+images)
    mockFetch.mockImplementation(async (url: string) => ({ url }));

    const result = await htmlToMarkdown(html);

    // Original HTML is ~65KB, result should be significantly smaller
    expect(result.length).toBeLessThan(html.length * 0.5);

    // Should not contain CSS
    expect(result).not.toMatch(/\{[^}]*color\s*:/);
    expect(result).not.toMatch(/@media/);

    // Should not contain HTML tags
    expect(result).not.toContain("<style");
    expect(result).not.toContain("<table");
    expect(result).not.toContain("<td");

    // Should contain readable content
    expect(result.length).toBeGreaterThan(0);
  });
});
