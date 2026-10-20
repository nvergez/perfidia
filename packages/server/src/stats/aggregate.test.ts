// Statistics across matches (phase-4 design §6.2, §6.4, §8.8) on hand-made match statistics: below
// the claim threshold no outcome, rank or rating leaves the aggregate (`--exploratory` shows them,
// flagged); a 76-match rotation series of four models of known strengths passes it and its ratings
// recover their order, with block-bootstrap intervals that are deterministic for a seed; cost per
// match per lineup with its interval; `--no-costs`; the clean sensitivity; groupings; id collisions.

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
import { aggregate } from "./aggregate.ts";
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
}

function seatStats(seat: PlayerId, s: SeatSpec, winners: readonly number[]): SeatStats {
  const llm = s.item < 4;
  const model = llm ? (MODELS[s.item] ?? null) : null;
  const key = model === null ? (BOTS[s.item - 4] ?? "bot:x@1") : modelKey(model);
  const zero = { messages: 0, pacts: 0, alliances: 0 };
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
    fake: false,
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
        : { lineup: "budget-mix", block: o.block, index: Number(id.slice(1)) },
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

/** A rotation series of `n` matches of four models of known strengths and two bots, seeded. */
function series(n: number, seed: number): MatchStats[] {
  const truth = [0.9, 0.3, -0.3, -0.9, 0, 0];
  const rng = mulberry32(seed);
  const u = (): number => (rng.nextU32() + 0.5) / 4_294_967_296;
  return Array.from({ length: n }, (_, m) => {
    const order = samplePlackettLuce([0, 1, 2, 3, 4, 5], truth, u);
    const seats: SeatSpec[] = [0, 1, 2, 3, 4, 5].map((item) => ({
      item,
      rank: order.indexOf(item) + 1,
      profile: PROFILES[(item + m) % 4],
      cost: item < 4 ? 1_000_000_000 * (item + 1) + m * 1_000_000 : undefined,
      handoff: item === 3 && m % 10 === 0,
    }));
    return matchStats(`m${String(m + 1).padStart(2, "0")}`, seats, { block: Math.floor(m / 4) });
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

  test("the claim threshold is met: ratings recover the four models' order", () => {
    expect(f.claims).toMatchObject({ state: "ok", pairs: 6, matches: 76, needed: 74, more: 0 });
    const r = f.ratings;
    if (r === null) throw new Error("no ratings");
    expect(r.intervals).toMatchObject({ method: "block-bootstrap", blocks: 19, replicates: 200 });
    const s = (id: string): number =>
      r.headline.items.find((i) => i.id === id)?.strength ?? Number.NaN;
    const ids = MODELS.map(modelIdOf);
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
    expect(other.ratings?.headline.items.map((i) => i.interval)).not.toEqual(
      f.ratings?.headline.items.map((i) => i.interval),
    );
  });

  test("cost per match per lineup, with its block-bootstrap interval; --no-costs", () => {
    const haiku = f.models.find((m) => m.id === "anthropic.claude-haiku-5-5.medium");
    const byLineup = haiku?.cost?.byLineup ?? [];
    expect(byLineup.map((l) => [l.lineup, l.matches])).toEqual([["budget-mix", 76]]);
    const l = byLineup[0];
    expect(l?.meanNanoUsd).toBe(1_037_500_000);
    expect(l?.interval !== null && l !== undefined && l.interval.lo <= l.meanNanoUsd).toBe(true);
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
