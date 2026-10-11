import { describe, expect, test } from "bun:test";
import { canonicalJson, fnv1a64 } from "@perfidia/engine/core";
import type { ActionHandler, Ctx, DomainModule, Ruleset } from "@perfidia/engine/contracts";
import {
  LogRecorder,
  addBuildItem,
  addCity,
  fakeDomain,
  fixtureMatch,
  fixtureRuleset,
  fixtureSetup,
  fixtureState,
  matchFromState,
  testStep,
  type FixtureConfig,
  type FixtureExt,
} from "@perfidia/engine/testing";
import type { Action, ActionOf, Json, MatchSetup } from "@perfidia/protocol";
import fc from "fast-check";
import * as kernel from "./index.ts";
import {
  EngineBug,
  EngineMisuse,
  MatchConfigError,
  createMatch,
  loadMatch,
  stateHash,
  type Match,
} from "./index.ts";

type FixtureRuleset = Ruleset<FixtureConfig, FixtureExt>;

function configError(fn: () => unknown): MatchConfigError {
  try {
    fn();
  } catch (error) {
    if (error instanceof MatchConfigError) return error;
    throw error;
  }
  throw new Error("expected a MatchConfigError");
}

function create(
  o: {
    setup?: MatchSetup;
    ruleset?: FixtureRuleset;
    domain?: DomainModule;
    overrides?: Record<string, Json>;
  } = {},
): Match {
  return createMatch(
    o.setup ?? fixtureSetup({ overrides: o.overrides ?? {} }),
    o.ruleset ?? fixtureRuleset,
    o.domain ?? fakeDomain,
    {
      invariants: "step",
    },
  );
}

function messages(e: MatchConfigError): string {
  return e.issues.map((i) => `${i.path}: ${i.message}`).join("\n");
}

