import { describe, expect, test } from "bun:test";
import type { AnyRuleset } from "@perfidia/engine/contracts";
import type { Match } from "@perfidia/engine/kernel";
import * as p1 from "@perfidia/engine/rulesets/perfidia-1";
import {
  addBuildItem,
  addCity,
  addMovement,
  addProposal,
  addRecruitBatch,
  addStationed,
  buildState,
  fixtureRules,
  fixtureRuleset,
  matchFromState,
  testStep,
} from "@perfidia/engine/testing";
import { turnBack } from "@perfidia/engine/std";
import {
  createGatewayState,
  createWakeScheduler,
  deliver,
  searchArchivePage,
  seatOf,
  type GatewayState,
} from "@perfidia/gateway/seat";
import {
  BriefingSchema,
  type Briefing,
  type CityId,
  type CompiledRules,
  type DomainEvent,
  type GameState,
  type MovementId,
  type PlayerId,
} from "@perfidia/protocol";
import {
  BRIEFING_TARGET_CHARS,
  MESSAGE_MIN_CUT,
  briefingSize,
  buildBriefing,
  leaderboard,
  movementView,
  viewCity,
  visibilityOf,
  viewPlayer,
} from "./index.ts";
import {
  NOW,
  P1,
  P2,
  P3,
  P4,
  event,
  feedP1,
  fixtureMatch,
  fixtureWorld,
  gatewayFor,
  grantingRuleset,
  oid,
  perfidiaGateway,
  perfidiaRuleset,
  text,
  wakeRecord,
  type Perturbation,
} from "./testkit.test.ts";

function parse(b: Briefing): Briefing {
  return BriefingSchema.parse(b);
}

/** Any value, typed loosely so that `toEqual` compares it with plain literals. */
function plain(value: unknown): unknown {
  return value;
}

function p1Briefing(): { b: Briefing; gw: GatewayState; match: Match } {
  const match = fixtureMatch();
  const { gw, wake } = gatewayFor(match);
  feedP1(gw, wake, match.read());
  const b = buildBriefing(match.read(), P1, gw, wakeRecord(["incoming_attack m24hp8"], true));
  return { b: parse(b), gw, match };
}

