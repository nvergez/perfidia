import type { DeepReadonly } from "@perfidia/protocol";
import type { PerfidiaConfig } from "./config.ts";

// Espionage maths (perfidia-1 §10). The `arrive.spy` hook counts the land pop present (every owner,
// garrison included) and builds the report.

/** Counter-intel of a city: `100 + 50 · wall + Σ land pop present` (§10). */
export function counterIntel(
  config: DeepReadonly<PerfidiaConfig>,
  wall: number,
  landPopPresent: number,
): number {
  const s = config.spy;
  return s.counterBase + s.counterPerWall * wall + s.counterPerLandPop * landPopPresent;
}

/** A spy succeeds iff its gold exceeds the counter-intel; ties go to the target (§10). */
export function spySucceeds(gold: number, counter: number): boolean {
  return gold > counter;
}

/** The least gold that succeeds against a counter-intel value. */
export function spyGoldNeeded(counter: number): number {
  return counter + 1;
}
