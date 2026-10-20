import { randInt, streamRng, type Rng } from "@perfidia/engine/core";
import {
  MODEL_STATS_FORMAT,
  type Claims,
  type MatchStats,
  type ModelAggregate,
  type ModelSeatRow,
  type ModelStatsFile,
  type RatingItem,
  type RatingSet,
  type Ratings,
  type SeatStats,
  type StatsGrouping,
  type StatsInterval,
  type StatsModel,
  type StatsTokens,
} from "@perfidia/protocol";
import { itemOf } from "@perfidia/spectator/stats";
import { PRIOR_SIGMA } from "./pl.ts";
import { CLAIM_ALPHA, CLAIM_GAP, GAPS, binomialPower, neededFor } from "./power.ts";
import {
  LEVEL,
  MIN_BOOTSTRAP_BLOCKS,
  percentileInterval,
  rateMatches,
  type RankedMatch,
} from "./rate.ts";

// Per-model statistics across matches (phase-4 design §6.2, §6.4): every seat of every match is an
// item (its model by default; or its profile, prompt variant, model × profile; a bot is always its
// bot), as it started (intention to treat). Descriptive figures (wakes, messages, pacts, battles,
// errors, cost) are summed per item; cost per match is also given per lineup, since social and
// urgent wakes depend on the opponents. Outcomes (final ranks, wins) and the ratings are claims: they
// are computed only once every compared pair of LLM items met in the rated matches a 70/30
// head-to-head claim needs (`power.ts`), or with `exploratory` (the command line only).
//
// Ratings: a MAP Plackett–Luce fit of each rated match's full ranking (`pl.ts`), LLM strengths summed
// to zero, also on an Elo-like scale; the headline keeps every seat as it started, the clean
// sensitivity drops handed-off seats from their rankings. Intervals: a block bootstrap over rotation
// blocks (a series' block of matches, else a match alone), seeded and deterministic, from 5 blocks;
// below, Laplace posterior intervals (strengths and differences only). Everything is sorted by id,
// never by outcome.

export type SeriesSummary = ModelStatsFile["series"][number];

export interface AggregateOptions {
  readonly grouping?: StatsGrouping;
  /** Publish costs, tokens and model time (default true; a match that withheld them stays without). */
  readonly costs?: boolean;
  /** The bootstrap's seed (default `DEFAULT_SEED`). */
  readonly seed?: number;
  readonly replicates?: number;
  /** Outcomes and ratings below the claim threshold (never served). */
  readonly exploratory?: boolean;
  readonly series?: readonly SeriesSummary[];
}

export const DEFAULT_SEED = 20_261_019;
export const DEFAULT_REPLICATES = 1000;
const ELO_PER_STRENGTH = 400 / Math.LN10;

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Six decimals: stable output, far below any interval's width. */
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const r1 = (x: number): number => Math.round(x * 10) / 10;

/** The bootstrap block of a match: its series' block, else the match alone. */
export function blockOf(m: MatchStats): string {
  return m.series === null ? `match:${m.match}` : `series:${m.series.lineup}#${m.series.block}`;
}

interface Item {
  readonly key: string;
  id: string;
  readonly kind: "llm" | "bot";
  readonly model: StatsModel | null;
  fake: boolean;
}

interface SeatRef {
  readonly match: MatchStats;
  readonly seat: SeatStats;
  readonly item: number;
}

function merge(into: Map<string, number>, rec: Readonly<Record<string, number>>): void {
  for (const [k, v] of Object.entries(rec)) into.set(k, (into.get(k) ?? 0) + v);
}

function record(m: ReadonlyMap<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of [...m.keys()].toSorted(byText)) out[k] = m.get(k) ?? 0;
  return out;
}

/** The item ids: each key's base id, `-2`, `-3`… when two keys share one (keys in sorted order). */
function assignIds(items: Item[]): void {
  const used = new Set<string>();
  for (const it of items.toSorted((a, b) => byText(a.key, b.key))) {
    let id = it.id;
    for (let k = 2; used.has(id); k += 1) id = `${it.id}-${k}`;
    it.id = id;
    used.add(id);
  }
}

