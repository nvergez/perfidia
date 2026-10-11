// The match host and `runMatch` (docs/architecture.md §7.2, §7.4, §8.3, §8.7, §9.1, §10.2, §10.3):
// the turn rules, the line kinds and their order, caps, batches and "max", end_turn, INTERNAL,
// fatal paths, snapshots, hand-offs and the lockstep per-second cap, with scripted agents.

import { describe, expect, test } from "bun:test";
import { createMatch, verifyLog, type AnyRuleset } from "@perfidia/engine";
import { EngineBug, MatchConfigError } from "@perfidia/engine/kernel";
import { AgentRoundError } from "@perfidia/gateway/clock";
import { seatOf } from "@perfidia/gateway/seat";
import {
  ToolResultSchema,
  type CityId,
  type LogLine,
  type MatchSetup,
  type PlayerId,
  type RoundInput,
  type SeatAgent,
  type Snapshot,
  type ToolError,
  type ToolResult,
} from "@perfidia/protocol";
import {
  GatewayInternalError,
  HostFailure,
  MatchHost,
  MemorySink,
  createToolRegistry,
  runMatch,
  type LogSink,
  type ToolRegistry,
  type ToolSpec,
} from "./index.ts";
import {
  FIXTURE,
  PERFIDIA,
  SANDBOX,
  Scripted,
  agentsFor,
  call,
  idle,
  linesOf,
  manualHost,
  script,
  setupOf,
} from "./testkit.test.ts";

/** A lockstep run in memory (strict, step invariants) whose log passes Level E. */
async function lockstep(
  ruleset: AnyRuleset,
  setup: MatchSetup,
  agents: Readonly<Record<string, SeatAgent>>,
  extra: { readonly maxTurnsPerSecond?: number; readonly snapshotEvery?: number } = {},
): Promise<{ lines: LogLine[]; sink: MemorySink }> {
  const sink = new MemorySink();
  await runMatch({
    setup,
    ruleset,
    agents: agentsFor(setup, agents),
    clock: {
      kind: "lockstep",
      ...(extra.maxTurnsPerSecond === undefined
        ? {}
        : { maxTurnsPerSecond: extra.maxTurnsPerSecond }),
    },
    sink,
    strict: true,
    invariants: "step",
    ...(extra.snapshotEvery === undefined ? {} : { snapshotEvery: extra.snapshotEvery }),
  });
  const lines = sink.parsed();
  const report = verifyLog(lines, (ref) => (ref === ruleset.ref ? ruleset : undefined));
  expect(report.divergence).toBeUndefined();
  expect(report.ok).toBe(true);
  return { lines, sink };
}

const own = (input: RoundInput): CityId => input.briefing.cities[0]?.id ?? "c0";

/** The error a promise rejects with; throws when it resolves. */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

/** The ruleset's tools, with view_map made to throw (a test double). */
function throwingViewMap(ruleset: AnyRuleset): ToolRegistry {
  const tools = new Map(createToolRegistry(ruleset));
  const real = tools.get("view_map");
  if (real === undefined) throw new Error("no view_map");
  const broken: ToolSpec = {
    name: real.name,
    family: real.family,
    kind: real.kind,
    description: real.description,
    args: real.args,
    handle() {
      throw new Error("the map is on fire");
    },
  };
  tools.set("view_map", broken);
  return tools;
}

/** The ruleset's tools, with `name` made to run its real handler and then throw (a test double). */
function throwingAfter(ruleset: AnyRuleset, name: string): ToolRegistry {
  const tools = new Map(createToolRegistry(ruleset));
  const real = tools.get(name);
  if (real === undefined) throw new Error(`no ${name}`);
  const broken: ToolSpec = {
    ...real,
    handle(env, args) {
      real.handle(env, args);
      throw new Error("explaining the result failed");
    },
  };
  tools.set(name, broken);
  return tools;
}

/** A host whose turn gate throws (a test double of layer 1). */
class BrokenGate extends MatchHost {
  override gate(): ToolError | null {
    throw new Error("the gate is stuck");
  }
}

function brokenGateHost(strict: boolean): { host: MatchHost; sink: MemorySink } {
  const setup = setupOf(SANDBOX, 2);
  const sink = new MemorySink();
  const host = new BrokenGate({
    match: createMatch(setup, SANDBOX, { invariants: "step" }),
    sink,
    agents: agentsFor(setup, {}),
    clock: { kind: "lockstep", maxTurnsPerSecond: 3 },
    strict,
  });
  host.start();
  return { host, sink };
}

/** A sink that records the order of writes, flushes and snapshots. */
class Recording implements LogSink {
  readonly events: string[] = [];

