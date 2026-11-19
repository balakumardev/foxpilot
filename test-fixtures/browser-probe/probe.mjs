#!/usr/bin/env node
// Live-browser probe: OBSERVES how Chromium + an MV3 extension behave, so unit tests can pin
// real strings instead of guesses. Run:  node test-fixtures/browser-probe/probe.mjs
//
//   - builds variant A (host_permissions <all_urls>), variant B (optional_host_permissions only,
//     host NOT granted), variant C (A, used for the withhold-then-grant proxy) and a trivial
//     "other" extension into a temp dir,
//   - starts the fixture server (server.mjs) and a headless Chromium with a throwaway profile,
//   - case 5 (tab states: discarded, file:, error page, data:/blob:, slow loads) lives in case5() below,
//   - drives each extension's service worker over raw CDP (Runtime.evaluate in the SW target),
//   - writes OBSERVED.json next to this file (rewritten after every case),
//   - always kills exactly the PIDs it spawned and removes its temp profile.
//
// Dependency-free except `ws`, resolved by absolute path from mcp-server/node_modules.
// Everything is *.example.test (mapped to 127.0.0.1 in the browser), 127.0.0.1 and fake tokens.
//
// Env: CHROMIUM_BIN (default: Playwright's chromium-1187 under ~/Library/Caches/ms-playwright),
//      PROBE_WS_PATH (default: ../../mcp-server/node_modules/ws), PROBE_HEADED=1 (no --headless),
//      PROBE_CASES=1,2,3,4,5 (subset). Set TMPDIR to choose where the temp profile lives.
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startServer } from "./server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const WebSocket = require(process.env.PROBE_WS_PATH ?? path.resolve(HERE, "../../mcp-server/node_modules/ws"));
const CHROMIUM =
  process.env.CHROMIUM_BIN ??
  path.join(os.homedir(), "Library/Caches/ms-playwright/chromium-1187/chrome-mac/Chromium.app/Contents/MacOS/Chromium");
const CASES = new Set((process.env.PROBE_CASES ?? "1,2,3,4,5").split(",").map((s) => s.trim()));
const OBSERVED_PATH = path.join(HERE, "OBSERVED.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms: ${label}`)), ms))]);
const errText = (e) => String((e && e.message) || e);

// ---------------------------------------------------------------------------------------------
// process bookkeeping: only ever signal PIDs this script spawned
// ---------------------------------------------------------------------------------------------
const livePids = new Set();
function killAllLive() {
  for (const pid of livePids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}
process.on("exit", killAllLive);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    killAllLive();
    process.exit(130);
  });
}

// ---------------------------------------------------------------------------------------------
// raw CDP client
// ---------------------------------------------------------------------------------------------
class CDP {
  constructor(url) {
    this.ws = new WebSocket(url, { perMessageDeflate: false });
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.opened = new Promise((res, rej) => {
      this.ws.once("open", res);
      this.ws.once("error", rej);
    });
    this.ws.on("message", (data) => {
      const m = JSON.parse(String(data));
      if (m.id === undefined) {
        for (const l of this.listeners) l(m);
        return;
      }
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

async function launchBrowser(tmpRoot, tag, extDirs) {
  const profile = path.join(tmpRoot, `profile-${tag}`);
  fs.mkdirSync(profile, { recursive: true });
  const logFd = fs.openSync(path.join(tmpRoot, `chromium-${tag}.log`), "w");
  const list = extDirs.join(",");
  const headless = process.env.PROBE_HEADED !== "1";
  const args = [
    ...(headless ? ["--headless=new"] : []),
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--use-mock-keychain",
    "--password-store=basic",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--no-proxy-server",
    `--disable-extensions-except=${list}`,
    `--load-extension=${list}`,
    "--host-resolver-rules=MAP *.example.test 127.0.0.1",
    "about:blank",
  ];
  const child = spawn(CHROMIUM, args, { stdio: ["ignore", logFd, logFd] });
  fs.closeSync(logFd);
  const b = { tag, pid: child.pid, exited: false, closed: false, headless, cdp: null };
  livePids.add(child.pid);
  child.once("exit", () => {
    b.exited = true;
  });
  const spawnFailed = new Promise((_, rej) => child.once("error", rej));
  const portFile = path.join(profile, "DevToolsActivePort");
  let lines;
  const t0 = Date.now();
  while (!lines) {
    if (Date.now() - t0 > 30000) throw new Error("DevToolsActivePort never appeared");
    if (b.exited) throw new Error("browser exited before DevToolsActivePort appeared");
    try {
      const txt = fs.readFileSync(portFile, "utf8").split("\n");
      if (txt.length >= 2 && txt[1]) lines = txt;
    } catch {}
    if (!lines) await Promise.race([sleep(150), spawnFailed]);
  }
  b.cdp = new CDP(`ws://127.0.0.1:${lines[0]}${lines[1]}`);
  await b.cdp.opened;
  b.version = await b.cdp.send("Browser.getVersion");
  return b;
}

async function closeBrowser(b) {
  if (!b || b.closed) return null;
  b.closed = true;
  try {
    await withTimeout(b.cdp.send("Browser.close"), 3000, "Browser.close");
  } catch {}
  const waitExit = async (ms) => {
    const t0 = Date.now();
    while (!b.exited && Date.now() - t0 < ms) await sleep(100);
  };
  await waitExit(5000);
  let how = "Browser.close";
  if (!b.exited) {
    how = "SIGTERM";
    try {
      process.kill(b.pid, "SIGTERM");
    } catch {}
    await waitExit(3000);
  }
  if (!b.exited) {
    how = "SIGKILL";
    try {
      process.kill(b.pid, "SIGKILL");
    } catch {}
    await waitExit(2000);
  }
  b.cdp.close();
  let alive = true;
  try {
    process.kill(b.pid, 0);
  } catch {
    alive = false;
  }
  livePids.delete(b.pid);
  return { tag: b.tag, closedBy: how, exited: b.exited, pidStillAlive: alive };
}

// ---------------------------------------------------------------------------------------------
// extension variants
// ---------------------------------------------------------------------------------------------
const BASE_PERMS = ["tabs", "scripting", "cookies", "activeTab", "declarativeNetRequest"];

function writeVariants(tmpRoot) {
  const copy = (dir, files) => {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) fs.copyFileSync(path.join(HERE, "ext", f), path.join(dir, f));
  };
  const write = (dir, name, content) => fs.writeFileSync(path.join(dir, name), content);
  const shared = ["worker.js", "perm.html", "perm.js"];

  const A = path.join(HERE, "ext");

  // B: host NOT granted (only an optional grant is declared)
  const B = path.join(tmpRoot, "ext-b");
  copy(B, shared);
  write(
    B,
    "manifest.json",
    JSON.stringify(
      {
        manifest_version: 3,
        name: "probe-B",
        version: "1.0.0",
        permissions: BASE_PERMS,
        optional_host_permissions: ["<all_urls>"],
        background: { service_worker: "worker.js" },
      },
      null,
      2,
    ),
  );

  // C: same as A, but a separate extension so case 2 can withhold + re-grant site access on it
  const C = path.join(tmpRoot, "ext-c");
  copy(C, shared);
  write(
    C,
    "manifest.json",
    JSON.stringify(
      {
        manifest_version: 3,
        name: "probe-C",
        version: "1.0.0",
        permissions: BASE_PERMS,
        host_permissions: ["<all_urls>"],
        background: { service_worker: "worker.js" },
      },
      null,
      2,
    ),
  );

  // D: same as A; case 5 turns its 'Allow access to file URLs' off (that reloads the extension)
  const D = path.join(tmpRoot, "ext-d");
  copy(D, shared);
  write(
    D,
    "manifest.json",
    JSON.stringify(
      {
        manifest_version: 3,
        name: "probe-D",
        version: "1.0.0",
        permissions: BASE_PERMS,
        host_permissions: ["<all_urls>"],
        background: { service_worker: "worker.js" },
      },
      null,
      2,
    ),
  );

  // other: a second, unrelated extension so tabs on chrome-extension://<other id>/ exist
  const O = path.join(tmpRoot, "ext-other");
  copy(O, ["worker.js"]);
  write(
    O,
    "manifest.json",
    JSON.stringify(
      {
        manifest_version: 3,
        name: "probe-other",
        version: "1.0.0",
        background: { service_worker: "worker.js" },
        web_accessible_resources: [{ resources: ["public.html"], matches: ["<all_urls>"] }],
      },
      null,
      2,
    ),
  );
  write(O, "public.html", "<!doctype html><meta charset=utf-8><title>other public</title><p>web accessible</p>");
  write(O, "private.html", "<!doctype html><meta charset=utf-8><title>other private</title><p>not web accessible</p>");
  return { A, B, C, D, other: O };
}

async function findWorkers(b, wantNames, timeoutMs = 25000) {
  const found = {};
  const sessions = new Map(); // targetId -> sessionId (attach once, retry the name probe)
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const { targetInfos } = await b.cdp.send("Target.getTargets");
    for (const t of targetInfos) {
      if (t.type !== "service_worker" || !t.url.startsWith("chrome-extension://")) continue;
      if (Object.values(found).some((w) => w.targetId === t.targetId)) continue;
      let sessionId = sessions.get(t.targetId);
      if (!sessionId) {
        ({ sessionId } = await b.cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true }));
        sessions.set(t.targetId, sessionId);
      }
      let name;
      try {
        const r = await b.cdp.send(
          "Runtime.evaluate",
          { expression: "chrome.runtime.getManifest().name", returnByValue: true },
          sessionId,
        );
        name = r.result && r.result.value;
      } catch {}
      if (typeof name !== "string") continue; // context not ready yet; try again next round
      found[name] = { name, targetId: t.targetId, sessionId, extId: new URL(t.url).host };
    }
    if (wantNames.every((n) => found[n])) return found;
    await sleep(300);
  }
  throw new Error(`service workers not found (have ${Object.keys(found)}; want ${wantNames})`);
}