describe("createMatch", () => {
  test("builds the initial state: players, counters, ledger, timers and match_end", () => {
    const m = fixtureMatch({ players: 3 });
    const s = m.read().state;
    expect(Object.keys(s.players)).toEqual(["p1", "p2", "p3"]);
    expect(s.ids.c).toBe(3);
    expect(s.ids.own["p2"]).toEqual({ m: 0, r: 0, q: 0, g: 0 });
    expect(s.ledger["p1"]?.made).toEqual({ soldier: 10 });
    expect(s.ledger["neutral"]).toEqual({ made: {}, gone: {} });
    expect(s.queue.map((e) => [e.kind, e.at, e.seq])).toEqual([
      ["fixture_open", 7200, 1],
      ["match_end", 86400, 2],
    ]);
    expect(s.evHash).toBe(fnv1a64(""));
    expect(m.now).toBe(0);
    expect(m.ended).toBe(false);
    expect(m.nextEventTime()).toBe(7200);
    expect(m.hash()).toBe(fixtureMatch({ players: 3 }).hash());
    expect(m.hash()).not.toBe(fixtureMatch({ players: 3, seed: 8 }).hash());
  });

  test("an invalid idKey, a ref mismatch and N out of range are MatchConfigErrors", () => {
    const setup = fixtureSetup();
    expect(
      messages(
        configError(() => create({ setup: { ...setup, idKey: setup.idKey.toUpperCase() } })),
      ),
    ).toContain("setup.idKey");
    expect(messages(configError(() => create({ setup: { ...setup, idKey: "abc" } })))).toContain(
      "setup.idKey",
    );
    expect(
      messages(configError(() => create({ setup: { ...setup, ruleset: "fixture-1@1.0.1" } }))),
    ).toContain("setup.ruleset");
    expect(messages(configError(() => create({ setup: fixtureSetup({ players: 1 }) })))).toContain(
      "setup.seats",
    );
    expect(messages(configError(() => create({ setup: fixtureSetup({ players: 5 }) })))).toContain(
      "2..4 players",
    );
    expect(messages(configError(() => create({ overrides: { "time.matchEnd": 0 } })))).toContain(
      "time.matchEnd",
    );
  });

  test("an event kind without a class or without a handler is rejected", () => {
    const noClass: FixtureRuleset = {
      ...fixtureRuleset,
      compile: (c, n) => {
        const rules = fixtureRuleset.compile(c, n);
        delete rules.eventClasses["fixture_open"];
        return rules;
      },
    };
    expect(messages(configError(() => create({ ruleset: noClass })))).toContain(
      "eventClasses.fixture_open: event kind fixture_open has no class",
    );
    const orphan: FixtureRuleset = {
      ...fixtureRuleset,
      compile: (c, n) => ({
        ...fixtureRuleset.compile(c, n),
        eventClasses: { ...fixtureRuleset.compile(c, n).eventClasses, orphan: 7 },
      }),
    };
    expect(messages(configError(() => create({ ruleset: orphan })))).toContain(
      "event kind orphan has no handler",
    );
    const { build_done: _dropped, ...events } = fakeDomain.events;
    expect(messages(configError(() => create({ domain: { ...fakeDomain, events } })))).toContain(
      "event kind build_done has no handler",
    );
    const onMatchEnd: FixtureRuleset = {
      ...fixtureRuleset,
      hooks: {
        ...fixtureRuleset.hooks,
        on: { ...fixtureRuleset.hooks.on, match_end: () => undefined },
      },
    };
    expect(messages(configError(() => create({ ruleset: onMatchEnd })))).toContain(
      "hooks.on.match_end would never run",
    );
  });

  test("match_end must have a class of its own", () => {
    const shared: FixtureRuleset = {
      ...fixtureRuleset,
      compile: (c, n) => {
        const rules = fixtureRuleset.compile(c, n);
        rules.eventClasses["match_end"] = 7;
        return rules;
      },
    };
    expect(messages(configError(() => create({ ruleset: shared })))).toContain(
      "match_end must have a class of its own; class 7 is shared with fixture_open, pact_expire, proposal_expire",
    );
  });

  test("a world timer at 0 and a start stock above its cap are rejected", () => {
    expect(messages(configError(() => create({ overrides: { "time.openAt": 0 } })))).toContain(
      "timers.0.at: world timer fixture_open is at 0",
    );
    const e = configError(() => create({ overrides: { "start.stock": 1001 } }));
    expect(messages(e)).toContain("cities.c1.stock.wood");
    expect(messages(e)).toContain("exceeds the storage cap 1000 of vault level 1");
  });

  test("a travel time below minTravel for one island pair, the same island included, is rejected", () => {
    const between = messages(configError(() => create({ overrides: { "time.travel": 3599 } })));
    expect(between).toContain("travelTime(i1, i2, any) = 3599, below time.minTravel (3600)");
    expect(between).not.toContain("travelTime(i1, i1");
    const same = messages(configError(() => create({ overrides: { "time.sameIsland": 100 } })));
    expect(same).toContain("travelTime(i1, i1, any) = 100");
    expect(same).toContain("travelTime(i2, i2, any) = 100");
    expect(same).not.toContain("travelTime(i1, i2");
    const onePair: FixtureRuleset = {
      ...fixtureRuleset,
      hooks: {
        ...fixtureRuleset.hooks,
        travelTime: (r, from, to, g) =>
          from === "i2" && to === "i1" ? 10 : fixtureRuleset.hooks.travelTime(r, from, to, g),
      },
    };
    expect(messages(configError(() => create({ ruleset: onePair })))).toContain(
      "travelTime(i2, i1, any) = 10",
    );
  });

  test("failing initial invariants and a throwing createWorld are rejected", () => {
    const badExt: FixtureRuleset = {
      ...fixtureRuleset,
      hooks: {
        ...fixtureRuleset.hooks,
        createWorld: (w) => ({
          ...fixtureRuleset.hooks.createWorld(w),
          ext: { opened: false, renames: -1, holds: {} },
        }),
      },
    };
    expect(messages(configError(() => create({ ruleset: badExt })))).toContain(
      "initial state: kernel.ext",
    );
    const throwing: FixtureRuleset = {
      ...fixtureRuleset,
      hooks: {
        ...fixtureRuleset.hooks,
        createWorld: () => {
          throw new Error("no map");
        },
      },
    };
    expect(messages(configError(() => create({ ruleset: throwing })))).toContain(
      "createWorld threw Error: no map",
    );
  });
});

