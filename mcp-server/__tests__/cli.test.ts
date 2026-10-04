import * as childProcess from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BrokerServer } from "../broker";
import { CliIo, isCliInvocation, runCli } from "../cli";
import { readLinkConfig, writeLinkConfig } from "../link-config";
import { parseLinkToken } from "../link-crypto";
import { LinkHost } from "../link-host";
import { RelayServer } from "../relay-server";
import { FOXPILOT_VERSION } from "../version";

jest.mock("child_process", () => {
  const actual = jest.requireActual("child_process");
  return {
    ...actual,
    spawn: jest.fn(() => ({ unref: jest.fn() })),
  };
});
const spawnMock = childProcess.spawn as jest.Mock;

function makeIo(): CliIo & {
  stdout: string[];
  stderr: string[];
  outStr: () => string;
  errStr: () => string;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (line: string) => stdout.push(line),
    err: (line: string) => stderr.push(line),
    outStr: () => stdout.join("\n"),
    errStr: () => stderr.join("\n"),
  };
}

describe("CLI (runCli & isCliInvocation)", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let origSecret: string | undefined;
  let origPort: string | undefined;
  let relay: RelayServer;
  let relayPort: number;
  let relayUrl: string;
  let broker: BrokerServer;
  let brokerPort: number;
  let linkHost: LinkHost;
  let shutdownCalled: boolean;

  beforeEach(async () => {
    spawnMock.mockClear();
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "foxpilot-cli-test-"));
    origHome = process.env.HOME;
    origSecret = process.env.EXTENSION_SECRET;
    origPort = process.env.EXTENSION_PORT;

    process.env.HOME = tempHome;
    process.env.EXTENSION_SECRET = "test-secret-foxpilot-123456";

    relay = new RelayServer({ port: 0 });
    await relay.listen();
    relayPort = relay.getPort();
    relayUrl = `ws://127.0.0.1:${relayPort}`;

    shutdownCalled = false;
    broker = new BrokerServer({
      port: 0,
      host: "127.0.0.1",
      secret: process.env.EXTENSION_SECRET,
      onShutdown: () => {
        shutdownCalled = true;
        broker.close();
      },
    });
    await broker.listen();
    brokerPort = broker.getPort();
    process.env.EXTENSION_PORT = String(brokerPort);

    linkHost = new LinkHost({
      broker,
      version: FOXPILOT_VERSION,
      reconnectMinMs: 50,
      reconnectMaxMs: 200,
      handshakeTimeoutMs: 1000,
      pingIntervalMs: 1000,
      deadAfterMs: 3000,
    });

    broker.setLinkController({
      status: () => linkHost.status(),
      reload: () => {
        linkHost.apply(readLinkConfig(path.join(tempHome, ".foxpilot")));
        broker.refreshIdle();
        return linkHost.status();
      },
      turnOff: () => {
        const config = readLinkConfig(path.join(tempHome, ".foxpilot"));
        if (config) {
          try {
            writeLinkConfig(
              { ...config, enabled: false },
              path.join(tempHome, ".foxpilot")
            );
          } catch {
            /* ignore */
          }
        }
        linkHost.apply(null);
        broker.refreshIdle();
        return linkHost.status();
      },
      isActive: () => linkHost.isActive(),
    });

    linkHost.apply(readLinkConfig(path.join(tempHome, ".foxpilot")));
  });

  afterEach(async () => {
    linkHost?.apply(null);
    await broker?.close();
    await relay?.close();

    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;

    if (origSecret !== undefined) process.env.EXTENSION_SECRET = origSecret;
    else delete process.env.EXTENSION_SECRET;

    if (origPort !== undefined) process.env.EXTENSION_PORT = origPort;
    else delete process.env.EXTENSION_PORT;

    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("isCliInvocation table", () => {
    expect(isCliInvocation([])).toBe(false);
    expect(isCliInvocation(["link"])).toBe(true);
    expect(isCliInvocation(["relay"])).toBe(true);
    expect(isCliInvocation(["broker"])).toBe(true);
    expect(isCliInvocation(["help"])).toBe(true);
    expect(isCliInvocation(["--help"])).toBe(true);
    expect(isCliInvocation(["-h"])).toBe(true);
    expect(isCliInvocation(["version"])).toBe(true);
    expect(isCliInvocation(["--version"])).toBe(true);
    expect(isCliInvocation(["-v"])).toBe(true);
    expect(isCliInvocation(["--unknown-flag"])).toBe(false);
    expect(isCliInvocation(["some-other-arg"])).toBe(false);
  });

  it("link turns on remote link, writes 0600 link.json, and connects to relay", async () => {
    const io = makeIo();
    const code = await runCli(["link", "--relay", relayUrl], io);
    expect(code).toBe(0);
    expect(spawnMock).not.toHaveBeenCalled();

    const out = io.outStr();
    expect(out).toContain("FoxPilot remote link is ON");
    expect(out).toContain("(connected)");

    const match = out.match(/FOXPILOT_LINK=([^\s]+)/);
    expect(match).not.toBeNull();
    const token = match![1];

    const parsed = parseLinkToken(token);
    expect(parsed.relayUrl).toBe(relayUrl);

    const configFile = path.join(tempHome, ".foxpilot", "link.json");
    expect(fs.existsSync(configFile)).toBe(true);
    const stat = fs.statSync(configFile);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("link token prints exactly that token", async () => {
    const ioSetup = makeIo();
    await runCli(["link", "--relay", relayUrl], ioSetup);
    const match = ioSetup.outStr().match(/FOXPILOT_LINK=([^\s]+)/);
    const expectedToken = match![1];

    const ioToken = makeIo();
    const code = await runCli(["link", "token"], ioToken);
    expect(code).toBe(0);
    expect(ioToken.stdout).toEqual([expectedToken]);
  });

  it("link status shows on + relay connected and does not contain the token", async () => {
    const ioSetup = makeIo();
    await runCli(["link", "--relay", relayUrl], ioSetup);
    const match = ioSetup.outStr().match(/FOXPILOT_LINK=([^\s]+)/);
    const token = match![1];

    const ioStatus = makeIo();
    const code = await runCli(["link", "status"], ioStatus);
    expect(code).toBe(0);
    const out = ioStatus.outStr();
    expect(out).toContain("FoxPilot remote link is ON");
    expect(out).toContain("(connected)");
    expect(out).not.toContain(token);
  });

  it("link rotate prints a different token and replaces the secret in link.json", async () => {
    const ioSetup = makeIo();
    await runCli(["link", "--relay", relayUrl], ioSetup);
    const match1 = ioSetup.outStr().match(/FOXPILOT_LINK=([^\s]+)/);
    const token1 = match1![1];
    const config1 = readLinkConfig(path.join(tempHome, ".foxpilot"))!;

    const ioRotate = makeIo();
    const code = await runCli(["link", "rotate"], ioRotate);
    expect(code).toBe(0);

    const out = ioRotate.outStr();
    expect(out).toContain("The old token no longer works.");
    const match2 = out.match(/FOXPILOT_LINK=([^\s]+)/);
    expect(match2).not.toBeNull();
    const token2 = match2![1];
    expect(token2).not.toBe(token1);

    const config2 = readLinkConfig(path.join(tempHome, ".foxpilot"))!;
    expect(config2.secret).not.toBe(config1.secret);
    expect(
      fs.readFileSync(path.join(tempHome, ".foxpilot", "link.json"), "utf8")
    ).not.toContain(config1.secret);
  });

  it("link off turns off remote link and updates broker link-status to enabled:false", async () => {
    const ioSetup = makeIo();
    await runCli(["link", "--relay", relayUrl], ioSetup);

    const ioOff = makeIo();
    const code = await runCli(["link", "off"], ioOff);
    expect(code).toBe(0);
    expect(ioOff.outStr()).toContain("FoxPilot remote link is OFF");

    const status = linkHost.status();
    expect(status.enabled).toBe(false);

    const ioStatus = makeIo();
    await runCli(["link", "status"], ioStatus);
    expect(ioStatus.outStr()).toContain("FoxPilot remote link is OFF");
  });

  it("rejects disallowed relay URL with exit 2", async () => {
    const io = makeIo();
    const code = await runCli(["link", "--relay", "ws://8.8.8.8:1"], io);
    expect(code).toBe(2);
    expect(io.errStr()).toContain("wss:// is required outside private networks");
  });

  it("broker status prints the version", async () => {
    const io = makeIo();
    const code = await runCli(["broker", "status"], io);
    expect(code).toBe(0);
    expect(io.outStr()).toContain(FOXPILOT_VERSION);
  });

  it("broker stop triggers the BrokerServer's onShutdown", async () => {
    const io = makeIo();
    const code = await runCli(["broker", "stop"], io);
    expect(code).toBe(0);
    expect(shutdownCalled).toBe(true);
    expect(io.outStr()).toContain(
      `Stopped the FoxPilot broker on port ${brokerPort}`
    );
  });

  it("link with an older broker (no link controller) exits 1 and prints the kill command", async () => {
    broker.setLinkController(null);

    const io = makeIo();
    const code = await runCli(["link", "--relay", relayUrl], io);
    expect(code).toBe(1);

    const isWin = process.platform === "win32";
    const expectedKill = isWin
      ? `findstr :${brokerPort}`
      : `lsof -nP -iTCP:${brokerPort} -sTCP:LISTEN -t | xargs kill`;
    expect(io.errStr()).toContain(expectedKill);
    expect(io.errStr()).toContain("npx foxpilot-mcp link");
  });

  it("relay --port 0 starts and stops when aborted", async () => {
    const io = makeIo();
    const ac = new AbortController();
    const promise = runCli(["relay", "--port", "0"], io, undefined, ac.signal);

    let printed = false;
    for (let i = 0; i < 50; i++) {
      if (io.outStr().includes("FoxPilot relay listening on ws://127.0.0.1:")) {
        printed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(printed).toBe(true);

    ac.abort();
    const code = await promise;
    expect(code).toBe(0);
  });

  it("version prints FOXPILOT_VERSION", async () => {
    const io = makeIo();
    const code = await runCli(["version"], io);
    expect(code).toBe(0);
    expect(io.stdout).toEqual([FOXPILOT_VERSION]);
  });

  it("unknown command or flag exits with code 2", async () => {
    const io1 = makeIo();
    const code1 = await runCli(["unknown-command"], io1);
    expect(code1).toBe(2);
    expect(io1.errStr()).toContain("Unknown command");

    const io2 = makeIo();
    const code2 = await runCli(["link", "--unknown-flag"], io2);
    expect(code2).toBe(2);
    expect(io2.errStr()).toContain("Unknown flag");

    const io3 = makeIo();
    const code3 = await runCli(["broker", "unknown-sub"], io3);
    expect(code3).toBe(2);
    expect(io3.errStr()).toContain("Unknown broker subcommand");
  });
});
