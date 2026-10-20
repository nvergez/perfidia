import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SERIES_FORMAT,
  SeriesManifestSchema,
  type LineupSeat,
  type PlayerId,
  type SeriesManifest,
} from "@perfidia/protocol";
import { EXIT, UsageError, assertFreeRunDir, type CliIo } from "@perfidia/sim";
import type { Lineup } from "../log/schema.ts";
import { seededRandom } from "../model/clock.ts";
import { formatCents, formatUsd } from "../model/prices.ts";
import { loadLineup } from "./lineup.ts";
import { planArena, type ArenaEnv, type ArenaPlan, type ArenaRequest } from "./plan.ts";
import { runArena, type SignalSource } from "./run.ts";

// `arena series` (phase-4 design §3.7, §6.4, Pass 2): a lineup played as a rotation series, so a
// model's results are not its seat's or its profile's. The lineup's LLM seat entries (`models`:
// provider, model, endpoint, effort and the seat's own caps) rotate over its LLM positions by a
// seeded random Latin square, and its profiles by an orthogonal square (Graeco-Latin), one fresh
// pair per block of `order` matches: in a block every model plays every position once and, with
// the orthogonal pair, every profile once. Bot seats stay where the lineup puts them (reference
// players). Each block plays one map: its game seed is the series seed plus the block's index.
//
// Squares: the cyclic pair (i + j, 2i + j mod n) for odd orders, the GF(2^m) pair (i ⊕ j, 2·i ⊕ j)
// for 4, 8 and 16; then random rows (match order), columns (positions) and symbols (which model,
// which profile) from the series seed. Orders 2 and 6 have no orthogonal pair, and other even
// orders are not built here: their profiles rotate by an independent random Latin square
// (`orthogonal: false` in the manifest, and a warning).
//
// Every match is planned first (nothing is written when one is refused); then `series.json`
// (`perfidia-series/1`), and the matches run one by one into `<out>/m01`, `<out>/m02`…, each from
// its own lineup file (`<out>/lineups/`), re-planned at its start. The manifest is rewritten after
// each match. The series stops at the first match that does not exit 0, or after an operator
// signal (which hands that match's seats to their bots first).

/** A square of symbol indices: `square[row][column]` (row: the match of a block; column: a position). */
export type Square = readonly (readonly number[])[];

export interface SquarePair {
  /** Which model sits at each position of each match. */
  readonly models: Square;
  /** Which profile each position plays in each match. */
  readonly profiles: Square;
  readonly orthogonal: boolean;
}

/** Irreducible polynomials of GF(2^m), by order. */
const GF_POLY: Readonly<Record<number, number>> = { 4: 0b111, 8: 0b1011, 16: 0b10011 };

/** `a · b` in GF(`order`), `order` a power of two in `GF_POLY`. */
function gfMul(a: number, b: number, order: number): number {
  const poly = GF_POLY[order] ?? 0;
  let x = a;
  let y = b;
  let r = 0;
  while (y > 0) {
    if ((y & 1) === 1) r ^= x;
    y >>= 1;
    x <<= 1;
    if ((x & order) !== 0) x ^= poly;
  }
  return r;
}

/** The base pair of `order` before randomization, and whether it is orthogonal. */
function basePair(order: number): { a: number[][]; b: number[][]; orthogonal: boolean } {
  const grid = (f: (i: number, j: number) => number): number[][] =>
    Array.from({ length: order }, (_row, i) => Array.from({ length: order }, (_col, j) => f(i, j)));
  if (order % 2 === 1) {
    return {
      a: grid((i, j) => (i + j) % order),
      b: grid((i, j) => (2 * i + j) % order),
      orthogonal: true,
    };
  }
  if (GF_POLY[order] !== undefined) {
    return {
      a: grid((i, j) => i ^ j),
      b: grid((i, j) => gfMul(2, i, order) ^ j),
      orthogonal: true,
    };
  }
  return {
    a: grid((i, j) => (i + j) % order),
    b: grid((i, j) => (i + j) % order),
    orthogonal: false,
  };
}

/** A grid's cell (0 outside it). */
const cell = (g: readonly (readonly number[])[], r: number, c: number): number => g[r]?.[c] ?? 0;

