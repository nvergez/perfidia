// Statistics across matches (phase-4 design §6.2, §6.4, §8.8) on hand-made match statistics: below
// the claim threshold no outcome, rank or rating leaves the aggregate (`--exploratory` shows them,
// flagged); a 76-match rotation series of four models of known strengths passes it and its ratings
// recover their order (Laplace intervals below 40 blocks; a 160-match series gets block-bootstrap
// intervals, deterministic for a seed); pairs at the claim's Bonferroni level; an unrotated root is
// `unbalanced`; a rehearsal in a real root neither blocks nor joins the claim; pairs that never met
// count; cost per match over rated matches and per lineup; per wake over costed seats only;
// `--no-costs`; the clean sensitivity; groupings; id collisions.

import { describe, expect, test } from "bun:test";
import { mulberry32 } from "@perfidia/engine/core";
import {
  MatchStatsSchema,
  ModelStatsFileSchema,
  type MatchStats,
  type PlayerId,
  type SeatStats,
  type StatsModel,
} from "@perfidia/protocol";
import { modelIdOf, modelKey } from "@perfidia/spectator/stats";
import { aggregate, balanceSlack } from "./aggregate.ts";
import { samplePlackettLuce } from "./pl.ts";

const MODELS: StatsModel[] = [
  "claude-haiku-5-5",
  "gpt-6-luna",
  "gemini-3.8-flash",
  "z-ai/glm-5.3-flash",
].map((model, i) => ({
  provider: ["anthropic", "openai", "google", "openrouter"][i] ?? "x",
  model,
  endpoint: i === 3 ? "z-ai/fp8" : null,
  effort: i === 3 ? "low" : "medium",
  intended: null,
  quantization: null,
  effortSent: null,
}));
const BOTS = ["bot:opportunist@3", "bot:conqueror@3"];
const PROFILES = ["odysseus@1", "achilles@1", "penelope@1", "agamemnon@1"];

interface SeatSpec {
  readonly item: number;
  readonly rank: number;
  readonly profile?: string | undefined;
  readonly cost?: number | undefined;
  readonly handoff?: boolean | undefined;
  readonly fake?: boolean | undefined;
  /** Another model id for the item (a second lineup's models). */
  readonly model?: string | undefined;
}