  write(line: LogLine): void {
    this.events.push(line.k === "ckpt" ? `ckpt ${line.hour}` : line.k);
  }

  snapshot(snap: Snapshot): void {
    this.events.push(`snapshot ${snap.hour}`);
  }

  flush(): void {
    this.events.push("flush");
  }
}

/** Reads the map every hour. */
function hourly(): Scripted {
  return new Scripted("test:hourly", (input) =>
    input.round === 0
      ? { calls: [call("view_map"), call("end_turn", { nextWakeIn: 3600 })] }
      : { calls: [] },
  );
}

function failed(r: ToolResult | undefined): { code: string; details?: unknown } {
  if (r === undefined || r.ok) throw new Error(`expected a failure, got ${JSON.stringify(r)}`);
  return r;
}

describe("caps and the turn gate", () => {
  test("cap rejections write gw lines with their details and never reach the engine", async () => {
    const setup = setupOf(SANDBOX, 2, { "time.matchEnd": 3600 });
    const message = call("send_message", { to: ["p2"], text: "hello" });
    const p1 = script([
      [Array.from({ length: 10 }, () => message), Array.from({ length: 3 }, () => message)],
    ]);
    const { lines } = await lockstep(SANDBOX, setup, { p1 });

    const acts = linesOf(lines, "act").filter((l) => l.seat === "p1");
    expect(acts).toHaveLength(10);
    expect(acts.every((l) => l.r.ok && l.tool === "send_message")).toBe(true);
    const messages = linesOf(lines, "ev").filter((l) => l.e.type === "message");
    expect(messages).toHaveLength(10);
    // Each act line comes right before the ev line of the message it sent (§10.2).
    for (const act of acts) {
      const next = lines[lines.indexOf(act) + 1];
      expect(next).toMatchObject({ k: "ev", e: { type: "message" } });
    }
    const gw = linesOf(lines, "gw");
    expect(gw.map((l) => [l.rt, l.r])).toEqual([
      [0, { ok: false, code: "CALLS_CAP", details: { scope: "round", cap: 8, used: 8 } }],
      [0, { ok: false, code: "CALLS_CAP", details: { scope: "round", cap: 8, used: 8 } }],
      [
        1,
        {
          ok: false,
          code: "DAILY_CAP",
          details: { kind: "messages", cap: 10, used: 10, availableAt: 86400 },
        },
      ],
    ]);
    const results = p1.results(1, 1);
    expect(failed(results[2]).code).toBe("DAILY_CAP");
    expect(results.slice(0, 2).every((r) => r.ok)).toBe(true);
  });

  test("calls beyond the round cap get CALLS_CAP, calls after end_turn get TURN_OVER, and the next lastTurn reports both", async () => {
    const setup = setupOf(SANDBOX, 2, { "time.matchEnd": 7200 });
    const view = call("view_map");
    const p1 = script([
      [
        Array.from({ length: 9 }, () => view),
        [call("end_turn", { nextWakeIn: 3600 }), view, call("leaderboard")],
      ],
      [[call("end_turn")]],
    ]);
    const { lines } = await lockstep(SANDBOX, setup, { p1 });
    expect(p1.results(1, 0).map((r) => (r.ok ? "ok" : r.code))).toEqual([
      ...Array.from({ length: 8 }, () => "ok"),
      "CALLS_CAP",
    ]);
    const second = p1.turn(2)[0];
    expect(second?.briefing.t).toBe(3600);
    expect(second?.briefing.wake.reasons).toEqual(["self"]);
    expect(second?.briefing.lastTurn).toMatchObject({
      ended: "end_turn",
      unseen: [
        { tool: "view_map", code: "CALLS_CAP" },
        { tool: "view_map", code: "TURN_OVER", count: 2 },
      ],
      nextWake: { at: [3600, "D1 01:00"], kind: "self" },
    });
    const turn = linesOf(lines, "turn").find((l) => l.seat === "p1");
    expect(turn).toMatchObject({ rounds: 2, calls: 12, why: "end_turn", selfAt: 3600 });
    expect(linesOf(lines, "obs").filter((l) => l.seat === "p1")).toHaveLength(8);
  });

  test("end_turn clamps and warns, end_turn {} keeps the pending self-wake, both fields are INVALID_ARGS without ending the turn", async () => {
    const setup = setupOf(SANDBOX, 2, { "time.matchEnd": 7200 });
    const p1 = script([
      [[call("end_turn", { nextWakeIn: 10 })]],
      [[call("end_turn", { nextWakeIn: 600, wakeAt: 900 })], [call("end_turn")]],
      [[call("end_turn", { nextWakeIn: 2000 })]],
    ]);
    const p2 = script([
      [[call("send_message", { to: ["p1"], text: "wake up" }), call("end_turn")]],
    ]);
    const { lines } = await lockstep(SANDBOX, setup, { p1, p2 });

    // Turn 1 at t = 0: 10 s is below selfWake.min (1800 s): clamped to 1800.
    const t1 = linesOf(lines, "turn").filter((l) => l.seat === "p1");
    expect(t1[0]).toMatchObject({
      t: 0,
      why: "end_turn",
      selfAt: 1800,
      next: { at: 300, kind: "social" },
    });
    // Turn 2 at t = 300 (p2's message): both fields are rejected and the turn goes on.
    const second = p1.turn(2);
    expect(second[0]?.briefing.t).toBe(300);
    const reasons = second[0]?.briefing.wake.reasons ?? [];
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/^message g/);
    const both = failed(second[1]?.results[0]);
    expect(both.code).toBe("INVALID_ARGS");
    // end_turn {} keeps the pending self-wake of turn 1.
    const third = p1.turn(3)[0];
    expect(third?.briefing.t).toBe(1800);
    expect(third?.briefing.wake.reasons).toEqual(["self"]);
    expect(t1[1]).toMatchObject({ t: 300, rounds: 2, why: "end_turn", selfAt: 1800 });
    expect(t1[2]).toMatchObject({ t: 1800, selfAt: 3800, next: { at: 3800, kind: "self" } });
    // The results the agent saw (the next round's input, or the next turn's lastTurn).
    const gw = linesOf(lines, "gw").filter((l) => l.seat === "p1");
    expect(gw.map((l) => [l.turn, l.rt, l.tool, l.r.code])).toEqual([
      [2, 0, "end_turn", "INVALID_ARGS"],
    ]);
  });

  test("end_turn results: the clamped wake with its warning, and the kept one", () => {
    const { host } = manualHost(SANDBOX, setupOf(SANDBOX, 2));
    const h = host.openTurn("p1");
    h.execute({ calls: [call("end_turn", { nextWakeIn: 10 })] });
    const [r] = h.input().results;
    expect(r).toEqual({
      ok: true,
      t: 0,
      data: { wakeAt: [1800, "D1 00:30"], clamped: true },
      warnings: [
        {
          code: "WAKE_CLAMPED",
          message:
            "The wake at D1 00:00:10 is outside the self-wake range; it is set to D1 00:30. A self-wake is 30m to 6h ahead of the end_turn call.",
        },
      ],
    });
    expect(h.done).toBe(true);
    h.close();
    const h2 = host.openTurn("p2");
    h2.execute({ calls: [call("end_turn"), call("view_map")] });
    const [kept, over] = h2.input().results;
    expect(kept).toEqual({ ok: true, t: 0, data: { wakeAt: null, clamped: false } });
    expect(failed(over).code).toBe("TURN_OVER");
    h2.close();
  });
});