/** A random permutation of `0..n-1` (Fisher–Yates on `rand`). */
function permutation(n: number, rand: () => number): number[] {
  const p = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.floor(rand() * (i + 1)));
    const t = p[i] ?? i;
    p[i] = p[j] ?? j;
    p[j] = t;
  }
  return p;
}

/**
 * A seeded random pair of Latin squares of `order`: the base pair with its rows, columns and both
 * symbol sets permuted (which keeps both Latin and their orthogonality). Without an orthogonal base
 * pair, the profile square takes its own row permutation, so the two squares are independent.
 */
export function randomSquares(order: number, seed: number): SquarePair {
  if (!Number.isSafeInteger(order) || order < 1) throw new Error(`no square of order ${order}`);
  const rand = seededRandom(seed);
  const base = basePair(order);
  const rows = permutation(order, rand);
  const cols = permutation(order, rand);
  const symA = permutation(order, rand);
  const symB = permutation(order, rand);
  const rowsB = base.orthogonal ? rows : permutation(order, rand);
  const models = rows.map((r) => cols.map((c) => symA[cell(base.a, r, c)] ?? 0));
  const profiles = rowsB.map((r) => cols.map((c) => symB[cell(base.b, r, c)] ?? 0));
  return { models, profiles, orthogonal: base.orthogonal };
}

/** The squares' seed of block `b` of a series: one stream per block. */
export const blockSquareSeed = (seed: number, b: number): number =>
  (seed ^ Math.imul(b + 1, 0x85ebca6b)) >>> 0;

/** The game seed of block `b`: the series seed plus the block's index (uint32). */
export const blockGameSeed = (seed: number, b: number): number => (seed + b) >>> 0;

/** The rotated seat entries and profiles of a lineup, in position order. */
export function rotationOf(lineup: Lineup): {
  readonly positions: PlayerId[];
  readonly entries: Extract<LineupSeat, { kind: "llm" }>[];
  readonly profiles: string[];
} {
  const llm = lineup.seats
    .filter((s): s is Extract<LineupSeat, { kind: "llm" }> => s.kind === "llm")
    .toSorted((a, b) => Number(a.seat.slice(1)) - Number(b.seat.slice(1)));
  return {
    positions: llm.map((s) => s.seat),
    entries: llm,
    profiles: llm.map((s) => s.profile),
  };
}

/** One match of a series, before it runs. */
export interface SeriesMatch {
  readonly index: number;
  readonly block: number;
  readonly run: string;
  readonly seed: number;
  /** Per position: the model entry and the profile it plays. */
  readonly seats: readonly {
    readonly seat: PlayerId;
    readonly model: number;
    readonly profile: number;
  }[];
  readonly lineup: Lineup;
}

/** The matches of a series: per block, the squares' rows, each a lineup of its own. */
export function seriesMatches(
  lineup: Lineup,
  blocks: number,
  seed: number,
): {
  readonly matches: SeriesMatch[];
  readonly orthogonal: boolean;
} {
  const rot = rotationOf(lineup);
  const order = rot.positions.length;
  if (order === 0) throw new UsageError(`--lineup ${lineup.id} has no LLM seat to rotate`);
  const total = blocks * order;
  const width = Math.max(2, String(total).length);
  const matches: SeriesMatch[] = [];
  let orthogonal = true;
  for (let b = 0; b < blocks; b += 1) {
    const sq = randomSquares(order, blockSquareSeed(seed, b));
    orthogonal &&= sq.orthogonal;
    for (let j = 0; j < order; j += 1) {
      const index = b * order + j + 1;
      const tag = String(index).padStart(width, "0");
      const seats = rot.positions.map((seat, i) => ({
        seat,
        model: sq.models[j]?.[i] ?? i,
        profile: sq.profiles[j]?.[i] ?? i,
      }));
      const bySeat = new Map(seats.map((s) => [s.seat, s]));
      matches.push({
        index,
        block: b,
        run: `m${tag}`,
        seed: blockGameSeed(seed, b),
        seats,
        lineup: {
          ...lineup,
          id: `${lineup.id}-m${tag}`,
          title: `${lineup.title} (series match ${index}, block ${b + 1})`,
          seats: lineup.seats.map((s) => {
            const r = bySeat.get(s.seat);
            const entry = r === undefined ? undefined : rot.entries[r.model];
            const profile = r === undefined ? undefined : rot.profiles[r.profile];
            if (s.kind === "bot" || entry === undefined || profile === undefined) return s;
            return { ...entry, seat: s.seat, profile };
          }),
        },
      });
    }
  }
  return { matches, orthogonal };
}