function seatStats(seat: PlayerId, s: SeatSpec, winners: readonly number[]): SeatStats {
  const llm = s.item < 4;
  const base = llm ? (MODELS[s.item] ?? null) : null;
  const model =
    base === null
      ? null
      : {
          ...base,
          ...(s.model === undefined ? {} : { model: s.model }),
          ...(s.fake === true ? { provider: "fake", intended: base.provider } : {}),
        };
  const key = model === null ? (BOTS[s.item - 4] ?? "bot:x@1") : modelKey(model);
  const zero = { messages: 0, pacts: 0, alliances: 0, partners: 0 };
  return {
    seat,
    kind: llm ? "llm" : "bot",
    label: key,
    key,
    id: model === null ? `bot.${key.slice(4).replace("@", ".")}` : modelIdOf(model),
    name: seat,
    model,
    profile: llm ? (s.profile ?? "odysseus@1") : null,
    promptVariant: llm ? "system" : null,
    reminders: null,
    toolsHash: null,
    fake: s.fake === true,
    outcome: {
      rank: s.rank,
      score: 100 - s.rank,
      cities: 7 - s.rank,
      alive: true,
      eliminatedAt: null,
      winner: winners.includes(s.rank),
    },
    play: {
      turns: 10,
      wakes: llm ? 10 : 0,
      rounds: llm ? 30 : 0,
      calls: llm ? 60 : 0,
      accepted: llm ? 50 : 0,
      rejections: llm ? { INVALID_ARGS: 1 } : {},
      thoughts: llm ? 9 : 0,
      endings: llm ? { end_turn: 10 } : {},
    },
    diplomacy: {
      messagesSent: 2,
      messagesReceived: 3,
      publicSent: 1,
      proposalsSent: 1,
      proposalsReceived: 1,
      accepted: 1,
      refused: 0,
      alliancesFounded: 0,
      alliancesJoined: 0,
      alliancesLeft: 0,
      pactsSigned: 1,
      pactsKept: 1,
      pactsBroken: 0,
      pactEnds: {},
      betrayalsCommitted: 0,
      betrayalsSuffered: 0,
      sameModel: llm ? zero : null,
      crossModel: llm ? zero : null,
      selfIdentification: 0,
    },
    military: {
      battlesAttacked: 1,
      battlesDefended: 1,
      battlesWon: 1,
      citiesConquered: 0,
      citiesLost: 0,
      citiesFounded: 2,
    },
    incidents: {
      handoff: s.handoff === true ? { t: 3600, reason: "cap", label: "bot:turtle@3" } : null,
      wakeCaps: 0,
      promptCaps: 0,
      fallbackPermille: 0,
      errorWakes: 0,
      refusals: {},
      parallelPermille: llm ? 500 : null,
    },
    operations: llm
      ? {
          attempts: 30,
          thoughtCalls: 0,
          stops: { tool_use: 30 },
          errors: {},
          toolErrors: { malformed: 0, invalidArgs: 1 },
          fallbacks: 0,
          toolRounds: 20,
          parallelRounds: 10,
          textChars: 100,
          reasoningChars: 200,
          reasoningKinds: { summary: 30 },
          latencyMs: { n: 30, p50: 1000, p95: 3000 },
          ttftMs: null,
        }
      : null,
    cost:
      llm && s.cost !== undefined
        ? {
            nanoUsd: s.cost,
            perWakeNanoUsd: Math.floor(s.cost / 10),
            preflightNanoUsd: 0,
            feesNanoUsd: 0,
            reportedNanoUsd: null,
            estimatedNanoUsd: 0,
            byKind: null,
            tokens: {
              input: 100,
              cacheWrite5m: 100,
              cacheWrite1h: 0,
              cacheRead: 800,
              output: 50,
              reasoning: 0,
            },
            cacheReadPermille: 800,
            priceCards: [],
            capNanoUsd: 5_000_000_000,
          }
        : null,
  };
}

function matchStats(
  id: string,
  seats: readonly SeatSpec[],
  o: {
    readonly rated?: boolean;
    readonly block?: number;
    readonly lineup?: string | null;
    readonly costs?: boolean;
    readonly prefix?: string;
  } = {},
): MatchStats {
  return MatchStatsSchema.parse({
    format: "perfidia-stats/1",
    match: id,
    ruleset: "perfidia-1@1.1.0",
    status: o.rated === false ? "stopped" : "ended",
    verified: true,
    rated: o.rated !== false,
    clock: "lockstep",
    lastT: 604_800,
    endedAt: o.rated === false ? null : 604_800,
    result: o.rated === false ? null : { reason: "domination", winners: ["p1"] },
    fake: false,
    lineup: o.lineup === undefined ? "budget-mix" : o.lineup,
    series:
      o.block === undefined
        ? null
        : {
            lineup: o.lineup ?? "budget-mix",
            block: o.block,
            index: Number(id.slice((o.prefix ?? "m").length)),
          },
    published: { costs: o.costs !== false },
    seats: seats.map((s, i) => seatStats(`p${i + 1}`, s, [1])),
    collusion: {
      samePairs: 0,
      crossPairs: 6,
      same: { messages: 0, pacts: 0, alliances: 0 },
      cross: { messages: 0, pacts: 0, alliances: 0 },
    },
    cost: null,
  });
}

/**
 * A rotation series of `n` matches of four models of known strengths and two bots, seeded: in each
 * block of four, each model sits on each of p1–p4 once and plays each profile once (bots on p5, p6).
 * `rotate: false` keeps every model on one seat and one profile (no rotation).
 */
