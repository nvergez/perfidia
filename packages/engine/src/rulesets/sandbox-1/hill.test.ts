import { describe, expect, test } from "bun:test";
import { idKeyFromSeed } from "@perfidia/engine/core";
import { createMatch } from "@perfidia/engine/kernel";
import { addMovement, testStep } from "@perfidia/engine/testing";
import { PlayerIdSchema } from "@perfidia/protocol";
import { SANDBOX_1_DEFAULTS, SANDBOX_1_REF } from "./config.ts";
import { sandbox1_1_0_0 } from "./descriptor.ts";
import { hillStatus, hillThreshold, hillWinner } from "./hill.ts";
import { computeStandings } from "./scoring.ts";
import { sandboxCity, sandboxMatch, sandboxState, TEST_DOMAIN } from "./testkit.test.ts";

// Victory (docs/architecture.md §3.8): the `hill_open` timer at t = 172800 opens the hill, a
// player owning ≥ ceilDiv(totalCities, 2) cities and ≥ 2 wins (reason `hill`) from that very
// event; the last player standing wins; otherwise the highest score at matchEnd.

describe("threshold", () => {
  test("ceilDiv(total, 2) and at least 2", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 12, 13].map((n) => hillThreshold(SANDBOX_1_DEFAULTS, n))).toEqual([
      2, 2, 2, 2, 3, 3, 4, 6, 7,
    ]);
  });
});

describe("hill_open", () => {
  test("a player who already qualifies wins at the hill_open event, not at the next action", () => {
    const { state, rules } = sandboxState({ players: 2, now: 100000 });
    sandboxCity(state, rules, { owner: "p1", id: "c1", island: "i1", capital: true });
    sandboxCity(state, rules, { owner: "p2", id: "c2", island: "i3", capital: true });
    sandboxCity(state, rules, { owner: "p1", id: "c3", island: "i2" });
    const match = sandboxMatch(state);
    // p1 holds 2 of 3 cities, the threshold, but the hill is closed: actions do not end the match.
    expect(hillWinner(SANDBOX_1_DEFAULTS, match.read().state)).toBe("p1");
    match.advanceTo(172799);
    const renamed = match.apply("p1", {
      type: "ext",
      tool: "rename_city",
      args: { city: "c1", name: "Hilltop" },
    });
    expect(renamed.ok).toBe(true);
    expect(match.ended).toBe(false);
    expect(match.read().ext()).toEqual({ hillOpen: false });

    const { events } = match.advanceTo(172800);
    expect(match.ended).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["match_ended"]);
    expect(events[0]?.data).toEqual({ reason: "hill", winners: ["p1"] });
    expect(match.result).toMatchObject({ endedAt: 172800, reason: "hill", winners: ["p1"] });
    expect(match.result?.standings.map((s) => [s.player, s.rank, s.score])).toEqual([
      ["p1", 1, 2 * 50 + 2 * 10],
      ["p2", 2, 50 + 2 * 5],
    ]);
    expect(match.read().ext()).toEqual({ hillOpen: true });
    expect(match.nextEventTime()).toBeNull();
  });

  test("nobody qualifies: the hill opens, the flag is set and the match goes on", () => {
    const { state, rules } = sandboxState({ players: 3, now: 100000 });
    sandboxCity(state, rules, { owner: "p1", id: "c1", island: "i1", capital: true });
    sandboxCity(state, rules, { owner: "p2", id: "c2", island: "i3", capital: true });
    sandboxCity(state, rules, { owner: "p3", id: "c3", island: "i5", capital: true });
    const match = sandboxMatch(state);
    const { events } = match.advanceTo(172800);
    expect(events).toEqual([]);
    expect(match.ended).toBe(false);
    expect(match.read().ext()).toEqual({ hillOpen: true });
    expect(match.read().state.queue.map((e) => e.kind)).toEqual(["match_end"]);
    const visibility = match.ruleset.hooks.visibility;
    expect(visibility?.publicMatch?.(match.read())).toMatchObject({
      hill: { open: true, threshold: 2, totalCities: 3 },
    });
  });

  test("after the opening, the step that makes a player qualify ends the match", () => {
    const now = 200000;
    const { state, rules } = sandboxState({ players: 3, now });
    sandboxCity(state, rules, { owner: "p1", id: "c1", island: "i1", capital: true });
    sandboxCity(state, rules, { owner: "p2", id: "c2", island: "i3", capital: true });
    sandboxCity(state, rules, { owner: "p3", id: "c3", island: "i5", capital: true });
    sandboxCity(state, rules, { owner: "p2", id: "c4", island: "i4" });
    sandboxCity(state, rules, { owner: "p3", id: "c5", island: "i6" });
    // 5 cities: the threshold is 3. p1 takes c4 (2 cities): not yet.
    addMovement(state, rules, {
      kind: "attack",
      owner: "p1",
      from: "c1",
      to: "c4",
      units: { axeman: 5, colonist: 1 },
      party: "p2",
      departAt: now,
      arriveAt: now + 9300,
    });
    addMovement(state, rules, {
      kind: "attack",
      owner: "p1",
      from: "c1",
      to: "c5",
      units: { axeman: 5, colonist: 1 },
      party: "p3",
      departAt: now,
      arriveAt: now + 10000,
    });
    const match = sandboxMatch(state);
    expect(match.read().ext()).toEqual({ hillOpen: true });
    match.advanceTo(now + 9300);
    expect(match.ended).toBe(false);
    const { events } = match.advanceTo(now + 10000);
    expect(events.map((e) => e.type)).toEqual([
      "battle",
      "battle_report",
      "battle_report",
      "city_conquered",
      "match_ended",
    ]);
    expect(match.result).toMatchObject({ endedAt: now + 10000, reason: "hill", winners: ["p1"] });
  });

  test("two players holding half: more cities, then score, then player number", () => {
    const { state, rules } = sandboxState({ players: 2, now: 180000 });
    sandboxCity(state, rules, { owner: "p1", id: "c1", island: "i1", capital: true });
    sandboxCity(state, rules, { owner: "p2", id: "c2", island: "i3", capital: true });
    sandboxCity(state, rules, { owner: "p1", id: "c3", island: "i2" });
    sandboxCity(state, rules, {
      owner: "p2",
      id: "c4",
      island: "i4",
      buildings: { keep: 2, sawmill: 1, pit: 1, forge: 1, depot: 1 },
    });
    const match = sandboxMatch(state);
    const r = match.read();
    expect(hillWinner(SANDBOX_1_DEFAULTS, r.state)).toBe("p2");
    // The first step after loading evaluates the open hill.
    testStep(match, () => {});
    expect(match.result).toMatchObject({ reason: "hill", winners: ["p2"] });
  });
});