describe("batches and max", () => {
  test("batch items get consecutive n, their item index and per-item results", async () => {
    const setup = setupOf(SANDBOX, 2, { "time.matchEnd": 3600 });
    let city: CityId = "c0";
    const p1 = new Scripted("test:builder", (input) => {
      city = own(input);
      return input.turn === 1 && input.round === 0
        ? { calls: [call("build", { city, buildings: ["sawmill", "camp", "pit"] })] }
        : { calls: [] };
    });
    const { lines } = await lockstep(SANDBOX, setup, { p1 });
    const acts = linesOf(lines, "act").filter((l) => l.seat === "p1");
    expect(acts.map((l) => [l.n, l.i, l.tool, l.a, l.r])).toEqual([
      [1, 0, "build", { type: "build", city, building: "sawmill" }, { ok: true }],
      [
        2,
        1,
        "build",
        { type: "build", city, building: "camp" },
        { ok: false, code: "REQUIREMENT_MISSING" },
      ],
      [3, 2, "build", { type: "build", city, building: "pit" }, { ok: true }],
    ]);
    const [result] = p1.results(1, 0);
    expect(result?.ok).toBe(true);
    if (!result?.ok) throw new Error("the batch failed");
    expect(result.data["items"]).toMatchObject([
      { ok: true, building: "sawmill", level: 2, item: 1 },
      { ok: false, code: "REQUIREMENT_MISSING" },
      { ok: true, building: "pit", level: 2, item: 2 },
    ]);
  });

  test('[{guard, "max"}, {raider, "max"}] resolves the second order against what the first left', async () => {
    const setup = setupOf(PERFIDIA, 6, {
      "time.matchEnd": 3600,
      "start.capital.buildings.barracks": 1,
    });
    let city: CityId = "c0";
    const p1 = new Scripted("test:recruiter", (input) => {
      city = own(input);
      const orders = [
        { unit: "guard", count: "max" },
        { unit: "raider", count: "max" },
      ];
      return input.turn === 1 && input.round === 0
        ? { calls: [call("recruit", { city, orders })] }
        : { calls: [] };
    });
    const { lines } = await lockstep(PERFIDIA, setup, { p1 });
    // 800/800/800 in stock, 52 free pop: 13 guards (30/60/30 each: stone binds) leave 410/20/410,
    // so a single raider (50/20/60): against the initial stock it would have been 13.
    const acts = linesOf(lines, "act").filter((l) => l.seat === "p1");
    expect(acts.map((l) => [l.i, l.a])).toEqual([
      [0, { type: "recruit", city, unit: "guard", count: 13 }],
      [1, { type: "recruit", city, unit: "raider", count: 1 }],
    ]);
    const [result] = p1.results(1, 0);
    if (!result?.ok) throw new Error("the batch failed");
    expect(result.data["items"]).toMatchObject([
      { ok: true, unit: "guard", count: 13, cost: { wood: 390, stone: 780, gold: 390 } },
      { ok: true, unit: "raider", count: 1, cost: { wood: 50, stone: 20, gold: 60 } },
    ]);
  });

  test('"max" that resolves to 0 sends nothing, names the binding constraint and is logged as a gw item for lastTurn', () => {
    const setup = setupOf(PERFIDIA, 6, {
      "start.capital.buildings.barracks": 1,
      "start.capital.stock.stone": 0,
    });
    const { host, sink } = manualHost(PERFIDIA, setup);
    const h = host.openTurn("p1");
    const city = h.input().briefing.cities[0]?.id ?? "";
    const orders = [
      { unit: "guard", count: "max" },
      { unit: "raider", count: "max" },
    ];
    h.execute({ calls: [call("recruit", { city, orders }), call("end_turn")] });
    const [r] = h.input().results;
    if (!r?.ok) throw new Error("the call failed as a whole");
    // No stone: a guard (30/60/30) is unaffordable, so "max" is 0 and a count of 1 names the
    // shortage; raiders (50/20/60) need stone too. No act line is written for either: each item
    // gets a gw line with its index and the details, numbered like the items of a batch.
    expect(r.data["items"]).toMatchObject([
      { ok: false, code: "INSUFFICIENT_RESOURCES", details: { unit: "guard", need_stone: 60 } },
      { ok: false, code: "INSUFFICIENT_RESOURCES", details: { unit: "raider", need_stone: 20 } },
    ]);
    const lines = sink.parsed();
    expect(lines.filter((l) => l.k === "act")).toEqual([]);
    const gw = linesOf(lines, "gw");
    expect(gw.map((l) => [l.n, l.i, l.tool, l.r.code, l.r.details?.["unit"]])).toEqual([
      [1, 0, "recruit", "INSUFFICIENT_RESOURCES", "guard"],
      [2, 1, "recruit", "INSUFFICIENT_RESOURCES", "raider"],
    ]);
    expect(gw.every((l) => l.error === undefined)).toBe(true);
    h.close();
    // The agent never saw these results (its last round): lastTurn lists both, as it lists the
    // engine's rejection of the same order with an explicit count.
    const unseen = seatOf(host.gw, "p1").lastTurn?.unseen ?? [];
    expect(unseen.map((u) => [u.tool, u.code, u.count])).toEqual([
      ["recruit", "INSUFFICIENT_RESOURCES", undefined],
      ["recruit", "INSUFFICIENT_RESOURCES", undefined],
    ]);
    expect(unseen[0]?.message).toContain("guard");
    expect(unseen[1]?.message).toContain("raider");

    const explicit = manualHost(PERFIDIA, setup);
    const h2 = explicit.host.openTurn("p1");
    const one = [
      { unit: "guard", count: 1 },
      { unit: "raider", count: 1 },
    ];
    h2.execute({ calls: [call("recruit", { city, orders: one }), call("end_turn")] });
    h2.close();
    expect(explicit.sink.parsed().filter((l) => l.k === "act")).toHaveLength(2);
    expect(seatOf(explicit.host.gw, "p1").lastTurn?.unseen).toEqual(unseen);
  });
});

