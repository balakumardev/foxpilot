import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  createLinkConfig,
  linkConfigPath,
  linkSecret,
  linkToken,
  readLinkConfig,
  writeLinkConfig,
} from "../link-config";
import { parseLinkToken } from "../link-crypto";
import { DEFAULT_RELAY_URL } from "../relay-protocol";

describe("link-config", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "link-config-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("round-trips in a temp directory with 0600 file mode", () => {
    const config = createLinkConfig();
    writeLinkConfig(config, tempDir);

    const read = readLinkConfig(tempDir);
    expect(read).toEqual(config);

    const filePath = linkConfigPath(tempDir);
    const stat = fs.statSync(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("returns null when file is absent, unreadable, or invalid", () => {
    expect(readLinkConfig(tempDir)).toBeNull();

    const filePath = linkConfigPath(tempDir);

    // Invalid JSON
    fs.writeFileSync(filePath, "not a json", { mode: 0o600 });
    expect(readLinkConfig(tempDir)).toBeNull();

    // Valid JSON but not an object
    fs.writeFileSync(filePath, JSON.stringify(["not an object"]), { mode: 0o600 });
    expect(readLinkConfig(tempDir)).toBeNull();

    const base = createLinkConfig();

    // Unsupported version
    fs.writeFileSync(
      filePath,
      JSON.stringify({ ...base, version: 2 }),
      { mode: 0o600 }
    );
    expect(readLinkConfig(tempDir)).toBeNull();

    // Secret too short
    fs.writeFileSync(
      filePath,
      JSON.stringify({ ...base, secret: Buffer.alloc(16).toString("base64url") }),
      { mode: 0o600 }
    );
    expect(readLinkConfig(tempDir)).toBeNull();

    // Secret with padding or invalid characters
    fs.writeFileSync(
      filePath,
      JSON.stringify({ ...base, secret: Buffer.alloc(32).toString("base64") }), // base64 has padding '=' or '+/'
      { mode: 0o600 }
    );
    expect(readLinkConfig(tempDir)).toBeNull();

    // Disallowed relay URL
    fs.writeFileSync(
      filePath,
      JSON.stringify({ ...base, relayUrl: "ws://public-unencrypted.com" }),
      { mode: 0o600 }
    );
    expect(readLinkConfig(tempDir)).toBeNull();

    // Invalid createdAt
    fs.writeFileSync(
      filePath,
      JSON.stringify({ ...base, createdAt: "invalid-date" }),
      { mode: 0o600 }
    );
    expect(readLinkConfig(tempDir)).toBeNull();
  });

  it("createLinkConfig provides defaults and validates custom relayUrl", () => {
    const config = createLinkConfig();
    expect(config.version).toBe(1);
    expect(config.enabled).toBe(true);
    expect(config.relayUrl).toBe(DEFAULT_RELAY_URL);
    expect(Buffer.from(config.secret, "base64url").length).toBe(32);
    expect(Date.parse(config.createdAt)).toBeGreaterThan(0);

    const custom = createLinkConfig("wss://custom-relay.example.com");
    expect(custom.relayUrl).toBe("wss://custom-relay.example.com");

    expect(() => createLinkConfig("ws://not-allowed.example.com")).toThrow(
      /Disallowed relay URL/
    );
  });

  it("linkSecret extracts a 32-byte Buffer or throws on invalid", () => {
    const config = createLinkConfig();
    const secret = linkSecret(config);
    expect(Buffer.isBuffer(secret)).toBe(true);
    expect(secret.length).toBe(32);
    expect(secret.toString("base64url")).toBe(config.secret);

    expect(() =>
      linkSecret({ ...config, secret: "too-short" })
    ).toThrow();
  });

  it("linkToken parses back with parseLinkToken", () => {
    const config = createLinkConfig();
    const token = linkToken(config);
    const parsed = parseLinkToken(token);

    expect(parsed.secret.equals(linkSecret(config))).toBe(true);
    expect(parsed.relayUrl).toBe(config.relayUrl);
  });
});
