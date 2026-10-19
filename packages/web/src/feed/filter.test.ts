import { describe, expect, test } from "bun:test";
import type { FeedItem } from "@perfidia/protocol/spectator";
import type { PlayerId } from "../lib/ids.ts";
import type { FeedEntry } from "../playback/timeline.ts";
import {
  DEFAULT_VIEW,
  between,
  filterFeed,
  findEntry,
  inCategory,
  allianceNamesOf,
  betrayalBattle,
  mergeEntries,
  sameTurnOf,
  seenBy,
  seqOfItem,
  turnIndex,
  turnKeyOf,
  turnsOf,
  visible,
  PLAYING_WINDOW,
  WINDOW,
  windowLimit,
  windowOf,
  type FeedView,
} from "./filter.ts";

// The feed's chips, player multi-select and pair mode (phase-3 design §4.3, §4.2.4), and the
// lookups behind its cards, on hand-made items of every kind.

const base = (id: string, players: PlayerId[], importance: 0 | 1 | 2 | 3 = 1) => ({
  id,
  t: 100,
  players,
  importance,
});

const message = (id: string, from: PlayerId, to: PlayerId[] | "all", turn: number | null = 3) =>
  ({
    k: "message",
    ...base(id, to === "all" ? [from] : [from, ...to]),
    message: "g1abcd",
    from,
    to,
    private: to !== "all",
    text: "hello",
    turn,
  }) satisfies FeedItem;

const launch = (
  id: string,
  owner: PlayerId,
  o: {
    target?: PlayerId | null;
    foe?: PlayerId | null;
    importance?: 0 | 1 | 2 | 3;
    ally?: boolean;
  },
) =>
  ({
    k: "launch",
    ...base(
      id,
      [owner, ...(o.target === undefined || o.target === null ? [] : [o.target])],
      o.importance ?? 1,
    ),
    movement: "m1abcd",
    kind: "attack",
    owner,
    from: "c1",
    to: "c2",
    toIsland: "i1",
    target: o.target ?? null,
    departAt: 100,
    arriveAt: 200,
    units: {},
    pop: 1,
    settlers: false,
    foe: o.foe ?? null,
    againstAlly: o.ally === true ? "ally" : null,
    context: null,
  }) satisfies FeedItem;

const turn = (id: string, seat: PlayerId, n: number, llm: boolean) =>
  ({
    k: "turn",
    ...base(id, [seat], llm ? 1 : 0),
    seat,
    turn: n,
    llm,
    wakeT: 90,
    reasons: ["self"],
    urgent: false,
    why: "end_turn",
    rounds: 2,
    calls: 3,
    accepted: 3,
    rejected: [],
    messages: [],
    thought: `thought ${seat} ${n}`,
  }) satisfies FeedItem;

/** A diplomacy entry of an alliance. */
const dip = (
  seq: number,
  event: "alliance_formed" | "alliance_joined" | "alliance_dissolved",
  alliance: `a${number}`,
  players: PlayerId[],
  name: string | null,
): FeedEntry => ({
  seq,
  item: {
    k: "diplomacy",
    ...base(`${seq}:0`, players),
    event,
    alliance,
    name,
    cause: null,
    expiresAt: null,
  },
});

