import WebSocket from "ws";
import * as net from "net";
import { BrokerServer } from "../broker";

const SECRET = "control-secret";

/** An unsigned hello carrying a chrome-extension origin (zero-config admission path). */
function unsignedHello(browserId: string): string {
  const payload = {
    type: "hello",
    browserId,
    browserType: "chrome",
    label: "Chrome",
  };
  return JSON.stringify({ payload });
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<any> {
  return new Promise((resolve) =>
    ws.once("message", (d) => resolve(JSON.parse(d.toString())))
  );
}

/**
 * Detect whether this host actually has an IPv6 loopback we can bind/connect to.
 * Some CI sandboxes lack ::1; in that case we skip ONLY the ::1 leg of the test
 * (the 127.0.0.1 leg must always pass).
 */
function hasIpv6Loopback(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(0, "::1", () => {
      s.close(() => resolve(true));
    });
  });
}

/** Connect, send an origin hello, and assert a `welcome` comes back. */
async function expectWelcome(url: string, browserId: string): Promise<void> {
  const ext = new WebSocket(url, {
    origin: "chrome-extension://abcdefghijklmnop",
  });
  try {
    await waitOpen(ext);
    const welcomePromise = nextMessage(ext);
    ext.send(unsignedHello(browserId));
    const welcome = await welcomePromise;
    expect(welcome).toMatchObject({ type: "welcome", browserId });
  } finally {
    try {
      ext.close();
    } catch {
      /* ignore */
    }
  }
}

describe("BrokerServer dual-stack loopback bind (host: localhost)", () => {
  let server: BrokerServer;
  let port: number;

  beforeEach(async () => {
    server = new BrokerServer({ port: 0, host: "localhost", secret: SECRET });
    await server.listen();
    port = server.getPort();
  });

  afterEach(() => {
    try {
      server.close();
    } catch {
      /* ignore */
    }
  });

  it("accepts a WS connection on the IPv4 loopback (127.0.0.1)", async () => {
    await expectWelcome(`ws://127.0.0.1:${port}/extension`, "dual-ipv4");
  }, 10000);

  it("accepts a WS connection on the IPv6 loopback ([::1]) when available", async () => {
    if (!(await hasIpv6Loopback())) {
      // eslint-disable-next-line no-console
      console.warn(
        "[broker-dual-stack] IPv6 loopback (::1) unavailable in this environment; skipping the ::1 leg."
      );
      return;
    }
    await expectWelcome(`ws://[::1]:${port}/extension`, "dual-ipv6");
  }, 10000);
});