/** The claim state of the rated matches (design §6.4). */
export function claimsOf(rated: readonly (readonly number[])[], llm: ReadonlySet<number>): Claims {
  const pairs = new Map<string, number>();
  const present = new Set<number>();
  for (const items of rated) {
    const mine = [...new Set(items.filter((i) => llm.has(i)))].toSorted((a, b) => a - b);
    for (const i of mine) present.add(i);
    for (const [k, a] of mine.entries()) {
      for (const b of mine.slice(k + 1)) pairs.set(`${a}|${b}`, (pairs.get(`${a}|${b}`) ?? 0) + 1);
    }
  }
  const compared = pairs.size;
  const matches = compared === 0 ? 0 : Math.min(...pairs.values());
  const alpha = CLAIM_ALPHA / Math.max(1, compared);
  const needed = neededFor(CLAIM_GAP.p, Math.max(1, compared));
  const state = compared === 0 ? "no_comparison" : matches >= needed ? "ok" : "too_few_matches";
  return {
    state,
    gap: CLAIM_GAP.label,
    models: present.size,
    pairs: compared,
    alpha: r6(alpha),
    matches,
    needed,
    more: Math.max(0, needed - matches),
    power: r6(binomialPower(matches, CLAIM_GAP.p, alpha)),
    table: GAPS.map((g) => ({
      gap: g.label,
      needed: neededFor(g.p, Math.max(1, compared)),
      power: r6(binomialPower(matches, g.p, alpha)),
    })),
  };
}

/** An interval rounded to six decimals (the point itself when there is none). */
const iv = (x: StatsInterval | null, fallback: number): StatsInterval =>
  x === null ? { lo: r6(fallback), hi: r6(fallback) } : { lo: r6(x.lo), hi: r6(x.hi) };
/** A strength on the Elo-like scale. */
const elo = (s: number): number => r1(1500 + ELO_PER_STRENGTH * s);

const DIPLOMACY_SUMS = [
  "messagesSent",
  "messagesReceived",
  "pactsSigned",
  "pactsKept",
  "pactsBroken",
  "betrayalsCommitted",
  "betrayalsSuffered",
  "alliancesFounded",
  "alliancesJoined",
  "selfIdentification",
] as const;
const MILITARY_SUMS = [
  "battlesAttacked",
  "battlesDefended",
  "battlesWon",
  "citiesConquered",
  "citiesLost",
] as const;
const TOKEN_KINDS = [
  "input",
  "cacheWrite5m",
  "cacheWrite1h",
  "cacheRead",
  "output",
  "reasoning",
] as const;

