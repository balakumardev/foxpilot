/**
 * Chrome/Edge-only TRUSTED coordinate input via chrome.debugger (CDP). Backs the
 * engine:"cdp" tier of the -at tools: it dispatches Input.* events at viewport
 * CSS-pixel {x,y}, which the renderer delivers as isTrusted:true (so strict
 * rich-text editors that ignore synthetic events accept them). It does NOT move
 * the OS cursor and needs no sidecar — its only cost is the "started debugging
 * this browser" banner (documented, opt-in). The debugger attach is REFCOUNTED
 * under the "input" purpose (see network-capture.ts) so it coexists with
 * response-body capture on the same tab: each call attaches "input", dispatches,
 * and releases "input" in a finally.
 *
 * Coordinates are native viewport CSS px — no screen mapping, no DPR multiply.
 * Firefox has no CDP; the Firefox message handler rejects engine:"cdp" before
 * reaching this module (this file is imported ONLY by the Chrome extension).
 */
import { attachDebugger, detachDebugger } from "./network-capture";

type MouseButton = "left" | "middle" | "right";

// Attach the "input" purpose, run the dispatch, and ALWAYS release it. Attach is
// outside the try so a failed attach (DevTools already open) does not trigger a
// spurious detach — nothing was attached.
async function withInputAttach(
  tabId: number,
  fn: (dbg: any) => Promise<void>
): Promise<void> {
  const dbg = (chrome as any).debugger;
  await attachDebugger(tabId, "input");
  try {
    await fn(dbg);
  } finally {
    await detachDebugger(tabId, "input");
  }
}

export async function cdpInputClick(
  tabId: number,
  x: number,
  y: number,
  button: MouseButton,
  doubleClick: boolean
): Promise<void> {
  await withInputAttach(tabId, async (dbg) => {
    // A trusted mouseMoved to the point FIRST so the renderer sets its hover
    // state / hit-target before the press (some handlers latch the target on
    // move). `buttons:1` marks the left button held during the press;
    // `buttons:0` on release. (C17 click fidelity.)
    await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });
    // First (and, for a single click, only) trusted press/release pair.
    await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button,
      buttons: 1,
      clickCount: 1,
    });
    await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button,
      buttons: 0,
      clickCount: 1,
    });
    if (doubleClick) {
      // A trusted dblclick is a second pair with clickCount:2 (Chrome then
      // synthesizes the dblclick event itself).
      await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button,
        buttons: 1,
        clickCount: 2,
      });
      await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button,
        buttons: 0,
        clickCount: 2,
      });
    }
  });
}

export async function cdpInputType(
  tabId: number,
  x: number,
  y: number,
  text: string,
  submit: boolean
): Promise<void> {
  await withInputAttach(tabId, async (dbg) => {
    // A trusted click at {x,y} is how CDP establishes focus + caret: the real
    // click runs the editor's own focus/selection logic and places the caret at
    // the point (there is no CDP "focus at coordinate" command — the click is
    // the mechanism). Input.insertText then commits text AT that caret. The
    // mouseMoved + `buttons` bitmask mirror cdpInputClick's C17 fidelity.
    await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });
    await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    if (text.length > 0) {
      // insertText delivers the whole string as a trusted IME-style commit —
      // fires real beforeinput/input, which is what strict editors require.
      await dbg.sendCommand({ tabId }, "Input.insertText", { text });
    }
    if (submit) {
      await dbg.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        text: "\r",
      });
      await dbg.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
      });
    }
  });
}

export async function cdpInputHover(
  tabId: number,
  x: number,
  y: number
): Promise<void> {
  await withInputAttach(tabId, async (dbg) => {
    await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });
  });
}

export async function cdpInputScroll(
  tabId: number,
  x: number,
  y: number,
  dx?: number,
  dy?: number
): Promise<void> {
  await withInputAttach(tabId, async (dbg) => {
    // A trusted wheel event at {x,y}. Unlike the synthetic engine (which
    // measures the container and defaults to its clientHeight), CDP dispatches
    // a raw wheel at the OS/renderer level, so an omitted delta defaults to a
    // fixed one-page step (600 px) rather than a measured container height.
    await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: typeof dx === "number" ? dx : 0,
      deltaY: typeof dy === "number" ? dy : 600,
    });
  });
}

// True on macOS, where the "select all" accelerator is Cmd(Meta)+A rather than
// Ctrl+A. Runs in the extension background context (service worker / persistent
// page), where `navigator.platform` / `navigator.userAgentData.platform` are
// available. Best-effort — defaults to non-mac (Ctrl) if neither is readable.
function isMacPlatform(): boolean {
  try {
    const nav = (globalThis as { navigator?: any }).navigator;
    if (nav) {
      if (typeof nav.platform === "string" && /mac/i.test(nav.platform)) {
        return true;
      }
      const uaPlatform = nav.userAgentData && nav.userAgentData.platform;
      if (typeof uaPlatform === "string" && /mac/i.test(uaPlatform)) {
        return true;
      }
    }
  } catch (e) {
    /* ignore — fall through to non-mac default */
  }
  return false;
}