const ITEMS = {
  publicMsg: message("1:0", "p1", "all"),
  privateMsg: message("2:0", "p2", ["p3"]),
  groupMsg: message("3:0", "p4", ["p2", "p3"]),
  proposal: {
    k: "proposal",
    ...base("4:0", ["p2", "p3"]),
    proposal: "q1abcd",
    from: "p2",
    to: "p3",
    kind: "alliance",
    name: "League",
    text: "join me",
    until: null,
    expiresAt: 500,
  } satisfies FeedItem,
  answer: {
    k: "answer",
    ...base("5:0", ["p2", "p3"]),
    proposal: "q1abcd",
    from: "p2",
    to: "p3",
    kind: "alliance",
    accept: true,
  } satisfies FeedItem,
  formed: {
    k: "diplomacy",
    ...base("6:0", ["p2", "p3"], 2),
    event: "alliance_formed",
    alliance: "a2",
    name: "League",
    cause: null,
    expiresAt: null,
  } satisfies FeedItem,
  attack: launch("7:0", "p2", { target: "p3", foe: "p3" }),
  attackOnAlly: launch("8:0", "p2", { target: "p3", foe: "p3", importance: 3, ally: true }),
  relief: launch("9:0", "p2", { target: "p5", foe: "p6", importance: 2 }),
  shipment: launch("10:0", "p1", { target: "p1", importance: 0 }),
  battle: {
    k: "battle",
    ...base("11:0", ["p3", "p2"], 2),
    city: "c18",
    attacker: "p2",
    defender: "p3",
    kind: "city",
    winner: "attacker",
    reports: ["r1abcd", "r2abcd"],
    siege: null,
    fell: false,
  } satisfies FeedItem,
  neutralBattle: {
    k: "battle",
    ...base("12:0", ["p2"], 1),
    city: "c30",
    attacker: "p2",
    defender: "neutral",
    kind: "city",
    winner: "attacker",
    reports: [],
    siege: null,
    fell: false,
  } satisfies FeedItem,
  betrayal: {
    k: "betrayal",
    ...base("13:0", ["p2", "p3"], 3),
    by: "p2",
    against: "p3",
    relation: "ally",
    city: "c18",
    context: { messages: [], thoughts: [], since: 50 },
  } satisfies FeedItem,
  conquest: {
    k: "conquest",
    ...base("14:0", ["p4", "p2"], 3),
    city: "c15",
    from: "p2",
    to: "p4",
    prize: false,
  } satisfies FeedItem,
  founding: {
    k: "founding",
    ...base("15:0", ["p5"], 0),
    city: "c8",
    island: "i2",
    slot: 1,
    owner: "p5",
  } satisfies FeedItem,
  spy: {
    k: "spy",
    ...base("16:0", ["p6", "p5"], 0),
    event: "spy_report",
    city: "c8",
    by: "p6",
    report: "r3abcd",
  } satisfies FeedItem,
  llmTurn: turn("17:0", "p2", 3, true),
  botTurn: turn("18:0", "p5", 9, false),
  end: {
    k: "end",
    ...base("19:0", ["p1", "p4"], 3),
    reason: "domination",
    winners: ["p1", "p4"],
  } satisfies FeedItem,
} as const;

const ALL: readonly FeedEntry[] = Object.values(ITEMS).map((item) => ({
  seq: seqOfItem(item.id) ?? -1,
  item,
}));

const ids = (entries: readonly FeedEntry[]): string[] => entries.map((e) => e.item.id);
const view = (o: Partial<FeedView>): FeedView => ({ ...DEFAULT_VIEW, ...o });
const shown = (o: Partial<FeedView>): string[] => ids(filterFeed(ALL, view(o)));

describe("feed chips", () => {
  test("All: everything but bot turns and background launches; spying and foundings included", () => {
    const all = shown({});
    expect(all).toContain(ITEMS.founding.id);
    expect(all).toContain(ITEMS.spy.id);
    expect(all).toContain(ITEMS.llmTurn.id);
    expect(all).not.toContain(ITEMS.botTurn.id);
    expect(all).not.toContain(ITEMS.shipment.id);
    expect(all).toHaveLength(ALL.length - 2);
    expect(shown({ showBots: true })).toContain(ITEMS.botTurn.id);
  });

  test("Diplomacy: messages, proposals, alliances, betrayals, attacks on allies, the end", () => {
    expect(shown({ filter: "diplomacy" })).toEqual([
      "1:0",
      "2:0",
      "3:0",
      "4:0",
      "5:0",
      "6:0",
      "8:0",
      "13:0",
      "19:0",
    ]);
  });

  test("Military: launches that matter, battles, betrayals, conquests, the end; never spying", () => {
    expect(shown({ filter: "military" })).toEqual([
      "7:0",
      "8:0",
      "9:0",
      "11:0",
      "12:0",
      "13:0",
      "14:0",
      "19:0",
    ]);
  });

  test("Thoughts: agents' turns, bots' behind the toggle or when no agent plays", () => {
    expect(shown({ filter: "thoughts" })).toEqual(["17:0"]);
    expect(shown({ filter: "thoughts", showBots: true })).toEqual(["17:0", "18:0"]);
    expect(shown({ filter: "thoughts", botsOnly: true })).toEqual(["17:0", "18:0"]);
    // "All" stays free of bot turns in a bots-only match: they are the Thoughts chip's.
    expect(shown({ botsOnly: true })).not.toContain(ITEMS.botTurn.id);
  });

  test("Private only: private messages and proposals, never a public message", () => {
    expect(shown({ filter: "private" })).toEqual(["2:0", "3:0", "4:0", "5:0"]);
    expect(inCategory(ITEMS.publicMsg, "private", false)).toBe(false);
  });

  test("the player multi-select keeps items involving any picked player", () => {
    expect(shown({ filter: "diplomacy", players: ["p4"] })).toEqual(["3:0", "19:0"]);
    expect(shown({ filter: "military", players: ["p6", "p5"] })).toEqual(["9:0"]);
    expect(shown({ filter: "thoughts", players: ["p1"] })).toEqual([]);
  });
});