/** A rating set of the items `fitItems` (by item index) over ranked matches using fit indices. */
function ratingSet(
  items: readonly Item[],
  fitItems: readonly number[],
  matches: readonly RankedMatch[],
  rng: Rng,
  replicates: number,
): { set: RatingSet; method: "block-bootstrap" | "laplace"; blocks: number } {
  const n = fitItems.length;
  // The compared items: the LLM ones; a run of bots only compares its bots (the power check).
  const llmOnly = fitItems.flatMap((it, i) => (items[it]?.kind === "llm" ? [i] : []));
  const llm = llmOnly.length > 0 ? llmOnly : fitItems.map((_, i) => i);
  const rated = rateMatches(n, llm, matches, rng, replicates);
  const counts = Array.from({ length: n }, () => 0);
  for (const m of matches) for (const i of new Set(m.ranking)) counts[i] = (counts[i] ?? 0) + 1;
  const ratingItems: RatingItem[] = fitItems.map((it, i): RatingItem => {
    const item = items[it];
    const s = rated.strength[i] ?? 0;
    const interval = iv(rated.strengthIv[i] ?? null, s);
    const rankIv = rated.rankIv[i] ?? null;
    return {
      id: item?.id ?? "x",
      key: item?.key ?? "",
      kind: item?.kind ?? "bot",
      matches: counts[i] ?? 0,
      strength: r6(s),
      interval,
      elo: elo(s),
      eloInterval: { lo: elo(interval.lo), hi: elo(interval.hi) },
      meanRank: r6(rated.rank[i] ?? 0),
      meanRankInterval: rankIv === null ? null : { lo: r6(rankIv.lo), hi: r6(rankIv.hi) },
    };
  });
  const pairs: RatingSet["pairs"] = rated.pairs.map((p) => {
    let met = 0;
    let ahead = 0;
    for (const m of matches) {
      const ra = m.ranking.indexOf(p.a);
      const rb = m.ranking.indexOf(p.b);
      if (ra < 0 || rb < 0) continue;
      met += 1;
      if (ra < rb) ahead += 1;
    }
    return {
      a: items[fitItems[p.a] ?? 0]?.id ?? "x",
      b: items[fitItems[p.b] ?? 0]?.id ?? "x",
      matches: met,
      aAhead: ahead,
      difference: r6(p.difference),
      interval: iv(p.interval, p.difference),
    };
  });
  return {
    set: {
      matches: matches.length,
      seats: matches.reduce((s, m) => s + m.ranking.length, 0),
      items: ratingItems.toSorted((x, y) => byText(x.id, y.id)),
      pairs: pairs.toSorted((x, y) => byText(`${x.a}|${x.b}`, `${y.a}|${y.b}`)),
    },
    method: rated.method,
    blocks: rated.blocks,
  };
}

/** The ratings of the rated matches (headline and clean), over fit indices of the items they rank. */
function ratingsOf(
  items: readonly Item[],
  refs: readonly SeatRef[],
  seed: number,
  replicates: number,
): Ratings | null {
  const build = (clean: boolean): RankedMatch[] => {
    const byMatch = new Map<string, SeatRef[]>();
    for (const r of refs) {
      if (!r.match.rated) continue;
      if (clean && r.seat.incidents.handoff !== null) continue;
      byMatch.set(r.match.match, [...(byMatch.get(r.match.match) ?? []), r]);
    }
    return [...byMatch.keys()].toSorted(byText).flatMap((id) => {
      const seats = (byMatch.get(id) ?? []).toSorted(
        (a, b) => a.seat.outcome.rank - b.seat.outcome.rank,
      );
      const first = seats[0];
      if (first === undefined || seats.length < 2) return [];
      return [
        {
          block: blockOf(first.match),
          ranking: seats.map((s) => s.item),
          ranks: seats.map((s) => s.seat.outcome.rank),
        },
      ];
    });
  };
  const headline = build(false);
  const clean = build(true);
  const reindex = (
    matches: readonly RankedMatch[],
  ): { fitItems: number[]; matches: RankedMatch[] } => {
    const fitItems = [...new Set(matches.flatMap((m) => m.ranking))].toSorted((a, b) =>
      byText(items[a]?.id ?? "", items[b]?.id ?? ""),
    );
    const at = new Map(fitItems.map((it, i) => [it, i]));
    return {
      fitItems,
      matches: matches.map((m) => ({ ...m, ranking: m.ranking.map((it) => at.get(it) ?? 0) })),
    };
  };
  const h = reindex(headline);
  if (h.fitItems.length < 2) return null;
  const c = reindex(clean);
  const hs = ratingSet(items, h.fitItems, h.matches, streamRng(seed >>> 0, "headline"), replicates);
  const cs =
    c.fitItems.length < 2
      ? { set: { matches: 0, seats: 0, items: [], pairs: [] }, method: hs.method, blocks: 0 }
      : ratingSet(items, c.fitItems, c.matches, streamRng(seed >>> 0, "clean"), replicates);
  return {
    method: "map-plackett-luce",
    priorSigma: PRIOR_SIGMA,
    intervals: {
      method: hs.method,
      level: LEVEL,
      blocks: hs.blocks,
      replicates: hs.method === "block-bootstrap" ? replicates : 0,
      bootstrapSeed: seed >>> 0,
    },
    headline: hs.set,
    clean: cs.set,
  };
}

