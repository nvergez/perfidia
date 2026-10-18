// The gateway state rebuild (docs/architecture.md §10.5) with scripted test agents: the rebuilt
// state equals the live one `runMatch` returns, under lockstep and real time, with every line kind
// that drives the gateway (notes, accepted and rejected actions, gateway rejections of every layer,
// the daily message cap included, batch items, INTERNAL, end_turn, deferred turns, messages, public
// messages); and a log with a line removed or changed is rebuilt to another state or reported as a
// drift, never a throw. The incremental fold (`createGatewayFold`) driven by the incremental replay
// gives the same state, also when resumed from a JSON copy of its state midway.

import { describe, expect, test } from "bun:test";
import { createMatch, createReplay, type AnyRuleset } from "@perfidia/engine";
import { canonicalJson } from "@perfidia/engine/core";
import { VirtualTime } from "@perfidia/gateway/clock";
import { seatOf, type GatewayState } from "@perfidia/gateway/seat";
import type {
  CityId,
  LogLine,
  MatchSetup,
  PlayerId,
  RoundInput,
  RoundOutput,
  SeatAgent,
  TimeSource,
  ToolCall,
} from "@perfidia/protocol";
import {
  MemorySink,
  createGatewayFold,
  createToolRegistry,
  rebuildGatewayState,
  runMatch,
  type GatewayFold,
  type RunMatchOptions,
  type ToolRegistry,
  type ToolSpec,
} from "./index.ts";
import {
  PERFIDIA,
  SANDBOX,
  Scripted,
  call,
  idle,
  linesOf,
  manualHost,
  setupOf,
} from "./testkit.test.ts";

const resolveOf =
  (ruleset: AnyRuleset) =>
  (ref: string): AnyRuleset | undefined =>
    ref === ruleset.ref ? ruleset : undefined;

const text = (gw: GatewayState): string => canonicalJson(gw);

const own = (input: RoundInput): CityId => input.briefing.cities[0]?.id ?? "c0";

/** The ruleset's tools, with view_map made to throw (INTERNAL). */
function throwingViewMap(ruleset: AnyRuleset): ToolRegistry {
  const tools = new Map(createToolRegistry(ruleset));
  const real = tools.get("view_map");
  if (real === undefined) throw new Error("no view_map");
  const broken: ToolSpec = {
    ...real,
    handle() {
      throw new Error("the map is on fire");
    },
  };
  tools.set("view_map", broken);
  return tools;
}

/**
 * p1 exercises every gateway line kind: notes (accepted and too long), accepted and rejected
 * actions, batches whose second "max" resolves to 0 once the unit can be recruited, a hidden id,
 * calls after end_turn, the call cap, an unknown tool, a self-wake, a turn that keeps it and empty
 * rounds.
 */
function busy(unit: string, buildings: readonly string[]): Scripted {
  const recruit = (city: CityId): ToolCall =>
    call("recruit", {
      city,
      orders: [
        { unit, count: "max" },
        { unit, count: "max" },
      ],
    });
  return new Scripted("test:busy", (input) => {
    const city = own(input);
    const calls: ToolCall[] = [];
    if (input.turn === 1 && input.round === 0) {
      calls.push(
        call("write_note", { text: "plan: grow", mode: "append" }),
        recruit(city),
        call("build", { city, buildings: [...buildings, "nosuchbuilding"] }),
        call("view_city", { city: "c999" }),
        call("recall_troops", { movement: "m00000" }),
        call("send_message", { to: ["p2"], text: "hello p2" }),
      );
    } else if (input.turn === 1 && input.round === 1) {
      calls.push(
        call("write_note", { text: "x".repeat(5000), mode: "replace" }),
        call("cancel_queue", { city, item: 99 }),
        call("end_turn", { nextWakeIn: 1800 }),
        call("leaderboard"),
      );
    } else if (input.turn === 2 && input.round === 0) {
      for (let i = 0; i < 11; i += 1) calls.push(call("leaderboard"));
    } else if (input.turn === 2 && input.round === 1) {
      calls.push(call("conquer_world"), call("end_turn", { nextWakeIn: 5400, wakeAt: 9000 }));
    } else if (input.turn === 2 && input.round === 2) {
      calls.push(call("end_turn"));
    } else if (input.round === 0) {
      calls.push(call("write_note", { text: `turn ${input.turn}`, mode: "append" }), recruit(city));
      if (input.turn % 3 === 0) calls.push(call("end_turn", { nextWakeIn: 2400 }));
    }
    return { calls };
  });
}