describe("the briefing of the fixture world", () => {
  test("header, wake, budget, lastTurn", () => {
    const { b } = p1Briefing();
    expect(b).toMatchObject({
      you: P1,
      t: NOW,
      time: "D1 02:00",
      left: [79200, "22h"],
      ruleset: "fixture-1@1.0.0",
      wake: { urgent: true, reasons: ["incoming_attack m24hp8"] },
      lastTurn: null,
      notes: "",
      budget: {
        roundTrips: 6,
        callsPerRoundTrip: 8,
        callsPerWake: 30,
        ownWakesLeft: 8,
        socialWakesLeft: 6,
        selfWakeAt: null,
        attacksLeft: 10,
        messagesLeft: 10,
      },
    });
  });

  test("cities with queues, units and the publicCity extra of a held city", () => {
    const { b } = p1Briefing();
    expect(b.cities.map((c) => c.id)).toEqual(["c1", "c2", "c3"]);
    expect(plain(b.cities[0])).toEqual({
      id: "c1",
      isl: "i1",
      res: [300, 300, 300],
      rate: [60, 60, 60],
      cap: 1000,
      pop: [22, 80],
      build: [{ item: 1, b: "tower", lvl: 3, end: [9000, "D1 02:30"] }],
      recruit: { drill: [{ item: 2, unit: "soldier", n: 5, end: [7500, "D1 02:05"] }] },
      units: { soldier: 12 },
      stationed: 0,
    });
    expect(b.cities[2]).toMatchObject({
      id: "c3",
      stationed: 1,
      ext: { held: { by: P4, since: [NOW, "D1 02:00"] } },
    });
    expect(b.cities[1]).not.toHaveProperty("ext");
  });

  test("every incoming attack with its foe and time pairs; own moves; the top-level ext", () => {
    const { b } = p1Briefing();
    expect(b.incoming.map((x) => [x.kind, x.by, x.foe, x.to, x.depart, x.arrive])).toEqual([
      ["attack", P4, P2, "c4", [6000, "D1 01:40"], [11400, "D1 03:10"]],
      ["attack", P3, P1, "c1", [6600, "D1 01:50"], [12000, "D1 03:20"]],
    ]);
    expect(plain(b.moves)).toEqual([
      { id: b.moves[0]?.id, kind: "support", to: "c4", arrive: [12500, "D1 03:28:20"] },
    ]);
    // The fixture's briefing hook: the holds p1 takes part in, as holder and as owner.
    expect(plain(b.ext)).toEqual({
      renamingOpen: false,
      renames: 0,
      openAt: [7200, "D1 02:00"],
      holding: [{ city: "c5", owner: P3, since: [NOW, "D1 02:00"] }],
      held: [{ city: "c3", by: P4, since: [NOW, "D1 02:00"] }],
    });
  });

  test("messages, proposals with their texts, events and news", () => {
    const { b, match } = p1Briefing();
    expect(plain(b.msgs)).toEqual([
      { id: oid("g", 1), from: P2, to: [P1], text: "Hold c3, I come." },
    ]);
    const q = Object.values(match.read().state.proposals).find((x) => x.to === P1);
    expect(plain(b.proposals)).toEqual([
      {
        id: q?.id,
        from: P3,
        to: P1,
        kind: "pact",
        name: null,
        text: "Peace  for two days?",
        expires: [10800, "D1 03:00"],
      },
    ]);
    // A report is summarised to its standard fields; read_notes {open} gives the rest.
    expect(plain(b.events)).toEqual([
      {
        type: "battle_report",
        at: [6500, "D1 01:48:20"],
        report: oid("r", 1),
        city: "c6",
        attacker: P1,
        defender: P4,
        kind: "raid",
        winner: "defender",
      },
    ]);
    expect(plain(b.news)).toEqual([
      {
        type: "battle",
        at: [6600, "D1 01:50"],
        city: "c6",
        attacker: P1,
        defender: P4,
        kind: "raid",
        winner: "defender",
      },
    ]);
    expect(b).not.toHaveProperty("more");
    expect(briefingSize(b)).toBeLessThanOrEqual(BRIEFING_TARGET_CHARS);
  });

  test("the holder's briefing lists the hold in its top-level ext", () => {
    const match = fixtureMatch();
    const { gw } = gatewayFor(match);
    const b = parse(buildBriefing(match.read(), P4, gw, wakeRecord(["start"])));
    expect(b.ext["holding"]).toEqual([{ city: "c3", owner: P1, since: [NOW, "D1 02:00"] }]);
    expect(b.cities.map((c) => c.id)).toEqual(["c6"]);
    expect(briefingSize(b)).toBeLessThanOrEqual(BRIEFING_TARGET_CHARS);
  });

  test("without a briefing hook, the top-level ext is publicMatch (§8.2 default)", () => {
    const publicOnly: AnyRuleset = {
      ...fixtureRuleset,
      hooks: {
        ...fixtureRuleset.hooks,
        visibility: { publicMatch: () => ({ hill: { open: false, at: [172800, "D3 00:00"] } }) },
      },
    };
    const match = fixtureMatch([], publicOnly);
    const { gw } = gatewayFor(match);
    const b = parse(buildBriefing(match.read(), P1, gw, wakeRecord(["start"])));
    expect(plain(b.ext)).toEqual({ hill: { open: false, at: [172800, "D3 00:00"] } });
    expect(plain(leaderboard(match.read()).ext)).toEqual(plain(b.ext));
    // Nor a publicCity hook: the held city shows no extra.
    expect(b.cities[2]).not.toHaveProperty("ext");
  });

  test("deterministic", () => {
    expect(text(p1Briefing().b)).toBe(text(p1Briefing().b));
  });
});

// The budget fixtures (§8.2): a 3-city perfidia-1 seat with its notebook full, five long
// messages, queues, an own movement, a proposal, events, news and a previous turn (its last
// briefing an hour ago), under one incoming attack (as the §8.2 example) or three, with
// perfidia-1's visibility extras (city points, the briefing's sieges and countdowns); and the same
// seat with full queues in every city.

const T = 223320;
const SEAT: PlayerId = "p3";
const LONG = "We hold the strait together. ".repeat(40);
/** The seat's previous briefing, an hour before (D3 13:02): the `since` of the `more` calls. */
const LAST_BRIEFING = T - 3600;

