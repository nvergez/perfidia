import { describe, expect, test } from "bun:test";
import type { Ctx } from "@perfidia/engine/contracts";
import {
  addBuildItem,
  addCity,
  addMovement,
  addPact,
  addProposal,
  addRecruitBatch,
  fixtureRuleset,
  fixtureState,
  matchFromState,
  testStep,
} from "@perfidia/engine/testing";
import type { GameState } from "@perfidia/protocol";
import { EngineBug, eventProblems, type Match } from "./index.ts";

// Each structural invariant of §13.3 catches a planted corruption; so does the emitted-event check.

function richMatch(): Match {
  const { state, rules } = fixtureState({ players: 3 });
  addCity(state, rules, {
    owner: "p1",
    capital: true,
    units: { soldier: 10 },
    buildings: { tower: 1, drill: 1, vault: 1 },
  });
  addCity(state, rules, {
    owner: "p2",
    island: "i2",
    capital: true,
    units: { soldier: 5 },
    buildings: { tower: 1, drill: 1, vault: 1 },
  });
  addCity(state, rules, { owner: "p3", island: "i2", capital: true, buildings: { vault: 1 } });
  addMovement(state, rules, {
    kind: "attack",
    owner: "p1",
    from: "c1",
    to: "c2",
    units: { soldier: 3 },
    arriveAt: 5400,
  });
  addMovement(state, rules, {
    kind: "spy",
    owner: "p2",
    from: "c2",
    to: "c1",
    gold: 20,
    arriveAt: 5400,
  });
  addBuildItem(state, rules, "c1", "tower");
  addRecruitBatch(state, rules, "c2", "soldier", 4);
  addProposal(state, rules, { from: "p1", to: "p3", kind: "pact" });
  addPact(state, rules, "p2", "p3", { expiresAt: 50000 });
  return matchFromState(state, fixtureRuleset);
}

function caught(edit: (ctx: Ctx) => void): EngineBug {
  const m = richMatch();
  try {
    testStep(m, edit);
  } catch (error) {
    if (error instanceof EngineBug) return error;
    throw error;
  }
  throw new Error("the corruption was not caught");
}

function expectCaught(name: string, fragment: string, edit: (ctx: Ctx) => void): void {
  const bug = caught(edit);
  expect(bug.kind).toBe("invariant");
  expect(bug.message).toContain(name);
  expect(bug.message).toContain(fragment);
}

function firstMovement(s: GameState): GameState["movements"][`m${string}`] {
  const m = Object.values(s.movements).find((x) => x.kind === "attack");
  if (m === undefined) throw new Error("no attack");
  return m;
}

