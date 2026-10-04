/**
 * HTTP CONNECT proxy support for outbound WebSocket connections.
 *
 * Cloud sandboxes only allow egress through an HTTP proxy (HTTPS_PROXY). The
 * `ws` package ignores proxy settings, so this module opens a CONNECT tunnel
 * itself and hands `ws` a pre-connected socket through its `createConnection`
 * option.
 */
import * as net from "net";
import * as tls from "tls";

const MAX_HEAD_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;

function firstNonEmpty(env: NodeJS.ProcessEnv, names: string[]): string | undefined {
  for (const name of names) {
    const v = env[name];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return undefined;
}

/** Strip IPv6 brackets and lowercase. */
function normalizeHost(host: string): string {
  let h = host.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h;
}

function defaultPort(protocol: string): number {
  return protocol === "wss:" || protocol === "https:" ? 443 : 80;
}

function isLoopbackHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  if (net.isIPv4(host) && host.split(".")[0] === "127") return true;
  return false;
}

/** Parse a NO_PROXY entry into host (normalized, no leading dot) and optional port. */
function parseNoProxyEntry(entry: string): { host: string; port?: number } | undefined {
  let host = entry;
  let port: number | undefined;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end === -1) return undefined;
    const rest = host.slice(end + 1);
    host = host.slice(0, end + 1);
    if (rest.startsWith(":")) {
      if (!/^\d+$/.test(rest.slice(1))) return undefined;
      port = Number(rest.slice(1));
    } else if (rest !== "") {
      return undefined;
    }
  } else {
    const first = host.indexOf(":");
    if (first !== -1 && first === host.lastIndexOf(":")) {
      const p = host.slice(first + 1);
      host = host.slice(0, first);
      if (/^\d+$/.test(p)) port = Number(p);
      else if (p !== "") return undefined;
    }
    // multiple colons => bare IPv6 literal, kept as-is
  }
  host = normalizeHost(host);
  if (host.startsWith("*.")) host = host.slice(2);
  else if (host.startsWith(".")) host = host.slice(1);
  if (host === "") return undefined;
  return { host, port };
}

function bypassedByNoProxy(host: string, port: number, noProxy: string): boolean {
  const entries = noProxy.split(/[\s,]+/).filter((e) => e !== "");
  for (const raw of entries) {
    if (raw === "*") return true;
    const entry = parseNoProxyEntry(raw.toLowerCase());
    if (!entry) continue;
    if (entry.port !== undefined && entry.port !== port) continue;
    if (host === entry.host) return true;
    if (net.isIP(entry.host) || net.isIP(host)) continue;
    if (host.endsWith("." + entry.host)) return true;
  }
  return false;
}

/** The proxy URL that applies to `target` (a ws:, wss:, http: or https: URL), or undefined. */
export function proxyForUrl(
  target: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return undefined;
  }
  const secure = url.protocol === "wss:" || url.protocol === "https:";
  const plain = url.protocol === "ws:" || url.protocol === "http:";
  if (!secure && !plain) return undefined;

  const host = normalizeHost(url.hostname);
  if (isLoopbackHost(host)) return undefined;

  const proxy = secure
    ? firstNonEmpty(env, ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"])
    : firstNonEmpty(env, ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]);
  if (!proxy) return undefined;

  let proxyUrl: URL;
  try {
    proxyUrl = new URL(proxy);
  } catch {
    return undefined;
  }
  if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") return undefined;

  const noProxy = firstNonEmpty(env, ["NO_PROXY", "no_proxy"]);
  if (noProxy) {
    const port = url.port ? Number(url.port) : defaultPort(url.protocol);
    if (bypassedByNoProxy(host, port, noProxy)) return undefined;
  }
  return proxy;
}