/** Fills every build queue (5 items) and adds two recruit batches to each city. */
function fillQueues(state: GameState, rules: CompiledRules): void {
  const more: readonly (readonly [CityId, readonly string[]])[] = [
    ["c3", ["hall", "lumber", "quarry"]],
    ["c9", ["quarry", "mine", "warehouse", "barracks"]],
    ["c12", ["hall", "lumber", "quarry", "mine", "barracks"]],
  ];
  for (const [city, buildings] of more) {
    for (const b of buildings) addBuildItem(state, rules, city, b);
    if (city !== "c3") addRecruitBatch(state, rules, city, "guard", 10);
    addRecruitBatch(state, rules, city, "raider", 15);
  }
}

function budgetWorld(attacks: 1 | 3, fullQueues = false): { match: Match; gw: GatewayState } {
  const rules = p1.compileRules(p1.PERFIDIA_1_DEFAULTS, 8);
  const players = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"] as const;
  const state = buildState({
    rules,
    players: 8,
    now: T,
    islands: [
      { kind: "home", richnessPm: 1000, slots: 2 },
      { kind: "frontier", richnessPm: 1500, slots: 2 },
      { kind: "backyard", richnessPm: 1000, slots: 1 },
      { kind: "home", richnessPm: 1000, slots: 2 },
    ],
    ext: p1.initialExt([...players], [...players]),
  });
  const levels = {
    hall: 5,
    lumber: 5,
    quarry: 5,
    mine: 5,
    warehouse: 5,
    barracks: 3,
    harbor: 2,
    wall: 2,
  };
  addCity(state, rules, {
    owner: SEAT,
    id: "c3",
    island: "i1",
    capital: true,
    stock: { wood: 1520, stone: 800, gold: 240 },
    units: { guard: 40, raider: 10, transport: 4 },
    buildings: levels,
  });
  addCity(state, rules, {
    owner: SEAT,
    id: "c9",
    island: "i2",
    stock: 600,
    units: { guard: 20 },
    buildings: { hall: 2, lumber: 2, quarry: 2, mine: 2, warehouse: 2, barracks: 1 },
  });
  addCity(state, rules, {
    owner: SEAT,
    id: "c12",
    island: "i3",
    stock: 300,
    units: { guard: 8 },
    buildings: { hall: 1, warehouse: 1 },
  });
  addCity(state, rules, {
    owner: "p2",
    id: "c2",
    island: "i4",
    capital: true,
    units: { raider: 80 },
    buildings: levels,
  });
  addCity(state, rules, {
    owner: "p5",
    id: "c5",
    island: "i1",
    capital: true,
    units: { raider: 50 },
    buildings: levels,
  });
  addCity(state, rules, {
    owner: "p6",
    id: "c6",
    island: "i4",
    capital: true,
    units: { raider: 50 },
    buildings: levels,
  });
  addBuildItem(state, rules, "c3", "barracks");
  addBuildItem(state, rules, "c3", "wall");
  addRecruitBatch(state, rules, "c3", "guard", 20, { unitTime: 300 });
  addBuildItem(state, rules, "c9", "lumber");
  addStationed(state, "c3", { owner: "p5", home: "c5", role: "support", units: { guard: 5 } });
  if (fullQueues) fillQueues(state, rules);
  const raids = [
    ["p2", "c2", "c3", 3300],
    ["p5", "c5", "c9", 5400],
    ["p6", "c6", "c12", 8000],
  ] as const;
  for (const [owner, from, to, dt] of raids.slice(0, attacks)) {
    addMovement(state, rules, {
      kind: "attack",
      owner,
      from,
      to,
      party: SEAT,
      units: { raider: 30 },
      departAt: T - 1500,
      arriveAt: T + dt,
    });
  }
  addMovement(state, rules, {
    kind: "support",
    owner: SEAT,
    from: "c3",
    to: "c9",
    party: SEAT,
    units: { guard: 10 },
    departAt: T - 600,
    arriveAt: T + 1080,
  });
  addProposal(state, rules, { from: "p6", to: SEAT, kind: "pact", expiresAt: T + 39480 });
  const match = matchFromState(state, perfidiaRuleset);
  const gw = createGatewayState([...players]);
  const wake = createWakeScheduler(gw, perfidiaGateway());
  const proposal = Object.values(match.read().state.proposals)[0];
  const events: DomainEvent[] = [
    event(
      T - 3000,
      "proposal",
      [
        ["p6", "self"],
        [SEAT, "target"],
      ],
      {
        proposal: proposal?.id ?? "",
        from: "p6",
        to: SEAT,
        kind: "pact",
        name: null,
        text: "A pact for two days, then we talk about the strait and the frontier islands near c9.",
        until: null,
        expiresAt: T + 39480,
      },
    ),
    event(T - 2000, "queue_empty", [[SEAT, "self"]], { city: "c12", queue: "build" }),
    event(T - 1900, "build_done", [[SEAT, "self"]], {
      city: "c9",
      item: 3,
      building: "quarry",
      level: 2,
    }),
    event(
      T - 1000,
      "alliance_left",
      [["p7", "self"]],
      { alliance: "a1", player: "p7", cause: "left" },
      true,
    ),
    event(
      T - 900,
      "battle",
      [],
      { city: "c6", attacker: "p8", defender: "p6", kind: "city", winner: "attacker" },
      true,
    ),
  ];
  for (let i = 1; i <= 5; i += 1) {
    const from = i % 2 === 0 ? "p5" : "p6";
    events.push(
      event(
        T - 1800 + i * 100,
        "message",
        [
          [from, "self"],
          [SEAT, "target"],
        ],
        { message: oid("g", i), from, to: [SEAT], text: `${i}: ${LONG}` },
      ),
    );
  }
  deliver(gw, events, wake);
  const s = seatOf(gw, SEAT);
  s.notes = "n".repeat(4000);
  s.lastBriefingAt = LAST_BRIEFING;
  s.wake.selfAt = 230520;
  s.lastTurn = {
    ended: "end_turn",
    unseen: [
      {
        tool: "attack",
        code: "INSUFFICIENT_UNITS",
        message: "c3: 60 raider requested, 10 at home.",
      },
    ],
    warnings: [],
    nextWake: { at: 230520, kind: "self" },
  };
  return { match, gw };
}

