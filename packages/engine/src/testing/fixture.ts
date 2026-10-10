import { fmtDuration, fmtTime, shuffle } from "@perfidia/engine/core";
import type {
  ActionHandler,
  Ctx,
  ExtraTool,
  ReadCtx,
  Ruleset,
  StepInfo,
} from "@perfidia/engine/contracts";
import {
  AuthoredNameSchema,
  CityIdSchema,
  PlayerIdSchema,
  compareIds,
  safeRecord,
  z,
  type ActionOf,
  type City,
  type CityId,
  type CompiledRules,
  type DeepReadonly,
  type GameState,
  type GameTime,
  type Island,
  type JsonObject,
  type MatchResult,
  type PlayerId,
  type Res,
  type Standing,
  type UnitCounts,
  type Violation,
} from "@perfidia/protocol";
import { addUnits, must, own, sendHome, unitTotal } from "./util.ts";

// The fixture ruleset `fixture-1@1.0.0` (docs/architecture.md §15 T04): two islands, constant
// travel, a trivial attack and spy, simple standings, one world timer, a non-empty `ext`, one
// ruleset intel event, error samples, one read and one write extra tool, and a visibility with a
// `publicCity` extra and a `briefing` hook driven by `ext`. Its ids are its own: it shares no
// building, unit or queue id with a real ruleset. Test-only; it is not in the registry.
//
// Rules in short: the larger side of a battle wins and the loser's units die; survivors sail home.
// A spy always reports, and the target learns of it (`fixture_scouted`, an intel event). Renaming
// (`fixture_rename`) opens at the `fixture_open` timer. After every step, a living player without a
// city is eliminated, and the last one alive wins (`last_standing`); otherwise the best score at
// `matchEnd` wins (`time`). A hand-built state should therefore give every living player a city.
//
// Holds, a besieged-like marker: a city with a stationed `hold` group of another player is held by
// that player. `ext.holds` records it (holder and since when), refreshed after every step from the
// stationed groups; `publicCity` shows it on the held city, and the `briefing` hook lists the holds
// the viewer takes part in. A hand-built state sets `ext.holds` with `fixtureHolds(state)`, or lets
// the first step (a `testStep` with no edit, say) refresh it.

const Int = z.int().nonnegative();

export const FixtureConfigSchema = z.strictObject({
  /** Fixed: 2..4 players. */
  players: z.strictObject({ min: z.literal(2), max: z.literal(4) }),
  /** Fixed. */
  resourceScale: z.literal(3600),
  time: z.strictObject({
    matchEnd: Int,
    attackFrom: Int,
    minTravel: Int,
    /** Travel between the two islands. */
    travel: Int,
    /** Travel within one island. */
    sameIsland: Int,
    /** The `fixture_open` world timer. */
    openAt: Int,
    /** Seconds per building level. */
    buildTime: Int,
    /** Seconds per recruited unit. */
    recruitTime: Int,
  }),
  start: z.strictObject({ stock: Int, soldiers: Int }),
  gateway: z.strictObject({
    roundTripsPerWake: Int,
    toolCallsPerRoundTrip: Int,
    toolCallsPerWake: Int.nullable(),
    ownWakesPerDay: Int,
    socialWakesPerDay: Int,
    groupWindow: Int,
    urgentMinGap: Int,
    selfWake: z.strictObject({ min: Int, max: Int }),
    safetyWake: Int,
    attackLaunchesPerDay: Int,
    messagesPerDay: Int,
    notesMaxChars: Int,
  }),
});
export type FixtureConfig = z.infer<typeof FixtureConfigSchema>;

export const FixtureHoldSchema = z.strictObject({ by: PlayerIdSchema, since: Int });
export type FixtureHold = z.infer<typeof FixtureHoldSchema>;

export const FixtureExtSchema = z.strictObject({
  opened: z.boolean(),
  renames: Int,
  /** The held cities: by whom, since when. */
  holds: safeRecord(CityIdSchema, FixtureHoldSchema),
});
export type FixtureExt = z.infer<typeof FixtureExtSchema>;

