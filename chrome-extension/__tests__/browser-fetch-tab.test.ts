/**
 * browser-fetch with a `tabId` through the Chrome MessageHandler: the fetch is
 * injected into the tab's ISOLATED world with scripting.executeScript, gated on
 * the tab URL and the resolved target URL, timed out from the service worker,
 * and answered with context:"tab". Without a tabId the background path is
 * unchanged apart from context:"background".
 *
 * scripting.executeScript is mocked here, so nothing in this file proves what a
 * real browser sends on the wire (Origin, Referer, connect-src behaviour of the
 * isolated world); the live-browser check is separate.
 */
import { MessageHandler } from "../message-handler";
import type { ExtensionTransport } from "../transport";
import type { ServerMessageRequest } from "@foxpilot/common";
import { abortFetchInTab, fetchInTab } from "../injected/fetch-in-tab-script";
import {
  TAB_FETCH_DEFAULT_TIMEOUT_MS,
  TAB_FETCH_MAX_TIMEOUT_MS,
} from "../tab-fetch";

jest.mock("../native-input-client", () => ({
  NativeInputClient: jest.fn().mockImplementation(() => ({
    sendGesture: jest.fn(),
  })),
}));

const APP = "https://app.example.test";
const executeScript = () => (global as any).chrome.scripting.executeScript as jest.Mock;