function budgetBriefing(attacks: 1 | 3, fullQueues = false): { b: Briefing; gw: GatewayState } {
  const { match, gw } = budgetWorld(attacks, fullQueues);
  const reasons = [`incoming_attack ${oid("m", 1)}`, "message g00001"];
  return { b: parse(buildBriefing(match.read(), SEAT, gw, wakeRecord(reasons, true))), gw };
}

describe("the §8.2 budget, one incoming attack", () => {
  const { b, gw } = budgetBriefing(1);

  test("within 2,400 characters excluding notes, with the notebook full and long messages", () => {
    expect(b.notes).toBe("n".repeat(4000));
    expect(b.cities).toHaveLength(3);
    expect(briefingSize(b)).toBeLessThanOrEqual(BRIEFING_TARGET_CHARS);
  });

  test("the incoming attack, with its foe and time pairs", () => {
    expect(b.incoming.map((x) => [x.kind, x.by, x.foe, x.to, x.depart, x.arrive])).toEqual([
      ["attack", "p2", SEAT, "c3", [221820, "D3 13:37"], [226620, "D3 14:57"]],
    ]);
  });

  test("the newest message is kept, its body cut to fit; the others are named by a more entry", () => {
    expect(b.msgs).toHaveLength(1);
    expect(b.msgs[0]).toMatchObject({ id: oid("g", 5), from: "p6", to: [SEAT], cut: true });
    // Cut at 300, or shorter (down to MESSAGE_MIN_CUT) when 300 does not fit the target.
    const kept = b.msgs[0]?.text ?? "";
    expect(kept.length).toBeGreaterThanOrEqual(MESSAGE_MIN_CUT);
    expect(kept.length).toBeLessThanOrEqual(300);
    expect(`5: ${LONG}`.startsWith(kept)).toBe(true);
    expect(plain(b.more?.["msgs"])).toEqual({
      count: 5 - b.msgs.length,
      call: {
        tool: "read_notes",
        args: { search: { scope: "mine", kinds: ["message"], since: LAST_BRIEFING, before: 10 } },
      },
    });
    // The read_notes call lists exactly the messages left out, newest first, none it kept.
    const search = { scope: "mine" as const, kinds: ["message"], since: LAST_BRIEFING, before: 10 };
    const hits = searchArchivePage(gw, SEAT, search).hits;
    expect(hits.map((h) => h.id)).toEqual([4, 3, 2, 1].map((i) => oid("g", i)));
  });

  test("every open proposal is listed with its text", () => {
    expect(b.proposals).toHaveLength(1);
    expect(b.proposals[0]).toMatchObject({
      from: "p6",
      to: SEAT,
      kind: "pact",
      name: null,
      text: "A pact for two days, then we talk about the strait and the frontier islands near c9.",
      expires: [262800, "D4 01:00"],
    });
  });

  test("lastTurn, budget and the pending self-wake as pairs; no per-wake cap in perfidia-1", () => {
    expect(plain(b.lastTurn)).toEqual({
      ended: "end_turn",
      unseen: [
        {
          tool: "attack",
          code: "INSUFFICIENT_UNITS",
          message: "c3: 60 raider requested, 10 at home.",
        },
      ],
      warnings: [],
      nextWake: { at: [230520, "D3 16:02"], kind: "self" },
    });
    expect(plain(b.budget)).toEqual({
      roundTrips: 8,
      callsPerRoundTrip: 10,
      ownWakesLeft: 12,
      socialWakesLeft: 8,
      selfWakeAt: [230520, "D3 16:02"],
      attacksLeft: 20,
      messagesLeft: 20,
    });
    expect(b.left).toEqual([381480, "4d 9h58m"]);
    expect(b.time).toBe("D3 14:02");
  });

  test("queues: build items and recruit batches with item numbers and end pairs", () => {
    expect(b.cities[0]).toMatchObject({
      id: "c3",
      res: [1520, 800, 240],
      build: [
        { item: 1, b: "barracks", lvl: 4, end: [228986, "D3 15:36:26"] },
        { item: 2, b: "wall", lvl: 3, end: [232986, "D3 16:43:06"] },
      ],
      recruit: { barracks: [{ item: 3, unit: "guard", n: 20, end: [229320, "D3 15:42"] }] },
      stationed: 1,
    });
  });
});

