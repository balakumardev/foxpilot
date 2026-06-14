import { ensureConnected, initKeepalive, KEEPALIVE_ALARM_NAME } from "../keepalive";

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