/** p2 answers messages, and posts to everyone (a public message wakes nobody). */
function chatty(): Scripted {
  return new Scripted("test:chatty", (input) => {
    if (input.round > 0) return { calls: [] };
    const to: string[] | "all" = input.turn % 2 === 0 ? "all" : ["p1"];
    return {
      calls: [
        call("send_message", { to, text: `turn ${input.turn}` }),
        call("end_turn", { nextWakeIn: 3000 + 600 * input.turn }),
      ],
    };
  });
}

/**
 * p4 posts seven public messages a turn (they wake nobody), so from its third turn on it is over
 * the daily message cap of both rulesets: `DAILY_CAP`, whose message the rebuild regenerates from
 * the line's details.
 */
function spammer(): Scripted {
  return new Scripted("test:spammer", (input) =>
    input.round > 0
      ? { calls: [] }
      : {
          calls: [
            ...Array.from({ length: 7 }, (_, i) =>
              call("send_message", { to: "all", text: `turn ${input.turn}, news ${i + 1}` }),
            ),
            call("end_turn", { nextWakeIn: 2400 }),
          ],
        },
  );
}

/** p3 calls the broken view_map (INTERNAL) and recruits. */
function mapper(unit: string): Scripted {
  return new Scripted("test:mapper", (input) =>
    input.round > 0
      ? { calls: [] }
      : {
          calls: [
            call("view_map"),
            call("recruit", { city: own(input), orders: [{ unit, count: 1 }] }),
            call("end_turn", { nextWakeIn: 4000 }),
          ],
        },
  );
}

/** `agent` answering each round after `ms` of wall time (think time under virtual time). */
function slow(agent: SeatAgent, time: TimeSource, ms: number): SeatAgent {
  return {
    label: agent.label,
    async round(input: RoundInput): Promise<RoundOutput> {
      const out = await agent.round(input);
      await time.sleepUntil(time.nowMs() + ms).done;
      return out;
    },
  };
}

interface Scenario {
  readonly ruleset: AnyRuleset;
  readonly setup: MatchSetup;
  readonly agents: Map<PlayerId, SeatAgent>;
}

function scenario(ruleset: AnyRuleset, time: TimeSource | null): Scenario {
  const setup = setupOf(ruleset, 6, { "time.matchEnd": 21600 }, 17);
  const rules = createMatch(setup, ruleset).rules;
  const table = rules.units.find((u) => u.id !== rules.roles.settler);
  const unit = table?.id ?? "";
  // What the unit requires, then what those buildings require: queued in that order.
  const needs = Object.keys(table?.requires ?? {});
  const before = needs.flatMap((b) =>
    Object.keys(rules.buildings.find((x) => x.id === b)?.requires ?? {}),
  );
  const given: Record<string, SeatAgent> = {
    p1: busy(unit, [...before, ...needs]),
    p2: chatty(),
    p3: mapper(unit),
    p4: spammer(),
  };
  const agents = new Map<PlayerId, SeatAgent>(
    setup.seats.map((s, i) => {
      const agent = given[s.id] ?? idle();
      return [s.id, time === null ? agent : slow(agent, time, 700 + 900 * i)];
    }),
  );
  return { ruleset, setup, agents };
}