export const FIXTURE_REF = "fixture-1@1.0.0";

export const FIXTURE_DEFAULTS: DeepReadonly<FixtureConfig> = {
  players: { min: 2, max: 4 },
  resourceScale: 3600,
  time: {
    matchEnd: 86400,
    attackFrom: 0,
    minTravel: 3600,
    travel: 5400,
    sameIsland: 3600,
    openAt: 7200,
    buildTime: 600,
    recruitTime: 60,
  },
  start: { stock: 500, soldiers: 10 },
  gateway: {
    roundTripsPerWake: 6,
    toolCallsPerRoundTrip: 8,
    toolCallsPerWake: 30,
    ownWakesPerDay: 8,
    socialWakesPerDay: 6,
    groupWindow: 300,
    urgentMinGap: 300,
    selfWake: { min: 600, max: 21600 },
    safetyWake: 21600,
    attackLaunchesPerDay: 10,
    messagesPerDay: 10,
    notesMaxChars: 2000,
  },
};

/** Buildings in canonical order; every one has 3 levels. */
export const FIXTURE_BUILDINGS = [
  "tower",
  "woodcut",
  "stonecut",
  "goldcut",
  "vault",
  "drill",
] as const;
/** Units in canonical order: a soldier, a settler and a carrier. */
export const FIXTURE_UNITS = ["soldier", "pioneer", "ship"] as const;
const MAX_LEVEL = 3;

function res(n: number): Res {
  return { wood: n, stone: n, gold: n };
}

function compileFixture(config: DeepReadonly<FixtureConfig>, players: number): CompiledRules {
  const t = config.time;
  const levels = [0, 1, 2, 3];
  const buildingTime = levels.map((level) => (level === 0 ? [1] : [t.buildTime * level]));
  const unitTime = levels.map(() => t.recruitTime);
  const building = (id: string, requires: Record<string, number> = {}) => ({
    id,
    maxLevel: MAX_LEVEL,
    cost: levels.map((level) => res(10 * level)),
    time: buildingTime,
    requires,
  });
  return {
    ruleset: FIXTURE_REF,
    players,
    time: { matchEnd: t.matchEnd, attackFrom: t.attackFrom, minTravel: t.minTravel },
    resourceScale: config.resourceScale,
    buildings: [
      building("tower"),
      building("woodcut"),
      building("stonecut"),
      building("goldcut"),
      building("vault"),
      building("drill", { tower: 1 }),
    ],
    units: [
      {
        id: "soldier",
        domain: "land",
        attack: 5,
        defense: 5,
        naval: 0,
        carry: 10,
        capacity: 0,
        pop: 1,
        cost: res(5),
        queue: "drill",
        requires: { drill: 1 },
        time: unitTime,
        maxPerOrder: 100,
      },
      {
        id: "pioneer",
        domain: "land",
        attack: 0,
        defense: 1,
        naval: 0,
        carry: 0,
        capacity: 0,
        pop: 5,
        cost: res(100),
        queue: "drill",
        requires: { drill: 2 },
        time: unitTime,
        maxPerOrder: 1,
      },
      {
        id: "ship",
        domain: "naval",
        attack: 0,
        defense: 0,
        naval: 2,
        carry: 0,
        capacity: 10,
        pop: 2,
        cost: res(30),
        queue: "drill",
        requires: { drill: 1 },
        time: unitTime,
        maxPerOrder: 100,
      },
    ],
    roles: {
      producers: { wood: "woodcut", stone: "stonecut", gold: "goldcut" },
      storage: "vault",
      population: "tower",
      buildSpeed: null,
      wall: null,
      settler: "pioneer",
    },
    levels: {
      production: [0, 60, 120, 180],
      storage: [600, 1000, 2000, 4000],
      population: [20, 40, 80, 160],
    },
    queues: {
      build: { max: 3, requiresOn: "completed" },
      recruit: [{ id: "drill", building: "drill", maxBatches: 2, maxCount: 100 }],
      delivery: "batch",
      refund: {
        build: { queuedPm: 1000, active: { pm: 500 } },
        recruit: { queuedPm: 1000, active: { pm: 500 } },
      },
    },
    settlerCost: [res(100), res(200), res(300)],
    newCity: {
      buildings: { tower: 1, woodcut: 1, stonecut: 1, goldcut: 1, vault: 1 },
      stock: res(100),
      units: {},
    },
    neutralProduction: false,
    movement: {
      recall: { window: 600, kinds: ["attack", "support"], stationed: "whole", dismiss: false },
      shipment: null,
      transportRule: false,
      spyMinGold: 10,
    },
    diplomacy: {
      allianceMax: 2,
      maxPacts: 1,
      pactDuration: 86400,
      maxOpenProposals: 2,
      proposalTtl: 3600,
      messageMaxChars: 200,
      proposalTextMaxChars: 100,
      allianceNameMaxChars: 16,
    },
    toolOptions: { foundSlot: false, pactUntil: false },
    gateway: {
      ...config.gateway,
      selfWake: { ...config.gateway.selfWake },
      wake: {
        incoming_attack: { party: "urgent" },
        message: { target: "social" },
        build_done: { self: "own" },
        queue_empty: { self: "own" },
      },
      publicOncePerDay: [],
    },
    travelProbes: [{ label: "any", group: { kind: "attack", units: {} } }],
    eventClasses: {
      build_done: 1,
      recruit_done: 2,
      arrive_return: 3,
      arrive_support: 4,
      arrive_shipment: 4,
      arrive_found: 4,
      arrive_spy: 5,
      arrive_attack: 6,
      proposal_expire: 7,
      pact_expire: 7,
      fixture_open: 7,
      match_end: 9,
    },
  };
}