describe("INTERNAL and fatal paths", () => {
  test("a read tool that throws returns INTERNAL, writes a gw line with the error and leaves the hash unchanged", () => {
    const tools = throwingViewMap(SANDBOX);
    const { host, match, sink } = manualHost(SANDBOX, setupOf(SANDBOX, 2), { tools });
    const h = host.openTurn("p1");
    const before = match.hash();
    h.execute({ calls: [call("view_map"), call("leaderboard")] });
    expect(match.hash()).toBe(before);
    const [broken, fine] = h.input().results;
    expect(ToolResultSchema.parse(broken)).toMatchObject({
      ok: false,
      t: 0,
      code: "INTERNAL",
      message: "The gateway failed on this call; nothing was applied.",
    });
    expect(fine?.ok).toBe(true);
    h.execute({ calls: [] });
    const gw = sink.parsed().filter((l) => l.k === "gw");
    expect(gw).toEqual([
      {
        k: "gw",
        n: 1,
        t: 0,
        seat: "p1",
        turn: 1,
        rt: 0,
        tool: "view_map",
        r: { ok: false, code: "INTERNAL" },
        error: "Error: the map is on fire",
      },
    ]);
    h.close();
  });

  test("INTERNAL is fatal in strict mode: the gw line, then a fatal line, and runMatch rethrows", async () => {
    const tools = throwingViewMap(SANDBOX);
    const { host } = manualHost(SANDBOX, setupOf(SANDBOX, 2), { tools, strict: true });
    const h = host.openTurn("p1");
    expect(() => h.execute({ calls: [call("view_map")] })).toThrow(GatewayInternalError);

    const setup = setupOf(SANDBOX, 2);
    const sink = new MemorySink();
    const run = runMatch({
      setup,
      ruleset: SANDBOX,
      agents: agentsFor(setup, { p1: script([[[call("view_map")]]]) }),
      clock: { kind: "lockstep" },
      sink,
      strict: true,
      tools,
    });
    expect(await rejection(run)).toBeInstanceOf(GatewayInternalError);
    const lines = sink.parsed();
    expect(lines.at(-2)).toMatchObject({ k: "gw", r: { code: "INTERNAL" } });
    const fatal = lines.at(-1);
    expect(fatal).toMatchObject({ k: "fatal", t: 0, error: { kind: "driver" } });
    expect(fatal?.k === "fatal" ? fatal.error.message : "").toContain("the map is on fire");
  });

  test("a tool that throws after it changed the match is a HostFailure, never INTERNAL", () => {
    const setup = setupOf(SANDBOX, 2);
    const cases: [string, (city: CityId) => unknown][] = [
      ["build", (city) => ({ city, buildings: ["sawmill"] })],
      ["write_note", () => ({ text: "plan", mode: "replace" })],
      ["end_turn", () => ({ nextWakeIn: 3600 })],
    ];
    for (const [tool, args] of cases) {
      const tools = throwingAfter(SANDBOX, tool);
      const { host, match, sink } = manualHost(SANDBOX, setup, { tools });
      const h = host.openTurn("p1");
      const city = h.input().briefing.cities[0]?.id ?? "c0";
      const before = match.hash();
      expect(() => h.execute({ calls: [call(tool, args(city))] })).toThrow(HostFailure);
      const lines = sink.parsed();
      // What the call did stays done and logged, and no gw line claims that nothing was applied.
      expect(lines.filter((l) => l.k === "gw")).toEqual([]);
      const s = seatOf(host.gw, "p1");
      if (tool === "build") {
        expect(linesOf(lines, "act").map((l) => l.r)).toEqual([{ ok: true }]);
        expect(match.hash()).not.toBe(before);
      } else if (tool === "write_note") {
        expect(linesOf(lines, "note").map((l) => l.text)).toEqual(["plan"]);
        expect(s.notes).toBe("plan");
      } else {
        expect(s.wake.selfAt).toBe(3600);
      }
    }
  });

  test("runMatch aborts on such a failure with a fatal line after the applied action, strict or not", async () => {
    const setup = setupOf(SANDBOX, 2);
    let city: CityId = "c0";
    const p1 = new Scripted("test:builder", (input) => {
      city = own(input);
      return { calls: [call("build", { city, buildings: ["sawmill"] })] };
    });
    for (const strict of [false, true]) {
      const sink = new MemorySink();
      const run = runMatch({
        setup,
        ruleset: SANDBOX,
        agents: agentsFor(setup, { p1 }),
        clock: { kind: "lockstep" },
        sink,
        strict,
        tools: throwingAfter(SANDBOX, "build"),
      });
      // oxlint-disable-next-line no-await-in-loop -- one mode at a time, each with its own sink
      expect(await rejection(run)).toBeInstanceOf(HostFailure);
      const lines = sink.parsed();
      expect(linesOf(lines, "act").map((l) => [l.tool, l.r])).toEqual([["build", { ok: true }]]);
      const fatal = lines.at(-1);
      expect(fatal).toMatchObject({ k: "fatal", error: { kind: "driver" } });
      expect(fatal?.k === "fatal" ? fatal.error.message : "").toContain(
        "cannot be reported as INTERNAL",
      );
      expect(lines.some((l) => l.k === "gw")).toBe(false);
    }
  });

  test("a turn gate that throws gives INTERNAL with a gw line, runs nothing, and is fatal in strict mode", () => {
    const { host, sink } = brokenGateHost(false);
    const h = host.openTurn("p1");
    h.execute({ calls: [call("view_map"), call("end_turn")] });
    const results = h.input().results;
    expect(results.map((r) => (r.ok ? "ok" : r.code))).toEqual(["INTERNAL", "INTERNAL"]);
    const lines = sink.parsed();
    expect(linesOf(lines, "gw").map((l) => [l.n, l.tool, l.r, l.error])).toEqual([
      [1, "view_map", { ok: false, code: "INTERNAL" }, "Error: the gate is stuck"],
      [2, "end_turn", { ok: false, code: "INTERNAL" }, "Error: the gate is stuck"],
    ]);
    expect(lines.some((l) => l.k === "obs")).toBe(false);
    expect(h.done).toBe(false);

    const strict = brokenGateHost(true);
    const h2 = strict.host.openTurn("p1");
    expect(() => h2.execute({ calls: [call("view_map")] })).toThrow(GatewayInternalError);
    expect(strict.sink.parsed().at(-1)).toMatchObject({ k: "gw", r: { code: "INTERNAL" } });
  });

  test("an explainer that throws on an engine rejection gives the bare code, never INTERNAL", () => {
    const wordless: AnyRuleset = {
      ...SANDBOX,
      errors: {
        ...SANDBOX.errors,
        CITY_NAME_INVALID: () => {
          throw new Error("no words");
        },
      },
    };
    const setup = setupOf(SANDBOX, 2);
    const match = createMatch(setup, wordless, { invariants: "step" });
    const sink = new MemorySink();
    const host = new MatchHost({
      match,
      sink,
      agents: agentsFor(setup, {}),
      clock: { kind: "lockstep", maxTurnsPerSecond: 3 },
      strict: true,
    });
    host.start();
    const h = host.openTurn("p1");
    const city = h.input().briefing.cities[0]?.id ?? "c0";
    h.execute({ calls: [call("rename_city", { city, name: "A".repeat(20) }), call("end_turn")] });
    const [renamed] = h.input().results;
    expect(renamed).toMatchObject({
      ok: false,
      code: "CITY_NAME_INVALID",
      message: "CITY_NAME_INVALID",
      details: { city, reason: "length" },
    });
    h.close();
    const lines = sink.parsed();
    expect(linesOf(lines, "act").map((l) => l.r)).toEqual([
      { ok: false, code: "CITY_NAME_INVALID" },
    ]);
    expect(lines.some((l) => l.k === "gw")).toBe(false);
    expect(seatOf(host.gw, "p1").lastTurn?.unseen).toEqual([
      { tool: "rename_city", code: "CITY_NAME_INVALID", message: "CITY_NAME_INVALID" },
    ]);
  });

  test("an agent error in strict mode writes a fatal line of kind agent and rethrows", async () => {
    const setup = setupOf(SANDBOX, 2);
    const sink = new MemorySink();
    const broken: SeatAgent = {
      label: "test:broken",
      round: () => Promise.reject(new Error("no idea")),
    };
    const run = runMatch({
      setup,
      ruleset: SANDBOX,
      agents: agentsFor(setup, { p2: broken }),
      clock: { kind: "lockstep" },
      sink,
      strict: true,
    });
    expect(await rejection(run)).toBeInstanceOf(AgentRoundError);
    const lines = sink.parsed();
    expect(lines.at(-2)).toMatchObject({
      k: "turn",
      seat: "p2",
      why: "error",
      error: "Error: no idea",
    });
    expect(lines.at(-1)).toMatchObject({
      k: "fatal",
      error: { kind: "agent", message: "AgentRoundError: p2: round failed: Error: no idea" },
    });
  });

  test("an engine bug is fatal whatever the mode: a fatal line of the engine's kind, then the rethrow", async () => {
    const hooks = SANDBOX.hooks;
    const buggy: AnyRuleset = {
      ...SANDBOX,
      hooks: {
        ...hooks,
        afterStep(ctx, step) {
          if (step.cause.kind === "action") throw new Error("afterStep exploded");
          hooks.afterStep?.(ctx, step);
        },
      },
    };
    const setup = setupOf(SANDBOX, 2);
    const sink = new MemorySink();
    const run = runMatch({
      setup,
      ruleset: buggy,
      agents: agentsFor(setup, {
        p1: script([[[call("send_message", { to: "all", text: "x" })]]]),
      }),
      clock: { kind: "lockstep" },
      sink,
    });
    expect(await rejection(run)).toBeInstanceOf(EngineBug);
    const lines = sink.parsed();
    const fatal = lines.at(-1);
    expect(fatal).toMatchObject({ k: "fatal", t: 0, error: { kind: "engine" } });
    expect(fatal?.k === "fatal" ? fatal.error.message : "").toContain("afterStep exploded");
    // The action that reached the engine is not logged as applied: the match aborted inside it.
    expect(lines.filter((l) => l.k === "act")).toEqual([]);
  });

  test("a setup that fails the checks is a MatchConfigError before any line is written", async () => {
    const setup = setupOf(SANDBOX, 2, { "time.matchEnd": 0 });
    const sink = new MemorySink();
    const error = await rejection(
      runMatch({
        setup,
        ruleset: SANDBOX,
        agents: agentsFor(setup, {}),
        clock: { kind: "lockstep" },
        sink,
      }),
    );
    expect(error).toBeInstanceOf(MatchConfigError);
    expect(String(error)).toContain("time.matchEnd");
    expect(sink.lines).toEqual([]);
  });
});

