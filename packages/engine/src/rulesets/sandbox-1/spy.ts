import { own } from "@perfidia/engine/core";
import type { Ctx, ReadCtx } from "@perfidia/engine/contracts";
import { deleteMovement, queueEtas, stockAt, unitsAtHome, unitsPop } from "@perfidia/engine/std";
import type {
  CityId,
  CompiledRules,
  DeepReadonly,
  JsonObject,
  MovementId,
  UnitCounts,
} from "@perfidia/protocol";
import type { SandboxConfig } from "./config.ts";
import type { SandboxExt } from "./ext.ts";

// `hooks.arrive.spy` (docs/architecture.md §3.8). A spy succeeds iff its gold (paid at departure)
// is above `spy.counterBase + Σ pop of the land units present` (every owner, home and stationed;
// ties go to the target). On success the spier gets a `spy_report` snapshot of the city and the
// owner is not told; on failure the spier gets `spy_failed` and the owner `spy_detected` (the
// spier, its origin city and the gold). A spy whose sender owns the target at arrival (it changed
// hands meanwhile) simply reports.

type SandboxCtx = Ctx<SandboxConfig, SandboxExt>;

function bug(message: string): never {
  throw new Error(`sandbox-1: ${message}`);
}

/** The land units of `units` (boats excluded). */
function landOnly(rules: DeepReadonly<CompiledRules>, units: Readonly<UnitCounts>): UnitCounts {
  const out: UnitCounts = {};
  for (const u of rules.units) {
    const n = units[u.id] ?? 0;
    if (u.domain === "land" && n > 0) out[u.id] = n;
  }
  return out;
}

/** Σ pop of the land units in the city: the owner's units at home and every stationed group. */
export function landPopPresent(r: ReadCtx, city: CityId): number {
  const c = own(r.state.cities, city) ?? bug(`city ${city} does not exist`);
  let pop = unitsPop(r.rules, landOnly(r.rules, unitsAtHome(r, city)));
  for (const g of c.stationed) pop += unitsPop(r.rules, landOnly(r.rules, g.units));
  return pop;
}

/** Counter-intelligence of a city: a spy needs strictly more gold. */
export function counterIntel(
  config: DeepReadonly<SandboxConfig>,
  r: ReadCtx,
  city: CityId,
): number {
  return config.spy.counterBase + landPopPresent(r, city);
}

/** The report of a successful spy: the city as it is at arrival (not units away, not movements). */
export function spySnapshot(r: ReadCtx, city: CityId): JsonObject {
  const c = own(r.state.cities, city) ?? bug(`city ${city} does not exist`);
  return {
    city,
    owner: c.owner,
    island: c.island,
    buildings: { ...c.buildings },
    stock: stockAt(r, city),
    units: unitsAtHome(r, city),
    stationed: c.stationed.map((g) => ({
      player: g.owner,
      home: g.home,
      role: g.role,
      units: { ...g.units },
    })),
    queues: queueEtas(r, city).map((q) =>
      q.kind === "build"
        ? { queue: q.queue, item: q.item, building: q.building, level: q.level, end: q.end }
        : { queue: q.queue, item: q.item, unit: q.unit, count: q.count, end: q.end },
    ),
  };
}

/** `hooks.arrive.spy`. */
export function arriveSpy(ctx: SandboxCtx, id: MovementId): void {
  const m = own(ctx.state.movements, id) ?? bug(`spy ${id} does not exist`);
  if (m.to === null) bug(`spy ${id} has no target city`);
  const cityId = m.to;
  const city = own(ctx.state.cities, cityId) ?? bug(`spy ${id} targets the missing ${cityId}`);
  const spier = m.owner;
  const r = ctx.read();
  const success = city.owner === spier || m.gold > counterIntel(ctx.config, r, cityId);
  if (success) {
    ctx.emit({
      type: "spy_report",
      public: false,
      to: [{ p: spier, as: "self" }],
      data: { report: ctx.nextId("r", spier), ...spySnapshot(r, cityId) },
    });
  } else {
    ctx.emit({
      type: "spy_failed",
      public: false,
      to: [{ p: spier, as: "self" }],
      data: { movement: id, city: cityId },
    });
    if (city.owner !== null) {
      ctx.emit({
        type: "spy_detected",
        public: false,
        to: [{ p: city.owner, as: "target" }],
        data: { city: cityId, by: spier, from: m.from, gold: m.gold },
      });
    }
  }
  deleteMovement(ctx, id);
}