describe("apply", () => {
  test("accepts an action, returning copies of its data and events", () => {
    const m = fixtureMatch();
    const out = m.apply("p1", { type: "attack", from: "c1", to: "c2", units: { soldier: 3 } });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.events.map((e) => e.type)).toEqual(["incoming_attack"]);
    expect(out.warnings).toEqual([]);
    expect(out.h).toBeUndefined();
    const h = m.hash();
    out.data["movement"] = "mzzzzz";
    expect(m.hash()).toBe(h);
  });

  test("a rejected action leaves the state hash unchanged", () => {
    const m = fixtureMatch();
    const before = m.hash();
    const rejected: Action[] = [
      { type: "build", city: "c2", building: "tower" },
      { type: "build", city: "c9", building: "tower" },
      { type: "attack", from: "c1", to: "c2", units: { soldier: 99 } },
      { type: "recruit", city: "c1", unit: "soldier", count: 500 },
      { type: "found_city", from: "c1", island: "i1", units: {}, slot: null },
      { type: "ext", tool: "fixture_rename", args: { city: "c1", name: "x" } },
    ];
    for (const a of rejected) {
      const out = m.apply("p1", a);
      expect(out.ok).toBe(false);
      expect(m.hash()).toBe(before);
    }
  });

  test("the guard runs first; MATCH_ENDED and ELIMINATED come before it", () => {
    const m = fixtureMatch({ players: 3 });
    const rename: Action = {
      type: "ext",
      tool: "fixture_rename",
      args: { city: "c1", name: "Home" },
    };
    expect(m.apply("p1", rename)).toEqual({
      ok: false,
      violation: { code: "FIXTURE_CLOSED", details: { availableAt: 7200 } },
    });
    m.advanceTo(7200);
    expect(m.apply("p1", rename)).toMatchObject({ ok: true, data: { city: "c1", name: "Home" } });
    testStep(m, (ctx) => {
      const p2 = ctx.state.players["p2"];
      if (p2 !== undefined) {
        p2.alive = false;
        p2.eliminatedAt = ctx.now;
      }
    });
    expect(m.apply("p2", { type: "build", city: "c2", building: "tower" })).toEqual({
      ok: false,
      violation: { code: "ELIMINATED", details: { player: "p2", eliminatedAt: 7200 } },
    });
    m.advanceTo(86400);
    expect(m.ended).toBe(true);
    expect(m.apply("p1", rename)).toEqual({
      ok: false,
      violation: { code: "MATCH_ENDED", details: { matchEnd: 86400 } },
    });
  });

  test("an ext action without a handler is an INVALID_ARGS violation", () => {
    const { actions: _dropped, ...hooks } = fixtureRuleset.hooks;
    const m = create({ ruleset: { ...fixtureRuleset, hooks: { ...hooks, guard: () => null } } });
    expect(m.apply("p1", { type: "ext", tool: "fixture_rename", args: {} })).toEqual({
      ok: false,
      violation: {
        code: "INVALID_ARGS",
        details: { tool: "fixture_rename", reason: "no_handler" },
      },
    });
  });

  test("validation warnings come back with the result; a ruleset handler overrides the domain's", () => {
    const warned: ActionHandler<ActionOf<"send_message">, null> = {
      validate: () => ({ ok: true, plan: null, warnings: [{ code: "LOUD", details: { n: 1 } }] }),
      apply: () => ({ sent: true }),
    };
    const ruleset: FixtureRuleset = {
      ...fixtureRuleset,
      hooks: {
        ...fixtureRuleset.hooks,
        actions: { ...fixtureRuleset.hooks.actions, send_message: warned },
      },
    };
    const m = create({ ruleset });
    expect(m.apply("p1", { type: "send_message", to: "all", text: "hi" })).toEqual({
      ok: true,
      data: { sent: true },
      events: [],
      warnings: [{ code: "LOUD", details: { n: 1 } }],
    });
  });

  test("traceHashes adds the state hash after every applied action", () => {
    const m = fixtureMatch({ traceHashes: true });
    const out = m.apply("p1", { type: "build", city: "c1", building: "tower" });
    expect(out.ok && out.h).toBe(m.hash());
  });

  test("an unknown seat or a malformed action is EngineMisuse", () => {
    const m = fixtureMatch();
    expect(() => m.apply("p7", { type: "build", city: "c1", building: "tower" })).toThrow(
      EngineMisuse,
    );
    expect(() => m.apply("p1", { type: "build", city: "c1", building: "Tower!" })).toThrow(
      EngineMisuse,
    );
    expect(() =>
      m.apply("p1", { type: "recruit", city: "c1", unit: "soldier", count: -1 }),
    ).toThrow(EngineMisuse);
    const float = { type: "recruit", city: "c1", unit: "soldier", count: 1.5 } as const;
    expect(() => m.apply("p1", float)).toThrow(EngineMisuse);
  });

  test("the handler never sees the caller's action object", () => {
    const m = fixtureMatch();
    const units = { soldier: 2 };
    m.apply("p1", { type: "attack", from: "c1", to: "c2", units });
    const before = m.hash();
    units.soldier = 9;
    expect(m.hash()).toBe(before);
  });
});

