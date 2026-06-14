/**
 * Pure, deterministic-with-a-seed motion model for human-like input.
 * No DOM and no `browser` access — safe to unit-test directly and to call
 * from the background. The orchestrator (run-human-input.ts) consumes these.
 */

export interface Point {
  x: number;
  y: number;
}

export interface MouseStep {
  x: number;
  y: number;
  delayMs: number; // wait this long BEFORE dispatching this point
}

export interface KeyStep {
  char: string;
  delayMs: number; // wait this long BEFORE typing this char
}

/** mulberry32 — small fast seeded PRNG. Returns a function yielding [0,1). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A curved, eased, jittered cubic-Bézier path from `from` to `to`. The number
 * of waypoints scales with distance. The final waypoint lands exactly on `to`.
 */
export function mousePath(
  from: Point,
  to: Point,
  rng: () => number
): MouseStep[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const steps = Math.max(8, Math.min(40, Math.round(dist / 12)));

  // Unit normal to the straight line, used to bow the control points out.
  const nx = dist === 0 ? 0 : -dy / dist;
  const ny = dist === 0 ? 0 : dx / dist;
  const bow = Math.min(dist, 200) * 0.3;

  const c1x = from.x + dx * 0.33 + nx * (rng() - 0.5) * 2 * bow;
  const c1y = from.y + dy * 0.33 + ny * (rng() - 0.5) * 2 * bow;
  const c2x = from.x + dx * 0.66 + nx * (rng() - 0.5) * 2 * bow;
  const c2y = from.y + dy * 0.66 + ny * (rng() - 0.5) * 2 * bow;

  const totalMs = 120 + dist * 1.2 + rng() * 80;
  const out: MouseStep[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // ease-in-out so velocity ramps up then settles.
    const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    const mt = 1 - e;
    const x =
      mt * mt * mt * from.x +
      3 * mt * mt * e * c1x +
      3 * mt * e * e * c2x +
      e * e * e * to.x;
    const y =
      mt * mt * mt * from.y +
      3 * mt * mt * e * c1y +
      3 * mt * e * e * c2y +
      e * e * e * to.y;
    const tremor = (rng() - 0.5) * 1.5;
    out.push({
      x: Math.round(x + tremor),
      y: Math.round(y + tremor),
      delayMs: Math.max(4, Math.round(totalMs / steps + (rng() - 0.5) * 6)),
    });
  }
  // Guarantee the path ends exactly on the target.
  const lastDelay = out[out.length - 1].delayMs;
  out[out.length - 1] = { x: Math.round(to.x), y: Math.round(to.y), delayMs: lastDelay };
  return out;
}

/**
 * Per-character timing for typing `text`. Gaussian-ish flight times via the
 * mean of three rng draws, with longer pauses after spaces and punctuation.
 */
export function typingPlan(text: string, rng: () => number): KeyStep[] {
  const out: KeyStep[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    let d = 60 + ((rng() + rng() + rng()) / 3) * 160; // ~60-220ms
    if (ch === " ") {
      d += 40;
    }
    if (".,!?;:".indexOf(ch) >= 0) {
      d += 80;
    }
    out.push({ char: ch, delayMs: Math.round(d) });
  }
  return out;
}