// ---------------------------------------------------------------------------------------------
// service-worker snippets. Each snippet is stringified and evaluated INSIDE the extension's
// service worker, so it may only use its single argument and the helpers from __prelude().
// Functions handed to chrome.scripting.executeScript must be self-contained too.
// ---------------------------------------------------------------------------------------------
function __prelude() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const race = (p, ms, label) =>
    Promise.race([p, new Promise((r) => setTimeout(() => r({ __timedOut: true, label, afterMs: ms }), ms))]);
  const errInfo = (e) => ({ name: e && e.name, message: String(e && e.message !== undefined ? e.message : e) });
  const tabInfo = async (id) => {
    try {
      const t = await chrome.tabs.get(id);
      return {
        id: t.id,
        url: t.url,
        pendingUrl: t.pendingUrl === undefined ? "<<absent>>" : t.pendingUrl,
        status: t.status,
        discarded: t.discarded,
        active: t.active,
      };
    } catch (e) {
      return { error: errInfo(e) };
    }
  };
  const fullTab = async (id) => {
    try {
      const t = await chrome.tabs.get(id);
      const f = (v) => (v === undefined ? "<<absent>>" : v);
      return { id: t.id, url: f(t.url), pendingUrl: f(t.pendingUrl), title: f(t.title), status: t.status, discarded: t.discarded, active: t.active };
    } catch (e) {
      return { error: errInfo(e) };
    }
  };
  // polls tabs.get every 50 ms and records only the CHANGES, relative to t0, until done(tab) or maxMs
  const watchTab = async (id, t0, maxMs, done = (t) => t.status === "complete") => {
    const changePoints = [];
    let last = "";
    let doneAtMs = null;
    while (Date.now() - t0 < maxMs) {
      const t = await fullTab(id);
      const key = JSON.stringify([t.status, t.discarded, t.active, t.url, t.pendingUrl, t.title, t.error]);
      if (key !== last) {
        const { id: _id, ...rest } = t;
        changePoints.push({ atMs: Date.now() - t0, ...rest });
        last = key;
      }
      if (!t.error && done(t)) {
        doneAtMs = Date.now() - t0;
        break;
      }
      await sleep(50);
    }
    return { changePoints, doneAtMs, gaveUpAtMs: doneAtMs === null ? maxMs : undefined };
  };
  const waitComplete = async (id, ms = 10000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      let t;
      try {
        t = await chrome.tabs.get(id);
      } catch (e) {
        return false;
      }
      if (t.status === "complete") return true;
      await sleep(100);
    }
    return false;
  };
  const openTab = async (url, active = true) => (await chrome.tabs.create({ url, active })).id;
  const closeTab = async (id) => {
    try {
      await chrome.tabs.remove(id);
    } catch (e) {}
  };
  // executeScript wrapper: keeps every key of each InjectionResult except documentId, and marks an
  // absent/undefined result explicitly (returnByValue would silently drop undefined).
  const exec = async (opts, ms = 20000) => {
    try {
      const r = await race(chrome.scripting.executeScript(opts), ms, "executeScript");
      if (r && r.__timedOut) return { ok: false, timedOut: true, afterMs: ms };
      return {
        ok: true,
        count: r.length,
        items: r.map((x) => {
          const { documentId, frameId, result, ...rest } = x;
          return {
            frameId,
            keys: Object.keys(x).filter((k) => k !== "documentId"),
            result: result === undefined ? "<<undefined>>" : result,
            ...rest,
          };
        }),
      };
    } catch (e) {
      return { ok: false, ...errInfo(e) };
    }
  };
  const swFetch = async (url, method = "GET") => {
    try {
      const init = { credentials: "include", method };
      if (method === "POST") {
        init.body = "x";
        init.headers = { "content-type": "text/plain" };
      }
      const r = await fetch(url, init);
      return { status: r.status, body: await r.text() };
    } catch (e) {
      return { threw: errInfo(e) };
    }
  };
  const shape = (r) => {
    if (!r || r.threw || r.execError) return r;
    let json;
    try {
      json = JSON.parse(r.body);
    } catch (e) {}
    return json !== undefined ? { status: r.status, json } : { status: r.status, body: r.body };
  };
  const contains = async (origins) => {
    try {
      const r = await race(chrome.permissions.contains({ origins }), 8000, "permissions.contains");
      return r && r.__timedOut ? { timedOut: true } : { returned: r };
    } catch (e) {
      return { threw: errInfo(e) };
    }
  };
  return { sleep, race, errInfo, tabInfo, fullTab, watchTab, waitComplete, openTab, closeTab, exec, swFetch, shape, contains };
}

const PRELUDE_NAMES = "sleep, race, errInfo, tabInfo, fullTab, watchTab, waitComplete, openTab, closeTab, exec, swFetch, shape, contains";

async function swCall(b, w, fn, arg, timeoutMs = 90000) {
  const expression =
    `(async () => { const { ${PRELUDE_NAMES} } = (${__prelude})(); ` +
    `return await (${fn})(${arg === undefined ? "null" : JSON.stringify(arg)}); })()`;
  const run = async () => {
    const r = await withTimeout(
      b.cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, w.sessionId),
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
    return await run();
  } catch (e) {
    if (!/Session with given id not found|Target closed|detached|not found/i.test(errText(e))) throw e;
    const fresh = await findWorkers(b, [w.name], 10000);
    Object.assign(w, fresh[w.name]);
    return await run();
  }
}

// -- tab / permission matrix (case 1) ----------------------------------------------------------
const S_probeTab = async (a) => {
  const out = { label: a.label, requestedUrl: a.url };
  let tabId = a.existingTabId;
  if (tabId === undefined) {
    try {
      const t = await race(chrome.tabs.create({ url: a.url, active: true }), 15000, "tabs.create");
      if (t && t.__timedOut) {
        out.createTimedOutAfterMs = 15000;
        return out;
      }
      tabId = t.id;
      out.createReturned = { url: t.url, pendingUrl: t.pendingUrl, status: t.status };
    } catch (e) {
      out.createError = errInfo(e);
      return out;
    }
  }
  out.waitedUntilComplete = await waitComplete(tabId, 8000);
  out.tab = await tabInfo(tabId);
  out.tabFull = await fullTab(tabId);
  out.executeScript = await exec({ target: { tabId }, func: () => 1 });
  try {
    const m = await race(chrome.tabs.sendMessage(tabId, { ping: 1 }), 8000, "tabs.sendMessage");
    out.sendMessage = m && m.__timedOut ? { timedOutAfterMs: 8000 } : { resolved: true };
  } catch (e) {
    out.sendMessage = { threw: errInfo(e) };
  }
  const tabUrl = out.tab && out.tab.url;
  out.tabUrlTypeof = typeof tabUrl;
  if (typeof tabUrl === "string" && tabUrl !== "") {
    try {
      const o = new URL(tabUrl).origin;
      out.origin = o;
      out.pattern = o + "/*";
      out.permissionsContainsOriginPattern = await contains([o + "/*"]);
    } catch (e) {
      out.originError = errInfo(e);
    }
    out.permissionsContainsFullTabUrl = await contains([tabUrl]);
  }
  if (!a.keep) await closeTab(tabId);
  return out;
};

const S_findTabsByPrefix = async (a) =>
  (await chrome.tabs.query({}))
    .filter((t) => (t.url || "").startsWith(a.prefix) || (t.pendingUrl || "").startsWith(a.prefix))
    .map((t) => ({ id: t.id, url: t.url, pendingUrl: t.pendingUrl, status: t.status }));

// What a naive `new URL(tab.url)` does for the values tabs.create / tabs.get can hand back.
const S_urlParsing = async () => {
  const tryUrl = (v) => {
    try {
      return { origin: new URL(v).origin };
    } catch (e) {
      return { threw: errInfo(e) };
    }
  };
  return { emptyString: tryUrl(""), undefinedValue: tryUrl(undefined), nullValue: tryUrl(null) };
};

const S_permissionsBaseline = async () => ({
  allUrls: await contains(["<all_urls>"]),
  manifestPermissions: chrome.runtime.getManifest().permissions,
  manifestHostPermissions: chrome.runtime.getManifest().host_permissions ?? null,
  manifestOptionalHostPermissions: chrome.runtime.getManifest().optional_host_permissions ?? null,
});

const S_discard = async (a) => {
  const out = {};
  const id1 = await openTab(a.url);
  await waitComplete(id1);
  const id2 = await openTab(a.url); // becomes the active tab, so tab 1 is in the background
  await waitComplete(id2);
  out.tab1BeforeDiscard = await tabInfo(id1);
  try {
    const d = await race(chrome.tabs.discard(id1), 10000, "tabs.discard");
    if (d && d.__timedOut) throw new Error("tabs.discard timed out after 10000ms");
    out.discardReturned = d
      ? { id: d.id, url: d.url, pendingUrl: d.pendingUrl, status: d.status, discarded: d.discarded }
      : String(d);
  } catch (e) {
    out.discardError = errInfo(e);
  }
  await sleep(300);
  out.originalIdAfterDiscard = await tabInfo(id1);
  const execId = out.discardReturned && out.discardReturned.id !== undefined ? out.discardReturned.id : id1;
  out.executeScriptTargetId = execId === id1 ? "same as original id" : "different from original id";
  out.tabDiscardedTarget = await tabInfo(execId);
  out.executeScript = await exec({ target: { tabId: execId }, func: () => 1 });
  out.tabAfterExecuteScript = await tabInfo(execId);
  if (execId !== id1) out.executeScriptOnOriginalId = await exec({ target: { tabId: id1 }, func: () => 1 });
  try {
    const m = await race(chrome.tabs.sendMessage(execId, { ping: 1 }), 8000, "tabs.sendMessage");
    out.sendMessage = m && m.__timedOut ? { timedOutAfterMs: 8000 } : { resolved: true };
  } catch (e) {
    out.sendMessage = { threw: errInfo(e) };
  }
  await closeTab(execId);
  if (execId !== id1) await closeTab(id1);
  await closeTab(id2);
  return out;
};