describe("emit and boundary copies (§6.4, §6.6)", () => {
  test("after an emit, mutating the state leaves the collected event, a taken snapshot and the hashes unchanged", () => {
    const m = fixtureMatch({ invariants: "checkpoint" });
    const snap = m.snapshot(0);
    const snapText = canonicalJson(snap);
    const ev0 = m.read().state.evHash;
    let expectedText = "";
    const events = testStep(m, (ctx) => {
      const city = ctx.state.cities["c1"];
      if (city === undefined) throw new Error("no c1");
      const data = { city: "c1", levels: city.buildings };
      ctx.emit({ type: "fixture_opened", public: true, to: [], data: { at: ctx.now, data } });
      expectedText = canonicalJson({
        type: "fixture_opened",
        public: true,
        to: [],
        data: {
          at: 0,
          data: {
            city: "c1",
            levels: { drill: 1, goldcut: 1, stonecut: 1, tower: 1, vault: 1, woodcut: 1 },
          },
        },
        t: 0,
      });
      city.buildings["tower"] = 3;
      data.city = "c2";
    });
    expect(events).toEqual([
      {
        t: 0,
        type: "fixture_opened",
        public: true,
        to: [],
        data: {
          at: 0,
          data: {
            city: "c1",
            levels: { drill: 1, goldcut: 1, stonecut: 1, tower: 1, vault: 1, woodcut: 1 },
          },
        },
      },
    ]);
    expect(m.read().state.evHash).toBe(fnv1a64(`${ev0}\n${expectedText}`));
    expect(canonicalJson(snap)).toBe(snapText);
    expect(stateHash(snap.state)).toBe(snap.hash);
    const h = m.hash();
    const [event] = events;
    if (event !== undefined) event.data["at"] = 99;
    expect(m.hash()).toBe(h);
  });

  test("events are deep-frozen under step invariants", () => {
    const m = fixtureMatch();
    const out = m.advanceTo(7200);
    const [opened] = out.events;
    expect(Object.isFrozen(opened)).toBe(true);
    expect(Object.isFrozen(opened?.data)).toBe(true);
  });

  test("the result is a copy; the setup is frozen at every level and snapshots copy it", () => {
    const m = fixtureMatch();
    m.advanceTo(86400);
    const result = m.result;
    if (result === null) throw new Error("not ended");
    result.winners.push("p9");
    expect(m.result?.winners).not.toContain("p9");

    for (const invariants of ["off", "checkpoint", "step"] as const) {
      const live = fixtureMatch({ invariants, overrides: { "time.travel": 7200 } });
      live.apply("p1", { type: "attack", from: "c1", to: "c2", units: { soldier: 2 } });
      const snapText = canonicalJson(live.snapshot(1));
      const h = live.hash();
      const setup = live.setup;
      expect(Object.isFrozen(setup)).toBe(true);
      expect(Object.isFrozen(setup.seats)).toBe(true);
      expect(Object.isFrozen(setup.overrides)).toBe(true);
      expect(() => setup.seats.push({ id: "p3" })).toThrow(TypeError);
      expect(() => {
        setup.overrides["time.travel"] = 9999;
      }).toThrow(TypeError);
      expect(() => {
        setup.idKey = "0".repeat(32);
      }).toThrow(TypeError);
      expect(canonicalJson(live.snapshot(1))).toBe(snapText);
      expect(live.hash()).toBe(h);

      const snap = live.snapshot(1);
      snap.setup.idKey = "0".repeat(32);
      expect(live.setup.idKey).not.toBe(snap.setup.idKey);
      const loaded = loadMatch(live.snapshot(1), fixtureRuleset, fakeDomain, { invariants });
      expect(Object.isFrozen(loaded.setup.seats)).toBe(true);
      expect(() => loaded.setup.seats.push({ id: "p3" })).toThrow(TypeError);
      expect(loaded.hash()).toBe(h);
    }
  });
});

describe("rng, freezing, misuse and aborts", () => {
  test("the same stream name twice under step invariants is an EngineBug", () => {
    const m = fixtureMatch();
    expect(() =>
      testStep(m, (ctx) => {
        ctx.rng("loot:1");
        ctx.rng("loot:1");
      }),
    ).toThrow(EngineBug);
    const again = fixtureMatch();
    testStep(again, (ctx) => void ctx.rng("loot:2"));
    expect(() => testStep(again, (ctx) => void ctx.rng("loot:2"))).toThrow(/requested twice/);
    expect(() => testStep(fixtureMatch(), (ctx) => void ctx.rng("seats"))).toThrow(
      /requested twice/,
    );
  });

  test("without step invariants a repeated name repeats the same draws", () => {
    const m = fixtureMatch({ invariants: "checkpoint" });
    testStep(m, (ctx) => {
      expect(ctx.rng("x").nextU32()).toBe(ctx.rng("x").nextU32());
    });
  });

  test("the rules, the config and the descriptor are deep-frozen under step invariants", () => {
    const m = fixtureMatch();
    expect(Object.isFrozen(m.rules.buildings)).toBe(true);
    expect(Object.isFrozen(m.config)).toBe(true);
    expect(Object.isFrozen(fixtureRuleset.hooks)).toBe(true);
    const sorting: FixtureRuleset = {
      ...fixtureRuleset,
      hooks: {
        ...fixtureRuleset.hooks,
        on: {
          fixture_open: (ctx) => {
            Reflect.apply(Array.prototype.sort, ctx.rules.units, [() => 0]);
          },
        },
      },
    };
    const m2 = create({ ruleset: sorting });
    expect(() => m2.advanceTo(7200)).toThrow(EngineBug);
  });

  test("time going backwards is EngineMisuse; so is a fractional time", () => {
    const m = fixtureMatch();
    m.advanceTo(100);
    expect(() => m.advanceTo(99)).toThrow(EngineMisuse);
    expect(() => m.advanceTo(100.5)).toThrow(EngineMisuse);
    expect(() => m.advanceTo(100)).not.toThrow();
  });

  test("a throwing handler is an EngineBug that aborts the match", () => {
    const failing: FixtureRuleset = {
      ...fixtureRuleset,
      hooks: {
        ...fixtureRuleset.hooks,
        on: {
          fixture_open: () => {
            throw new RangeError("bad maths");
          },
        },
      },
    };
    const m = create({ ruleset: failing });
    let bug: unknown;
    try {
      m.advanceTo(7200);
    } catch (error) {
      bug = error;
    }
    expect(bug).toBeInstanceOf(EngineBug);
    expect(bug instanceof EngineBug && bug.kind).toBe("engine");
    expect(bug instanceof Error && bug.message).toContain(
      "fixture_open handler threw RangeError: bad maths",
    );
    expect(() => m.advanceTo(7300)).toThrow(EngineMisuse);
    expect(() => m.apply("p1", { type: "build", city: "c1", building: "tower" })).toThrow(
      EngineMisuse,
    );
    expect(m.hash()).toMatch(/^[0-9a-f]{16}$/);
  });

  test("cancelling a missing seq and scheduling at now are EngineBugs", () => {
    expect(() => testStep(fixtureMatch(), (ctx) => ctx.cancel(999))).toThrow(
      /no pending event has this seq/,
    );
    expect(() =>
      testStep(fixtureMatch(), (ctx) => void ctx.schedule("fixture_open", 0, "")),
    ).toThrow(/strictly after now/);
    expect(() =>
      testStep(fixtureMatch(), (ctx) => void ctx.schedule("unknown_kind", 5, "")),
    ).toThrow(/has no class/);
  });
});

