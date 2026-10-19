import { describe, expect, test } from "bun:test";
import type {
  AnnotationRound,
  FeedItem,
  TurnAnnotation,
  TurnCall,
} from "@perfidia/protocol/spectator";
import type { FeedEntry } from "../playback/timeline.ts";
import type { AnnotMsg } from "../store/match.ts";
import {
  callTally,
  findTurnItem,
  fmtLatency,
  roundsUpTo,
  shapeRounds,
  tokenSum,
  totalsOf,
  turnMessages,
  whyWords,
  type RoundRow,
} from "./detail.ts";

const TOKENS = { input: 10, cacheWrite5m: 100, cacheWrite1h: 0, cacheRead: 1_000, output: 50 };

function round(n: number, calls: string[], o: Partial<AnnotationRound> = {}): AnnotationRound {
  return {
    round: n,
    kind: "round",
    attempts: 1,
    stop: "tool_use",
    refusal: null,
    errors: [],
    reasoning: [`thinking ${n}`],
    text: [],
    calls,
    costNanoUsd: 1_000_000,
    tokens: TOKENS,
    latencyMs: 1_500,
    ...o,
  };
}

function annotation(rounds: AnnotationRound[]): TurnAnnotation {
  return { seat: "p1", turn: 2, complete: true, rounds, spentNanoUsd: 9, capNanoUsd: 99 };
}

const call = (rt: number | null, tool: string, items = 1, ok = items, codes: string[] = []) =>
  ({ rt, tool, items, ok, codes }) satisfies TurnCall;

function live(n: number, calls: string[], o: Partial<AnnotMsg> = {}): AnnotMsg {
  return {
    type: "annot",
    match: "m",
    seat: "p1",
    turn: 2,
    round: n,
    kind: "round",
    reasoning: [`live ${n}`],
    text: [],
    calls,
    complete: false,
    ...o,
  };
}

/** `tool verdict codes` per round, compact. */
const view = (rows: readonly RoundRow[]): string[][] =>
  rows.map((r) => [
    r.key,
    ...r.calls.map(
      (c) =>
        `${c.tool} ${c.verdict}${c.items > 1 ? ` ${c.ok}/${c.items}` : ""}${c.implicit ? " implicit" : ""}${c.codes.length > 0 ? ` ${c.codes.join(",")}` : ""}`,
    ),
  ]);