function makeTransport(): jest.Mocked<ExtensionTransport> {
  return {
    sendResourceToServer: jest.fn().mockResolvedValue(undefined),
    sendErrorToServer: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<ExtensionTransport>;
}

function req(extra: Record<string, unknown>): ServerMessageRequest {
  return {
    cmd: "browser-fetch",
    correlationId: "bf1",
    url: `${APP}/api/v1/things`,
    ...extra,
  } as ServerMessageRequest;
}

const okResult = {
  ok: true,
  status: 200,
  statusText: "OK",
  headers: { "content-type": "application/json" },
  finalUrl: `${APP}/api/v1/things`,
  truncated: false,
  bodyText: '{"things":[]}',
};

describe("MessageHandler (chrome) — browser-fetch with tabId", () => {
  let handler: MessageHandler;
  let transport: jest.Mocked<ExtensionTransport>;
  let config: any;

  beforeEach(() => {
    jest.clearAllMocks();
    transport = makeTransport();
    handler = new MessageHandler(transport);
    config = {
      secret: "test-secret",
      ports: [8089],
      domainDenyList: [] as string[],
      auditLog: [],
      automationMode: true,
      toolSettings: {},
    };
    (browser.storage.local.get as jest.Mock).mockResolvedValue({ config });
    (browser.tabs.get as jest.Mock).mockResolvedValue({
      id: 7,
      url: `${APP}/dashboard?x=1#frag`,
    });
    (browser.permissions.contains as jest.Mock).mockResolvedValue(true);
    (browser.tabs.create as jest.Mock).mockResolvedValue({ id: 900 });
    executeScript().mockReset();
    executeScript().mockImplementation(async (inj: any) =>
      inj.func === abortFetchInTab ? [{ result: true }] : [{ result: okResult }]
    );
    (global as any).fetch = jest.fn();
  });

  describe("the injection", () => {
    it("runs fetchInTab in the ISOLATED world of that tab (never MAIN) and replies with context:tab", async () => {
      await handler.handleDecodedMessage(
        req({
          tabId: 7,
          method: "POST",
          headers: { "x-csrf-token": "fake-token-123" },
          body: '{"a":1}',
          maxBytes: 1234,
        })
      );

      expect(executeScript()).toHaveBeenCalledTimes(1);
      const inj = executeScript().mock.calls[0][0];
      expect(inj.target).toEqual({ tabId: 7 });
      expect(inj.world).toBe("ISOLATED");
      expect(inj.world).not.toBe("MAIN");
      expect(inj.func).toBe(fetchInTab);
      expect(inj.args).toHaveLength(1);
      expect(inj.args[0]).toEqual(
        expect.objectContaining({
          url: `${APP}/api/v1/things`,
          expectOrigin: APP,
          method: "POST",
          headers: { "x-csrf-token": "fake-token-123" },
          body: '{"a":1}',
          maxBytes: 1234,
          requestId: expect.stringMatching(/^ft-/),
        })
      );
      // The background fetch path is not taken.
      expect((global as any).fetch).not.toHaveBeenCalled();

      expect(transport.sendResourceToServer).toHaveBeenCalledTimes(1);
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "browser-fetch-result",
        correlationId: "bf1",
        ...okResult,
        context: "tab",
        tabOrigin: APP,
      });
    });

    it("leaves credentials undefined so the page function defaults to same-origin, and forwards an explicit one", async () => {
      await handler.handleDecodedMessage(req({ tabId: 7 }));
      expect(executeScript().mock.calls[0][0].args[0].credentials).toBeUndefined();

      executeScript().mockClear();
      await handler.handleDecodedMessage(req({ tabId: 7, credentials: "include", redirect: "manual" }));
      const args = executeScript().mock.calls[0][0].args[0];
      expect(args.credentials).toBe("include");
      expect(args.redirect).toBe("manual");
    });

    it("resolves a relative URL against the TAB URL, host included", async () => {
      await handler.handleDecodedMessage(req({ tabId: 7, url: "/api/v2/x?y=1" }));
      expect(executeScript().mock.calls[0][0].args[0].url).toBe(`${APP}/api/v2/x?y=1`);

      executeScript().mockClear();
      await handler.handleDecodedMessage(req({ tabId: 7, url: "//other.example.test/z" }));
      expect(executeScript().mock.calls[0][0].args[0].url).toBe("https://other.example.test/z");
    });

    it("passes the already-resolved absolute URL, so the page cannot resolve it differently (a <base> tag)", async () => {
      await handler.handleDecodedMessage(req({ tabId: 7, url: "rel/path" }));
      expect(executeScript().mock.calls[0][0].args[0].url).toBe(`${APP}/rel/path`);
    });

    it("does not ask for permission on the TARGET origin: the page makes the request, the tab needs the grant", async () => {
      (browser.permissions.contains as jest.Mock).mockImplementation(
        async ({ origins }: { origins: string[] }) => origins.includes(`${APP}/*`)
      );
      await handler.handleDecodedMessage(req({ tabId: 7, url: "https://api.other.test/data" }));
      expect(executeScript()).toHaveBeenCalledTimes(1);
      expect(browser.permissions.contains).toHaveBeenCalledTimes(1);
      expect(browser.permissions.contains).toHaveBeenCalledWith({ origins: [`${APP}/*`] });
    });

    it("surfaces a failed injection as ok:false with context:tab, not as a throw", async () => {
      executeScript().mockRejectedValue(new Error("Cannot access contents of the page."));
      await handler.handleDecodedMessage(req({ tabId: 7 }));
      const reply = transport.sendResourceToServer.mock.calls[0][0] as any;
      expect(reply).toMatchObject({
        resource: "browser-fetch-result",
        ok: false,
        context: "tab",
        tabOrigin: APP,
      });
      expect(reply.error).toContain("Cannot access contents of the page.");
      expect(reply.error).toContain("tab 7");
    });

    it("does not leak the tab URL (query, fragment) from the browser's refusal text", async () => {
      // Observed in Chromium 140: the refusal embeds the WHOLE tab URL.
      executeScript().mockRejectedValue(
        new Error(
          'Cannot access contents of url "https://app.example.test/cb?access_token=fake-token-123#id_token=fake-jwt-abc". ' +
            "Extension manifest must request permission to access this host."
        )
      );
      await handler.handleDecodedMessage(req({ tabId: 7 }));
      const reply = transport.sendResourceToServer.mock.calls[0][0] as any;
      expect(reply.ok).toBe(false);
      expect(reply.error).not.toContain("fake-token-123");
      expect(reply.error).not.toContain("fake-jwt-abc");
      expect(reply.error).toContain("tab 7");
    });

    it("says so when the page returns no result (navigated away mid-request)", async () => {
      executeScript().mockResolvedValue([]);
      await handler.handleDecodedMessage(req({ tabId: 7 }));
      const reply = transport.sendResourceToServer.mock.calls[0][0] as any;
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/no result.*navigated/s);
      expect(reply.context).toBe("tab");
    });

    it("relays a page-side failure (CORS, aborted) unchanged", async () => {
      executeScript().mockResolvedValue([{ result: { ok: false, error: "Failed to fetch (CORS)" } }]);
      await handler.handleDecodedMessage(req({ tabId: 7 }));
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "browser-fetch-result",
        correlationId: "bf1",
        ok: false,
        error: "Failed to fetch (CORS)",
        context: "tab",
        tabOrigin: APP,
      });
    });

    it("the real injected function runs through the handler (stubbed page fetch)", async () => {
      // jsdom's own origin is http://localhost, so point the tab there.
      (browser.tabs.get as jest.Mock).mockResolvedValue({ id: 7, url: "http://localhost/page" });
      const pageFetch = jest.fn().mockResolvedValue({
        status: 403,
        statusText: "Forbidden",
        url: "http://localhost/api/thing",
        headers: { forEach: () => {}, get: () => null },
        body: null,
        arrayBuffer: async () => new ArrayBuffer(0),
      });
      (global as any).fetch = pageFetch;
      executeScript().mockImplementation(async (inj: any) => [{ result: await inj.func(...inj.args) }]);

      await handler.handleDecodedMessage(req({ tabId: 7, url: "/api/thing" }));

      expect(pageFetch).toHaveBeenCalledTimes(1);
      expect(pageFetch.mock.calls[0][0]).toBe("http://localhost/api/thing");
      expect(pageFetch.mock.calls[0][1].credentials).toBe("same-origin");
      expect(transport.sendResourceToServer).toHaveBeenCalledWith({
        resource: "browser-fetch-result",
        correlationId: "bf1",
        ok: true,
        status: 403,
        statusText: "Forbidden",
        headers: {},
        finalUrl: "http://localhost/api/thing",
        truncated: false,
        bodyBase64: "",
        context: "tab",
        tabOrigin: "http://localhost",
      });
    });
  });

  describe("gating", () => {
    it("denies a tab whose URL is on the deny list, before injecting anything", async () => {
      config.domainDenyList = ["app.example.test"];
      await expect(handler.handleDecodedMessage(req({ tabId: 7 }))).rejects.toThrow(/deny list/);
      expect(executeScript()).not.toHaveBeenCalled();
      expect(browser.permissions.contains).not.toHaveBeenCalled();
    });

    it("denies a TARGET URL on the deny list even when the tab itself is allowed", async () => {
      config.domainDenyList = ["blocked.example.test"];
      await expect(
        handler.handleDecodedMessage(req({ tabId: 7, url: "https://api.blocked.example.test/x" }))
      ).rejects.toThrow(/deny list/);
      expect(executeScript()).not.toHaveBeenCalled();
    });

    it("checks the deny list on the target AFTER resolving a relative URL against the tab", async () => {
      // `//host/path` is protocol-relative: it changes the host, and must be caught.
      config.domainDenyList = ["blocked.example.test"];
      await expect(
        handler.handleDecodedMessage(req({ tabId: 7, url: "//blocked.example.test/x" }))
      ).rejects.toThrow(/deny list/);
      expect(executeScript()).not.toHaveBeenCalled();
    });

    it("needs host permission on the TAB URL: a missing grant is reported (Automation Mode on: the all-sites dialog) and nothing is injected", async () => {
      (browser.permissions.contains as jest.Mock).mockResolvedValue(false);
      await expect(handler.handleDecodedMessage(req({ tabId: 7 }))).rejects.toThrow(
        /Automation Mode is on.*all sites/s
      );
      expect(browser.permissions.contains).toHaveBeenCalledWith({ origins: [`${APP}/*`] });
      expect(executeScript()).not.toHaveBeenCalled();
    });

    it.each([
      ["chrome://settings/", /chrome: page/],
      ["about:blank", /about: page/],
      ["chrome-extension://abcdefghijklmnop/options.html", /chrome-extension: page/],
      ["file:///tmp/page.html", /file: page/],
      ["view-source:https://app.example.test/", /view-source: page/],
    ])("a %s tab gets a clear error and never reaches the permission lookup or the injection", async (url, msg) => {
      (browser.tabs.get as jest.Mock).mockResolvedValue({ id: 7, url });
      await expect(handler.handleDecodedMessage(req({ tabId: 7 }))).rejects.toThrow(msg);
      await expect(handler.handleDecodedMessage(req({ tabId: 7 }))).rejects.toThrow(
        /http\(s\) page|without tabId/
      );
      expect(browser.permissions.contains).not.toHaveBeenCalled();
      expect(browser.tabs.create).not.toHaveBeenCalled();
      expect(executeScript()).not.toHaveBeenCalled();
    });

    it("a tab with no readable URL gets a clear error", async () => {
      (browser.tabs.get as jest.Mock).mockResolvedValue({ id: 7 });
      await expect(handler.handleDecodedMessage(req({ tabId: 7 }))).rejects.toThrow(
        /no URL the extension can read/
      );
      expect(executeScript()).not.toHaveBeenCalled();
    });

    it("an unresolvable URL is an error, not a fetch", async () => {
      await expect(
        handler.handleDecodedMessage(req({ tabId: 7, url: "http://" }))
      ).rejects.toThrow(/Invalid URL/);
      expect(executeScript()).not.toHaveBeenCalled();
    });

    it("keeps the Automation Mode gate: off means refused, nothing injected", async () => {
      config.automationMode = false;
      await expect(handler.handleDecodedMessage(req({ tabId: 7 }))).rejects.toThrow(
        /requires Automation Mode/
      );
      expect(executeScript()).not.toHaveBeenCalled();
    });

    it("keeps the tool toggle: a disabled Browser Fetch refuses tab mode too", async () => {
      config.toolSettings = { "browser-fetch": false };
      await expect(handler.handleDecodedMessage(req({ tabId: 7 }))).rejects.toThrow(
        /disabled in extension settings/
      );
      expect(executeScript()).not.toHaveBeenCalled();
    });
  });

  describe("timeout (raced from the service worker, never a page timer)", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    function hangFetchOnly() {
      executeScript().mockImplementation((inj: any) =>
        inj.func === abortFetchInTab ? Promise.resolve([{ result: true }]) : new Promise(() => {})
      );
    }

    it("returns a clear error at timeoutMs, aborts the request in the page and leaves no timer behind", async () => {
      hangFetchOnly();
      const done = handler.handleDecodedMessage(req({ tabId: 7, timeoutMs: 5000 }));
      await jest.advanceTimersByTimeAsync(4999);
      expect(transport.sendResourceToServer).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await done;

      const reply = transport.sendResourceToServer.mock.calls[0][0] as any;
      expect(reply).toMatchObject({ ok: false, context: "tab", tabOrigin: APP });
      expect(reply.error).toMatch(/Timed out after 5000 ms/);
      expect(reply.error).toMatch(/may already have received it/);

      // The page-side request is cancelled, by the id the fetch was started with.
      const calls = executeScript().mock.calls.map((c) => c[0]);
      const fetchCall = calls.find((c) => c.func === fetchInTab);
      const abortCall = calls.find((c) => c.func === abortFetchInTab);
      expect(abortCall).toBeDefined();
      expect(abortCall.world).toBe("ISOLATED");
      expect(abortCall.args).toEqual([fetchCall.args[0].requestId]);
      expect(jest.getTimerCount()).toBe(0);
    });

    it("a stuck abort cannot hold the reply back", async () => {
      executeScript().mockImplementation(() => new Promise(() => {}));
      const done = handler.handleDecodedMessage(req({ tabId: 7, timeoutMs: 1000 }));
      await jest.advanceTimersByTimeAsync(1000);
      await done;
      expect(transport.sendResourceToServer).toHaveBeenCalledTimes(1);
    });

    it("a request that finishes in time clears its timer", async () => {
      await handler.handleDecodedMessage(req({ tabId: 7, timeoutMs: 20000 }));
      expect(transport.sendResourceToServer.mock.calls[0][0]).toMatchObject({ ok: true });
      expect(jest.getTimerCount()).toBe(0);
    });

    it("defaults to the background path's 30 s and caps a longer ask below the broker's 45 s budget", async () => {
      expect(TAB_FETCH_DEFAULT_TIMEOUT_MS).toBe(30000);
      // mcp-server/timeouts.ts gives browser-fetch 45000 ms for the whole call.
      expect(TAB_FETCH_MAX_TIMEOUT_MS).toBeLessThan(45000);

      hangFetchOnly();
      const done = handler.handleDecodedMessage(req({ tabId: 7, timeoutMs: 120000 }));
      await jest.advanceTimersByTimeAsync(TAB_FETCH_MAX_TIMEOUT_MS - 1);
      expect(transport.sendResourceToServer).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await done;
      expect((transport.sendResourceToServer.mock.calls[0][0] as any).error).toContain(
        `Timed out after ${TAB_FETCH_MAX_TIMEOUT_MS} ms`
      );
    });

    it("uses 30 s when timeoutMs is omitted", async () => {
      hangFetchOnly();
      const done = handler.handleDecodedMessage(req({ tabId: 7 }));
      await jest.advanceTimersByTimeAsync(29999);
      expect(transport.sendResourceToServer).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await done;
      expect((transport.sendResourceToServer.mock.calls[0][0] as any).error).toContain(
        "Timed out after 30000 ms"
      );
    });
  });

  describe("without tabId (background path)", () => {
    it("still fetches from the background, gates on the target URL, and now says context:background", async () => {
      (global as any).fetch = jest.fn().mockResolvedValue({
        status: 200,
        statusText: "OK",
        url: `${APP}/api/v1/things`,
        headers: new Headers({ "content-type": "text/plain" }),
        arrayBuffer: async () => new TextEncoder().encode("hi").buffer,
      });
      await handler.handleDecodedMessage(req({}));

      expect((global as any).fetch).toHaveBeenCalledTimes(1);
      expect(executeScript()).not.toHaveBeenCalled();
      expect(browser.tabs.get).not.toHaveBeenCalled();
      expect(browser.permissions.contains).toHaveBeenCalledWith({ origins: [`${APP}/*`] });
      const reply = transport.sendResourceToServer.mock.calls[0][0] as any;
      expect(reply).toMatchObject({
        resource: "browser-fetch-result",
        ok: true,
        status: 200,
        bodyText: "hi",
        context: "background",
      });
      expect(reply.tabOrigin).toBeUndefined();
    });

    it("a failed background fetch also says context:background", async () => {
      (global as any).fetch = jest.fn().mockRejectedValue(new TypeError("Failed to fetch"));
      await handler.handleDecodedMessage(req({}));
      expect(transport.sendResourceToServer.mock.calls[0][0]).toMatchObject({
        ok: false,
        context: "background",
      });
    });

    it("still refuses a denied target URL", async () => {
      config.domainDenyList = ["app.example.test"];
      await expect(handler.handleDecodedMessage(req({}))).rejects.toThrow(/deny list/);
      expect((global as any).fetch).not.toHaveBeenCalled();
    });
  });

  describe("audit log", () => {
    async function flush() {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    }

    it("a tab-mode fetch records the tab URL AND the fetched URL (a relative one resolved)", async () => {
      await handler.handleDecodedMessage(req({ tabId: 7, url: "/api/v1/things" }));
      await flush();
      expect(config.auditLog).toHaveLength(1);
      expect(config.auditLog[0]).toMatchObject({
        toolId: "browser-fetch",
        command: "browser-fetch",
        url: `${APP}/dashboard?x=1#frag`,
        targetUrl: `${APP}/api/v1/things`,
      });
    });

    it("a background fetch keeps recording the fetched URL as `url`, with no targetUrl", async () => {
      (global as any).fetch = jest.fn().mockRejectedValue(new Error("x"));
      await handler.handleDecodedMessage(req({}));
      await flush();
      expect(config.auditLog[0].url).toBe(`${APP}/api/v1/things`);
      expect(config.auditLog[0].targetUrl).toBeUndefined();
    });
  });
});
