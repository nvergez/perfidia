import { describe, expect, test } from "bun:test";
import type { Claims, ModelAggregate, RatingItem } from "@perfidia/protocol/spectator";
import fc from "fast-check";
import {
  botName,
  channelWords,
  claimExplanation,
  claimHeadline,
  countsWords,
  displayOrder,
  fmtInterval,
  fmtMs,
  fmtPermille,
  fmtProb,
  fmtShare,
  fmtTokens,
  fmtUsdFine,
  handoffWords,
  itemName,
  mainReasoningKind,
  rankingShown,
  ratingOrder,
  reasoningKindsWords,
  remindersWords,
  scalePercent,
  seriesWords,
  total,
} from "./format.ts";

const claims = (o: Partial<Claims> = {}): Claims => ({
  state: "too_few_matches",
  gap: "70/30",
  models: 4,
  pairs: 6,
  alpha: 0.05 / 6,
  matches: 4,
  needed: 74,
  more: 70,
  power: 0.0004,
  table: [
    { gap: "80/20", needed: 32, power: 0 },
    { gap: "70/30", needed: 74, power: 0 },
    { gap: "60/40", needed: 303, power: 0 },
  ],
  ...o,
});

type Item = Pick<ModelAggregate, "id" | "key" | "kind" | "model" | "fake">;
const model = (provider: string, name: string, o: Partial<Item> = {}): Item => ({
  id: `${provider}.${name}`.replaceAll("/", "-"),
  key: `${provider}/${name}/medium`,
  kind: "llm",
  fake: provider === "fake",
  model: {
    provider,
    model: name,
    endpoint: null,
    effort: "medium",
    intended: null,
    quantization: null,
    effortSent: null,
  },
  ...o,
});

const ratingItem = (id: string, strength: number): RatingItem => ({
  id,
  key: id,
  kind: "llm",
  matches: 10,
  strength,
  interval: { lo: strength - 1, hi: strength + 1 },
  elo: 1500,
  eloInterval: { lo: 1400, hi: 1600 },
  meanRank: 2,
  meanRankInterval: null,
});

describe("money, shares and numbers", () => {
  test("dollars keep sub-cent figures; a dollar or more reads as fmtUsd", () => {
    expect(fmtUsdFine(0)).toBe("$0.00");
    expect(fmtUsdFine(50_000)).toBe("<$0.0001");
    expect(fmtUsdFine(1_444_084)).toBe("$0.0014");
    expect(fmtUsdFine(20_700_000)).toBe("$0.0207");
    expect(fmtUsdFine(140_300_000)).toBe("$0.1403");
    expect(fmtUsdFine(999_940_000)).toBe("$0.9999");
    expect(fmtUsdFine(1_000_000_000)).toBe("$1.00");
    expect(fmtUsdFine(12_050_000_000)).toBe("$12.05");
  });

  test("sub-dollar amounts round to the nearest ten-thousandth of a dollar", () => {
    fc.assert(
      fc.property(fc.integer({ min: 100_000, max: 999_949_999 }), (nano) => {
        const s = fmtUsdFine(nano);
        expect(s).toMatch(/^\$0\.\d{4}$/);
        expect(Math.abs(Number(s.slice(1)) * 1e9 - nano)).toBeLessThanOrEqual(50_000);
      }),
      { numRuns: 300 },
    );
  });

  test("permille, shares, probabilities, intervals, time and tokens", () => {
    expect(fmtPermille(617)).toBe("61.7%");
    expect(fmtPermille(0)).toBe("0.0%");
    expect(fmtPermille(1000)).toBe("100.0%");
    expect(fmtPermille(null)).toBe("–");
    expect(fmtShare(1, 3)).toBe("33.3%");
    expect(fmtShare(3, 0)).toBe("–");
    expect(fmtProb(0.8104)).toBe("0.81");
    expect(fmtProb(0)).toBe("0.00");
    expect(fmtInterval({ lo: -0.366, hi: 0.044 })).toBe("[−0.37, 0.04]");
    expect(fmtInterval({ lo: 1432.4, hi: 1611.6 }, 0)).toBe("[1,432, 1,612]");
    expect(fmtMs(850)).toBe("850 ms");
    expect(fmtMs(1_240)).toBe("1.2 s");
    expect(fmtMs(14_400)).toBe("14 s");
    expect(fmtTokens(950)).toBe("950");
    expect(fmtTokens(12_400)).toBe("12.4K");
    expect(fmtTokens(1_234_567)).toBe("1.23M");
    expect(scalePercent(5, 0, 10)).toBe(50);
    expect(scalePercent(-100, 0, 10)).toBe(0);
    expect(scalePercent(3, 3, 3)).toBe(50);
  });
});