const zeroTokens = (): StatsTokens => ({
  input: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  output: 0,
  reasoning: 0,
});

/** The mean cost per match of one item in one lineup, with its block-bootstrap interval. */
function lineupCost(
  perMatch: readonly { readonly block: string; readonly cost: number }[],
  rng: Rng,
  replicates: number,
): { mean: number; interval: StatsInterval | null } {
  const mean = perMatch.reduce((s, m) => s + m.cost, 0) / Math.max(1, perMatch.length);
  const blocks = [...new Set(perMatch.map((m) => m.block))].toSorted(byText);
  if (blocks.length < MIN_BOOTSTRAP_BLOCKS || replicates <= 0) return { mean, interval: null };
  const byBlock = new Map<string, number[]>();
  for (const m of perMatch) byBlock.set(m.block, [...(byBlock.get(m.block) ?? []), m.cost]);
  const means: number[] = [];
  for (let r = 0; r < replicates; r += 1) {
    let sum = 0;
    let count = 0;
    for (let b = 0; b < blocks.length; b += 1) {
      for (const c of byBlock.get(blocks[randInt(rng, 0, blocks.length - 1)] ?? "") ?? []) {
        sum += c;
        count += 1;
      }
    }
    means.push(count === 0 ? 0 : sum / count);
  }
  const within = percentileInterval(means);
  return {
    mean,
    interval: within === null ? null : { lo: Math.floor(within.lo), hi: Math.ceil(within.hi) },
  };
}