/** A run of the scenario (not strict: INTERNAL is expected), and its log. */
async function run(
  ruleset: AnyRuleset,
  clock: "lockstep" | "virtual",
): Promise<{ lines: LogLine[]; gw: GatewayState }> {
  const virtual =
    clock === "virtual"
      ? new VirtualTime({ yieldMacrotask: () => new Promise((r) => setImmediate(r)) })
      : null;
  const s = scenario(ruleset, virtual);
  const sink = new MemorySink();
  const options: RunMatchOptions = {
    setup: s.setup,
    ruleset,
    agents: s.agents,
    clock:
      virtual === null
        ? { kind: "lockstep", maxTurnsPerSecond: 1 }
        : { kind: "realtime", speed: { num: 3, den: 1 }, time: virtual, timeKind: "virtual" },
    sink,
    invariants: "step",
    tools: throwingViewMap(ruleset),
  };
  const out = await (virtual === null ? runMatch(options) : virtual.run(() => runMatch(options)));
  return { lines: sink.parsed(), gw: out.gateway };
}

describe("the rebuilt gateway state equals the live one", () => {
  for (const ruleset of [PERFIDIA, SANDBOX]) {
    for (const clock of ["lockstep", "virtual"] as const) {
      test(`${ruleset.ref}, ${clock}`, async () => {
        const live = await run(ruleset, clock);
        const rebuilt = rebuildGatewayState(live.lines, resolveOf(ruleset));
        expect(rebuilt.drift).toBeNull();
        expect(rebuilt.report.divergence).toBeUndefined();
        expect(rebuilt.ok).toBe(true);
        expect(rebuilt.inTurn).toBe(false);
        expect(text(rebuilt.gw)).toBe(text(live.gw));

        // The scenario reached every line kind and code it is meant to fold.
        const lines = live.lines;
        const gwCodes = new Set(linesOf(lines, "gw").map((l) => l.r.code));
        for (const code of [
          "NOTE_TOO_LONG",
          "TURN_OVER",
          "CALLS_CAP",
          "DAILY_CAP",
          "UNKNOWN_ID",
          "INVALID_ARGS",
          "INTERNAL",
        ]) {
          expect([code, gwCodes.has(code)]).toEqual([code, true]);
        }
        expect(linesOf(lines, "act").some((l) => l.r.ok)).toBe(true);
        expect(linesOf(lines, "act").some((l) => !l.r.ok)).toBe(true);
        expect(linesOf(lines, "note").length).toBeGreaterThan(3);
        // p4's last turn ended over the message cap: lastTurn keeps the regenerated wording.
        const capped = seatOf(rebuilt.gw, "p4").lastTurn?.unseen.find(
          (u) => u.code === "DAILY_CAP",
        );
        expect(capped?.message).toContain("message");
        const p1 = seatOf(rebuilt.gw, "p1");
        expect(p1.notes.startsWith("plan: grow\nturn 3")).toBe(true);
        expect(p1.archive.some((d) => d.event.type === "message")).toBe(true);
        const charges = new Set(linesOf(lines, "wake").map((l) => l.charge));
        expect(charges).toEqual(new Set([null, "own", "social"]));
      }, 30000);
    }
  }

  test("lastTurn keeps the unseen failures, INTERNAL's message included", async () => {
    const live = await run(PERFIDIA, "lockstep");
    const rebuilt = rebuildGatewayState(live.lines, resolveOf(PERFIDIA));
    const turnTwo = seatOf(live.gw, "p3").lastTurn;
    expect(seatOf(rebuilt.gw, "p3").lastTurn).toEqual(turnTwo);
    // p1's first turn ended with calls it never saw: the note too long, the cancel, the call after end_turn.
    const p1 = linesOf(live.lines, "turn").find((l) => l.seat === "p1");
    expect(p1).toMatchObject({ turn: 1, why: "end_turn", rounds: 2, selfAt: 1800 });
  }, 30000);
});

