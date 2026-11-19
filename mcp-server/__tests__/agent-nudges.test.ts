import * as fs from "fs";
import * as path from "path";
import {
  ACTIVATE_TAB_REPLY_NOTE,
  ENGINE_CDP_REPLY_NOTE,
  SCREENSHOT_DEBUGGER_NOTE,
  SCREENSHOT_IMAGE_NOTE,
  installNudges,
  screenshotWarningText,
  withNudges,
} from "../agent-nudges";

// Why this file exists: two things make FoxPilot visibly intrude on the user's
// browser, and both are escape hatches an agent should reach for rarely.
//   - activateTab:true switches the user's visible tab and back.
//   - engine:"cdp" (and capture-response-bodies, and the screenshot fallback)
//     attach Chrome's debugger, which shows "FoxPilot started debugging this
//     browser" and is detectable by the page.
// Real sessions set them out of habit (a 2026-11 audit: most activateTab calls
// followed a call that had NOT failed). The guidance in descriptions only works
// at the moment the agent reads it, so a successful call that used either flag
// also gets a one-line reminder to drop it, right where the agent would copy
// the habit into its next call.

const ok = (text = "done") => ({ content: [{ type: "text", text }] });
const texts = (r: { content: { type: string; text?: string }[] }): string[] =>
  r.content.filter((c) => c.type === "text").map((c) => c.text as string);

