import { NativeGesture } from "@foxpilot/common";

export interface InputBackend {
  // All coordinates are absolute SCREEN coordinates.
  moveTo(x: number, y: number): Promise<void>;
  click(button: "left" | "right", doubleClick: boolean): Promise<void>;
  mouseDown(button: "left" | "right"): Promise<void>;
  mouseUp(button: "left" | "right"): Promise<void>;
  typeChar(ch: string): Promise<void>;
  pressKey(key: string, modifiers: string[]): Promise<void>;
  // Returns true if the backend can synthesize input (OS permission granted).
  probe(): Promise<boolean>;
}

interface RecordedCall { kind: string; [k: string]: unknown }

export class MockInputBackend implements InputBackend {
  calls: RecordedCall[] = [];
  permitted = true;
  async moveTo(x: number, y: number) { this.calls.push({ kind: "moveTo", x, y }); }
  async click(button: "left" | "right", doubleClick: boolean) { this.calls.push({ kind: "click", button, doubleClick }); }
  async mouseDown(button: "left" | "right") { this.calls.push({ kind: "mouseDown", button }); }
  async mouseUp(button: "left" | "right") { this.calls.push({ kind: "mouseUp", button }); }
  async typeChar(ch: string) { this.calls.push({ kind: "typeChar", ch }); }
  async pressKey(key: string, modifiers: string[]) { this.calls.push({ kind: "pressKey", key, modifiers }); }
  async probe() { return this.permitted; }
}

// Executes a gesture against a backend, pacing waypoints with real sleeps.
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export async function runGesture(backend: InputBackend, gesture: NativeGesture): Promise<{ ok: boolean; error?: string; needsPermission?: boolean }> {
  try {
    if (gesture.kind === "probe") {
      const ok = await backend.probe();
      return ok ? { ok: true } : { ok: false, needsPermission: true, error: "OS input permission not granted" };
    }
    if (!(await backend.probe())) return { ok: false, needsPermission: true, error: "OS input permission not granted" };
    const playPath = async (wp: { x: number; y: number; delayMs: number }[]) => {
      for (const p of wp) { await sleep(p.delayMs); await backend.moveTo(p.x, p.y); }
    };
    if (gesture.kind === "move") { await playPath(gesture.waypoints); return { ok: true }; }
    if (gesture.kind === "move-click") {
      await playPath(gesture.waypoints);
      await backend.click(gesture.button || "left", !!gesture.doubleClick);
      return { ok: true };
    }
    if (gesture.kind === "type") { for (const k of gesture.keys) { await sleep(k.delayMs); await backend.typeChar(k.char); } return { ok: true }; }
    if (gesture.kind === "key") { await backend.pressKey(gesture.key, gesture.modifiers || []); return { ok: true }; }
    if (gesture.kind === "drag") {
      await playPath(gesture.from); await backend.mouseDown("left");
      await playPath(gesture.to); await backend.mouseUp("left");
      return { ok: true };
    }
    return { ok: false, error: "unknown gesture" };
  } catch (e) { return { ok: false, error: String(e) }; }
}
