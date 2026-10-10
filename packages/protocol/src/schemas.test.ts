// Every exported schema: valid fixtures parse unchanged, and invalid ones fail with an issue whose
// path points at the offending field (docs/architecture.md §15 T02 acceptance).

import { describe, expect, test } from "bun:test";
import {
  actions,
  briefing,
  buildItems,
  city,
  clone,
  compiledRules,
  domainEvent,
  gameState,
  gatewayRules,
  HASH64,
  ID_KEY,
  logLines,
  matchResult,
  movement,
  recruitItems,
  res,
  setup,
  SHA,
  snapshot,
  standardEventData,
  toolArgs,
  toolResultData,
  views,
  withAt,
} from "./fixtures.test.ts";
import * as protocol from "./index.ts";
import { STANDARD_EVENT_DATA, TOOL_ARGS, TOOL_RESULT_DATA, z, type ZodType } from "./index.ts";

type Path = readonly (string | number)[];
interface Invalid {
  readonly value: unknown;
  /** The path of the issue the rejection must report. */
  readonly path: Path;
}
interface Case {
  readonly schema: ZodType;
  readonly valid: readonly unknown[];
  readonly invalid: readonly Invalid[];
}

/** An invalid copy of `base`, changed at `path`, expected to be reported at `path`. */
const bad = (base: unknown, path: Path, next: unknown): Invalid => ({
  value: withAt(base, path, next),
  path,
});
/** An invalid copy of `base` with an unknown key at `path`, reported at the enclosing object. */
const extra = (base: unknown, path: Path): Invalid => ({
  value: withAt(base, [...path, "bogus"], 1),
  path,
});

function issuePaths(schema: ZodType, value: unknown): string[] {
  const parsed = schema.safeParse(value);
  if (parsed.success) return [];
  const paths: string[] = [];
  const visit = (issues: readonly z.core.$ZodIssue[], prefix: Path): void => {
    for (const issue of issues) {
      const full = [...prefix, ...issue.path.map((p) => (typeof p === "symbol" ? String(p) : p))];
      paths.push(JSON.stringify(full));
      if (issue.code === "invalid_union") for (const branch of issue.errors) visit(branch, full);
      if (issue.code === "invalid_key" || issue.code === "invalid_element")
        visit(issue.issues, full);
    }
  };
  visit(parsed.error.issues, []);
  return paths;
}

const p = (t: number, text: string): [number, string] => [t, text];

/** `cancel_queue` → `CancelQueue`. */
const pascal = (snake: string): string =>
  snake
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");