describe("ids", () => {
  test("nextId mints public counters and per-owner opaque ids; nextItem counts per city", () => {
    const m = fixtureMatch({ players: 3 });
    testStep(m, (ctx) => {
      expect(ctx.nextId("c")).toBe("c4");
      expect(ctx.nextId("a")).toBe("a1");
      const m1 = ctx.nextId("m", "p1");
      const m2 = ctx.nextId("m", "p1");
      const other = ctx.nextId("m", "p2");
      expect(m1).toMatch(/^m[0-9a-hjkmnp-tv-z]{5}$/);
      expect(new Set([m1, m2, other]).size).toBe(3);
      expect(ctx.state.ids.own["p1"]?.m).toBe(2);
      expect(ctx.nextId("g", "p3")).toMatch(/^g/);
      expect(ctx.nextItem("c1")).toBe(1);
      expect(ctx.nextItem("c1")).toBe(2);
      expect(ctx.nextItem("c2")).toBe(1);
      expect(() => ctx.nextId("m", "p9")).toThrow(EngineBug);
      expect(() => ctx.nextItem("c9")).toThrow(EngineBug);
    });
  });

  test("a player's own ids do not depend on other players' activity", () => {
    const quiet = fixtureMatch({ players: 3 });
    const busy = fixtureMatch({ players: 3 });
    busy.apply("p2", { type: "attack", from: "c2", to: "c3", units: { soldier: 1 } });
    busy.apply("p3", { type: "send_message", to: ["p2"], text: "x" });
    const a = quiet.apply("p1", { type: "attack", from: "c1", to: "c2", units: { soldier: 1 } });
    const b = busy.apply("p1", { type: "attack", from: "c1", to: "c2", units: { soldier: 1 } });
    expect(a.ok && a.data["movement"]).toBe(b.ok && b.data["movement"]);
  });
});

describe("match end", () => {
  test("match_end calls finish, ends the match and emits match_ended; nothing else runs", () => {
    const m = fixtureMatch();
    const out = m.advanceTo(100000);
    const ended = out.events.at(-1);
    expect(ended).toMatchObject({
      type: "match_ended",
      public: true,
      t: 86400,
      data: { reason: "time" },
    });
    expect(m.ended).toBe(true);
    expect(m.now).toBe(86400);
    expect(m.nextEventTime()).toBeNull();
    expect(m.result?.reason).toBe("time");
    expect(m.result?.standings.map((s) => s.rank)).toEqual([1, 2]);
    expect(m.advanceTo(200000)).toEqual({ events: [], checkpoints: [] });
    expect(m.now).toBe(86400);
  });

  test("a ruleset can end the match early from afterStep; afterStep then stops", () => {
    const m = fixtureMatch({ players: 2 });
    const events = testStep(m, (ctx) => {
      const c2 = ctx.state.cities["c2"];
      const { p1, p2 } = ctx.state.ledger;
      if (c2 === undefined || p1 === undefined || p2 === undefined)
        throw new Error("fixture shape");
      c2.owner = "p1";
      p2.gone["soldier"] = 10;
      p1.made["soldier"] = 20;
    });
    expect(events.map((e) => e.type)).toEqual(["player_eliminated", "match_ended"]);
    expect(m.ended).toBe(true);
    expect(m.result).toMatchObject({ reason: "last_standing", winners: ["p1"], endedAt: 0 });
    expect(() =>
      testStep(m, (ctx) =>
        ctx.endMatch({ endedAt: 0, reason: "again", winners: [], standings: [] }),
      ),
    ).toThrow(/already ended/);
  });
});