function aggregateOf(
  item: Item,
  refs: readonly SeatRef[],
  costs: boolean,
  show: boolean,
  seed: number,
  replicates: number,
): ModelAggregate {
  const matches = new Set(refs.map((r) => r.match.match));
  const handoffs = new Map<string, number>();
  const rejections = new Map<string, number>();
  const refusals = new Map<string, number>();
  const stops = new Map<string, number>();
  const errors = new Map<string, number>();
  let wakes = 0;
  let rounds = 0;
  let calls = 0;
  let thoughts = 0;
  const d = {
    messagesSent: 0,
    messagesReceived: 0,
    pactsSigned: 0,
    pactsKept: 0,
    pactsBroken: 0,
    betrayalsCommitted: 0,
    betrayalsSuffered: 0,
    alliancesFounded: 0,
    alliancesJoined: 0,
    selfIdentification: 0,
  };
  const mil = {
    battlesAttacked: 0,
    battlesDefended: 0,
    battlesWon: 0,
    citiesConquered: 0,
    citiesLost: 0,
  };
  let wakeCaps = 0;
  let promptCaps = 0;
  let errorWakes = 0;
  let ops = false;
  let attempts = 0;
  let malformed = 0;
  let invalidArgs = 0;
  let toolRounds = 0;
  let parallelRounds = 0;
  let latN = 0;
  let lat50 = 0;
  let lat95 = 0;
  let latency = false;
  let costSeen = false;
  let costTotal = 0;
  const costMatches = new Set<string>();
  const tokens = zeroTokens();
  const perLineup = new Map<string, Map<string, { block: string; cost: number }>>();
  for (const { match, seat } of refs) {
    if (seat.incidents.handoff !== null) {
      const reason = seat.incidents.handoff.reason ?? "unknown";
      handoffs.set(reason, (handoffs.get(reason) ?? 0) + 1);
    }
    wakes += seat.play.wakes;
    rounds += seat.play.rounds;
    calls += seat.play.calls;
    thoughts += seat.play.thoughts;
    merge(rejections, seat.play.rejections);
    for (const k of DIPLOMACY_SUMS) d[k] += seat.diplomacy[k];
    for (const k of MILITARY_SUMS) mil[k] += seat.military[k];
    wakeCaps += seat.incidents.wakeCaps;
    promptCaps += seat.incidents.promptCaps;
    errorWakes += seat.incidents.errorWakes;
    merge(refusals, seat.incidents.refusals);
    const o = seat.operations;
    if (o !== null) {
      ops = true;
      attempts += o.attempts;
      merge(stops, o.stops);
      merge(errors, o.errors);
      malformed += o.toolErrors.malformed;
      invalidArgs += o.toolErrors.invalidArgs;
      toolRounds += o.toolRounds;
      parallelRounds += o.parallelRounds;
      if (o.latencyMs !== null) {
        latency = true;
        latN += o.latencyMs.n;
        lat50 += o.latencyMs.p50 * o.latencyMs.n;
        lat95 += o.latencyMs.p95 * o.latencyMs.n;
      }
    }
    const c = seat.cost;
    if (costs && c !== null && match.published.costs) {
      costSeen = true;
      costTotal += c.nanoUsd;
      costMatches.add(match.match);
      for (const k of TOKEN_KINDS) tokens[k] += c.tokens[k];
      const lineup = match.lineup ?? "none";
      const byMatch = perLineup.get(lineup) ?? new Map<string, { block: string; cost: number }>();
      const prev = byMatch.get(match.match);
      byMatch.set(match.match, { block: blockOf(match), cost: (prev?.cost ?? 0) + c.nanoUsd });
      perLineup.set(lineup, byMatch);
    }
  }
  const prompt = tokens.input + tokens.cacheWrite5m + tokens.cacheWrite1h + tokens.cacheRead;
  const rated = refs.filter((r) => r.match.rated);
  const ranks: number[] = [];
  for (const r of rated) {
    const k = r.seat.outcome.rank - 1;
    while (ranks.length <= k) ranks.push(0);
    ranks[k] = (ranks[k] ?? 0) + 1;
  }
  const mean = (f: (r: SeatRef) => number): number =>
    rated.length === 0 ? 0 : r6(rated.reduce((s, r) => s + f(r), 0) / rated.length);
  return {
    id: item.id,
    key: item.key,
    kind: item.kind,
    model: item.model,
    fake: item.fake,
    matches: matches.size,
    seats: refs.length,
    rated: rated.length,
    handoffs: record(handoffs),
    play: { wakes, rounds, calls, thoughts, rejections: record(rejections) },
    diplomacy: d,
    military: mil,
    incidents: {
      wakeCaps,
      promptCaps,
      errorWakes,
      refusals: record(refusals),
      parallelPermille:
        !ops || toolRounds === 0 ? null : Math.round((parallelRounds * 1000) / toolRounds),
    },
    operations: !ops
      ? null
      : {
          attempts,
          stops: record(stops),
          errors: record(errors),
          toolErrors: { malformed, invalidArgs },
          latencyMs:
            !latency || latN === 0
              ? null
              : { n: latN, p50: Math.round(lat50 / latN), p95: Math.round(lat95 / latN) },
        },
    cost: !costSeen
      ? null
      : {
          nanoUsd: costTotal,
          perMatchNanoUsd: Math.floor(costTotal / Math.max(1, costMatches.size)),
          perWakeNanoUsd: wakes === 0 ? null : Math.floor(costTotal / wakes),
          cacheReadPermille: prompt === 0 ? 0 : Math.round((tokens.cacheRead * 1000) / prompt),
          tokens,
          byLineup: [...perLineup.keys()].toSorted(byText).map((lineup) => {
            const rows = [...(perLineup.get(lineup)?.values() ?? [])];
            const c = lineupCost(
              rows,
              streamRng(seed >>> 0, `cost:${item.id}:${lineup}`),
              replicates,
            );
            return {
              lineup,
              matches: rows.length,
              meanNanoUsd: Math.floor(c.mean),
              interval: c.interval,
            };
          }),
        },
    outcome:
      !show || rated.length === 0
        ? null
        : {
            rated: rated.length,
            meanRank: mean((r) => r.seat.outcome.rank),
            ranks,
            wins: rated.filter((r) => r.seat.outcome.winner).length,
            dominationWins: rated.filter(
              (r) => r.seat.outcome.winner && r.match.result?.reason === "domination",
            ).length,
            citiesMean: mean((r) => r.seat.outcome.cities),
          },
  };
}

