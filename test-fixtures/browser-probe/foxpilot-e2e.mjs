#!/usr/bin/env node
// FoxPilot full-stack end-to-end acceptance script.
//
//   node test-fixtures/browser-probe/foxpilot-e2e.mjs [--only 1,3,5] [--strict] [--keep] [--no-build] [--headed]
//
// What runs (all real, nothing mocked):
//   - the Chrome extension, built from the current source (`npm run package` in chrome-extension/),
//     loaded into a real headless Chromium (Playwright's chromium-1187 by default),
//   - the real broker (mcp-server/dist/broker-main.js),
//   - the real MCP server tool layer (mcp-server/dist/server.js) driven through the MCP SDK's
//     Client + StdioClientTransport, calling tools by name.
// A fixture HTTP server (server.mjs, shared with probe.mjs) plays every web page; *.example.test is
// mapped to 127.0.0.1 inside the browser (the deliberately un-granted host is a.example.test).
//
// Cases (each prints PASS / FAIL / PENDING / SKIPPED / INFO; everything is also written to
// E2E-RESULTS.json next to this file):
//   1 tab list (redaction + filters)        2 browser-fetch (background vs in-tab)
//   3 evaluate-script CSP matrix            4 take-snapshot on a loading tab
//   5 tab-access diagnosis tags (discarded / restricted / error page / un-granted site)
// 1 and 2 are strict. 3-5 test contracts another engineer may not have landed yet. A failing assertion there is
// PENDING (not FAIL) only while its feature is provably absent from the build: case 3 = the new evaluate-script
// wording ("forbids eval") is not in the shipped bundles; case 4 = no snapshot-wait marker (settleSnapshot/waitedMs)
// in the bundles AND the output still has the old shape (bare 0 elements, "nothing interactive matched", an error);
// case 5 = the contract's tag text (TAB DISCARDED: ...) is not in the bundles. Once the marker is in the build, a
// wrong output is a FAIL (a regression). --strict turns PENDING into FAIL.
// Exit code: 0 = no FAIL, 1 = at least one FAIL, 2 = infrastructure/safety abort.
//
// SAFETY DESIGN (the user's own Chrome has FoxPilot connected to a LIVE broker on 127.0.0.1:8089):
//   1. The extension is rebuilt, then COPIED to a temp dir and the copy is patched so the default
//      port literal (DEFAULT_WS_PORT = 8089, and the sidecar's 8090) is a private test port from the
//      extension's very first connection attempt. Each literal must occur exactly once per bundle,
//      and after patching NO 8089/8090 may remain in any text file of the copy, or the run aborts
//      BEFORE the browser starts.
//   2. Kernel-level backstop: the browser, the broker and the MCP server all run under macOS
//      sandbox-exec with a profile that denies outbound connections to :8089 and :8090 (and to a
//      canary port). Pre-flight and in-browser canary checks (IPv4 and IPv6, with positive controls)
//      prove the deny is inherited by the browser's network process.
//   3. HOME is a fresh temp dir for the broker, the MCP server and the browser, EXTENSION_PORT is a
//      free high port, so ~/.foxpilot (control secret, broker log) of the real user is never touched.
//      The script never connects to, probes, or lsof's port 8089 other than restricted to its OWN pids.
//   4. After launch (and again at the end) lsof restricted to the test pids must show no socket on
//      8089/8090 (abort otherwise); the browser's net-log is scanned for any 8089/8090 attempt.
//   5. Every PID it starts is recorded; cleanup kills exactly those PIDs (never pkill -f / pgrep -f)
//      and removes the temp dirs.
//   6. Fixture pages are http://127.0.0.1:<port>/... plus http://a.example.test:<port>/... ; fake data
//      only (fake-token-123, fake-jwt-abc, fake-session-1).
//
// Not covered / does not work headless: take-screenshot (captureVisibleTab needs a painted window), the
// all-sites permission dialog (the options tab it opens cannot be clicked), anything needing a real display.
// macOS only as written (sandbox-exec); elsewhere use E2E_NO_SEATBELT=1.
//
// Env: CHROMIUM_BIN (default: ~/Library/Caches/ms-playwright/chromium-1187/.../Chromium),
//      TMPDIR (where the temp profile/home live), E2E_REPO (build another checkout), E2E_RESULTS (where
//      to write the JSON), E2E_NO_SEATBELT=1 (run without sandbox-exec; loses
//      the kernel backstop and only the static patch check + net-log proof protect port 8089).
import { createRequire } from "node:module";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_REPO = path.resolve(HERE, "../..");
// E2E_REPO points the build step at another checkout (e.g. a `git archive HEAD` copy, to see how an older
// build behaves); the SDK/ws used by the harness itself always come from this repo.
const REPO = process.env.E2E_REPO ? path.resolve(process.env.E2E_REPO) : HARNESS_REPO;
const EXT_PKG_DIR = path.join(REPO, "chrome-extension");
const MCP_DIR = path.join(REPO, "mcp-server");
const requireMcp = createRequire(path.join(HARNESS_REPO, "mcp-server", "package.json"));
const WebSocket = requireMcp("ws");
const { Client } = requireMcp("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = requireMcp("@modelcontextprotocol/sdk/client/stdio.js");

const CHROMIUM =
  process.env.CHROMIUM_BIN ??
  path.join(os.homedir(), "Library/Caches/ms-playwright/chromium-1187/chrome-mac/Chromium.app/Contents/MacOS/Chromium");
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const RESULTS_PATH = process.env.E2E_RESULTS ? path.resolve(process.env.E2E_RESULTS) : path.join(HERE, "E2E-RESULTS.json");
const FORBIDDEN_PORTS = [8089, 8090];

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const ONLY = opt("--only") && opt("--only") !== "all" ? new Set(opt("--only").split(",").map((s) => s.trim())) : null;
const STRICT = flag("--strict");
const KEEP = flag("--keep");
const NO_BUILD = flag("--no-build");
const HEADED = flag("--headed");
const SEATBELT = process.env.E2E_NO_SEATBELT !== "1";
if (flag("-h") || flag("--help")) {
  console.log("usage: node foxpilot-e2e.mjs [--only 1,3,5] [--strict] [--keep] [--no-build] [--headed]");
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms: ${label}`)), ms))]);
const errText = (e) => String((e && e.message) || e);
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16);

// ---------------------------------------------------------------------------------------------
// state + process bookkeeping: only ever signal PIDs this script started
// ---------------------------------------------------------------------------------------------
const S = {
  tmp: null,
  home: null,
  profile: null,
  extDir: null,
  mcpDir: null,
  netlog: null,
  fixture: null,
  fixturePort: 0,
  base: "",
  baseA: "", // http://a.example.test:<port>  (un-granted host)
  brokerPort: 0,
  sidecarPort: 0,
  canaryPort: 0,
  canaries: null,
  browser: null,
  sw: null,
  extId: null,
  anchor: null,
  broker: null,
  client: null,
  transport: null,
  mcpStderr: "",
  schemas: {},
  bundleText: "",
};
const livePids = new Map(); // pid -> label
const knownPids = new Set(); // every pid ever seen in our process trees (browser helpers included)
/** Sync, used by exit/signal/watchdog: only pids we started or saw below them, plus anything naming our unique temp dir. */
function killLive(sig = "SIGKILL") {
  const targets = new Set([...livePids.keys(), ...knownPids]);
  try {
    const table = psTable();
    for (const root of [...livePids.keys()]) for (const d of descendants(root, table)) targets.add(d);
    if (S.tmp) for (const r of table) if (r.command.includes(S.tmp)) targets.add(r.pid);
  } catch {}
  targets.delete(process.pid);
  for (const pid of targets) {
    try {
      process.kill(pid, sig);
    } catch {}
  }
}
process.on("exit", () => killLive());
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    killLive();
    process.exit(130);
  });
}

class SafetyAbort extends Error {}
class InfraError extends Error {}

// ---------------------------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------------------------
const RESULTS = { meta: {}, safety: {}, cases: [], summary: {} };
const t0Run = Date.now();
function normText(s) {
  let out = typeof s === "string" ? s : JSON.stringify(s);
  const rep = [
    [S.tmp, "<TMP>"],
    [REPO, "<REPO>"],
    [os.homedir(), "<HOME>"],
    [S.extId, "<EXT_ID>"],
    [os.userInfo().username, "<USER>"],
    [S.fixturePort ? `:${S.fixturePort}` : null, ":<PORT>"],
    [S.brokerPort ? `:${S.brokerPort}` : null, ":<BROKER_PORT>"],
    [S.canaryPort ? `:${S.canaryPort}` : null, ":<CANARY_PORT>"],
  ];
  for (const [from, to] of rep) if (from) out = out.split(from).join(to);
  return out;
}
function shorten(s, n = 380) {
  const one = String(s).replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}...` : one;
}
function rec(id, title, status, observed, extra = {}) {
  const row = { id, title, status, observed: normText(shorten(observed ?? "", 1800)), ...extra };
  RESULTS.cases.push(row);
  const tag = status.padEnd(7);
  console.log(`[${tag}] ${id} ${title}${observed !== undefined && observed !== "" ? `\n          observed: ${shorten(observed, 300)}` : ""}`);
  if (extra.reason) console.log(`          reason: ${extra.reason}`);
  saveResults();
  return row;
}
/** verdict: ok -> PASS; otherwise FAIL, or PENDING when `pendingReason` says the feature is not in yet. */
function verdict(id, title, ok, observed, pendingReason = null, extra = {}) {
  if (ok) return rec(id, title, "PASS", observed, extra);
  if (pendingReason && !STRICT) return rec(id, title, "PENDING", observed, { reason: pendingReason, ...extra });
  return rec(id, title, "FAIL", observed, extra);
}
function saveResults() {
  RESULTS.meta.runtimeMs = Date.now() - t0Run;
  const counts = {};
  for (const r of RESULTS.cases) counts[r.status] = (counts[r.status] ?? 0) + 1;
  RESULTS.summary = counts;
  try {
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(RESULTS, null, 2) + "\n");
  } catch {}
}