describe("checkpoints (§5.3)", () => {
  test("an event exactly at an hour boundary precedes its checkpoint; an action at the boundary follows it", () => {
    const { state, rules } = fixtureState();
    addCity(state, rules, { owner: "p1", capital: true, buildings: { tower: 1, vault: 1 } });
    addCity(state, rules, {
      owner: "p2",
      island: "i2",
      capital: true,
      buildings: { tower: 1, vault: 1 },
    });
    addBuildItem(state, rules, "c1", "tower", { start: 0, end: 3600 });
    const m = matchFromState(state, fixtureRuleset);
    const out = m.advanceTo(3600);
    expect(out.events.map((e) => [e.type, e.t])).toEqual([
      ["build_done", 3600],
      ["queue_empty", 3600],
    ]);
    expect(out.checkpoints).toEqual([{ hour: 1, t: 3600, h: m.hash() }]);
    expect(m.read().state.cities["c1"]?.buildings["tower"]).toBe(2);
    m.apply("p1", { type: "build", city: "c1", building: "tower" });
    expect(m.hash()).not.toBe(out.checkpoints[0]?.h);

    const rec = new LogRecorder(fixtureMatch());
    rec.advanceTo(2400);
    rec.act("p1", { type: "build", city: "c1", building: "tower" });
    rec.advanceTo(3600);
    rec.act("p1", { type: "build", city: "c1", building: "tower" });
    expect(rec.lines.slice(-5).map((l) => `${l.k}@${l.k === "header" ? "-" : l.t}`)).toEqual([
      "act@2400",
      "ev@3600",
      "ev@3600",
      "ckpt@3600",
      "act@3600",
    ]);
  });

  test("checkpoints are taken on the way, never after the end", () => {
    const m = fixtureMatch({ overrides: { "time.matchEnd": 7000 } });
    const out = m.advanceTo(30000);
    expect(out.checkpoints.map((c) => c.hour)).toEqual([1]);
    expect(out.events.map((e) => e.type)).toEqual(["match_ended"]);
    expect(m.ended).toBe(true);
    expect(m.snapshot(0).hour).toBe(1);
    const long = fixtureMatch();
    expect(long.advanceTo(5 * 3600 + 5).checkpoints.map((c) => [c.hour, c.t])).toEqual([
      [1, 3600],
      [2, 7200],
      [3, 10800],
      [4, 14400],
      [5, 18000],
    ]);
    expect(long.advanceTo(5 * 3600 + 6).checkpoints).toEqual([]);
  });

  test("advanceTo(3600 H) leaves the match exactly in checkpoint state H", () => {
    const a = fixtureMatch();
    const [ck] = a.advanceTo(3600).checkpoints;
    expect(a.hash()).toBe(ck?.h ?? "");
    const b = fixtureMatch();
    b.advanceTo(1800);
    expect(b.advanceTo(3600).checkpoints[0]?.h).toBe(ck?.h);
  });
});

const p5Actions = fc.array(
  fc.record({
    seat: fc.constantFrom("p1", "p2"),
    pick: fc.nat({ max: 5 }),
    n: fc.integer({ min: 1, max: 4 }),
  }),
  { maxLength: 8 },
);

function prepared(list: readonly { seat: "p1" | "p2"; pick: number; n: number }[]): Match {
  const m = fixtureMatch({ invariants: "checkpoint" });
  for (const x of list) {
    const own = x.seat === "p1" ? "c1" : "c2";
    const foe = x.seat === "p1" ? "c2" : "c1";
    const a: Action[] = [
      { type: "build", city: own, building: "tower" },
      { type: "recruit", city: own, unit: "soldier", count: x.n },
      { type: "attack", from: own, to: foe, units: { soldier: x.n } },
      { type: "spy", from: own, to: foe, gold: 10 * x.n },
      {
        type: "propose",
        to: x.seat === "p1" ? "p2" : "p1",
        kind: "pact",
        name: null,
        text: "hi",
        until: null,
      },
      { type: "support", from: own, to: foe, units: { soldier: 1 } },
    ];
    const action = a[x.pick];
    if (action !== undefined) m.apply(x.seat, action);
  }
  return m;
}

