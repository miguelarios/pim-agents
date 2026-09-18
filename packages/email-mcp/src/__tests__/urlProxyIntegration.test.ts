/**
 * Real traffic, not a mocked fetch: a local HTTP proxy, an https:// link, and
 * an assertion that the resolution actually tunnelled through it.
 *
 * The mocked suite in urlProxy.test.ts pins the wiring; this one pins the part
 * the wiring cannot prove — that undici's ProxyAgent, installed as a separate
 * package, really does drive Node's bundled global fetch.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { disposeUrlCleaner, disposeUrlProxy, htmlToMarkdown } from "../htmlToMarkdown.js";

/** A proxy that records what reaches it and refuses to tunnel anywhere. */
async function startRecordingProxy() {
  const connects: Array<{ target: string; auth?: string }> = [];
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });
  server.on("connect", (req, socket) => {
    connects.push({
      target: req.url ?? "",
      auth: req.headers["proxy-authorization"] as string | undefined,
    });
    // Refusing keeps the test off the network entirely; the point is that the
    // request arrived here rather than going out directly.
    socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    socket.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    connects,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const LINK = '<p><a href="https://example.com/tracked">click</a></p>';

afterEach(async () => {
  delete process.env.URL_RESOLVE_PROXY;
  await disposeUrlProxy();
  await disposeUrlCleaner();
});

describe("URL_RESOLVE_PROXY over real sockets", () => {
  it("tunnels an https link through the proxy, carrying its credentials", async () => {
    const proxy = await startRecordingProxy();
    try {
      process.env.URL_RESOLVE_PROXY = `http://user:pass@127.0.0.1:${proxy.port}`;

      const markdown = await htmlToMarkdown(LINK);

      expect(proxy.connects.map((c) => c.target)).toContain("example.com:443");
      // "user:pass" base64-encoded — the credentials in the URL are used.
      expect(proxy.connects[0].auth).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`);
      // The proxy refused, so the link is left as it was rather than fetched direct.
      expect(markdown).toContain("https://example.com/tracked");
    } finally {
      await proxy.close();
    }
  }, 30_000);

  it("does not reach the proxy at all when the variable is unset", async () => {
    const proxy = await startRecordingProxy();
    try {
      process.env.URL_RESOLVE_DISABLE = "1";
      await htmlToMarkdown(LINK);
      expect(proxy.connects).toHaveLength(0);
    } finally {
      delete process.env.URL_RESOLVE_DISABLE;
      await proxy.close();
    }
  }, 30_000);
});