// ---------------------------------------------------------------------------------------------
// raw CDP client (copied from probe.mjs: only the browser target and the service worker are attached)
// ---------------------------------------------------------------------------------------------
class CDP {
  constructor(url) {
    this.ws = new WebSocket(url, { perMessageDeflate: false });
    this.id = 0;
    this.pending = new Map();
    this.opened = new Promise((res, rej) => {
      this.ws.once("open", res);
      this.ws.once("error", rej);
    });
    this.ws.on("message", (data) => {
      const m = JSON.parse(String(data));
      if (m.id === undefined) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.rej(new Error(`${m.error.message} (${m.error.code})`));
      else p.res(m.result);
    });
    this.ws.on("close", () => {
      for (const p of this.pending.values()) p.rej(new Error("CDP socket closed"));
      this.pending.clear();
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (e) {
        this.pending.delete(id);
        rej(e);
      }
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

// ---------------------------------------------------------------------------------------------
// small OS helpers
// ---------------------------------------------------------------------------------------------
function psTable() {
  const out = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 << 20 });
  return out
    .split("\n")
    .map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] }));
}
function descendants(rootPid, table = psTable()) {
  const kids = new Map();
  for (const r of table) {
    if (!kids.has(r.ppid)) kids.set(r.ppid, []);
    kids.get(r.ppid).push(r.pid);
  }
  const out = [];
  const stack = [rootPid];
  while (stack.length) {
    const p = stack.pop();
    for (const c of kids.get(p) ?? []) {
      out.push(c);
      stack.push(c);
    }
  }
  return out;
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function lsof(args) {
  const r = spawnSync("/usr/sbin/lsof", ["-nP", ...args], { encoding: "utf8", maxBuffer: 16 << 20, timeout: 20000 });
  return { out: r.stdout ?? "", err: r.stderr ?? "", status: r.status };
}
/** Every pid the browser (root + descendants), broker and MCP server own right now. */
function myPids() {
  const table = psTable();
  const set = new Set();
  for (const [pid] of livePids) {
    if (pidAlive(pid)) set.add(pid);
  }
  if (S.browser) for (const d of descendants(S.browser.pid, table)) set.add(d);
  if (S.broker) for (const d of descendants(S.broker.pid, table)) set.add(d);
  if (S.transport?.pid) for (const d of descendants(S.transport.pid, table)) set.add(d);
  for (const p of set) knownPids.add(p);
  return [...set];
}
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}
function httpGet(port, p, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: p, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
  });
}
const sbProfile = () =>
  `(version 1)(allow default)(deny network-outbound ${[...FORBIDDEN_PORTS, S.canaryPort].map((p) => `(remote ip "*:${p}")`).join(" ")})`;
function wrap(cmd, args) {
  return SEATBELT ? [SANDBOX_EXEC, ["-p", sbProfile(), cmd, ...args]] : [cmd, args];
}
function cleanEnv() {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: S.home,
    TMPDIR: S.tmp,
    LANG: "en_US.UTF-8",
    EXTENSION_PORT: String(S.brokerPort),
    FOXPILOT_FEEDBACK: "off",
  };
}