// CDP modifier bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8). Accepts the FoxPilot
// modifier names (ctrl/shift/alt/meta) plus common aliases.
function cdpModifierMask(modifiers?: string[]): number {
  if (!modifiers || modifiers.length === 0) {
    return 0;
  }
  let mask = 0;
  for (const m of modifiers) {
    switch (String(m).toLowerCase()) {
      case "alt":
        mask |= 1;
        break;
      case "ctrl":
      case "control":
        mask |= 2;
        break;
      case "meta":
      case "cmd":
      case "command":
      case "win":
      case "windows":
        mask |= 4;
        break;
      case "shift":
        mask |= 8;
        break;
      default:
        break;
    }
  }
  return mask;
}

interface KeyInfo {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

// Map a FoxPilot key name to the CDP key / code / windowsVirtualKeyCode (plus
// `text` for keys that produce a character). Named keys use their standard DOM
// key + Windows virtual-key code; a single printable character maps to its
// uppercased char code with a Key*/Digit* physical code and carries `text` so
// the renderer inserts it.
function resolveKeyInfo(key: string): KeyInfo {
  const named: Record<string, { code: string; keyCode: number; text?: string }> = {
    Enter: { code: "Enter", keyCode: 13, text: "\r" },
    Tab: { code: "Tab", keyCode: 9, text: "\t" },
    Escape: { code: "Escape", keyCode: 27 },
    Esc: { code: "Escape", keyCode: 27 },
    Backspace: { code: "Backspace", keyCode: 8 },
    Delete: { code: "Delete", keyCode: 46 },
    ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
    ArrowUp: { code: "ArrowUp", keyCode: 38 },
    ArrowRight: { code: "ArrowRight", keyCode: 39 },
    ArrowDown: { code: "ArrowDown", keyCode: 40 },
    Home: { code: "Home", keyCode: 36 },
    End: { code: "End", keyCode: 35 },
    PageUp: { code: "PageUp", keyCode: 33 },
    PageDown: { code: "PageDown", keyCode: 34 },
    Space: { code: "Space", keyCode: 32, text: " " },
    " ": { code: "Space", keyCode: 32, text: " " },
  };
  const hit = named[key];
  if (hit) {
    return {
      key: key === "Space" ? " " : key,
      code: hit.code,
      keyCode: hit.keyCode,
      ...(hit.text !== undefined ? { text: hit.text } : {}),
    };
  }
  // Single printable character → physical code + Windows VK from the uppercase
  // form; carries `text` so it is inserted as a character.
  if (key.length === 1) {
    const upper = key.toUpperCase();
    const cc = upper.charCodeAt(0);
    let code = "";
    if (upper >= "A" && upper <= "Z") {
      code = "Key" + upper;
    } else if (key >= "0" && key <= "9") {
      code = "Digit" + key;
    }
    return { key, code, keyCode: cc, text: key };
  }
  // Unknown multi-character key name — pass it through best-effort with no text.
  return { key, code: key, keyCode: 0 };
}

/**
 * Trusted "fill" (REPLACE semantics) at a viewport point via CDP. Focus-clicks
 * the point, selects the existing value (Cmd+A on macOS, Ctrl+A elsewhere), then
 * Input.insertText the new value — which replaces the selection (an empty value
 * clears the field). Chrome/Edge only; refcounted "input" purpose.
 */
export async function cdpInputFill(
  tabId: number,
  x: number,
  y: number,
  text: string
): Promise<void> {
  const selectAllModifier = isMacPlatform() ? 4 /* Meta */ : 2 /* Ctrl */;
  await withInputAttach(tabId, async (dbg) => {
    // Trusted focus click (mouseMoved + buttons bitmask, C17 fidelity).
    await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });
    await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    // Select-all so the following insertText REPLACES the current value.
    await dbg.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "keyDown",
      modifiers: selectAllModifier,
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
    });
    await dbg.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: selectAllModifier,
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
    });
    // insertText commits the new value over the selection. An empty string
    // clears the field (the selection is deleted with nothing inserted).
    await dbg.sendCommand({ tabId }, "Input.insertText", { text });
  });
}

/**
 * Trusted key press via CDP to the FOCUSED element (no coordinate) — backs
 * press-key engine:"cdp". Dispatches a keyDown/keyUp pair with the resolved
 * key / code / windowsVirtualKeyCode and the modifier bitmask. `text` (for
 * printable keys) is suppressed when a command modifier (Ctrl/Alt/Meta) is held
 * so shortcuts like Ctrl+A don't also insert a character. Chrome/Edge only.
 */
export async function cdpInputKey(
  tabId: number,
  key: string,
  modifiers?: string[]
): Promise<void> {
  const info = resolveKeyInfo(key);
  const mask = cdpModifierMask(modifiers);
  // A command modifier (Alt/Ctrl/Meta) means this is a shortcut, not text entry
  // — don't carry `text` (would double-insert the char alongside the command).
  const hasCommandModifier = (mask & (1 | 2 | 4)) !== 0;
  const text = hasCommandModifier ? undefined : info.text;
  await withInputAttach(tabId, async (dbg) => {
    await dbg.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "keyDown",
      modifiers: mask,
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.keyCode,
      ...(text !== undefined ? { text } : {}),
    });
    await dbg.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers: mask,
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.keyCode,
    });
  });
}
