// The first integration (docs/architecture.md §15 T14, §13.4, §13.7): the four real bots play
// 1-game-day matches of both rulesets through the gateway, under lockstep and under real time with
// `VirtualTime`; every log passes Level E, lockstep and virtual-time runs are byte-identical when
// repeated, a hand-off re-simulates at Level G, matches interleaved in one process match the same
// matches run alone (P17), P4 holds through the tools, the extra tools replay, every snapshot
// matches its checkpoint, and the memory sink writes the same bytes as the harness file writer.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { verifyLog, type AnyRuleset } from "@perfidia/engine";
import { fixtureRuleset } from "@perfidia/engine/testing";
import { ChaosAgent, MemorySink, teeSink } from "@perfidia/gateway";
import type { LogLine, PlayerId, RoundInput, SeatAgent } from "@perfidia/protocol";
import {
  JsonlFileSink,
  jsonlText,
  normalisedHash,
  normalisedText,
  prepareBotRun,
  readJsonl,
  resimulate,
  runBots,
  runPrepared,
  writeJsonl,
  type BotRun,
  type BotRunSpec,
  type ClockChoice,
} from "./harness/index.ts";

const RULESETS = ["perfidia-1@1.0.0", "sandbox-1@1.0.0"] as const;
const LOCKSTEP: ClockChoice = { kind: "lockstep" };
const VIRTUAL: ClockChoice = { kind: "virtual" };

/** A 1-game-day match of the four bots, six seats. */
function day(ruleset: string, clock: ClockChoice, seed = 4): BotRunSpec {
  return { ruleset, seed, players: 6, days: 1, clock, strict: true };
}

/** Level E through the registry: zero divergence. */
function levelE(
  lines: readonly LogLine[],
  resolve?: (ref: string) => AnyRuleset | undefined,
): void {
  const report = resolve === undefined ? verifyLog(lines) : verifyLog(lines, resolve);
  expect(report.divergence).toBeUndefined();
  expect(report.ok).toBe(true);
}

function kinds(lines: readonly LogLine[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of lines) out[l.k] = (out[l.k] ?? 0) + 1;
  return out;
}

/** The run ended without a fatal line, at the match end or by a victory. */
function endedCleanly(r: BotRun): void {
  expect(r.lines.some((l) => l.k === "fatal")).toBe(false);
  expect(r.lines.at(-1)).toMatchObject({ k: "end", result: { endedAt: r.run.result.endedAt } });
  expect(r.run.result.endedAt).toBeLessThanOrEqual(86400);
}

/** Every act line is followed by the ev lines of the events it emitted, at its own time (§10.2). */
function actsBeforeTheirEvents(lines: readonly LogLine[]): number {
  let followed = 0;
  for (const [i, line] of lines.entries()) {
    if (line.k !== "act" || !line.r.ok) continue;
    const next = lines[i + 1];
    if (next?.k === "ev" && next.t === line.t) followed += 1;
  }
  return followed;
}

/** Three matches for the coexistence test: two of perfidia-1 and one of sandbox-1. */
const specs = (clock: ClockChoice): BotRunSpec[] => [
  day("perfidia-1", clock, 21),
  day("sandbox-1", clock, 22),
  day("perfidia-1", clock, 23),
];

/** Bots on four seats and chaos agents on two, step invariants, strict. */
async function mixed(ref: string, seed: number, clock: ClockChoice): Promise<BotRun> {
  const prepared = prepareBotRun({ ...day(ref, clock, seed), invariants: "step" });
  const agents = new Map<PlayerId, SeatAgent>(prepared.options.agents);
  for (const seat of ["p3", "p6"] as const) {
    agents.set(seat, new ChaosAgent({ seat, seed: seed * 31 + seat.length }));
  }
  const sink = new MemorySink();
  const run = await runPrepared({ ...prepared, options: { ...prepared.options, agents } }, sink);
  return { run, sink, lines: sink.parsed() };
}

/** A bot that renames its first city in its first round. */
function renaming(bot: SeatAgent): SeatAgent {
  return {
    label: "test:renamer",
    async round(input: RoundInput) {
      const out = await bot.round(input);
      const city = input.briefing.cities[0]?.id;
      if (input.turn !== 1 || input.round !== 0 || city === undefined) return out;
      return {
        ...out,
        calls: [{ tool: "rename_city", args: { city, name: "Hill Fort" } }, ...out.calls],
      };
    },
  };
}