describe("the claim state", () => {
  test("too few matches: how many more, the power now; no ranking", () => {
    const c = claims();
    expect(claimHeadline(c)).toBe("Too few matches: 70 more needed (power now 0.00)");
    expect(rankingShown(c)).toBe(false);
    expect(claimExplanation(c)).toBe(
      "A ranking is shown once every pair of models has met in 74 rated matches: enough to see a 70/30 head-to-head edge 80% of the time (exact binomial test, α = 0.05 split over 6 pairs). 4 models, 6 pairs; the pair that met least has met in 4 rated matches.",
    );
  });

  test("ok: a ranking may be shown; no comparison: says so", () => {
    const ok = claims({ state: "ok", matches: 76, more: 0, power: 0.9214 });
    expect(rankingShown(ok)).toBe(true);
    expect(claimHeadline(ok)).toBe(
      "Enough matches for a ranking: 76 rated matches for the pair that met least (74 needed; power 0.92)",
    );
    const none = claims({ state: "no_comparison", models: 1, pairs: 0, matches: 0, needed: 0 });
    expect(rankingShown(none)).toBe(false);
    expect(claimHeadline(none)).toBe("No comparison yet: no two models have met in a rated match");
    expect(claimExplanation(none)).toContain("So far 1 model took part");
    expect(claimExplanation(claims({ pairs: 1 }))).toContain("(exact binomial test, α = 0.05)");
  });
});

describe("display order", () => {
  test("models by name, then rehearsals, then bots; never by outcome", () => {
    const items: Item[] = [
      { id: "bot.conqueror.3", key: "bot:conqueror@3", kind: "bot", model: null, fake: false },
      model("openai", "gpt-6-luna"),
      model("fake", "z-ai/glm-5.3-flash"),
      model("anthropic", "claude-haiku-5-5"),
      { id: "bot.expander.2", key: "bot:expander@2", kind: "bot", model: null, fake: false },
      model("google", "gemini-3.8-flash"),
      model("fake", "claude-opus-5-5"),
    ];
    expect(displayOrder(items).map((m) => m.id)).toEqual([
      "anthropic.claude-haiku-5-5",
      "google.gemini-3.8-flash",
      "openai.gpt-6-luna",
      "fake.claude-opus-5-5",
      "fake.z-ai-glm-5.3-flash",
      "bot.conqueror.3",
      "bot.expander.2",
    ]);
    expect(itemName(model("anthropic", "claude-haiku-5-5"))).toBe("Claude Haiku 5.5");
    expect(itemName(model("fake", "gpt-6-luna"))).toBe("Fake for GPT-6 Luna");
    expect(
      itemName({
        ...model("fake", "z-ai/glm-5.3-flash"),
        model: {
          provider: "fake",
          model: "z-ai/glm-5.3-flash",
          endpoint: "z-ai/fp8",
          effort: "low",
          intended: "openrouter",
          quantization: "fp8",
          effortSent: null,
        },
      }),
    ).toBe("Fake for GLM-5.3 Flash (Z.AI via OpenRouter)");
    expect(itemName(items[0] ?? model("x", "y"))).toBe("Conqueror (bot, version 3)");
    expect(botName("bot:turtle@3")).toBe("Turtle (bot, version 3)");
    expect(botName("weird")).toBe("weird");
  });

  test("ratings by strength, strongest first, ties by id", () => {
    expect(
      ratingOrder([ratingItem("b", 0.1), ratingItem("a", 0.1), ratingItem("c", 0.9)]).map(
        (r) => r.id,
      ),
    ).toEqual(["c", "a", "b"]);
  });
});

describe("words", () => {
  test("reasoning kinds by attempts, and the main one", () => {
    expect(reasoningKindsWords({ raw: 56, none: 4 })).toBe("raw chain of thought (56), none (4)");
    expect(reasoningKindsWords({ summary: 3 })).toBe("summary (3)");
    expect(reasoningKindsWords({})).toBe("not logged");
    expect(reasoningKindsWords({ odd: 2 })).toBe("odd (2)");
    expect(mainReasoningKind({ raw: 56, none: 70 })).toBe("raw");
    expect(mainReasoningKind({ summary: 2, raw: 1 })).toBe("summary");
    expect(mainReasoningKind({ none: 3 })).toBe("none");
    expect(mainReasoningKind({})).toBeNull();
  });

  test("channel, reminders, hand-off, series, counts", () => {
    expect(channelWords("developer")).toBe("developer messages");
    expect(channelWords("envelope")).toBe("[harness] text in its user turns");
    expect(remindersWords("last-round")).toBe("reminders at the turn's start and last round only");
    expect(remindersWords("every-round")).toBe("reminders after every round");
    expect(handoffWords("match_budget")).toBe("the match budget ran out");
    expect(handoffWords(null)).toBe("reason not recorded");
    expect(seriesWords({ lineup: "budget-mix", block: 0, index: 2 })).toBe(
      "series budget-mix, block 1, match 2",
    );
    expect(countsWords({ A: 1, B: 3, C: 0 })).toBe("B 3, A 1");
    expect(countsWords({})).toBe("none");
    expect(countsWords({ a: 5, b: 4, c: 3, d: 2, e: 1 })).toBe("a 5, b 4, c 3, d 2 and 1 other");
    expect(total({ a: 2, b: 3 })).toBe(5);
  });
});
