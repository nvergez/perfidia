import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { fmt } from "@perfidia/engine/core";
import type { Match } from "@perfidia/engine/kernel";
import * as p1 from "@perfidia/engine/rulesets/perfidia-1";
import {
  addAlliance,
  addBuildItem,
  addCity,
  addStationed,
  buildState,
  matchFromState,
} from "@perfidia/engine/testing";
import {
  createGatewayState,
  createWakeScheduler,
  deliver,
  type GatewayState,
} from "@perfidia/gateway/seat";
import {
  DOMAIN_ERROR_CODES,
  GATEWAY_WARNING_CODES,
  ToolErrorSchema,
  ToolWarningSchema,
  ViolationSchema,
  type Violation,
} from "@perfidia/protocol";
import { EXPLAINED_CODES, explain, toolError, toolWarning, type ExplainEnv } from "./index.ts";
import { P1, P2, event, perfidiaRuleset } from "./testkit.test.ts";

// The wording of §7.3: one snapshot per domain code and gateway warning, with numbers and times,
// on a hand-built perfidia-1 state at t = 223320 (D3 14:02) where p1 owns c12 and c13.

const T = 223320;

function setup(): { match: Match; gw: GatewayState } {
  const rules = p1.compileRules(p1.PERFIDIA_1_DEFAULTS, 6);
  const players = ["p1", "p2", "p3", "p4", "p5", "p6"] as const;
  const state = buildState({
    rules,
    players: 6,
    now: T,
    islands: [
      { richnessPm: 886, slots: 4 },
      { richnessPm: 1000, slots: 2 },
    ],
    ext: p1.initialExt([...players], [...players]),
  });
  // Mine 6 at richness 886 makes +310 gold/h (§7.3); warehouse 3 holds 2040; hall 5 allows 190.
  const c12 = addCity(state, rules, {
    owner: P1,
    id: "c12",
    island: "i1",
    capital: true,
    stock: { wood: 900, stone: 700, gold: 1210 },
    units: { guard: 40, raider: 10 },
    buildings: { hall: 5, lumber: 4, quarry: 4, mine: 6, warehouse: 3, barracks: 1 },
  });
  addCity(state, rules, {
    owner: P1,
    id: "c13",
    island: "i1",
    units: { guard: 5 },
    buildings: { hall: 1, warehouse: 1 },
  });
  addCity(state, rules, { owner: P2, id: "c20", island: "i2", buildings: { hall: 1 } });
  c12.itemSeq = 12;
  addBuildItem(state, rules, "c12", "hall", { end: T + 3000 });
  addBuildItem(state, rules, "c12", "barracks");
  addStationed(state, "c20", { owner: P1, home: "c12", role: "support", units: { guard: 10 } });
  addStationed(state, "c20", { owner: P1, home: "c13", role: "support", units: { guard: 5 } });
  addAlliance(state, "North", [P1, P2]);
  const match = matchFromState(state, perfidiaRuleset);
  const gw = createGatewayState([...players]);
  const wake = createWakeScheduler(gw, p1.compileRules(p1.PERFIDIA_1_DEFAULTS, 6).gateway);
  deliver(
    gw,
    [
      event(223310, "build_done", [[P1, "self"]], {
        city: "c12",
        item: 12,
        building: "mine",
        level: 6,
      }),
    ],
    wake,
  );
  return { match, gw };
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function envOf(): ExplainEnv {
  const { match, gw } = setup();
  return { r: match.read(), seat: P1, gw };
}

type Case = readonly [code: string, details: Violation["details"], message: string, hint: string];

/** When c12's queued barracks (item #14, level 2) completes, as the domain's `availableAt`. */
const BARRACKS_2 = 228986;

/**
 * One snapshot (at least) per domain code and gateway warning, on the detail shapes their emitters
 * use: `std` (departure rules, `insufficientResources`), the default domain handlers (economy,
 * military, recall and diplomacy validation, as on branch p1/T10), and the gateway (seat caps, the
 * argument parser). A case marked "legacy" pins a shape no emitter uses today, kept readable.
 */
const CASES: readonly Case[] = [
  // INVALID_ARGS: the argument parser (gateway), the domain, and std's found rule.
  [
    "INVALID_ARGS",
    { field: "slot", ruleset: "perfidia-1@1.0.0" },
    "perfidia-1@1.0.0 does not accept slot: it always founds a city in the lowest free slot.",
    "Remove slot and send the call again.",
  ],
  [
    "INVALID_ARGS",
    { field: "until", ruleset: "perfidia-1@1.0.0" },
    "perfidia-1@1.0.0 does not accept until: it gives every pact its fixed duration.",
    "Remove until and send the call again.",
  ],
  [
    "INVALID_ARGS",
    { field: "name", kind: "pact" },
    "name is only for an alliance proposal; this is a pact proposal.",
    "Remove name, or propose an alliance.",
  ],
  [
    "INVALID_ARGS",
    { field: "until", kind: "alliance" },
    "until is only for a pact proposal; this is an alliance proposal.",
    "Remove until, or propose a pact.",
  ],
  [
    "INVALID_ARGS",
    { field: "until", until: 220000, now: T },
    "The pact end D3 13:06:40 is not in the future: it is D3 14:02.",
    "Give a later until, or none for the ruleset's pact duration; a proposal whose until has passed can only be refused.",
  ],
  [
    "INVALID_ARGS",
    { building: "castle", reason: "unknown_building" },
    '"castle" is not a building of perfidia-1@1.0.0.',
    "Buildings: hall, lumber, quarry, mine, warehouse, barracks, harbor, wall.",
  ],
  [
    "INVALID_ARGS",
    { unit: "dragon", reason: "unknown_unit" },
    '"dragon" is not a unit of perfidia-1@1.0.0.',
    "Units: guard, raider, settler, transport, warship.",
  ],
  [
    "INVALID_ARGS",
    { island: "i2", slot: 5, slots: 2 },
    "i2 has no slot 5: its slots are 0 to 1.",
    "Leave out slot, or pick a free one (view_island i2 lists them).",
  ],
  [
    "INVALID_ARGS",
    { load: 0 },
    "A shipment must carry at least 1 resource.",
    "Give cargo with at least one of wood, stone or gold above 0.",
  ],
  [
    "INVALID_ARGS",
    { path: "orders.0.count", issue: 'expected a whole number above 0 or "max"' },
    'Invalid argument orders.0.count: expected a whole number above 0 or "max".',
    "Check the call against the tool's description.",
  ],
  ["UNKNOWN_ID", { city: "c99" }, "No city c99 is known to you.", "view_map lists every city."],
  [
    "UNKNOWN_ID",
    { movement: "m0k4qz" },
    "No movement m0k4qz is known to you.",
    "view_player on yourself lists your movements; view_city shows those you can see.",
  ],
  ["NOT_OWNER", { city: "c20", owner: "p2" }, "c20 is not your city.", "Your cities: c12, c13."],
  [
    "TURN_OVER",
    {},
    "Your turn is over: this call was not run.",
    "Calls placed after end_turn in the same round trip are not run; send them at your next wake.",
  ],
  [
    "ROUND_TRIP_CAP",
    { cap: 8, round: 9 },
    "A wake has at most 8 round trips; this call came in round trip 9.",
    "End the turn with end_turn; the next wake brings a new set of round trips.",
  ],
  [
    "CALLS_CAP",
    { scope: "round", cap: 10, used: 10 },
    "Only the first 10 calls of a round trip run; this was call 11.",
    "Send at most 10 calls per round trip; send this one again in the next round.",
  ],
  [
    "DAILY_CAP",
    { kind: "attacks", cap: 20, used: 20, availableAt: 259200 },
    "20 of 20 attack launches already used on D3: the limit is 20 per game day.",
    "The count restarts at D4 00:00 (in 9h58m); use this turn for other orders.",
  ],
  [
    "MATCH_ENDED",
    { matchEnd: 604800 },
    "The match is over: it ended at D8 00:00.",
    "No action is accepted any more.",
  ],
  [
    "ELIMINATED",
    { player: "p1", eliminatedAt: 200000 },
    "You were eliminated at D3 07:33:20: you can no longer act.",
    "Nothing you send changes the game any more.",
  ],
  [
    "NOTE_TOO_LONG",
    { chars: 4340, max: 4000, over: 340, notes: 3900, mode: "append" },
    "note would be 4,340 chars, limit 4,000: remove 340 or use mode=replace",
    "The notebook holds 3,900 chars. Shorten this text by 340 chars, or rewrite the whole notebook with mode=replace.",
  ],
  // std's insufficientResources, with the domain's `what` (unit, count, k).
  [
    "INSUFFICIENT_RESOURCES",
    {
      unit: "settler",
      count: 1,
      k: 2,
      city: "c12",
      need_gold: 1500,
      have_gold: 1210,
      rate_gold: 310,
      availableAt: 226688,
    },
    "c12 needs 1500 gold for settler (k = 2), has 1210.",
    "At +310 gold/h it is affordable at D3 14:58:08 (in 56m8s).",
  ],
  [
    "INSUFFICIENT_RESOURCES",
    { city: "c12", need_wood: 1200, need_gold: 1500, building: "harbor", level: 4 },
    "c12 needs 1200 wood and 1500 gold for harbor level 4, has 900 wood and 1210 gold.",
    "At +186 wood/h and +310 gold/h it is affordable at D3 15:38:47 (in 1h36m47s).",
  ],
  [
    "INSUFFICIENT_RESOURCES",
    { city: "c12", need_gold: 2500, have_gold: 1210, rate_gold: 310, availableAt: null },
    "c12 needs 2500 gold, has 1210.",
    "c12 stores at most 2040 of each resource: raise warehouse first.",
  ],
  [
    "EXCEEDS_STORAGE",
    {
      unit: "settler",
      count: 1,
      k: 6,
      city: "c12",
      storage: "warehouse",
      storageLevel: 3,
      cap: 2040,
      requiredLevel: 6,
      need_gold: 4500,
    },
    "c12 stores at most 2040 of each resource (warehouse 3), and settler (k = 6) costs 4500 gold.",
    "Raise warehouse to level 6 (it holds 4500).",
  ],
  [
    "EXCEEDS_STORAGE",
    {
      building: "wall",
      city: "c12",
      storage: "warehouse",
      storageLevel: 3,
      cap: 2040,
      requiredLevel: null,
      need_stone: 99000,
    },
    "c12 stores at most 2040 of each resource (warehouse 3), and wall costs 99000 stone.",
    "No warehouse level holds 99000.",
  ],
  [
    "INSUFFICIENT_POPULATION",
    {
      city: "c12",
      unit: "transport",
      count: 70,
      need: 140,
      used: 60,
      cap: 190,
      availableAt: null,
    },
    "c12 has 130 free population (60 of 190 used); 70 transport would use 140.",
    "Raise hall (level 6 allows 232), or recruit fewer: every unit homed in the city counts, wherever it is.",
  ],
  [
    "INSUFFICIENT_POPULATION",
    { city: "c12", unit: "guard", count: 140, need: 140, used: 60, cap: 190, availableAt: 226320 },
    "c12 has 130 free population (60 of 190 used); 140 guard would use 140.",
    "Raise hall (level 6 allows 232), or recruit fewer: every unit homed in the city counts, wherever it is. Your queued hall levels make room at D3 14:52 (in 50m).",
  ],
  [
    "REQUIREMENT_MISSING",
    {
      unit: "settler",
      count: 1,
      city: "c12",
      requires: "barracks",
      need: 2,
      have: 1,
      on: "completed",
      availableAt: BARRACKS_2,
    },
    "settler needs barracks 2 (now 1) in c12.",
    "Build barracks first: only completed levels count. barracks 2 completes at D3 15:36:26 (in 1h34m26s).",
  ],
  [
    "REQUIREMENT_MISSING",
    {
      unit: "settler",
      count: 1,
      city: "c12",
      requires: "barracks",
      need: 2,
      have: 1,
      on: "completed",
      availableAt: null,
    },
    "settler needs barracks 2 (now 1) in c12.",
    "Build barracks first: only completed levels count.",
  ],
  [
    "REQUIREMENT_MISSING",
    {
      building: "barracks",
      city: "c13",
      requires: "hall",
      need: 2,
      have: 1,
      on: "projected",
      availableAt: null,
    },
    "barracks needs hall 2 (now 1) in c13.",
    "Queue hall first: queued levels count for building requirements.",
  ],
  [
    "MAX_LEVEL",
    { city: "c12", building: "mine", level: 10, target: 11, maxLevel: 10 },
    "mine is at its maximum level 10 in c12, queued levels included.",
    "Build or queue something else.",
  ],
  [
    "QUEUE_FULL",
    { city: "c12", queue: "build", max: 5, availableAt: 226320 },
    "c12's build queue is full (5 items).",
    "Its first item (#13) ends at D3 14:52 (in 50m); queue more after that.",
  ],
  [
    "QUEUE_FULL",
    { city: "c12", queue: "barracks", max: 2, availableAt: 230000 },
    "c12's barracks queue is full (2 items).",
    "Its first item ends at D3 15:53:20 (in 1h51m20s); queue more after that.",
  ],
  [
    "QUEUE_ITEM",
    { city: "c12", item: 12, issued: true },
    "#12 of c12 completed at D3 14:01:50.",
    "A completed item cannot be cancelled; queued in c12: #13, #14.",
  ],
  [
    "QUEUE_ITEM",
    { city: "c12", item: 11, issued: true },
    "c12 has no item #11; queued: #13, #14.",
    "cancel_queue {city, item} removes a queued item and every later item of its queue.",
  ],
  [
    "QUEUE_ITEM",
    { city: "c12", item: 40, issued: false },
    "c12 has no item #40 (it was never queued); queued: #13, #14.",
    "cancel_queue {city, item} removes a queued item and every later item of its queue.",
  ],
  [
    "BATCH_LIMIT",
    { city: "c12", unit: "settler", requested: 2, max: 1 },
    "At most 1 settler per order, and 2 were ordered.",
    "Split it into orders of 1 or fewer (a recruit call takes up to 5 orders).",
  ],
  // Units at home (send, attack, …): std's unitShortage shape.
  [
    "INSUFFICIENT_UNITS",
    { city: "c12", unit: "raider", requested: 60, home: 10, backAt: 226620 },
    "c12: 60 raider requested, 10 at home.",
    "More raider units come home at D3 14:57 (in 55m); until then, send at most 10.",
  ],
  // A partial recall of a stationed group.
  [
    "INSUFFICIENT_UNITS",
    { city: "c20", from: "c12", unit: "guard", requested: 12, stationed: 10 },
    "c20: 12 guard requested, 10 in your group from c12.",
    "Recall at most 10 guard from it, or leave out units to recall the whole group.",
  ],
  // Legacy: no numbers given.
  [
    "INSUFFICIENT_UNITS",
    { city: "c13" },
    "c13 does not have these units at home.",
    "c13 has guard 5 at home.",
  ],
  [
    "NO_UNITS",
    { kind: "attack", crossing: true },
    "This attack has no unit that can fight across water.",
    "Send a land unit with attack above 0 or, across water, a naval unit with naval strength above 0.",
  ],
  [
    "NO_UNITS",
    { city: "c12", kind: "attack" },
    "No units were given for this attack.",
    "List at least one unit you have at home.",
  ],
  [
    "TRANSPORT_CAPACITY",
    { city: "c12", island: "i2", pop: 40, capacity: 20, missing: 20 },
    "The land units need 40 carrier capacity to cross water; the group carries 20: 20 short.",
    "Add carriers (transport, 20 each) or send fewer land units.",
  ],
  [
    "SHIPMENT_CAPACITY",
    { city: "c12", cap: 500, inFlight: 300, requested: 400, availableAt: 226620 },
    "c12 can have 500 resources in flight; 300 already are, and 400 were requested.",
    "Send at most 200 now, or raise harbor (+500 per level); cargo counts until it arrives. There is room for it at D3 14:57 (in 55m).",
  ],
  [
    "ATTACK_PROTECTION",
    { city: "c12", availableAt: 43200 },
    "No attack can be launched before D1 12:00.",
    "Attacks open at D1 12:00.",
  ],
  [
    "INVALID_TARGET",
    { city: "c12", kind: "attack" },
    "c12 is not a valid attack target.",
    "Attacks and spies go to a city you do not own.",
  ],
  [
    "INVALID_TARGET",
    { player: "p1", reason: "self" },
    "p1 is you: name another player.",
    "Messages, proposals and leave_alliance {with} name another player.",
  ],
  [
    "INVALID_TARGET",
    { player: "p3", reason: "eliminated" },
    "p3 was eliminated: it receives no messages or proposals any more.",
    "Name a player still in the game; leaderboard shows who is alive.",
  ],
  [
    "INVALID_TARGET",
    { proposal: "q1c7hn", reason: "own_proposal" },
    "q1c7hn is your own proposal: only the player it is addressed to can answer it.",
    "Wait for the answer, or let it expire.",
  ],
  [
    "INVALID_TARGET",
    { player: "p1", city: "c12" },
    "p1 is you: dismissing sends another player's units in c12 home.",
    "Name the player whose support you want to send home; your own units in your city are already home.",
  ],
  [
    "NO_FREE_SLOT",
    { island: "i2" },
    "i2 has no free slot.",
    "view_map gives the number of free slots of every island.",
  ],
  [
    "SETTLER_REQUIRED",
    { unit: "settler" },
    "Founding a city needs at least one settler in the group.",
    "Add a settler; recruit one first if you have none.",
  ],
  [
    "SPY_GOLD",
    { min: 100, gold: 40 },
    "A spy needs at least 100 gold; 40 given.",
    "Send 100 gold or more.",
  ],
  [
    "NOT_RECALLABLE",
    {
      movement: "m0k4qz",
      kind: "attack",
      window: 600,
      departAt: 222000,
      recallableUntil: 222600,
    },
    "m0k4qz cannot be recalled: its recall window closed at D3 13:50.",
    "Only attack, support and found movements can be recalled, within 10m of departure.",
  ],
  [
    "NOT_RECALLABLE",
    { movement: "m0k4qz", kind: "return", window: 600, departAt: 223000, recallableUntil: null },
    "m0k4qz cannot be recalled: it is a return.",
    "Only attack, support and found movements can be recalled, within 10m of departure.",
  ],
  [
    "NOT_RECALLABLE",
    { city: "c20", stationed: "none" },
    "Units stationed away cannot be recalled in perfidia-1@1.0.0.",
    "Your units in c20 stay there until the game sends them home.",
  ],
  [
    "NOT_RECALLABLE",
    { city: "c20", stationed: "whole", reason: "whole_only" },
    "perfidia-1@1.0.0 recalls a stationed group whole only: a unit list for c20 is refused.",
    "Leave out units to recall the whole group (name home to pick one group).",
  ],
  [
    "NOT_RECALLABLE",
    { city: "c12", player: "p2", dismiss: false },
    "perfidia-1@1.0.0 does not let a city's owner dismiss the units stationed in it.",
    "p2 can recall them; send a message to ask.",
  ],
  [
    "NOTHING_STATIONED",
    { city: "c20", home: "c14" },
    "You have no units stationed in c20 from c14.",
    "view_player on yourself lists your stationed groups.",
  ],
  [
    "NOTHING_STATIONED",
    { city: "c20", home: null },
    "You have no units stationed in c20.",
    "view_player on yourself lists your stationed groups.",
  ],
  [
    "NOTHING_STATIONED",
    { city: "c12", player: "p2" },
    "p2 has no support stationed in c12.",
    "view_city c12 lists the groups stationed there.",
  ],
  [
    "AMBIGUOUS_GROUP",
    { city: "c20", groups: 2, homes: "c12,c13" },
    "You have 2 groups in c20: from c12 (guard 10) and from c13 (guard 5).",
    "Add home (c12 or c13) to recall part of one group, or leave out units to recall them all.",
  ],
  [
    "TEXT_TOO_LONG",
    { field: "text", max: 1000, length: 1200 },
    "The text has 1200 characters; the limit is 1000.",
    "Shorten it by 200 characters.",
  ],
  [
    "TEXT_TOO_LONG",
    { field: "name", max: 30, length: 41 },
    "The name has 41 characters; the limit is 30.",
    "Shorten it by 11 characters.",
  ],
  [
    "PROPOSAL_LIMIT",
    { max: 3, open: 3, availableAt: 230000 },
    "You already have 3 open proposals; the limit is 3.",
    "Wait until one is answered or expires (proposals last 12h). The first one expires at D3 15:53:20 (in 1h51m20s).",
  ],
  [
    "PROPOSAL_LIMIT",
    { player: "p4", kind: "pact", proposal: "q1c7hn", reason: "duplicate", availableAt: 262800 },
    "You already have an open pact proposal to p4 (q1c7hn).",
    "Wait for its answer or its expiry before proposing again. It expires at D4 01:00 (in 10h58m).",
  ],
  [
    "PROPOSAL_NOT_FOUND",
    { proposal: "q1c7hn" },
    "No open proposal q1c7hn is addressed to you.",
    "It may have been answered or have expired; your briefing lists your open proposals.",
  ],
  [
    "ALREADY_ALLIED",
    { player: "p2", kind: "pact" },
    "You and p2 are already allies.",
    "Allies already share vision; a pact cannot be proposed to an ally.",
  ],
  [
    "ALREADY_ALLIED",
    { player: "p3", kind: "alliance", reason: "both_allied", alliance: "a2", yours: "a1" },
    "You and p3 are both in alliances (a1 and a2).",
    "One of you must leave_alliance before you can ally.",
  ],
  [
    "ALLIANCE_FULL",
    { alliance: "a1", max: 2, members: 2 },
    "a1 is full: 2 members at most.",
    "A member must leave before anyone else can join.",
  ],
  [
    "ALLIANCE_FULL",
    { alliance: null, max: 1, members: 0 },
    "Alliances hold at most 1 member in perfidia-1@1.0.0: none can be formed.",
    "Propose a pact instead.",
  ],
  [
    "NOT_IN_ALLIANCE",
    { player: "p1" },
    "You are not in an alliance.",
    "To end a pact, name the partner: leave_alliance {with: player}.",
  ],
  [
    "PACT_LIMIT",
    { player: "p3", max: 2, pacts: 2, availableAt: 250000 },
    "p3 already holds 2 pacts; the limit is 2.",
    "A pact must end or expire first; renewing an existing pact does not count. The first of their pacts expires at D3 21:26:40 (in 7h24m40s).",
  ],
  [
    "PACT_LIMIT",
    { player: "p1", max: 2, pacts: 2, availableAt: null },
    "You already hold 2 pacts; the limit is 2.",
    "A pact must end or expire first; renewing an existing pact does not count. None of your pacts expires on its own.",
  ],
  [
    "PACT_NOT_FOUND",
    { player: "p4" },
    "You have no pact with p4.",
    "leaderboard lists every pact.",
  ],
  [
    "INTERNAL",
    {},
    "The gateway failed on this call; nothing was applied.",
    "Send the call again; if it fails again, do something else.",
  ],
  [
    "WAKE_CLAMPED",
    { requested: 223500, at: 223920 },
    "The wake at D3 14:05 is outside the self-wake range; it is set to D3 14:12.",
    "A self-wake is 10m to 12h ahead of the end_turn call.",
  ],
  // The shapes of the domain's review round (p1/T10 65c548e): a `reason` on every INVALID_ARGS,
  // INVALID_TARGET and PROPOSAL_LIMIT, the rejected `action`, §7.3's `home` with `where` for a
  // stationed group, and `availableAt` on EXCEEDS_STORAGE.
  [
    "INVALID_ARGS",
    { field: "slot", ruleset: "perfidia-1@1.0.0", reason: "unsupported" },
    "perfidia-1@1.0.0 does not accept slot: it always founds a city in the lowest free slot.",
    "Remove slot and send the call again.",
  ],
  [
    "INVALID_ARGS",
    { field: "name", kind: "pact", reason: "wrong_kind" },
    "name is only for an alliance proposal; this is a pact proposal.",
    "Remove name, or propose an alliance.",
  ],
  [
    "INVALID_ARGS",
    { field: "until", until: 220000, now: T, reason: "past" },
    "The pact end D3 13:06:40 is not in the future: it is D3 14:02.",
    "Give a later until, or none for the ruleset's pact duration; a proposal whose until has passed can only be refused.",
  ],
  [
    "INSUFFICIENT_UNITS",
    { city: "c20", from: "c12", unit: "guard", requested: 12, home: 10, where: "stationed" },
    "c20: 12 guard requested, 10 in your group from c12.",
    "Recall at most 10 guard from it, or leave out units to recall the whole group.",
  ],
  [
    "INVALID_TARGET",
    { player: "p1", action: "send_message", reason: "self" },
    "p1 is you: send your messages to other players.",
    "Messages, proposals and leave_alliance {with} name another player.",
  ],
  [
    "INVALID_TARGET",
    { player: "p1", action: "propose", reason: "self" },
    "p1 is you: propose to another player.",
    "Messages, proposals and leave_alliance {with} name another player.",
  ],
  [
    "INVALID_TARGET",
    { player: "p1", action: "leave", reason: "self" },
    "p1 is you: name the partner whose pact you end, or leave out with to leave your alliance.",
    "Messages, proposals and leave_alliance {with} name another player.",
  ],
  [
    "INVALID_TARGET",
    { player: "p1", city: "c12", action: "dismiss", reason: "self" },
    "p1 is you: dismissing sends another player's units in c12 home.",
    "Name the player whose support you want to send home; your own units in your city are already home.",
  ],
  [
    "INVALID_TARGET",
    { player: "p3", action: "send_message", reason: "eliminated" },
    "p3 was eliminated: it receives no messages any more.",
    "Name a player still in the game; leaderboard shows who is alive.",
  ],
  [
    "INVALID_TARGET",
    { proposal: "q1c7hn", action: "answer", reason: "own_proposal" },
    "q1c7hn is your own proposal: only the player it is addressed to can answer it.",
    "Wait for the answer, or let it expire.",
  ],
  [
    "PROPOSAL_LIMIT",
    { to: "p4", kind: "pact", proposal: "q1c7hn", reason: "duplicate", availableAt: 262800 },
    "You already have an open pact proposal to p4 (q1c7hn).",
    "Wait for its answer or its expiry before proposing again. It expires at D4 01:00 (in 10h58m).",
  ],
  [
    "PROPOSAL_LIMIT",
    { max: 3, open: 3, reason: "max_open", availableAt: null },
    "You already have 3 open proposals; the limit is 3.",
    "Wait until one is answered or expires (proposals last 12h).",
  ],
  [
    "EXCEEDS_STORAGE",
    {
      unit: "guard",
      count: 150,
      city: "c12",
      storage: "warehouse",
      storageLevel: 3,
      cap: 2040,
      requiredLevel: 4,
      need_stone: 2400,
      availableAt: 230000,
    },
    "c12 stores at most 2040 of each resource (warehouse 3), and 150 guard costs 2400 stone.",
    "Raise warehouse to level 4 (it holds 2740). Your queued warehouse 4 completes at D3 15:53:20 (in 1h51m20s).",
  ],
];

describe("explain: one snapshot per domain code and gateway warning", () => {
  const env = envOf();
  for (const [code, details, message, hint] of CASES) {
    test(`${code} ${JSON.stringify(details)}`, () => {
      expect(explain({ code, details }, env)).toEqual({ message, hint });
    });
  }

  test("the fixture's queue: the barracks item behind REQUIREMENT_MISSING's availableAt", () => {
    const c12 = setup().match.read().state.cities["c12"];
    expect(c12?.build.map((x) => [x.id, x.building, x.end])).toEqual([
      [13, "hall", T + 3000],
      [14, "barracks", BARRACKS_2],
    ]);
  });

  test("every domain code and gateway warning has its own explainer and a snapshot", () => {
    const codes = [...DOMAIN_ERROR_CODES, ...GATEWAY_WARNING_CODES];
    expect([...EXPLAINED_CODES].toSorted(byText)).toEqual([...codes].toSorted(byText));
    for (const code of codes) expect(CASES.some(([c]) => c === code)).toBe(true);
  });

  test("the §7.3 example, with the numbers the details leave out computed from the own city", () => {
    const given = explain(
      {
        code: "INSUFFICIENT_RESOURCES",
        details: { city: "c12", need_gold: 1500, have_gold: 1210, availableAt: 226688 },
      },
      env,
    );
    const computed = explain(
      { code: "INSUFFICIENT_RESOURCES", details: { city: "c12", need_gold: 1500 } },
      env,
    );
    expect(given).toEqual({
      message: "c12 needs 1500 gold, has 1210.",
      hint: "At +310 gold/h it is affordable at D3 14:58:08 (in 56m8s).",
    });
    expect(computed).toEqual(given);
  });

  test("QUEUE_ITEM names the completion time from the seat's archive", () => {
    const { match, gw } = setup();
    const r = match.read();
    expect(
      explain({ code: "QUEUE_ITEM", details: { city: "c12", item: 12 } }, { r, seat: P1, gw })
        .message,
    ).toBe("#12 of c12 completed at D3 14:01:50.");
    // p2's archive has no such completion: the item reads as missing, and c12's queue is not shown.
    expect(
      explain({ code: "QUEUE_ITEM", details: { city: "c12", item: 12 } }, { r, seat: P2, gw })
        .message,
    ).toBe("c12 has no item #12.");
  });

  test("numbers are filled in from the seat's own cities only, never from another player's", () => {
    const { match, gw } = setup();
    const r = match.read();
    const asP2 = explain(
      { code: "INSUFFICIENT_RESOURCES", details: { city: "c12", need_gold: 1500 } },
      { r, seat: P2, gw },
    );
    expect(asP2).toEqual({
      message: "c12 needs 1500 gold, has less.",
      hint: "Wait for production, or receive resources with send_resources.",
    });
    expect(
      explain({ code: "INSUFFICIENT_UNITS", details: { city: "c12" } }, { r, seat: P2, gw }).hint,
    ).toBe("view_city lists the units at home.");
    expect(
      explain({ code: "AMBIGUOUS_GROUP", details: { city: "c20" } }, { r, seat: P2, gw }).message,
    ).toBe("You have several groups in c20.");
  });

  test("ruleset codes and warnings are worded by ruleset.errors with core's fmt", () => {
    for (const sample of p1.PERFIDIA_1_ERROR_SAMPLES) {
      const explainer = p1.PERFIDIA_1_ERRORS[sample.code];
      if (explainer === undefined) throw new Error(`no explainer for ${sample.code}`);
      expect(explain(sample, env)).toEqual(explainer(sample, fmt));
    }
    const warning = toolWarning(
      { code: "CAPITAL_IMMUNE", details: { city: "c3", arriveAt: 160200, immuneUntil: 172800 } },
      env,
    );
    expect(ToolWarningSchema.parse(warning)).toEqual({
      code: "CAPITAL_IMMUNE",
      message:
        "c3 is a capital that cannot be besieged before D3 00:00, and this attack lands at D2 20:30. A win will be a raid: the settlers come back home. To start a siege, land at D3 00:00 or later.",
    });
  });

  test("an unknown code gets a generic text listing its details", () => {
    expect(explain({ code: "SOMETHING_ODD", details: { b: 2, a: "x" } }, env)).toEqual({
      message: "SOMETHING_ODD (a=x, b=2).",
      hint: "The rules tool explains the rules behind this code.",
    });
  });

  test("toolError carries t, the code, the wording and a copy of the details", () => {
    const details = { city: "c99" };
    const error = toolError({ code: "UNKNOWN_ID", details }, env);
    expect(ToolErrorSchema.parse(error)).toEqual({
      ok: false,
      t: T,
      code: "UNKNOWN_ID",
      message: "No city c99 is known to you.",
      hint: "view_map lists every city.",
      details: { city: "c99" },
    });
    expect(error.details).not.toBe(details);
  });

  test("never throws, whatever the details (a ruleset or a host may send anything flat)", () => {
    const tricky = fc.constantFrom("constructor", "__proto__", "toString", "stationed", "self");
    const value = fc.oneof(fc.integer(), fc.string(), tricky, fc.boolean(), fc.constant(null));
    const keys = fc.constantFrom(
      "city",
      "island",
      "player",
      "movement",
      "proposal",
      "item",
      "unit",
      "building",
      "queue",
      "need_wood",
      "need_gold",
      "have_gold",
      "rate_gold",
      "availableAt",
      "backAt",
      "cap",
      "max",
      "count",
      "requested",
      "home",
      "used",
      "free",
      "k",
      "level",
      "kind",
      "field",
      "path",
      "scope",
      "mode",
      "chars",
      "over",
      "notes",
      "round",
      "at",
      "requested",
      "length",
      "inFlight",
      "action",
      "where",
      "reason",
      "ruleset",
      "until",
      "now",
      "pop",
      "capacity",
      "missing",
      "stationed",
      "from",
      "dismiss",
      "recallableUntil",
      "departAt",
      "issued",
      "requiredLevel",
      "storage",
      "on",
      "requires",
      "need",
      "have",
      "slot",
      "slots",
      "load",
      "pacts",
      "members",
      "alliance",
      "yours",
      "homes",
      "groups",
      "x",
    );
    const codes = [...EXPLAINED_CODES, "CAPITAL_IMMUNE", "NOT_A_CODE"];
    fc.assert(
      fc.property(fc.constantFrom(...codes), fc.dictionary(keys, value), (code, details) => {
        const v = ViolationSchema.safeParse({ code, details });
        if (!v.success) return;
        const e = explain(v.data, env);
        expect(typeof e.message).toBe("string");
        expect(typeof e.hint).toBe("string");
        expect(e.message.length).toBeGreaterThan(0);
      }),
      { numRuns: 400 },
    );
  });
});