describe("pair mode", () => {
  test("everything between two players, both ways, in time order; chips and players ignored", () => {
    const expected = ["2:0", "4:0", "5:0", "6:0", "7:0", "8:0", "11:0", "13:0"];
    expect(shown({ pair: ["p2", "p3"] })).toEqual(expected);
    expect(shown({ pair: ["p3", "p2"], filter: "thoughts", players: ["p1"] })).toEqual(expected);
  });

  test("a relief fights the besieger, not the city's owner; neutral battles involve no pair", () => {
    expect(between(ITEMS.relief, "p2", "p6")).toBe(true);
    expect(between(ITEMS.relief, "p2", "p5")).toBe(true);
    expect(between(ITEMS.neutralBattle, "p2", "p3")).toBe(false);
    expect(between(ITEMS.conquest, "p2", "p4")).toBe(true);
    expect(between(ITEMS.publicMsg, "p1", "p2")).toBe(false);
    expect(between(ITEMS.llmTurn, "p2", "p3")).toBe(false);
    expect(between(ITEMS.end, "p1", "p4")).toBe(true);
    expect(visible(ITEMS.groupMsg, view({ pair: ["p4", "p3"] }))).toBe(true);
    expect(visible(ITEMS.groupMsg, view({ pair: ["p2", "p3"] }))).toBe(false);
  });
});

