import type { Invariant } from "@perfidia/engine/contracts";
import { sortedIds } from "@perfidia/engine/std";
import { compareIds } from "@perfidia/protocol";
import { own } from "./common.ts";
import { Perfidia11ExtSchema } from "./ext_1_1.ts";
import { perfidiaInvariantsFor } from "./invariants.ts";

// The invariants of perfidia-1@1.1.0 (docs/architecture.md §13.3): 1.0.0's, reading the 1.1.0 ext,
// and the conquest records. Whether every countdown's bloc qualifies is deliberately not one: a
// hand-built state may hold a countdown that does not (P10 stages one), and `afterStep` cancels it
// at the next step; `countdownsQualifyProblems` checks it after steps instead.

const MAX_REPORTS = 20;

/**
 * Conquest records: each names an existing city, whose owner is the record's `by`; `former` is
 * sorted, without repeats, and lists players of the match (eliminated ones stay listed).
 */
const conquests: Invariant = {
  name: "perfidia-1.conquests",
  level: "step",
  check(r) {
    const parsed = Perfidia11ExtSchema.safeParse(r.state.ext);
    if (!parsed.success) return [];
    const x = parsed.data;
    const out: string[] = [];
    for (const id of sortedIds(x.conquests)) {
      const c = own(x.conquests, id);
      if (c === undefined) continue;
      const city = own(r.state.cities, id);
      if (city === undefined) {
        out.push(`conquest record of ${id}: no such city`);
        continue;
      }
      if (city.owner !== c.by) {
        out.push(
          `conquest record of ${id}: taken by ${c.by}, but the owner is ${city.owner ?? "none"}`,
        );
      }
      c.former.forEach((p, i) => {
        const prev = c.former[i - 1];
        if (prev !== undefined && compareIds(prev, p) >= 0) {
          out.push(
            `conquest record of ${id}: former owners ${c.former.join(",")} are not sorted and unique`,
          );
        }
        if (own(r.state.players, p) === undefined) {
          out.push(`conquest record of ${id}: former owner ${p} is not a player`);
        }
      });
      if (own(r.state.players, c.by) === undefined) {
        out.push(`conquest record of ${id}: ${c.by} is not a player`);
      }
    }
    return out.length > MAX_REPORTS
      ? [...out.slice(0, MAX_REPORTS), `… ${out.length - MAX_REPORTS} more`]
      : out;
  },
};

/** `hooks.invariants` of perfidia-1@1.1.0, all at step level. */
export const perfidia11Invariants: readonly Invariant[] = Object.freeze([
  ...perfidiaInvariantsFor(Perfidia11ExtSchema),
  conquests,
]);
