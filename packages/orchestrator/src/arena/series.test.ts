// Phase 4, Pass 2 (agent E): `arena series` (design §3.7, §6.4). The squares are Latin (every model
// at every position once per block, every profile too) and, with an orthogonal pair, Graeco-Latin
// (every model plays every profile once per block); they are a pure function of the seed. A fake
// series of budget-mix plays its 4 rotated matches with Level E ok, each seat as the manifest says.
// The four rotated fake matches run in the slow suite (PERFIDIA_SLOW=1, docs/architecture.md §13.8:
// `bun run test:slow`, run by `bun run test:exit`).

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { verifyLog } from "@perfidia/engine";
import { readLog } from "@perfidia/sim";
import {
  LineupSchema,
  SeatsFileSchema,
  SeriesManifestSchema,
  type Lineup,
} from "@perfidia/protocol";
import { memoryIo } from "@perfidia/sim";
import { main as arenaMain } from "./cli.ts";
import { loadLineup } from "./lineup.ts";
import { randomSquares, rotationOf, seriesMatches, type Square } from "./series.ts";
import { runDir } from "./rig.test.ts";

const SLOW = process.env["PERFIDIA_SLOW"] === "1";
/** A test of the slow suite: skipped unless PERFIDIA_SLOW=1. */
const xtest = test.skipIf(!SLOW);

/** `arena` as the CLI runs it, with no calibration profile unless a test passes `--profiles`. */
const main = (...[argv, io, env, o]: Parameters<typeof arenaMain>) =>
  arenaMain(argv, io, env, { profilesDir: "off", ...o });

const LONG = 120_000;
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isPermutation = (row: readonly number[], n: number): boolean =>
  row.length === n && new Set(row).size === n && row.every((v) => v >= 0 && v < n);

const isLatin = (s: Square, n: number): boolean =>
  s.length === n &&
  s.every((row) => isPermutation(row, n)) &&
  Array.from({ length: n }, (_, c) => s.map((row) => row[c] ?? -1)).every((col) =>
    isPermutation(col, n),
  );