describe("snapshots, hand-offs and the per-second cap", () => {
  test("every snapshot's hash equals its ckpt line, afterN is the last n before it, and Level E resumes from each", async () => {
    const setup = setupOf(SANDBOX, 2, { "time.matchEnd": 86400 });
    const { lines, sink } = await lockstep(
      SANDBOX,
      setup,
      { p1: hourly(), p2: hourly() },
      { snapshotEvery: 6 },
    );
    const snaps = sink.parsedSnapshots();
    expect(snaps.map((s) => [s.hour, s.t])).toEqual([
      [6, 21600],
      [12, 43200],
      [18, 64800],
      [23, 86400],
    ]);
    for (const snap of snaps.slice(0, -1)) {
      const i = lines.findIndex((l) => l.k === "ckpt" && l.hour === snap.hour);
      const ckpt = lines[i];
      expect(ckpt).toMatchObject({ k: "ckpt", h: snap.hash });
      const numbered = lines
        .slice(0, i)
        .flatMap((l) =>
          l.k === "act" || l.k === "gw" || l.k === "obs" || l.k === "note" ? [l.n] : [],
        );
      expect(snap.afterN).toBe(numbered.at(-1) ?? 0);
      expect(snap.afterN).toBeGreaterThan(0);
      const report = verifyLog(lines, { from: snap });
      expect(report.divergence).toBeUndefined();
    }
    const final = snaps.at(-1);
    expect(lines.at(-1)).toMatchObject({ k: "end", h: final?.hash });
  });

  test("the sink is flushed after every step that wrote checkpoint lines, before their snapshot, and around the final one", async () => {
    const setup = setupOf(SANDBOX, 2, { "time.matchEnd": 6 * 3600 });
    const sink = new Recording();
    await runMatch({
      setup,
      ruleset: SANDBOX,
      agents: agentsFor(setup, { p1: hourly(), p2: hourly() }),
      clock: { kind: "lockstep" },
      sink,
      strict: true,
      snapshotEvery: 2,
    });
    const ev = sink.events;
    const ckpts = ev.flatMap((e, i) => (e.startsWith("ckpt ") ? [i] : []));
    expect(ckpts).toHaveLength(5);
    // After a ckpt line, only the step's other ev and ckpt lines come before the flush.
    for (const i of ckpts) {
      const next = ev.slice(i + 1).find((e) => e !== "ev" && !e.startsWith("ckpt "));
      expect([ev[i], next]).toEqual([ev[i], "flush"]);
    }
    for (const hour of [2, 4]) {
      const at = ev.indexOf(`snapshot ${hour}`);
      expect(ev.slice(ev.indexOf(`ckpt ${hour}`), at)).toContain("flush");
    }
    expect(ev.slice(-4)).toEqual(["end", "flush", "snapshot 5", "flush"]);
  });

  test("a hand-off writes a controller line at the seat's first turn at or after its time", async () => {
    const setup = setupOf(SANDBOX, 2, { "time.matchEnd": 14400 });
    const first = hourly();
    const second = new Scripted("test:second", () => ({
      calls: [call("end_turn", { nextWakeIn: 7200 })],
    }));
    const sink = new MemorySink();
    await runMatch({
      setup,
      ruleset: SANDBOX,
      agents: agentsFor(setup, { p2: first }),
      clock: { kind: "lockstep" },
      sink,
      strict: true,
      handoffs: [{ seat: "p2", at: 5000, label: second.label, agent: second }],
    });
    const lines = sink.parsed();
    const header = lines[0];
    expect(header).toMatchObject({
      k: "header",
      controllers: { p1: "test:idle", p2: "test:hourly" },
    });
    const controller = linesOf(lines, "controller");
    // p2's turns: 0, 3600, 7200 (the first at or after 5000), then 14400 is the end.
    expect(controller).toEqual([{ k: "controller", t: 7200, seat: "p2", label: "test:second" }]);
    const i = lines.findIndex((l) => l.k === "controller");
    expect(lines[i + 1]).toMatchObject({ k: "wake", t: 7200, seat: "p2" });
    expect(first.inputs.map((x) => x.briefing.t)).toEqual([0, 3600]);
    expect(second.inputs.map((x) => x.briefing.t)).toEqual([7200]);
  });

  test("the lockstep per-second cap defers a seat woken again at the same second (defer line)", async () => {
    const setup = setupOf(FIXTURE, 2, { "time.matchEnd": 3600 });
    const p1 = new Scripted("test:attacker", (input) =>
      input.turn === 1 && input.round === 0
        ? {
            calls: [
              call("attack", { from: "c1", to: "c2", units: { soldier: 2 } }),
              call("end_turn"),
            ],
          }
        : { calls: [] },
    );
    const { lines } = await lockstep(FIXTURE, setup, { p1 }, { maxTurnsPerSecond: 1 });
    const defers = linesOf(lines, "defer");
    expect(defers).toEqual([{ k: "defer", t: 0, seat: "p2", to: 1 }]);
    const wakes = linesOf(lines, "wake").filter((l) => l.seat === "p2");
    expect(wakes.map((l) => [l.t, l.urgent])).toEqual([
      [0, false],
      [1, true],
    ]);
    expect(wakes[1]?.reasons[0]).toMatch(/^incoming_attack m/);
  });
});

