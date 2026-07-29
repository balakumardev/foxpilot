/**
 * Tests for the HTTP long-poll transport's secret handling.
 *
 * Long-poll is signed-only: every request is authed with an HMAC of the shared
 * secret, and getMessageSignature() THROWS on an empty secret. Under the
 * zero-config default (no secret) the poll loop must NOT spin a throw/retry
 * loop — connect() must refuse up front with a clear "blocked" state and never
 * touch the network.
 */
import { LongPollClient } from "../longpoll-client";
import type { ConnectionState, ConnectionStateDetail } from "../transport";

describe("LongPollClient secret handling", () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    // A resolving fetch so the poll loop (signed case) can take one turn without
    // a real network. The no-secret case must never reach this.
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ requests: [] }),
    });
    (global as any).fetch = fetchMock;
    // Identity for buildHello (read by getOrCreateBrowserId/getBrowserLabel).
    (browser.storage.local.get as jest.Mock).mockResolvedValue({
      config: {
        secret: "",
        ports: [8089],
        browserId: "bid-1",
        browserLabel: "My Chrome",
      },
    });
    (browser as any).runtime.getBrowserInfo = undefined; // chrome
  });

  it("refuses to poll with no secret: reports blocked(longpoll-requires-secret) and makes no request", async () => {
    const events: { state: ConnectionState; detail?: ConnectionStateDetail }[] =
      [];
    const client = new LongPollClient(8089, "", (state, detail) =>
      events.push({ state, detail })
    );

    client.connect();
    // Let any (erroneously scheduled) async poll work attempt to run.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const blocked = events.find((e) => e.state === "blocked");
    expect(blocked).toBeDefined();
    expect(blocked!.detail?.reason).toBe("longpoll-requires-secret");
    // The poll loop must never have started — no network call at all.
    expect(fetchMock).not.toHaveBeenCalled();

    client.disconnect();
  });

  it("does NOT throw from connect() when the secret is empty", () => {
    const client = new LongPollClient(8089, "");
    // getMessageSignature would throw on an empty secret; connect() must guard
    // against ever calling it, so this is a clean no-throw.
    expect(() => client.connect()).not.toThrow();
    client.disconnect();
  });

  it("starts polling when a secret IS configured", async () => {
    const client = new LongPollClient(8089, "shared");
    client.connect();
    // The loop POSTs a signed hello then GETs /poll. Wait on the CONDITION,
    // not on a fixed number of event-loop turns: the chain includes a real
    // crypto.subtle HMAC, so a turn count races it and flaked roughly 1 run in
    // 5 under a loaded suite. A deadline still fails honestly if polling never
    // starts — it only stops the assertion from firing before the work could
    // possibly have run.
    const deadline = Date.now() + 5000;
    while (fetchMock.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(fetchMock).toHaveBeenCalled();
    client.disconnect();
  });
});