describe("the squares (seeded random Latin and Graeco-Latin)", () => {
  test("Latin both, orthogonal for every order but 2 and 6, a pure function of the seed", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9 }),
        fc.integer({ min: 0, max: 0xffff_ffff }),
        (n, seed) => {
          const sq = randomSquares(n, seed);
          expect(isLatin(sq.models, n)).toBe(true);
          expect(isLatin(sq.profiles, n)).toBe(true);
          expect(sq.orthogonal).toBe(n !== 2 && n !== 6);
          if (sq.orthogonal) {
            const pairs = new Set(
              sq.models.flatMap((row, r) => row.map((m, c) => `${m}:${sq.profiles[r]?.[c] ?? -1}`)),
            );
            expect(pairs.size).toBe(n * n);
          }
          expect(randomSquares(n, seed)).toEqual(sq);
        },
      ),
      { numRuns: 300, seed: 4_711 },
    );
    // Orders 4, 8 and 16 come from GF(2^m): still Graeco-Latin.
    for (const n of [4, 8, 16]) {
      const sq = randomSquares(n, 99);
      expect(isLatin(sq.models, n) && isLatin(sq.profiles, n) && sq.orthogonal).toBe(true);
    }
    // The seed matters: two seeds give two squares (the 4 × 4 case of budget-mix).
    expect(randomSquares(4, 1)).not.toEqual(randomSquares(4, 2));
  });

  test("a series of budget-mix: each block rotates models over positions and profiles, one map per block", () => {
    const lineup = loadLineup("budget-mix");
    const rot = rotationOf(lineup);
    expect(rot.positions).toEqual(["p1", "p2", "p3", "p4"]);
    const { matches, orthogonal } = seriesMatches(lineup, 3, 41);
    expect(orthogonal).toBe(true);
    expect(matches.map((m) => m.run)).toEqual([
      "m01",
      "m02",
      "m03",
      "m04",
      "m05",
      "m06",
      "m07",
      "m08",
      "m09",
      "m10",
      "m11",
      "m12",
    ]);
    for (let b = 0; b < 3; b += 1) {
      const block = matches.filter((m) => m.block === b);
      expect(block.length).toBe(4);
      expect(new Set(block.map((m) => m.seed))).toEqual(new Set([41 + b]));
      for (const seat of rot.positions) {
        const at = block.map((m) => m.seats.find((s) => s.seat === seat));
        expect(new Set(at.map((s) => s?.model))).toEqual(new Set([0, 1, 2, 3]));
        expect(new Set(at.map((s) => s?.profile))).toEqual(new Set([0, 1, 2, 3]));
      }
      const pairs = new Set(block.flatMap((m) => m.seats.map((s) => `${s.model}:${s.profile}`)));
      expect(pairs.size).toBe(16);
    }
    // Each match's lineup: a valid lineup file, the rotated entries on the LLM seats, bots in place.
    for (const m of matches) {
      const l: Lineup = LineupSchema.parse(m.lineup);
      expect(l.id).toBe(`budget-mix-${m.run}`);
      expect(l.budgetUsd).toBe(lineup.budgetUsd);
      expect(l.seats.filter((s) => s.kind === "bot")).toEqual(
        lineup.seats.filter((s) => s.kind === "bot"),
      );
      for (const s of m.seats) {
        const seat = l.seats.find((x) => x.seat === s.seat);
        const entry = rot.entries[s.model];
        expect(
          seat?.kind === "llm" ? [seat.provider, seat.model, seat.endpoint, seat.profile] : null,
        ).toEqual([entry?.provider, entry?.model, entry?.endpoint, rot.profiles[s.profile]]);
      }
    }
    // The same seed, the same series; another seed, another one.
    expect(seriesMatches(lineup, 3, 41)).toEqual({ matches, orthogonal });
    expect(seriesMatches(lineup, 3, 42).matches.map((m) => m.seats)).not.toEqual(
      matches.map((m) => m.seats),
    );
  });

  test("an order without an orthogonal square: profiles rotate by an independent Latin square", () => {
    const base = loadLineup("budget-mix");
    const two: Lineup = {
      ...base,
      id: "pair",
      seats: base.seats.map((s) =>
        s.seat === "p3" || s.seat === "p4"
          ? { seat: s.seat, kind: "bot", label: "bot:turtle@3" }
          : s,
      ),
    };
    const { matches, orthogonal } = seriesMatches(two, 1, 3);
    expect(orthogonal).toBe(false);
    expect(matches.length).toBe(2);
    for (const seat of ["p1", "p2"]) {
      const at = matches.map((m) => m.seats.find((s) => s.seat === seat));
      expect(new Set(at.map((s) => s?.model))).toEqual(new Set([0, 1]));
      expect(new Set(at.map((s) => s?.profile))).toEqual(new Set([0, 1]));
    }
  });
});

async function cli(argv: readonly string[]) {
  const io = memoryIo();
  const code = await main(argv, io, {});
  return { code, out: io.stdout(), err: io.stderr() };
}

