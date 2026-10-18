import type { Ctx, ReadCtx } from "@perfidia/engine/contracts";
import { fmtTime, own } from "@perfidia/engine/core";
import type {
  City,
  CityId,
  DeepReadonly,
  GameState,
  GameTime,
  Movement,
  MovementId,
  PlayerId,
  Stationed,
  TimePair,
  UnitCounts,
} from "@perfidia/protocol";
import type { PerfidiaConfig, PerfidiaCore } from "./config.ts";
import type { PerfidiaExt } from "./ext.ts";

// Shared helpers of the perfidia-1 hooks: typed contexts, lookups that fail loudly (a missing
// entity inside a hook is an engine bug, docs/architecture.md §5.3) and small state queries.

/** The context of the hooks every perfidia-1 version shares: its config read through the core type. */
export type PCtx = Ctx<PerfidiaCore, PerfidiaExt>;
export type PRead = ReadCtx<PerfidiaCore, PerfidiaExt>;

/** The context of the hooks of perfidia-1@1.0.0 only (its scoring, victory and views). */
export type PCtx100 = Ctx<PerfidiaConfig, PerfidiaExt>;
export type PRead100 = ReadCtx<PerfidiaConfig, PerfidiaExt>;

type State = DeepReadonly<GameState>;

/** A precondition of a perfidia-1 hook failed: the kernel aborts the match as an engine bug. */
export class PerfidiaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PerfidiaError";
  }
}

export function fail(message: string): never {
  throw new PerfidiaError(message);
}

/** `core.own`: the own value of `key` in a record keyed by ids, never a prototype member. */
export { own };

export function cityOf(state: State, id: CityId): DeepReadonly<City> {
  return own(state.cities, id) ?? fail(`city ${id} does not exist`);
}

export function draftCityOf(ctx: PCtx, id: CityId): City {
  return own(ctx.state.cities, id) ?? fail(`city ${id} does not exist`);
}

export function movementOf(state: State, id: MovementId): DeepReadonly<Movement> {
  return own(state.movements, id) ?? fail(`movement ${id} does not exist`);
}

export function draftMovementOf(ctx: PCtx, id: MovementId): Movement {
  return own(ctx.state.movements, id) ?? fail(`movement ${id} does not exist`);
}

/** Removes the scheduled event `seq` when it is still queued (a handler runs after its own pop). */
export function cancelIfQueued(ctx: PCtx, seq: number): void {
  if (ctx.state.queue.some((e) => e.seq === seq)) ctx.cancel(seq);
}

/** A game time as shown to agents: the integer and its text (docs/architecture.md §7.3). */
export function timePair(t: GameTime): TimePair {
  return [t, fmtTime(t)];
}

/** The `hold` groups of `by` in the city: a siege garrison, in stored (home) order. */
export function holdGroups(
  state: State,
  city: CityId,
  by: PlayerId,
): readonly DeepReadonly<Stationed>[] {
  return cityOf(state, city).stationed.filter((g) => g.owner === by && g.role === "hold");
}

/** Units of one type in a list of groups. */
export function countIn(
  groups: readonly { readonly units: DeepReadonly<UnitCounts> }[],
  unit: string,
): number {
  let n = 0;
  for (const g of groups) n += g.units[unit] ?? 0;
  return n;
}

/** Whether two sorted lists are equal. */
export function sameMembers<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i]);
}