// Over the target (reported, as §8.1 asks of its budgets): cities, `incoming` and `proposals` never
// give way, and with three attacks, perfidia-1's extras and the `more` entries of the lists that
// gave way, nothing is left to cut. The sizes are pinned so that any growth shows.
const THREE_ATTACKS_CHARS = 2505;
const FULL_QUEUES_CHARS = 3571;

describe("the §8.2 budget, three incoming attacks", () => {
  const { b, gw } = budgetBriefing(3);

  test("every incoming attack is listed whatever the truncation", () => {
    expect(b.incoming.map((x) => [x.kind, x.by, x.foe, x.to, x.depart[1], x.arrive])).toEqual([
      ["attack", "p2", SEAT, "c3", "D3 13:37", [226620, "D3 14:57"]],
      ["attack", "p5", SEAT, "c9", "D3 13:37", [228720, "D3 15:32"]],
      ["attack", "p6", SEAT, "c12", "D3 13:37", [231320, "D3 16:15:20"]],
    ]);
    expect(b.proposals).toHaveLength(1);
  });

  test("the lists that do not fit give way, each with the call that lists it", () => {
    expect(b.news).toEqual([]);
    expect(b.msgs).toEqual([]);
    expect(b.events).toEqual([]);
    const events = { scope: "mine" as const, kinds: ["build_done", "queue_empty"], before: 4 };
    expect(plain(b.more)).toEqual({
      msgs: {
        count: 5,
        call: {
          tool: "read_notes",
          args: {
            search: { scope: "mine", kinds: ["message"], since: LAST_BRIEFING, before: 11 },
          },
        },
      },
      events: {
        count: 2,
        call: { tool: "read_notes", args: { search: { ...events, since: LAST_BRIEFING } } },
      },
      news: {
        count: 2,
        call: {
          tool: "read_notes",
          args: { search: { scope: "public", since: LAST_BRIEFING, before: 6 } },
        },
      },
    });
    // Each call lists exactly the entries left out.
    const hits = searchArchivePage(gw, SEAT, { ...events, since: LAST_BRIEFING }).hits;
    expect(hits.map((h) => h.type)).toEqual(["build_done", "queue_empty"]);
    const msgs = { scope: "mine" as const, kinds: ["message"], since: LAST_BRIEFING, before: 11 };
    expect(searchArchivePage(gw, SEAT, msgs).hits).toHaveLength(5);
    const news = { scope: "public" as const, since: LAST_BRIEFING, before: 6 };
    expect(searchArchivePage(gw, SEAT, news).hits).toHaveLength(2);
    // A single own movement costs less than its more entry, so it stays.
    expect(b.moves).toHaveLength(1);
  });

  test("over the 2,400 target with perfidia-1's extras: measured, and reported", () => {
    expect(b.cities.map((c) => c.ext)).toEqual([{ points: 132 }, { points: 111 }, { points: 102 }]);
    expect(b.ext).toEqual({ holding: [], countdowns: [] });
    expect(briefingSize(b)).toBe(THREE_ATTACKS_CHARS);
  });
});