export interface SeriesOptions {
  /** A preset name or a lineup file. */
  readonly lineup: string;
  /** The series directory (must hold no series). */
  readonly out: string;
  readonly blocks: number;
  readonly seed: number;
  /** The run flags every match shares (`--fake`, `--days`, `--price-date`, `--budget-usd`, …). */
  readonly request: ArenaRequest;
  readonly env: ArenaEnv;
  readonly io: CliIo;
  readonly quiet: boolean;
  readonly signals?: SignalSource;
  readonly now?: () => number;
}

/** A Google account on Tier 1 stops at $250 of spend a month (design §4.2, §6.4). */
const GOOGLE_TIER1_MONTHLY_NANO_USD = 250_000_000_000;

const SERIES_FILE = "series.json";

/** A model entry as the manifest and the messages name it. */
const entryLabel = (m: SeriesManifest["models"][number]): string =>
  `${m.provider}:${m.model}${m.endpoint === null ? "" : `@${m.endpoint}`}/${m.effort}`;

function writeManifest(out: string, m: SeriesManifest): void {
  writeFileSync(
    join(out, SERIES_FILE),
    `${JSON.stringify(SeriesManifestSchema.parse(m), null, 2)}\n`,
  );
}

/** A signal source that also records whether a signal came. */
function watched(source: SignalSource | undefined): { source?: SignalSource; seen: () => boolean } {
  if (source === undefined) return { seen: () => false };
  let seen = false;
  return {
    source: {
      subscribe(handler) {
        return source.subscribe((signal) => {
          seen = true;
          handler(signal);
        });
      },
    },
    seen: () => seen,
  };
}