// -- CSP eval gate (case 3) --------------------------------------------------------------------
const S_evalGate = async (a) => {
  const id = a.tabId; // opened by the caller, who also records the page's console
  const out = { tab: await tabInfo(id) };
  const evalFunc = (src) => {
    try {
      const r = (0, eval)(src);
      return { ok: true, value: JSON.stringify(r) };
    } catch (e) {
      return { ok: false, name: e && e.name, isEvalError: e instanceof EvalError, message: String(e && e.message) };
    }
  };
  const fnFunc = (src) => {
    try {
      const r = new Function(src)();
      return { ok: true, value: JSON.stringify(r) };
    } catch (e) {
      return { ok: false, name: e && e.name, isEvalError: e instanceof EvalError, message: String(e && e.message) };
    }
  };
  for (const world of ["MAIN", "ISOLATED"]) {
    out["indirectEval_" + world] = await exec({ target: { tabId: id }, world, func: evalFunc, args: ["1+1"] });
    out["newFunction_" + world] = await exec({ target: { tabId: id }, world, func: fnFunc, args: ["return 1+1"] });
  }
  // (iv) content-script-style inline <script> injection, then read the flag from MAIN
  out.inlineScriptFromIsolated = await exec({
    target: { tabId: id },
    world: "ISOLATED",
    func: async () => {
      const violations = [];
      const h = (e) =>
        violations.push({
          blockedURI: e.blockedURI,
          violatedDirective: e.violatedDirective,
          effectiveDirective: e.effectiveDirective,
          disposition: e.disposition,
        });
      document.addEventListener("securitypolicyviolation", h);
      const s = document.createElement("script");
      s.textContent = "window.__probe=1";
      document.documentElement.appendChild(s);
      await new Promise((r) => setTimeout(r, 150));
      document.removeEventListener("securitypolicyviolation", h);
      return { appended: true, violations };
    },
  });
  out.inlineScriptFlagReadFromMain = await exec({
    target: { tabId: id },
    world: "MAIN",
    func: () => ({ probe: window.__probe === undefined ? "<<undefined>>" : window.__probe }),
  });
  // control: the same inline <script> created from the page's own (MAIN) world, which is gated
  // by the PAGE's CSP only
  out.inlineScriptFromMainControl = await exec({
    target: { tabId: id },
    world: "MAIN",
    func: async () => {
      const violations = [];
      const h = (e) =>
        violations.push({
          blockedURI: e.blockedURI,
          violatedDirective: e.violatedDirective,
          effectiveDirective: e.effectiveDirective,
          disposition: e.disposition,
        });
      document.addEventListener("securitypolicyviolation", h);
      const s = document.createElement("script");
      s.textContent = "window.__probeMain=1";
      document.documentElement.appendChild(s);
      await new Promise((r) => setTimeout(r, 150));
      document.removeEventListener("securitypolicyviolation", h);
      return { appended: true, flag: window.__probeMain === undefined ? "<<undefined>>" : window.__probeMain, violations };
    },
  });
  return out;
};

const S_promiseTests = async (a) => {
  const id = await openTab(a.url);
  await waitComplete(id);
  const out = {};
  for (const world of ["MAIN", "ISOLATED"]) {
    const w = {};
    const t0 = Date.now();
    w.resolvesAfter200ms = await exec({
      target: { tabId: id },
      world,
      func: () => new Promise((r) => setTimeout(() => r("resolved-after-200ms"), 200)),
    });
    w.resolvesAfter200msElapsedMs = Date.now() - t0;
    const raced = await Promise.race([
      exec({ target: { tabId: id }, world, func: () => new Promise(() => {}) }),
      sleep(4000).then(() => ({ hungPast4000ms: true })),
    ]);
    w.neverSettles = raced;
    w.normalExecuteAfterTheHang = await Promise.race([
      exec({ target: { tabId: id }, world, func: () => "still-works" }),
      sleep(4000).then(() => ({ hungPast4000ms: true })),
    ]);
    out[world] = w;
  }
  const values = {
    domElement: () => document.body,
    windowObject: () => window,
    functionValue: () => function f() {},
    circularObject: () => {
      const o = {};
      o.self = o;
      return o;
    },
    mapObject: () => new Map([[1, 2]]),
    dateObject: () => new Date(0),
    undefinedValue: () => undefined,
    nullValue: () => null,
    nanValue: () => NaN,
    bigintValue: () => 10n,
    symbolValue: () => Symbol("x"),
    objectWithFunctionProp: () => ({ a: 1, f() {} }),
    errorObject: () => new Error("err-obj"),
    rejectedPromise: () => Promise.reject(new Error("rejected-in-func")),
    throwsSynchronously: () => {
      throw new Error("thrown-in-func");
    },
  };
  out.values = {};
  for (const [k, f] of Object.entries(values)) {
    out.values[k] = {
      MAIN: await exec({ target: { tabId: id }, world: "MAIN", func: f }),
      ISOLATED: await exec({ target: { tabId: id }, world: "ISOLATED", func: f }),
    };
  }
  await closeTab(id);
  return out;
};

// -- fetch origin / referer / cookie (case 4) --------------------------------------------------
const S_fetchRound = async (a) => {
  const { tabId, base, xsite } = a;
  const pageFetch = async (url, method) => {
    try {
      const init = { credentials: "include", method };
      if (method === "POST") {
        init.body = "x";
        init.headers = { "content-type": "text/plain" };
      }
      const r = await fetch(url, init);
      return { status: r.status, body: await r.text() };
    } catch (e) {
      return { threw: { name: e && e.name, message: String(e && e.message) } };
    }
  };
  const inPage = async (world, url, method) => {
    const r = await exec({ target: { tabId }, world, func: pageFetch, args: [url, method] });
    return r.ok ? r.items[0].result : { execError: r };
  };
  const ctxs = {
    serviceWorker: (u, m) => swFetch(u, m),
    isolatedWorld: (u, m) => inPage("ISOLATED", u, m),
    mainWorld: (u, m) => inPage("MAIN", u, m),
  };
  const targets = {
    echoGet: [base + "/api/echo", "GET"],
    echoPost: [base + "/api/echo", "POST"],
    guardedGet: [base + "/api/guarded", "GET"],
    guardedPost: [base + "/api/guarded", "POST"],
    guardedLenientGet: [base + "/api/guarded?lenient=1", "GET"],
  };
  const out = { tab: await tabInfo(tabId) };
  try {
    out.cookieJarForBase = (await chrome.cookies.getAll({ url: base + "/" })).map((c) => ({
      name: c.name,
      value: c.value,
      sameSite: c.sameSite,
      httpOnly: c.httpOnly,
      hostOnly: c.hostOnly,
    }));
  } catch (e) {
    out.cookieJarForBase = { threw: errInfo(e) };
  }
  for (const [cn, run] of Object.entries(ctxs)) {
    out[cn] = {};
    for (const [tn, [u, m]] of Object.entries(targets)) out[cn][tn] = shape(await run(u, m));
  }
  if (xsite) {
    out.crossOrigin = {};
    for (const x of xsite) {
      out.crossOrigin[x.label] = {};
      for (const [cn, run] of Object.entries(ctxs)) out.crossOrigin[x.label][cn] = shape(await run(x.url, "GET"));
    }
  }
  return out;
};

const S_dnrTest = async (a) => {
  const origin = a.base;
  const rule = (id, p) => ({
    id,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "origin", operation: "set", value: origin },
        { header: "referer", operation: "set", value: origin + "/page" },
      ],
    },
    condition: { urlFilter: "|" + origin + p, resourceTypes: ["xmlhttprequest", "other"] },
  });
  const out = {};
  const fetchAll = async () => ({
    guardedGet: shape(await swFetch(origin + "/api/guarded", "GET")),
    guardedPost: shape(await swFetch(origin + "/api/guarded", "POST")),
    echoGet: shape(await swFetch(origin + "/api/echo", "GET")),
    echoPost: shape(await swFetch(origin + "/api/echo", "POST")),
  });
  out.before = await fetchAll();
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [rule(9001, "/api/guarded"), rule(9002, "/api/echo")],
    });
    out.rulesInstalled = (await chrome.declarativeNetRequest.getSessionRules()).map((r) => r.id);
    out.withRules = await fetchAll();
  } catch (e) {
    out.error = errInfo(e);
  } finally {
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [9001, 9002] });
    } catch (e) {
      out.removeError = errInfo(e);
    }
    out.rulesAfterRemoval = (await chrome.declarativeNetRequest.getSessionRules()).map((r) => r.id);
  }
  out.afterRemoval = await fetchAll();
  return out;
};

// -- case 2 helpers -----------------------------------------------------------------------------
const S_requestWithoutGesture = async () => {
  try {
    return { returned: await chrome.permissions.request({ origins: ["<all_urls>"] }) };
  } catch (e) {
    return { threw: errInfo(e) };
  }
};

// Starts an executeScript WITHOUT awaiting it; readPendingExec later reports whether it ever settled.
const S_startPendingExec = async (a) => {
  self.__pendingExec = exec({ target: { tabId: a.tabId }, func: () => "pending-exec-result" }, 180000);
  return true;
};
const S_readPendingExec = async () => {
  const r = await race(self.__pendingExec, 8000, "pendingExec");
  return r && r.__timedOut ? { stillPendingAfterMs: 8000 } : r;
};

