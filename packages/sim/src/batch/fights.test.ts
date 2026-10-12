// The fight metrics of `sim batch` (docs/architecture.md §12.2): first battle, conquest and
// elimination times and domination countdowns, exact on hand-written lines and on the committed
// `scenario-late` golden (which has all of them); their per-variant mean and earliest; the game
// clock text; and a real batch whose rows, aggregates, per-day pacing and printed tables agree with
// its logs, one variant fighting and one ending by domination.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogLineSchema, type EvLine, type LogLine } from "@perfidia/protocol";
import { FIXTURES_DIR } from "../golden/index.ts";
import { DEFAULT_BOTS, listGoldens, readLog } from "../harness/index.ts";
import {
  dayOf,
  fightTable,
  fightTimes,
  firstTimeStat,
  gameClockText,
  matchTable,
  pacingOf,
  pacingTable,
  parseVariant,
  runBatch,
  type MatchRow,
} from "./index.ts";

/** Parses hand-written lines with the log schema, so a fixture is always a valid log. */
function log(rows: readonly unknown[]): LogLine[] {
  return rows.map((r) => LogLineSchema.parse(r));
}

const ev = (t: number, type: string, data: Record<string, unknown> = {}): unknown => ({
  k: "ev",
  t,
  e: { t, type, public: true, to: [], data },
});

/** The time of the first `ev` line of `type`, or null. */
const firstOf = (lines: readonly LogLine[], type: string): number | null =>
  lines.find((l): l is EvLine => l.k === "ev" && l.e.type === type)?.t ?? null;

describe("fight times", () => {
  test("no fighting: every time is null and no countdown opened", () => {
    expect(fightTimes(log([ev(10, "city_founded"), ev(20, "message")]))).toEqual({
      firstBattleT: null,
      firstConquestT: null,
      firstEliminationT: null,
      dominationCountdowns: 0,
      firstDominationT: null,
    });
    expect(fightTimes([])).toMatchObject({ firstBattleT: null, dominationCountdowns: 0 });
  });

  test("the earliest of each event type, and every countdown counted", () => {
    const lines = log([
      ev(3600, "city_founded"),
      ev(47520, "battle", { city: "c3" }),
      ev(47520, "battle", { city: "c4" }),
      ev(50000, "siege_started", { city: "c3" }),
      ev(90000, "city_conquered", { city: "c3" }),
      ev(91000, "battle"),
      ev(120000, "player_eliminated", { player: "p2" }),
      ev(130000, "city_conquered", { city: "c9" }),
      ev(270000, "domination_started"),
      ev(271000, "domination_cancelled"),
      ev(280000, "domination_started"),
      { k: "ckpt", t: 277200, hour: 77, h: "0".repeat(16) },
    ]);
    expect(fightTimes(lines)).toEqual({
      firstBattleT: 47520,
      firstConquestT: 90000,
      firstEliminationT: 120000,
      dominationCountdowns: 2,
      firstDominationT: 270000,
    });
  });

  test("the scenario-late golden: battles, conquests, an elimination, countdowns", () => {
    const g = listGoldens(FIXTURES_DIR).find(
      (x) => x.ref === "perfidia-1@1.0.0" && x.name === "scenario-late",
    );
    if (g === undefined) throw new Error("scenario-late is not committed");
    const lines = readLog(g.path);
    const f = fightTimes(lines);
    expect(f).toEqual({
      firstBattleT: firstOf(lines, "battle"),
      firstConquestT: firstOf(lines, "city_conquered"),
      firstEliminationT: firstOf(lines, "player_eliminated"),
      dominationCountdowns: lines.filter((l) => l.k === "ev" && l.e.type === "domination_started")
        .length,
      firstDominationT: firstOf(lines, "domination_started"),
    });
    expect(f.firstBattleT).toBe(4200);
    expect(f.firstEliminationT).not.toBeNull();
    expect(f.dominationCountdowns).toBe(2);
    // The pacing days count the same conquests and eliminations.
    const p = pacingOf(lines);
    expect(p.report.ok).toBe(true);
    const count = (type: string): number =>
      lines.filter((l) => l.k === "ev" && l.e.type === type).length;
    expect(p.days.reduce((a, d) => a + d.conquests, 0)).toBe(count("city_conquered"));
    expect(p.days.reduce((a, d) => a + d.eliminations, 0)).toBe(count("player_eliminated"));
    expect(p.days.reduce((a, d) => a + d.eliminations, 0)).toBe(1);
  });

  test("mean (rounded to the second) and earliest over the runs that had one", () => {
    expect(firstTimeStat([])).toEqual({ runs: 0, mean: null, min: null });
    expect(firstTimeStat([null, null])).toEqual({ runs: 0, mean: null, min: null });
    expect(firstTimeStat([null, 200, 100, null])).toEqual({ runs: 2, mean: 150, min: 100 });
    expect(firstTimeStat([1, 2])).toEqual({ runs: 2, mean: 2, min: 1 });
    expect(firstTimeStat([0])).toEqual({ runs: 1, mean: 0, min: 0 });
  });

  test("game times print on the game clock, to the minute", () => {
    expect(gameClockText(null)).toBe("-");
    expect(gameClockText(0)).toBe("D1 00:00");
    expect(gameClockText(47520)).toBe("D1 13:12");
    expect(gameClockText(47579)).toBe("D1 13:12");
    expect(gameClockText(86400 + 3600)).toBe("D2 01:00");
  });
});