describe("a closed turn's rounds", () => {
  test("each round's reply names meet the log's calls: batches, rejections, notes, end_turn", () => {
    const a = annotation([
      round(0, ["rules", "view_city"]),
      round(1, ["answer_proposal", "build", "propose_alliance"]),
      round(2, ["write_note", "end_turn"]),
    ]);
    const results = [
      call(0, "rules"),
      call(0, "view_city"),
      call(1, "answer_proposal", 1, 0, ["PACT_LIMIT"]),
      call(1, "build", 5, 3, ["NO_RESOURCES", "QUEUE_FULL"]),
      call(1, "propose_alliance"),
      // An accepted write_note: its note line has no round; it is round 2's.
      call(null, "write_note"),
    ];
    const r = shapeRounds({ annotation: a, live: [], results });
    expect(r.verdicts).toBe(true);
    expect(view(r.rounds)).toEqual([
      ["round:0", "rules ok", "view_city ok"],
      [
        "round:1",
        "answer_proposal rejected PACT_LIMIT",
        "build partial 3/5 NO_RESOURCES,QUEUE_FULL",
        "propose_alliance ok",
      ],
      ["round:2", "write_note ok", "end_turn ok implicit"],
    ]);
    expect(callTally(r.rounds)).toEqual({
      calls: 7,
      accepted: 5,
      partial: 1,
      rejected: 1,
      pending: 0,
    });
    expect(r.totals).toMatchObject({ costNanoUsd: 3_000_000, latencyMs: 4_500, metered: 3 });
    expect(tokenSum(r.totals.tokens)).toBe(3 * 1_160);
  });

  test("a note between two rounds' calls goes to the round whose reply names it", () => {
    const a = annotation([round(0, ["write_note", "view_map"]), round(1, ["write_note"])]);
    const results = [call(null, "write_note"), call(0, "view_map"), call(null, "write_note")];
    expect(view(shapeRounds({ annotation: a, live: [], results }).rounds)).toEqual([
      ["round:0", "write_note ok", "view_map ok"],
      ["round:1", "write_note ok"],
    ]);
  });

  test("a rejected end_turn has its line; a call no reply names is still listed", () => {
    const a = annotation([round(0, ["end_turn", "mystery"])]);
    const results = [call(0, "end_turn", 1, 0, ["WAKE_TOO_LATE"]), call(0, "recruit")];
    expect(view(shapeRounds({ annotation: a, live: [], results }).rounds)).toEqual([
      ["round:0", "end_turn rejected WAKE_TOO_LATE", "mystery unknown", "recruit ok"],
    ]);
  });

  test("without an annotation the rounds come from the log alone", () => {
    const results = [call(1, "build", 2, 2), call(0, "rules"), call(null, "write_note")];
    const r = shapeRounds({ annotation: null, live: [], results });
    expect(view(r.rounds)).toEqual([
      ["round:0", "rules ok", "write_note ok"],
      ["round:1", "build ok 2/2"],
    ]);
    expect(r.rounds.every((x) => x.meter === null && x.reasoning.length === 0)).toBe(true);
    expect(r.totals.metered).toBe(0);
  });

  test("a call placed in no round is kept apart, and thought calls come last", () => {
    const a = annotation([
      round(0, [], { kind: "thought_call", reasoning: ["the thought"] }),
      round(0, ["write_note"]),
    ]);
    const r = shapeRounds({ annotation: null, live: [], results: [call(null, "write_note")] });
    expect(view(r.rounds)).toEqual([["loose", "write_note ok"]]);
    const t = shapeRounds({ annotation: a, live: [], results: [] });
    expect(t.rounds.map((x) => x.key)).toEqual(["round:0", "thought_call:0"]);
    // A reply's call with no log line: not known (the turn's results are known, but empty).
    expect(view(t.rounds)[0]).toEqual(["round:0", "write_note unknown"]);
  });

  test("long tool names are matched as the fold cuts them (64 characters)", () => {
    const long = "x".repeat(80);
    const a = annotation([round(0, [long])]);
    const r = shapeRounds({
      annotation: a,
      live: [],
      results: [call(0, "x".repeat(64), 1, 0, ["UNKNOWN_TOOL"])],
    });
    expect(r.rounds[0]?.calls.map((c) => c.verdict)).toEqual(["rejected"]);
  });
});

