/**
 * The contract behind browser-fetch's tabId mode, with a tiny SERVER that behaves
 * like the API that started this: it answers an EMPTY 403 to any request whose
 * Origin is not its own, and a normal 200 to one whose Origin is.
 *
 *   background-style call -> Origin: chrome-extension://fake-extension-id -> empty 403
 *   in-tab call           -> Origin: the page's origin                    -> 200
 *
 * HONEST LIMIT: this does NOT prove browser behaviour. Nothing here sends a
 * browser request. The "browser" is a fetch stub that attaches the Origin header
 * that the real browser is EXPECTED to attach (the extension's for a background
 * fetch, the page's for a fetch made from the page's context), over a plain node
 * http client. What it pins is the shape of the contract: the server turns a
 * foreign Origin into the empty 403 the agent saw, the in-tab function makes a
 * request that would carry the page's Origin if the browser sends one, and the
 * empty-403 hint names the right fix for each context. Whether Chrome's isolated
 * world and Firefox's content.fetch really send the page's Origin is for the
 * live-browser harness, not this file.
 */
import * as http from "http";
import { AddressInfo } from "net";
import { fetchInTab } from "../../chrome-extension/injected/fetch-in-tab-script";
import { formatBrowserFetchReply } from "../fetch-format";

let server: http.Server;
let origin: string;
let calls: Array<{ origin: string | undefined; referer: string | undefined; cookie: string | undefined }>;

// A node http client with just enough of the fetch Response surface for fetchInTab.
function nodeFetch(url: string, init: { headers?: Record<string, string>; method?: string } = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: init.method ?? "GET", headers: init.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === "string") headers.set(k, v);
        }
        resolve({
          status: res.statusCode,
          statusText: res.statusMessage,
          url,
          headers,
          body: null,
          arrayBuffer: async () =>
            body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  calls = [];
  server = http.createServer((req, res) => {
    calls.push({
      origin: req.headers.origin,
      referer: req.headers.referer,
      cookie: req.headers.cookie,
    });
    if (req.headers.origin !== origin) {
      res.statusCode = 403; // empty body, no content type: what the agent saw
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end('{"things":["a","b"]}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  calls = [];
});

describe("the same-site API contract behind tabId mode (model, not browser proof)", () => {
  it("answers an empty 403 to a background-style call carrying the extension's Origin", async () => {
    const resp = await nodeFetch(`${origin}/api/things`, {
      headers: { Origin: "chrome-extension://fake-extension-id" },
    });
    expect(resp.status).toBe(403);
    expect(Buffer.from(await resp.arrayBuffer()).length).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].origin).toBe("chrome-extension://fake-extension-id");
  });

  it("answers 200 to the in-tab function when the (stub) browser attaches the page's Origin", async () => {
    const realFetch = (globalThis as any).fetch;
    // The stub plays the browser: a fetch made from the page's context carries
    // the page's Origin, which for this test is the server's own origin.
    (globalThis as any).fetch = (url: string, init: any) =>
      nodeFetch(url, { ...init, headers: { ...(init?.headers ?? {}), Origin: origin } });
    try {
      const result = await fetchInTab({
        requestId: "contract-1",
        url: `${origin}/api/things`,
      });
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(result.bodyText).toBe('{"things":["a","b"]}');
      expect(calls).toHaveLength(1);
      expect(calls[0].origin).toBe(origin);
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });

  it("the two outcomes are told apart by the reply formatter: banner + body for the tab, hint for the bare background 403", async () => {
    // Background-style: bare 403 -> the Origin/Referer hint pointing at tabId.
    const bg = await nodeFetch(`${origin}/api/things`, {
      headers: { Origin: "chrome-extension://fake-extension-id" },
    });
    const bgText = formatBrowserFetchReply(
      { url: `${origin}/api/things` },
      {
        ok: true,
        status: bg.status,
        statusText: bg.statusText,
        headers: {},
        bodyBase64: "",
        context: "background",
      }
    ).text;
    expect(bgText).toMatch(/^403 Forbidden/);
    expect(bgText).toMatch(/Hint: .*extension's Origin.*Retry with tabId/s);

    // In-tab: 200 with the page's Origin -> banner, body, no hint.
    const realFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = (url: string, init: any) =>
      nodeFetch(url, { ...init, headers: { ...(init?.headers ?? {}), Origin: origin } });
    try {
      const tab = await fetchInTab({ requestId: "contract-2", url: `${origin}/api/things` });
      const tabText = formatBrowserFetchReply(
        { url: `${origin}/api/things`, tabId: 7 },
        { ...tab, context: "tab", tabOrigin: origin }
      ).text;
      expect(tabText.split("\n")[0]).toBe(`[ran inside tab 7 as the page: origin ${origin}]`);
      expect(tabText).toContain('{"things":["a","b"]}');
      expect(tabText).not.toContain("Hint:");
    } finally {
      (globalThis as any).fetch = realFetch;
    }
  });
});
