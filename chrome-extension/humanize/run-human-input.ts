/**
 * Pure orchestrator for the synthetic human-like input layer. It contains NO
 * DOM and NO `browser` access — all effects are injected via `deps`, so it is
 * unit-testable with mocks. message-handler.ts wires the real deps.
 *
 * Outcome-invariance: every authoritative mutation goes through `deps.instant`
 * (the existing, untouched `performInputAction`). The humanized path only adds
 * paced movement / per-char typing and falls back to instant on any step
 * failure. For `type`, a mid-way failure lands the REMAINING substring via
 * instant (which appends), so the final value is identical with no duplication.
 */

import type { performInputAction } from "../injected/action-script";
import { mousePath, Point, typingPlan } from "./motion-model";

export type InstantArgs = Parameters<typeof performInputAction>[1];
export interface StepResult {
  ok: boolean;
  error?: string;
}
export interface TargetInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  dpr: number;
}

export interface HumanInputDeps {
  rng: () => number;
  sleep: (ms: number) => Promise<void>;
  getCursor: () => Point;
  setCursor: (p: Point) => void;
  readTargetInfo: (uid: string) => Promise<TargetInfo | null>;
  mouseMove: (x: number, y: number) => Promise<void>;
  typeChar: (ch: string) => Promise<StepResult>;
  instant: (args: InstantArgs) => Promise<StepResult>;
}

function centerOf(info: TargetInfo): Point {
  return { x: info.x + info.width / 2, y: info.y + info.height / 2 };
}

export async function runHumanInput(
  args: InstantArgs,
  deps: HumanInputDeps
): Promise<StepResult> {
  async function moveCursorTo(target: Point): Promise<void> {
    const from = deps.getCursor();
    const steps = mousePath(from, target, deps.rng);
    for (let i = 0; i < steps.length; i++) {
      await deps.sleep(steps[i].delayMs);
      await deps.mouseMove(steps[i].x, steps[i].y);
    }
    deps.setCursor(target);
  }

  // Actions targeting a single uid: move the cursor over it (if it resolves),
  // then let the instant path do the real activation / value set.
  if (args.action === "click" || args.action === "hover" || args.action === "fill") {
    const info = await deps.readTargetInfo(args.uid);
    if (info) {
      await moveCursorTo(centerOf(info));
    }
    return deps.instant(args);
  }

  if (args.action === "fill-form") {
    for (let i = 0; i < args.fields.length; i++) {
      const field = args.fields[i];
      const info = await deps.readTargetInfo(field.uid);
      if (info) {
        await moveCursorTo(centerOf(info));
      }
      const r = await deps.instant({
        action: "fill",
        uid: field.uid,
        value: field.value,
      });
      if (!r.ok) {
        return r;
      }
      // Brief inter-field pause (skip after the last field).
      if (i < args.fields.length - 1) {
        await deps.sleep(80 + Math.round(deps.rng() * 160));
      }
    }
    return { ok: true };
  }

  if (args.action === "drag") {
    const fromInfo = await deps.readTargetInfo(args.fromUid);
    if (fromInfo) {
      await moveCursorTo(centerOf(fromInfo));
    }
    const toInfo = await deps.readTargetInfo(args.toUid);
    if (toInfo) {
      await moveCursorTo(centerOf(toInfo));
    }
    return deps.instant(args);
  }

  if (args.action === "type") {
    const text = args.text;
    const plan = typingPlan(text, deps.rng);
    for (let i = 0; i < plan.length; i++) {
      await deps.sleep(plan[i].delayMs);
      const r = await deps.typeChar(plan[i].char);
      if (!r.ok) {
        // Land the remaining text instantly (instant `type` appends).
        return deps.instant({
          action: "type",
          text: text.slice(i),
          submit: args.submit,
        });
      }
    }
    if (args.submit) {
      return deps.instant({ action: "type", text: "", submit: true });
    }
    return { ok: true };
  }

  if (args.action === "press-key") {
    await deps.sleep(40 + Math.round(deps.rng() * 120));
    return deps.instant(args);
  }

  // Unknown action shape — defer to instant (which returns the canonical error).
  return deps.instant(args);
}