describe("createGatewayFold", () => {
  test("a loop over createReplay's lines equals rebuildGatewayState; a fold resumed midway from a JSON copy too", async () => {
    const live = await run(PERFIDIA, "lockstep");
    const header = live.lines[0];
    if (header?.k !== "header") throw new Error("no header");
    const resolve = resolveOf(PERFIDIA);
    const mid = Math.floor(live.lines.length / 2);
    const fold = createGatewayFold();
    const later: { fold: GatewayFold | null } = { fold: null };
    let index = 0;
    const replay = createReplay(header, resolve, {
      onLine: (line, r, applied) => {
        fold.line(line, r, applied);
        later.fold?.line(line, r, applied);
        if (index === mid) {
          later.fold = createGatewayFold({
            gw: structuredClone(fold.gw),
            index,
          });
        }
        index += 1;
      },
    });
    for (const line of live.lines.slice(1)) expect(replay.push(line).ok).toBe(true);
    expect(fold.drift).toBeNull();
    expect(text(fold.gw)).toBe(text(rebuildGatewayState(live.lines, resolve).gw));
    expect(text(fold.gw)).toBe(text(live.gw));
    const other = later.fold;
    expect(other).not.toBeNull();
    expect(other?.drift ?? null).toBeNull();
    expect(text(other?.gw ?? fold.gw)).toBe(text(live.gw));
    for (const seat of ["p1", "p2", "p3"] as const) {
      expect(other?.wake?.peek(seat) ?? null).toEqual(fold.wake?.peek(seat) ?? null);
    }
  }, 30000);
});

describe("lines the scenario does not always reach, on a host driven by hand", () => {
  test('batch items whose "max" resolves to 0 (gw lines with i) and a deferred seat', () => {
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
    h.execute({
      calls: [call("recruit", { city, orders }), call("end_turn", { nextWakeIn: 900 })],
    });
    h.close();
    host.defer("p2", 1);
    host.advanceTo(1);
    const p2 = host.openTurn("p2");
    p2.execute({ calls: [call("write_note", { text: "deferred", mode: "replace" })] });
    p2.execute({ calls: [] });
    p2.close();
    const lines = sink.parsed();
    expect(linesOf(lines, "gw").map((l) => l.i)).toEqual([0, 1]);
    expect(linesOf(lines, "defer")).toEqual([{ k: "defer", t: 0, seat: "p2", to: 1 }]);
    const rebuilt = rebuildGatewayState(lines, resolveOf(PERFIDIA));
    // The log has no end line yet: the engine report says so; the fold itself went through.
    expect(rebuilt.report.divergence?.kind).toBe("end");
    expect(rebuilt.drift).toBeNull();
    expect(rebuilt.inTurn).toBe(false);
    expect(text(rebuilt.gw)).toBe(text(host.gw));
    expect(seatOf(rebuilt.gw, "p1").lastTurn?.unseen.map((u) => u.code)).toEqual([
      "INSUFFICIENT_RESOURCES",
      "INSUFFICIENT_RESOURCES",
    ]);
  });
});