/** proxy URL with any password/username replaced by "***" — safe for logs and error messages. */
export function redactProxyUrl(proxy: string): string {
  try {
    const u = new URL(proxy);
    if (u.username) u.username = "***";
    if (u.password) u.password = "***";
    let out = u.toString();
    if (u.pathname === "/" && !u.search && !u.hash && out.endsWith("/")) out = out.slice(0, -1);
    return out;
  } catch {
    return "<invalid proxy url>";
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Open a CONNECT tunnel through `proxy` to target's host:port; resolves the raw connected socket (no TLS to the target yet). */
export function openTunnel(
  target: string,
  proxy: string,
  opts: { timeoutMs?: number } = {}
): Promise<net.Socket> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const redacted = redactProxyUrl(proxy);

  return new Promise<net.Socket>((resolve, reject) => {
    let targetUrl: URL;
    let proxyUrl: URL;
    try {
      targetUrl = new URL(target);
    } catch {
      reject(new Error(`Invalid tunnel target URL: ${target}`));
      return;
    }
    try {
      proxyUrl = new URL(proxy);
    } catch {
      reject(new Error(`Invalid proxy URL: ${redacted}`));
      return;
    }
    if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
      reject(new Error(`Unsupported proxy scheme in ${redacted}`));
      return;
    }

    // URL.hostname keeps IPv6 brackets, which is exactly what the authority needs.
    const host = targetUrl.hostname;
    const port = targetUrl.port ? Number(targetUrl.port) : defaultPort(targetUrl.protocol);
    const authority = `${host}:${port}`;

    const proxyIsTls = proxyUrl.protocol === "https:";
    const proxyHost = normalizeHost(proxyUrl.hostname);
    const proxyPort = proxyUrl.port ? Number(proxyUrl.port) : proxyIsTls ? 443 : 80;

    const socket: net.Socket = proxyIsTls
      ? tls.connect({ host: proxyHost, port: proxyPort, servername: net.isIP(proxyHost) ? undefined : proxyHost })
      : net.connect({ host: proxyHost, port: proxyPort });

    let settled = false;
    let buf = Buffer.alloc(0);
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      // Keep a no-op handler so a late error cannot become an uncaught exception.
      socket.on("error", () => {});
      socket.destroy();
      reject(err);
    };

    function onError(err: Error) {
      fail(new Error(`Proxy ${redacted} connection failed: ${err.message}`));
    }
    function onClose() {
      fail(new Error(`Proxy ${redacted} closed the connection before answering CONNECT to ${authority}`));
    }
    function onData(chunk: Buffer) {
      if (settled) return;
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buf.length > MAX_HEAD_BYTES) {
          fail(new Error(`Proxy ${redacted} sent an oversized response head (> ${MAX_HEAD_BYTES} bytes)`));
        }
        return;
      }
      if (end + 4 > MAX_HEAD_BYTES) {
        fail(new Error(`Proxy ${redacted} sent an oversized response head (> ${MAX_HEAD_BYTES} bytes)`));
        return;
      }
      const head = buf.subarray(0, end).toString("latin1");
      const rest = buf.subarray(end + 4);
      const statusLine = head.split("\r\n")[0];
      const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/.exec(statusLine);
      if (!m || m[1][0] !== "2") {
        fail(new Error(`Proxy ${redacted} refused CONNECT to ${authority}: ${statusLine}`));
        return;
      }
      settled = true;
      cleanup();
      socket.pause();
      if (rest.length > 0) socket.unshift(Buffer.from(rest));
      resolve(socket);
    }

    timer = setTimeout(() => {
      fail(new Error(`Proxy ${redacted} timed out after ${timeoutMs} ms waiting for CONNECT to ${authority}`));
    }, timeoutMs);

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);

    let req = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n`;
    if (proxyUrl.username || proxyUrl.password) {
      const creds = `${safeDecode(proxyUrl.username)}:${safeDecode(proxyUrl.password)}`;
      req += `Proxy-Authorization: Basic ${Buffer.from(creds, "utf8").toString("base64")}\r\n`;
    }
    req += "\r\n";
    socket.write(req);
  });
}

/**
 * When a proxy applies to `target`, open the tunnel and return a single-use `createConnection`
 * function for ws's options (TLS-wrapping the tunnel for wss:/https: targets, using
 * `tls.connect({ socket, servername: <target host unless it is an IP>, ...tlsOptions })`).
 * Returns undefined when no proxy applies (caller connects directly).
 */
export async function tunneledCreateConnection(
  target: string,
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; tlsOptions?: tls.ConnectionOptions } = {}
): Promise<((options?: unknown) => net.Socket) | undefined> {
  const proxy = proxyForUrl(target, opts.env ?? process.env);
  if (!proxy) return undefined;

  const tunnel = await openTunnel(target, proxy, { timeoutMs: opts.timeoutMs });

  const url = new URL(target);
  const secure = url.protocol === "wss:" || url.protocol === "https:";
  const host = normalizeHost(url.hostname);
  let used = false;

  return () => {
    if (used) throw new Error("tunneledCreateConnection: the returned createConnection is single-use");
    used = true;
    if (!secure) return tunnel;
    return tls.connect({
      socket: tunnel,
      ...(net.isIP(host) ? {} : { servername: host }),
      ...opts.tlsOptions,
    });
  };
}