describe("arena series --fake", () => {
  xtest(
    "4 rotated budget-mix matches with a manifest, each Level E ok, seated as the manifest says",
    async () => {
      const out = runDir("series");
      const args = [
        "series",
        "--fake",
        "--lineup",
        "budget-mix",
        "--days",
        "1",
        "--seed",
        "5",
        "--id-key",
        "seed",
        "--price-date",
        "2026-10-20",
        "--profiles",
        "off",
        "--quiet",
        "--out",
        out,
      ];
      const r = await cli(args);
      expect(r.code).toBe(0);
      expect(r.out).toContain("series budget-mix: 4/4 match(es) played, Level E ok on every one");
      const manifest = SeriesManifestSchema.parse(
        JSON.parse(readFileSync(join(out, "series.json"), "utf8")),
      );
      expect(manifest).toMatchObject({
        lineup: "budget-mix",
        seed: 5,
        fake: true,
        order: 4,
        blocks: 1,
        orthogonal: true,
        positions: ["p1", "p2", "p3", "p4"],
        profiles: ["odysseus@1", "achilles@1", "penelope@1", "agamemnon@1"],
      });
      expect(manifest.models.map((m) => [m.provider, m.model, m.endpoint, m.effort])).toEqual([
        ["anthropic", "claude-haiku-5-5", null, "medium"],
        ["openai", "gpt-6-luna", null, "medium"],
        ["google", "gemini-3.8-flash", null, "medium"],
        ["openrouter", "z-ai/glm-5.3-flash", "z-ai/fp8", "low"],
      ]);
      expect(manifest.matches.map((m) => [m.run, m.seed, m.status, m.code, m.levelE])).toEqual([
        ["m01", 5, "ended", 0, true],
        ["m02", 5, "ended", 0, true],
        ["m03", 5, "ended", 0, true],
        ["m04", 5, "ended", 0, true],
      ]);
      expect(readdirSync(join(out, "lineups")).toSorted(byName)).toEqual([
        "m01.json",
        "m02.json",
        "m03.json",
        "m04.json",
      ]);
      for (const m of manifest.matches) {
        expect(m.costNanoUsd ?? 0).toBeGreaterThan(0);
        const dir = join(out, m.run);
        // Level E again, from the log itself.
        expect(verifyLog(readLog(join(dir, "match.jsonl"))).ok).toBe(true);
        const seats = SeatsFileSchema.parse(
          JSON.parse(readFileSync(join(dir, "seats.json"), "utf8")),
        );
        for (const s of m.seats) {
          const seat = seats.seats.find((x) => x.seat === s.seat);
          const model = manifest.models[s.model];
          expect(
            seat?.kind === "llm"
              ? [
                  seat.intended?.provider,
                  seat.model,
                  seat.intended?.endpoint ?? null,
                  `${seat.profile.id}@${seat.profile.version}`,
                ]
              : null,
          ).toEqual([
            model?.provider,
            model?.model,
            model?.endpoint ?? null,
            manifest.profiles[s.profile],
          ]);
        }
        expect(seats.lineup).toBe(`budget-mix-${m.run}`);
      }
      // Each model played each position and each profile once.
      for (let i = 0; i < 4; i += 1) {
        const mine = manifest.matches.flatMap((m) => m.seats.filter((s) => s.model === i));
        expect(new Set(mine.map((s) => s.seat)).size).toBe(4);
        expect(new Set(mine.map((s) => s.profile)).size).toBe(4);
      }
      // A second series into a used directory is refused; nothing is touched.
      const again = await cli(args);
      expect(again.code).toBe(3);
      expect(again.err).toContain("already holds a series");
    },
    LONG,
  );

  test("a match the plan refuses (a budget under the reserve) refuses the series: nothing written", async () => {
    const out = runDir("refused");
    const r = await cli([
      "series",
      "--fake",
      "--lineup",
      "budget-mix",
      "--days",
      "1",
      "--seed",
      "5",
      "--budget-usd",
      "0.5",
      "--profiles",
      "off",
      "--quiet",
      "--out",
      out,
    ]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("below the predicted low");
    expect(existsSync(out)).toBe(false);
    const missing = await cli(["series", "--fake", "--out", out]);
    expect(missing.code).toBe(3);
    expect(missing.err).toContain("--lineup and --out are required");
  });

  test("the series flags: no --seat (the squares seat every LLM seat)", async () => {
    const out = runDir("seat");
    const r = await cli([
      "series",
      "--fake",
      "--lineup",
      "budget-mix",
      "--seat",
      "p1=bot:turtle@3",
      "--out",
      out,
    ]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("Unknown option '--seat'");
    expect(existsSync(out)).toBe(false);
  });
});