describe("the §8.2 budget, full queues in every city", () => {
  const { b } = budgetBriefing(3, true);

  test("every queue item, every incoming attack and the proposal are listed: measured", () => {
    expect(b.cities.map((c) => c.build.length)).toEqual([5, 5, 5]);
    expect(b.cities.map((c) => Object.values(c.recruit).flat().length)).toEqual([2, 2, 2]);
    expect(b.incoming).toHaveLength(3);
    expect(b.proposals).toHaveLength(1);
    expect([b.msgs, b.events, b.news]).toEqual([[], [], []]);
    expect(briefingSize(b)).toBe(FULL_QUEUES_CHARS);
  });
});

describe("text and lists", () => {
  test("a long message is cut at 300 characters when the briefing has room", () => {
    const match = fixtureMatch();
    const { gw, wake } = gatewayFor(match);
    deliver(
      gw,
      [
        event(
          NOW,
          "message",
          [
            [P2, "self"],
            [P1, "target"],
          ],
          { message: oid("g", 7), from: P2, to: [P1], text: LONG },
        ),
      ],
      wake,
    );
    const b = parse(buildBriefing(match.read(), P1, gw, wakeRecord(["message"])));
    expect(plain(b.msgs)).toEqual([
      { id: oid("g", 7), from: P2, to: [P1], text: LONG.slice(0, 300), cut: true },
    ]);
    expect(briefingSize(b)).toBeLessThanOrEqual(BRIEFING_TARGET_CHARS);
  });

  test("control characters are stripped, own messages left out, public messages are news", () => {
    const match = fixtureMatch();
    const { gw, wake } = gatewayFor(match);
    deliver(
      gw,
      [
        event(
          NOW,
          "message",
          [
            [P2, "self"],
            [P1, "target"],
          ],
          { message: oid("g", 1), from: P2, to: [P1], text: "line\none\u0000" },
        ),
        event(
          NOW,
          "message",
          [
            [P1, "self"],
            [P2, "target"],
          ],
          { message: oid("g", 2), from: P1, to: [P2], text: "mine" },
        ),
        event(
          NOW,
          "message",
          [[P3, "self"]],
          { message: oid("g", 3), from: P3, to: "all", text: "x".repeat(400) },
          true,
        ),
      ],
      wake,
    );
    const b = parse(buildBriefing(match.read(), P1, gw, wakeRecord(["message"])));
    expect(plain(b.msgs)).toEqual([{ id: oid("g", 1), from: P2, to: [P1], text: "line one " }]);
    expect(plain(b.news)).toEqual([
      {
        type: "message",
        at: [NOW, "D1 02:00"],
        message: oid("g", 3),
        from: P3,
        to: "all",
        text: "x".repeat(300),
        cut: true,
      },
    ]);
  });

  test("news gives way first, then moves, then events, then messages", () => {
    const match = fixtureMatch();
    const { gw, wake } = gatewayFor(match);
    const many: DomainEvent[] = [];
    for (let i = 0; i < 30; i += 1) {
      many.push(
        event(
          NOW - 100 + i,
          "battle",
          [],
          { city: "c6", attacker: P3, defender: P4, kind: "raid", winner: "defender" },
          true,
        ),
      );
      many.push(
        event(NOW - 100 + i, "build_done", [[P1, "self"]], {
          city: "c1",
          item: 100 + i,
          building: "tower",
          level: 2,
        }),
      );
    }
    deliver(gw, many, wake);
    const b = parse(buildBriefing(match.read(), P1, gw, wakeRecord(["queue_empty"])));
    expect(briefingSize(b)).toBeLessThanOrEqual(BRIEFING_TARGET_CHARS);
    expect(b.news).toEqual([]);
    expect(b.more?.["news"]?.count).toBe(30);
    // A single own movement costs less than its more entry: it stays.
    expect(b.moves).toHaveLength(1);
    expect(b.more).not.toHaveProperty("moves");
    expect(b.events.length).toBeGreaterThan(0);
    expect(b.events.length + (b.more?.["events"]?.count ?? 0)).toBe(30);
    // The newest events are kept.
    expect(b.events.at(-1)).toMatchObject({ type: "build_done", item: 129 });
    expect(b.incoming).toHaveLength(2);
  });
});

