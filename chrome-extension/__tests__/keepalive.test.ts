import { ensureConnected, initKeepalive, KEEPALIVE_ALARM_NAME } from "../keepalive";
import { LongPollClient } from "../longpoll-client";

interface FakeClient {
  isClosed(): boolean;
  connect: jest.Mock;
  ping: jest.Mock;
}

function makeClient(closed: boolean): FakeClient {
  return {
    isClosed: () => closed,
    connect: jest.fn(),
    ping: jest.fn(),
  };
}

describe("ensureConnected", () => {
  it("reconnects a closed client and does NOT ping it", () => {
    const client = makeClient(true);
    ensureConnected(client);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.ping).not.toHaveBeenCalled();
  });

  it("pings an open client and does NOT reconnect it", () => {
    const client = makeClient(false);
    ensureConnected(client);
    expect(client.connect).not.toHaveBeenCalled();
    expect(client.ping).toHaveBeenCalledTimes(1);
  });
});

describe("initKeepalive", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("creates a sub-minute periodic alarm and wires an onAlarm listener", () => {
    initKeepalive(() => []);
    expect(browser.alarms.create).toHaveBeenCalledTimes(1);
    const [name, info] = (browser.alarms.create as jest.Mock).mock.calls[0];
    expect(name).toBe(KEEPALIVE_ALARM_NAME);
    expect(info.periodInMinutes).toBeGreaterThan(0);
    expect(info.periodInMinutes).toBeLessThanOrEqual(0.5);
    expect(browser.alarms.onAlarm.addListener).toHaveBeenCalledTimes(1);
  });

  it("on the keepalive alarm, ensures every supplied client is connected", () => {
    const closed = makeClient(true);
    const open = makeClient(false);
    initKeepalive(() => [closed, open]);
    const handler = (browser.alarms.onAlarm.addListener as jest.Mock).mock.calls[0][0];

    handler({ name: KEEPALIVE_ALARM_NAME });
    expect(closed.connect).toHaveBeenCalledTimes(1);
    expect(open.ping).toHaveBeenCalledTimes(1);
  });

  it("ignores unrelated alarms", () => {
    const client = makeClient(true);
    initKeepalive(() => [client]);
    const handler = (browser.alarms.onAlarm.addListener as jest.Mock).mock.calls[0][0];

    handler({ name: "some-other-alarm" });
    expect(client.connect).not.toHaveBeenCalled();
  });
});

// Regression: the long-poll transport must satisfy the keepalive contract.
// Before this, LongPollClient lacked isClosed()/ping(), so an alarm tick over a
// long-poll client threw "client.isClosed is not a function" at runtime.
describe("LongPollClient keepalive safety", () => {
  it("reports not-closed and a no-op ping that never throws", () => {
    const client = new LongPollClient(9999, "test-secret");
    expect(client.isClosed()).toBe(false);
    expect(() => client.ping()).not.toThrow();
  });

  it("ensureConnected on a long-poll client runs without throwing and does NOT reconnect", () => {
    const client = new LongPollClient(9999, "test-secret");
    // Stub connect so a (regressed) reconnect would be observable and would not
    // start a real fetch poll loop in the test environment.
    const connectSpy = jest.spyOn(client, "connect").mockImplementation(() => {});

    expect(() => ensureConnected(client)).not.toThrow();
    // Reports not-closed, so keepalive must ping, not reconnect.
    expect(connectSpy).not.toHaveBeenCalled();
  });
});