describe("a damaged log rebuilds to another state, or reports where the fold stopped", () => {
  test("a missing turn line: the seat's next wake cannot begin, and the state differs", async () => {
    const live = await run(PERFIDIA, "lockstep");
    const i = live.lines.findIndex((l) => l.k === "turn" && l.seat === "p2");
    const damaged = live.lines.toSpliced(i, 1);
    const rebuilt = rebuildGatewayState(damaged, resolveOf(PERFIDIA));
    expect(rebuilt.report.ok).toBe(true);
    expect(rebuilt.ok).toBe(false);
    expect(rebuilt.drift).toMatchObject({ k: "wake", seat: "p2" });
    expect(text(rebuilt.gw)).not.toBe(text(live.gw));
  }, 30000);

  test("a wake line with other reasons, and a turn line with another next wake, are drifts", async () => {
    const live = await run(SANDBOX, "lockstep");
    const w = live.lines.findIndex((l) => l.k === "wake" && l.seat === "p1" && l.turn === 2);
    const wake = live.lines[w];
    if (wake?.k !== "wake") throw new Error("no second wake of p1");
    const reasons = rebuildGatewayState(
      live.lines.with(w, { ...wake, reasons: ["safety"] }),
      resolveOf(SANDBOX),
    );
    expect(reasons.drift).toMatchObject({ index: w, k: "wake", seat: "p1", t: wake.t });
    expect(reasons.drift?.expected).toContain('"safety"');

    const c = live.lines.findIndex((l) => l.k === "turn" && l.seat === "p1" && l.turn === 2);
    const turn = live.lines[c];
    if (turn?.k !== "turn" || turn.next === null) throw new Error("no second turn of p1");
    const next = rebuildGatewayState(
      live.lines.with(c, { ...turn, next: { ...turn.next, at: turn.next.at + 1 } }),
      resolveOf(SANDBOX),
    );
    expect(next.drift).toMatchObject({ index: c, k: "turn", seat: "p1" });
  }, 30000);

  test("a missing note or gw line, which changes no engine hash, is an order divergence at its n", async () => {
    const live = await run(SANDBOX, "lockstep");
    const note = live.lines.findIndex((l) => l.k === "note" && l.seat === "p1");
    // p3's last INTERNAL: a failure of its last turn, which its lastTurn lists.
    const gw = live.lines.findLastIndex((l) => l.k === "gw" && l.r.code === "INTERNAL");
    for (const i of [note, gw]) {
      expect(i).toBeGreaterThan(0);
      const missing = live.lines[i];
      if (missing?.k !== "note" && missing?.k !== "gw") throw new Error("not a numbered line");
      const rebuilt = rebuildGatewayState(live.lines.toSpliced(i, 1), resolveOf(SANDBOX));
      expect(rebuilt.ok).toBe(false);
      expect(rebuilt.report.divergence).toMatchObject({
        kind: "order",
        n: missing.n + 1,
        expected: `n = ${missing.n}`,
      });
    }
  }, 30000);

  test("a missing ev line is the engine's divergence", async () => {
    const live = await run(SANDBOX, "lockstep");
    const i = live.lines.findIndex((l) => l.k === "ev" && l.e.type === "message");
    const rebuilt = rebuildGatewayState(live.lines.toSpliced(i, 1), resolveOf(SANDBOX));
    expect(rebuilt.report.divergence?.kind).toBe("event");
    expect(rebuilt.ok).toBe(false);
  }, 30000);

  test("a log cut inside a turn (a crash) leaves that turn open: inTurn", () => {
    const setup = setupOf(SANDBOX, 2);
    const { host, sink } = manualHost(SANDBOX, setup);
    const h = host.openTurn("p1");
    h.execute({ calls: [call("write_note", { text: "half a turn", mode: "append" })] });
    const rebuilt = rebuildGatewayState(sink.parsed(), resolveOf(SANDBOX));
    expect(rebuilt.report.divergence?.kind).toBe("end");
    expect(rebuilt.drift).toBeNull();
    expect(rebuilt.inTurn).toBe(true);
    expect(rebuilt.openTurns).toEqual(["p1"]);
    expect(seatOf(rebuilt.gw, "p1").notes).toBe("half a turn");
    expect(text(rebuilt.gw)).toBe(text(host.gw));
  });

  test("a log without its header rebuilds nothing and does not throw", () => {
    const rebuilt = rebuildGatewayState([], resolveOf(SANDBOX));
    expect(rebuilt.report.divergence?.kind).toBe("header");
    expect(rebuilt.ok).toBe(false);
    expect(Object.keys(rebuilt.gw.seats)).toEqual([]);
  });
});
