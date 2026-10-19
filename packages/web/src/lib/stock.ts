import type { CityEnt } from "@perfidia/protocol/spectator";

// A city's stock for display at the playhead (phase-3 design §4.4): the frame holds whole units at
// `stockAt` and rates per hour; the value now is extrapolated in floating point and capped, shown
// with "≈". Exact values belong to the engine.

export type Resources = Readonly<Record<string, number>>;

export function stockNow(
  city: Pick<CityEnt, "stock" | "stockAt" | "perHour" | "cap">,
  t: number,
): Resources {
  const dt = Math.max(0, t - city.stockAt);
  const out: Record<string, number> = {};
  for (const r of ["wood", "stone", "gold"] as const) {
    const v = city.stock[r];
    out[r] = Math.floor(Math.min(Math.max(v, city.cap), v + (city.perHour[r] * dt) / 3_600));
  }
  return out;
}