// ---------------------------------------------------------------------------------------------
// build + snapshot + patch
// ---------------------------------------------------------------------------------------------
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 << 20, timeout: 240000 });
  if (r.status !== 0) {
    throw new InfraError(`${cmd} ${args.join(" ")} failed in ${cwd} (status ${r.status}):\n${(r.stdout ?? "").slice(-1500)}\n${(r.stderr ?? "").slice(-1500)}`);
  }
}
function textFilesIn(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|html|json|css|txt|map)$/i.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}
function buildAndSnapshot() {
  if (!NO_BUILD) {
    run("npm", ["run", "package"], EXT_PKG_DIR);
    run("npm", ["run", "build"], MCP_DIR);
  }
  const extSrc = path.join(EXT_PKG_DIR, "web-ext-artifacts", "chrome-unpacked");
  S.extDir = path.join(S.tmp, "ext");
  fs.cpSync(extSrc, S.extDir, { recursive: true });
  S.mcpDir = path.join(S.tmp, "mcp-dist");
  fs.cpSync(path.join(MCP_DIR, "dist"), S.mcpDir, { recursive: true });
  // a build racing with another engineer's build can leave a half-written copy: validate it
  JSON.parse(fs.readFileSync(path.join(S.extDir, "manifest.json"), "utf8"));
  for (const f of ["dist/background.js", "dist/content-script.js", "dist/options.js"]) {
    if (fs.statSync(path.join(S.extDir, f)).size < 5000) throw new InfraError(`extension copy looks truncated: ${f}`);
  }
  for (const f of ["server.js", "broker-main.js"]) {
    const p = path.join(S.mcpDir, f);
    const r = spawnSync(process.execPath, ["--check", p], { encoding: "utf8" });
    if (r.status !== 0) throw new InfraError(`mcp-server dist/${f} does not parse (concurrent rebuild?): ${r.stderr.slice(0, 500)}`);
  }
  RESULTS.meta.fingerprint = {
    "extension dist/background.js": sha(path.join(S.extDir, "dist/background.js")),
    "extension dist/content-script.js": sha(path.join(S.extDir, "dist/content-script.js")),
    "mcp-server dist/server.js": sha(path.join(S.mcpDir, "server.js")),
    "mcp-server dist/broker-main.js": sha(path.join(S.mcpDir, "broker-main.js")),
    extensionVersion: JSON.parse(fs.readFileSync(path.join(S.extDir, "manifest.json"), "utf8")).version,
  };
  // text of the shipped bundles, used to decide whether a not-yet-landed contract is in the build
  S.bundleText = ["dist/background.js", "dist/content-script.js"]
    .map((f) => fs.readFileSync(path.join(S.extDir, f), "utf8"))
    .concat(["server.js", "broker-main.js"].map((f) => fs.readFileSync(path.join(S.mcpDir, f), "utf8")))
    .join("\n");
}
function patchExtension() {
  const report = { patched: [], remaining: [] };
  for (const f of ["dist/background.js", "dist/options.js"]) {
    const p = path.join(S.extDir, f);
    let text = fs.readFileSync(p, "utf8");
    const ws = text.match(/DEFAULT_WS_PORT = 8089;/g) ?? [];
    const sc = text.match(/DEFAULT_SIDECAR_PORT = 8090;/g) ?? [];
    if (ws.length !== 1 || sc.length !== 1) {
      throw new SafetyAbort(`patch precondition failed in ${f}: DEFAULT_WS_PORT=8089 occurs ${ws.length}x, DEFAULT_SIDECAR_PORT=8090 occurs ${sc.length}x (expected exactly 1 each); the source changed shape, refusing to launch`);
    }
    text = text.replace("DEFAULT_WS_PORT = 8089;", `DEFAULT_WS_PORT = ${S.brokerPort};`).replace("DEFAULT_SIDECAR_PORT = 8090;", `DEFAULT_SIDECAR_PORT = ${S.sidecarPort};`);
    fs.writeFileSync(p, text);
    report.patched.push(`${f}: DEFAULT_WS_PORT 8089 -> ${S.brokerPort}, DEFAULT_SIDECAR_PORT 8090 -> ${S.sidecarPort} (1 occurrence each)`);
  }
  // display-only text in the options page (a ports chip and an input placeholder)
  for (const f of textFilesIn(S.extDir).filter((x) => x.endsWith(".html"))) {
    const text = fs.readFileSync(f, "utf8");
    const next = text.replace(/\b8089\b/g, String(S.brokerPort)).replace(/\b8090\b/g, String(S.sidecarPort));
    if (next !== text) {
      fs.writeFileSync(f, next);
      report.patched.push(`${path.relative(S.extDir, f)}: display text`);
    }
  }
  for (const f of textFilesIn(S.extDir)) {
    const lines = fs.readFileSync(f, "utf8").split("\n");
    lines.forEach((l, i) => {
      if (/(?<![\d.])(8089|8090)(?!\d)/.test(l)) report.remaining.push(`${path.relative(S.extDir, f)}:${i + 1}`);
    });
  }
  if (report.remaining.length) throw new SafetyAbort(`8089/8090 still present in the patched extension copy: ${report.remaining.join(", ")}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(S.extDir, "manifest.json"), "utf8"));
  report.manifestHostPermissions = manifest.host_permissions;
  report.manifestOptionalHostPermissions = manifest.optional_host_permissions;
  RESULTS.safety.patch = report;
}

// ---------------------------------------------------------------------------------------------
// canaries + seatbelt pre-flight
// ---------------------------------------------------------------------------------------------
function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}
async function startCanaries() {
  const hits = { canary4: 0, canary6: 0, ctl6: 0 };
  const mk = (k) =>
    http
      .createServer((req, res) => {
        res.writeHead(204, { "access-control-allow-origin": "*" });
        res.end();
      })
      .on("connection", () => hits[k]++);
  // is an IPv6 loopback available at all?
  let v6 = true;
  {
    const probe = http.createServer();
    try {
      await listen(probe, 0, "::1");
    } catch {
      v6 = false;
    }
    await new Promise((r) => probe.close(r));
  }
  let canary4 = null;
  let canary6 = null;
  for (let i = 0; i < 10 && !S.canaryPort; i++) {
    canary4 = mk("canary4");
    const port = await listen(canary4, 0, "127.0.0.1");
    if (!v6) {
      S.canaryPort = port;
      break;
    }
    canary6 = mk("canary6");
    try {
      await listen(canary6, port, "::1");
      S.canaryPort = port;
    } catch {
      canary6 = null; // that port is taken on ::1: try another
      await new Promise((r) => canary4.close(r));
    }
  }
  if (!S.canaryPort) throw new InfraError("could not find a canary port free on both loopback families");
  let ctl6 = null;
  let ctl6Port = 0;
  if (canary6) {
    ctl6 = mk("ctl6");
    ctl6Port = await listen(ctl6, 0, "::1");
  }
  S.canaries = { canary4, canary6, ctl6, ctl6Port, hits, v6: !!canary6 };
}
function seatbeltPreflight() {
  if (!SEATBELT) {
    RESULTS.safety.seatbelt = { enabled: false, note: "E2E_NO_SEATBELT=1: running WITHOUT the kernel-level deny of :8089/:8090" };
    console.log("WARNING: seatbelt disabled; only the static patch check and the net-log proof protect port 8089.");
    return;
  }
  if (!fs.existsSync(SANDBOX_EXEC)) throw new SafetyAbort(`${SANDBOX_EXEC} not found; set E2E_NO_SEATBELT=1 to run without the kernel backstop`);
  const targets = [
    { name: "canary-127.0.0.1", host: "127.0.0.1", port: S.canaryPort, expect: "denied" },
    { name: "control-127.0.0.1 (fixture)", host: "127.0.0.1", port: S.fixturePort, expect: "connected" },
  ];
  if (S.canaries.canary6) {
    targets.push({ name: "canary-[::1]", host: "::1", port: S.canaryPort, expect: "denied" });
    if (S.canaries.ctl6) targets.push({ name: "control-[::1]", host: "::1", port: S.canaries.ctl6Port, expect: "connected" });
  }
  const code = `
    const net = require("net");
    const targets = ${JSON.stringify(targets)};
    const tryc = (t) => new Promise((r) => {
      const c = net.connect({ host: t.host, port: t.port });
      const to = setTimeout(() => { c.destroy(); r({ name: t.name, result: "timeout" }); }, 3000);
      c.on("connect", () => { clearTimeout(to); c.destroy(); r({ name: t.name, result: "connected" }); });
      c.on("error", (e) => { clearTimeout(to); r({ name: t.name, result: "error:" + e.code }); });
    });
    Promise.all(targets.map(tryc)).then((r) => console.log(JSON.stringify(r)));`;
  const r = spawnSync(SANDBOX_EXEC, ["-p", sbProfile(), process.execPath, "-e", code], { encoding: "utf8", timeout: 20000 });
  let parsed;
  try {
    parsed = JSON.parse(r.stdout.trim());
  } catch {
    throw new SafetyAbort(`seatbelt pre-flight could not run: ${r.stdout} ${r.stderr}`);
  }
  const bad = [];
  for (const t of targets) {
    const got = parsed.find((x) => x.name === t.name)?.result;
    const ok = t.expect === "denied" ? got === "error:EPERM" : got === "connected";
    if (!ok) bad.push(`${t.name}: expected ${t.expect}, got ${got}`);
  }
  const { hits } = S.canaries;
  if (hits.canary4 + hits.canary6 !== 0) bad.push(`canary listeners saw ${hits.canary4 + hits.canary6} connection(s) despite the deny`);
  RESULTS.safety.seatbelt = { enabled: true, profile: normText(sbProfile()), preflight: parsed, canaryIpv6: !!S.canaries.canary6 };
  if (bad.length) throw new SafetyAbort(`seatbelt pre-flight failed: ${bad.join("; ")}`);
}

// ---------------------------------------------------------------------------------------------
// broker + browser + MCP client
// ---------------------------------------------------------------------------------------------
async function startBroker() {
  const [cmd, args] = wrap(process.execPath, [path.join(S.mcpDir, "broker-main.js")]);
  const logFd = fs.openSync(path.join(S.tmp, "broker.log"), "w");
  const child = spawn(cmd, args, { env: cleanEnv(), stdio: ["ignore", logFd, logFd] });
  fs.closeSync(logFd);
  S.broker = child;
  livePids.set(child.pid, "broker");
  child.once("exit", () => livePids.delete(child.pid));
  const t0 = Date.now();
  while (Date.now() - t0 < 20000) {
    const h = await httpGet(S.brokerPort, "/health");
    if (h && h.status === 200) return JSON.parse(h.body);
    if (child.exitCode !== null) break;
    await sleep(200);
  }
  throw new InfraError(`broker did not answer /health on 127.0.0.1:${S.brokerPort}\n${tail(path.join(S.tmp, "broker.log"))}`);
}
function tail(file, n = 1500) {
  try {
    return fs.readFileSync(file, "utf8").slice(-n);
  } catch {
    return "(no log)";
  }
}
async function launchChromium() {
  S.profile = path.join(S.tmp, "profile");
  fs.mkdirSync(S.profile, { recursive: true });
  S.netlog = path.join(S.tmp, "netlog.json");
  const logPath = path.join(S.tmp, "chromium.log");
  const logFd = fs.openSync(logPath, "w");
  const chromiumArgs = [
    ...(HEADED ? [] : ["--headless=new"]),
    "--no-sandbox", // required to nest under sandbox-exec; the seatbelt profile is the sandbox here
    `--user-data-dir=${S.profile}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--use-mock-keychain",
    "--password-store=basic",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--no-proxy-server",
    `--disable-extensions-except=${S.extDir}`,
    `--load-extension=${S.extDir}`,
    // hermetic names: only localhost and *.example.test (-> 127.0.0.1) resolve; every other hostname fails
    "--host-resolver-rules=EXCLUDE localhost,EXCLUDE 127.0.0.1,EXCLUDE [::1],EXCLUDE ::1,MAP *.example.test 127.0.0.1,MAP * ~NOTFOUND",
    `--log-net-log=${S.netlog}`,
    "--net-log-capture-mode=Default",
    "about:blank",
  ];
  const [cmd, args] = wrap(CHROMIUM, chromiumArgs);
  const child = spawn(cmd, args, { env: cleanEnv(), stdio: ["ignore", logFd, logFd] });
  fs.closeSync(logFd);
  const b = { pid: child.pid, exited: false, closed: false, cdp: null, logPath };
  S.browser = b;
  livePids.set(child.pid, "chromium");
  child.once("exit", () => {
    b.exited = true;
    livePids.delete(child.pid);
  });
  const portFile = path.join(S.profile, "DevToolsActivePort");
  let lines;
  const t0 = Date.now();
  while (!lines) {
    if (Date.now() - t0 > 30000) throw new InfraError(`DevToolsActivePort never appeared\n${tail(logPath)}`);
    if (b.exited) throw new InfraError(`browser exited early\n${tail(logPath)}`);
    try {
      const txt = fs.readFileSync(portFile, "utf8").split("\n");
      if (txt.length >= 2 && txt[1]) lines = txt;
    } catch {}
    if (!lines) await sleep(150);
  }
  b.cdp = new CDP(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
  await b.cdp.opened;
  b.version = await b.cdp.send("Browser.getVersion");
  return b;
}
async function closeBrowser() {
  const b = S.browser;
  if (!b || b.closed) return;
  b.closed = true;
  try {
    await withTimeout(b.cdp.send("Browser.close"), 4000, "Browser.close");
  } catch {}
  const t0 = Date.now();
  while (!b.exited && Date.now() - t0 < 6000) await sleep(100);
  b.cdp.close();
}

// ---- service worker ----------------------------------------------------------------------------
let swSession = null;
async function findSw(timeoutMs = 25000) {
  const t0 = Date.now();
  let woke = false;
  while (Date.now() - t0 < timeoutMs) {
    const { targetInfos } = await S.browser.cdp.send("Target.getTargets");
    for (const t of targetInfos) {
      if (t.type !== "service_worker" || !t.url.startsWith("chrome-extension://") || !t.url.endsWith("/dist/background.js")) continue;
      const { sessionId } = await S.browser.cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
      swSession = sessionId;
      S.extId = new URL(t.url).host;
      return sessionId;
    }
    if (!woke && Date.now() - t0 > 3000) {
      // an idle MV3 worker is not a target: a tab creation wakes it (tabs.onCreated)
      woke = true;
      try {
        const { targetId } = await S.browser.cdp.send("Target.createTarget", { url: "about:blank" });
        await sleep(500);
        await S.browser.cdp.send("Target.closeTarget", { targetId });
      } catch {}
    }
    await sleep(250);
  }
  throw new InfraError("FoxPilot service worker target not found");
}
/** Runs `fn` (stringified, self-contained) inside the extension service worker. */
async function swEval(fn, arg, timeoutMs = 60000) {
  const expression = `(async () => { return await (${fn})(${arg === undefined ? "null" : JSON.stringify(arg)}); })()`;
  const once = async () => {
    if (!swSession) await findSw();
    const r = await withTimeout(
      S.browser.cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, swSession),
      timeoutMs,
      `service worker snippet ${fn.name || "(anonymous)"}`,
    );
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`SW snippet threw: ${(d.exception && d.exception.description) || d.text}`);
    }
    return r.result.value;
  };
  try {
    return await once();
  } catch (e) {
    if (!/Session with given id not found|Target closed|detached|not found|Cannot find context/i.test(errText(e))) throw e;
    swSession = null;
    return await once();
  }
}

