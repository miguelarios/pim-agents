/**
 * Routing link resolution through an HTTP proxy, so the machine running the
 * server does not hand its IP to every host an email links to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { disposeUrlProxy, htmlToMarkdown } from "../htmlToMarkdown.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const LINK = '<p><a href="https://example.com/a">a</a></p>';

/** The init object the resolver passed to fetch, if it fetched at all. */
const initFor = (index = 0) => mockFetch.mock.calls[index]?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue({ url: "https://example.com/a", status: 200 });
  delete process.env.URL_RESOLVE_PROXY;
});

afterEach(async () => {
  delete process.env.URL_RESOLVE_PROXY;
  await disposeUrlProxy();
  vi.restoreAllMocks();
});

describe("URL_RESOLVE_PROXY", () => {
  it("resolves directly, with no dispatcher, when unset", async () => {
    await htmlToMarkdown(LINK);

    expect(mockFetch).toHaveBeenCalled();
    expect(initFor()).not.toHaveProperty("dispatcher");
  });

  it("passes a dispatcher to every resolution fetch when set", async () => {
    process.env.URL_RESOLVE_PROXY = "http://proxy.internal:3128";

    await htmlToMarkdown(LINK);

    expect(mockFetch).toHaveBeenCalled();
    expect(initFor().dispatcher).toBeDefined();
    expect(typeof initFor().dispatcher.dispatch).toBe("function");
  });

  it("reuses one agent across fetches rather than building one per URL", async () => {
    process.env.URL_RESOLVE_PROXY = "http://proxy.internal:3128";
    mockFetch.mockImplementation(async (url: string) => ({ url, status: 200 }));

    await htmlToMarkdown(
      '<p><a href="https://example.com/a">a</a><a href="https://example.org/b">b</a></p>',
    );

    expect(mockFetch.mock.calls.length).toBeGreaterThan(1);
    expect(initFor(0).dispatcher).toBe(initFor(1).dispatcher);
  });

  it("rebuilds the agent when the configured proxy changes", async () => {
    process.env.URL_RESOLVE_PROXY = "http://proxy-a.internal:3128";
    await htmlToMarkdown(LINK);
    const first = initFor().dispatcher;

    mockFetch.mockClear();
    process.env.URL_RESOLVE_PROXY = "http://proxy-b.internal:3128";
    await htmlToMarkdown(LINK);

    expect(initFor().dispatcher).not.toBe(first);
  });

  it.each([
    ["not-a-url", "unparseable"],
    ["ftp://proxy.internal:3128", "wrong scheme"],
  ])("resolves nothing at all when the proxy is %s (%s)", async (value) => {
    process.env.URL_RESOLVE_PROXY = value;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const markdown = await htmlToMarkdown(LINK);

    // Fails closed: a broken proxy must not silently become a direct fetch,
    // which is the exact leak this setting exists to prevent.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalled();
    // Conversion still succeeds; the link is simply left unresolved.
    expect(markdown).toContain("https://example.com/a");
  });

  it("treats a whitespace-only value as unset rather than broken", async () => {
    process.env.URL_RESOLVE_PROXY = "   ";

    await htmlToMarkdown(LINK);

    expect(mockFetch).toHaveBeenCalled();
    expect(initFor()).not.toHaveProperty("dispatcher");
  });

  it("still skips resolution entirely when URL_RESOLVE_DISABLE wins", async () => {
    process.env.URL_RESOLVE_PROXY = "http://proxy.internal:3128";
    process.env.URL_RESOLVE_DISABLE = "1";

    await htmlToMarkdown(LINK);

    expect(mockFetch).not.toHaveBeenCalled();
    delete process.env.URL_RESOLVE_DISABLE;
  });
});