function series(
  n: number,
  seed: number,
  o: {
    readonly rotate?: boolean;
    readonly truth?: readonly number[];
    readonly prefix?: string;
  } = {},
): MatchStats[] {
  const truth = o.truth ?? [0.9, 0.3, -0.3, -0.9, 0, 0];
  const rng = mulberry32(seed);
  const u = (): number => (rng.nextU32() + 0.5) / 4_294_967_296;
  // The GF(4) Graeco-Latin pair of `arena series`: in row r, position c holds model r ⊕ c and
  // profile 2·r ⊕ c (2· in GF(4): 0, 2, 3, 1).
  const twice = [0, 2, 3, 1];
  return Array.from({ length: n }, (_, m) => {
    const order = samplePlackettLuce([0, 1, 2, 3, 4, 5], truth, u);
    const r = o.rotate === false ? 0 : m % 4;
    const at = (item: number): number => (item < 4 ? r ^ item : item);
    const seats: SeatSpec[] = [0, 1, 2, 3, 4, 5]
      .map((item) => ({
        item,
        rank: order.indexOf(item) + 1,
        profile: PROFILES[((twice[r] ?? 0) ^ r ^ item) % 4],
        cost: item < 4 ? 1_000_000_000 * (item + 1) + m * 1_000_000 : undefined,
        handoff: item === 3 && m % 10 === 0,
      }))
      .toSorted((a, b) => at(a.item) - at(b.item));
    const id = `${o.prefix ?? "m"}${String(m + 1).padStart(3, "0")}`;
    return matchStats(id, seats, { block: Math.floor(m / 4), prefix: o.prefix ?? "m" });
  });
}

