import { describe, expect, test } from "bun:test";
import type { AnyRuleset } from "@perfidia/engine/contracts";
import { fmt, idKeyFromSeed } from "@perfidia/engine/core";
import { createMatch, type Match } from "@perfidia/engine/kernel";
import * as perfidia from "@perfidia/engine/rulesets/perfidia-1";
import {
  DOMAIN_EVENT_KINDS,
  PlayerIdSchema,
  compareIds,
  type MatchSetup,
  type PlayerId,
} from "@perfidia/protocol";
import * as check from "./check.ts";
import * as cheatsheet from "./cheatsheet.ts";
import * as combat from "./combat.ts";
import * as compile from "./compile.ts";
import * as config from "./config.ts";
import * as domination from "./domination.ts";
import * as errors from "./errors.ts";
import * as ext from "./ext.ts";
import { domain } from "@perfidia/engine/domain";
import { addMovement, matchFromState } from "@perfidia/engine/testing";
import { city, extOf, testDomain, world } from "./fixtures.test.ts";
import * as map from "./map.ts";
import * as scoring from "./scoring.ts";
import * as sin10k from "./sin10k.ts";
import * as spy from "./spy.ts";
import * as travel from "./travel.ts";

// The `perfidia1_1_0_0` descriptor: its fields, its wiring with the kernel (creation checks, world
// timers, every event kind handled, a whole 1-day match under step invariants), and the wave-3
// exports, kept unchanged.

const P1 = perfidia.perfidia1_1_0_0;

/** The runtime exports of the wave-3 modules (T06), as they were before wave 4. */
const T06_EXPORTS = [
  "BUILDING_IDS",
  "BlocKeySchema",
  "CAPITAL_IMMUNE",
  "CITY_BESIEGED",
  "CROWN_TAG",
  "CountdownSchema",
  "DOMINATION_OPEN",
  "FULL_TURN",
  "ISLAND_KINDS",
  "MAX_JITTER",
  "MAX_PACE",
  "MAX_TABLE_SIZE",
  "MAX_TILES",
  "NEUTRAL",
  "NOT_BESIEGER",
  "PERFIDIA_1_DEFAULTS",
  "PERFIDIA_1_ERRORS",
  "PERFIDIA_1_ERROR_SAMPLES",
  "PERFIDIA_1_ID",
  "PERFIDIA_1_REF",
  "PERFIDIA_1_VERSION",
  "PairKeySchema",
  "PerfidiaConfigSchema",
  "PerfidiaExtSchema",
  "RECRUIT_QUEUES",
  "SIN10K",
  "SiegeSchema",
  "UNIT_IDS",
  "baseDefense",
  "battleCredit",
  "battlePointsOf",
  "battleScore",
  "besiegerOf",
  "bestTiebreak",
  "blocCities",
  "blocsOf",
  "canBesiege",
  "carryOf",
  "checkConfig",
  "cityPoints",
  "compileRules",
  "computeStandings",
  "cosT",
  "countdownOf",
  "counterIntel",
  "createWorld",
  "distance2",
  "distanceTiles",
  "dominationThreshold",
  "drawMap",
  "eventClasses",
  "hasHubs",
  "homeRadius",
  "initialExt",
  "islandsPerSector",
  "landAttack",
  "landDefense",
  "layoutIslands",
  "lootOf",
  "moralePm",
  "normaliseAngle",
  "orderEndingCountdowns",
  "paceOf",
  "pairKey",
  "playerRange",
  "popBeforeByOwner",
  "popLostByOwner",
  "quad",
  "qualifies",
  "rankPlayers",
  "relationEndedAt",
  "renderCheatSheet",
  "resolveBattle",
  "scoreRows",
  "sectorIslandId",
  "siegeOf",
  "sinT",
  "spyGoldNeeded",
  "spySucceeds",
  "standingsOf",
  "statsOf",
  "survivorsOf",
  "tiebreakPosition",
  "timeWinner",
  "totalCities",
  "travelBetween",
  "travelTime",
  "wakeTable",
  "wallAfterBreach",
  "wallFactorPm",
  "wereRelated",
] as const;

const T06_MODULES: readonly Record<string, unknown>[] = [
  config,
  check,
  compile,
  cheatsheet,
  sin10k,
  map,
  travel,
  combat,
  spy,
  scoring,
  domination,
  ext,
  errors,
];