describe("turn handles (§9.1)", () => {
  test("close(failure) logs the failure's cause as why and its error; done after the end still executes once", () => {
    const setup = setupOf(SANDBOX, 2, { "time.matchEnd": 3600 });
    const { host, sink } = manualHost(SANDBOX, setup);
    const h1 = host.openTurn("p1");
    h1.close({ error: "no answer within 5000 ms", cause: "timeout" });
    const h2 = host.openTurn("p2");
    expect(h2.done).toBe(false);
    // The match ends while p2 is thinking: its answered round is still executed, each call refused.
    host.advanceTo(3600);
    expect(host.ended()).toBe(true);
    expect(h2.done).toBe(true);
    h2.execute({ calls: [call("view_map"), call("end_turn")], thought: "too late" });
    expect(h2.input().results.map((r) => (r.ok ? "ok" : r.code))).toEqual([
      "MATCH_ENDED",
      "MATCH_ENDED",
    ]);
    h2.close();
    expect(() => h2.close()).toThrow("close() called twice");
    expect(() => h2.execute({ calls: [] })).toThrow("closed turn");
    host.finish();
    const lines = sink.parsed();
    const turns = linesOf(lines, "turn");
    expect(turns.map((l) => [l.seat, l.t, l.why, l.error, l.thought, l.next])).toEqual([
      ["p1", 0, "timeout", "no answer within 5000 ms", undefined, { at: 21600, kind: "safety" }],
      ["p2", 3600, "match_ended", undefined, "too late", null],
    ]);
    expect(linesOf(lines, "gw").map((l) => [l.tool, l.r.code])).toEqual([
      ["view_map", "MATCH_ENDED"],
      ["end_turn", "MATCH_ENDED"],
    ]);
    expect(lines.at(-1)).toMatchObject({ k: "end", t: 3600 });
    // Nothing is accepted after the end line.
    expect(() => host.openTurn("p1")).toThrow("after the match finished");
  });
});

describe("hand-off and agent bookkeeping", () => {
  test("runMatch refuses a seat without an agent and a setup naming another ruleset", async () => {
    const setup = setupOf(SANDBOX, 2);
    const agents = new Map<PlayerId, SeatAgent>([["p1", idle()]]);
    const noAgent = await rejection(
      runMatch({
        setup,
        ruleset: SANDBOX,
        agents,
        clock: { kind: "lockstep" },
        sink: new MemorySink(),
      }),
    );
    expect(String(noAgent)).toContain("seat p2 has no agent");
    const otherRuleset = await rejection(
      runMatch({
        setup,
        ruleset: PERFIDIA,
        agents: agentsFor(setup, {}),
        clock: { kind: "lockstep" },
        sink: new MemorySink(),
      }),
    );
    expect(otherRuleset).toBeInstanceOf(MatchConfigError);
    expect(String(otherRuleset)).toContain("setup.ruleset");
  });
});