describe("a real batch", () => {
  test("rows, aggregates, pacing and tables agree with the logs: one variant fights, one ends by domination", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perfidia-sim-fights-"));
    try {
      // No protection and two days: battles on day 1 or 2. Domination open at 6 h with a
      // threshold the bots reach at once: a countdown, then a domination end (exit criterion 5).
      const fight = parseVariant("fight: perfidia-1 time.protectionEnd=0 time.matchEnd=172800");
      const dom = parseVariant(
        "dom: perfidia-1 time.matchEnd=86400 time.dominationStart=21600 time.dominationHold=3600 victory.dominationPm=110 victory.dominationMinPerPlayer=0",
      );
      const result = await runBatch(
        {
          variants: [fight, dom],
          seeds: [2],
          players: 6,
          bots: [...DEFAULT_BOTS],
          days: null,
          pacing: true,
        },
        { out: dir },
      );
      const [fv, dv] = result.variants;
      if (fv === undefined || dv === undefined) throw new Error("two variants expected");
      for (const [vi, v] of result.variants.entries()) {
        const m = v.matches[0];
        if (m === undefined) throw new Error("one match expected");
        const lines = readLog(join(dir, `v${vi + 1}-s2`, "match.jsonl"));
        expect(m).toMatchObject({
          firstBattleT: firstOf(lines, "battle"),
          firstConquestT: firstOf(lines, "city_conquered"),
          firstEliminationT: firstOf(lines, "player_eliminated"),
          firstDominationT: firstOf(lines, "domination_started"),
        });
        expect(m.replayOk).toBe(true);
        const days = m.pacing ?? [];
        expect(days.reduce((a, d) => a + d.battles, 0)).toBe(m.battles);
        expect(days.reduce((a, d) => a + d.conquests, 0)).toBe(m.conquests);
        expect(days.reduce((a, d) => a + d.eliminations, 0)).toBe(m.eliminations);
        const a = v.aggregate;
        expect(a.firstBattle).toEqual(firstTimeStat([m.firstBattleT]));
        expect(a.firstConquest).toEqual(firstTimeStat([m.firstConquestT]));
        expect(a.firstElimination).toEqual(firstTimeStat([m.firstEliminationT]));
        expect(a.runsWithElimination).toBe(m.eliminations > 0 ? 1 : 0);
      }

      const f: MatchRow | undefined = fv.matches[0];
      if (f?.firstBattleT == null) throw new Error("the fight variant had no battle");
      expect(f.reason).toBe("time");
      expect(f.dominationCountdowns).toBe(0);
      // The first battle's day is the first pacing day with a battle.
      expect((f.pacing ?? []).find((d) => d.battles > 0)?.day).toBe(dayOf(f.firstBattleT));
      expect(fv.aggregate).toMatchObject({
        reasons: { time: 1 },
        firstBattle: { runs: 1, mean: f.firstBattleT, min: f.firstBattleT },
        runsWithCountdown: 0,
      });

      const d: MatchRow | undefined = dv.matches[0];
      if (d?.firstDominationT == null || d.endedAt === null) throw new Error("no countdown");
      expect(d.reason).toBe("domination");
      expect(d.dominationCountdowns).toBeGreaterThan(0);
      expect(d.firstDominationT).toBeGreaterThanOrEqual(21600);
      expect(d.firstDominationT).toBeLessThanOrEqual(d.endedAt - 3600);
      expect(dv.aggregate).toMatchObject({ reasons: { domination: 1 }, runsWithCountdown: 1 });

      // The tables print the same numbers on the game clock.
      const fights = fightTable(result).split("\n");
      expect(fights[0]).toStartWith("fights · game clock to the minute");
      expect(fights[1]).toMatch(
        /^variant +runs +ends +1st battle \(mean \/ min\) +1st conquest \(mean \/ min\) +1st elim \(mean \/ min\) +runs with elim +runs with countdown$/,
      );
      // Variant names longer than their column get a line of their own, the numbers the next.
      const battle = gameClockText(f.firstBattleT);
      expect(fights[2]).toBe(fv.text);
      expect(fights[3]).toMatch(/^ +1 +time 1 /);
      expect(fights[3]).toContain(` ${battle} / ${battle} `);
      expect(fights[3]).toMatch(/ 0$/);
      expect(fights[4]).toBe(dv.text);
      expect(fights[5]).toMatch(/^ +1 +domination 1 +- +- +- +0 +1$/);
      const perMatch = matchTable(result);
      expect(perMatch).toContain(` ${battle} `);
      expect(perMatch).toContain(
        ` ${d.dominationCountdowns} from ${gameClockText(d.firstDominationT)} `,
      );
      expect(pacingTable(result).split("\n")[1]).toMatch(
        / +battles +conquests +elims +sieges started +held +broken$/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
