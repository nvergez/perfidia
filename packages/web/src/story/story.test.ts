import { describe, expect, test } from "bun:test";
import type { FeedItem, Frame, Moment, Standing } from "@perfidia/protocol/spectator";
import type { PlayerId } from "../lib/ids.ts";
import type { FeedEntry } from "../playback/timeline.ts";
import type { DominationView } from "../skins/index.ts";
import { buildStory, storyClock, storyText, type StoryInput } from "./story.ts";

// The story strip's templates (phase-3 design §4.3): the leader and the margin, the bloc closest
// to a domination win (or its running countdown), the last betrayal, and the attack on an ally in
// flight, from the frame and the moments alone.

const NAMES: Readonly<Record<string, string>> = {
  p1: "Odysseus",
  p2: "Achilles",
  p3: "Penelope",
  p4: "Agamemnon",
};
const label = (id: string): string => `${NAMES[id] ?? "?"} · ${id}`;

const standing = (player: PlayerId, rank: number, score: number, alive = true): Standing => ({
  player,
  rank,
  score,
  parts: {},
  cities: 1,
  alive,
});

const D = 86_400;
const H = 3_600;

function dom(o: Partial<DominationView> = {}): DominationView {
  return {
    open: true,
    need: 16,
    needTaken: 2,
    slots: 43,
    blocs: [
      { key: "a1", members: ["p1", "p4"], cities: 14, taken: 1 },
      { key: "p3", members: ["p3"], cities: 4, taken: 0 },
    ],
    countdowns: [],
    opensAt: 3 * D,
    hold: D,
    startBy: 5 * D,
    ...o,
  };
}

const ALLIANCES: Frame["alliances"] = {
  a1: { id: "a1", name: "War p1", members: ["p1", "p4"], formedAt: 1000 },
};

const BETRAYAL: FeedItem = {
  k: "betrayal",
  id: "7048:0",
  t: 4 * D - 3 * H,
  players: ["p2", "p3"],
  importance: 3,
  by: "p2",
  against: "p3",
  relation: "ally",
  city: "c18",
  context: { messages: [], thoughts: [], since: null },
};

const LAUNCH: FeedItem = {
  k: "launch",
  id: "6618:0",
  t: 3 * D,
  players: ["p2", "p3"],
  importance: 3,
  movement: "m1abcd",
  kind: "attack",
  owner: "p2",
  from: "c2",
  to: "c18",
  toIsland: "i4",
  target: "p3",
  departAt: 3 * D,
  arriveAt: 3 * D + 12 * H + 50 * 60,
  units: {},
  pop: 10,
  settlers: false,
  foe: "p3",
  againstAlly: "ally",
  context: null,
};

function momentOf(seq: number, item: FeedItem, title = "a moment"): Moment {
  return {
    item: item.id,
    seq,
    t: item.t,
    k: item.k,
    importance: item.importance,
    title,
    players: [...item.players],
    cities: [],
  };
}

function input(o: Partial<StoryInput> = {}): StoryInput {
  return {
    t: 4 * D + 14 * H + 20 * 60,
    standings: [standing("p1", 1, 1312), standing("p2", 2, 1260), standing("p3", 3, 900)],
    result: null,
    domination: dom(),
    alliances: ALLIANCES,
    movements: {},
    moments: [],
    feed: [],
    ...o,
  };
}

