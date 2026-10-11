// The pacing measures (docs/architecture.md §13.9, §4.3): army pop counts units at home through
// `std.unitsAtHome`, so recruits that trickled out of a queue but are not materialised yet count,
// at every checkpoint, including those where the stored `units` lag behind.

import { describe, expect, test } from "bun:test";
import { verifyLog, type ReadCtx } from "@perfidia/engine";
import { sortedIds, unitsAtHome, unitsPop } from "@perfidia/engine/std";
import { runBots } from "../harness/index.ts";
import { measureState } from "./index.ts";

/** Every owned unit's pop, with units at home taken raw (`stored`) or derived. */
function totalArmyPop(r: ReadCtx, stored: boolean): number {
  const s = r.state;
  let total = 0;
  for (const id of sortedIds(s.cities)) {
    const c = s.cities[id];
    if (c === undefined) continue;
    if (c.owner !== null) total += unitsPop(r.rules, stored ? c.units : unitsAtHome(r, id));
    for (const g of c.stationed) total += unitsPop(r.rules, g.units);
  }
  for (const m of Object.values(s.movements)) total += unitsPop(r.rules, m.units);
  return total;
}

describe("pacing measures", () => {
  test("army pop counts trickled recruits that are not materialised yet", async () => {
    const { lines } = await runBots({
      ruleset: "perfidia-1",
      seed: 1,
      players: 6,
      days: 1,
      clock: { kind: "lockstep" },
    });
    const seats = 6;
    let lagging = 0;
    let checkpoints = 0;
    const report = verifyLog(lines, {
      onCheckpoint(_hour, r) {
        checkpoints += 1;
        const derived = totalArmyPop(r, false);
        if (derived !== totalArmyPop(r, true)) lagging += 1;
        expect(measureState(r).armyPopMean).toBe(Math.round((derived / seats) * 100) / 100);
      },
    });
    expect(report.ok).toBe(true);
    expect(checkpoints).toBeGreaterThan(20);
    // The case that matters happens in this run: some checkpoint has unmaterialised recruits.
    expect(lagging).toBeGreaterThan(0);
  }, 30000);
});
