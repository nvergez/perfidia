// The phase-1 exit criterion (docs/architecture.md §13.7), with the performance figures of §13.8.
// Exit suite only: every test skips unless PERFIDIA_EXIT=1 (`bun run test:exit`, a separate CI
// job). For each of perfidia-1@1.0.0 (with time.dominationStart=604801, so that the full 7 days
// normally run) and sandbox-1@1.0.0: 12 seats (3 of each bot), 7 game days, under lockstep, real
// time with VirtualTime (speed 3, latency 2–60 s) and real time on the system clock at a very high
// speed. Then one more perfidia-1 lockstep run on the unmodified published defaults, and a batch run
// twice with its variant order reversed. Figures are printed at the end, measured after a 1-day
// warm-up match of each ruleset; the CI limits of §13.8 are asserted, the targets only reported.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getRuleset, loadMatch, verifyLog } from "@perfidia/engine";
import { buildBriefing } from "@perfidia/gateway";
import type { Json, LogLine } from "@perfidia/protocol";
import { parseVariant, runBatch } from "../batch/index.ts";
import {
  normalisedHash,
  runBots,
  type BotRun,
  type BotRunSpec,
  type ClockChoice,
} from "../harness/index.ts";
import { summarize, type MatchSummary } from "../summary/index.ts";

const ENABLED = process.env["PERFIDIA_EXIT"] === "1";
const suite = ENABLED ? describe : describe.skip;

const SEED = 1;
const PLAYERS = 12;
const DAYS = 7;
const MATCH_END = DAYS * 86400;
const RUN_TIMEOUT = 300_000;

const LOCKSTEP: ClockChoice = { kind: "lockstep" };
const VIRTUAL: ClockChoice = {
  kind: "virtual",
  speed: { num: 3, den: 1 },
  latencyMs: [2000, 60000],
};
/** One game day per wall second. */
const SYSTEM: ClockChoice = { kind: "system", speed: { num: 86400, den: 1 } };

interface Target {
  readonly ref: string;
  readonly overrides: Readonly<Record<string, Json>>;
}

const TARGETS: readonly Target[] = [
  { ref: "perfidia-1@1.0.0", overrides: { "time.dominationStart": 604801 } },
  { ref: "sandbox-1@1.0.0", overrides: {} },
];

/** Victories that legitimately end a match before `matchEnd`, by ruleset ref. */
const EARLY_END: Readonly<Record<string, readonly string[]>> = {
  "perfidia-1@1.0.0": ["domination", "last_standing"],
  "sandbox-1@1.0.0": ["hill", "last_standing"],
};

interface Row {
  run: string;
  clock: string;
  wallMs: number;
  levelEMs: number;
  endedAt: number;
  reason: string;
  battles: number;
  conquests: number;
  alliances: number;
  betrayals: number;
  eliminations: number;
  internal: number;
  lines: number;
}

interface Figure {
  scenario: string;
  target: string;
  ciLimit: string;
  measured: string;
}

const rows: Row[] = [];
const figures: Figure[] = [];

const ms = (from: number): number => Math.round(performance.now() - from);

function spec(t: Target, clock: ClockChoice): BotRunSpec {
  return {
    ruleset: t.ref,
    seed: SEED,
    players: PLAYERS,
    days: DAYS,
    overrides: t.overrides,
    clock,
    invariants: "checkpoint",
    strict: true,
  };
}

interface Checked {
  readonly run: BotRun;
  readonly summary: MatchSummary;
  readonly wallMs: number;
  readonly levelEMs: number;
}

/**
 * Runs a match and checks the common expectations: no fatal line, no INTERNAL `gw` line, an end at
 * `matchEnd` or by a legitimate victory, and Level E with zero divergence over every hourly
 * checkpoint hash.
 */