const S_execOnTab = async (a) => ({
  tab: await tabInfo(a.tabId),
  executeScript: await exec({ target: { tabId: a.tabId }, func: () => 1 }),
});

// -- case 5: tab states (discarded / file / error page / data / blob / slow) ------------------
const S_discardedScenario = async (a) => {
  const out = { mode: a.mode };
  const id1 = await openTab(a.url);
  await waitComplete(id1);
  const id2 = await openTab(a.url); // active tab, so id1 is in the background
  await waitComplete(id2);
  try {
    const d = await race(chrome.tabs.discard(id1), 10000, "tabs.discard");
    if (d && d.__timedOut) throw new Error("tabs.discard timed out after 10000ms");
    const f = (v) => (v === undefined ? "<<absent>>" : v);
    out.discardReturned = d
      ? { id: d.id, url: f(d.url), pendingUrl: f(d.pendingUrl), title: f(d.title), status: d.status, discarded: d.discarded }
      : String(d);
  } catch (e) {
    out.discardError = errInfo(e);
  }
  const tabId = out.discardReturned && out.discardReturned.id !== undefined ? out.discardReturned.id : id1;
  out.tabIdSameAsBeforeDiscard = tabId === id1;
  await sleep(300);
  out.tabsGetAfterDiscard = await fullTab(tabId);
  const probeExec = async (ms) => {
    const t0 = Date.now();
    const r = await exec({ target: { tabId }, func: () => 1 }, ms);
    return { elapsedMs: Date.now() - t0, ...r };
  };
  const untilLoaded = (t) => t.status === "complete" && t.discarded === false;
  if (a.mode === "reload") {
    const t0 = Date.now();
    try {
      const r = await race(chrome.tabs.reload(tabId), 10000, "tabs.reload");
      out.reloadCall = r && r.__timedOut ? { timedOutAfterMs: 10000 } : { resolvedAfterMs: Date.now() - t0 };
    } catch (e) {
      out.reloadCall = { threw: errInfo(e) };
    }
    out.tabRightAfterReloadCall = await fullTab(tabId);
    out.watchAfterReload = await watchTab(tabId, Date.now(), 10000, untilLoaded);
    out.executeScriptAfterwards = await probeExec(10000);
  } else if (a.mode === "update" || a.mode === "updateImmediateExec") {
    const t0 = Date.now();
    try {
      const u = await race(chrome.tabs.update(tabId, { active: true }), 10000, "tabs.update");
      out.updateCall =
        u && u.__timedOut
          ? { timedOutAfterMs: 10000 }
          : { resolvedAfterMs: Date.now() - t0, returnedTab: u && { status: u.status, discarded: u.discarded, active: u.active } };
    } catch (e) {
      out.updateCall = { threw: errInfo(e) };
    }
    if (a.mode === "updateImmediateExec") {
      out.tabAtTheMomentOfTheImmediateCall = await fullTab(tabId);
      out.executeScriptImmediately = await probeExec(6000);
    }
    out.watchAfterUpdate = await watchTab(tabId, Date.now(), 10000, untilLoaded);
    out.executeScriptAfterwards = await probeExec(10000);
  } else if (a.mode === "sendMessage") {
    const t0 = Date.now();
    try {
      const m = await race(chrome.tabs.sendMessage(tabId, { ping: 1 }), 8000, "tabs.sendMessage");
      out.sendMessage = m && m.__timedOut ? { timedOutAfterMs: 8000 } : { resolved: true, elapsedMs: Date.now() - t0 };
    } catch (e) {
      out.sendMessage = { threw: errInfo(e), elapsedMs: Date.now() - t0 };
    }
  } else if (a.mode === "execOnly") {
    out.executeScript = await probeExec(10000);
  }
  out.tabAtEnd = await fullTab(tabId);
  await closeTab(tabId);
  if (tabId !== id1) await closeTab(id1);
  await closeTab(id2);
  return out;
};

const S_fileExtras = async (a) => {
  const out = {};
  try {
    out.newURLOrigin = new URL(a.url).origin;
  } catch (e) {
    out.newURLOrigin = { threw: errInfo(e) };
  }
  out.containsFileScheme = await contains(["file:///*"]);
  out.containsFullFileUrl = await contains([a.url]);
  out.containsAllUrls = await contains(["<all_urls>"]);
  try {
    if (!(chrome.extension && chrome.extension.isAllowedFileSchemeAccess)) {
      out.isAllowedFileSchemeAccess = "<<chrome.extension.isAllowedFileSchemeAccess not available>>";
    } else {
      const v = await race(new Promise((res) => chrome.extension.isAllowedFileSchemeAccess(res)), 5000, "isAllowedFileSchemeAccess");
      out.isAllowedFileSchemeAccess = v && v.__timedOut ? { timedOut: true } : v;
    }
  } catch (e) {
    out.isAllowedFileSchemeAccess = { threw: errInfo(e) };
  }
  return out;
};

const S_blobTab = async (a) => {
  const out = {};
  const id = await openTab(a.pageUrl);
  await waitComplete(id);
  out.createBlobAndNavigate = await exec({
    target: { tabId: id },
    world: "MAIN",
    func: () => {
      const u = URL.createObjectURL(new Blob(["<!doctype html><p>x</p>"], { type: "text/html" }));
      setTimeout(() => {
        location.href = u;
      }, 0);
      return u;
    },
  });
  let t;
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    t = await fullTab(id);
    if (typeof t.url === "string" && t.url.startsWith("blob:")) break;
  }
  out.tabAfterNavigate = t;
  await waitComplete(id, 5000);
  out.tabAfterSettle = await fullTab(id);
  out.executeScript = await exec({
    target: { tabId: id },
    func: () => ({ href: location.href, origin: location.origin, readyState: document.readyState }),
  });
  const tabUrl = out.tabAfterSettle.url;
  if (typeof tabUrl === "string" && tabUrl.startsWith("blob:")) {
    try {
      const o = new URL(tabUrl).origin;
      out.newURLOrigin = o;
      out.containsOriginPattern = await contains([o + "/*"]);
    } catch (e) {
      out.newURLOrigin = { threw: errInfo(e) };
    }
  }
  await closeTab(id);
  return out;
};

// executeScript at a fixed time after a slow navigation starts, and how long the tab stays 'loading'
// (the tabs.get watch starts together with the navigation, not after the executeScript).
const S_slowFirstExec = async (a) => {
  const SLOW_PROBE = () => ({
    readyState: document.readyState,
    href: location.href,
    title: document.title,
    documentElementChildren: document.documentElement ? document.documentElement.childElementCount : null,
    bodyChildren: document.body ? document.body.childElementCount : null,
    hasFirst: !!document.getElementById("first"),
    hasSecond: !!document.getElementById("second"),
  });
  const out = { how: a.how, active: a.active, injectImmediately: !!a.injectImmediately, executeScriptPlannedAtMs: a.atMs };
  const opts = (id, f) => ({ target: { tabId: id }, func: f, ...(a.injectImmediately ? { injectImmediately: true } : {}) });
  let id;
  let t0;
  if (a.how === "navigateExisting") {
    id = await openTab(a.basePage);
    await waitComplete(id);
    out.tabBeforeNavigation = await fullTab(id);
    t0 = Date.now();
    await chrome.tabs.update(id, { url: a.url });
  } else {
    t0 = Date.now();
    const t = await chrome.tabs.create({ url: a.url, active: a.active });
    id = t.id;
    out.createReturned = {
      url: t.url === undefined ? "<<absent>>" : t.url,
      pendingUrl: t.pendingUrl === undefined ? "<<absent>>" : t.pendingUrl,
      status: t.status,
      active: t.active,
    };
  }
  const watching = watchTab(id, t0, 12000);
  out.navigationCallReturnedAtMs = Date.now() - t0;
  await sleep(Math.max(0, a.atMs - (Date.now() - t0)));
  out.tabAtTheCall = await fullTab(id);
  const t1 = Date.now();
  out.executeScript = await exec(opts(id, SLOW_PROBE), 6000);
  out.executeScriptCalledAtMs = t1 - t0;
  out.executeScriptSettledAfterMs = Date.now() - t1;
  out.tabWatchFromNavigationStart = await watching;
  out.executeScriptAfterTheLoad = await exec(opts(id, SLOW_PROBE), 6000);
  await closeTab(id);
  return out;
};

const S_slowSampling = async (a) => {
  const SLOW_PROBE = () => ({
    readyState: document.readyState,
    href: location.href,
    title: document.title,
    documentElementChildren: document.documentElement ? document.documentElement.childElementCount : null,
    bodyChildren: document.body ? document.body.childElementCount : null,
    hasFirst: !!document.getElementById("first"),
    hasSecond: !!document.getElementById("second"),
  });
  const out = { how: a.how, injectImmediately: !!a.injectImmediately, everyMs: a.everyMs, durationMs: a.durationMs };
  let id;
  let t0;
  if (a.how === "navigateExisting") {
    id = await openTab(a.basePage);
    await waitComplete(id);
    t0 = Date.now();
    await chrome.tabs.update(id, { url: a.url });
  } else {
    t0 = Date.now();
    id = (await chrome.tabs.create({ url: a.url, active: true })).id;
  }
  out.samples = [];
  for (let k = 0; k * a.everyMs <= a.durationMs; k++) {
    const planned = k * a.everyMs;
    const wait = planned - (Date.now() - t0);
    if (wait > 0) await sleep(wait);
    const t = await fullTab(id);
    const calledAt = Date.now() - t0;
    const r = await exec(
      { target: { tabId: id }, func: SLOW_PROBE, ...(a.injectImmediately ? { injectImmediately: true } : {}) },
      1500,
    );
    out.samples.push({
      plannedAtMs: planned,
      calledAtMs: calledAt,
      settledAtMs: Date.now() - t0,
      tabStatus: t.status,
      tabUrl: t.url,
      executeScript: r.ok ? r.items[0].result : r.timedOut ? { timedOutAfterMs: 1500 } : { error: r.message },
    });
  }
  await closeTab(id);
  return out;
};