describe("below the claim threshold", () => {
  const few = series(8, 1);

  test("no outcome, rank or rating leaves the aggregate; the state says how many more", () => {
    const f = ModelStatsFileSchema.parse(aggregate(few, { replicates: 50 }));
    expect(f.claims).toMatchObject({ state: "too_few_matches", models: 4, pairs: 6, matches: 8 });
    expect([f.claims.needed, f.claims.more]).toEqual([74, 66]);
    expect(f.ratings).toBeNull();
    expect(f.exploratory).toBe(false);
    expect(f.models.every((m) => m.outcome === null)).toBe(true);
    expect(f.seats.every((s) => s.rank === null)).toBe(true);
    // Descriptive figures stay: wakes, messages, cost, tool errors.
    const haiku = f.models.find((m) => m.id === "anthropic.claude-haiku-5-5.medium");
    expect(haiku?.play.wakes).toBe(80);
    expect(haiku?.operations?.toolErrors.invalidArgs).toBe(8);
    expect(haiku?.incidents.parallelPermille).toBe(500);
    expect(haiku?.cost?.perMatchNanoUsd).toBe(1_003_500_000);
    // Sorted by id, never by outcome.
    const ids = f.models.map((m) => m.id);
    expect(ids).toEqual(ids.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(f.blocks).toBe(2);
  });

  test("--exploratory shows them, flagged", () => {
    const f = aggregate(few, { replicates: 50, exploratory: true });
    expect(f.exploratory).toBe(true);
    expect(f.ratings?.intervals.method).toBe("laplace");
    expect(f.models.find((m) => m.kind === "llm")?.outcome).not.toBeNull();
    expect(f.seats.every((s) => s.rank !== null)).toBe(true);
  });

  test("no rated match, or one model: no comparison", () => {
    const stopped = structuredClone(few);
    for (const m of stopped) m.rated = false;
    expect(aggregate(stopped, { replicates: 0 }).claims.state).toBe("no_comparison");
  });
});

describe("a 76-match rotation series (19 blocks of 4)", () => {
  const all = series(76, 2);
  const f = aggregate(all, { replicates: 200 });
  const ids = MODELS.map(modelIdOf);

  test("the claim threshold is met: ratings recover the four models' order", () => {
    expect(f.claims).toMatchObject({
      state: "ok",
      pairs: 6,
      unmet: 0,
      matches: 76,
      needed: 74,
      more: 0,
      balance: { ok: true, items: [] },
    });
    const r = f.ratings;
    if (r === null) throw new Error("no ratings");
    // 19 blocks: Laplace intervals widened to the block bootstrap's where it is wider.
    expect(r.intervals).toMatchObject({
      method: "laplace+block-bootstrap",
      blocks: 19,
      replicates: 200,
    });
    expect(r.intervals.pairLevel).toBeCloseTo(1 - 0.05 / 6, 6);
    const s = (id: string): number =>
      r.headline.items.find((i) => i.id === id)?.strength ?? Number.NaN;
    const strengths = ids.map(s);
    expect(strengths).toEqual(strengths.toSorted((a, b) => b - a));
    expect(Math.abs(strengths.reduce((a, b) => a + b, 0))).toBeLessThan(1e-5);
    for (const item of r.headline.items) {
      expect(item.interval.lo).toBeLessThanOrEqual(item.strength);
      expect(item.interval.hi).toBeGreaterThanOrEqual(item.strength);
      expect(item.elo).toBeCloseTo(1500 + (400 / Math.LN10) * item.strength, 0);
      expect(item.meanRankInterval).not.toBeNull();
    }
    // The pair of the strongest and the weakest: far apart, in every match together.
    const pair = r.headline.pairs.find((p) => p.a === ids[0] && p.b === ids[3]);
    expect(pair?.matches).toBe(76);
    expect(pair?.interval.lo).toBeGreaterThan(0);
    // Outcomes and ranks are shown.
    expect(f.models.every((m) => m.outcome !== null)).toBe(true);
    expect(f.seats.every((x) => x.rank !== null)).toBe(true);
  });

  test("the clean sensitivity leaves the handed-off seats out of their rankings", () => {
    const r = f.ratings;
    expect(r?.headline.seats).toBe(76 * 6);
    expect(r?.clean.seats).toBe(76 * 6 - 8);
    const glm = f.models.find((m) => m.id === modelIdOf(MODELS[3] ?? MODELS[0]!));
    expect(glm?.handoffs).toEqual({ cap: 8 });
  });

  test("deterministic for a seed; another seed moves the intervals, not the fit", () => {
    expect(aggregate(all, { replicates: 200 })).toEqual(f);
    const other = aggregate(all, { replicates: 200, seed: 99 });
    expect(other.ratings?.headline.items.map((i) => i.strength)).toEqual(
      f.ratings?.headline.items.map((i) => i.strength),
    );
    expect(other.ratings?.headline.items.map((i) => i.meanRankInterval)).not.toEqual(
      f.ratings?.headline.items.map((i) => i.meanRankInterval),
    );
  });

  test("cost per match over rated matches, per lineup, small-sample corrected; --no-costs", () => {
    const haiku = f.models.find((m) => m.id === "anthropic.claude-haiku-5-5.medium");
    const byLineup = haiku?.cost?.byLineup ?? [];
    expect(byLineup.map((l) => [l.lineup, l.matches])).toEqual([["budget-mix", 76]]);
    const l = byLineup[0];
    expect(l?.meanNanoUsd).toBe(1_037_500_000);
    // Haiku's cost is 1e9 + m·1e6 at match m: the mean's interval holds it, and is wider than the
    // raw percentile interval by the t(18)/z·√(19/18) factor (about 1.10).
    expect(l?.interval !== null && l !== undefined && l.interval.lo < l.meanNanoUsd).toBe(true);
    expect(l?.interval !== null && l !== undefined && l.interval.hi > l.meanNanoUsd).toBe(true);
    const hidden = aggregate(all, { replicates: 0, costs: false });
    expect(hidden.published.costs).toBe(false);
    expect(hidden.models.every((m) => m.cost === null)).toBe(true);
    expect(hidden.seats.every((s) => s.costNanoUsd === null)).toBe(true);
    expect(JSON.stringify(hidden)).not.toContain("1037500000");
  });

  test("groupings: by profile, by prompt variant, by model × profile; bots stay their bot", () => {
    const byProfile = aggregate(all, { replicates: 0, grouping: "profile" });
    expect(byProfile.models.map((m) => m.id)).toEqual([
      "bot.conqueror.3",
      "bot.opportunist.3",
      "profile.achilles.1",
      "profile.agamemnon.1",
      "profile.odysseus.1",
      "profile.penelope.1",
    ]);
    expect(byProfile.models.every((m) => m.model === null)).toBe(true);
    // Each profile met each model and each seat once a block: balanced.
    expect(byProfile.claims.balance.ok).toBe(true);
    const variant = aggregate(all, { replicates: 0, grouping: "variant" });
    expect(variant.models.map((m) => m.id)).toEqual([
      "bot.conqueror.3",
      "bot.opportunist.3",
      "variant.system",
    ]);
    const mp = aggregate(all.slice(0, 4), { replicates: 0, grouping: "model-profile" });
    expect(mp.models.filter((m) => m.kind === "llm")).toHaveLength(16);
  });
});

describe("the claim state reads the rotation and the pairs (review fixes)", () => {
  test("an unrotated root (each model on one seat and one profile) is unbalanced: no ranking", () => {
    // Equal models; the seat and profile each model always has would be read as its strength.
    const fixed = series(76, 9, { rotate: false, truth: [0, 0, 0, 0, -1, -1] });
    const f = aggregate(fixed, { replicates: 0 });
    expect(f.claims).toMatchObject({ state: "unbalanced", matches: 76, needed: 74, more: 0 });
    expect(f.claims.balance.ok).toBe(false);
    expect(f.claims.balance.items).toHaveLength(8);
    expect(f.claims.balance.items[0]).toMatchObject({ min: 0, max: 76, levels: 4 });
    expect(new Set(f.claims.balance.items.map((i) => i.factor))).toEqual(
      new Set(["profile", "seat"]),
    );
    expect(f.ratings).toBeNull();
    expect(f.models.every((m) => m.outcome === null)).toBe(true);
    expect(f.seats.every((s) => s.rank === null)).toBe(true);
    // The rotated series of the same length is balanced.
    expect(aggregate(series(76, 9), { replicates: 0 }).claims.state).toBe("ok");
  });

  test("balance allows one seat, or a tenth, of difference", () => {
    expect([
      balanceSlack(0),
      balanceSlack(10),
      balanceSlack(11),
      balanceSlack(19),
      balanceSlack(40),
    ]).toEqual([1, 1, 2, 2, 4]);
    // One rated match fewer (a stopped match in a block) keeps a series balanced.
    const one = series(76, 2);
    const stopped = structuredClone(one);
    const m5 = stopped[5];
    if (m5 === undefined) throw new Error("no match");
    Object.assign(m5, { rated: false, status: "stopped" });
    expect(aggregate(stopped, { replicates: 0 }).claims.balance.ok).toBe(true);
  });

  test("fake rehearsal matches in a real root neither block nor join the claim", () => {
    const real = series(76, 2);
    const rehearsal = series(8, 3, { prefix: "r" });
    for (const m of rehearsal) {
      Object.assign(m, { fake: true, series: null });
      for (const seat of m.seats) {
        if (seat.model === null) continue;
        const model = { ...seat.model, provider: "fake", intended: seat.model.provider };
        Object.assign(seat, { fake: true, model, key: modelKey(model), id: modelIdOf(model) });
      }
    }
    const f = aggregate([...real, ...rehearsal], { replicates: 0 });
    expect(f.claims).toMatchObject({ state: "ok", models: 4, pairs: 6, unmet: 0, matches: 76 });
    // The fake items are references, like the bots: rated, never paired.
    const fake = f.models.filter((m) => m.fake).map((m) => m.id);
    expect(fake).toHaveLength(4);
    const pairs = f.ratings?.headline.pairs ?? [];
    expect(pairs).toHaveLength(6);
    expect(pairs.some((p) => fake.includes(p.a) || fake.includes(p.b))).toBe(false);
    // A rehearsal root alone still compares its fake items.
    const alone = aggregate(rehearsal, { replicates: 0 });
    expect(alone.claims).toMatchObject({ state: "too_few_matches", models: 4, pairs: 6 });
  });

  test("pairs that never met count: two disjoint lineups never reach a claim", () => {
    const a = series(84, 2);
    const b = series(84, 4, { prefix: "b" });
    for (const m of b) {
      Object.assign(m, {
        lineup: "other",
        series: m.series === null ? null : { ...m.series, lineup: "other" },
      });
      for (const seat of m.seats) {
        if (seat.model === null) continue;
        const model = { ...seat.model, model: `${seat.model.model}-x` };
        Object.assign(seat, { model, key: modelKey(model), id: modelIdOf(model) });
      }
    }
    const f = aggregate([...a, ...b], { replicates: 0 });
    expect(f.claims).toMatchObject({
      state: "too_few_matches",
      models: 8,
      pairs: 28,
      unmet: 16,
      matches: 0,
    });
    expect(f.claims.alpha).toBeCloseTo(0.05 / 28, 6);
    expect(f.ratings).toBeNull();
  });

  test("cost per match leaves unrated matches out; cost per wake counts costed seats only", () => {
    const rated = matchStats("c1", [
      { item: 0, rank: 1, cost: 3_000_000_000 },
      { item: 4, rank: 2 },
    ]);
    const stopped = matchStats(
      "c2",
      [
        { item: 0, rank: 1, cost: 1_000_000_000 },
        { item: 4, rank: 2 },
      ],
      {
        rated: false,
      },
    );
    // A run without llm_calls.jsonl: its seat has wakes and no cost.
    const uncosted = matchStats("c3", [
      { item: 0, rank: 1 },
      { item: 4, rank: 2 },
    ]);
    const f = aggregate([rated, stopped, uncosted], { replicates: 0 });
    const haiku = f.models.find((m) => m.id === "anthropic.claude-haiku-5-5.medium");
    expect(haiku?.play.wakes).toBe(30);
    expect(haiku?.cost).toMatchObject({
      nanoUsd: 4_000_000_000,
      perMatchNanoUsd: 3_000_000_000,
      perWakeNanoUsd: 200_000_000,
    });
    expect(haiku?.cost?.byLineup).toEqual([
      { lineup: "budget-mix", matches: 1, meanNanoUsd: 3_000_000_000, interval: null },
    ]);
    // Only an unrated match: no cost per match.
    const g = aggregate([stopped], { replicates: 0 });
    expect(g.models.find((m) => m.kind === "llm")?.cost?.perMatchNanoUsd).toBeNull();
  });

  test("same-model and cross-model dealings sum across matches with their partners", () => {
    const m = matchStats("d1", [
      { item: 0, rank: 1 },
      { item: 1, rank: 2 },
      { item: 4, rank: 3 },
    ]);
    const seat = m.seats[0];
    if (seat === undefined) throw new Error("no seat");
    seat.diplomacy.sameModel = { messages: 2, pacts: 1, alliances: 0, partners: 1 };
    seat.diplomacy.crossModel = { messages: 4, pacts: 0, alliances: 1, partners: 2 };
    const f = aggregate([m, { ...structuredClone(m), match: "d2" }], { replicates: 0 });
    const haiku = f.models.find((x) => x.id === "anthropic.claude-haiku-5-5.medium");
    expect(haiku?.diplomacy.sameModel).toEqual({
      messages: 4,
      pacts: 2,
      alliances: 0,
      partners: 2,
    });
    expect(haiku?.diplomacy.crossModel).toEqual({
      messages: 8,
      pacts: 0,
      alliances: 2,
      partners: 4,
    });
    expect(f.models.find((x) => x.kind === "bot")?.diplomacy.sameModel).toBeNull();
  });
});

test("two keys that share an id are told apart; per-match published costs are respected", () => {
  const a = matchStats("a1", [
    { item: 0, rank: 1, cost: 5 },
    { item: 4, rank: 2 },
  ]);
  const twin = structuredClone(a);
  const seat = twin.seats[0];
  if (seat?.model === null || seat === undefined) throw new Error("no model");
  twin.match = "a2";
  seat.model = { ...seat.model, model: "claude.haiku.5.5" };
  seat.key = modelKey(seat.model);
  seat.id = modelIdOf(seat.model);
  expect(seat.id).toBe("anthropic.claude-haiku-5-5.medium");
  const f = aggregate([a, twin], { replicates: 0 });
  expect(f.models.map((m) => [m.key, m.id])).toEqual([
    ["anthropic/claude-haiku-5-5/medium", "anthropic.claude-haiku-5-5.medium"],
    ["anthropic/claude.haiku.5.5/medium", "anthropic.claude-haiku-5-5.medium-2"],
    ["bot:opportunist@3", "bot.opportunist.3"],
  ]);
  expect(f.matches.find((m) => m.match === "a2")?.seats[0]?.id).toBe(
    "anthropic.claude-haiku-5-5.medium-2",
  );
  const withheld = matchStats("b1", [{ item: 0, rank: 1, cost: 7 }], { costs: false });
  const g = aggregate([withheld], { replicates: 0 });
  expect(g.models[0]?.cost).toBeNull();
});