describe("P5: advanceTo(a); advanceTo(b) ≡ advanceTo(b)", () => {
  test("splitting an advance changes nothing", () => {
    fc.assert(
      fc.property(
        p5Actions,
        fc.integer({ min: 0, max: 90000 }),
        fc.integer({ min: 0, max: 90000 }),
        (list, x, y) => {
          const [a, b] = x <= y ? [x, y] : [y, x];
          const whole = prepared(list);
          const outWhole = whole.advanceTo(b);
          const split = prepared(list);
          const first = split.advanceTo(a);
          const second = split.advanceTo(b);
          expect(canonicalJson([...first.events, ...second.events])).toBe(
            canonicalJson(outWhole.events),
          );
          expect([...first.checkpoints, ...second.checkpoints]).toEqual(outWhole.checkpoints);
          expect(split.hash()).toBe(whole.hash());
          expect(split.now).toBe(whole.now);
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe("matchFromState", () => {
  test("a hand-built state loads and runs", () => {
    const { state, rules } = fixtureState();
    addCity(state, rules, { owner: "p1", capital: true });
    addCity(state, rules, { owner: "p2", island: "i2", capital: true });
    const m = matchFromState(state, fixtureRuleset);
    expect(m.now).toBe(0);
    expect(m.advanceTo(7200).events.map((e) => e.type)).toEqual(["fixture_opened"]);
  });

  test("testStep lives in the testing kit only: the kernel barrel does not export it", () => {
    expect(Object.keys(kernel)).not.toContain("runTestStep");
    expect(Object.keys(kernel)).toContain("createMatch");
  });
});

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

function bugOf(fn: () => unknown): EngineBug {
  const error = caught(fn);
  if (error instanceof EngineBug) return error;
  throw new Error(`expected an EngineBug, got ${String(error)}`);
}

function withHooks(hooks: Partial<FixtureRuleset["hooks"]>): FixtureRuleset {
  return { ...fixtureRuleset, hooks: { ...fixtureRuleset.hooks, ...hooks } };
}

const fakeBuild: ActionHandler = fakeDomain.actions.build;
const fakeAttack: ActionHandler = fakeDomain.actions.attack;

function setWood(ctx: Ctx, wood: number): void {
  const c1 = ctx.state.cities["c1"];
  if (c1 === undefined) throw new Error("no c1");
  c1.stock.wood = wood;
}

describe("only EngineMisuse and EngineBug leave the kernel (§5.3)", () => {
  test("a float left in the state is an invariant EngineBug at the next checkpoint", () => {
    const floating = withHooks({ on: { fixture_open: (ctx) => setWood(ctx, 1.5) } });
    const m = createMatch(fixtureSetup(), floating, fakeDomain, { invariants: "checkpoint" });
    const bug = bugOf(() => m.advanceTo(7200));
    expect(bug.kind).toBe("invariant");
    expect(bug.message).toContain("the state is not canonical JSON at t = 7200");
    expect(bug.message).toContain("1.5 is not a safe integer at $.cities.c1.stock.wood");
    expect(() => m.advanceTo(7300)).toThrow(EngineMisuse);
    expect(bugOf(() => m.hash()).kind).toBe("invariant");
    expect(bugOf(() => m.snapshot(0)).kind).toBe("invariant");
  });

  test("a float left by an action is an EngineBug at its trace hash, else at the checkpoint", () => {
    const floating = withHooks({
      actions: {
        ...fixtureRuleset.hooks.actions,
        build: {
          validate: (r, seat, a) => fakeBuild.validate(r, seat, a),
          apply: (ctx, seat, plan) => {
            const data = fakeBuild.apply(ctx, seat, plan);
            setWood(ctx, 0.5);
            return data;
          },
        },
      },
    });
    const build: Action = { type: "build", city: "c1", building: "tower" };
    const traced = createMatch(fixtureSetup(), floating, fakeDomain, {
      invariants: "checkpoint",
      traceHashes: true,
    });
    expect(bugOf(() => traced.apply("p1", build)).kind).toBe("invariant");
    expect(() => traced.apply("p1", build)).toThrow(EngineMisuse);
    const plain = createMatch(fixtureSetup(), floating, fakeDomain, { invariants: "checkpoint" });
    expect(plain.apply("p1", build).ok).toBe(true);
    expect(bugOf(() => plain.advanceTo(3600)).message).toContain("at t = 3600");
  });

  test("a float in a violation or a warning is an EngineBug of kind engine", () => {
    const guarding = withHooks({
      guard: () => ({ code: "FIXTURE_CLOSED", details: { availableAt: 1.5 } }),
    });
    const build: Action = { type: "build", city: "c1", building: "tower" };
    for (const invariants of ["checkpoint", "step"] as const) {
      const m = createMatch(fixtureSetup(), guarding, fakeDomain, { invariants });
      const bug = bugOf(() => m.apply("p1", build));
      expect(bug.kind).toBe("engine");
      expect(bug.message).toContain("hooks.guard returned a violation that is not canonical JSON");
      expect(() => m.apply("p1", build)).toThrow(EngineMisuse);
    }
    const warning = withHooks({
      actions: {
        ...fixtureRuleset.hooks.actions,
        build: {
          validate: (r, seat, a) => {
            const verdict = fakeBuild.validate(r, seat, a);
            return verdict.ok
              ? { ...verdict, warnings: [{ code: "FIXTURE_CLOSED", details: { x: 0.5 } }] }
              : verdict;
          },
          apply: (ctx, seat, plan) => fakeBuild.apply(ctx, seat, plan),
        },
      },
    });
    const m = createMatch(fixtureSetup(), warning, fakeDomain, { invariants: "checkpoint" });
    expect(bugOf(() => m.apply("p1", build)).message).toContain(
      "build.validate returned a violation that is not canonical JSON",
    );
  });

  test("validate answers as apply would, changes nothing, and is guarded like apply", () => {
    const m = fixtureMatch({ players: 3 });
    const before = m.hash();
    const rename: Action = {
      type: "ext",
      tool: "fixture_rename",
      args: { city: "c1", name: "Home" },
    };
    const probes: Action[] = [
      rename,
      { type: "build", city: "c2", building: "tower" },
      { type: "recruit", city: "c1", unit: "soldier", count: 500 },
      { type: "build", city: "c1", building: "tower" },
    ];
    const verdicts = probes.map((a) => m.validate("p1", a));
    expect(m.hash()).toBe(before);
    expect(verdicts[0]).toEqual({ code: "FIXTURE_CLOSED", details: { availableAt: 7200 } });
    expect(verdicts[3]).toBeNull();
    for (const [i, a] of probes.entries()) {
      const out = m.apply("p1", a);
      expect(out.ok ? null : out.violation).toEqual(verdicts[i] ?? null);
    }
    expect(() => m.validate("p7", rename)).toThrow(EngineMisuse);

    const throwing = withHooks({
      guard: () => {
        throw new Error("guard exploded");
      },
    });
    const broken = createMatch(fixtureSetup(), throwing, fakeDomain, { invariants: "step" });
    const bug = bugOf(() =>
      broken.validate("p1", { type: "build", city: "c1", building: "tower" }),
    );
    expect(bug.kind).toBe("engine");
    expect(bug.message).toContain("guard exploded");
    expect(() => broken.advanceTo(10)).toThrow(EngineMisuse);
  });

  test("any other error thrown inside the kernel becomes an EngineBug of kind engine", () => {
    const m = fixtureMatch();
    const bug = bugOf(() =>
      testStep(m, () => {
        throw new TypeError("edit failed");
      }),
    );
    expect(bug.kind).toBe("engine");
    expect(bug.message).toContain("TypeError: edit failed");
    expect(bug.cause).toBeInstanceOf(TypeError);
    expect(() => m.advanceTo(10)).toThrow(EngineMisuse);
  });
});

describe("apply hands handlers the canonical action", () => {
  test("record keys are in canonical order, as in the replayed act line", () => {
    const seen: string[][] = [];
    const recording = withHooks({
      actions: {
        ...fixtureRuleset.hooks.actions,
        attack: {
          validate: (r, seat, a) => {
            if (a.type === "attack") seen.push(Object.keys(a.units));
            return fakeAttack.validate(r, seat, a);
          },
          apply: (ctx, seat, plan) => fakeAttack.apply(ctx, seat, plan),
        },
      },
    });
    const units: Record<string, number> = {};
    units["soldier"] = 2;
    units["ship"] = 1;
    const m = createMatch(fixtureSetup(), recording, fakeDomain, { invariants: "step" });
    m.apply("p1", { type: "attack", from: "c1", to: "c2", units });
    m.apply("p1", { type: "attack", from: "c1", to: "c2", units: { ship: 1, soldier: 2 } });
    expect(Object.keys(units)).toEqual(["soldier", "ship"]);
    expect(seen).toEqual([
      ["ship", "soldier"],
      ["ship", "soldier"],
    ]);
  });
});

type Finish = FixtureRuleset["hooks"]["finish"];

/** The fixture's own `finish`. */
const finishOf: Finish = (ctx) => fixtureRuleset.hooks.finish(ctx);

describe("endMatch (§5.2)", () => {
  test("an invalid result is an EngineBug at every invariant level", () => {
    const cases: [Finish, string][] = [
      [
        (ctx) => {
          const result = { ...finishOf(ctx), bogus: 1 };
          return result;
        },
        'Unrecognized key: "bogus"',
      ],
      [(ctx) => ({ ...finishOf(ctx), winners: ["p7"] }), "winners names p7, who is not a player"],
      [(ctx) => ({ ...finishOf(ctx), winners: ["p1", "p1"] }), "winners names p1 twice"],
      [(ctx) => ({ ...finishOf(ctx), endedAt: 5 }), "endedAt is 5; the match ends now, at 86400"],
      [
        (ctx) => {
          const r = finishOf(ctx);
          return { ...r, standings: [...r.standings, ...r.standings] };
        },
        "standings names p1 twice",
      ],
      [
        (ctx) => {
          const r = finishOf(ctx);
          for (const row of r.standings) row.score += 0.5;
          return r;
        },
        "the result is not canonical JSON",
      ],
    ];
    for (const [finish, message] of cases) {
      for (const invariants of ["off", "checkpoint", "step"] as const) {
        const m = createMatch(fixtureSetup(), withHooks({ finish }), fakeDomain, { invariants });
        const bug = bugOf(() => m.advanceTo(86400));
        expect(bug.kind).toBe("engine");
        expect(bug.message).toContain(message);
        expect(m.ended).toBe(false);
      }
    }
  });

  test("the kernel emits match_ended once; a ruleset that emits it is an EngineBug", () => {
    const m = fixtureMatch();
    const types = m.advanceTo(86400).events.map((e) => e.type);
    expect(types.filter((t) => t === "match_ended")).toHaveLength(1);
    const emitting = withHooks({
      on: {
        fixture_open: (ctx) => {
          ctx.emit({
            type: "match_ended",
            public: true,
            to: [],
            data: { reason: "x", winners: [] },
          });
        },
      },
    });
    const bug = bugOf(() => create({ ruleset: emitting }).advanceTo(7200));
    expect(bug.message).toContain("match_ended is emitted by the kernel");
  });
});