// ---- tab helpers (all through the service worker; no page target is ever attached) -------------
const tabs = {
  async open(url, active = false) {
    return swEval(async (a) => (await chrome.tabs.create({ url: a.url, active: a.active })).id, { url, active });
  },
  async tryOpen(url, active = false) {
    return swEval(
      async (a) => {
        try {
          return { id: (await chrome.tabs.create({ url: a.url, active: a.active })).id };
        } catch (e) {
          return { error: String((e && e.message) || e) };
        }
      },
      { url, active },
    );
  },
  async waitComplete(id, ms = 12000) {
    return swEval(
      async (a) => {
        const t0 = Date.now();
        let t;
        while (Date.now() - t0 < a.ms) {
          try {
            t = await chrome.tabs.get(a.id);
          } catch (e) {
            return { error: String((e && e.message) || e) };
          }
          if (t.status === "complete") return { status: "complete", url: t.url, title: t.title, ms: Date.now() - t0 };
          await new Promise((r) => setTimeout(r, 50));
        }
        return { status: t && t.status, url: t && t.url, timedOut: true };
      },
      { id, ms },
    );
  },
  async info(id) {
    return swEval(
      async (a) => {
        try {
          const t = await chrome.tabs.get(a.id);
          return { id: t.id, url: t.url, pendingUrl: t.pendingUrl, status: t.status, discarded: t.discarded, active: t.active, title: t.title };
        } catch (e) {
          return { error: String((e && e.message) || e) };
        }
      },
      { id },
    );
  },
  async list() {
    return swEval(async () => (await chrome.tabs.query({})).map((t) => ({ id: t.id, url: t.url, pendingUrl: t.pendingUrl, status: t.status, discarded: t.discarded, active: t.active, title: t.title })));
  },
  async closeExtra(extraKeep = []) {
    const keep = [S.anchor, ...extraKeep].filter((x) => x !== null && x !== undefined);
    return swEval(
      async (a) => {
        const all = await chrome.tabs.query({});
        const rm = all.filter((t) => !a.keep.includes(t.id)).map((t) => t.id);
        if (rm.length) await chrome.tabs.remove(rm);
        return rm.length;
      },
      { keep },
    );
  },
  async discard(id) {
    return swEval(
      async (a) => {
        try {
          const t = await chrome.tabs.discard(a.id);
          return t ? { discarded: t.discarded, status: t.status, id: t.id } : { error: "tabs.discard returned undefined" };
        } catch (e) {
          return { error: String((e && e.message) || e) };
        }
      },
      { id },
    );
  },
  async reload(id) {
    return swEval(async (a) => chrome.tabs.reload(a.id).then(() => true), { id });
  },
};

// ---- MCP client --------------------------------------------------------------------------------
async function startMcp() {
  const [cmd, args] = wrap(process.execPath, [path.join(S.mcpDir, "server.js")]);
  S.transport = new StdioClientTransport({ command: cmd, args, env: cleanEnv(), stderr: "pipe" });
  S.transport.stderr?.on("data", (d) => {
    S.mcpStderr = (S.mcpStderr + d).slice(-6000);
  });
  S.client = new Client({ name: "foxpilot-e2e", version: "1.0.0" }, { capabilities: {} });
  await withTimeout(S.client.connect(S.transport), 30000, "MCP client connect");
  if (S.transport.pid) livePids.set(S.transport.pid, "mcp-server");
  const { tools } = await S.client.listTools();
  S.schemas = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema?.properties ?? {}]));
  RESULTS.meta.toolCount = tools.length;
}
async function tool(name, args = {}, { timeoutMs = 45000 } = {}) {
  const t0 = Date.now();
  try {
    const r = await withTimeout(S.client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs }), timeoutMs + 3000, name);
    const text = (r.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
    return { isError: !!r.isError, text, ms: Date.now() - t0, thrown: false };
  } catch (e) {
    return { isError: true, text: errText(e), ms: Date.now() - t0, thrown: true };
  }
}
const hasArg = (toolName, arg) => Object.prototype.hasOwnProperty.call(S.schemas[toolName] ?? {}, arg);