describe("last standing", () => {
  test("the conquest of the last rival city ends the match at once", () => {
    const now = 30000;
    const { state, rules } = sandboxState({ players: 2, now });
    sandboxCity(state, rules, { owner: "p1", id: "c1", island: "i1", capital: true });
    sandboxCity(state, rules, { owner: "p2", id: "c2", island: "i4" });
    const arriveAt = now + 9300;
    addMovement(state, rules, {
      kind: "attack",
      owner: "p1",
      from: "c1",
      to: "c2",
      units: { axeman: 5, colonist: 1 },
      party: "p2",
      arriveAt,
    });
    const match = sandboxMatch(state);
    const { events } = match.advanceTo(arriveAt);
    expect(events.map((e) => e.type)).toEqual([
      "battle",
      "battle_report",
      "battle_report",
      "city_conquered",
      "player_eliminated",
      "match_ended",
    ]);
    expect(match.result).toMatchObject({
      endedAt: arriveAt,
      reason: "last_standing",
      winners: ["p1"],
    });
    expect(match.result?.standings.map((s) => [s.player, s.rank, s.alive])).toEqual([
      ["p1", 1, true],
      ["p2", 2, false],
    ]);
  });
});

describe("time", () => {
  test("at matchEnd the highest score wins; ties by cities, then player number", () => {
    const { state, rules } = sandboxState({ players: 3, now: 600000 });
    sandboxCity(state, rules, { owner: "p1", id: "c1", island: "i1", capital: true });
    sandboxCity(state, rules, {
      owner: "p2",
      id: "c2",
      island: "i3",
      capital: true,
      buildings: { keep: 3, sawmill: 1, pit: 1, forge: 1, depot: 1 },
    });
    sandboxCity(state, rules, {
      owner: "p3",
      id: "c3",
      island: "i5",
      capital: true,
      buildings: { keep: 3, sawmill: 1, pit: 1, forge: 1, depot: 1 },
    });
    const match = sandboxMatch(state);
    expect(computeStandings(SANDBOX_1_DEFAULTS, match.read().state).map((s) => s.player)).toEqual([
      "p2",
      "p3",
      "p1",
    ]);
    const { events } = match.advanceTo(604800);
    expect(events.map((e) => e.type)).toEqual(["match_ended"]);
    expect(match.result).toEqual({
      endedAt: 604800,
      reason: "time",
      winners: ["p2"],
      standings: [
        {
          player: "p2",
          rank: 1,
          score: 64,
          parts: { cityPoints: 50, levelPoints: 14 },
          cities: 1,
          alive: true,
        },
        {
          player: "p3",
          rank: 2,
          score: 64,
          parts: { cityPoints: 50, levelPoints: 14 },
          cities: 1,
          alive: true,
        },
        {
          player: "p1",
          rank: 3,
          score: 60,
          parts: { cityPoints: 50, levelPoints: 10 },
          cities: 1,
          alive: true,
        },
      ],
    });
  });

  test("a whole default match with no action ends on time at 604800, after the hill opened", () => {
    const match = createMatch(
      {
        ruleset: SANDBOX_1_REF,
        overrides: {},
        seed: 3,
        idKey: idKeyFromSeed(3),
        seats: [1, 2, 3, 4].map((i) => ({ id: PlayerIdSchema.parse(`p${i}`) })),
      },
      sandbox1_1_0_0,
      TEST_DOMAIN,
      { invariants: "step" },
    );
    const { checkpoints } = match.advanceTo(604800);
    expect(checkpoints).toHaveLength(167);
    expect(match.result).toMatchObject({ endedAt: 604800, reason: "time", winners: ["p1"] });
    expect(match.read().ext()).toEqual({ hillOpen: true });
  });
});

describe("hill status", () => {
  test("public data: open flag, opening time, threshold, total, three leaders", () => {
    const { state, rules } = sandboxState({ players: 4, now: 1000 });
    sandboxCity(state, rules, { owner: "p1", id: "c1", island: "i1", capital: true });
    sandboxCity(state, rules, { owner: "p2", id: "c2", island: "i3", capital: true });
    sandboxCity(state, rules, { owner: "p3", id: "c3", island: "i5", capital: true });
    sandboxCity(state, rules, { owner: "p4", id: "c4", island: "i7", capital: true });
    sandboxCity(state, rules, { owner: "p3", id: "c5", island: "i6" });
    expect(hillStatus(SANDBOX_1_DEFAULTS, state, { hillOpen: false })).toEqual({
      open: false,
      opensAt: [172800, "D3 00:00"],
      threshold: 3,
      totalCities: 5,
      leaders: [
        { player: "p3", cities: 2 },
        { player: "p1", cities: 1 },
        { player: "p2", cities: 1 },
      ],
    });
  });
});