const CASES: Record<string, Case> = {
  // json.ts
  JsonSchema: {
    schema: protocol.JsonSchema,
    valid: [null, true, 3, "x", [1, "a", null], { a: { b: [1, 2] } }],
    invalid: [
      { value: { a: undefined }, path: ["a"] },
      { value: [Number.NaN], path: [0] },
    ],
  },
  JsonObjectSchema: {
    schema: protocol.JsonObjectSchema,
    valid: [{}, { a: 1, b: [true, null] }],
    invalid: [
      { value: [1], path: [] },
      { value: { a: () => 1 }, path: ["a"] },
    ],
  },
  // ids.ts
  GameTimeSchema: {
    schema: protocol.GameTimeSchema,
    valid: [0, 604800],
    invalid: [
      { value: -1, path: [] },
      { value: 1.5, path: [] },
      { value: 2 ** 53, path: [] },
    ],
  },
  TimePairSchema: {
    schema: protocol.TimePairSchema,
    valid: [p(226620, "D3 14:57")],
    invalid: [
      { value: [226620], path: [] },
      { value: ["D3", 1], path: [0] },
    ],
  },
  DurationPairSchema: {
    schema: protocol.DurationPairSchema,
    valid: [p(381480, "4d 9h58m")],
    invalid: [{ value: [-5, "x"], path: [0] }],
  },
  PlayerIdSchema: {
    schema: protocol.PlayerIdSchema,
    valid: ["p1", "p12"],
    invalid: [
      { value: "p0", path: [] },
      { value: "p01", path: [] },
      { value: "p-1", path: [] },
      { value: "c1", path: [] },
      { value: 1, path: [] },
    ],
  },
  IslandIdSchema: {
    schema: protocol.IslandIdSchema,
    valid: ["i1", "i40"],
    invalid: [{ value: "i", path: [] }],
  },
  CityIdSchema: {
    schema: protocol.CityIdSchema,
    valid: ["c1", "c107"],
    invalid: [
      { value: "c1.5", path: [] },
      { value: "C1", path: [] },
    ],
  },
  AllianceIdSchema: {
    schema: protocol.AllianceIdSchema,
    valid: ["a1"],
    invalid: [{ value: "a0", path: [] }],
  },
  MovementIdSchema: {
    schema: protocol.MovementIdSchema,
    valid: ["m0k4qz", "m00000", "mzzzzz"],
    invalid: [
      { value: "m41", path: [] },
      { value: "m0k4qi", path: [] },
      { value: "m0k4qzz", path: [] },
      { value: "M0k4qz", path: [] },
    ],
  },
  ReportIdSchema: {
    schema: protocol.ReportIdSchema,
    valid: ["r2b7kq"],
    invalid: [{ value: "r2b7kl", path: [] }],
  },
  ProposalIdSchema: {
    schema: protocol.ProposalIdSchema,
    valid: ["q1c7hn"],
    invalid: [{ value: "q1c7ho", path: [] }],
  },
  MessageIdSchema: {
    schema: protocol.MessageIdSchema,
    valid: ["g09xr2"],
    invalid: [
      { value: "g09xru", path: [] },
      { value: "m09xr2", path: [] },
    ],
  },
  QueueItemIdSchema: {
    schema: protocol.QueueItemIdSchema,
    valid: [1, 7],
    invalid: [{ value: 0, path: [] }],
  },
  Hash64Schema: {
    schema: protocol.Hash64Schema,
    valid: [HASH64],
    invalid: [
      { value: "CBF29CE484222325", path: [] },
      { value: "cbf29ce48422232", path: [] },
    ],
  },
  Sha256Schema: {
    schema: protocol.Sha256Schema,
    valid: [SHA],
    invalid: [{ value: SHA.slice(1), path: [] }],
  },
  RulesetIdSchema: {
    schema: protocol.RulesetIdSchema,
    valid: ["perfidia-1", "sandbox-1"],
    invalid: [
      { value: "1perfidia", path: [] },
      { value: "Perfidia", path: [] },
    ],
  },
  RulesetRefSchema: {
    schema: protocol.RulesetRefSchema,
    valid: ["perfidia-1@1.0.0", "sandbox-1@10.2.33"],
    invalid: [
      { value: "perfidia-1", path: [] },
      { value: "perfidia-1@1.0", path: [] },
      { value: "perfidia-1@01.0.0", path: [] },
      { value: "Perfidia@1.0.0", path: [] },
    ],
  },
  SemverSchema: {
    schema: protocol.SemverSchema,
    valid: ["0.1.0"],
    invalid: [{ value: "v0.1.0", path: [] }],
  },
  BuildingIdSchema: {
    schema: protocol.BuildingIdSchema,
    valid: ["hall", "town_center"],
    invalid: [
      { value: "Hall", path: [] },
      { value: "hall2", path: [] },
    ],
  },
  UnitIdSchema: {
    schema: protocol.UnitIdSchema,
    valid: ["guard"],
    invalid: [{ value: "", path: [] }],
  },
  QueueIdSchema: {
    schema: protocol.QueueIdSchema,
    valid: ["build", "barracks"],
    invalid: [{ value: "build-1", path: [] }],
  },
  EventTypeSchema: {
    schema: protocol.EventTypeSchema,
    valid: ["queue_empty", "arrive_attack", "siege_end"],
    invalid: [{ value: "QueueEmpty", path: [] }],
  },
  AuthoredNameSchema: {
    schema: protocol.AuthoredNameSchema,
    valid: ["Iron Pact", "north-wind_2.0", "c12"],
    invalid: [
      { value: "", path: [] },
      { value: "Brûlé", path: [] },
      { value: "é", path: [] },
      { value: "bell\u0007", path: [] },
      { value: "two\nlines", path: [] },
      { value: "tab\there", path: [] },
    ],
  },
  // resources.ts
  ResourceIdSchema: {
    schema: protocol.ResourceIdSchema,
    valid: ["wood", "stone", "gold"],
    invalid: [{ value: "iron", path: [] }],
  },
  ResSchema: {
    schema: protocol.ResSchema,
    valid: [res(0, 0, 0), res(1, 2, 3)],
    invalid: [
      bad(res(1, 2, 3), ["gold"], -1),
      bad(res(1, 2, 3), ["stone"], 0.5),
      bad(res(1, 2, 3), ["wood"], undefined),
      extra(res(1, 2, 3), []),
    ],
  },
  UnitCountsSchema: {
    schema: protocol.UnitCountsSchema,
    valid: [{}, { guard: 40, raider: 1 }],
    invalid: [
      { value: { guard: 0 }, path: ["guard"] },
      { value: { guard: 1.5 }, path: ["guard"] },
      { value: { Guard: 1 }, path: ["Guard"] },
    ],
  },
  // events.ts
  MovementKindSchema: {
    schema: protocol.MovementKindSchema,
    valid: ["attack", "return"],
    invalid: [{ value: "raid", path: [] }],
  },
  ScheduledEventSchema: {
    schema: protocol.ScheduledEventSchema,
    valid: gameState.queue,
    invalid: [
      bad(gameState.queue[0], ["at"], -3),
      bad(gameState.queue[0], ["kind"], "Build-Done"),
      bad(gameState.queue[0], ["ref"], null),
    ],
  },
  RoleSchema: {
    schema: protocol.RoleSchema,
    valid: ["party", "self", "target", "stationed", "ally"],
    invalid: [{ value: "public", path: [] }],
  },
  RecipientSchema: {
    schema: protocol.RecipientSchema,
    valid: [{ p: "p3", as: "party" }],
    invalid: [bad({ p: "p3", as: "party" }, ["as"], "enemy")],
  },
  DomainEventSchema: {
    schema: protocol.DomainEventSchema,
    valid: [domainEvent, { t: 0, type: "siege_started", public: true, to: [], data: {} }],
    invalid: [
      bad(domainEvent, ["type"], "Siege Started"),
      bad(domainEvent, ["to", 1, "p"], "p3"),
      bad(domainEvent, ["data"], [1]),
      bad(domainEvent, ["public"], undefined),
      extra(domainEvent, []),
    ],
  },
  StandardEventTypeSchema: {
    schema: protocol.StandardEventTypeSchema,
    valid: ["battle", "match_ended"],
    invalid: [
      { value: "captured", path: [] },
      { value: "siege_started", path: [] },
    ],
  },
  // violations.ts
  DomainErrorCodeSchema: {
    schema: protocol.DomainErrorCodeSchema,
    valid: ["INVALID_ARGS", "INTERNAL"],
    invalid: [{ value: "CITY_BESIEGED", path: [] }],
  },
  ErrorCodeSchema: {
    schema: protocol.ErrorCodeSchema,
    valid: ["CITY_BESIEGED", "WAKE_CLAMPED"],
    invalid: [{ value: "city_besieged", path: [] }],
  },
  ViolationDetailsSchema: {
    schema: protocol.ViolationDetailsSchema,
    valid: [{ city: "c12", need_gold: 1500, have_gold: 1210, availableAt: null, ok: false }],
    invalid: [
      { value: { units: { guard: 1 } }, path: ["units"] },
      { value: { need_gold: 1.5 }, path: ["need_gold"] },
    ],
  },
  ViolationSchema: {
    schema: protocol.ViolationSchema,
    valid: [{ code: "QUEUE_ITEM", details: { city: "c14", item: 12 } }],
    invalid: [
      { value: { code: "QUEUE_ITEM" }, path: ["details"] },
      { value: { code: "", details: {} }, path: ["code"] },
    ],
  },
  // rules.ts
  WakeClassSchema: {
    schema: protocol.WakeClassSchema,
    valid: ["urgent", "own", "social"],
    invalid: [{ value: "safety", path: [] }],
  },
  WakeRoleSchema: {
    schema: protocol.WakeRoleSchema,
    valid: ["public", "party"],
    invalid: [{ value: "everyone", path: [] }],
  },
  GatewayRulesSchema: {
    schema: protocol.GatewayRulesSchema,
    valid: [gatewayRules, { ...gatewayRules, toolCallsPerWake: 30 }],
    invalid: [
      bad(gatewayRules, ["selfWake", "min"], 1.5),
      bad(gatewayRules, ["wake", "message", "target"], "loud"),
      {
        value: withAt(gatewayRules, ["wake", "message", "everyone"], "social"),
        path: ["wake", "message"],
      },
      bad(gatewayRules, ["toolCallsPerWake"], undefined),
      bad(gatewayRules, ["publicOncePerDay", 0], "Domination"),
    ],
  },
  TravelGroupSchema: {
    schema: protocol.TravelGroupSchema,
    valid: [{ kind: "spy", units: {} }],
    invalid: [bad({ kind: "spy", units: {} }, ["kind"], "fly")],
  },
  CitySeedSchema: {
    schema: protocol.CitySeedSchema,
    valid: [compiledRules.newCity],
    invalid: [bad(compiledRules.newCity, ["stock", "wood"], -200)],
  },
  BuildingTableSchema: {
    schema: protocol.BuildingTableSchema,
    valid: compiledRules.buildings,
    invalid: [
      bad(compiledRules.buildings[0], ["time", 1, 0], 1.5),
      bad(compiledRules.buildings[0], ["requires", "hall"], 0),
      bad(compiledRules.buildings[0], ["maxLevel"], 0),
    ],
  },
  UnitTableSchema: {
    schema: protocol.UnitTableSchema,
    valid: compiledRules.units,
    invalid: [
      bad(compiledRules.units[0], ["domain"], "air"),
      bad(compiledRules.units[0], ["cost", "gold"], undefined),
    ],
  },
  CompiledRulesSchema: {
    schema: protocol.CompiledRulesSchema,
    valid: [
      compiledRules,
      withAt(
        withAt(compiledRules, ["queues", "refund", "recruit", "active"], { pm: 500 }),
        ["movement", "shipment"],
        null,
      ),
    ],
    invalid: [
      bad(compiledRules, ["ruleset"], "perfidia-1"),
      bad(compiledRules, ["roles", "producers", "gold"], undefined),
      bad(compiledRules, ["queues", "refund", "build", "queuedPm"], 1001),
      bad(compiledRules, ["queues", "refund", "build", "active"], "all"),
      bad(compiledRules, ["queues", "build", "requiresOn"], "queued"),
      bad(compiledRules, ["eventClasses", "build_done"], -1),
      bad(compiledRules, ["gateway", "groupWindow"], "600"),
      bad(compiledRules, ["travelProbes", 0, "group", "units", "transport"], 0),
      bad(compiledRules, ["settlerCost"], []),
      extra(compiledRules, ["movement", "recall"]),
    ],
  },
  // match.ts
  IdKeySchema: {
    schema: protocol.IdKeySchema,
    valid: [ID_KEY],
    invalid: [
      { value: ID_KEY.slice(1), path: [] },
      { value: ID_KEY.toUpperCase(), path: [] },
    ],
  },
  ConfigPathSchema: {
    schema: protocol.ConfigPathSchema,
    valid: ["time.matchEnd", "homeRadius.6"],
    invalid: [
      { value: "time..matchEnd", path: [] },
      { value: "", path: [] },
    ],
  },
  MatchSetupSchema: {
    schema: protocol.MatchSetupSchema,
    valid: [setup, { ...clone(setup), overrides: {} }],
    invalid: [
      bad(setup, ["idKey"], ID_KEY.slice(0, 31)),
      bad(setup, ["idKey"], `${ID_KEY}0`),
      bad(setup, ["idKey"], ID_KEY.toUpperCase()),
      bad(setup, ["seed"], -1),
      bad(setup, ["seed"], 4294967296),
      bad(setup, ["seats", 1, "id"], "p3"),
      bad(setup, ["seats"], []),
      bad(setup, ["ruleset"], "perfidia-1"),
      { value: withAt(setup, ["overrides", "bad path"], 1), path: ["overrides", "bad path"] },
    ],
  },
  ConfigIssueSchema: {
    schema: protocol.ConfigIssueSchema,
    valid: [{ path: "time.siegeDuration", message: "must exceed movement.recallWindow (600)" }],
    invalid: [{ value: { path: "x", message: "" }, path: ["message"] }],
  },
  StandingSchema: {
    schema: protocol.StandingSchema,
    valid: matchResult.standings,
    invalid: [
      bad(matchResult.standings[0], ["rank"], 0),
      bad(matchResult.standings[0], ["parts", "cityPoints"], 0.5),
    ],
  },
  MatchResultSchema: {
    schema: protocol.MatchResultSchema,
    valid: [matchResult],
    invalid: [bad(matchResult, ["winners", 0], "neutral"), bad(matchResult, ["reason"], "")],
  },
  LockstepClockSpecSchema: {
    schema: protocol.LockstepClockSpecSchema,
    valid: [
      { kind: "lockstep", maxTurnsPerSecond: 3 },
      { kind: "lockstep", maxTurnsPerSecond: 3, roundTimeoutMs: 60000 },
    ],
    invalid: [{ value: { kind: "lockstep", maxTurnsPerSecond: 0 }, path: ["maxTurnsPerSecond"] }],
  },
  RealtimeClockSpecSchema: {
    schema: protocol.RealtimeClockSpecSchema,
    valid: [{ kind: "realtime", speed: [5, 2], time: "system" }],
    invalid: [{ value: { kind: "realtime", speed: [3, 0], time: "virtual" }, path: ["speed", 1] }],
  },
  ClockSpecSchema: {
    schema: protocol.ClockSpecSchema,
    valid: [
      { kind: "lockstep", maxTurnsPerSecond: 3 },
      logLines.header.k === "header" ? logLines.header.clock : null,
    ],
    invalid: [
      { value: { kind: "turbo" }, path: ["kind"] },
      { value: { kind: "realtime", speed: [3, 1], time: "wall" }, path: ["time"] },
    ],
  },
  // state.ts
  PlayerSchema: {
    schema: protocol.PlayerSchema,
    valid: Object.values(gameState.players),
    invalid: [
      bad(gameState.players["p1"], ["alliance"], "a0"),
      { value: { id: "p1", alive: true, alliance: null }, path: ["eliminatedAt"] },
    ],
  },
  IslandSchema: {
    schema: protocol.IslandSchema,
    valid: Object.values(gameState.islands),
    invalid: [bad(gameState.islands["i1"], ["x"], 0.5), bad(gameState.islands["i1"], ["kind"], "")],
  },
  StationedSchema: {
    schema: protocol.StationedSchema,
    valid: city.stationed,
    invalid: [bad(city.stationed[0], ["role"], "siege")],
  },
  BuildItemSchema: {
    schema: protocol.BuildItemSchema,
    valid: city.build,
    invalid: [bad(city.build[0], ["level"], 0), bad(city.build[0], ["cost", "wood"], -1)],
  },
  RecruitBatchSchema: {
    schema: protocol.RecruitBatchSchema,
    valid: city.recruit["barracks"] ?? [],
    invalid: [bad(city.recruit["barracks"]?.[0], ["unitTime"], 0)],
  },
  CitySchema: {
    schema: protocol.CitySchema,
    valid: Object.values(gameState.cities),
    invalid: [
      bad(city, ["name"], "Brûlé"),
      bad(city, ["buildings", "hall"], -1),
      bad(city, ["units", "guard"], 0),
      bad(city, ["recruit", "barracks", 0, "done"], -1),
      bad(city, ["stationed", 0, "units", "guard"], 1.5),
      bad(city, ["tag"], ""),
    ],
  },
  MovementSchema: {
    schema: protocol.MovementSchema,
    valid: [movement, { ...clone(movement), kind: "return", back: { kind: "attack", at: 50300 } }],
    invalid: [
      bad(movement, ["id"], "m41"),
      { value: withAt(movement, ["back"], { kind: "attack" }), path: ["back", "at"] },
      bad(movement, ["slot"], -1),
      bad(movement, ["to"], undefined),
    ],
  },
  ProposalSchema: {
    schema: protocol.ProposalSchema,
    valid: Object.values(gameState.proposals),
    invalid: [bad(gameState.proposals["q1c7hn"], ["kind"], "truce")],
  },
  AllianceSchema: {
    schema: protocol.AllianceSchema,
    valid: Object.values(gameState.alliances),
    invalid: [bad(gameState.alliances["a1"], ["members", 1], "x2")],
  },
  PactSchema: {
    schema: protocol.PactSchema,
    valid: [...gameState.pacts, { a: "p1", b: "p2", since: 0, expiresAt: null, seq: null }],
    invalid: [bad(gameState.pacts[0], ["since"], undefined)],
  },
  LedgerEntrySchema: {
    schema: protocol.LedgerEntrySchema,
    valid: [{ made: { guard: 1 }, gone: {} }],
    invalid: [{ value: { made: {} }, path: ["gone"] }],
  },
  OwnCountersSchema: {
    schema: protocol.OwnCountersSchema,
    valid: [{ m: 0, r: 0, q: 0, g: 0 }],
    invalid: [{ value: { m: 0, r: 0, q: 0 }, path: ["g"] }],
  },
  GameStateSchema: {
    schema: protocol.GameStateSchema,
    valid: [gameState, { ...clone(gameState), status: "ended", result: matchResult }],
    invalid: [
      bad(gameState, ["v"], 2),
      bad(gameState, ["evHash"], "xyz"),
      bad(gameState, ["queue", 0, "cls"], -1),
      bad(gameState, ["cities", "c1", "stock", "wood"], 0.25),
      bad(gameState, ["movements", "m0k4qz", "units", "guard"], -15),
      bad(gameState, ["ids", "own", "p1", "g"], -1),
      bad(gameState, ["ledger", "neutral"], undefined),
      { value: withAt(gameState, ["result"], { endedAt: 0 }), path: ["result", "reason"] },
      {
        value: withAt(gameState, ["players", "x1"], gameState.players["p1"]),
        path: ["players", "x1"],
      },
      extra(gameState, ["cities", "c1"]),
    ],
  },
  // actions.ts
  ...Object.fromEntries(
    protocol.ActionSchema.options.map((schema): [string, Case] => {
      const type = schema.shape.type.value;
      const valid = actions.filter((a) => a.type === type);
      return [`${pascal(type)}ActionSchema`, { schema, valid, invalid: [extra(valid[0], [])] }];
    }),
  ),
  ActionSchema: {
    schema: protocol.ActionSchema,
    valid: [
      ...actions,
      { type: "recall_stationed", at: "c9", home: "c3", units: { guard: 5 } },
      { type: "send_message", to: "all", text: "hi" },
      { type: "leave", with: "p4" },
      { type: "found_city", from: "c3", island: "i7", units: { settler: 1 }, slot: 2 },
    ],
    invalid: [
      { value: { type: "raze", city: "c3" }, path: ["type"] },
      bad(actions[1], ["count"], "max"),
      bad(actions[1], ["count"], 0),
      bad(actions[4], ["units", "raider"], 0),
      bad(actions[11], ["to"], []),
      bad(actions[12], ["name"], "Nörth"),
      bad(actions[15], ["tool"], "Rename"),
    ],
  },
  // views.ts
  RelationViewSchema: {
    schema: protocol.RelationViewSchema,
    valid: views.player.relations,
    invalid: [bad(views.player.relations[0], ["until"], 262800)],
  },
  MovementViewSchema: {
    schema: protocol.MovementViewSchema,
    valid: [...views.cityFull.incoming, ...views.player.private.movements],
    invalid: [
      bad(views.cityFull.incoming[0], ["access"], "partial"),
      bad(views.cityFull.incoming[0], ["arrive"], 226620),
    ],
  },
  StationedViewSchema: {
    schema: protocol.StationedViewSchema,
    valid: views.cityFull.stationed,
    invalid: [bad(views.cityFull.stationed[0], ["home"], "x")],
  },
  IntelSnapshotSchema: {
    schema: protocol.IntelSnapshotSchema,
    valid: [views.cityPublic.intel],
    invalid: [bad(views.cityPublic.intel, ["type"], "rumour")],
  },
  BuildItemViewSchema: {
    schema: protocol.BuildItemViewSchema,
    valid: views.cityFull.build,
    invalid: [bad(views.cityFull.build[0], ["end"], [1])],
  },
  RecruitBatchViewSchema: {
    schema: protocol.RecruitBatchViewSchema,
    valid: views.cityFull.recruit.barracks,
    invalid: [bad(views.cityFull.recruit.barracks[0], ["count"], 0)],
  },
  CityViewFullSchema: {
    schema: protocol.CityViewFullSchema,
    valid: [views.cityFull],
    invalid: [bad(views.cityFull, ["pop", "cap"], undefined), bad(views.cityFull, ["ext"], null)],
  },
  CityViewPublicSchema: {
    schema: protocol.CityViewPublicSchema,
    valid: [views.cityPublic, { ...clone(views.cityPublic), intel: null }],
    invalid: [bad(views.cityPublic, ["intel", "age"], undefined)],
  },
  CityViewSchema: {
    schema: protocol.CityViewSchema,
    valid: [views.cityFull, views.cityPublic],
    invalid: [
      bad(views.cityPublic, ["access"], "partial"),
      bad(views.cityFull, ["stock"], undefined),
    ],
  },
  CityRowSchema: {
    schema: protocol.CityRowSchema,
    valid: views.map.cities,
    invalid: [bad(views.map.cities[0], ["owner"], undefined)],
  },
  IslandViewSchema: {
    schema: protocol.IslandViewSchema,
    valid: [views.island],
    invalid: [bad(views.island, ["travel", 0, "times", 1], 3600)],
  },
  MapIslandSchema: {
    schema: protocol.MapIslandSchema,
    valid: views.map.islands,
    invalid: [bad(views.map.islands[0], ["free"], [1])],
  },
  MapViewSchema: {
    schema: protocol.MapViewSchema,
    valid: [views.map, { islands: [], cities: [] }],
    invalid: [bad(views.map, ["travel", "x7"], [])],
  },
  ProposalViewSchema: {
    schema: protocol.ProposalViewSchema,
    valid: views.player.private.proposals,
    invalid: [bad(views.player.private.proposals[0], ["expires"], undefined)],
  },
  PlayerPrivateViewSchema: {
    schema: protocol.PlayerPrivateViewSchema,
    valid: [views.player.private],
    invalid: [
      bad(views.player.private, ["settler", "k"], -1),
      bad(views.player.private, ["stationed", 0, "role"], "garrison"),
    ],
  },
  PlayerViewSchema: {
    schema: protocol.PlayerViewSchema,
    valid: [views.player, withAt(views.player, ["private"], undefined)],
    invalid: [
      bad(views.player, ["relation"], "enemy"),
      bad(views.player, ["parts", "battlePoints"], 1.5),
    ],
  },
  LeaderboardViewSchema: {
    schema: protocol.LeaderboardViewSchema,
    valid: [views.leaderboard],
    invalid: [bad(views.leaderboard, ["standings", 0, "rank"], 0)],
  },
  ArchiveHitSchema: {
    schema: protocol.ArchiveHitSchema,
    valid: [views.archiveHit],
    invalid: [bad(views.archiveHit, ["summary"], undefined)],
  },
  ArchiveEntrySchema: {
    schema: protocol.ArchiveEntrySchema,
    valid: [views.archiveEntry],
    invalid: [bad(views.archiveEntry, ["to", 0, "as"], "reader")],
  },
  ExtraToolInfoSchema: {
    schema: protocol.ExtraToolInfoSchema,
    valid: views.rules.extraTools,
    invalid: [bad(views.rules.extraTools[0], ["family"], "memory")],
  },
  RulesInfoSchema: {
    schema: protocol.RulesInfoSchema,
    valid: [views.rules],
    invalid: [
      bad(views.rules, ["rules", "gateway"], undefined),
      bad(views.rules, ["rules", "gateway", "wake"], undefined),
      bad(views.rules, ["rulesHash"], "x"),
    ],
  },
  // briefing.ts
  WakeReasonSchema: {
    schema: protocol.WakeReasonSchema,
    valid: ["start", "incoming_attack m0k4qz"],
    invalid: [{ value: "", path: [] }],
  },
  WakeKindSchema: {
    schema: protocol.WakeKindSchema,
    valid: ["self", "safety"],
    invalid: [{ value: "start", path: [] }],
  },
  TurnEndSchema: {
    schema: protocol.TurnEndSchema,
    valid: ["end_turn", "empty_round", "round_cap", "timeout", "error", "match_ended"],
    invalid: [{ value: "crash", path: [] }],
  },
  BriefingLastTurnSchema: {
    schema: protocol.BriefingLastTurnSchema,
    valid: [briefing.lastTurn, { ended: "timeout", unseen: [], nextWake: null }],
    invalid: [bad(briefing.lastTurn, ["unseen", 0, "code"], "oops")],
  },
  BriefingCitySchema: {
    schema: protocol.BriefingCitySchema,
    valid: [
      ...briefing.cities,
      { ...clone(briefing.cities[0]), ext: { siege: { by: "p2", ends: [240000, "D3 18:40"] } } },
    ],
    invalid: [
      bad(briefing.cities[0], ["res"], [1, 2]),
      bad(briefing.cities[0], ["recruit", "barracks", 0, "n"], 0),
    ],
  },
  BriefingIncomingSchema: {
    schema: protocol.BriefingIncomingSchema,
    valid: briefing.incoming,
    invalid: [bad(briefing.incoming[0], ["depart"], undefined)],
  },
  BriefingMoveSchema: {
    schema: protocol.BriefingMoveSchema,
    valid: briefing.moves,
    invalid: [bad(briefing.moves[0], ["id"], "m3")],
  },
  BriefingMessageSchema: {
    schema: protocol.BriefingMessageSchema,
    valid: [...briefing.msgs, { id: "g09xr2", from: "p5", to: "all", text: "x", cut: true }],
    invalid: [bad(briefing.msgs[0], ["cut"], false)],
  },
  BriefingProposalSchema: {
    schema: protocol.BriefingProposalSchema,
    valid: briefing.proposals,
    invalid: [bad(briefing.proposals[0], ["text"], undefined)],
  },
  BriefingEventSchema: {
    schema: protocol.BriefingEventSchema,
    valid: [...briefing.events, ...briefing.news],
    invalid: [{ value: { city: "c9" }, path: ["type"] }],
  },
  BriefingBudgetSchema: {
    schema: protocol.BriefingBudgetSchema,
    valid: [briefing.budget, { ...clone(briefing.budget), callsPerWake: 30, selfWakeAt: null }],
    invalid: [bad(briefing.budget, ["ownWakesLeft"], -1)],
  },
  BriefingMoreSchema: {
    schema: protocol.BriefingMoreSchema,
    valid: [{ count: 3, call: { tool: "view_player", args: { player: "p3" } } }],
    invalid: [{ value: { count: 0, call: { tool: "view_player", args: {} } }, path: ["count"] }],
  },
  BriefingSchema: {
    schema: protocol.BriefingSchema,
    valid: [
      briefing,
      {
        ...clone(briefing),
        lastTurn: null,
        more: {
          msgs: {
            count: 2,
            call: {
              tool: "read_notes",
              args: { search: { scope: "mine", kinds: ["message"], since: 0 } },
            },
          },
        },
      },
    ],
    invalid: [
      bad(briefing, ["left"], 381480),
      bad(briefing, ["incoming", 0, "foe"], "neutral"),
      bad(briefing, ["notes"], undefined),
      bad(briefing, ["ext"], undefined),
      bad(briefing, ["wake", "reasons", 0], ""),
    ],
  },
  // tools.ts
  ToolNameSchema: {
    schema: protocol.ToolNameSchema,
    valid: ["view_city", "end_turn"],
    invalid: [{ value: "search_archives", path: [] }],
  },
  RecruitOrderSchema: {
    schema: protocol.RecruitOrderSchema,
    valid: [{ unit: "guard", count: "max" }],
    invalid: [{ value: { unit: "guard", count: "all" }, path: ["count"] }],
  },
  ...Object.fromEntries(
    protocol.TOOL_NAMES.map((tool): [string, Case] => {
      const valid = toolArgs[tool];
      return [
        `${pascal(tool)}ArgsSchema`,
        { schema: TOOL_ARGS[tool], valid, invalid: [extra(valid[0], [])] },
      ];
    }),
  ),
  ToolCallSchema: {
    schema: protocol.ToolCallSchema,
    valid: [
      { tool: "view_city", args: { city: "c3" } },
      { tool: "nonsense", args: null },
    ],
    invalid: [{ value: { args: {} }, path: ["tool"] }],
  },
  ToolWarningSchema: {
    schema: protocol.ToolWarningSchema,
    valid: [{ code: "WAKE_CLAMPED", message: "Moved to D1 00:10." }],
    invalid: [{ value: { code: "WAKE_CLAMPED" }, path: ["message"] }],
  },
  ToolSuccessSchema: {
    schema: protocol.ToolSuccessSchema,
    valid: [{ ok: true, t: 0, data: {} }],
    invalid: [{ value: { ok: true, data: {} }, path: ["t"] }],
  },
  ToolErrorSchema: {
    schema: protocol.ToolErrorSchema,
    valid: [
      { ok: false, t: 0, code: "UNKNOWN_ID", message: "No city c99.", hint: "See view_map." },
    ],
    invalid: [{ value: { ok: false, t: 0, code: "UNKNOWN_ID", message: "x" }, path: ["hint"] }],
  },
  ToolResultSchema: {
    schema: protocol.ToolResultSchema,
    valid: [
      // The error example of docs/architecture.md §7.3, verbatim.
      {
        ok: false,
        t: 223320,
        code: "INSUFFICIENT_RESOURCES",
        message: "c12 needs 1500 gold for settler (k = 2), has 1210.",
        hint: "At +310 gold/h it is affordable at D3 14:58:08 (in 56m8s).",
        details: { city: "c12", need_gold: 1500, have_gold: 1210, availableAt: 226688 },
      },
      {
        ok: true,
        t: 0,
        data: { wakeAt: [600, "D1 00:10"], clamped: true },
        warnings: [{ code: "WAKE_CLAMPED", message: "Moved to D1 00:10." }],
      },
    ],
    invalid: [
      { value: { ok: "yes", t: 0 }, path: ["ok"] },
      {
        value: { ok: false, t: 0, code: "X", message: "m", hint: "h", details: { a: [1] } },
        path: ["details", "a"],
      },
      { value: { ok: true, t: 0, data: [] }, path: ["data"] },
    ],
  },
  BatchItemErrorSchema: {
    schema: protocol.BatchItemErrorSchema,
    valid: [{ ok: false, code: "QUEUE_FULL", message: "m", hint: "h" }],
    invalid: [{ value: { ok: false, code: "QUEUE_FULL", message: "m" }, path: ["hint"] }],
  },
  BuildItemResultSchema: {
    schema: protocol.BuildItemResultSchema,
    valid: buildItems,
    invalid: [bad(buildItems[0], ["end"], 7200), bad(buildItems[1], ["hint"], undefined)],
  },
  RecruitItemResultSchema: {
    schema: protocol.RecruitItemResultSchema,
    valid: recruitItems,
    invalid: [bad(recruitItems[0], ["count"], "max")],
  },
  // log.ts
  HeaderLineSchema: {
    schema: protocol.HeaderLineSchema,
    valid: [logLines.header, withAt(logLines.header, ["wallStart"], undefined)],
    invalid: [
      bad(logLines.header, ["format"], "perfidia-log/2"),
      bad(logLines.header, ["setup", "idKey"], "secret"),
    ],
  },
  WakeLineSchema: {
    schema: protocol.WakeLineSchema,
    valid: [logLines.wake],
    invalid: [bad(logLines.wake, ["charge"], "urgent"), bad(logLines.wake, ["reasons"], [])],
  },
  BatchLineSchema: {
    schema: protocol.BatchLineSchema,
    valid: [logLines.batch],
    invalid: [bad(logLines.batch, ["order", 0], "x")],
  },
  ActResultSchema: {
    schema: protocol.ActResultSchema,
    valid: [{ ok: true }, { ok: false, code: "REQUIREMENT_MISSING" }],
    invalid: [{ value: { ok: false }, path: ["code"] }],
  },
  ActLineSchema: {
    schema: protocol.ActLineSchema,
    valid: [logLines.act],
    invalid: [
      bad(logLines.act, ["n"], 0),
      bad(logLines.act, ["a", "type"], "teleport"),
      bad(logLines.act, ["r", "ok"], undefined),
    ],
  },
  GwLineSchema: {
    schema: protocol.GwLineSchema,
    valid: [
      logLines.gw,
      { ...clone(logLines.gw), r: { ok: false, code: "INTERNAL" }, error: "boom" },
    ],
    invalid: [bad(logLines.gw, ["r", "ok"], true)],
  },
  ObsLineSchema: {
    schema: protocol.ObsLineSchema,
    valid: [logLines.obs],
    invalid: [bad(logLines.obs, ["bytes"], -1)],
  },
  NoteLineSchema: {
    schema: protocol.NoteLineSchema,
    valid: [logLines.note],
    invalid: [bad(logLines.note, ["mode"], "prepend")],
  },
  TurnLineSchema: {
    schema: protocol.TurnLineSchema,
    valid: [
      logLines.turn,
      { ...clone(logLines.turn), why: "error", selfAt: null, next: null, error: "agent threw" },
    ],
    invalid: [bad(logLines.turn, ["why"], "bored"), bad(logLines.turn, ["next", "kind"], "start")],
  },
  DeferLineSchema: {
    schema: protocol.DeferLineSchema,
    valid: [logLines.defer],
    invalid: [bad(logLines.defer, ["to"], undefined)],
  },
  ControllerLineSchema: {
    schema: protocol.ControllerLineSchema,
    valid: [logLines.controller],
    invalid: [bad(logLines.controller, ["label"], "")],
  },
  EvLineSchema: {
    schema: protocol.EvLineSchema,
    valid: [logLines.ev],
    invalid: [bad(logLines.ev, ["e", "to", 0, "as"], "boss")],
  },
  CkptLineSchema: {
    schema: protocol.CkptLineSchema,
    valid: [logLines.ckpt],
    invalid: [bad(logLines.ckpt, ["hour"], 0)],
  },
  EndLineSchema: {
    schema: protocol.EndLineSchema,
    valid: [logLines.end],
    invalid: [bad(logLines.end, ["result", "standings", 0, "alive"], "yes")],
  },
  FatalLineSchema: {
    schema: protocol.FatalLineSchema,
    valid: [logLines.fatal, withAt(logLines.fatal, ["error", "details"], undefined)],
    invalid: [bad(logLines.fatal, ["error", "kind"], "panic")],
  },
  LogLineSchema: {
    schema: protocol.LogLineSchema,
    valid: Object.values(logLines),
    invalid: [
      { value: { k: "chat", t: 0 }, path: ["k"] },
      bad(logLines.act, ["seat"], "p0"),
      extra(logLines.ckpt, []),
    ],
  },
  SnapshotSchema: {
    schema: protocol.SnapshotSchema,
    valid: [snapshot],
    invalid: [
      bad(snapshot, ["format"], "perfidia-snapshot/0"),
      bad(snapshot, ["state", "cities", "c1", "owner"], "nobody"),
      bad(snapshot, ["afterN"], -1),
    ],
  },
};

