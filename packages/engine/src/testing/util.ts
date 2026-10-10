import type { Ctx } from "@perfidia/engine/contracts";
import type { UnitCounts } from "@perfidia/protocol";

// Small helpers shared by the testing kit.

/**
 * Turns an arrived movement into its return trip home (as long as the way out), or deletes it when
 * nothing travels back. Used by the fixture's arrivals and the fake domain.
 */
export function sendHome(ctx: Ctx, id: string): void {
  const m = must(ctx.state.movements, id, "movement");
  if (unitTotal(m.units) === 0 && m.cargo.wood + m.cargo.stone + m.cargo.gold === 0) {
    delete ctx.state.movements[m.id];
    return;
  }
  const duration = Math.max(1, m.arriveAt - m.departAt);
  m.back = { kind: m.kind, at: ctx.now };
  m.kind = "return";
  m.departAt = ctx.now;
  m.arriveAt = ctx.now + duration;
  m.seq = ctx.schedule("arrive_return", m.arriveAt, m.id);
}

/** The own value of `key` in a record keyed by an id kind, or undefined (never a prototype key). */
export function own<V>(rec: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.hasOwn(rec, key) ? rec[key] : undefined;
}

/** Like `own`, but throws when the record has no such key. */
export function must<V>(rec: Readonly<Record<string, V>>, key: string, what: string): V {
  const value = own(rec, key);
  if (value === undefined) throw new Error(`testing kit: no ${what} ${key}`);
  return value;
}

/** Σ of the counts. */
export function unitTotal(units: Readonly<UnitCounts>): number {
  let total = 0;
  for (const n of Object.values(units)) total += n ?? 0;
  return total;
}

/** Adds `units` into `into`, keeping zero entries out. */
export function addUnits(into: UnitCounts, units: Readonly<UnitCounts>): void {
  for (const [unit, n] of Object.entries(units)) {
    if (n !== undefined && n > 0) into[unit] = (into[unit] ?? 0) + n;
  }
}

/** Removes `units` from `from` (which must hold them), keeping zero entries out. */
export function takeUnits(from: UnitCounts, units: Readonly<UnitCounts>): void {
  for (const [unit, n] of Object.entries(units)) {
    if (n === undefined || n <= 0) continue;
    const left = (from[unit] ?? 0) - n;
    if (left < 0) throw new Error(`testing kit: ${n} ${unit} taken, only ${from[unit] ?? 0} there`);
    if (left === 0) delete from[unit];
    else from[unit] = left;
  }
}

/** Whether `units` (non-empty) are all available in `have`. */
export function hasUnits(have: Readonly<UnitCounts>, units: Readonly<UnitCounts>): boolean {
  return Object.entries(units).every(([unit, n]) => n === undefined || (have[unit] ?? 0) >= n);
}