describe("lookups", () => {
  test("the window keeps the last items and counts the hidden ones", () => {
    expect(windowOf([1, 2, 3, 4, 5], 3)).toEqual({ shown: [3, 4, 5], hidden: 2 });
    // While playing and following the bottom, the default window shrinks; paused, it is back.
    expect(windowLimit(WINDOW, true, true)).toBe(PLAYING_WINDOW);
    expect(windowLimit(WINDOW, false, true)).toBe(WINDOW);
    expect(windowLimit(WINDOW, true, false)).toBe(WINDOW);
    expect(windowLimit(WINDOW * 2, true, true)).toBe(WINDOW * 2);
    const all = [1, 2];
    expect(windowOf(all, 300).shown).toBe(all);
  });

  test("older pages merge before the local feed without duplicates", () => {
    const local = ALL.slice(5);
    const older = ALL.slice(0, 7);
    const merged = mergeEntries(older, local);
    expect(ids(merged)).toEqual(ids(ALL));
    expect(mergeEntries([], local)).toBe(local);
  });

  test("older pages never show what lies after the playhead (a seek back, an empty local feed)", () => {
    const older = ALL.slice(0, 7);
    const cursor = older[2]?.seq ?? 0;
    expect(ids(mergeEntries(older, [], cursor))).toEqual(ids(ALL.slice(0, 3)));
    expect(ids(mergeEntries(older, ALL.slice(1, 2), cursor))).toEqual(ids(ALL.slice(0, 2)));
  });

  test("a message's same-turn thought by seat and turn; a seat's turns in order", () => {
    const index = turnIndex(ALL);
    expect(index.get("p2:3")?.item).toBe(ITEMS.llmTurn);
    // The sender's turn the message was sent in: not the turn before, not a recipient's.
    const at = sameTurnOf(ITEMS.privateMsg);
    expect(at).toEqual({ seat: "p2", turn: 3 });
    expect(at === null ? undefined : index.get(turnKeyOf(at.seat, at.turn))?.item).toBe(
      ITEMS.llmTurn,
    );
    expect(sameTurnOf(message("40:0", "p3", ["p2"], 7))).toEqual({ seat: "p3", turn: 7 });
    expect(sameTurnOf(message("41:0", "p3", ["p2"], null))).toBeNull();
    expect(index.get("p2:4")).toBeUndefined();
    expect(turnsOf(ALL, "p5").map((t) => t.turn)).toEqual([9]);
  });

  test("an entry by cursor and id, by binary search", () => {
    const feed: FeedEntry[] = [
      { seq: 3, item: ITEMS.publicMsg },
      { seq: 7, item: ITEMS.attack },
      { seq: 7, item: ITEMS.relief },
      { seq: 9, item: ITEMS.battle },
    ];
    expect(findEntry(feed, 7, ITEMS.relief.id)?.item).toBe(ITEMS.relief);
    expect(findEntry(feed, 9, ITEMS.battle.id)?.seq).toBe(9);
    expect(findEntry(feed, 8, ITEMS.battle.id)).toBeNull();
    expect(findEntry([], 1, "1:0")).toBeNull();
    expect(seqOfItem("7048:0")).toBe(7048);
    expect(seqOfItem("x:0")).toBeNull();
  });

  test("a private message was seen by its sender and recipients only", () => {
    expect(seenBy(ITEMS.privateMsg)).toEqual(["p2", "p3"]);
    expect(seenBy(ITEMS.groupMsg)).toEqual(["p4", "p2", "p3"]);
    expect(seenBy(ITEMS.publicMsg)).toBe("all");
  });

  test("alliances by id from the feed's history: a dissolved one keeps its name and members", () => {
    const feed = [
      dip(1, "alliance_formed", "a2", ["p2", "p3"], "League p2"),
      dip(2, "alliance_dissolved", "a2", ["p3"], null),
      dip(3, "alliance_formed", "a3", ["p2", "p5"], "League p2"),
      dip(4, "alliance_joined", "a3", ["p6"], null),
    ];
    const names = allianceNamesOf(feed);
    expect(names.get("a2")).toEqual({ name: "League p2", members: ["p2", "p3"] });
    expect(names.get("a3")).toEqual({ name: "League p2", members: ["p2", "p5", "p6"] });
    expect(allianceNamesOf(feed)).toBe(names);
  });

  test("a betrayal's battle: the betrayer's attack on the city at that time, before it", () => {
    const at = 305_433;
    const battle = (seq: number, attacker: PlayerId, city: `c${number}`, t = at): FeedEntry => ({
      seq,
      item: {
        k: "battle",
        ...base(`${seq}:0`, [attacker, "p3"]),
        t,
        city,
        attacker,
        defender: "p3",
        kind: "city",
        winner: "defender",
        reports: [],
        siege: null,
        fell: false,
      },
    });
    const betrayal = {
      k: "betrayal",
      ...base("7048:0", ["p2", "p3"], 3),
      t: at,
      by: "p2",
      against: "p3",
      relation: "ally",
      city: "c18",
      context: { messages: [], thoughts: [], since: null },
    } satisfies FeedItem;
    const feed: FeedEntry[] = [
      battle(7000, "p2", "c18", at - 60),
      battle(7044, "p4", "c18"),
      battle(7045, "p2", "c18"),
      { seq: 7048, item: betrayal },
      battle(7050, "p2", "c18"),
    ];
    expect(betrayalBattle(feed, 7048, betrayal)?.id).toBe("7045:0");
    expect(betrayalBattle(feed.slice(0, 2), 7048, betrayal)).toBeNull();
  });
});