describe("1-game-day matches of the four bots", () => {
  for (const ref of RULESETS) {
    test(`${ref}, lockstep: no fatal, Level E, and a second run is byte-identical`, async () => {
      const first = await runBots(day(ref, LOCKSTEP));
      const second = await runBots(day(ref, LOCKSTEP));
      endedCleanly(first);
      levelE(first.lines);
      expect(second.sink.text()).toBe(first.sink.text());
      expect(second.sink.snapshots).toEqual(first.sink.snapshots);
      const k = kinds(first.lines);
      expect(k["header"]).toBe(1);
      expect(k["batch"]).toBeGreaterThan(0);
      expect(k["act"]).toBeGreaterThan(50);
      expect(k["obs"]).toBeGreaterThan(50);
      expect(k["note"]).toBeGreaterThan(0);
      expect(k["ckpt"]).toBe(23);
      // Act lines come before their ev lines (Level E checks the order of every one).
      expect(actsBeforeTheirEvents(first.lines)).toBeGreaterThan(0);
      // The bots use the four strategies, and every seat got a turn each game hour or so.
      const header = first.lines[0];
      expect(header?.k === "header" && Object.values(header.controllers)).toEqual([
        "bot:expander@1",
        "bot:rusher@1",
        "bot:turtle@1",
        "bot:opportunist@1",
        "bot:expander@1",
        "bot:rusher@1",
      ]);
      expect(first.run.stats.turns).toBe(k["wake"] ?? -1);
    }, 30000);

    test(`${ref}, real time under VirtualTime: no fatal, Level E, Level G, reproducible`, async () => {
      const first = await runBots(day(ref, VIRTUAL));
      endedCleanly(first);
      levelE(first.lines);
      const header = first.lines[0];
      expect(header).toMatchObject({
        k: "header",
        clock: { kind: "realtime", speed: [3, 1], time: "virtual", latencyMs: [2000, 60000] },
      });
      const again = await resimulate(first.lines);
      expect(normalisedText(again.lines)).toBe(normalisedText(first.lines));
      // Seats overlap in real time: some turn opens while another is in flight.
      let open = 0;
      let overlap = false;
      for (const l of first.lines) {
        if (l.k === "wake") {
          open += 1;
          if (open > 1) overlap = true;
        } else if (l.k === "turn") open -= 1;
      }
      expect(overlap).toBe(true);
    }, 30000);
  }

  test("lockstep Level G re-simulates the bots byte for byte", async () => {
    const first = await runBots(day("sandbox-1", LOCKSTEP, 8));
    const again = await resimulate(first.lines);
    expect(normalisedHash(again.lines)).toBe(normalisedHash(first.lines));
  }, 30000);

  test("the per-second cap writes defer lines when it binds (bots on the fixture ruleset, cap 1)", async () => {
    const out = await runBots({
      ruleset: fixtureRuleset,
      seed: 1,
      players: 4,
      days: 1,
      clock: { kind: "lockstep", maxTurnsPerSecond: 1 },
      bots: ["rusher", "rusher", "turtle", "opportunist"],
      strict: true,
    });
    const defers = out.lines.filter((l) => l.k === "defer");
    expect(defers.length).toBeGreaterThan(0);
    for (const d of defers) if (d.k === "defer") expect(d.to).toBe(d.t + 1);
    levelE(out.lines, (ref) => (ref === fixtureRuleset.ref ? fixtureRuleset : undefined));
    const wakes = out.run.stats.wakes;
    const deferred = Object.values(wakes).flatMap((days) => days.map((x) => x.deferred));
    expect(deferred.reduce((a, b) => a + b, 0)).toBe(defers.length);
  }, 30000);
});

describe("hand-offs", () => {
  test("p2 handed to another bot at t = 43200: a controller line, Level E and Level G", async () => {
    const out = await runBots({
      ...day("perfidia-1", LOCKSTEP, 6),
      handoffs: [{ seat: "p2", at: 43200, strategy: "turtle" }],
    });
    endedCleanly(out);
    const controllers = out.lines.filter((l) => l.k === "controller");
    expect(controllers).toHaveLength(1);
    const [line] = controllers;
    expect(line).toMatchObject({ k: "controller", seat: "p2", label: "bot:turtle@1" });
    expect(line?.t).toBeGreaterThanOrEqual(43200);
    const next = out.lines[out.lines.findIndex((l) => l.k === "controller") + 1];
    expect(next).toMatchObject({ k: "wake", seat: "p2", t: line?.t });
    levelE(out.lines);
    const again = await resimulate(out.lines);
    expect(normalisedText(again.lines)).toBe(normalisedText(out.lines));
  }, 30000);
});