async function runChecked(name: string, t: Target, clock: ClockChoice, s = spec(t, clock)) {
  const t0 = performance.now();
  const run = await runBots(s);
  const wallMs = ms(t0);
  const summary = summarize(run.lines, { wallMs });
  expect(run.lines.some((l) => l.k === "fatal")).toBe(false);
  expect(summary.status).toBe("ended");
  expect(summary.internal).toBe(0);
  const reason = summary.reason ?? "";
  if (summary.endedAt === MATCH_END) expect(reason).toBe("time");
  else expect(EARLY_END[t.ref] ?? []).toContain(reason);

  const t1 = performance.now();
  const report = verifyLog(run.lines);
  const levelEMs = ms(t1);
  expect(report.divergence).toBeUndefined();
  expect(report.ok).toBe(true);
  expect(report.finalHash).toBe(run.run.finalHash);
  const ckpts = run.lines.filter((l) => l.k === "ckpt").length;
  expect(report.checkpoints).toBe(ckpts);
  expect(ckpts).toBe(Math.ceil((summary.endedAt ?? 0) / 3600) - 1);

  const e = summary.events;
  rows.push({
    run: name,
    clock: clock.kind,
    wallMs,
    levelEMs,
    endedAt: summary.endedAt ?? -1,
    reason,
    battles: e.battles,
    conquests: e.conquests,
    alliances: e.alliancesFormed,
    betrayals: e.betrayals,
    eliminations: e.eliminations,
    internal: summary.internal,
    lines: run.lines.length,
  });
  return { run, summary, wallMs, levelEMs } satisfies Checked;
}

/** The 95th percentile of a sample, rounded to the microsecond. */
function p95(xs: readonly number[]): number {
  const v = xs.toSorted((a, b) => a - b)[Math.floor(xs.length * 0.95)] ?? 0;
  return Math.round(v * 1000) / 1000;
}

/** The p95 times of a full state hash and of a briefing build, on the final state (ms). */
function stateFigures(run: BotRun): { hashMs: number; briefingP95Ms: number } {
  const final = run.sink.parsedSnapshots().at(-1);
  if (final === undefined) throw new Error("no final snapshot");
  const match = loadMatch(final, getRuleset(final.setup.ruleset), { invariants: "off" });
  const hashes: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    const t = performance.now();
    match.hash();
    hashes.push(performance.now() - t);
  }
  expect(match.hash()).toBe(run.run.finalHash);
  const r = match.read();
  const times: number[] = [];
  for (const seat of Object.values(run.run.gateway.seats).map((s) => s.seat)) {
    for (let i = 0; i < 20; i += 1) {
      const t = performance.now();
      buildBriefing(r, seat, run.run.gateway, {
        reasons: ["safety"],
        urgent: false,
        charge: null,
        day: DAYS - 1,
        used: { own: 0, social: 0 },
      });
      times.push(performance.now() - t);
    }
  }
  return { hashMs: p95(hashes), briefingP95Ms: p95(times) };
}

const sameNormalisedLog = (a: readonly LogLine[], b: readonly LogLine[]): void => {
  expect(normalisedHash(b)).toBe(normalisedHash(a));
};

