// The dossier's series, pure (`fold/series.ts`, `reduce/dossier.ts`): a notebook edit rebuilds the
// version exactly (fast-check, surrogate pairs included), a write that changes nothing is not a
// version, the history keeps its newest versions within its budgets and stores the oldest kept one
// whole, hourly points come from the projection, and a seat's record counts each message and
// betrayal once on each side. The war golden and a fake run are checked in `war.test.ts` and
// `live.test.ts`, on the folds they already make.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { FeedItem, FeedItemOf, PlayerEnt } from "@perfidia/protocol";
import { notebookTexts, seatTally } from "../reduce/dossier.ts";
import { NOTEBOOK_HISTORY_MAX_CHARS, NotebookLog, SeatSeries, spliceOf } from "./series.ts";

const rebuild = (prev: string, e: ReturnType<typeof spliceOf>): string =>
  prev.slice(0, e.head) + e.text + prev.slice(prev.length - e.tail);

describe("spliceOf", () => {
  test("an append, an edit in the middle, a rewrite, a clear", () => {
    expect(spliceOf("plan", "plan\ngrow")).toEqual({ head: 4, tail: 0, text: "\ngrow" });
    expect(spliceOf('{"a":1,"b":2}', '{"a":1,"b":3}')).toEqual({ head: 11, tail: 1, text: "3" });
    expect(spliceOf("abc", "xyz")).toEqual({ head: 0, tail: 0, text: "xyz" });
    expect(spliceOf("abc", "")).toEqual({ head: 0, tail: 0, text: "" });
    expect(spliceOf("aaa", "aaaa")).toEqual({ head: 3, tail: 0, text: "a" });
  });

  test("never splits a surrogate pair", () => {
    // 😀 and 😁 share their high surrogate.
    const e = spliceOf("x😀y", "x😁y");
    expect(e).toEqual({ head: 1, tail: 1, text: "😁" });
  });

  test("rebuilds the new text from the old one, for any two texts", () => {
    const text = fc.string({
      unit: fc.constantFrom("a", "b", "\n", "😀", "😁", "é"),
      maxLength: 30,
    });
    fc.assert(
      fc.property(text, text, (a, b) => {
        const e = spliceOf(a, b);
        expect(rebuild(a, e)).toBe(b);
        expect(e.head + e.tail).toBeLessThanOrEqual(Math.min(a.length, b.length));
        expect(e.text.length > 0 && /^[\uDC00-\uDFFF]/.test(e.text)).toBe(false);
      }),
      { numRuns: 400 },
    );
  });
});