// ---------------------------------------------------------------------------------------------
// case runners
// ---------------------------------------------------------------------------------------------
const execLine = (r) => {
  if (!r) return "(none)";
  if (r.createError) return `tabs.create threw: ${r.createError.message}`;
  const e = r.executeScript;
  if (!e) return "(no executeScript)";
  if (!e.ok && e.timedOut) return `NEVER SETTLED within ${e.afterMs} ms (neither result nor error)`;
  if (!e.ok) return `ERR [${e.name}] ${e.message}`;
  return `OK ${JSON.stringify(e.items.map((i) => i.result))}`;
};

async function runMatrix(b, w, other, ownId, base) {
  const items = [
    ["http-page(csp=none)", `${base}/page?csp=none`],
    ["chrome://version", "chrome://version"],
    ["about:blank", "about:blank"],
    ["view-source:http", `view-source:${base}/page`],
    ["other-extension-page(web-accessible)", `chrome-extension://${other.extId}/public.html`],
    ["other-extension-page(not-web-accessible)", `chrome-extension://${other.extId}/private.html`],
    ["own-extension-page", `chrome-extension://${ownId}/perm.html`],
  ];
  const matrix = [];
  for (const [label, url] of items) {
    matrix.push(await probeWithFallback(b, w, label, url, url.startsWith("view-source:") ? "view-source:" : null));
  }
  return matrix;
}

// S_probeTab; when tabs.create refuses the URL and a prefix is given, retry through CDP
// Target.createTarget and probe whichever tab shows up with that prefix.
async function probeWithFallback(b, w, label, url, fallbackPrefix) {
  let r = await swCall(b, w, S_probeTab, { label, url });
  if (r.createError && fallbackPrefix) {
    const fallback = {};
    try {
      const t = await b.cdp.send("Target.createTarget", { url });
      fallback.targetCreateTarget = { ok: true };
      await sleep(1000);
      const found = await swCall(b, w, S_findTabsByPrefix, { prefix: fallbackPrefix });
      fallback.tabsQueryFound = found;
      if (found.length) {
        const r2 = await swCall(b, w, S_probeTab, { label, url, existingTabId: found[0].id });
        r2.viaCdpTargetCreate = true;
        fallback.probed = r2;
      }
      await b.cdp.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
    } catch (e) {
      fallback.targetCreateTarget = { ok: false, message: errText(e) };
    }
    r = { ...r, fallbackViaCdp: fallback };
  }
  return r;
}

async function case1(b, W, port) {
  const base = `http://a.example.test:${port}`;
  const out = {
    note:
      "executeScript target is {tabId}, func ()=>1. 'tab' = chrome.tabs.get after the tab settled. " +
      "origin = new URL(tab.url).origin evaluated inside the service worker. " +
      "permissionsContainsOriginPattern = chrome.permissions.contains({origins:[origin+'/*']}).",
  };
  out.newURLOnEmptyUndefinedNull = await swCall(b, W["probe-A"], S_urlParsing);
  out.variantB_hostNotGranted = {
    permissions: await swCall(b, W["probe-B"], S_permissionsBaseline),
    matrix: await runMatrix(b, W["probe-B"], W["probe-other"], W["probe-B"].extId, base),
  };
  out.variantA_hostGranted = {
    permissions: await swCall(b, W["probe-A"], S_permissionsBaseline),
    matrix: await runMatrix(b, W["probe-A"], W["probe-other"], W["probe-A"].extId, base),
  };
  out.variantA_hostGranted.discardedTab = await swCall(b, W["probe-A"], S_discard, { url: `${base}/page?csp=none` });
  out.summary = {};
  for (const [v, key] of [
    ["B", "variantB_hostNotGranted"],
    ["A", "variantA_hostGranted"],
  ]) {
    for (const r of out[key].matrix) out.summary[`${v}: ${r.label}`] = execLine(r);
  }
  const d = out.variantA_hostGranted.discardedTab;
  out.summary["A: discarded tab"] = d.discardError
    ? `tabs.discard threw: ${d.discardError.message}`
    : `discarded=${d.tabDiscardedTarget && d.tabDiscardedTarget.discarded}; ${execLine({ executeScript: d.executeScript })}`;
  return out;
}

// Records the page's own console / security log (the text the browser prints for CSP refusals).
async function capturePageConsole(b, pageUrl) {
  const { targetInfos } = await b.cdp.send("Target.getTargets");
  const t = [...targetInfos].reverse().find((x) => x.type === "page" && x.url === pageUrl);
  if (!t) return { stop: async () => ({ pageTargetNotFound: true }) };
  const { sessionId } = await b.cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  const entries = [];
  const listener = (m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Log.entryAdded") {
      const { source, level, text } = m.params.entry;
      entries.push({ via: "Log.entryAdded", source, level, text });
    } else if (m.method === "Runtime.consoleAPICalled") {
      entries.push({ via: "Runtime.consoleAPICalled", type: m.params.type, args: m.params.args.map((a) => a.value ?? a.description) });
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      entries.push({ via: "Runtime.exceptionThrown", text: d.text, description: d.exception && d.exception.description });
    }
  };
  b.cdp.listeners.add(listener);
  await b.cdp.send("Log.enable", {}, sessionId);
  await b.cdp.send("Runtime.enable", {}, sessionId);
  return {
    stop: async () => {
      await sleep(200);
      b.cdp.listeners.delete(listener);
      await b.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      return entries;
    },
  };
}

async function case3(b, W, port) {
  const base = `http://a.example.test:${port}`;
  const w = W["probe-A"];
  const out = { perCsp: {} };
  for (const csp of ["none", "self", "self-eval", "self-inline-eval"]) {
    const url = `${base}/page?csp=${csp}`;
    const tabId = await swCall(b, w, async (a) => {
      const id = await openTab(a.url);
      await waitComplete(id);
      return id;
    }, { url });
    const cap = await capturePageConsole(b, url);
    out.perCsp[csp] = await swCall(b, w, S_evalGate, { tabId });
    out.perCsp[csp].pageConsoleDuringTests = await cap.stop();
    await swCall(b, w, async (a) => await closeTab(a.tabId), { tabId });
  }
  out.promiseAndSerialization = await swCall(b, w, S_promiseTests, { url: `${base}/page?csp=none` });
  return out;
}

async function case4(b, W, port) {
  const base = `http://a.example.test:${port}`;
  const w = W["probe-A"];
  const out = { perPageCsp: {} };
  for (const csp of ["none", "self", "connect-none"]) {
    const tabId = await swCall(b, w, async (a) => await openTab(a.url), { url: `${base}/page?csp=${csp}` });
    await swCall(b, w, async (a) => await waitComplete(a.tabId), { tabId });
    const xsite =
      csp === "none"
        ? [
            { label: "b.example.test cors=1 (cross-origin, same-site)", url: `http://b.example.test:${port}/api/echo?cors=1` },
            { label: "b.example.test no cors (cross-origin, same-site)", url: `http://b.example.test:${port}/api/echo` },
            { label: "127.0.0.1 cors=1 (cross-site)", url: `http://127.0.0.1:${port}/api/echo?cors=1` },
            { label: "127.0.0.1 no cors (cross-site)", url: `http://127.0.0.1:${port}/api/echo` },
          ]
        : null;
    const cap = await capturePageConsole(b, `${base}/page?csp=${csp}`);
    out.perPageCsp[csp] = await swCall(b, w, S_fetchRound, { tabId, base, xsite });
    out.perPageCsp[csp].pageConsoleDuringFetches = await cap.stop();
    await swCall(b, w, async (a) => await closeTab(a.tabId), { tabId });
  }
  out.declarativeNetRequestOnServiceWorkerFetch = await swCall(b, w, S_dnrTest, { base });
  return out;
}

// 'Allow access to file URLs' for an unpacked extension, flipped the way chrome://extensions does it.
const fileAccessOf = (r) => (r && r.ok && r.value && r.value.fileAccess ? r.value.fileAccess : r);

async function setFileAccessOff(b, w, opts = {}) {
  return await withExtensionsPage(b, async (sid) => {
    const stateOf = async () => {
      const i = await evalInPage(b, sid, dpExpression("getExtensionInfo", [w.extId]));
      return i && i.ok && i.value ? i.value.state : i;
    };
    const r = {};
    if (opts.developerMode) {
      // Chrome 138+ disables unpacked extensions on the NEXT start unless the profile is in developer mode
      r.developerMode = await evalInPage(b, sid, dpExpression("updateProfileConfiguration", [{ inDeveloperMode: true }]));
    }
    r.fileAccessBefore = fileAccessOf(await evalInPage(b, sid, dpExpression("getExtensionInfo", [w.extId])));
    r.update = await evalInPage(b, sid, dpExpression("updateExtensionConfiguration", [{ extensionId: w.extId, fileAccess: false }]));
    await sleep(1000);
    r.stateRightAfterUpdate = await stateOf(); // the update reloads the extension and leaves it DISABLED
    r.reEnable = await evalInPage(
      b,
      sid,
      `new Promise((res) => { chrome.management.setEnabled(${JSON.stringify(w.extId)}, true, () => res({ lastError: (chrome.runtime.lastError && chrome.runtime.lastError.message) || null })); })`,
    );
    for (let i = 0; i < 20 && (await stateOf()) !== "ENABLED"; i++) await sleep(400);
    r.stateAfterReEnable = await stateOf();
    r.fileAccessAfter = fileAccessOf(await evalInPage(b, sid, dpExpression("getExtensionInfo", [w.extId])));
    r.fileAccessFieldNote = "isActive = the 'Allow access to file URLs' switch is on; isEnabled = the switch is offered";
    return r;
  });
}

