// Price cards of every provider (phase-4 design §2.9, Pass 1b): pico-dollars per token with their
// source and check date, UTC validity windows, long-context tiers, time-of-day overrides charged at
// their highest, the platform fee, and costs rounded up to whole nano-dollars; the model catalog the
// plan validates seats against. The rates pinned here were read on 2026-10-20 from each card's
// source (fetched copies kept in the session's scratchpad, p4b-web/).

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { UsageEntry } from "./adapter.ts";
import { MODELS, capabilitiesFor, endpointInfo, modelInfo } from "./catalog.ts";
import {
  ALL_CARDS,
  MAX_CARD,
  billable,
  cardAt,
  cardById,
  cardsFrom,
  costOf,
  effectivePrices,
  entryCost,
  pricerFor,
  type PriceCard,
} from "./prices.ts";
import { perMTok } from "./prices/card.ts";

const entry = (
  model: string,
  t: Partial<UsageEntry["tokens"]>,
  kind: "message" | "fallback" = "message",
): UsageEntry => ({
  model,
  kind,
  tokens: { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, ...t },
  estimated: false,
});

/** A card's rates in $/MTok: input, output, cache read, short write, long write. */
const rates = (c: {
  input: number;
  output: number;
  cacheRead: number;
  write5m: number;
  write1h: number;
}) => [c.input, c.output, c.cacheRead, c.write5m, c.write1h].map((p) => p / 1_000_000);

const card = (provider: string, model: string, endpoint: string | null, at: string) => {
  const c = cardAt(provider, model, endpoint, at);
  if (c === null) throw new Error(`no card ${provider}:${model}`);
  return c;
};

const OCT = "2026-10-19T00:00:00.000Z";