// Returns into a held city (perfidia-1 §9.3, §12) and recalled attacks (§7.4). In the fixture world
// c3 (p1's) is held by p4, and c5 (p3's) by p1.

/** p1's return into c3 from c4: a bounced attack on p3's city, or a stationed group going home. */
const BOUNCED: Perturbation = { kind: "homecoming", city: "c3", party: P3, back: true };
const STATIONED: Perturbation = { kind: "homecoming", city: "c3", party: null, back: false };

function returnId(match: Match): string {
  const m = Object.values(match.read().state.movements).find((x) => x.kind === "return");
  if (m === undefined) throw new Error("no return in the world");
  return m.id;
}

describe("homecomings and recalled attacks", () => {
  test("the besieger's briefing lists a return into the city it holds, itself as the foe, no origin", () => {
    for (const homecoming of [BOUNCED, STATIONED]) {
      const match = fixtureMatch([homecoming]);
      const { gw, wake } = gatewayFor(match);
      const id = returnId(match);
      // perfidia-1 tells the besieger with an incoming_attack notice (homecoming: true, from: null).
      const notice = event(NOW - 100, "incoming_attack", [[P4, "party"]], {
        movement: id,
        from: null,
        by: P1,
        foe: P4,
        to: "c3",
        departAt: NOW - 100,
        arriveAt: NOW + 3500,
        homecoming: true,
      });
      deliver(gw, [notice], wake);
      const b = parse(buildBriefing(match.read(), P4, gw, wakeRecord([`incoming_attack ${id}`])));
      // Never the return's recorded party (p3's city was the target), never null; no turnedBack.
      // Nor its origin: c4 is where p1 had troops stationed (a stationed recall or a dismissal), or
      // the target of the attack that bounced, neither of which p4 was told about (perfidia-1 §12).
      expect(plain(b.incoming.find((x) => x.id === id))).toEqual({
        id,
        kind: "return",
        from: null,
        by: P1,
        foe: P4,
        to: "c3",
        depart: [7100, "D1 01:58:20"],
        arrive: [10700, "D1 02:58:20"],
        homecoming: true,
      });
      // The notice of a listed movement does not repeat in events.
      expect(b.events).toEqual([]);
      // The movement view at the besieger's access hides the origin too; its owner sees it.
      const m = Object.values(match.read().state.movements).find((x) => x.id === id);
      if (m === undefined) throw new Error("no return");
      expect(movementView(match.read(), m, "incoming", P4).from).toBeNull();
      expect(movementView(match.read(), m, "own", P1).from).toBe("c4");
    }
  });

  test("the mover sees its return in full: the besieger as its foe, and when it turned back", () => {
    for (const [homecoming, turnedBack] of [
      [BOUNCED, [7100, "D1 01:58:20"]],
      [STATIONED, undefined],
    ] as const) {
      const match = fixtureMatch([homecoming]);
      const { gw } = gatewayFor(match);
      const r = match.read();
      const id = returnId(match);
      const own = viewPlayer(r, P1, P1, gw)?.private?.movements.find((m) => m.id === id);
      expect(own).toMatchObject({ access: "own", party: P4, homecoming: true, home: "c3" });
      expect(plain(own?.turnedBack)).toEqual(turnedBack);
      const city = viewCity(r, P1, "c3", gw);
      const incoming = city?.access === "full" ? city.incoming : [];
      expect(plain(incoming.find((m) => m.id === id))).toEqual(own);
      // The mover's briefing lists it among its own moves, not as incoming.
      const b = buildBriefing(r, P1, gw, wakeRecord(["start"]));
      expect(b.moves.map((m): string => m.id)).toContain(id);
      expect(b.incoming.map((m): string => m.id)).not.toContain(id);
    }
  });

  test("a recalled attack stays in the target's incoming list, turned back at the recall time", () => {
    const match = fixtureMatch();
    const { gw, wake } = gatewayFor(match);
    const r = match.read();
    // p4's attack on p2's c4: p2 is its foe, p1 (p2's ally) and p1's group in c4 are told.
    const attack = Object.values(r.state.movements).find((m) => m.owner === P4);
    if (attack === undefined) throw new Error("no attack of p4");
    const launch = event(
      NOW - 1200,
      "incoming_attack",
      [
        [P2, "party"],
        [P1, "stationed"],
      ],
      {
        movement: attack.id,
        from: "c6",
        by: P4,
        foe: P2,
        to: "c4",
        departAt: NOW - 1200,
        arriveAt: NOW + 4200,
        homecoming: false,
      },
    );
    deliver(gw, [launch], wake);
    expect(buildBriefing(r, P1, gw, wakeRecord(["start"])).incoming.map((x) => x.id)).toContain(
      attack.id,
    );
    const recall = testStep(match, (ctx) => turnBack(ctx, attack.id));
    expect(recall.map((e) => e.type)).toEqual(["movement_recalled"]);
    deliver(gw, recall, wake);
    const after = match.read();
    // The return home (c6, not held) is hidden from both.
    expect(viewCity(after, P1, "c4", gw)).toMatchObject({ access: "full" });
    for (const seat of [P1, P2]) {
      const b = parse(buildBriefing(after, seat, gw, wakeRecord(["incoming_attack"])));
      expect(plain(b.incoming.find((x) => x.id === attack.id))).toEqual({
        id: attack.id,
        kind: "attack",
        from: "c6",
        by: P4,
        foe: P2,
        to: "c4",
        depart: [6000, "D1 01:40"],
        arrive: [11400, "D1 03:10"],
        turnedBack: [NOW, "D1 02:00"],
      });
      // Neither the launch notice nor the recall repeats in events.
      expect(b.events.map((e) => e.type)).not.toContain("movement_recalled");
      expect(b.events.map((e) => e.type)).not.toContain("incoming_attack");
    }
  });

  test("an attack recalled into a city the seat holds shows as the homecoming it becomes", () => {
    const match = fixtureMatch();
    const { gw, wake } = gatewayFor(match);
    // p3's attack on c1: recalled, it returns into c5, which p1 holds.
    const attack = Object.values(match.read().state.movements).find((m) => m.owner === P3);
    if (attack === undefined) throw new Error("no attack of p3");
    const recall = testStep(match, (ctx) => turnBack(ctx, attack.id));
    deliver(gw, recall, wake);
    const b = parse(buildBriefing(match.read(), P1, gw, wakeRecord(["incoming_attack"])));
    expect(b.incoming.find((x) => x.id === attack.id)).toMatchObject({
      kind: "return",
      by: P3,
      foe: P1,
      to: "c5",
      homecoming: true,
    });
    // The recall itself stays in events, with the time it happened at.
    expect(plain(b.events.find((e) => e.type === "movement_recalled"))).toEqual({
      type: "movement_recalled",
      at: [NOW, "D1 02:00"],
      movement: attack.id,
      kind: "attack",
      by: P3,
      to: "c1",
      arriveAt: [10800, "D1 03:00"],
    });
  });
});