/** The items of each rated match's seats. */
function ratedItemsOf(matches: readonly MatchStats[], refs: readonly SeatRef[]): number[][] {
  return matches
    .filter((m) => m.rated)
    .map((m) => refs.filter((r) => r.match === m).map((r) => r.item));
}

/** The per-model statistics of these matches. */
export function aggregate(stats: readonly MatchStats[], o: AggregateOptions = {}): ModelStatsFile {
  const grouping = o.grouping ?? "model";
  const costs = o.costs !== false;
  const seed = o.seed ?? DEFAULT_SEED;
  const replicates = o.replicates ?? DEFAULT_REPLICATES;
  const matches = stats.toSorted((a, b) => byText(a.match, b.match));
  const items: Item[] = [];
  const byKey = new Map<string, number>();
  const refs: SeatRef[] = [];
  for (const match of matches) {
    for (const seat of match.seats) {
      const g = itemOf(
        {
          kind: seat.kind,
          key: seat.key,
          id: seat.id,
          profile: seat.profile,
          variant: seat.promptVariant,
        },
        grouping,
      );
      let index = byKey.get(g.key);
      if (index === undefined) {
        index = items.length;
        byKey.set(g.key, index);
        items.push({
          key: g.key,
          id: g.id,
          kind: seat.kind,
          model: grouping === "model" ? seat.model : null,
          fake: seat.fake,
        });
      }
      const it = items[index];
      if (it !== undefined && seat.fake) it.fake = true;
      refs.push({ match, seat, item: index });
    }
  }
  assignIds(items);
  const llmItems = items.flatMap((it, i) => (it.kind === "llm" ? [i] : []));
  const ratedSeats = new Set(ratedItemsOf(matches, refs).flat());
  // A run of bots only (the power check of design §6.4) compares its bots.
  const llm = new Set(llmItems.some((i) => ratedSeats.has(i)) ? llmItems : items.map((_, i) => i));
  const claims = claimsOf(ratedItemsOf(matches, refs), llm);
  const show = claims.state === "ok" || o.exploratory === true;
  const order = items
    .map((_, i) => i)
    .toSorted((a, b) => byText(items[a]?.id ?? "", items[b]?.id ?? ""));
  const models = order.map((i) => {
    const item = items[i];
    if (item === undefined) throw new Error("no item");
    return aggregateOf(
      item,
      refs.filter((r) => r.item === i),
      costs,
      show,
      seed,
      replicates,
    );
  });
  const seats: ModelSeatRow[] = refs
    .map((r): ModelSeatRow => ({
      id: items[r.item]?.id ?? "x",
      match: r.match.match,
      seat: r.seat.seat,
      rated: r.match.rated,
      lineup: r.match.lineup,
      profile: r.seat.profile,
      promptVariant: r.seat.promptVariant,
      handedOff: r.seat.incidents.handoff !== null,
      wakes: r.seat.play.wakes,
      costNanoUsd: costs && r.match.published.costs ? (r.seat.cost?.nanoUsd ?? null) : null,
      rank: show ? r.seat.outcome.rank : null,
    }))
    .toSorted((a, b) => byText(`${a.id}|${a.match}|${a.seat}`, `${b.id}|${b.match}|${b.seat}`));
  const ratedBlocks = new Set(matches.filter((m) => m.rated).map(blockOf));
  return {
    format: MODEL_STATS_FORMAT,
    grouping,
    published: { costs },
    matches: matches.map((m) => ({
      match: m.match,
      status: m.status,
      rated: m.rated,
      fake: m.fake,
      lineup: m.lineup,
      series: m.series,
      block: blockOf(m),
      seats: refs
        .filter((r) => r.match === m)
        .map((r) => ({ seat: r.seat.seat, id: items[r.item]?.id ?? "x" })),
    })),
    series: [...(o.series ?? [])],
    blocks: ratedBlocks.size,
    models,
    claims,
    ratings: show ? ratingsOf(items, refs, seed, replicates) : null,
    exploratory: o.exploratory === true && claims.state !== "ok",
    seats,
  };
}