describe("every schema accepts its valid fixtures and rejects invalid ones with a useful path", () => {
  for (const [name, c] of Object.entries(CASES)) {
    test(name, () => {
      expect(c.valid.length).toBeGreaterThan(0);
      expect(c.invalid.length).toBeGreaterThan(0);
      for (const value of c.valid) {
        const parsed = c.schema.safeParse(value);
        if (!parsed.success)
          throw new Error(`${name} rejected ${JSON.stringify(value)}: ${parsed.error.message}`);
        expect(parsed.data).toEqual(value);
      }
      for (const { value, path } of c.invalid) {
        const paths = issuePaths(c.schema, value);
        if (!paths.includes(JSON.stringify(path))) {
          throw new Error(
            `${name}: expected an issue at ${JSON.stringify(path)} for ${JSON.stringify(value)}, got ${JSON.stringify(paths)}`,
          );
        }
      }
    });
  }
});

describe("standard event data", () => {
  for (const type of protocol.STANDARD_EVENT_TYPES) {
    test(type, () => {
      const schema: ZodType = STANDARD_EVENT_DATA[type];
      const data = standardEventData[type];
      expect(schema.safeParse(data).success).toBe(true);
      expect(protocol.DomainEventSchema.safeParse({ ...domainEvent, type, data }).success).toBe(
        true,
      );
      // Dropping any required field is reported at that field.
      const required = Object.keys(data).filter(
        (key) => !schema.safeParse(withAt(data, [key], undefined)).success,
      );
      expect(required.length).toBeGreaterThan(0);
      for (const key of required) {
        expect(issuePaths(schema, withAt(data, [key], undefined))).toContain(JSON.stringify([key]));
      }
    });
  }
});

describe("tool result data", () => {
  for (const tool of protocol.TOOL_NAMES) {
    test(tool, () => {
      const schema: ZodType = TOOL_RESULT_DATA[tool];
      expect(schema.safeParse(toolResultData[tool]).success).toBe(true);
      expect(
        protocol.ToolSuccessSchema.safeParse({ ok: true, t: 5, data: toolResultData[tool] })
          .success,
      ).toBe(true);
      expect(schema.safeParse("not an object").success).toBe(false);
    });
  }
});

test("every exported schema has fixtures, under its own name", () => {
  const exported = Object.entries(protocol).filter(([key]) => key.endsWith("Schema"));
  expect(exported.map(([key]) => key).filter((key) => !(key in CASES))).toEqual([]);
  for (const [key, schema] of exported) expect(CASES[key]?.schema === schema).toBe(true);
  expect(Object.keys(CASES).filter((key) => !exported.some(([name]) => name === key))).toEqual([]);
});

test("parsing never strips or rewrites a valid fixture", () => {
  for (const line of Object.values(logLines)) {
    expect(protocol.LogLineSchema.parse(clone(line))).toEqual(line);
  }
  expect(protocol.GameStateSchema.parse(clone(gameState))).toEqual(gameState);
});
