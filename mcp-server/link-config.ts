import * as fs from "fs";
import * as path from "path";
import { ensureFoxpilotDir, foxpilotDir } from "./control-secret";
import { formatLinkToken, generateLinkSecret } from "./link-crypto";
import { DEFAULT_RELAY_URL, isAllowedRelayUrl } from "./relay-protocol";

export interface LinkConfig {
  version: 1;
  enabled: boolean;
  secret: string;
  relayUrl: string;
  createdAt: string;
}

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export function linkConfigPath(dir?: string): string {
  return path.join(dir ?? foxpilotDir(), "link.json");
}

export function readLinkConfig(dir?: string): LinkConfig | null {
  try {
    const file = linkConfigPath(dir);
    if (!fs.existsSync(file)) {
      return null;
    }
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      parsed.version !== 1 ||
      typeof parsed.enabled !== "boolean" ||
      typeof parsed.secret !== "string" ||
      typeof parsed.relayUrl !== "string" ||
      typeof parsed.createdAt !== "string"
    ) {
      return null;
    }

    if (!B64URL_RE.test(parsed.secret)) {
      return null;
    }
    const secretBuf = Buffer.from(parsed.secret, "base64url");
    if (secretBuf.length !== 32 || secretBuf.toString("base64url") !== parsed.secret) {
      return null;
    }

    if (!isAllowedRelayUrl(parsed.relayUrl)) {
      return null;
    }

    if (parsed.createdAt.trim() === "" || Number.isNaN(Date.parse(parsed.createdAt))) {
      return null;
    }

    return {
      version: 1,
      enabled: parsed.enabled,
      secret: parsed.secret,
      relayUrl: parsed.relayUrl,
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

export function writeLinkConfig(config: LinkConfig, dir?: string): void {
  const targetDir = dir ?? foxpilotDir();
  ensureFoxpilotDir(targetDir);
  const file = linkConfigPath(targetDir);
  const tmpFile = `${file}.tmp-${process.pid}`;
  const content = JSON.stringify(config, null, 2) + "\n";
  fs.writeFileSync(tmpFile, content, { mode: 0o600 });
  fs.renameSync(tmpFile, file);
  fs.chmodSync(file, 0o600);
}

export function createLinkConfig(relayUrl?: string): LinkConfig {
  const resolvedRelayUrl = relayUrl ?? DEFAULT_RELAY_URL;
  if (!isAllowedRelayUrl(resolvedRelayUrl)) {
    throw new Error(`Disallowed relay URL: ${resolvedRelayUrl}`);
  }
  return {
    version: 1,
    enabled: true,
    secret: generateLinkSecret().toString("base64url"),
    relayUrl: resolvedRelayUrl,
    createdAt: new Date().toISOString(),
  };
}

export function linkSecret(config: LinkConfig): Buffer {
  if (!config || typeof config.secret !== "string" || !B64URL_RE.test(config.secret)) {
    throw new Error("Invalid link secret in config");
  }
  const buf = Buffer.from(config.secret, "base64url");
  if (buf.length !== 32 || buf.toString("base64url") !== config.secret) {
    throw new Error("Link secret must decode to exactly 32 bytes (unpadded base64url)");
  }
  return buf;
}

export function linkToken(config: LinkConfig): string {
  return formatLinkToken(linkSecret(config), config.relayUrl);
}