// Switch file access off, close the browser, start a NEW browser on the same profile so the extension
// is loaded from scratch with the persisted setting (no stale in-memory permissions).
async function fileAccessOffRelaunch(tmpRoot, dirs, fileUrl) {
  const out = {};
  const tag = "fileoff";
  let b;
  try {
    b = await launchBrowser(tmpRoot, tag, [dirs.D]);
    const w1 = (await findWorkers(b, ["probe-D"]))["probe-D"];
    out.firstLaunch = await setFileAccessOff(b, w1, { developerMode: true });
    out.firstLaunchClosed = await closeBrowser(b);
    fs.rmSync(path.join(tmpRoot, `profile-${tag}`, "DevToolsActivePort"), { force: true });
    b = await launchBrowser(tmpRoot, tag, [dirs.D]);
    // not a fresh install, so no onInstalled: wake the worker with a tabs.onCreated event
    await sleep(1500);
    const wake = await b.cdp.send("Target.createTarget", { url: "about:blank" });
    await sleep(800);
    await b.cdp.send("Target.closeTarget", { targetId: wake.targetId }).catch(() => {});
    let found;
    try {
      found = await findWorkers(b, ["probe-D"], 8000);
    } catch (e) {
      // still not running: report why, then enable it the way a user would
      out.workerMissingAfterRelaunch = await withExtensionsPage(b, async (sid) => {
        const infos = await evalInPage(b, sid, dpExpression("getExtensionsInfo", [{ includeDisabled: true, includeTerminated: true }]));
        const mine = infos && infos.ok ? infos.value.find((x) => x.name === "probe-D") : null;
        const r = { state: mine && mine.state, disableReasons: mine && Object.entries(mine.disableReasons || {}).filter(([, v]) => v).map(([k]) => k) };
        r.developerMode = await evalInPage(b, sid, dpExpression("updateProfileConfiguration", [{ inDeveloperMode: true }]));
        r.reEnable = await evalInPage(
          b,
          sid,
          `new Promise((res) => { chrome.management.setEnabled(${JSON.stringify(mine.id)}, true, () => res({ lastError: (chrome.runtime.lastError && chrome.runtime.lastError.message) || null })); })`,
        );
        return r;
      });
      await sleep(1500);
      const wake2 = await b.cdp.send("Target.createTarget", { url: "about:blank" });
      await sleep(800);
      await b.cdp.send("Target.closeTarget", { targetId: wake2.targetId }).catch(() => {});
      found = await findWorkers(b, ["probe-D"], 15000);
    }
    const w2 = found["probe-D"];
    out.fileAccessAfterRelaunch = await withExtensionsPage(b, async (sid) =>
      fileAccessOf(await evalInPage(b, sid, dpExpression("getExtensionInfo", [w2.extId]))),
    );
    out.probe = await probeWithFallback(b, w2, "file: (file access off, relaunched)", fileUrl, "file:");
    out.extras = await swCall(b, w2, S_fileExtras, { url: fileUrl });
  } catch (e) {
    out.runError = errText(e);
  } finally {
    if (b && !b.closed) out.secondLaunchClosed = await closeBrowser(b);
  }
  return out;
}

// -- case 5 --------------------------------------------------------------------------------------
async function case5(b, W, port, extra) {
  const base = `http://a.example.test:${port}`;
  const wA = W["probe-A"];
  const wB = W["probe-B"];
  const page = `${base}/page?csp=none`;
  const out = { summary: {} };
  const line = (r) => execLine({ executeScript: r });

  // (a) discarded tab recovery
  out.a_discardedTab = {
    note: "Each scenario runs on its own fresh pair of tabs: tab 1 is discarded while tab 2 (also /page) stays active.",
  };
  for (const mode of ["reload", "update", "updateImmediateExec", "sendMessage", "execOnly"]) {
    out.a_discardedTab[`variantA_${mode}`] = await swCall(b, wA, S_discardedScenario, { mode, url: page });
  }
  out.a_discardedTab.variantB_execOnly = await swCall(b, wB, S_discardedScenario, { mode: "execOnly", url: page });
  const A = out.a_discardedTab;
  out.summary["a: tabs.get right after discard"] = JSON.stringify(A.variantA_reload.tabsGetAfterDiscard);
  out.summary["a(i) after tabs.reload: complete at"] = JSON.stringify(A.variantA_reload.watchAfterReload.doneAtMs ?? `not complete in ${A.variantA_reload.watchAfterReload.gaveUpAtMs} ms`);
  out.summary["a(i) executeScript after reload"] = line(A.variantA_reload.executeScriptAfterwards);
  out.summary["a(ii) after tabs.update active: complete at"] = JSON.stringify(A.variantA_update.watchAfterUpdate.doneAtMs ?? `not complete in ${A.variantA_update.watchAfterUpdate.gaveUpAtMs} ms`);
  out.summary["a(ii) executeScript after update+load"] = line(A.variantA_update.executeScriptAfterwards);
  out.summary["a(ii) executeScript IMMEDIATELY after update"] = line(A.variantA_updateImmediateExec.executeScriptImmediately);
  out.summary["a(iii) variant B discarded executeScript"] = line(A.variantB_execOnly.executeScript);
  out.summary["a(iv) sendMessage to discarded tab"] = JSON.stringify(A.variantA_sendMessage.sendMessage);

  // (b) file: URL. A --load-extension'ed unpacked extension starts with file access ON (see
  // isAllowedFileSchemeAccess below), so variant D has it switched OFF via chrome://extensions.
  const fileUrl = pathToFileURL(extra.fileForProbe).href;
  out.b_fileUrl = {};
  out.b_fileUrl.defaultFileAccess_variantA = await probeWithFallback(b, wA, "file:", fileUrl, "file:");
  out.b_fileUrl.defaultFileAccess_variantA.extras = await swCall(b, wA, S_fileExtras, { url: fileUrl });
  out.summary["b: file:, default (file access ON) executeScript"] = execLine(out.b_fileUrl.defaultFileAccess_variantA);
  const wD = W["probe-D"];
  try {
    out.b_fileUrl.toggleFileAccessOff_viaChromeExtensionsPage = await setFileAccessOff(b, wD);
    // the toggle reloads the extension: wake its service worker with a tabs.onCreated event, re-attach
    const wake = await b.cdp.send("Target.createTarget", { url: "about:blank" });
    await sleep(800);
    await b.cdp.send("Target.closeTarget", { targetId: wake.targetId }).catch(() => {});
    Object.assign(wD, (await findWorkers(b, ["probe-D"], 15000))["probe-D"]);
    out.b_fileUrl.inSessionToggle_variantD = await probeWithFallback(b, wD, "file: (file access off, same session)", fileUrl, "file:");
    out.b_fileUrl.inSessionToggle_variantD.extras = await swCall(b, wD, S_fileExtras, { url: fileUrl });
    const ins = out.b_fileUrl.inSessionToggle_variantD;
    out.b_fileUrl.inSessionToggleNote =
      "The extension kept running with its already-loaded permission set after the switch, so executeScript on the CDP-opened file: tab still succeeded here; the relaunched run below is the clean 'file access off' observation.";
    out.summary["b: file:, switched OFF in-session (stale, see note) executeScript"] = execLine(ins.fallbackViaCdp && ins.fallbackViaCdp.probed ? ins.fallbackViaCdp.probed : ins);
  } catch (e) {
    out.b_fileUrl.inSessionToggleRunError = errText(e);
  }
  out.b_fileUrl.persistedOffThenRelaunched = await fileAccessOffRelaunch(extra.tmpRoot, extra.dirs, fileUrl);
  const rl = out.b_fileUrl.persistedOffThenRelaunched;
  if (rl.probe) out.summary["b: file:, switched OFF, browser relaunched on that profile"] = execLine(rl.probe.fallbackViaCdp && rl.probe.fallbackViaCdp.probed ? rl.probe.fallbackViaCdp.probed : rl.probe);
  if (rl.probe) out.summary["b: tabs.create(file:) with file access off"] = rl.probe.createError ? rl.probe.createError.message : "did not throw";

  // (c) connection-refused error page
  out.c_errorPage = await probeWithFallback(b, wA, "connection refused", "http://127.0.0.1:1/", null);
  out.summary["c: http://127.0.0.1:1/ executeScript"] = execLine(out.c_errorPage);

  // (d) data: and blob:
  out.d_dataUrl = await probeWithFallback(b, wA, "data:", "data:text/html,<p>x</p>", "data:");
  out.d_blobUrl = await swCall(b, wA, S_blobTab, { pageUrl: page });
  out.summary["d: data: executeScript"] = execLine(out.d_dataUrl);
  out.summary["d: blob: executeScript"] = line(out.d_blobUrl.executeScript);

  // (e) executeScript while a slow page is still loading
  const slow = (mode) => `${base}/slow?ms=3000${mode === "stream" ? "&mode=stream" : ""}`;
  const slowRuns = async (injectImmediately) => {
    const runs = { note: "/slow?ms=3000: mode=delay sends nothing for 3 s; mode=stream sends headers + first chunk at once and the rest after 3 s." };
    for (const mode of ["delay", "stream"]) {
      for (const how of ["newTab", "navigateExisting"]) {
        const key = `${mode}_${how}`;
        runs[key] = {
          executeScriptAt500ms: await swCall(b, wA, S_slowFirstExec, { how, active: true, atMs: 500, url: slow(mode), basePage: page, injectImmediately }),
          sampledEvery200msFor4s: await swCall(b, wA, S_slowSampling, { how, everyMs: 200, durationMs: 4000, url: slow(mode), basePage: page, injectImmediately }),
        };
        const f = runs[key].executeScriptAt500ms;
        out.summary[`e${injectImmediately ? " (injectImmediately)" : ""}: ${key} executeScript at +500ms`] =
          `${f.executeScript.ok ? JSON.stringify(f.executeScript.items[0].result) : execLine({ executeScript: f.executeScript })} (settled after ${f.executeScriptSettledAfterMs} ms; tab complete at ${f.tabWatchFromNavigationStart.doneAtMs} ms)`;
      }
    }
    return runs;
  };
  out.e_slowPage = await slowRuns(false);
  out.e_slowPage_withInjectImmediately = await slowRuns(true);

  // (f) background new tab on the slow route
  out.f_backgroundNewTab = await swCall(b, wA, S_slowFirstExec, { how: "newTab", active: false, atMs: 300, url: slow("delay"), basePage: page });
  const f = out.f_backgroundNewTab;
  out.summary["f: active:false new tab, executeScript at +300ms"] = `${f.executeScript.ok ? JSON.stringify(f.executeScript.items[0].result) : execLine({ executeScript: f.executeScript })} (settled after ${f.executeScriptSettledAfterMs} ms)`;
  out.summary["f: active:false new tab, tabs.create returned"] = JSON.stringify(f.createReturned);
  out.summary["f: active:false new tab, tabs.get watch"] = JSON.stringify(f.tabWatchFromNavigationStart);
  return out;
}

