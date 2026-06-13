// Real OS-input backend driven by @nut-tree-fork/nut-js (v4).
//
// Verified against the installed type declarations
// (node_modules/@nut-tree-fork/nut-js + @nut-tree-fork/shared):
//   - mouse: setPosition(Point), getPosition(), leftClick(), rightClick(),
//            doubleClick(Button), pressButton(Button), releaseButton(Button)
//   - keyboard: type(...string|Key), pressKey(...Key), releaseKey(...Key)
//   - Point: new Point(x, y)
//   - Button enum: LEFT=0, MIDDLE=1, RIGHT=2
//   - Key enum: Escape, Enter, LeftControl, LeftShift, LeftAlt, LeftSuper, ...
//   - config: mouse.config.mouseSpeed (number), keyboard.config.autoDelayMs (number)
//
// nut-js is kept as an esbuild `--external` dependency so the native addon is
// resolved at runtime from node_modules and never bundled into dist/main.js.
import { mouse, keyboard, Point, Button, Key } from "@nut-tree-fork/nut-js";
import { InputBackend } from "./input-backend";

export class NutInputBackend implements InputBackend {
  constructor() {
    // We pace movement ourselves (one setPosition per waypoint) and pace typing
    // via the sidecar's per-key sleeps, so disable nut-js' own easing/auto-delay.
    try {
      mouse.config.mouseSpeed = 99999;
    } catch {
      /* config may be unavailable in some environments; safe to ignore */
    }
    try {
      keyboard.config.autoDelayMs = 0;
    } catch {
      /* ignore */
    }
  }

  async moveTo(x: number, y: number): Promise<void> {
    await mouse.setPosition(new Point(Math.round(x), Math.round(y)));
  }

  async click(button: "left" | "right", doubleClick: boolean): Promise<void> {
    if (doubleClick) {
      await mouse.doubleClick(button === "right" ? Button.RIGHT : Button.LEFT);
      return;
    }
    if (button === "right") {
      await mouse.rightClick();
    } else {
      await mouse.leftClick();
    }
  }

  async mouseDown(button: "left" | "right"): Promise<void> {
    await mouse.pressButton(button === "right" ? Button.RIGHT : Button.LEFT);
  }

  async mouseUp(button: "left" | "right"): Promise<void> {
    await mouse.releaseButton(button === "right" ? Button.RIGHT : Button.LEFT);
  }

  async typeChar(ch: string): Promise<void> {
    await keyboard.type(ch);
  }

  async pressKey(key: string, modifiers: string[]): Promise<void> {
    const map: Record<string, Key> = {
      ctrl: Key.LeftControl,
      control: Key.LeftControl,
      shift: Key.LeftShift,
      alt: Key.LeftAlt,
      option: Key.LeftAlt,
      meta: Key.LeftSuper,
      cmd: Key.LeftSuper,
      command: Key.LeftSuper,
      super: Key.LeftSuper,
      win: Key.LeftSuper,
      enter: Key.Enter,
      return: Key.Enter,
      escape: Key.Escape,
      esc: Key.Escape,
    };
    const mods = modifiers
      .map((m) => map[m.toLowerCase()])
      .filter((k): k is Key => k !== undefined);
    const main = map[key.toLowerCase()];
    const keys = main !== undefined ? [...mods, main] : mods;
    if (!keys.length) {
      // Nothing mapped (e.g. a literal character with no modifiers): type it.
      await keyboard.type(key);
      return;
    }
    // Press in natural order (modifiers first, then main key), release in reverse.
    for (const k of keys) {
      await keyboard.pressKey(k);
    }
    for (const k of [...keys].reverse()) {
      await keyboard.releaseKey(k);
    }
  }

  async probe(): Promise<boolean> {
    // Best-effort signal: getPosition() works on macOS without Accessibility,
    // but synthesizing input requires it. A throw here (or at gesture time)
    // surfaces as needsPermission upstream; this is the cheap pre-check.
    try {
      await mouse.getPosition();
      return true;
    } catch {
      return false;
    }
  }
}