describe("which movements incoming lists", () => {
  test("with full ally access: attacks on its own and its ally's cities, never an ally's outgoing attack nor a support to the ally", () => {
    const state = fixtureWorld();
    // p3's support to p2's c4: p1 sees it in full (its ally's city), but it does not concern p1.
    addMovement(state, fixtureRules(4), {
      kind: "support",
      owner: P3,
      from: "c5",
      to: "c4",
      party: P2,
      units: { soldier: 1 },
      departAt: NOW - 50,
      arriveAt: NOW + 3000,
    });
    const match = matchFromState(state, grantingRuleset);
    const r = match.read();
    const { gw } = gatewayFor(match);
    const vis = visibilityOf(r);
    const of = (owner: PlayerId, kind: string): MovementId => {
      const m = Object.values(r.state.movements).find((x) => x.owner === owner && x.kind === kind);
      if (m === undefined) throw new Error(`no ${kind} of ${owner}`);
      return m.id;
    };
    // p2's attack on p4's c6 (an ally's outgoing attack) and p3's support are seen in full.
    expect(vis.movementAccess(P1, of(P2, "attack"))).toBe("full");
    expect(vis.movementAccess(P1, of(P3, "support"))).toBe("full");
    // p3's attack on p1's own c1 is still seen: the granting fixture keeps the default access.
    expect(vis.movementAccess(P1, of(P3, "attack"))).toBe("incoming");
    const b = parse(buildBriefing(r, P1, gw, wakeRecord(["start"])));
    expect(b.incoming.map((x) => [x.kind, x.by, x.to, x.foe])).toEqual([
      ["attack", P4, "c4", P2],
      ["attack", P3, "c1", P1],
    ]);
  });
});

void P3;