describe("the descriptor", () => {
  test("is perfidia-1@1.0.0, published, assembled from the wave-3 modules", () => {
    const any: AnyRuleset = P1;
    expect([any.id, any.version, any.ref, any.status]).toEqual([
      "perfidia-1",
      "1.0.0",
      "perfidia-1@1.0.0",
      "published",
    ]);
    expect(P1.title).toBe("Perfidia V1");
    expect(P1.configSchema.safeParse(P1.defaults).success).toBe(true);
    expect(P1.defaults).toBe(config.PERFIDIA_1_DEFAULTS);
    expect(P1.extSchema).toBe(ext.PerfidiaExtSchema);
    expect(P1.players(P1.defaults)).toEqual({ min: 6, max: 12 });
    const rules = P1.compile(P1.defaults, 8);
    expect(rules).toEqual(compile.compileRules(P1.defaults, 8));
    expect(P1.check?.(P1.defaults, rules)).toEqual(check.checkConfig(P1.defaults, rules));
    expect(P1.cheatSheet(P1.defaults, rules)).toBe(cheatsheet.renderCheatSheet(P1.defaults, rules));
  });

  test("declares its events, intel events and every explained code", () => {
    expect(Object.keys(P1.eventSchemas).toSorted(compareIds)).toEqual([
      "domination_cancelled",
      "domination_started",
      "queues_refunded",
      "siege_broken",
      "siege_started",
    ]);
    expect(P1.intelEvents).toEqual(["siege_started", "siege_broken", "queues_refunded"]);
    for (const e of P1.intelEvents ?? []) expect(Object.hasOwn(P1.eventSchemas, e)).toBe(true);
    expect(P1.errorSamples.map((v) => v.code).toSorted(compareIds)).toEqual(
      Object.keys(P1.errors).toSorted(compareIds),
    );
    for (const v of P1.errorSamples) {
      const explain = P1.errors[v.code];
      expect(explain?.(v, fmt).message.length ?? 0).toBeGreaterThan(0);
    }
    expect(P1.tools).toBeUndefined();
    expect(P1.hooks.actions).toBeUndefined();
  });

  test("handles every scheduled event kind with a class", () => {
    const classes = P1.compile(P1.defaults, 6).eventClasses;
    const own = Object.keys(P1.hooks.on ?? {}).toSorted(compareIds);
    expect(own).toEqual(["domination_end", "domination_open", "siege_end"]);
    const handled = new Set<string>([...DOMAIN_EVENT_KINDS, ...own]);
    expect(Object.keys(classes).toSorted(compareIds)).toEqual([...handled].toSorted(compareIds));
    expect(Object.keys(P1.hooks.arrive).toSorted(compareIds)).toEqual([
      "attack",
      "found",
      "return",
      "shipment",
      "spy",
      "support",
    ]);
  });

  test("keeps every wave-3 export, with the same values", () => {
    const index: Record<string, unknown> = perfidia;
    const wave3 = T06_MODULES.flatMap((m) => Object.keys(m)).toSorted(compareIds);
    expect(wave3).toEqual([...T06_EXPORTS].toSorted(compareIds));
    for (const m of T06_MODULES) {
      for (const [name, value] of Object.entries(m)) expect(index[name]).toBe(value);
    }
    expect(index["perfidia1_1_0_0"]).toBe(P1);
  });
});

function setup(players: number, seed: number): MatchSetup {
  return {
    ruleset: P1.ref,
    overrides: { "time.matchEnd": 86400, "time.dominationStart": 3600 },
    seed,
    idKey: idKeyFromSeed(seed),
    seats: Array.from({ length: players }, (_, i) => ({ id: PlayerIdSchema.parse(`p${i + 1}`) })),
  };
}

function day(players: number, seed: number): { match: Match; hashes: string[] } {
  const match = createMatch(setup(players, seed), P1, testDomain, { invariants: "step" });
  const hashes = [match.hash()];
  for (let t = 21600; t <= 86400; t += 21600) {
    match.advanceTo(t);
    hashes.push(match.hash());
  }
  return { match, hashes };
}

describe("a whole match through the kernel", () => {
  for (const players of [6, 12]) {
    test(`N = ${players}: created, opened for domination, ended on time at matchEnd`, () => {
      const { match } = day(players, 3);
      const x = extOf(match);
      expect(x.domination.open).toBe(true);
      expect(x.domination.countdowns).toEqual([]);
      expect(x.tiebreak.toSorted(compareIds)).toEqual(
        Array.from({ length: players }, (_, i): PlayerId => `p${i + 1}`).toSorted(compareIds),
      );
      expect(match.ended).toBe(true);
      expect(match.result?.reason).toBe("time");
      expect(match.result?.winners).toHaveLength(1);
      expect(match.result?.standings).toHaveLength(players);
      expect(match.result?.endedAt).toBe(86400);
    });
  }

  test("time.recallWindow = 0 rejects a recall even in the launch second (§18); 600 accepts it", () => {
    for (const window of [0, 600]) {
      const w = world({ overrides: { "time.recallWindow": window } });
      city(w, { id: "c1", owner: "p1", island: "i1", units: { raider: 10, transport: 1 } });
      city(w, { id: "c2", owner: "p2", island: "i2" });
      const m = addMovement(w.state, w.rules, {
        kind: "attack",
        owner: "p1",
        from: "c1",
        to: "c2",
        party: "p2",
        units: { raider: 5, transport: 1 },
        arriveAt: w.state.now + 7200,
      });
      const match = matchFromState(w.state, P1, {
        domain,
        overrides: { "time.recallWindow": window },
      });
      const out = match.apply("p1", { type: "recall", movement: m.id });
      if (window === 0) {
        expect(out.ok ? "accepted" : out.violation).toMatchObject({
          code: "NOT_RECALLABLE",
          details: { window: 0, recallableUntil: null },
        });
      } else {
        expect(out.ok).toBe(true);
      }
    }
  });

  test("is deterministic: the same setup gives the same hashes", () => {
    expect(day(7, 5).hashes).toEqual(day(7, 5).hashes);
    expect(day(7, 5).hashes).not.toEqual(day(7, 6).hashes);
  });
});