function capital(
  config: DeepReadonly<FixtureConfig>,
  owner: PlayerId,
  island: Island,
  slot: number,
): City {
  const scale = config.resourceScale;
  const id = CityIdSchema.parse(`c${owner.slice(1)}`);
  return {
    id,
    name: id,
    owner,
    island: island.id,
    slot,
    capitalOf: owner,
    tag: null,
    foundedAt: 0,
    stock: res(config.start.stock * scale),
    stockAt: 0,
    buildings: { tower: 1, woodcut: 1, stonecut: 1, goldcut: 1, vault: 1, drill: 1 },
    units: config.start.soldiers > 0 ? { soldier: config.start.soldiers } : {},
    stationed: [],
    itemSeq: 0,
    build: [],
    recruit: { drill: [] },
  };
}

function citiesOf(
  r: { readonly state: DeepReadonly<{ cities: Record<string, City> }> },
  p: PlayerId,
): City["id"][] {
  return Object.values(r.state.cities)
    .filter((c) => c.owner === p)
    .map((c) => c.id)
    .toSorted(compareIds);
}

function standingsOf(r: ReadCtx<FixtureConfig, FixtureExt>): Standing[] {
  const rows = Object.values(r.state.players).map((p) => {
    const owned = Object.values(r.state.cities).filter((c) => c.owner === p.id);
    const cityPoints = 100 * owned.length;
    let levelPoints = 0;
    for (const c of owned) for (const level of Object.values(c.buildings)) levelPoints += level;
    return { player: p.id, cities: owned.length, alive: p.alive, cityPoints, levelPoints };
  });
  const sorted = rows.toSorted(
    (a, b) =>
      b.cityPoints + b.levelPoints - (a.cityPoints + a.levelPoints) ||
      compareIds(a.player, b.player),
  );
  return sorted.map((row, i) => ({
    player: row.player,
    rank: i + 1,
    score: row.cityPoints + row.levelPoints,
    parts: { cityPoints: row.cityPoints, levelPoints: row.levelPoints },
    cities: row.cities,
    alive: row.alive,
  }));
}

/** The first stationed `hold` group of a player other than the owner, if any. */
function holderOf(city: DeepReadonly<City>): PlayerId | null {
  return city.stationed.find((g) => g.role === "hold" && g.owner !== city.owner)?.owner ?? null;
}

