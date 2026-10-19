// Applying steps to frames (phase-3 design §2.7): whole entities set or deleted, fields assigned on
// held entities only, arrays and `ext` replaced, cursor and time taken from the step, inputs never
// changed; the standings derived from the players; game time formatted exactly as the engine does.

import { describe, expect, test } from "bun:test";
import { fmtDuration, fmtTime } from "@perfidia/engine/core";
import type { Frame, Step } from "@perfidia/protocol";
import fc from "fast-check";
import { applyStep, applySteps, fmtGameDuration, fmtGameTime, standingsOf } from "./index.ts";

const player = (id: "p1" | "p2", rank: number, score: number) => ({
  id,
  alive: true,
  eliminatedAt: null,
  alliance: null,
  rank,
  score,
  parts: { cityPoints: score },
  cities: 1,
  relations: [],
  army: { pop: 0, units: {} },
  ext: {},
});

const seat = (id: "p1" | "p2") => ({
  seat: id,
  controller: "bot:turtle@3",
  inTurn: false,
  turn: 0,
  round: null,
  wakeT: null,
  reasons: [],
  urgent: false,
  next: null,
  lastThought: null,
  notesChars: 0,
  handoff: null,
});

const frame: Frame = {
  format: "perfidia-spectator/1",
  match: "m",
  timeline: "0123456789abcdef",
  seq: 0,
  t: 0,
  status: "live",
  result: null,
  ext: { a: 1 },
  cities: {},
  queues: {},
  movements: {},
  players: { p1: player("p1", 1, 120), p2: player("p2", 2, 100) },
  seats: { p1: seat("p1"), p2: seat("p2") },
  alliances: {},
  pacts: [],
  proposals: [],
};

describe("applyStep", () => {
  test("sets and deletes whole entities, assigns fields, replaces arrays; never changes its inputs", () => {
    const before = structuredClone(frame);
    const step: Step = {
      seq: 5,
      t: 3600,
      patch: {
        players: { p2: null },
        playerFields: { p1: { score: 130, parts: { cityPoints: 130 } } },
        seatFields: { p1: { inTurn: true, round: 2 } },
        alliances: { a1: { id: "a1", name: "League", members: ["p1"], formedAt: 3600 } },
        pacts: [{ a: "p1", b: "p2", since: 3600, expiresAt: null }],
        ext: { a: 2 },
        status: "ended",
        result: { reason: "time", winners: ["p1"] },
      },
    };
    const next = applyStep(frame, step);
    expect(frame).toEqual(before);
    expect([next.seq, next.t, next.status, next.ext]).toEqual([5, 3600, "ended", { a: 2 }]);
    expect(Object.keys(next.players)).toEqual(["p1"]);
    expect(next.players.p1?.score).toBe(130);
    expect(next.players.p1?.army).toBe(frame.players.p1?.army);
    expect([next.seats.p1?.inTurn, next.seats.p1?.round, next.seats.p2]).toEqual([
      true,
      2,
      frame.seats.p2,
    ]);
    expect(next.alliances.a1?.members).toEqual(["p1"]);
    expect(next.result).toEqual({ reason: "time", winners: ["p1"] });
    // Untouched collections are shared.
    expect(next.cities).toBe(frame.cities);
  });

  test("fields for an entity the frame does not hold are a broken stream", () => {
    expect(() =>
      applyStep(frame, { seq: 1, t: 0, patch: { cityFields: { c9: { stockAt: 5 } } } }),
    ).toThrow("fields for c9, which the frame does not hold");
  });

  test("applySteps skips the steps at or before the frame's cursor", () => {
    const steps: Step[] = [
      { seq: 3, t: 10, patch: { ext: { a: 3 } } },
      { seq: 4, t: 20 },
    ];
    const at3 = applySteps(frame, steps.slice(0, 1));
    expect(applySteps(at3, steps)).toEqual(applySteps(frame, steps));
    expect(applySteps(frame, steps).seq).toBe(4);
  });

  test("applySteps copies a record once for a run of steps: the same frame, inputs unchanged", () => {
    const steps: Step[] = [
      { seq: 1, t: 10, patch: { playerFields: { p1: { score: 121 } } } },
      { seq: 2, t: 20, patch: { players: { p2: null }, seatFields: { p1: { round: 0 } } } },
      { seq: 3, t: 30 },
      { seq: 4, t: 40, patch: { playerFields: { p1: { score: 122 } }, ext: { a: 4 } } },
    ];
    const before = structuredClone(frame);
    const oneByOne = steps.reduce((f, s) => applyStep(f, s), frame);
    const batched = applySteps(frame, steps);
    expect(batched).toEqual(oneByOne);
    expect(frame).toEqual(before);
    expect(batched.players).not.toBe(frame.players);
    expect(batched.cities).toBe(frame.cities);
    // A frame after part of the run is not changed by applying the rest.
    const at2 = applySteps(frame, steps.slice(0, 2));
    const at2Copy = structuredClone(at2);
    applySteps(at2, steps);
    expect(at2).toEqual(at2Copy);
    expect(applySteps(frame, [])).toBe(frame);
  });

  test("standings are the players in rank order", () => {
    expect(standingsOf(frame).map((s) => [s.player, s.rank, s.score])).toEqual([
      ["p1", 1, 120],
      ["p2", 2, 100],
    ]);
  });
});

describe("game time for display", () => {
  test("equals the engine's fmtTime and fmtDuration on 10,000 random values", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 30 * 86400 }), (t) => {
        expect(fmtGameTime(t)).toBe(fmtTime(t));
        expect(fmtGameDuration(t)).toBe(fmtDuration(t));
      }),
      { numRuns: 10_000 },
    );
    expect([fmtGameTime(0), fmtGameTime(305433), fmtGameDuration(381480)]).toEqual([
      "D1 00:00",
      "D4 12:50:33",
      "4d 9h58m",
    ]);
  });
});