// -- case 2 --------------------------------------------------------------------------------------
async function evalInPage(b, sessionId, expression, timeoutMs = 10000) {
  const r = await withTimeout(
    b.cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId),
    timeoutMs,
    "page evaluate",
  );
  if (r.exceptionDetails) return { exception: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
  return r.result.value;
}

const dpExpression = (method, args) =>
  `(async () => { try { if (!(window.chrome && chrome.developerPrivate)) return { noDeveloperPrivate: true };` +
  ` const v = await new Promise((res, rej) => { chrome.developerPrivate.${method}(...${JSON.stringify(args)},` +
  ` (r) => { const e = chrome.runtime.lastError; e ? rej(new Error(e.message)) : res(r === undefined ? null : r); }); });` +
  ` return { ok: true, value: v }; } catch (e) { return { ok: false, message: String((e && e.message) || e) }; } })()`;

async function withExtensionsPage(b, fn) {
  let targetId;
  try {
    ({ targetId } = await b.cdp.send("Target.createTarget", { url: "chrome://extensions" }));
  } catch (e) {
    return { couldNotOpenChromeExtensionsPage: errText(e) };
  }
  try {
    const { sessionId } = await b.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      await sleep(250);
      try {
        ready = (await evalInPage(b, sessionId, "document.readyState === 'complete' && !!(window.chrome && chrome.developerPrivate)", 3000)) === true;
      } catch {}
    }
    if (!ready) return { chromeExtensionsPageNeverExposedDeveloperPrivate: true };
    return await fn(sessionId);
  } finally {
    await b.cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

async function case2(b, W, port) {
  const base = `http://a.example.test:${port}`;
  const pageUrl = `${base}/page?csp=none`;
  const wB = W["probe-B"];
  const wC = W["probe-C"];
  const out = {
    status: "attempted",
    manualRepro: [
      "1. Generate variant B (this script writes it to a temp dir; manifest = tabs, scripting, cookies, activeTab, declarativeNetRequest + optional_host_permissions [\"<all_urls>\"], NO host_permissions).",
      "2. In a real, headed Chromium/Chrome: chrome://extensions > Developer mode > Load unpacked > the variant-B folder. Open its service worker console (Inspect views: service worker).",
      "3. Start the fixture (`node test-fixtures/browser-probe/server.mjs` prints the port) and open a tab OLD on http://127.0.0.1:<port>/page?csp=none (no hosts-file edit needed; or launch the browser with --host-resolver-rules=\"MAP *.example.test 127.0.0.1\" to use a.example.test).",
      "4. In the SW console: `const [t]=await chrome.tabs.query({url:'*://*/page*'}); await chrome.scripting.executeScript({target:{tabId:t.id},func:()=>1})` -> expect the refusal.",
      "5. Open chrome-extension://<B id>/perm.html in a new tab and click 'Grant all sites' (a real click supplies the user gesture); accept the permission bubble.",
      "6. Back in the SW console: re-run the executeScript on OLD, then open a FRESH tab on /page and run it there. Compare the two results.",
    ],
  };

  // ---- baseline: OLD tab refused in B ------------------------------------------------------
  const oldTab = await swCall(b, wB, async (a) => {
    const id = await openTab(a.url);
    await waitComplete(id);
    return id;
  }, { url: pageUrl });
  out.variantB_oldTab_beforeGrant = await swCall(b, wB, S_execOnTab, { tabId: oldTab });
  out.variantB_permissionsBeforeGrant = await swCall(b, wB, S_permissionsBaseline);
  out.permissionsRequestFromServiceWorkerWithoutGesture = await swCall(b, wB, S_requestWithoutGesture);

  const stateOfB = async (label) => {
    const fresh = await swCall(b, wB, async (a) => {
      const id = await openTab(a.url);
      await waitComplete(id);
      const r = { tabId: id };
      return r;
    }, { url: pageUrl });
    const s = {
      label,
      allUrlsGranted: await swCall(b, wB, S_permissionsBaseline),
      oldTab: await swCall(b, wB, S_execOnTab, { tabId: oldTab.id ?? oldTab }),
      freshTabOpenedAfter: await swCall(b, wB, S_execOnTab, { tabId: fresh.tabId }),
    };
    await swCall(b, wB, async (a) => await closeTab(a.tabId), { tabId: fresh.tabId });
    return s;
  };

  // ---- 2a: trusted CDP click -> permissions.request ----------------------------------------
  const click = { method: "CDP Input.dispatchMouseEvent on a button in the extension page that calls chrome.permissions.request({origins:['<all_urls>']})" };
  try {
    const permUrl = `chrome-extension://${wB.extId}/perm.html`;
    const permTabId = await swCall(b, wB, async (a) => await openTab(a.url), { url: permUrl });
    await sleep(800);
    const { targetInfos } = await b.cdp.send("Target.getTargets");
    const t = targetInfos.find((x) => x.type === "page" && x.url === permUrl);
    if (!t) throw new Error("perm.html page target not found");
    const { sessionId } = await b.cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
    await b.cdp.send("Target.activateTarget", { targetId: t.targetId }).catch(() => {});
    const rect = await evalInPage(
      b,
      sessionId,
      "(() => { const r = document.getElementById('grant').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()",
    );
    for (const [type, extra] of [
      ["mouseMoved", {}],
      ["mousePressed", { button: "left", clickCount: 1 }],
      ["mouseReleased", { button: "left", clickCount: 1 }],
    ]) {
      await b.cdp.send("Input.dispatchMouseEvent", { type, x: rect.x, y: rect.y, ...extra }, sessionId);
    }
    const samples = [];
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < 12000) {
      last = await evalInPage(
        b,
        sessionId,
        "({ result: window.__permResult, clickIsTrusted: window.__clickIsTrusted, userActivationActiveAtClick: window.__userActivationActive })",
        3000,
      );
      if (!samples.length || JSON.stringify(samples[samples.length - 1].v) !== JSON.stringify(last)) {
        samples.push({ atMs: Date.now() - t0, v: last });
      }
      if (last.result && last.result !== "pending" && last.result !== "idle") break;
      await sleep(500);
    }
    click.clickAt = rect;
    click.observedSamples = samples;
    click.finalResult = last;
    click.stillPendingAfter12s = last.result === "pending";
    await swCall(b, wB, async (a) => await closeTab(a.tabId), { tabId: permTabId });
  } catch (e) {
    click.error = errText(e);
  }
  out.attempt2a_trustedClickPermissionsRequest = click;
  out.stateAfter2a = await stateOfB("after 2a");

  // ---- 2b: chrome://extensions developerPrivate (what the Site access UI calls) on B -------
  out.attempt2b_developerPrivateAddHostPermission_onB = await withExtensionsPage(b, async (sid) => {
    const r = {};
    r.addAllUrls = await evalInPage(b, sid, dpExpression("addHostPermission", [wB.extId, "<all_urls>"]));
    r.addWildcard = await evalInPage(b, sid, dpExpression("addHostPermission", [wB.extId, "http://*/*"]));
    r.addSpecificSite = await evalInPage(b, sid, dpExpression("addHostPermission", [wB.extId, "http://a.example.test/*"]));
    return r;
  });
  out.stateAfter2b = await stateOfB("after 2b");

  // ---- 2c: PROXY. Variant C declares host_permissions <all_urls> (required). We withhold site
  //      access via chrome://extensions (the 'On click' site-access setting), then grant it back
  //      ('On all sites'). This is NOT the optional_host_permissions request path; it only shows
  //      how an ALREADY-LOADED tab compares with a FRESH tab once <all_urls> becomes granted.
  const proxy = {
    caveat:
      "PROXY, not the optional_host_permissions + chrome.permissions.request path: required <all_urls> withheld then re-granted via chrome://extensions developerPrivate.updateExtensionConfiguration({hostAccess}).",
  };
  try {
    const mk = async () =>
      await swCall(b, wC, async (a) => {
        const id = await openTab(a.url);
        await waitComplete(id);
        return id;
      }, { url: pageUrl });
    const execC = async (tabId) => await swCall(b, wC, S_execOnTab, { tabId });
    const cOld = await mk();
    proxy.step1_baselineGranted_oldTab = await execC(cOld);
    const dp = await withExtensionsPage(b, async (sid) => {
      const r = {};
      r.getInfoBefore = await evalInPage(b, sid, dpExpression("getExtensionInfo", [wC.extId]));
      if (r.getInfoBefore && r.getInfoBefore.ok && r.getInfoBefore.value) {
        const rh = r.getInfoBefore.value.permissions && r.getInfoBefore.value.permissions.runtimeHostPermissions;
        r.getInfoBefore = { hostAccess: rh && rh.hostAccess, hasAllHosts: rh && rh.hasAllHosts };
      }
      r.withhold = await evalInPage(b, sid, dpExpression("updateExtensionConfiguration", [{ extensionId: wC.extId, hostAccess: "ON_CLICK" }]));
      await sleep(500);
      await swCall(b, wC, S_startPendingExec, { tabId: cOld });
      proxy.step2_afterWithhold_oldTab = await execC(cOld);
      const cFreshWhileWithheld = await mk();
      proxy.step2_afterWithhold_freshTab = await execC(cFreshWhileWithheld);
      proxy.step2_permissionsContainsAllUrls = await swCall(b, wC, S_permissionsBaseline);
      r.grant = await evalInPage(b, sid, dpExpression("updateExtensionConfiguration", [{ extensionId: wC.extId, hostAccess: "ON_ALL_SITES" }]));
      await sleep(500);
      proxy.step3_afterGrant_permissionsContainsAllUrls = await swCall(b, wC, S_permissionsBaseline);
      proxy.step3_executeScriptThatWasPendingSinceTheWithhold = await swCall(b, wC, S_readPendingExec);
      proxy.step3_afterGrant_oldTab_loadedBeforeWithhold = await execC(cOld);
      proxy.step3_afterGrant_tabLoadedWhileWithheld = await execC(cFreshWhileWithheld);
      const cFreshAfterGrant = await mk();
      proxy.step3_afterGrant_freshTabOpenedAfterGrant = await execC(cFreshAfterGrant);
      r.getInfoAfter = await evalInPage(b, sid, dpExpression("getExtensionInfo", [wC.extId]));
      if (r.getInfoAfter && r.getInfoAfter.ok && r.getInfoAfter.value) {
        const rh = r.getInfoAfter.value.permissions && r.getInfoAfter.value.permissions.runtimeHostPermissions;
        r.getInfoAfter = { hostAccess: rh && rh.hostAccess, hasAllHosts: rh && rh.hasAllHosts };
      }
      for (const id of [cOld, cFreshWhileWithheld, cFreshAfterGrant]) {
        await swCall(b, wC, async (a) => await closeTab(a.tabId), { tabId: id });
      }
      return r;
    });
    proxy.developerPrivateCalls = dp;
  } catch (e) {
    proxy.error = errText(e);
  }
  out.attempt2c_proxy_withholdThenGrantVariantC = proxy;

  await swCall(b, wB, async (a) => await closeTab(a.tabId), { tabId: oldTab });
  const granted =
    (out.stateAfter2a.allUrlsGranted.allUrls.returned === true) || (out.stateAfter2b.allUrlsGranted.allUrls.returned === true);
  out.status = granted ? "grant obtained on variant B (see stateAfter2a / stateAfter2b)" : "optional_host_permissions grant on variant B could not be obtained headlessly; only the labelled proxy (2c) ran";
  return out;
}

