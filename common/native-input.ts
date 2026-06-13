// Wire protocol for the native-input sidecar (extension <-> sidecar, signed).
export interface NativeWaypoint { x: number; y: number; delayMs: number } // SCREEN coords

export type NativeGesture =
  | { kind: "move-click"; waypoints: NativeWaypoint[]; button?: "left" | "right"; doubleClick?: boolean }
  | { kind: "move"; waypoints: NativeWaypoint[] }
  | { kind: "type"; keys: { char: string; delayMs: number }[] }
  | { kind: "key"; key: string; modifiers?: string[] }
  | { kind: "drag"; from: NativeWaypoint[]; to: NativeWaypoint[] }
  | { kind: "probe" };

export interface NativeInputRequest { id: string; gesture: NativeGesture }
export interface NativeInputResponse {
  id: string;
  ok: boolean;
  error?: string;
  needsPermission?: boolean; // OS (macOS Accessibility) permission missing
}