describe("NotebookLog", () => {
  test("a write that leaves the text as it was is not a version", () => {
    const log = new NotebookLog();
    expect(log.add(10, 1, "replace", "")).toBe(false);
    expect(log.add(20, 1, "replace", "plan")).toBe(true);
    expect(log.add(30, 2, "replace", "plan")).toBe(false);
    expect(log.add(40, 3, "append", "plan\ngrow")).toBe(true);
    expect(log.add(50, 4, "replace", "")).toBe(true);
    expect(log.history()).toEqual({
      total: 3,
      versions: [
        { t: 20, turn: 1, mode: "replace", head: 0, tail: 0, text: "plan" },
        { t: 40, turn: 3, mode: "append", head: 4, tail: 0, text: "\ngrow" },
        { t: 50, turn: 4, mode: "replace", head: 0, tail: 0, text: "" },
      ],
    });
    expect(notebookTexts(log.history())).toEqual(["plan", "plan\ngrow", ""]);
  });

  test("keeps the newest versions within its budgets; the oldest kept is whole", () => {
    const log = new NotebookLog({ maxChars: 20, maxVersions: 3 });
    const texts = ["a", "ab", "abc", "abcd", "0123456789abcdef", "0123456789abcdefXYZ"];
    for (const [i, x] of texts.entries()) log.add(i, i, "replace", x);
    const h = log.history();
    expect(h.total).toBe(6);
    // Three at most; then 16 + 3 characters of edits fit, a third version stored whole does not.
    expect(h.versions.map((v) => [v.head, v.tail, v.text])).toEqual([
      [0, 0, "0123456789abcdef"],
      [16, 0, "XYZ"],
    ]);
    expect(notebookTexts(h)).toEqual(texts.slice(4));
  });

  test("any sequence of writes: the kept versions are the newest distinct ones, in order", () => {
    const text = fc.string({ unit: fc.constantFrom("a", "b", "\n", "😀"), maxLength: 12 });
    fc.assert(
      fc.property(
        fc.array(text, { maxLength: 30 }),
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 0, max: 40 }),
        (writes, maxVersions, maxChars) => {
          const log = new NotebookLog({ maxChars, maxVersions });
          const distinct: string[] = [];
          for (const [i, w] of writes.entries()) {
            if (log.add(i, i, "replace", w)) distinct.push(w);
            expect(w === (distinct.at(-1) ?? "")).toBe(true);
          }
          const h = log.history();
          expect(h.total).toBe(distinct.length);
          const texts = notebookTexts(h);
          expect(texts).toEqual(distinct.slice(distinct.length - h.versions.length));
          if (distinct.length > 0) expect(h.versions.length).toBeGreaterThan(0);
          expect(h.versions.length).toBeLessThanOrEqual(maxVersions);
          const chars = h.versions.reduce((n, v) => n + v.text.length, 0);
          expect(h.versions.length === 1 || chars <= maxChars).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  test("the worst case stays small: 4,000-character rewrites of random CJK text", () => {
    // A seeded generator (xorshift32): the same text on every run.
    let x = 2_463_534_242;
    const next = (): number => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return (x >>> 0) / 4_294_967_296;
    };
    const log = new NotebookLog();
    for (let i = 0; i < 60; i += 1) {
      const text = Array.from({ length: 4_000 }, () =>
        String.fromCharCode(0x4e_00 + Math.floor(next() * 20_000)),
      ).join("");
      log.add(i * 3_600, i, "replace", text);
    }
    const h = log.history();
    expect(h.total).toBe(60);
    expect(h.versions).toHaveLength(NOTEBOOK_HISTORY_MAX_CHARS / 4_000);
    // With 720 hourly points (30 days), a dossier stays under 64 KB gzipped.
    const hourly = Array.from({ length: 720 }, (_, i) => ({
      t: i * 3_600,
      score: 9_999,
      cities: 12,
    }));
    const gz = Bun.gzipSync(
      JSON.stringify({ notes: "x".repeat(4_000), hourly, notebook: h }),
    ).length;
    expect(gz).toBeLessThan(64 * 1_024);
    console.log(
      `worst-case dossier (random CJK notebooks, 720 hourly points): ${gz} bytes gzipped`,
    );
  });

  test("an edit that does not fit the version before it is refused", () => {
    expect(
      notebookTexts({
        total: 2,
        versions: [
          { t: 0, turn: 1, mode: "replace", head: 0, tail: 0, text: "ab" },
          { t: 1, turn: 2, mode: "replace", head: 2, tail: 1, text: "c" },
        ],
      }),
    ).toBeNull();
    expect(
      notebookTexts({
        total: 1,
        versions: [{ t: 0, turn: 1, mode: "replace", head: 1, tail: 0, text: "b" }],
      }),
    ).toBeNull();
  });
});

const ent = (id: `p${number}`, score: number, cities: number): PlayerEnt => ({
  id,
  alive: true,
  eliminatedAt: null,
  alliance: null,
  rank: 1,
  score,
  parts: {},
  cities,
  relations: [],
  army: { pop: 0, units: {} },
  ext: {},
});

describe("SeatSeries", () => {
  test("a point per checkpoint per seat, from the projection; a key that moves with them", () => {
    const s = new SeatSeries(["p1", "p2"]);
    const key0 = s.key("p1");
    s.checkpoint(3600, (p) => (p === "p1" ? ent("p1", 120, 1) : ent("p2", 90, 1)));
    s.checkpoint(7200, (p) => (p === "p1" ? ent("p1", 135, 2) : undefined));
    expect(s.hourly("p1")).toEqual([
      { t: 3600, score: 120, cities: 1 },
      { t: 7200, score: 135, cities: 2 },
    ]);
    expect(s.hourly("p2")).toEqual([{ t: 3600, score: 90, cities: 1 }]);
    expect(s.key("p1")).not.toBe(key0);
    const key1 = s.key("p1");
    s.note("p1", 7300, 3, "replace", "plan");
    expect(s.key("p1")).not.toBe(key1);
    expect(s.notebook("p1").versions.map((v) => v.text)).toEqual(["plan"]);
    expect(s.notebook("p9")).toEqual({ total: 0, versions: [] });
    // Copies: a caller cannot change the series.
    s.hourly("p1").pop();
    expect(s.hourly("p1")).toHaveLength(2);
  });
});

const base = { importance: 1 };
const message = (id: string, from: `p${number}`, to: FeedItemOf<"message">["to"]): FeedItem => ({
  ...base,
  k: "message",
  id,
  t: 10,
  players: [from],
  message: "g1abcd",
  from,
  to,
  private: to !== "all",
  text: "hi",
  turn: 1,
});

describe("seatTally", () => {
  test("turns, messages both ways, betrayals once on each side", () => {
    const turn = (id: string, seat: `p${number}`): FeedItem => ({
      ...base,
      k: "turn",
      id,
      t: 20,
      players: [seat],
      seat,
      turn: 1,
      llm: false,
      wakeT: null,
      reasons: [],
      urgent: false,
      why: "end_turn",
      rounds: 1,
      calls: 1,
      accepted: 1,
      rejected: [],
      messages: [],
      thought: null,
    });
    const items: FeedItem[] = [
      message("1:0", "p1", ["p2"]),
      message("2:0", "p2", "all"),
      message("3:0", "p3", ["p1", "p2"]),
      message("4:0", "p1", "all"),
      turn("5:0", "p1"),
      turn("6:0", "p2"),
      turn("7:0", "p1"),
      {
        ...base,
        k: "betrayal",
        id: "8:0",
        t: 30,
        players: ["p2", "p3"],
        importance: 3,
        by: "p2",
        against: "p3",
        relation: "ally",
        city: "c18",
        context: { messages: [], thoughts: [], since: null },
      },
    ];
    expect(seatTally(items, "p1")).toEqual({
      turns: 2,
      messagesSent: 2,
      messagesReceived: 2,
      betrayalsCommitted: 0,
      betrayalsSuffered: 0,
    });
    expect(seatTally(items, "p2")).toMatchObject({
      turns: 1,
      messagesSent: 1,
      messagesReceived: 3,
      betrayalsCommitted: 1,
      betrayalsSuffered: 0,
    });
    expect(seatTally(items, "p3")).toMatchObject({
      messagesSent: 1,
      messagesReceived: 2,
      betrayalsCommitted: 0,
      betrayalsSuffered: 1,
    });
    expect(seatTally([], "p1").turns).toBe(0);
  });
});