// ---------------------------------------------------------------------------------------------
// output hygiene
// ---------------------------------------------------------------------------------------------
function normalize(observed, ctx) {
  let s = JSON.stringify(observed, null, 2);
  const lit = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  s = s.replace(new RegExp(`:${ctx.port}\\b`, "g"), ":<PORT>");
  for (const id of ctx.otherIds) s = s.replace(new RegExp(lit(id), "g"), "<OTHER_EXT_ID>");
  for (const id of ctx.extIds) s = s.replace(new RegExp(lit(id), "g"), "<EXT_ID>");
  s = s.replace(new RegExp(lit(ctx.tmpRoot), "g"), "<TMP>").replace(new RegExp(lit(os.homedir()), "g"), "<HOME>");
  // isolated-world CSP names the extension by a per-extension UUID instead of its 32-letter id
  const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  s = s.replace(new RegExp(`chrome-extension://${UUID}`, "g"), "chrome-extension://<EXT_UUID>");
  s = s.replace(new RegExp(UUID, "g"), "<UUID>");
  s = s.replace(/\/Users\/[^"\s]+/g, "<PATH>").replace(/\/(?:private\/)?(?:tmp|var)\/[^"\s]+/g, "<PATH>");
  return s + "\n";
}

// ---------------------------------------------------------------------------------------------
async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fp-probe-"));
  const server = await startServer();
  const port = server.port;
  const dirs = writeVariants(tmpRoot);
  const fileForProbe = path.join(tmpRoot, "harmless.html");
  fs.writeFileSync(fileForProbe, "<!doctype html><title>harmless</title><p>fake probe file</p>\n");
  const observed = {
    meta: {
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      normalization:
        "Ephemeral fixture-server port is written as <PORT>; the extension under test's id as <EXT_ID> (unpacked ids are a hash of the extension folder path); the unrelated 'probe-other' extension's id as <OTHER_EXT_ID>; a UUID in chrome-extension://<uuid>/ as <EXT_UUID> and any other 8-4-4-4-12 hex UUID (e.g. a blob: URL) as <UUID> (the isolated-world CSP names the extension by a per-extension UUID, chrome-extension://<EXT_UUID>/, NOT by its 32-letter id - do not pin the UUID and do not swap it for the id); temp/home paths as <TMP>/<HOME> and any other absolute temp/user path as <PATH>.",
      hosts: "a.example.test and b.example.test are mapped to 127.0.0.1 inside the browser (--host-resolver-rules); same fixture server, same port.",
      fixtureNotes: [
        "Sec-Fetch-* request headers are only sent to potentially trustworthy URLs (https or localhost/127.0.0.1), so secFetchSite/secFetchMode are expected to be null for plain-http *.example.test and present for http://127.0.0.1.",
        "a.example.test and b.example.test are cross-ORIGIN but SAME-SITE (.test is not on the public suffix list, so example.test is the registrable domain). http://127.0.0.1:<PORT> is the genuinely cross-site target.",
        "/slow?ms=<n>[&mode=stream]: delay mode sends nothing for n ms; stream mode sends headers + the first chunk at once and the rest after n ms (case 5).",
        "/api/guarded default rule is literal: 200 only when Origin === 'http://<Host>' AND cookie sid=fake-session-1; so a same-origin GET is 403 by design of the fixture (the browser fact is that no Origin header is sent on a same-origin GET). ?lenient=1 additionally accepts a request with no Origin that is provably same-origin: Sec-Fetch-Site: same-origin, or a Referer on the same host (the Referer fallback is why page-context lenient GETs return 200; the extension service worker sends no Referer, so it stays 403).",
      ],
    },
  };
  const ctx = { port, tmpRoot, extIds: [], otherIds: [] };
  const save = () => fs.writeFileSync(OBSERVED_PATH, normalize(observed, ctx));
  const closed = [];
  let b1, b2;
  try {
    const needMain = ["1", "3", "4", "5"].some((n) => CASES.has(n));
    let W;
    if (needMain) {
      b1 = await launchBrowser(tmpRoot, "main", [dirs.A, dirs.B, dirs.D, dirs.other]);
      observed.meta.browser = { product: b1.version.product, userAgent: b1.version.userAgent, headless: b1.headless ? "--headless=new" : "headed" };
      W = await findWorkers(b1, ["probe-A", "probe-B", "probe-D", "probe-other"]);
      ctx.extIds.push(W["probe-A"].extId, W["probe-B"].extId, W["probe-D"].extId);
      ctx.otherIds.push(W["probe-other"].extId);
      save();
    }
    for (const [n, fn] of [
      ["1", case1],
      ["3", case3],
      ["4", case4],
      ["5", case5],
    ]) {
      if (!CASES.has(n)) continue;
      try {
        observed[`case${n}`] = await fn(b1, W, port, { tmpRoot, fileForProbe, dirs });
      } catch (e) {
        observed[`case${n}`] = { runError: errText(e) };
        console.error(`case ${n} failed: ${errText(e)}\n${String(e && e.stack)}`);
      }
      save();
      console.error(`case ${n} done`);
    }
    closed.push(await closeBrowser(b1));

    if (CASES.has("2")) {
      try {
        b2 = await launchBrowser(tmpRoot, "case2", [dirs.B, dirs.C]);
        observed.meta.browser ??= { product: b2.version.product, userAgent: b2.version.userAgent, headless: b2.headless ? "--headless=new" : "headed" };
        const W2 = await findWorkers(b2, ["probe-B", "probe-C"]);
        ctx.extIds.push(W2["probe-C"].extId, W2["probe-B"].extId);
        observed.case2 = await withTimeout(case2(b2, W2, port), 20 * 60 * 1000, "case 2");
      } catch (e) {
        observed.case2 = { runError: errText(e) };
        console.error(`case 2 failed: ${errText(e)}\n${String(e && e.stack)}`);
      }
      save();
      console.error("case 2 done");
      closed.push(await closeBrowser(b2));
    }
  } finally {
    for (const b of [b1, b2]) {
      if (b && !b.closed) closed.push(await closeBrowser(b));
    }
    observed.meta.cleanup = closed.filter(Boolean);
    try {
      save();
    } catch {}
    await server.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  // short human summary (normalized the same way as the JSON)
  const sum = JSON.parse(normalize(observed, ctx)).case1?.summary;
  if (sum) {
    console.log("CASE 1 executeScript outcomes");
    for (const [k, v] of Object.entries(sum)) console.log(`  ${k.padEnd(52)} ${v}`);
  }
  const sum5 = JSON.parse(normalize(observed, ctx)).case5?.summary;
  if (sum5) {
    console.log("CASE 5 highlights");
    for (const [k, v] of Object.entries(sum5)) console.log(`  ${k.padEnd(56)} ${v}`);
  }
  console.log(`wrote ${OBSERVED_PATH}`);
  console.log(`browser pids closed: ${JSON.stringify(observed.meta.cleanup)}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("probe failed:", e && e.stack ? e.stack : e);
    process.exit(1);
  },
);