describe("price cards (pico-dollars per token)", () => {
  test("every card has an id, a source URL, a check date and a window; ids are unique", () => {
    const ids = new Set<string>();
    for (const c of ALL_CARDS) {
      expect(ids.has(c.id)).toBe(false);
      ids.add(c.id);
      expect(c.source).toMatch(/^https:\/\//);
      expect(c.checked).toBe("2026-10-20");
      expect(c.id).toStartWith(`${c.provider}:${c.model}`);
      expect(Number.isNaN(Date.parse(c.validFrom))).toBe(false);
      if (c.validTo !== null)
        expect(Date.parse(c.validTo)).toBeGreaterThan(Date.parse(c.validFrom));
      for (const p of [c.input, c.output, c.cacheRead, c.write5m, c.write1h]) {
        expect(Number.isSafeInteger(p) && p >= 0).toBe(true);
      }
    }
    expect(ALL_CARDS.length).toBe(19);
    expect(perMTok("0.075")).toBe(75_000);
    expect(perMTok("0.0016")).toBe(1_600);
    expect(() => perMTok("1e3")).toThrow("not a price");
  });

  test("the rates read on 2026-10-20 ($/MTok: input, output, cache read, short write, long write)", () => {
    expect(rates(card("anthropic", "claude-fable-5-1", null, OCT))).toEqual([
      10, 50, 0.25, 12.5, 20,
    ]);
    expect(rates(card("anthropic", "claude-sonnet-5-5", null, OCT))).toEqual([2, 10, 0.1, 2.5, 4]);
    expect(rates(card("openai", "gpt-6.1-sol", null, OCT))).toEqual([2, 10, 0.1, 2.5, 2.5]);
    expect(rates(card("openai", "gpt-6-sol", null, OCT))).toEqual([2, 10, 0.2, 2.5, 2.5]);
    expect(rates(card("openai", "gpt-6-luna", null, OCT))).toEqual([0.1, 0.5, 0.01, 0.125, 0.125]);
    expect(rates(card("openai", "gpt-6-astra", null, OCT))).toEqual([10, 50, 1, 12.5, 12.5]);
    expect(rates(card("google", "gemini-4-argon", null, OCT))).toEqual([2, 10, 0.1, 2, 2]);
    expect(rates(card("google", "gemini-3.8-flash", null, OCT))).toEqual([
      0.75, 3.75, 0.075, 0.75, 0.75,
    ]);
    expect(rates(card("openrouter", "z-ai/glm-5.3", "z-ai/fp8", OCT))).toEqual([
      1.4, 4.4, 0.26, 1.4, 1.4,
    ]);
    expect(rates(card("openrouter", "z-ai/glm-5.3-flash", "z-ai/fp8", OCT))).toEqual([
      0.15, 0.5, 0.03, 0.15, 0.15,
    ]);
    expect(rates(card("openrouter", "moonshotai/kimi-k3", "moonshotai/mxfp4", OCT))).toEqual([
      3, 15, 0.3, 3, 3,
    ]);
    expect(rates(card("openrouter", "deepseek/deepseek-v4.1-flash-1017", "together", OCT))).toEqual(
      [0.3, 1.2, 0.006, 0.3, 0.3],
    );
    // OpenAI's long-context tier (over 272K input tokens): 2× input and cache, 1.5× output.
    const sol = card("openai", "gpt-6.1-sol", null, OCT);
    expect(sol.longContext?.aboveTokens).toBe(272_000);
    expect(rates({ ...(sol.longContext?.card ?? sol) })).toEqual([4, 15, 0.2, 5, 5]);
    // Fees: OpenRouter only.
    for (const c of ALL_CARDS)
      expect(c.platformFeePermille).toBe(c.provider === "openrouter" ? 55 : 0);
  });

  test("dated windows: Argon doubles from 2026-11-30T00:00Z, 3.8 Flash from 2026-12-31T00:00Z", () => {
    expect(card("google", "gemini-4-argon", null, "2026-11-29T23:59:59Z").id).toBe(
      "google:gemini-4-argon@2026-10-20",
    );
    expect(card("google", "gemini-4-argon", null, "2026-11-30T00:00:00Z").id).toBe(
      "google:gemini-4-argon@2026-10-20#from2026-11-30",
    );
    expect(rates(card("google", "gemini-4-argon", null, "2026-12-01T00:00:00Z"))).toEqual([
      4, 20, 0.2, 4, 4,
    ]);
    expect(rates(card("google", "gemini-3.8-flash", null, "2027-01-01T00:00:00Z"))).toEqual([
      1.5, 7.5, 0.15, 1.5, 1.5,
    ]);
    // Before the first read, no card: the plan refuses the seat.
    expect(cardAt("google", "gemini-4-argon", null, "2026-10-18T00:00:00Z")).toBeNull();
    // A run billed from before a change is bounded by both windows.
    expect(cardsFrom("google", "gemini-4-argon", null, OCT).map((c) => c.id)).toEqual([
      "google:gemini-4-argon@2026-10-20",
      "google:gemini-4-argon@2026-10-20#from2026-11-30",
    ]);
    expect(cardsFrom("google", "gemini-4-argon", null, "2026-12-02T00:00:00Z")).toHaveLength(1);
    // An OpenRouter card belongs to its endpoint: another endpoint has none.
    expect(cardAt("openrouter", "z-ai/glm-5.3", "wafer/us", OCT)).toBeNull();
    expect(cardAt("openrouter", "z-ai/glm-5.3", null, OCT)).toBeNull();
  });

  test("costs round up to whole nano-dollars; the platform fee is added and reported apart", () => {
    const glm = { provider: "openrouter", endpoint: "z-ai/fp8", at: OCT };
    // 1 token of DeepSeek cache read = 6000 pUSD = 6 nUSD; 1 token of GLM-5.3 Flash read = 30 nUSD.
    const one = entryCost(entry("z-ai/glm-5.3-flash", { cacheRead: 1 }), glm);
    expect([one.nanoUsd, one.feeNanoUsd, one.card]).toEqual([
      30 + 2,
      2,
      "openrouter:z-ai/glm-5.3-flash(z-ai/fp8)@2026-10-20",
    ]);
    const big = entryCost(
      entry("z-ai/glm-5.3", { input: 1000, cacheRead: 9000, output: 1500 }),
      glm,
    );
    const tokens = 1000 * 1400 + 9000 * 260 + 1500 * 4400;
    expect([big.nanoUsd, big.feeNanoUsd]).toEqual([
      tokens + Math.ceil((tokens * 55) / 1000),
      Math.ceil((tokens * 55) / 1000),
    ]);
    // A sub-nano price rounds the entry up, never down.
    const sub: PriceCard = { ...card("openai", "gpt-6-luna", null, OCT) };
    expect(sub.cacheRead).toBe(10_000);
    const c = costOf([entry("gpt-6-luna", { cacheRead: 1 })], {
      provider: "openai",
      endpoint: null,
      at: OCT,
    });
    expect([c.nanoUsd, c.feeNanoUsd, c.cards]).toEqual([10, 0, ["openai:gpt-6-luna@2026-10-20"]]);
    // The pricer picks the card by the attempt's start, unless the run pinned an instant.
    const argon = pricerFor({ provider: "google", endpoint: null, fixedAt: null, fallbackAt: OCT });
    const out = [entry("gemini-4-argon", { output: 1000 })];
    expect(argon(out, "2026-11-29T12:00:00Z").nanoUsd).toBe(10_000_000);
    expect(argon(out, "2026-11-30T12:00:00Z").nanoUsd).toBe(20_000_000);
    expect(argon(out, undefined).nanoUsd).toBe(10_000_000);
    const pinned = pricerFor({ provider: "google", endpoint: null, fixedAt: OCT, fallbackAt: OCT });
    expect(pinned(out, "2026-12-30T00:00:00Z").nanoUsd).toBe(10_000_000);
  });

  test("long-context tiers price the whole request; an unknown model is charged at the highest of all cards", () => {
    const ctx = { provider: "openai", endpoint: null, at: OCT };
    const under = entryCost(entry("gpt-6.1-sol", { input: 272_000, output: 10 }), ctx);
    const over = entryCost(entry("gpt-6.1-sol", { input: 272_001, output: 10 }), ctx);
    expect([under.longPrompt, under.nanoUsd]).toEqual([false, 272_000 * 2000 + 10 * 10_000]);
    expect([over.longPrompt, over.card, over.nanoUsd]).toEqual([
      true,
      "openai:gpt-6.1-sol@2026-10-20#over272k",
      272_001 * 4000 + 10 * 15_000,
    ]);
    const u = costOf([entry("gpt-9", { input: 1, output: 1 })], ctx);
    expect(u.unpriced).toEqual(["gpt-9"]);
    expect(u.nanoUsd).toBe(Math.ceil((MAX_CARD.input + MAX_CARD.output) / 1000));
    expect(MAX_CARD.output).toBe(75_000_000);
    // A fake seat's usage priced at the wrong provider is unpriced, never zero.
    expect(costOf([entry("gemini-4-argon", { input: 1 })]).unpriced).toEqual(["gemini-4-argon"]);
  });

  test("time-of-day overrides are charged at their highest price per kind (an upper bound)", () => {
    const base = card("openrouter", "deepseek/deepseek-v4.1-flash-1017", "together", OCT);
    const withOverrides: PriceCard = {
      ...base,
      overrides: [
        { utcStart: 0, utcEnd: 100, prices: { input: 150_000, output: 600_000 } },
        {
          utcStart: 100,
          utcEnd: 400,
          days: ["monday"],
          prices: { input: 600_000, cacheRead: 9_000 },
        },
      ],
    };
    expect(effectivePrices(withOverrides)).toEqual({
      input: 600_000,
      output: 1_200_000,
      cacheRead: 9_000,
      write5m: 300_000,
      write1h: 300_000,
    });
    expect(billable([withOverrides]).map((c) => c.input)).toEqual([600_000]);
    expect(cardById("openai:gpt-6.1-sol@2026-10-20#over272k")?.input).toBe(4_000_000);
    expect(cardById("nope")).toBeNull();
  });

  test("an entry's cost is monotone in every token count and never below its exact value (property)", () => {
    const n = fc.integer({ min: 0, max: 400_000 });
    fc.assert(
      fc.property(fc.constantFrom(...ALL_CARDS), n, n, n, n, n, (c, i, w5, w1, r, o) => {
        const ctx = { provider: c.provider, endpoint: c.endpoint, at: c.validFrom };
        const e = entry(c.model, {
          input: i,
          cacheWrite5m: w5,
          cacheWrite1h: w1,
          cacheRead: r,
          output: o,
        });
        const got = entryCost(e, ctx);
        const p = got.longPrompt && c.longContext !== null ? c.longContext.card : c;
        const exactPico =
          i * p.input + w5 * p.write5m + w1 * p.write1h + r * p.cacheRead + o * p.output;
        expect(got.unpriced).toBe(false);
        expect(got.nanoUsd * 1000).toBeGreaterThanOrEqual(exactPico);
        expect(got.nanoUsd - got.feeNanoUsd).toBe(Math.ceil(exactPico / 1000));
        const more = entryCost({ ...e, tokens: { ...e.tokens, output: o + 1 } }, ctx);
        expect(more.nanoUsd).toBeGreaterThanOrEqual(got.nanoUsd);
      }),
      { numRuns: 300, seed: 1919 },
    );
  });
});

describe("the model catalog", () => {
  test("every seat model has a card, its efforts and limits; OpenRouter models pin a ZDR endpoint", () => {
    for (const m of MODELS.filter((x) => x.seat)) {
      const endpoint = m.endpoints[0]?.tag ?? null;
      expect([m.model, cardAt(m.provider, m.model, endpoint, OCT) !== null]).toEqual([
        m.model,
        true,
      ]);
      expect(m.capabilities.efforts.length).toBeGreaterThan(0);
      expect(m.capabilities.contextTokens).toBeGreaterThanOrEqual(1_000_000);
      expect(m.capabilities.maxOutputTokens).toBeGreaterThanOrEqual(65_536);
      expect(m.source).toMatch(/https:\/\/|claude-api skill/);
    }
    expect(capabilitiesFor("google", "gemini-4-argon")).toMatchObject({
      efforts: ["low", "medium", "high"],
      operatorChannel: "envelope",
      cache: "implicit",
      maxOutputTokens: 65_536,
      minAttemptTimeoutMs: 15 * 60_000,
    });
    expect(capabilitiesFor("openai", "gpt-6.1-sol").efforts).not.toContain("none");
    expect(capabilitiesFor("openai", "gpt-6-luna").efforts).toContain("none");
    expect(capabilitiesFor("openai", "gpt-6-luna").operatorChannel).toBe("developer");
    expect(modelInfo("openai", "gpt-6.1-sol")?.reasoningContext).toBe("all_turns");
    expect(capabilitiesFor("anthropic", "claude-sonnet-5-5").operatorChannel).toBe("system");
    const glm = endpointInfo("z-ai/glm-5.3", "z-ai/fp8");
    expect([
      glm?.zdr,
      glm?.quantization,
      glm?.supportedParams.includes("parallel_tool_calls"),
    ]).toEqual([true, "fp8", false]);
    expect(capabilitiesFor("openrouter", "z-ai/glm-5.3", "z-ai/fp8")).toMatchObject({
      maxOutputTokens: 131_072,
      contextTokens: 1_048_576,
      reasoning: "raw",
    });
    // GLM-5.3 reasons always: `none` is not an effort it takes.
    expect(capabilitiesFor("openrouter", "z-ai/glm-5.3").efforts).not.toContain("none");
    expect(modelInfo("openrouter", "z-ai/glm-5.3")?.advertisedEfforts).toEqual([
      "max",
      "high",
      "low",
    ]);
    // Unknown models get their provider's defaults (tests, smoke), never a crash.
    expect(capabilitiesFor("anthropic", "claude-mystery").operatorChannel).toBe("system");
    expect(capabilitiesFor("acme", "x").operatorChannel).toBe("system");
  });
});