describe("kernel invariants", () => {
  test("the rich fixture state passes every invariant and runs", () => {
    const m = richMatch();
    m.checkInvariants("checkpoint");
    m.advanceTo(86400);
    expect(m.ended).toBe(true);
  });

  test("queue order", () => {
    expectCaught("kernel.queue", "is not after", (ctx) => {
      const q = ctx.state.queue;
      const [a, b] = q;
      if (a !== undefined && b !== undefined) [q[0], q[1]] = [b, a];
    });
  });

  test("duplicate seq", () => {
    expectCaught("kernel.queue", "appears twice", (ctx) => {
      const last = ctx.state.queue.at(-1);
      if (last !== undefined) ctx.state.queue.push({ ...last });
    });
  });

  test("a seq above state.seq", () => {
    expectCaught("kernel.queue", "above state.seq", (ctx) => {
      ctx.state.seq -= 1;
    });
  });

  test("an event before now", () => {
    expectCaught("kernel.queue", "before now", (ctx) => {
      ctx.state.now = 6000;
    });
  });

  test("a class that differs from eventClasses", () => {
    expectCaught("kernel.queue", "eventClasses says", (ctx) => {
      const ev = ctx.state.queue.find((e) => e.kind === "match_end");
      if (ev !== undefined) ev.cls = 8;
    });
  });

  test("an arrival whose movement is gone", () => {
    expectCaught("kernel.event-refs", "no such movement", (ctx) => {
      delete ctx.state.movements[firstMovement(ctx.state).id];
    });
  });

  test("a movement pointing to another seq", () => {
    expectCaught("kernel.event-refs", "points to seq", (ctx) => {
      firstMovement(ctx.state).seq += 100;
    });
  });

  test("a movement whose arrival time differs from its event", () => {
    expectCaught("kernel.event-refs", "arrives at", (ctx) => {
      firstMovement(ctx.state).arriveAt += 1;
    });
  });

  test("a build_done without its item", () => {
    expectCaught("kernel.event-refs", "no queue item of c1", (ctx) => {
      const c1 = ctx.state.cities["c1"];
      if (c1 !== undefined) c1.build = [];
    });
  });

  test("a proposal_expire without its proposal", () => {
    expectCaught("kernel.event-refs", "no such proposal", (ctx) => {
      ctx.state.proposals = {};
    });
  });

  test("a pact_expire without its pact", () => {
    expectCaught("kernel.event-refs", "no such pact", (ctx) => {
      ctx.state.pacts = [];
    });
  });

  test("a running match without match_end", () => {
    expectCaught("kernel.event-refs", "needs exactly one", (ctx) => {
      ctx.state.queue = ctx.state.queue.filter((e) => e.kind !== "match_end");
    });
  });

  test("a movement without its arrival event", () => {
    expectCaught("kernel.entity-events", "has 0 arrival events", (ctx) => {
      const m = firstMovement(ctx.state);
      ctx.state.queue = ctx.state.queue.filter((e) => e.seq !== m.seq);
    });
  });

  test("a queue item without its event", () => {
    expectCaught("kernel.entity-events", "c2 drill batch #1: its event", (ctx) => {
      const batch = ctx.state.cities["c2"]?.recruit["drill"]?.[0];
      ctx.state.queue = ctx.state.queue.filter((e) => e.seq !== batch?.seq);
    });
  });

  test("an expiring pact without its event", () => {
    expectCaught("kernel.entity-events", "but has no event", (ctx) => {
      const [pact] = ctx.state.pacts;
      if (pact === undefined) return;
      ctx.state.queue = ctx.state.queue.filter((e) => e.seq !== pact.seq);
      pact.seq = null;
    });
  });

  test("a city id above its counter", () => {
    expectCaught("kernel.ids", "above the city counter", (ctx) => {
      ctx.state.ids.c = 2;
    });
  });

  test("a record key that is not its id", () => {
    expectCaught("kernel.ids", "players.p2 has id p3", (ctx) => {
      const p2 = ctx.state.players["p2"];
      if (p2 !== undefined) p2.id = "p3";
    });
  });

  test("a movement id its owner's counter did not mint", () => {
    expectCaught("kernel.ids", "was not minted for p1", (ctx) => {
      const own = ctx.state.ids.own["p1"];
      if (own !== undefined) own.m = 0;
    });
  });

  test("a queue item above its city's item counter", () => {
    expectCaught("kernel.ids", "above its item counter", (ctx) => {
      const c1 = ctx.state.cities["c1"];
      if (c1 !== undefined) c1.itemSeq = 0;
    });
  });

  test("a player without private counters", () => {
    expectCaught("kernel.ids", "has no private id counters", (ctx) => {
      delete ctx.state.ids.own["p3"];
    });
  });

  test("status and result disagree", () => {
    expectCaught("kernel.status", "ended without a result", (ctx) => {
      ctx.state.status = "ended";
    });
    expectCaught("kernel.status", "a running match has a result", (ctx) => {
      ctx.state.result = { endedAt: 0, reason: "time", winners: [], standings: [] };
    });
  });

  test("an ext that fails extSchema is caught at the checkpoint level", () => {
    const m = richMatch();
    testStep(m, (ctx) => {
      ctx.state.ext = { opened: "yes" };
    });
    expect(() => m.checkInvariants("step")).not.toThrow();
    expect(() => m.checkInvariants("checkpoint")).toThrow(
      /kernel\.ext: state\.ext\.opened does not match fixture-1@1\.0\.0's extSchema/,
    );
  });

  test("domain and ruleset invariants run too", () => {
    expectCaught("fake.conservation", "p1 has 14 soldier, the ledger says 13", (ctx) => {
      const c1 = ctx.state.cities["c1"];
      if (c1 !== undefined) c1.units["soldier"] = 11;
    });
    const m = richMatch();
    m.advanceTo(7300);
    expect(() =>
      testStep(m, (ctx) => {
        ctx.state.ext = { opened: false, renames: 0, holds: {} };
      }),
    ).toThrow(/fixture\.opened: renaming is still closed/);
  });
});

describe("emitted-event check (§8.6)", () => {
  test("an undeclared event type fails the step", () => {
    expect(() =>
      testStep(richMatch(), (ctx) =>
        ctx.emit({ type: "captured", public: true, to: [], data: { city: "c1" } }),
      ),
    ).toThrow(/undeclared type "captured"/);
  });

  test("invalid standard event data fails the step", () => {
    const bug = caught((ctx) =>
      ctx.emit({
        type: "battle",
        public: true,
        to: [],
        data: { city: "c1", attacker: "p1", defender: "p2", kind: "raid" },
      }),
    );
    expect(bug.kind).toBe("invariant");
    expect(bug.message).toContain("event 0 (battle): data.winner");
  });

  test("a ruleset event is checked against its own schema; the envelope too", () => {
    expect(() =>
      testStep(richMatch(), (ctx) =>
        ctx.emit({ type: "city_renamed", public: true, to: [], data: { city: "c1", name: "é" } }),
      ),
    ).toThrow(/event 0 \(city_renamed\): data\.name/);
    expect(() =>
      testStep(richMatch(), (ctx) =>
        ctx.emit({
          type: "fixture_opened",
          public: false,
          to: [
            { p: "p1", as: "self" },
            { p: "p1", as: "ally" },
          ],
          data: { at: 0 },
        }),
      ),
    ).toThrow(/addressed twice/);
  });

  test("eventProblems accepts valid standard and ruleset events", () => {
    expect(
      eventProblems(fixtureRuleset, [
        { t: 0, type: "fixture_opened", public: true, to: [], data: { at: 0 } },
        { t: 0, type: "player_eliminated", public: true, to: [], data: { player: "p2" } },
      ]),
    ).toEqual([]);
  });
});