/** `arena series`: plans every match, writes the manifest, runs the matches; its exit code. */
export async function runSeries(o: SeriesOptions): Promise<number> {
  const io = o.io;
  const say = (text: string): void => {
    if (!o.quiet) io.out(text);
  };
  if (!Number.isSafeInteger(o.blocks) || o.blocks < 1) {
    throw new UsageError(`--blocks must be a positive integer, got ${o.blocks}`);
  }
  const lineup = loadLineup(o.lineup);
  const rot = rotationOf(lineup);
  const { matches, orthogonal } = seriesMatches(lineup, o.blocks, o.seed);
  if (existsSync(join(o.out, SERIES_FILE))) {
    throw new UsageError(`${o.out} already holds a series (${SERIES_FILE}): give a new --out`);
  }
  for (const m of matches) assertFreeRunDir(join(o.out, m.run));

  // Every match planned first, from lineup files in a scratch directory: nothing is written when
  // one is refused.
  const scratch = mkdtempSync(join(tmpdir(), "perfidia-series-"));
  const plans: ArenaPlan[] = [];
  try {
    for (const m of matches) {
      const file = join(scratch, `${m.run}.json`);
      writeFileSync(file, `${JSON.stringify(m.lineup, null, 2)}\n`);
      plans.push(
        planArena(
          { ...o.request, lineup: file, seed: m.seed },
          o.env,
          o.now === undefined ? {} : { now: o.now },
        ),
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const models = rot.entries.map((e) => ({
    provider: e.provider,
    model: e.model,
    endpoint: e.endpoint ?? null,
    effort: e.effort ?? lineup.defaults.effort ?? "medium",
  }));
  const fake = o.request.fake === true;
  const warnings: string[] = [];
  if (!orthogonal) {
    warnings.push(
      `no orthogonal Latin square of order ${rot.positions.length} is built: profiles rotate by an independent Latin square, so model × profile pairs are not balanced within a block`,
    );
  }
  const sum = (f: (p: ArenaPlan) => number): number => plans.reduce((n, p) => n + f(p), 0);
  const googleHigh = sum((p) =>
    p.prediction.seats.filter((s) => s.provider === "google").reduce((n, s) => n + s.high, 0),
  );
  if (googleHigh > GOOGLE_TIER1_MONTHLY_NANO_USD) {
    warnings.push(
      `the series' Google seats are predicted up to ${formatCents(googleHigh)} (high): over Gemini Tier 1's $250 monthly account cap, the service pauses until the 1st once it is reached`,
    );
  }
  const budgets = plans.map((p) => p.budget?.budgetNanoUsd ?? null);
  say(
    `series of ${lineup.id}: ${matches.length} match(es) in ${o.blocks} block(s) of ${rot.positions.length}, seed ${o.seed}${fake ? ", fake models ($0)" : ""}${orthogonal ? " (Graeco-Latin)" : ""}\n`,
  );
  say(
    `prediction: ${formatCents(sum((p) => p.prediction.match.low))} low · ${formatCents(sum((p) => p.prediction.match.central))} central · ${formatCents(sum((p) => p.prediction.match.high))} high over the series${budgets.every((b) => b !== null) ? `; at most ${formatCents(budgets.reduce<number>((n, b) => n + (b ?? 0), 0))} (the sum of the match budgets)` : ""}\n`,
  );
  const modelText = (i: number): string => {
    const m = models[i];
    return m === undefined ? "?" : entryLabel(m);
  };
  for (const m of matches) {
    say(
      `  ${m.run}  block ${m.block + 1}  seed ${m.seed}  ${m.seats.map((s) => `${s.seat} ${modelText(s.model)} as ${rot.profiles[s.profile] ?? "?"}`).join(" · ")}\n`,
    );
  }
  for (const w of warnings) io.err(`warning: ${w}\n`);

  mkdirSync(join(o.out, "lineups"), { recursive: true });
  const manifest: SeriesManifest = {
    format: SERIES_FORMAT,
    lineup: lineup.id,
    seed: o.seed,
    fake,
    order: rot.positions.length,
    blocks: o.blocks,
    orthogonal,
    positions: rot.positions,
    models,
    profiles: rot.profiles,
    matches: matches.map((m) => ({
      index: m.index,
      block: m.block,
      run: m.run,
      seed: m.seed,
      seats: m.seats.map((s) => ({ seat: s.seat, model: s.model, profile: s.profile })),
      status: "planned",
      code: null,
      levelE: null,
      costNanoUsd: null,
    })),
  };
  for (const m of matches) {
    writeFileSync(
      join(o.out, "lineups", `${m.run}.json`),
      `${JSON.stringify(m.lineup, null, 2)}\n`,
    );
  }
  writeManifest(o.out, manifest);

  const signals = watched(o.signals);
  let code: number = EXIT.ok;
  for (const [i, m] of matches.entries()) {
    say(`series match ${m.index}/${matches.length} (${m.run})\n`);
    const plan = planArena(
      { ...o.request, lineup: join(o.out, "lineups", `${m.run}.json`), seed: m.seed },
      o.env,
      o.now === undefined ? {} : { now: o.now },
    );
    // oxlint-disable-next-line no-await-in-loop -- one match at a time: the series stops at a failure
    const outcome = await runArena(plan, {
      dir: join(o.out, m.run),
      io,
      quiet: o.quiet,
      ...(signals.source === undefined ? {} : { signals: signals.source }),
    });
    const row = manifest.matches[i];
    if (row !== undefined) {
      manifest.matches[i] = {
        ...row,
        status: outcome.status,
        code: outcome.code,
        levelE: outcome.report.levelE?.ok ?? null,
        costNanoUsd: outcome.report.budget.actualNanoUsd,
      };
    }
    writeManifest(o.out, manifest);
    if (outcome.code !== EXIT.ok) {
      io.err(
        `arena series: ${m.run} ended ${outcome.status} (exit ${outcome.code}): the series stops; ${matches.length - i - 1} match(es) not played\n`,
      );
      code = outcome.code;
      break;
    }
    if (signals.seen()) {
      io.err(
        `arena series: an operator signal during ${m.run}: the series stops; ${matches.length - i - 1} match(es) not played\n`,
      );
      code = EXIT.fatal;
      break;
    }
  }
  const played = manifest.matches.filter((m) => m.status !== "planned");
  io.out(
    `series ${lineup.id}: ${played.length}/${matches.length} match(es) played, Level E ${played.every((m) => m.levelE === true) ? "ok" : "NOT ok"} on every one, spent ${formatUsd(played.reduce((n, m) => n + (m.costNanoUsd ?? 0), 0))}\n`,
  );
  io.out(`series manifest: ${join(o.out, SERIES_FILE)}\n`);
  return code;
}