describe("withNudges", () => {
  it("appends the activateTab reminder after a successful call that set activateTab:true", () => {
    const r = withNudges({ tabId: 1, activateTab: true }, ok("Clicked element e1"));
    expect(texts(r)).toEqual(["Clicked element e1", ACTIVATE_TAB_REPLY_NOTE]);
  });

  it("appends the debugger reminder after a successful engine:cdp call", () => {
    const r = withNudges({ tabId: 1, engine: "cdp" }, ok("Clicked element e1"));
    expect(texts(r)).toEqual(["Clicked element e1", ENGINE_CDP_REPLY_NOTE]);
  });

  it("appends both when both flags were set, activateTab first", () => {
    const r = withNudges({ activateTab: true, engine: "cdp" }, ok("x"));
    expect(texts(r)).toEqual(["x", ACTIVATE_TAB_REPLY_NOTE, ENGINE_CDP_REPLY_NOTE]);
  });

  it("adds nothing when neither flag is on", () => {
    for (const args of [
      {},
      { tabId: 1 },
      { activateTab: false },
      { engine: "synthetic" },
      { engine: "auto" },
      { activateTab: undefined, engine: undefined },
    ]) {
      expect(withNudges(args, ok("x"))).toEqual(ok("x"));
    }
  });

  it("adds nothing to an error result: the error text already says what to do", () => {
    const err = { isError: true, content: [{ type: "text", text: "boom" }] };
    expect(withNudges({ activateTab: true, engine: "cdp" }, err)).toBe(err);
  });

  it("keeps images and other content in place and appends the note last", () => {
    const shot = {
      content: [
        { type: "text", text: "Warning: w" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
    };
    const r = withNudges({ activateTab: true }, shot);
    expect(r.content).toHaveLength(3);
    expect(r.content[1]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png" });
    expect(r.content[2]).toEqual({ type: "text", text: ACTIVATE_TAB_REPLY_NOTE });
  });

  it("does not mutate the handler's own result object", () => {
    const original = ok("x");
    withNudges({ activateTab: true }, original);
    expect(original.content).toHaveLength(1);
  });
});

describe("installNudges", () => {
  type Registered = { args: unknown[]; handle: object };
  function fakeServer() {
    const registered: Registered[] = [];
    return {
      registered,
      server: {
        tool: (...args: unknown[]) => {
          const handle = { registeredWith: args };
          registered.push({ args, handle });
          return handle;
        },
      },
    };
  }

  it("wraps the callback of a tool whose input shape has activateTab", async () => {
    const { server, registered } = fakeServer();
    installNudges(server);
    const cb = jest.fn(async () => ok("Clicked"));
    server.tool("click-element", "desc", { tabId: 1, activateTab: 2 }, cb);

    const wrapped = registered[0].args[3] as (a: object, e: object) => Promise<any>;
    expect(wrapped).not.toBe(cb);
    const extra = { signal: "s" };
    const r = await wrapped({ tabId: 1, activateTab: true }, extra);
    expect(cb).toHaveBeenCalledWith({ tabId: 1, activateTab: true }, extra);
    expect(texts(r)).toEqual(["Clicked", ACTIVATE_TAB_REPLY_NOTE]);
    expect(texts(await wrapped({ tabId: 1 }, extra))).toEqual(["Clicked"]);
  });

  it("wraps a tool whose input shape has engine but not activateTab", async () => {
    const { server, registered } = fakeServer();
    installNudges(server);
    server.tool("evaluate-script", "desc", { engine: 1 }, async () => ok("42"));

    const wrapped = registered[0].args[3] as (a: object, e: object) => Promise<any>;
    expect(texts(await wrapped({ engine: "cdp" }, {}))).toEqual(["42", ENGINE_CDP_REPLY_NOTE]);
  });

  it("handles the shorter (name, shape, callback) overload", async () => {
    const { server, registered } = fakeServer();
    installNudges(server);
    server.tool("scroll-to", { activateTab: 1 }, async () => ok("scrolled"));

    const wrapped = registered[0].args[2] as (a: object, e: object) => Promise<any>;
    expect(texts(await wrapped({ activateTab: true }, {}))).toEqual([
      "scrolled",
      ACTIVATE_TAB_REPLY_NOTE,
    ]);
  });

  it("leaves tools with neither field completely untouched", () => {
    const { server, registered } = fakeServer();
    installNudges(server);
    const cb = async () => ok("tabs");
    const shape = { tabId: 1 };
    server.tool("get-active-tab", "desc", shape, cb);
    server.tool("close-browser-tabs", "desc", cb);

    expect(registered[0].args[2]).toBe(shape);
    expect(registered[0].args[3]).toBe(cb);
    expect(registered[1].args[2]).toBe(cb);
  });

  it("returns whatever the real registration returned", () => {
    const { server, registered } = fakeServer();
    installNudges(server);
    const handle = server.tool("click-element", "d", { activateTab: 1 }, async () => ok());
    expect(handle).toBe(registered[0].handle);
  });
});

describe("screenshotWarningText", () => {
  it("passes an ordinary warning through unchanged", () => {
    expect(screenshotWarningText("stitch failed; returned one viewport")).toBe(
      "Warning: stitch failed; returned one viewport"
    );
  });

  it("explains that the CDP fallback showed the debugger banner and points at snapshots", () => {
    const w =
      "captureVisibleTab returned an empty readback; used the CDP screenshot fallback (a 'started debugging this browser' banner may have appeared).";
    const text = screenshotWarningText(w);
    expect(text.startsWith(`Warning: ${w}`)).toBe(true);
    expect(text).toContain(SCREENSHOT_DEBUGGER_NOTE);
    expect(SCREENSHOT_DEBUGGER_NOTE).toMatch(/take-snapshot/);
    expect(SCREENSHOT_DEBUGGER_NOTE).toMatch(/get-tab-web-content/);
  });
});

describe("the reminder texts stay short and actionable", () => {
  it("each names the flag, says what the user saw, and says when to use it again", () => {
    expect(ACTIVATE_TAB_REPLY_NOTE).toMatch(/activateTab/);
    expect(ACTIVATE_TAB_REPLY_NOTE).toMatch(/Omit it/);
    expect(ACTIVATE_TAB_REPLY_NOTE).toMatch(/times out|errors|empty/);
    expect(ENGINE_CDP_REPLY_NOTE).toMatch(/started debugging this browser/);
    expect(ENGINE_CDP_REPLY_NOTE).toMatch(/Omit engine/);
    for (const n of [
      ACTIVATE_TAB_REPLY_NOTE,
      ENGINE_CDP_REPLY_NOTE,
      SCREENSHOT_DEBUGGER_NOTE,
      SCREENSHOT_IMAGE_NOTE,
    ]) {
      expect(n.length).toBeLessThan(420);
    }
  });
});

describe("server.ts wiring and agent-facing guidance", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.ts"), "utf8");

  it("installs the reply reminders before the first tool is registered", () => {
    const install = src.indexOf("installNudges(mcpServer)");
    // A real registration starts a line; the comment above install mentions it too.
    const firstTool = src.search(/^mcpServer\.tool\(/m);
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(firstTool);
  });

  it("routes the take-screenshot warning through screenshotWarningText", () => {
    expect(src).toMatch(/screenshotWarningText\(result\.warning\)/);
    expect(src).not.toMatch(/text: `Warning: \$\{result\.warning\}`/);
  });

  it("activateTab guidance says retry once, then go back to omitting it", () => {
    expect(src).toMatch(/RETRY-ONLY\. Do NOT set this on the first attempt/);
    expect(src).toMatch(/Do NOT leave it on for follow-up calls/);
    expect(src).toMatch(/the page is the cause, not the tab/);
    expect(src).toMatch(/then go back to omitting it/);
  });

  it("every engine field shares one description that names the banner and the last-resort rule", () => {
    expect(src).not.toMatch(/engine: z\.enum\(\["synthetic", "cdp"\]\)\.optional\(\)/);
    const uses = src.match(/\.\.\.engineField/g) || [];
    expect(uses.length).toBeGreaterThanOrEqual(9);
    const start = src.indexOf("const engineField");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 1600);
    expect(block).toMatch(/started debugging this browser/);
    expect(block).toMatch(/detect/);
    expect(block).toMatch(/Never use it first/);
  });

  it("the server instructions tell agents the debugger is a last resort", () => {
    expect(src).toMatch(/DEBUGGER BANNER/);
    expect(src).toMatch(/last resorts/);
  });

  it("take-screenshot and capture-response-bodies steer agents to the covert tools", () => {
    expect(src).toMatch(/most common cause of the debugger banner/);
    expect(src).toMatch(/Use this only if get-network-requests/);
    expect(src).toMatch(/enabled:false as soon as you have/);
  });

  // Screenshots are the costliest thing FoxPilot returns, and the root-cause work
  // (2026-11-15) found their failures have three real causes, none of which the old
  // text named. The agent-facing text must steer away from images and say why.
  it("steers agents to text reads first and reminds them on every screenshot reply", () => {
    expect(SCREENSHOT_IMAGE_NOTE).toMatch(/take-snapshot/);
    expect(SCREENSHOT_IMAGE_NOTE).toMatch(/get-tab-web-content/);
    expect(SCREENSHOT_IMAGE_NOTE).toMatch(/costliest/);
    expect(src).toMatch(/READING PAGES, IMAGES LAST/);
    // The note is added after the image, so it is the last thing the agent reads.
    const handler = src.slice(src.indexOf('"take-screenshot",'));
    expect(handler.indexOf('type: "image"')).toBeGreaterThan(-1);
    expect(handler.indexOf("SCREENSHOT_IMAGE_NOTE")).toBeGreaterThan(handler.indexOf('type: "image"'));
  });

  it("take-screenshot describes the measured causes, not the old guess", () => {
    const start = src.indexOf('"take-screenshot",');
    const desc = src.slice(start, src.indexOf("\n", start + 40));
    expect(desc).toMatch(/MUST BE VISIBLE/);
    expect(desc).toMatch(/minimized or hidden/);
    expect(desc).toMatch(/CHROME\/EDGE/);
    expect(desc).toMatch(/30 screens/);
    expect(desc).toMatch(/all-sites access/);
    expect(desc).toMatch(/take one, not one after every action/);
    expect(desc).not.toMatch(/GPU\/compositor/);
  });
});
