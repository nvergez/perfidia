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
  fixtureRuleset,
  matchFromState,
} from "@perfidia/engine/testing";
import {
  createGatewayState,
  createWakeScheduler,
  deliver,
  searchArchivePage,
  seatOf,
  type GatewayState,
} from "@perfidia/gateway/seat";
import { BriefingSchema, type Briefing, type DomainEvent, type PlayerId } from "@perfidia/protocol";
import {
  BRIEFING_TARGET_CHARS,
  MESSAGE_MIN_CUT,
  briefingSize,
  buildBriefing,
  leaderboard,
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
  gatewayFor,
  oid,
  perfidiaGateway,
  perfidiaRuleset,
  text,
  wakeRecord,
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

const byText = (a: string | null, b: string | null): number =>
  (a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0;

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
        report: oid("r", 1),
        city: "c6",
        attacker: P1,
        defender: P4,
        kind: "raid",
        winner: "defender",
      },
    ]);
    expect(plain(b.news)).toEqual([
      { type: "battle", city: "c6", attacker: P1, defender: P4, kind: "raid", winner: "defender" },
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
// messages, queues, an own movement, a proposal, events, news and a previous turn, under one
// incoming attack (as the §8.2 example) or three.

const T = 223320;
const SEAT: PlayerId = "p3";
const LONG = "We hold the strait together. ".repeat(40);

function budgetWorld(attacks: 1 | 3): { match: Match; gw: GatewayState } {
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
    nextWake: { at: 230520, kind: "self" },
  };
  return { match, gw };
}

function budgetBriefing(attacks: 1 | 3): { b: Briefing; gw: GatewayState } {
  const { match, gw } = budgetWorld(attacks);
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
        args: { search: { scope: "mine", kinds: ["message"], since: 0 } },
      },
    });
    // The read_notes call lists every message, the ones left out included.
    const hits = searchArchivePage(gw, SEAT, { scope: "mine", kinds: ["message"], since: 0 }).hits;
    expect(hits.map((h) => h.id).toSorted(byText)).toEqual(
      [1, 2, 3, 4, 5].map((i) => oid("g", i)).toSorted(byText),
    );
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

describe("the §8.2 budget, three incoming attacks", () => {
  const { b } = budgetBriefing(3);

  test("within 2,400 characters; every incoming attack is listed whatever the truncation", () => {
    expect(briefingSize(b)).toBeLessThanOrEqual(BRIEFING_TARGET_CHARS);
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
    expect(plain(b.more)).toEqual({
      msgs: {
        count: 5,
        call: {
          tool: "read_notes",
          args: { search: { scope: "mine", kinds: ["message"], since: 0 } },
        },
      },
      events: {
        count: 2,
        call: { tool: "read_notes", args: { search: { scope: "mine", since: 0 } } },
      },
      news: {
        count: 2,
        call: { tool: "read_notes", args: { search: { scope: "public", since: 0 } } },
      },
    });
    // A single own movement costs less than its more entry, so it stays.
    expect(b.moves).toHaveLength(1);
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

void P3;