suite("phase-1 exit criterion (§13.7)", () => {
  // One 1-day match of each ruleset first, so that the timed runs measure a warm process rather
  // than module loading and the first compilation of the engine.
  beforeAll(async () => {
    for (const t of TARGETS) {
      // oxlint-disable-next-line no-await-in-loop -- warm-up runs, one at a time
      await runBots({ ...spec(t, LOCKSTEP), days: 1 });
    }
  }, RUN_TIMEOUT);

  afterAll(() => {
    console.log("\nT17 exit runs: 12 seats (3 of each bot), 7 game days, seed 1 (wall ms):");
    console.table(rows);
    console.log("Performance budget (§13.8):");
    console.table(figures);
  });

  for (const t of TARGETS) {
    test(
      `${t.ref}, lockstep: no fatal, no INTERNAL, Level E, and a second run is identical`,
      async () => {
        const first = await runChecked(`${t.ref} lockstep`, t, LOCKSTEP);
        const second = await runBots(spec(t, LOCKSTEP));
        sameNormalisedLog(first.run.lines, second.lines);
        if (t.ref === "perfidia-1@1.0.0") {
          // Item 4, the drama minimum: a battle and an alliance are required.
          expect(first.summary.events.battles).toBeGreaterThanOrEqual(1);
          expect(first.summary.events.alliancesFormed).toBeGreaterThanOrEqual(1);
          const f = stateFigures(first.run);
          figures.push(
            {
              scenario: "Lockstep, perfidia-1, 12 seats, 7 days, bots, checkpoint invariants",
              target: "≤ 5 s",
              ciLimit: "20 s",
              measured: `${first.wallMs} ms`,
            },
            {
              scenario: "Level E replay of a 7-day log",
              target: "≤ 3 s",
              ciLimit: "15 s",
              measured: `${first.levelEMs} ms`,
            },
            {
              scenario: "Full state hash at day 7",
              target: "≤ 10 ms",
              ciLimit: "–",
              measured: `${f.hashMs} ms (p95 of 20)`,
            },
            {
              scenario: "Briefing build (p95)",
              target: "≤ 1 ms",
              ciLimit: "–",
              measured: `${f.briefingP95Ms} ms`,
            },
          );
          expect(first.wallMs).toBeLessThan(20_000);
          expect(first.levelEMs).toBeLessThan(15_000);
        }
      },
      RUN_TIMEOUT,
    );

    test(
      `${t.ref}, real time under VirtualTime: no fatal, no INTERNAL, Level E, and a second run is identical`,
      async () => {
        const first = await runChecked(`${t.ref} virtual`, t, VIRTUAL);
        const header = first.run.lines[0];
        expect(header).toMatchObject({
          k: "header",
          clock: { kind: "realtime", speed: [3, 1], time: "virtual", latencyMs: [2000, 60000] },
        });
        const second = await runBots(spec(t, VIRTUAL));
        sameNormalisedLog(first.run.lines, second.lines);
        if (t.ref === "perfidia-1@1.0.0") {
          figures.push({
            scenario: "Real time under VirtualTime, same match, speed 3",
            target: "≤ 10 s",
            ciLimit: "40 s",
            measured: `${first.wallMs} ms`,
          });
          expect(first.wallMs).toBeLessThan(40_000);
        }
      },
      RUN_TIMEOUT,
    );

    test(
      `${t.ref}, real time on the system clock at 86400×: completes and passes Level E`,
      async () => {
        const r = await runChecked(`${t.ref} system`, t, SYSTEM);
        expect(r.run.lines[0]).toMatchObject({
          k: "header",
          clock: { kind: "realtime", speed: [86400, 1], time: "system" },
        });
      },
      RUN_TIMEOUT,
    );
  }

  test(
    "perfidia-1@1.0.0 on its unmodified published defaults: no fatal, no INTERNAL, Level E",
    async () => {
      const t: Target = { ref: "perfidia-1@1.0.0", overrides: {} };
      // No override at all, not even the match length: the default `matchEnd` is 7 days.
      const { days: _days, ...noOverride } = spec(t, LOCKSTEP);
      const r = await runChecked("perfidia-1@1.0.0 defaults", t, LOCKSTEP, noOverride);
      const header = r.run.lines[0];
      expect(header?.k === "header" && header.setup.overrides).toEqual({});
      expect(r.summary.endedAt).toBeLessThanOrEqual(MATCH_END);
      // Domination runs at full scale from day 4: a domination end is accepted and reported.
      console.log(
        `published defaults: ended at ${r.summary.endedAt} (${r.summary.reason}), winners ${r.summary.winners.join(", ")}`,
      );
    },
    RUN_TIMEOUT,
  );

  test(
    "batch, run twice with its variant order reversed, gives identical results",
    async () => {
      const a = parseVariant("perfidia-1@1.0.0 time.dominationStart=604801", { days: DAYS });
      const b = parseVariant("sandbox-1@1.0.0", { days: DAYS });
      const plan = {
        seeds: [1, 2],
        players: PLAYERS,
        bots: ["expander", "rusher", "turtle", "opportunist"] as const,
        days: DAYS,
        pacing: false,
      };
      const ab = await runBatch({ ...plan, variants: [a, b] });
      const ba = await runBatch({ ...plan, variants: [b, a] });
      expect(ab.variants[0]).toEqual(ba.variants[1]);
      expect(ab.variants[1]).toEqual(ba.variants[0]);
      for (const v of ab.variants) {
        for (const m of v.matches) {
          expect([m.status, m.error, m.internal]).toEqual(["ended", null, 0]);
        }
      }
    },
    RUN_TIMEOUT,
  );
});