describe("an open turn's rounds (live)", () => {
  test("live rounds join the annotation's: newer text, the annotation's figures", () => {
    const a = annotation([round(0, ["rules"]), round(1, ["view_city"])]);
    const msgs = [live(1, ["view_city", "view_map"], { text: ["resent"] }), live(2, ["build"])];
    const r = shapeRounds({ annotation: a, live: msgs, results: null });
    expect(r.verdicts).toBe(false);
    expect(r.rounds.map((x) => [x.key, x.reasoning[0], x.meter === null])).toEqual([
      ["round:0", "thinking 0", false],
      ["round:1", "live 1", false],
      ["round:2", "live 2", true],
    ]);
    expect(r.rounds[1]?.text).toEqual(["resent"]);
    expect(view(r.rounds)).toEqual([
      ["round:0", "rules pending"],
      ["round:1", "view_city pending", "view_map pending"],
      ["round:2", "build pending"],
    ]);
    expect(callTally(r.rounds)).toEqual({
      calls: 4,
      accepted: 0,
      partial: 0,
      rejected: 0,
      pending: 4,
    });
    expect(r.totals.metered).toBe(2);
  });

  test("live messages alone, out of order and resent: one row per round, the last one wins", () => {
    const msgs = [
      live(1, ["b"]),
      live(0, ["a"]),
      live(0, [], { kind: "thought_call", reasoning: ["thought"] }),
      live(1, ["g2"], { reasoning: ["retried"] }),
    ];
    const r = shapeRounds({ annotation: null, live: msgs, results: null });
    expect(r.rounds.map((x) => [x.key, x.reasoning.join("")])).toEqual([
      ["round:0", "live 0"],
      ["round:1", "retried"],
      ["thought_call:0", "thought"],
    ]);
  });

  test("replayed with the playhead inside: the rounds reached, their totals, the cost after", () => {
    // Three rounds and a closing thought call of 11, 18, 11 and 4 thousandths of a dollar.
    const a = annotation([
      round(0, ["rules"], { costNanoUsd: 11_000_000 }),
      round(1, ["view_city"], { costNanoUsd: 18_000_000 }),
      round(2, ["build"], { costNanoUsd: 11_000_000 }),
      round(0, [], { kind: "thought_call", costNanoUsd: 4_000_000 }),
    ]);
    const all = shapeRounds({ annotation: a, live: [], results: null });
    expect(all.totals.attempts).toBe(4);
    const at1 = roundsUpTo(all, 1);
    expect(at1.rounds.map((r) => r.key)).toEqual(["round:0", "round:1"]);
    expect(at1.totals).toEqual(totalsOf(at1.rounds));
    expect([at1.totals.costNanoUsd, at1.totals.attempts, at1.totals.metered]).toEqual([
      29_000_000, 2, 2,
    ]);
    expect(tokenSum(at1.totals.tokens)).toBe(2 * tokenSum(TOKENS));
    expect(at1.laterCostNanoUsd).toBe(15_000_000);
    // Before the first logged call: nothing yet; the whole turn's cost comes later.
    const none = roundsUpTo(all, null);
    expect([none.rounds.length, none.totals.metered, none.laterCostNanoUsd]).toEqual([
      0, 0, 44_000_000,
    ]);
    expect(roundsUpTo(all, 2).laterCostNanoUsd).toBe(4_000_000);
  });

  test("once the turn closes, its results give the live rounds their verdicts", () => {
    const msgs = [live(0, ["rules", "end_turn"])];
    const r = shapeRounds({ annotation: null, live: msgs, results: [call(0, "rules")] });
    expect(view(r.rounds)).toEqual([["round:0", "rules ok", "end_turn ok implicit"]]);
  });
});

function entry(seq: number, item: FeedItem): FeedEntry {
  return { seq, item };
}

const base = (seq: number, t: number) => ({
  id: `${seq}:0`,
  t,
  players: ["p1" as const],
  importance: 1,
});

const msg = (seq: number, turn: number | null, id: `g${string}`): FeedEntry =>
  entry(seq, {
    k: "message",
    ...base(seq, seq),
    message: id,
    from: "p1",
    to: ["p2"],
    private: true,
    text: `m${seq}`,
    turn,
  });
const turnItem = (seq: number, turn: number, messages: `g${string}`[]): FeedEntry =>
  entry(seq, {
    k: "turn",
    ...base(seq, seq),
    seat: "p1",
    turn,
    llm: true,
    wakeT: 0,
    reasons: ["start"],
    urgent: false,
    why: "end_turn",
    rounds: 1,
    calls: 1,
    accepted: 1,
    rejected: [],
    messages,
    thought: null,
  });

describe("the feed's side of a turn", () => {
  const feed = [
    msg(1, 1, "g1"),
    turnItem(2, 1, ["g1"]),
    msg(3, 2, "g2"),
    msg(4, null, "g3"),
    turnItem(5, 2, ["g2", "g3"]),
    msg(6, 3, "g4"),
  ];

  test("finds the turn's item, and the messages it sent (an open turn's by their turn)", () => {
    expect(findTurnItem(feed, "p1", 2)?.seq).toBe(5);
    expect(findTurnItem(feed, "p1", 3)).toBeNull();
    expect(findTurnItem(feed, "p2", 1)).toBeNull();
    expect(turnMessages(feed, "p1", 2, ["g2", "g3"]).map((m) => m.message)).toEqual(["g2", "g3"]);
    expect(turnMessages(feed, "p1", 3).map((m) => m.message)).toEqual(["g4"]);
    expect(turnMessages(feed, "p2", 2)).toEqual([]);
  });

  test("words for endings and model time", () => {
    expect(whyWords("round_cap")).toBe("It reached the cap on rounds per turn.");
    expect(fmtLatency(0)).toBe("0.0 s");
    expect(fmtLatency(1_249)).toBe("1.2 s");
    expect(fmtLatency(12_400)).toBe("12 s");
    expect(fmtLatency(185_000)).toBe("3 min 5 s");
    expect(fmtLatency(120_000)).toBe("2 min");
  });
});