describe("coexistence (P17)", () => {
  for (const clock of [LOCKSTEP, VIRTUAL]) {
    test(`three matches interleaved in one process equal each run alone (${clock.kind})`, async () => {
      const together = await Promise.all(specs(clock).map((s) => runBots(s)));
      for (const [i, spec] of specs(clock).entries()) {
        // oxlint-disable-next-line no-await-in-loop -- the reference runs are alone, one at a time
        const alone = await runBots(spec);
        expect(normalisedHash(together[i]?.lines ?? [])).toBe(normalisedHash(alone.lines));
      }
      expect(normalisedHash(together[0]?.lines ?? [])).not.toBe(
        normalisedHash(together[2]?.lines ?? []),
      );
    }, 60000);
  }
});

describe("P4 through the tools", () => {
  for (const ref of RULESETS) {
    test(`${ref}: random matches never throw, keep step invariants and replay`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 1_000_000 }),
          fc.boolean(),
          async (seed, virtual) => {
            const out = await mixed(ref, seed, virtual ? VIRTUAL : LOCKSTEP);
            endedCleanly(out);
            levelE(out.lines);
            expect(out.lines.filter((l) => l.k === "gw" && l.r.code === "INTERNAL")).toEqual([]);
          },
        ),
        { numRuns: 3 },
      );
    }, 60000);
  }
});

describe("extra tools, snapshots and sinks", () => {
  test("rename_city calls are logged as ext actions and replayed at Level E", async () => {
    const prepared = prepareBotRun(day("sandbox-1", LOCKSTEP, 5));
    const agents = new Map<PlayerId, SeatAgent>(prepared.options.agents);
    const bot = agents.get("p1");
    if (bot === undefined) throw new Error("no p1");
    agents.set("p1", renaming(bot));
    const sink = new MemorySink();
    await runPrepared({ ...prepared, options: { ...prepared.options, agents } }, sink);
    const lines = sink.parsed();
    const i = lines.findIndex((l) => l.k === "act" && l.tool === "rename_city");
    const rename = lines[i];
    if (rename?.k !== "act") throw new Error("no rename_city act line");
    expect(rename).toMatchObject({
      k: "act",
      seat: "p1",
      a: { type: "ext", tool: "rename_city", args: { name: "Hill Fort" } },
      r: { ok: true },
    });
    const ev = lines[i + 1];
    expect(ev).toMatchObject({
      k: "ev",
      e: { type: "city_renamed", public: true, data: { name: "Hill Fort" } },
    });
    levelE(lines);
    // A tampered rename is caught at its line.
    const tampered = lines.with(i, {
      ...rename,
      a: { type: "ext", tool: "rename_city", args: { city: "c1", name: "!" } },
    });
    expect(verifyLog(tampered).divergence?.n).toBe(rename.n);
  }, 30000);

  test("every snapshot's hash equals its ckpt line, and Level E resumes from each", async () => {
    const out = await runBots({ ...day("perfidia-1", LOCKSTEP, 9), snapshotEvery: 6 });
    const snaps = out.sink.parsedSnapshots();
    expect(snaps.map((s) => s.hour)).toEqual([6, 12, 18, 23]);
    for (const snap of snaps.slice(0, -1)) {
      const ckpt = out.lines.find((l) => l.k === "ckpt" && l.hour === snap.hour);
      expect(ckpt).toMatchObject({ h: snap.hash, t: snap.t });
      const report = verifyLog(out.lines, { from: snap });
      expect(report.divergence).toBeUndefined();
      expect(report.finalHash).toBe(out.run.finalHash);
    }
    expect(out.lines.at(-1)).toMatchObject({ k: "end", h: snaps.at(-1)?.hash });
  }, 30000);

  test("MemorySink text equals the harness file writer's output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perfidia-sink-"));
    try {
      const path = join(dir, "run", "match.jsonl");
      const memory = new MemorySink();
      const file = new JsonlFileSink(path, { snapshotsDir: join(dir, "run", "snapshots") });
      const prepared = prepareBotRun({ ...day("sandbox-1", LOCKSTEP, 12), snapshotEvery: 12 });
      await runPrepared(prepared, teeSink(memory, file));
      expect(readFileSync(path, "utf8")).toBe(memory.text());
      expect(jsonlText(memory.lines)).toBe(memory.text());
      expect(jsonlText(memory.parsed())).toBe(memory.text());
      const gz = join(dir, "copy.jsonl.gz");
      writeJsonl(gz, memory.parsed());
      expect(jsonlText(readJsonl(gz))).toBe(memory.text());
      expect(readJsonl(path)).toEqual(memory.parsed());
      const snapshot = readFileSync(join(dir, "run", "snapshots", "h0012.json"), "utf8");
      expect(snapshot).toBe(memory.snapshots[0] ?? "");
      expect(readFileSync(join(dir, "run", "snapshots", "final.json"), "utf8")).toBe(
        memory.snapshots.at(-1) ?? "",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