/**
 * The holds of `state` (the `ext.holds` the fixture keeps): every city with a `hold` group of
 * another player, held since the time already recorded for that holder, else since `state.now`.
 */
export function fixtureHolds(state: DeepReadonly<GameState>): Record<CityId, FixtureHold> {
  const ext = FixtureExtSchema.safeParse(state.ext);
  const before = ext.success ? ext.data.holds : {};
  const holds: Record<CityId, FixtureHold> = {};
  for (const city of Object.values(state.cities).toSorted((a, b) => compareIds(a.id, b.id))) {
    const by = holderOf(city);
    if (by === null) continue;
    const prev = own(before, city.id);
    holds[city.id] = { by, since: prev?.by === by ? prev.since : state.now };
  }
  return holds;
}

/** A time as the agent-facing pair of §7.3. */
function timePair(t: GameTime): [GameTime, string] {
  return [t, fmtTime(t)];
}

/** The `publicCity` extra: the hold of a held city, nothing for any other city. */
function publicCityOf(r: ReadCtx<FixtureConfig, FixtureExt>, city: CityId): JsonObject {
  const hold = own(r.ext().holds, city);
  return hold === undefined ? {} : { held: { by: hold.by, since: timePair(hold.since) } };
}

/** The `briefing` hook: renaming, and the holds the viewer takes part in, as holder or owner. */
function briefingOf(r: ReadCtx<FixtureConfig, FixtureExt>, viewer: PlayerId): JsonObject {
  const ext = r.ext();
  const holding: JsonObject[] = [];
  const held: JsonObject[] = [];
  for (const [city, hold] of Object.entries(ext.holds).toSorted((a, b) => compareIds(a[0], b[0]))) {
    const owner = own(r.state.cities, city)?.owner ?? null;
    if (hold.by === viewer) holding.push({ city, owner, since: timePair(hold.since) });
    if (owner === viewer) held.push({ city, by: hold.by, since: timePair(hold.since) });
  }
  return {
    renamingOpen: ext.opened,
    renames: ext.renames,
    openAt: timePair(r.config.time.openAt),
    holding,
    held,
  };
}

function goneFor(
  ctx: Ctx<FixtureConfig, FixtureExt>,
  owner: PlayerId | null,
  units: Readonly<UnitCounts>,
): void {
  const entry = ctx.state.ledger[owner ?? "neutral"];
  if (entry !== undefined) addUnits(entry.gone, units);
}

const RenameArgsSchema = z.strictObject({ city: CityIdSchema, name: z.string() });

interface RenamePlan {
  readonly city: City["id"];
  readonly name: string;
}

/** `hooks.actions.ext`: the write extra tool `fixture_rename {city, name}`. */
const renameHandler: ActionHandler<ActionOf<"ext">, RenamePlan> = {
  validate(r, seat, a) {
    if (a.tool !== "fixture_rename") {
      return { ok: false, violation: { code: "INVALID_ARGS", details: { tool: a.tool } } };
    }
    const args = RenameArgsSchema.safeParse(a.args);
    if (!args.success) {
      return { ok: false, violation: { code: "INVALID_ARGS", details: { tool: a.tool } } };
    }
    const { city, name } = args.data;
    const record = Object.hasOwn(r.state.cities, city) ? r.state.cities[city] : undefined;
    if (record === undefined)
      return { ok: false, violation: { code: "UNKNOWN_ID", details: { city } } };
    if (record.owner !== seat)
      return { ok: false, violation: { code: "NOT_OWNER", details: { city } } };
    if (name.length > 16 || !AuthoredNameSchema.safeParse(name).success) {
      return {
        ok: false,
        violation: { code: "TEXT_TOO_LONG", details: { max: 16, length: name.length } },
      };
    }
    return { ok: true, plan: { city, name } };
  },
  apply(ctx, _seat, plan) {
    const city = ctx.state.cities[plan.city];
    if (city === undefined) throw new Error(`fixture: no city ${plan.city}`);
    city.name = plan.name;
    const ext = FixtureExtSchema.parse(ctx.state.ext);
    ctx.state.ext = { ...ext, renames: ext.renames + 1 };
    ctx.emit({
      type: "city_renamed",
      public: true,
      to: [],
      data: { city: plan.city, name: plan.name },
    });
    return { city: plan.city, name: plan.name };
  },
};