// ---------------------------------------------------------------------------------------------
// safety proofs
// ---------------------------------------------------------------------------------------------
function lsofProof(label) {
  const pids = myPids();
  const list = pids.join(",");
  const proof = { label, pids: pids.length, perPort: {}, listeners8089: "", allTcp: "" };
  if (!pids.length) throw new SafetyAbort("lsof proof: no pids to check");
  for (const port of FORBIDDEN_PORTS) {
    const r = lsof(["-a", "-p", list, `-iTCP:${port}`]);
    const lines = r.out.split("\n").filter((l) => l.trim() && !l.startsWith("COMMAND"));
    proof.perPort[port] = lines;
  }
  const listen = lsof(["-a", "-p", list, "-iTCP:8089", "-sTCP:LISTEN"]);
  proof.listeners8089 = listen.out.split("\n").filter((l) => l.trim() && !l.startsWith("COMMAND")).join("\n");
  const all = lsof(["-a", "-p", list, "-iTCP"]);
  proof.allTcp = all.out
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("COMMAND"))
    .map((l) => l.replace(/\s+/g, " "))
    .slice(0, 40);
  proof.ok = FORBIDDEN_PORTS.every((p) => proof.perPort[p].length === 0) && proof.listeners8089 === "";
  (RESULTS.safety.lsof ??= []).push({ ...proof, allTcp: proof.allTcp.map(normText) });
  if (!proof.ok) {
    throw new SafetyAbort(`lsof shows a socket on a forbidden port among the test pids (${label}): ${JSON.stringify(proof.perPort)} ${proof.listeners8089}`);
  }
  return proof;
}
async function browserCanaryProof() {
  const { hits, ctl6Port, v6 } = S.canaries;
  const urls = {
    canary4: `http://127.0.0.1:${S.canaryPort}/`,
    canaryLocalhost: `http://localhost:${S.canaryPort}/`,
    ctl4: `${S.base}/favicon.ico`,
  };
  if (v6) {
    urls.canary6 = `http://[::1]:${S.canaryPort}/`;
    if (ctl6Port) urls.ctl6 = `http://[::1]:${ctl6Port}/`;
  }
  const before = { ...hits };
  const res = await swEval(
    async (a) => {
      const out = {};
      for (const [k, u] of Object.entries(a.urls)) {
        try {
          await fetch(u, { mode: "no-cors", cache: "no-store" });
          out[k] = "reached";
        } catch (e) {
          out[k] = "blocked: " + String((e && e.message) || e);
        }
      }
      return out;
    },
    { urls },
  );
  const canaryHits = hits.canary4 + hits.canary6 - before.canary4 - before.canary6;
  const problems = [];
  for (const k of Object.keys(res)) {
    const want = k.startsWith("canary") ? "blocked" : "reached";
    if (!res[k].startsWith(want)) problems.push(`${k}: expected ${want}, got ${res[k]}`);
  }
  if (canaryHits !== 0) problems.push(`canary listeners saw ${canaryHits} connection(s) from the browser`);
  if (ctl6Port && hits.ctl6 - before.ctl6 < 1) problems.push("IPv6 control listener saw no connection (the IPv6 canary result would prove nothing)");
  RESULTS.safety.browserCanary = { results: res, canaryHitsFromBrowser: canaryHits, ipv6ControlHits: hits.ctl6 - before.ctl6 };
  if (SEATBELT && problems.length) throw new SafetyAbort(`in-browser canary check failed: ${problems.join("; ")}`);
}
function netlogProof() {
  let text;
  try {
    text = fs.readFileSync(S.netlog, "utf8");
  } catch (e) {
    return { ok: false, error: `net-log missing: ${errText(e)}` };
  }
  const forbidden = [];
  const rx = /(?:127\.0\.0\.1|localhost|\[?::1\]?|0\.0\.0\.0)[:"]+\s*(8089|8090)(?!\d)|"port"\s*:\s*(8089|8090)(?!\d)/g;
  let m;
  while ((m = rx.exec(text)) && forbidden.length < 5) forbidden.push(text.slice(Math.max(0, m.index - 60), m.index + 80).replace(/\s+/g, " "));
  const wsToTest = (text.match(new RegExp(`ws://127\\.0\\.0\\.1:${S.brokerPort}/extension`, "g")) ?? []).length;
  // positive control: the browser DID try the denied canary port (browserCanaryProof), so a blocked attempt is
  // visible in this log; the same would be true for 8089.
  const canarySeen = (text.match(new RegExp(`:${S.canaryPort}(?!\\d)`, "g")) ?? []).length;
  const proof = { bytes: text.length, attemptsTo8089or8090: forbidden.length, samples: forbidden, extensionWebSocketEventsToTestBroker: wsToTest, blockedCanaryAttemptsVisibleInLog: canarySeen, ok: forbidden.length === 0 && wsToTest > 0 && (!SEATBELT || canarySeen > 0) };
  RESULTS.safety.netlog = proof;
  return proof;
}

// ---------------------------------------------------------------------------------------------
// shared assertions helpers
// ---------------------------------------------------------------------------------------------
const tabLines = (text) => text.split("\n").filter((l) => l.startsWith("tab id="));
const headerOf = (text) => text.match(/Showing tabs (\d+)-(\d+) of (\d+) (matching|total) tabs/);
const lacks = (toolName, ...args) => args.filter((a) => !hasArg(toolName, a));

// ---------------------------------------------------------------------------------------------
// CASE 1: tab list
// ---------------------------------------------------------------------------------------------
async function case1() {
  const T = "get-list-of-open-tabs";
  const missing = lacks(T, "urlContains", "titleContains", "fullUrls", "compact");
  if (missing.length) return rec("1.0", "tool schema has the tab-list filter arguments", "FAIL", `get-list-of-open-tabs schema lacks: ${missing.join(", ")} (a stale server build would silently drop them)`);
  await tabs.closeExtra();
  const base = S.base;
  const secretUrl = `${base}/page?csp=none&title=Secret%20Tab&next=%2Fcb%3Faccess_token%3Dfake-token-123#id_token=fake-jwt-abc`;
  const ids = [];
  for (const u of [secretUrl, `${base}/p/alpha-docs?title=Alpha%20Docs`, `${base}/p/beta-report?title=Beta%20Report`]) ids.push(await tabs.open(u, false));
  for (const id of ids) await tabs.waitComplete(id);
  const [secretId, alphaId, betaId] = ids;

  const all = await tool(T, {});
  const redactedUrl = `${base}/page?[redacted]#[redacted]`;
  const allLines = tabLines(all.text);
  verdict(
    "1.1",
    "default listing hides fake-token-123 / fake-jwt-abc and shows scheme+host+path with ?[redacted]/#[redacted]",
    !all.isError && !/fake-token-123|fake-jwt-abc/.test(all.text) && all.text.includes(redactedUrl) && ids.every((id) => allLines.some((l) => l.startsWith(`tab id=${id},`))),
    allLines.filter((l) => ids.some((id) => l.startsWith(`tab id=${id},`))).join(" | ") || all.text,
  );

  const alpha = await tool(T, { urlContains: "/p/alpha" });
  verdict("1.2", "urlContains matches on the PATH (/p/alpha -> exactly the alpha tab, header says matching)", !alpha.isError && tabLines(alpha.text).length === 1 && alpha.text.includes(`tab id=${alphaId},`) && /Showing tabs 1-1 of 1 matching tabs/.test(alpha.text), alpha.text);

  const pageLike = await tool(T, { urlContains: "/page" });
  verdict("1.3", "urlContains '/page' finds the secret tab, still redacted", !pageLike.isError && pageLike.text.includes(`tab id=${secretId},`) && pageLike.text.includes(redactedUrl) && !/fake-token-123|fake-jwt-abc/.test(pageLike.text), pageLike.text);

  const byToken = await tool(T, { urlContains: "fake-token-123" });
  verdict(
    "1.4",
    "urlContains with the secret text finds NOTHING by default (and lists no tab / leaks no token)",
    !byToken.isError && tabLines(byToken.text).length === 0 && !/access_token|fake-jwt-abc|id_token/.test(byToken.text) && /No open tabs match/.test(byToken.text),
    byToken.text,
  );

  const full = await tool(T, { urlContains: "fake-token-123", fullUrls: true });
  verdict("1.5", "fullUrls:true + urlContains secret finds the tab and prints the full URL", !full.isError && tabLines(full.text).length === 1 && full.text.includes(`tab id=${secretId},`) && full.text.includes("fake-token-123") && full.text.includes("fake-jwt-abc"), full.text);

  const byTitle = await tool(T, { titleContains: "beta rep" });
  verdict("1.6", "titleContains is case-insensitive and finds only the beta tab", !byTitle.isError && tabLines(byTitle.text).length === 1 && byTitle.text.includes(`tab id=${betaId},`) && /Beta Report/.test(byTitle.text), byTitle.text);

  const both = await tool(T, { urlContains: "/p/", titleContains: "alpha" });
  verdict("1.7", "urlContains + titleContains are ANDed", !both.isError && tabLines(both.text).length === 1 && both.text.includes(`tab id=${alphaId},`), both.text);

  const compactAll = await tool(T, { compact: true, urlContains: `127.0.0.1:${S.fixturePort}` });
  const cLines = compactAll.text.split("\n").filter((l) => /^id=\d+/.test(l));
  const cOk =
    !compactAll.isError &&
    cLines.length === 3 &&
    cLines.every((l) => /^id=\d+ win=\d+ 127\.0\.0\.1:\d+\/\S* \| .+$/.test(l) && l.length <= 160 && !l.includes("http://") && !l.includes("tab url=") && !l.includes("last accessed")) &&
    !/fake-token-123|fake-jwt-abc/.test(compactAll.text);
  verdict("1.8", "compact prints one short line per tab (id, win, host+path | title), no scheme, still redacted", cOk, compactAll.text);

  const total = headerOf(all.text);
  const narrowed = headerOf((await tool(T, { urlContains: `127.0.0.1:${S.fixturePort}` })).text);
  verdict(
    "1.9",
    "filters narrow the count; header says 'matching' when filtered and 'total' when not",
    !!total && !!narrowed && total[4] === "total" && narrowed[4] === "matching" && Number(narrowed[3]) === 3 && Number(total[3]) > 3,
    `unfiltered: ${total?.[0]} ; filtered: ${narrowed?.[0]}`,
  );
}

// ---------------------------------------------------------------------------------------------
// CASE 2: browser-fetch
// ---------------------------------------------------------------------------------------------
async function case2() {
  const T = "browser-fetch";
  if (lacks(T, "tabId").length) return rec("2.0", "browser-fetch schema has tabId", "FAIL", "browser-fetch schema lacks tabId (stale server build)");
  await tabs.closeExtra();
  const base = S.base;
  const tabId = await tabs.open(`${base}/page?csp=none&title=Fetch%20Tab`, true);
  await tabs.waitComplete(tabId);

  const bg = await tool(T, { url: `${base}/api/guarded`, method: "POST", body: "x", headers: { "content-type": "text/plain" } });
  verdict(
    "2.1",
    "no tabId (extension background): POST /api/guarded -> 403, empty body, Hint suggests tabId",
    !bg.isError && /^403\b/.test(bg.text) && /"content-length":\s*"0"/.test(bg.text) && !/"ok":\s*true/.test(bg.text) && /Hint:/.test(bg.text) && /tabId/.test(bg.text) && !bg.text.startsWith("[ran inside tab"),
    bg.text,
  );

  const inTab = await tool(T, { url: `${base}/api/guarded`, tabId, method: "POST", body: "x", headers: { "content-type": "text/plain" } });
  const banner = `[ran inside tab ${tabId} as the page: origin ${base}]`;
  verdict("2.2", "with tabId of a same-origin tab: banner line first, status 200 {\"ok\":true}", !inTab.isError && inTab.text.startsWith(banner) && /\n200\b/.test(inTab.text) && /\{"ok":true\}/.test(inTab.text), inTab.text);

  const echo = await tool(T, { url: "/api/echo", tabId });
  let echoJson = null;
  try {
    echoJson = JSON.parse(echo.text.split("\n\n").pop());
  } catch {}
  verdict(
    "2.3",
    "in-tab GET /api/echo shows the page's Referer and the cookie sid=fake-session-1",
    !echo.isError && echoJson && typeof echoJson.referer === "string" && echoJson.referer.startsWith(`${base}/page`) && /(^|;\s*)sid=fake-session-1(;|$)/.test(echoJson.cookie ?? ""),
    echoJson ? JSON.stringify(echoJson) : echo.text,
  );

  const chromeTab = await tabs.tryOpen("chrome://version", false);
  if (chromeTab.error) {
    rec("2.4", "browser-fetch with tabId of a chrome://version tab -> clear error, no hang", "SKIPPED", chromeTab.error, { reason: "tabs.create refused chrome://version in this browser" });
  } else {
    await tabs.waitComplete(chromeTab.id, 8000);
    const r = await tool(T, { url: `${base}/api/echo`, tabId: chromeTab.id }, { timeoutMs: 40000 });
    verdict("2.4", "browser-fetch with tabId of a chrome://version tab -> clear error, no hang (< 15 s)", r.isError && !r.thrown && r.ms < 15000 && r.text.length > 20, `${r.ms} ms: ${r.text}`);
  }
}

// ---------------------------------------------------------------------------------------------
// CASE 3: evaluate-script CSP matrix
// ---------------------------------------------------------------------------------------------
async function case3() {
  const T = "evaluate-script";
  if (lacks(T, "engine", "world").length) return rec("3.0", "evaluate-script schema has engine + world", "FAIL", "evaluate-script schema lacks engine/world (stale server build)");
  await tabs.closeExtra();
  const csp = {};
  for (const k of ["none", "self-eval", "self-inline-eval", "self"]) {
    csp[k] = await tabs.open(`${S.base}/page?csp=${k}`, false);
  }
  for (const id of Object.values(csp)) await tabs.waitComplete(id);
  const titleFn = "() => document.title";
  const objFn = "async () => ({ title: document.title, answer: (await Promise.resolve(40)) + 2 })";

  // informational: what the default world does on every variant
  const today = {};
  for (const k of Object.keys(csp)) today[k] = await tool(T, { tabId: csp[k], function: titleFn });
  rec("3.info", "TODAY: default-world evaluate-script `() => document.title` on each CSP variant", "INFO", Object.entries(today).map(([k, r]) => `csp=${k}: ${r.isError ? "ERROR " : "ok "}${shorten(r.text, 140)}`).join(" || "));

  const noneOk = !today.none.isError && /probe page/.test(today.none.text);
  // The evaluate-script change is "in the build" when its new CSP wording ("forbids eval", from
  // chrome-extension/main-world-eval.ts and mcp-server/server.ts) is in the shipped bundles; at the commit before it
  // the bundles only had "forbids inline script execution". Present -> a failing assertion is a FAIL (a regression);
  // absent -> PENDING.
  const evalLanded = /forbids eval/.test(S.bundleText);
  const pend = evalLanded ? null : 'the new evaluate-script wording ("forbids eval") is not in the built bundles: the evaluate-script change is not in this build';
  rec("3.info2", "evaluate-script change in the build (marker: \"forbids eval\")", "INFO", evalLanded ? "yes" : "no: pre-change behaviour is expected");

  verdict("3.1", "csp=none default world returns document.title", noneOk, today.none.text, pend);
  const obj = await tool(T, { tabId: csp.none, function: objFn });
  verdict("3.2", "csp=none default world awaits a promise and returns an object", !obj.isError && /probe page/.test(obj.text) && /42/.test(obj.text), obj.text, pend);
  for (const k of ["self-eval", "self-inline-eval"]) {
    const r = today[k];
    verdict(`3.3.${k}`, `csp=${k} default world returns the value`, !r.isError && /probe page/.test(r.text), r.text, pend);
  }
  const selfObj = today.self;
  verdict(
    "3.4",
    'csp=self (eval forbidden): default world -> isError naming the page CSP / unsafe-eval AND engine:"cdp"',
    selfObj.isError && /CSP|Content[- ]Security[- ]Policy|unsafe-eval/i.test(selfObj.text) && /engine\s*[:=]\s*\\?["']?cdp/i.test(selfObj.text),
    selfObj.text,
    pend,
  );

  const cdp = await tool(T, { tabId: csp.self, function: titleFn, engine: "cdp" });
  if (cdp.isError && /could not attach the debugger|Cannot attach|Another debugger is already attached|Debugger is not attached/i.test(cdp.text) && !/probe page/.test(cdp.text)) {
    rec("3.5", 'csp=self with engine:"cdp" returns the value', "SKIPPED", cdp.text, { reason: "the debugger could not attach in this headless browser" });
  } else {
    verdict("3.5", 'csp=self with engine:"cdp" returns the value', !cdp.isError && /probe page/.test(cdp.text), cdp.text, pend);
  }

  const hang = await tool(T, { tabId: csp.none, function: "() => new Promise(() => {})" }, { timeoutMs: 50000 });
  const after = await tool(T, { tabId: csp.none, function: titleFn });
  const hangOk = hang.isError && !hang.thrown && hang.ms <= 20000 && /time(d)? ?out|timeout|did not settle|never/i.test(hang.text);
  verdict("3.6", "never-settling promise -> timeout error within ~15 s (<= 20 s)", hangOk, `${hang.ms} ms: ${hang.text}`, pend);
  verdict("3.7", "the tab is not wedged: the call after the hang works", !after.isError && /probe page/.test(after.text), after.text, pend);

  const iso = await tool(T, { tabId: csp.none, function: titleFn, world: "isolated" });
  verdict("3.8", 'world:"isolated" still returns the honest-degrade error (isError, names the CSP/eval limit)', iso.isError && !iso.thrown && /isolated|CSP|unsafe-eval|Content[- ]Security/i.test(iso.text), iso.text);
}

// ---------------------------------------------------------------------------------------------
// CASE 4: snapshot on a loading tab
// ---------------------------------------------------------------------------------------------
const WAIT_MARKERS = [/\bsettleSnapshot\b/, /\bwaitedMs\b/, /waited \$\{\w+\} for the page/];
const WAIT_WORDING = /wait|still (loading|rendering|settling)|loading|rendering|settl/i;
async function case4() {
  await tabs.closeExtra();
  const markerLanded = WAIT_MARKERS.some((rx) => rx.test(S.bundleText));
  const firstLine = (t) => t.split("\n")[0];
  const oldShape = (r) => r.isError || /nothing interactive matched|NAVIGATING|NO DOCUMENT CONTENT/.test(firstLine(r.text)) || /^\[snapshot: 0 elements\]/.test(firstLine(r.text));
  const pendingFor = (r) => (oldShape(r) && !markerLanded ? "output still has the pre-feature shape (bare/0-element or error) and no wait marker is in the build: the snapshot-wait change is not in yet" : null);
  rec("4.info", "wait markers in the built bundles", "INFO", markerLanded ? `found: ${WAIT_MARKERS.filter((rx) => rx.test(S.bundleText)).join(" ")}` : "none found (heuristic); pre-feature output shapes are treated as PENDING");

  const timeline = async (path, label, needsButton) => {
    const tOpen0 = Date.now();
    const opened = await tool("open-browser-tab", { url: `${S.base}${path}` });
    const tOpenMs = Date.now() - tOpen0;
    const m = opened.text.match(/tab id (\d+)/);
    if (!m) return { err: `open-browser-tab: ${opened.text}` };
    const tabId = Number(m[1]);
    const t1 = Date.now();
    const snap = await tool("take-snapshot", { tabId }, { timeoutMs: 40000 });
    const snapMs = Date.now() - t1;
    const settled = await tabs.waitComplete(tabId, 15000);
    // page-world timestamps (the SPA/page records them); polled for up to 8 s so a late render is still measured
    const render = await swEval(
      async (a) => {
        const t0 = Date.now();
        let last = null;
        while (Date.now() - t0 < a.ms) {
          try {
            const r = await chrome.scripting.executeScript({ target: { tabId: a.tabId }, world: "MAIN", func: () => ({ vis: document.visibilityState, rs: document.readyState, loadedAt: window.__loadedAt, renderedAt: window.__renderedAt, button: !!document.querySelector("button") }) });
            last = r && r[0] && r[0].result;
          } catch (e) {
            last = { error: String((e && e.message) || e) };
          }
          if (!a.wantRender || (last && (last.renderedAt !== undefined || last.error))) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        return last;
      },
      { tabId, ms: needsButton === "Late Button" ? 8000 : 0, wantRender: needsButton === "Late Button" },
    );
    const hasButton = needsButton ? new RegExp(needsButton).test(snap.text) : false;
    const fl = firstLine(snap.text);
    const sawWait = WAIT_WORDING.test(fl) && !/nothing interactive matched/.test(fl);
    return { tabId, tOpenMs, snapMs, snap, settled, render, hasButton, firstLine: fl, sawWait, label };
  };
  const fmt = (x) => `open ${x.tOpenMs} ms; snapshot ${x.snapMs} ms (${x.snap.isError ? "ERROR" : "ok"}); tab complete after ${x.settled?.ms ?? "?"} ms; page ${JSON.stringify(x.render)}; first line: ${x.firstLine}`;

  const spa = await timeline("/spa?ms=2500", "spa", "Late Button");
  if (spa.err) rec("4.1", "SPA shell (complete, app renders after 2.5 s): snapshot right after open-browser-tab", "FAIL", spa.err);
  else verdict("4.1", "SPA shell: snapshot right after open contains the rendered button, or its count line says it waited / is still loading (never a bare 0-element snapshot)", !spa.snap.isError && (spa.hasButton || spa.sawWait), `${fmt(spa)} :: ${spa.snap.text}`, pendingFor(spa.snap));

  const slow = await timeline("/slow?ms=3000", "slow", null);
  if (slow.err) rec("4.2", "/slow?ms=3000: snapshot right after open", "FAIL", slow.err);
  else verdict("4.2", "/slow?ms=3000 (document still loading): count line says the extension waited / the page is still loading, not a bare 0-element snapshot", !slow.snap.isError && slow.sawWait, `${fmt(slow)} :: ${slow.snap.text}`, pendingFor(slow.snap));

  const slowUi = await timeline("/slow-ui?ms=3000", "slow-ui", "Slow Button");
  if (slowUi.err) rec("4.3", "/slow-ui?ms=3000: snapshot right after open", "FAIL", slowUi.err);
  else verdict("4.3", "/slow-ui?ms=3000: snapshot contains the Slow Button (the extension waited) or says it waited", !slowUi.snap.isError && (slowUi.hasButton || slowUi.sawWait), `${fmt(slowUi)} :: ${slowUi.snap.text}`, pendingFor(slowUi.snap));

  // a genuinely empty, complete page must come back promptly with no wait wording
  const emptyId = await tabs.open(`${S.base}/empty`, false);
  await tabs.waitComplete(emptyId);
  const e = await tool("take-snapshot", { tabId: emptyId });
  const efl = firstLine(e.text);
  verdict("4.4", "genuinely empty complete page (/empty): returns in < 1.5 s, 0-element count line, no wait wording", !e.isError && e.ms < 1500 && /^\[snapshot: 0 elements/.test(efl) && !/\bwait/i.test(efl), `${e.ms} ms :: ${e.text}`);
  const emptyFresh = await timeline("/empty", "empty-immediate", null);
  if (!emptyFresh.err) rec("4.info2", "INFO: /empty snapshotted right after open-browser-tab (not asserted)", "INFO", fmt(emptyFresh));
}

// ---------------------------------------------------------------------------------------------
// CASE 5: tab access diagnosis
// ---------------------------------------------------------------------------------------------
const TAG = {
  discarded: "TAB DISCARDED:",
  restricted: "TAB NOT SCRIPTABLE (restricted page):",
  errorPage: "TAB SHOWS A BROWSER ERROR PAGE:",
  site: "SITE ACCESS NOT GRANTED:",
};
const noUrlTokens = (t) => !/fake-token-123|fake-jwt-abc|fake-payload-xyz/.test(t) && !/https?:\/\/[^\s"')]*\?[^\s"')]*=/.test(t);
async function case5() {
  await tabs.closeExtra();
  const base = S.base;
  const inBuild = (tag) => S.bundleText.includes(tag);
  const pend = (tag) => (inBuild(tag) ? null : `the tag "${tag}" is not in the built bundles: the tab-access diagnosis change is not in yet`);
  rec("5.info", "contract tags found in the built bundles", "INFO", Object.values(TAG).map((t) => `${t} ${inBuild(t) ? "yes" : "no"}`).join(" ; "));

  // site-access baseline: the manifest must NOT hold <all_urls>, or the un-granted case proves nothing
  const perms = await swEval(async (a) => ({ allUrls: await chrome.permissions.contains({ origins: ["<all_urls>"] }), unGranted: await chrome.permissions.contains({ origins: [a.o] }), loopback: await chrome.permissions.contains({ origins: ["http://127.0.0.1/*"] }) }), { o: `${S.baseA}/*` });
  RESULTS.safety.sitePermissions = perms;

  // generic runner for a restricted-page sub-case
  const diag = async (id, title, url, tag, { alsoEval = false, maxMs = 15000, extra = () => true } = {}) => {
    const opened = await tabs.tryOpen(url, false);
    if (opened.error) {
      rec(id, title, "SKIPPED", opened.error, { reason: `tabs.create refused ${url.split(":")[0]}: in this browser` });
      return null;
    }
    await tabs.waitComplete(opened.id, 8000);
    const snap = await tool("take-snapshot", { tabId: opened.id }, { timeoutMs: 40000 });
    const checkText = (r) => r.text.startsWith(tag) && !r.thrown && r.ms <= maxMs && noUrlTokens(r.text) && extra(r.text);
    verdict(id, title, checkText(snap), `${snap.ms} ms :: ${snap.text}`, pend(tag));
    if (snap.ms > 5000) rec(`${id}.slow`, `INFO: the diagnosis for this tab took ${snap.ms} ms (the contract only bounds it at ${maxMs} ms)`, "INFO", "");
    if (alsoEval) {
      const ev = await tool("evaluate-script", { tabId: opened.id, function: "() => 1" }, { timeoutMs: 40000 });
      verdict(`${id}b`, `${title} (evaluate-script)`, checkText(ev), `${ev.ms} ms :: ${ev.text}`, pend(tag));
    }
    return opened.id;
  };

  // 5.1 discarded tab (a background tab is discarded; the active tab stays elsewhere)
  const dUrl = `${base}/page?csp=none&ui=1&title=Discard%20Me&token=fake-token-123`;
  const dId = await tabs.open(dUrl, true);
  await tabs.waitComplete(dId);
  const keeper = await tabs.open(`${base}/page?csp=none&title=Keeper`, true);
  await tabs.waitComplete(keeper);
  const disc = await tabs.discard(dId);
  if (disc.error || !disc.discarded) {
    rec("5.1", "discarded tab: take-snapshot / evaluate-script start with TAB DISCARDED:", "SKIPPED", JSON.stringify(disc), { reason: "tabs.discard did not discard the tab in this headless browser" });
  } else {
    const noRawAdvice = (t) => {
      const idx = t.indexOf("Original error:");
      const advice = idx >= 0 ? t.slice(0, idx) : t;
      return !/Extension manifest must request permission/i.test(advice);
    };
    const snap = await tool("take-snapshot", { tabId: dId }, { timeoutMs: 40000 });
    verdict("5.1", "discarded tab: take-snapshot starts with TAB DISCARDED:, no misleading permission advice, no URL tokens", snap.text.startsWith(TAG.discarded) && noRawAdvice(snap.text) && noUrlTokens(snap.text), `${snap.ms} ms :: ${snap.text}`, pend(TAG.discarded));
    const ev = await tool("evaluate-script", { tabId: dId, function: "() => document.title" }, { timeoutMs: 40000 });
    verdict("5.2", "discarded tab: evaluate-script starts with TAB DISCARDED:, no misleading permission advice, no URL tokens", ev.text.startsWith(TAG.discarded) && noRawAdvice(ev.text) && noUrlTokens(ev.text), `${ev.ms} ms :: ${ev.text}`, pend(TAG.discarded));
    // recovery: activateTab:true reloads it
    const still = await tabs.info(dId);
    const back = await tool("take-snapshot", { tabId: dId, activateTab: true }, { timeoutMs: 40000 });
    let recovered = !back.isError && /\[uid=e\d+\]/.test(back.text) && /OK/.test(back.text) && !back.text.startsWith(TAG.discarded);
    let how = "take-snapshot activateTab:true";
    if (!recovered) {
      // second route: discard again, reload from the extension, then snapshot
      const second = await tabs.open(`${base}/page?csp=none&title=Keeper2`, true);
      await tabs.waitComplete(second);
      const d2 = await tabs.discard(dId);
      if (!d2.error && d2.discarded) {
        await tabs.reload(dId);
        await tabs.waitComplete(dId, 10000);
        const again = await tool("take-snapshot", { tabId: dId }, { timeoutMs: 40000 });
        recovered = !again.isError && /\[uid=e\d+\]/.test(again.text);
        how = `chrome.tabs.reload then take-snapshot (activateTab route said: ${shorten(back.text, 120)})`;
      }
    }
    verdict("5.3", "the discarded tab works again after activateTab:true (reload) or chrome.tabs.reload", recovered, `via ${how}; tab before: discarded=${still.discarded}; ${shorten(back.text, 200)}`, pend(TAG.discarded) ? "the discarded-tab diagnosis/recovery change is not in this build" : null);
  }
  await tabs.closeExtra();

  await diag("5.4", "chrome://version tab -> TAB NOT SCRIPTABLE (restricted page): within 5 s", "chrome://version", TAG.restricted, { alsoEval: true, maxMs: 5000 });
  await tabs.closeExtra();
  await diag("5.5", "about:blank tab -> TAB NOT SCRIPTABLE (restricted page):", "about:blank", TAG.restricted);
  await tabs.closeExtra();
  await diag("5.6", "data: URL tab -> restricted tag, the data: payload is not echoed", "data:text/html,<title>x</title><p>fake-payload-xyz</p>", TAG.restricted, { extra: (t) => !t.includes("fake-payload-xyz") });
  await tabs.closeExtra();
  await diag("5.7", "view-source: tab -> restricted tag, no hang", `view-source:${base}/page?csp=none`, TAG.restricted);
  await tabs.closeExtra();
  await diag("5.8", "connection-refused tab (http://127.0.0.1:1/) -> TAB SHOWS A BROWSER ERROR PAGE:", "http://127.0.0.1:1/", TAG.errorPage);
  await tabs.closeExtra();
  if (perms.allUrls || perms.unGranted) {
    rec("5.9", "un-granted host -> SITE ACCESS NOT GRANTED: naming chrome://extensions and Site access", "SKIPPED", JSON.stringify(perms), { reason: "the browser already holds access to the un-granted host" });
  } else {
    await diag("5.9", "un-granted host http://a.example.test -> SITE ACCESS NOT GRANTED: naming chrome://extensions and Site access", `${S.baseA}/page?csp=none`, TAG.site, { alsoEval: true, extra: (t) => t.includes("chrome://extensions") && /Site access/.test(t) });
  }
  const sideTabs = (await tabs.list()).filter((t) => t.id !== S.anchor && !(t.url ?? "").startsWith("about:blank"));
  rec("5.9.side", "INFO: tabs left open after the un-granted-host call (side effects, closed before the next case)", "INFO", sideTabs.map((t) => (t.url ?? t.pendingUrl ?? "").replace(/\?.*$/, "?...")).join(" | "));
  await tabs.closeExtra(); // the un-granted-host path opens an options tab as a side effect

  const fresh = await tabs.open(`${base}/page?csp=none&ui=1&title=Fresh`, true);
  await tabs.waitComplete(fresh);
  const ok = await tool("take-snapshot", { tabId: fresh });
  verdict("5.10", "fresh tab on 127.0.0.1 -> normal success (count line + uid'd button)", !ok.isError && /^\[snapshot: [1-9]\d* element/.test(ok.text) && /\[uid=e\d+\]/.test(ok.text) && !Object.values(TAG).some((t) => ok.text.startsWith(t)), ok.text);
}

// ---------------------------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------------------------
async function cleanup(report) {
  const killed = [];
  try {
    if (S.client) await withTimeout(S.client.close(), 4000, "mcp close").catch(() => {});
  } catch {}
  // the browser: graceful first (flushes the net-log), then only recorded descendants
  const descBefore = S.browser ? descendants(S.browser.pid) : [];
  try {
    await closeBrowser();
  } catch {}
  const mineMarker = S.tmp;
  const table = (() => {
    try {
      return psTable();
    } catch {
      return [];
    }
  })();
  const byPid = new Map(table.map((r) => [r.pid, r]));
  for (const pid of [...descBefore, ...(S.browser ? [S.browser.pid] : []), ...(S.broker ? [S.broker.pid] : []), ...(S.transport?.pid ? [S.transport.pid] : [])]) {
    const row = byPid.get(pid);
    if (!row) continue;
    // PID-reuse guard: only signal a process that is still ours (its command line names our temp dir or our dist copy)
    if (mineMarker && row.command.includes(mineMarker)) {
      try {
        process.kill(pid, "SIGTERM");
        killed.push(pid);
      } catch {}
    }
  }
  // a broker the MCP server may have spawned itself on OUR test port (detached): find it by socket, never by name
  if (S.brokerPort) {
    const r = lsof(["-iTCP:" + S.brokerPort, "-sTCP:LISTEN", "-t"]);
    for (const p of r.out.split("\n").map((s) => Number(s.trim())).filter(Boolean)) {
      const row = byPid.get(p) ?? { command: "" };
      if (p !== process.pid && row.command.includes(S.tmp ?? "\0")) {
        try {
          process.kill(p, "SIGTERM");
          killed.push(p);
        } catch {}
      }
    }
  }
  await sleep(1200);
  for (const pid of killed) if (pidAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const pid of [...livePids.keys()]) {
    const row = byPid.get(pid);
    if (pidAlive(pid) && row && S.tmp && row.command.includes(S.tmp)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
  livePids.clear();
  knownPids.clear();
  try {
    for (const k of ["canary4", "canary6", "ctl6"]) S.canaries?.[k]?.close();
    await S.fixture?.close();
  } catch {}
  report.killedPids = killed;
  try {
    const leftover = psTable().filter((r) => S.tmp && r.command.includes(S.tmp) && r.pid !== process.pid);
    for (const r of leftover) {
      try {
        process.kill(r.pid, "SIGKILL");
      } catch {}
    }
    report.leftoverProcessesFoundAndKilled = leftover.length;
  } catch {}
  if (!KEEP && S.tmp && S.tmp.startsWith(os.tmpdir()) && path.basename(S.tmp).startsWith("foxpilot-e2e-")) {
    fs.rmSync(S.tmp, { recursive: true, force: true });
    report.tempRemoved = true;
  } else if (S.tmp) {
    report.tempKept = S.tmp;
  }
}

async function main() {
  RESULTS.meta = { startedAt: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`, strict: STRICT, only: ONLY ? [...ONLY] : "all", seatbelt: SEATBELT };
  if (!fs.existsSync(CHROMIUM)) {
    console.error(`Chromium not found at ${CHROMIUM}; set CHROMIUM_BIN`);
    return 2;
  }
  S.tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foxpilot-e2e-"));
  S.home = path.join(S.tmp, "home");
  fs.mkdirSync(S.home, { recursive: true });
  const cleanupReport = {};
  let exitCode = 0;
  try {
    // 1. ports and servers
    S.fixture = await startServer();
    S.fixturePort = S.fixture.port;
    S.base = `http://127.0.0.1:${S.fixturePort}`;
    S.baseA = `http://a.example.test:${S.fixturePort}`;
    S.brokerPort = await freePort();
    S.sidecarPort = await freePort();
    for (const p of [S.brokerPort, S.sidecarPort, S.fixturePort]) if (FORBIDDEN_PORTS.includes(p)) throw new SafetyAbort(`picked a forbidden port ${p}`);
    await startCanaries();
    RESULTS.meta.ports = { fixture: S.fixturePort, broker: S.brokerPort, sidecar: S.sidecarPort, canary: S.canaryPort };
    console.log(`isolation: HOME=${S.home}\n           broker/EXTENSION_PORT=${S.brokerPort} fixture=${S.fixturePort} canary=${S.canaryPort} seatbelt=${SEATBELT ? "on (deny :8089 :8090 :canary)" : "OFF"}`);

    // 2. build, snapshot, patch (aborts before any browser exists)
    buildAndSnapshot();
    patchExtension();
    console.log(`extension ${RESULTS.meta.fingerprint.extensionVersion}: ${RESULTS.safety.patch.patched.join("; ")}`);
    seatbeltPreflight();
    if (SEATBELT) console.log(`seatbelt pre-flight: ${RESULTS.safety.seatbelt.preflight.map((x) => `${x.name}=${x.result}`).join(", ")}`);

    // 3. broker, browser
    await startBroker();
    const b = await launchChromium();
    RESULTS.meta.browser = { product: b.version.product, headless: !HEADED, pid: b.pid };
    await findSw();
    // wake-up race: the extension may need a moment to run its initial connect
    const ports = await swEval(async () => (await chrome.storage.local.get("config")).config?.ports ?? null);
    const tabsNow = await tabs.list();
    S.anchor = (tabsNow.find((t) => t.url === "about:blank" || t.pendingUrl === "about:blank") ?? tabsNow[0])?.id ?? null;

    await browserCanaryProof();
    let health = null;
    const tConn = Date.now();
    while (Date.now() - tConn < 45000) {
      const h = await httpGet(S.brokerPort, "/health");
      if (h && h.status === 200) {
        health = JSON.parse(h.body);
        if (health.extensionConnected) break;
      }
      await sleep(400);
    }
    if (!health?.extensionConnected) {
      const st = await swEval(async () => (await chrome.storage.local.get("brokerStatus")).brokerStatus ?? null).catch((e) => errText(e));
      throw new InfraError(`extension did not connect to the test broker on ${S.brokerPort} within 45 s. health=${JSON.stringify(health)} extension brokerStatus=${JSON.stringify(st)} stored ports=${JSON.stringify(ports)}\nbroker log:\n${tail(path.join(S.tmp, "broker.log"))}\nchromium log:\n${tail(S.browser.logPath)}`);
    }
    const storedPorts = await swEval(async () => (await chrome.storage.local.get("config")).config?.ports ?? null);
    RESULTS.safety.extensionPorts = storedPorts;
    if (storedPorts && storedPorts.some((p) => p !== S.brokerPort)) throw new SafetyAbort(`extension stored ports ${JSON.stringify(storedPorts)} are not [${S.brokerPort}]`);
    RESULTS.safety.brokerHealthAfterConnect = health;

    // 4. Automation Mode (read-modify-write the existing config object)
    const cfg = await swEval(
      async (a) => {
        const cur = (await chrome.storage.local.get("config")).config || { secret: "", ports: [a.port] };
        cur.automationMode = true;
        if (!cur.ports) cur.ports = [a.port];
        await chrome.storage.local.set({ config: cur });
        return { automationMode: cur.automationMode, ports: cur.ports };
      },
      { port: S.brokerPort },
    );
    RESULTS.safety.automationMode = cfg;
    await tabs.closeExtra(); // the install-time options tab

    // 5. MCP layer
    await startMcp();
    const lb = await tool("list-browsers", {});
    if (lb.isError || !/chrome/i.test(lb.text)) throw new InfraError(`list-browsers did not show the test Chrome: ${lb.text}`);
    const logLine = S.mcpStderr.match(/broker log -> (\S+)/);
    if (logLine && !logLine[1].startsWith(S.home)) throw new SafetyAbort(`the MCP server wrote its broker log outside the temp HOME: ${logLine[1]}`);
    RESULTS.safety.controlSecretInTempHome = fs.existsSync(path.join(S.home, ".foxpilot", "control-secret"));
    const proof1 = lsofProof("after the extension and MCP server connected");
    console.log(`PROOF lsof (${proof1.pids} pids: browser tree + broker + MCP server): sockets on :8089 = ${proof1.perPort[8089].length}, on :8090 = ${proof1.perPort[8090].length}, LISTEN on :8089 = ${proof1.listeners8089 ? "YES" : "none"}`);
    console.log(`      connections held by the test pids:\n        ${proof1.allTcp.map(normText).join("\n        ")}`);
    console.log(`      list-browsers: ${lb.text}`);

    // 6. cases
    const plan = [
      ["1", "tab list", case1],
      ["2", "browser-fetch", case2],
      ["3", "evaluate-script CSP matrix", case3],
      ["4", "snapshot on a loading tab", case4],
      ["5", "tab access diagnosis", case5],
    ];
    for (const [n, name, fn] of plan) {
      if (ONLY && !ONLY.has(n)) continue;
      console.log(`\n=== CASE ${n}: ${name}`);
      const t0 = Date.now();
      try {
        await fn();
      } catch (e) {
        if (e instanceof SafetyAbort) throw e;
        rec(`${n}.crash`, `case ${n} (${name}) threw`, "FAIL", `${errText(e)}\n${String(e && e.stack).split("\n").slice(0, 4).join(" | ")}`);
      }
      try {
        await tabs.closeExtra();
      } catch {}
      console.log(`    (case ${n}: ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    }

    // 7. final safety proofs
    const proof2 = lsofProof("after the last case");
    console.log(`\nPROOF lsof (after cases, ${proof2.pids} pids): sockets on :8089 = ${proof2.perPort[8089].length}, on :8090 = ${proof2.perPort[8090].length}`);
    await closeBrowser();
    const nl = netlogProof();
    console.log(`PROOF net-log (${nl.bytes ?? 0} bytes of browser network events): attempts to :8089/:8090 = ${nl.attemptsTo8089or8090 ?? "n/a"}; extension websocket events to the test broker = ${nl.extensionWebSocketEventsToTestBroker ?? "n/a"}; denied canary attempts visible in the log (control) = ${nl.blockedCanaryAttemptsVisibleInLog ?? "n/a"}`);
    if (!nl.ok) {
      rec("SAFETY.netlog", "browser net-log shows no connection attempt to 8089/8090 (and does show the test broker websocket)", "FAIL", JSON.stringify(nl));
    } else {
      rec("SAFETY.netlog", "browser net-log shows no connection attempt to 8089/8090 (and does show the test broker websocket)", "PASS", `${nl.bytes} bytes scanned, 0 attempts to 8089/8090, ${nl.extensionWebSocketEventsToTestBroker} websocket events to the test broker, ${nl.blockedCanaryAttemptsVisibleInLog} denied-canary events visible (the log does record blocked attempts)`);
    }
    RESULTS.safety.ok = RESULTS.safety.netlog?.ok === true && RESULTS.safety.lsof.every((p) => p.ok);
  } catch (e) {
    if (e instanceof SafetyAbort) {
      RESULTS.safety.abort = errText(e);
      console.error(`\nSAFETY ABORT: ${errText(e)}`);
      exitCode = 2;
    } else if (e instanceof InfraError) {
      RESULTS.meta.infraError = errText(e);
      console.error(`\nINFRASTRUCTURE FAILURE: ${errText(e)}`);
      exitCode = 2;
    } else {
      RESULTS.meta.crash = String(e && e.stack ? e.stack : e);
      console.error(`\nUNEXPECTED: ${RESULTS.meta.crash}`);
      exitCode = 2;
    }
  } finally {
    await cleanup(cleanupReport);
    RESULTS.meta.cleanup = cleanupReport;
    saveResults();
  }
  const counts = RESULTS.summary;
  console.log("\nRESULTS");
  for (const r of RESULTS.cases) if (r.status !== "INFO") console.log(`  ${r.status.padEnd(7)} ${r.id.padEnd(10)} ${shorten(r.title, 110)}`);
  console.log(`\nSUMMARY: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")}  (runtime ${((Date.now() - t0Run) / 1000).toFixed(1)} s)`);
  console.log(`cleanup: killed pids ${JSON.stringify(cleanupReport.killedPids ?? [])}; ${cleanupReport.tempRemoved ? "temp dir removed" : `temp kept at ${cleanupReport.tempKept}`}`);
  console.log(`wrote ${RESULTS_PATH}`);
  if (exitCode === 0 && (counts.FAIL ?? 0) > 0) exitCode = 1;
  return exitCode;
}

const watchdog = setTimeout(() => {
  console.error("watchdog: the run took longer than 12 minutes; killing the test processes and exiting");
  killLive();
  process.exit(3);
}, 12 * 60 * 1000);
watchdog.unref();
main().then(
  (code) => process.exit(code),
  (e) => {
    console.error("e2e failed:", e && e.stack ? e.stack : e);
    killLive();
    process.exit(2);
  },
);