describe("story strip", () => {
  test("the clock reads Day N, HH:MM", () => {
    expect(storyClock(0)).toBe("Day 1, 00:00");
    expect(storyClock(4 * D + 14 * H + 20 * 60 + 59)).toBe("Day 5, 14:20");
  });

  test("leader with the margin over the second, and the leading bloc against the threshold", () => {
    expect(storyText(buildStory(input()), label)).toBe(
      "Day 5, 14:20 · Odysseus · p1 leads with 1,312, 52 ahead of Achilles · p2 · War p1 (p1, p4) holds 14 of the 16 cities a win needs, 1 of 2 taken",
    );
  });

  test("a tie, an eliminated leader skipped, a lone bloc, before the window opens", () => {
    const s = buildStory(
      input({
        t: D,
        standings: [standing("p4", 1, 900, false), standing("p1", 2, 700), standing("p2", 3, 700)],
        domination: dom({
          open: false,
          blocs: [{ key: "p3", members: ["p3"], cities: 5, taken: 0 }],
        }),
      }),
    );
    expect(storyText(s, label)).toBe(
      "Day 2, 00:00 · Odysseus · p1 leads with 700, tied with Achilles · p2 · Penelope · p3 holds 5 of the 16 cities a win needs, 0 of 2 taken (domination opens at D4 00:00)",
    );
  });

  test("a running countdown names its end and the time left", () => {
    const s = buildStory(
      input({
        t: 5 * D + 18 * H,
        domination: dom({
          countdowns: [
            { key: "a1", members: ["p1", "p4"], cities: 16, taken: 2, endsAt: 6 * D + 18 * H },
          ],
        }),
      }),
    );
    expect(s.find((x) => x.key === "bloc")?.parts).toBeDefined();
    expect(storyText(s, label)).toContain(
      "War p1 (p1, p4) holds 16 cities, 2 taken: wins at D7 18:00 (in 1 d) if it holds",
    );
  });

  test("the last betrayal, with how long ago", () => {
    const feed: FeedEntry[] = [{ seq: 7048, item: BETRAYAL }];
    const s = buildStory(input({ t: 4 * D, moments: [momentOf(7048, BETRAYAL)], feed }));
    const irony = s.at(-1);
    expect(irony?.tone).toBe("betrayal");
    expect(storyText(s, label)).toEndWith(
      "Last betrayal: Achilles · p2 attacked its ally Penelope · p3 at c18, 3 h ago",
    );
    const pact = { ...BETRAYAL, relation: "pact" as const };
    const s2 = buildStory(
      input({ t: 4 * D, moments: [momentOf(7048, pact)], feed: [{ seq: 7048, item: pact }] }),
    );
    expect(storyText(s2, label)).toEndWith(
      "Last betrayal: Achilles · p2 broke its pact with Penelope · p3 at c18, 3 h ago",
    );
  });

  test("an attack on an ally in flight wins over the last betrayal, until it lands", () => {
    const feed: FeedEntry[] = [
      { seq: 6618, item: LAUNCH },
      { seq: 7048, item: BETRAYAL },
    ];
    const moments = [momentOf(6618, LAUNCH), momentOf(7048, BETRAYAL)];
    const flying = buildStory(
      input({
        t: 3 * D + H,
        moments: moments.slice(0, 1),
        feed: feed.slice(0, 1),
        movements: {
          m1abcd: {
            id: "m1abcd",
            kind: "attack",
            owner: "p2",
            home: "c2",
            from: "c2",
            fromIsland: "i1",
            to: "c18",
            toIsland: "i4",
            party: "p3",
            units: {},
            cargo: { wood: 0, stone: 0, gold: 0 },
            gold: 0,
            departAt: LAUNCH.t,
            arriveAt: 3 * D + 12 * H + 50 * 60,
            back: null,
            turnedAt: null,
          },
        },
      }),
    );
    expect(flying.at(-1)?.tone).toBe("danger");
    expect(storyText(flying, label)).toEndWith(
      "Achilles · p2 has launched an attack on its ally Penelope · p3; it lands at D4 12:50 (in 11 h 50 min)",
    );
    // Landed (the movement is gone from the frame): the betrayal is told instead.
    const landed = buildStory(input({ t: 4 * D, moments, feed, movements: {} }));
    expect(landed.at(-1)?.tone).toBe("betrayal");
  });

  test("without a betrayal, the latest key moment", () => {
    const end: FeedItem = {
      k: "end",
      id: "9:0",
      t: 2 * D,
      players: ["p1"],
      importance: 3,
      reason: "time",
      winners: ["p1"],
    };
    const s = buildStory(
      input({ t: 2 * D + H, moments: [momentOf(9, end, "The match ended (time): p1 wins")] }),
    );
    expect(storyText(s, label)).toEndWith("Latest: The match ended (time): p1 wins, 1 h ago");
  });

  test("an ended match names its winners and how they won, without the bloc sentence", () => {
    const s = buildStory(input({ result: { reason: "domination", winners: ["p1", "p4"] } }));
    expect(s.map((x) => x.key)).toEqual(["clock", "leader"]);
    expect(storyText(s, label)).toBe(
      "Day 5, 14:20 · The match is over: Odysseus · p1 and Agamemnon · p4 win by domination",
    );
    const one = buildStory(input({ result: { reason: "time", winners: ["p2"] } }));
    expect(storyText(one, label)).toContain("Achilles · p2 wins on points at the end");
  });

  test("tied blocs: no bloc is named; a match too short for domination: no bloc sentence", () => {
    const tied = buildStory(
      input({
        domination: dom({
          blocs: [
            { key: "p1", members: ["p1"], cities: 1, taken: 0 },
            { key: "p2", members: ["p2"], cities: 1, taken: 0 },
          ],
        }),
      }),
    );
    expect(storyText(tied, label)).toContain(
      "No bloc leads: each holds at most 1 of the 16 cities a win needs",
    );
    const short = buildStory(input({ domination: dom({ opensAt: 3 * D, startBy: 0 }) }));
    expect(short.map((x) => x.key)).toEqual(["clock", "leader"]);
  });

  test("a ruleset without domination: no bloc sentence", () => {
    const s = buildStory(input({ domination: null }));
    expect(s.map((x) => x.key)).toEqual(["clock", "leader"]);
  });
});