const statusTool: ExtraTool = {
  name: "fixture_status",
  family: "observe",
  description: "Whether renaming is open, and how many cities were renamed.",
  args: z.strictObject({}),
  kind: "read",
  read: (r) => {
    const ext = FixtureExtSchema.parse(r.state.ext);
    return { opened: ext.opened, renames: ext.renames };
  },
};

const renameTool: ExtraTool = {
  name: "fixture_rename",
  family: "economy",
  description:
    "Rename one of your cities (ASCII letters, digits, space, '-', '_', '.'; at most 16).",
  args: RenameArgsSchema,
  kind: "write",
};

function closedViolation(openAt: number): Violation {
  return { code: "FIXTURE_CLOSED", details: { availableAt: openAt } };
}

/** The fixture ruleset (status `test`). */
export const fixtureRuleset: Ruleset<FixtureConfig, FixtureExt> = {
  id: "fixture-1",
  version: "1.0.0",
  ref: FIXTURE_REF,
  status: "test",
  title: "Kernel test fixture",
  configSchema: FixtureConfigSchema,
  defaults: FIXTURE_DEFAULTS,
  extSchema: FixtureExtSchema,
  players: (config) => ({ min: config.players.min, max: config.players.max }),
  compile: compileFixture,
  check(config) {
    return config.start.soldiers > 1000
      ? [
          {
            path: "start.soldiers",
            message: `is ${config.start.soldiers}; the fixture allows at most 1000`,
          },
        ]
      : [];
  },
  cheatSheet(config, rules) {
    return [
      `Fixture ruleset ${FIXTURE_REF}, ${rules.players} players, match end ${fmtTime(config.time.matchEnd)}.`,
      `Travel: ${fmtDuration(config.time.travel)} between islands, ${fmtDuration(config.time.sameIsland)} on one island.`,
      `Renaming opens at ${fmtTime(config.time.openAt)}.`,
    ].join("\n");
  },
  hooks: {
    createWorld(w) {
      const islands: Island[] = [
        { id: "i1", x: 0, y: 0, kind: "west", slots: 3, richnessPm: 1000 },
        { id: "i2", x: 10, y: 0, kind: "east", slots: 3, richnessPm: 1000 },
      ];
      const order = shuffle(w.rng("seats"), w.players);
      const cities = order.map((p, j) => {
        const island = islands[j % 2];
        if (island === undefined) throw new Error("fixture: no island");
        return capital(w.config, p, island, Math.floor(j / 2));
      });
      return {
        islands,
        cities: cities.toSorted((a, b) => compareIds(a.id, b.id)),
        ext: { opened: false, renames: 0, holds: {} },
        timers: [{ kind: "fixture_open", at: w.config.time.openAt, ref: "" }],
      };
    },
    travelTime(r, from, to) {
      return from === to ? r.config.time.sameIsland : r.config.time.travel;
    },
    arrive: {
      attack(ctx, id) {
        const m = must(ctx.state.movements, id, "movement");
        const city = m.to === null ? undefined : ctx.state.cities[m.to];
        if (city === undefined) throw new Error(`fixture: attack ${id} has no target city`);
        const winner = unitTotal(m.units) > unitTotal(city.units) ? "attacker" : "defender";
        if (winner === "attacker") {
          goneFor(ctx, city.owner, city.units);
          city.units = {};
        } else {
          goneFor(ctx, m.owner, m.units);
          m.units = {};
        }
        const headline = {
          city: city.id,
          attacker: m.owner,
          defender: city.owner ?? "neutral",
          kind: "raid",
          winner,
        };
        ctx.emit({ type: "battle", public: true, to: [], data: headline });
        ctx.emit({
          type: "battle_report",
          public: false,
          to: [{ p: m.owner, as: "self" }],
          data: { ...headline, report: ctx.nextId("r", m.owner) },
        });
        if (city.owner !== null && city.owner !== m.owner) {
          ctx.emit({
            type: "battle_report",
            public: false,
            to: [{ p: city.owner, as: "target" }],
            data: { ...headline, report: ctx.nextId("r", city.owner) },
          });
        }
        sendHome(ctx, id);
      },
      spy(ctx, id) {
        const m = must(ctx.state.movements, id, "movement");
        const city = m.to === null ? undefined : ctx.state.cities[m.to];
        if (city === undefined) throw new Error(`fixture: spy ${id} has no target city`);
        ctx.emit({
          type: "spy_report",
          public: false,
          to: [{ p: m.owner, as: "self" }],
          data: {
            report: ctx.nextId("r", m.owner),
            city: city.id,
            soldiers: unitTotal(city.units),
          },
        });
        if (city.owner !== null && city.owner !== m.owner) {
          ctx.emit({
            type: "fixture_scouted",
            public: false,
            to: [{ p: city.owner, as: "target" }],
            data: { city: city.id, by: m.owner },
          });
        }
        delete ctx.state.movements[m.id];
      },
    },
    on: {
      fixture_open(ctx) {
        ctx.state.ext = { ...ctx.ext(), opened: true };
        ctx.emit({ type: "fixture_opened", public: true, to: [], data: { at: ctx.now } });
      },
    },
    guard(r, _seat, a) {
      return a.type === "ext" && !r.ext().opened ? closedViolation(r.config.time.openAt) : null;
    },
    afterStep(ctx: Ctx<FixtureConfig, FixtureExt>, _step: StepInfo) {
      ctx.state.ext = { ...ctx.ext(), holds: fixtureHolds(ctx.state) };
      const r = ctx.read();
      for (const p of Object.values(ctx.state.players).toSorted((a, b) => compareIds(a.id, b.id))) {
        if (!p.alive || citiesOf(r, p.id).length > 0) continue;
        p.alive = false;
        p.eliminatedAt = ctx.now;
        ctx.emit({ type: "player_eliminated", public: true, to: [], data: { player: p.id } });
      }
      const alive = Object.values(ctx.state.players).filter((p) => p.alive);
      const [last] = alive;
      if (alive.length === 1 && last !== undefined) {
        ctx.endMatch({
          endedAt: ctx.now,
          reason: "last_standing",
          winners: [last.id],
          standings: standingsOf(ctx.read()),
        });
      }
    },
    standings: standingsOf,
    finish(ctx): MatchResult {
      const standings = standingsOf(ctx.read());
      const [top] = standings;
      return {
        endedAt: ctx.now,
        reason: "time",
        winners: top === undefined ? [] : [top.player],
        standings,
      };
    },
    visibility: {
      publicCity: (r, _viewer, city) => publicCityOf(r, city),
      briefing: briefingOf,
    },
    actions: { ext: renameHandler },
    invariants: [
      {
        name: "fixture.opened",
        level: "step",
        check(r) {
          const ext = FixtureExtSchema.safeParse(r.state.ext);
          const config = FixtureConfigSchema.safeParse(r.config);
          if (!ext.success || !config.success) return [];
          const openAt = config.data.time.openAt;
          return r.now > openAt && !ext.data.opened
            ? [`renaming is still closed after t = ${openAt}`]
            : [];
        },
      },
    ],
  },
  errors: {
    FIXTURE_CLOSED: (v, f) => {
      const at = typeof v.details["availableAt"] === "number" ? v.details["availableAt"] : 0;
      return {
        message: `Renaming is closed until ${f.time(at)}.`,
        hint: `Try again at ${f.time(at)} or later.`,
      };
    },
  },
  errorSamples: [closedViolation(7200)],
  tools: [statusTool, renameTool],
  eventSchemas: {
    fixture_opened: z.looseObject({ at: Int }),
    city_renamed: z.looseObject({ city: CityIdSchema, name: AuthoredNameSchema }),
    fixture_scouted: z.looseObject({ city: CityIdSchema, by: PlayerIdSchema }),
  },
  intelEvents: ["fixture_scouted"],
};
