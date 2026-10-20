import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { TokenUsage, UsageEntry } from "./adapter.ts";
import {
  ANTHROPIC_CHECKED,
  ANTHROPIC_PRICING_URL,
  CARDS,
  FALLBACK_TARGETS,
  HAIKU_LONG,
  HAIKU_LONG_PROMPT_TOKENS,
  MAX_PRICE,
  MAX_PRICE_ID,
  PRICES,
  cardsOf,
  costOf,
  entryCost,
  formatCents,
  formatUsd,
  requirePrice,
  usdToNano,
} from "./prices.ts";

const tokens = (t: Partial<TokenUsage>): TokenUsage => ({
  input: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  output: 0,
  ...t,
});
const entry = (model: string, t: Partial<TokenUsage>, kind: "message" | "fallback" = "message") =>
  ({ model, kind, tokens: tokens(t), estimated: false }) satisfies UsageEntry;

/** A card's rates in nUSD per token: input, 5m write, 1h write, cache read, output. */
function row(m: string): number[] {
  const c = CARDS[m];
  return c === undefined ? [] : [c.input, c.write5m, c.write1h, c.cacheRead, c.output];
}

describe("prices", () => {
  test("Opus 5.5: exact integer nano-dollars per token kind", () => {
    // 412 input, 2 930 5-min writes, 14 820 reads, 1 510 output (the design's §5.1 example).
    const c = entryCost(
      entry("claude-opus-5-5", { input: 412, cacheWrite5m: 2930, cacheRead: 14820, output: 1510 }),
    );
    expect(c).toEqual({
      nanoUsd: 412 * 4000 + 2930 * 5000 + 14820 * 200 + 1510 * 20000,
      unpriced: false,
      longPrompt: false,
      card: "anthropic:claude-opus-5-5@2026-10-20",
    });
    expect(c.nanoUsd).toBe(49_462_000);
    expect(entryCost(entry("claude-opus-5-5", { cacheWrite1h: 1000 })).nanoUsd).toBe(8_000_000);
  });

  test("a fallback attempt is priced at its own model", () => {
    const c = costOf([
      entry("claude-opus-5-5", { input: 1000 }),
      entry("claude-opus-5", { input: 1000, output: 100 }, "fallback"),
    ]);
    expect(c.nanoUsd).toBe(1000 * 4000 + 1000 * 5000 + 100 * 25000);
    expect(c.unpriced).toEqual([]);
  });

  test("an unpriced served model is charged at the highest rates and flagged, never zero", () => {
    const c = costOf([entry("claude-mystery-9", { input: 10, output: 10, cacheRead: 10 })]);
    expect(c.unpriced).toEqual(["claude-mystery-9"]);
    expect(c.nanoUsd).toBe(10 * MAX_PRICE.input + 10 * MAX_PRICE.output + 10 * MAX_PRICE.cacheRead);
    expect(MAX_PRICE.output).toBe(25_000);
  });

  test("Haiku 5.5 over 100 K prompt tokens uses the long-prompt card and is flagged", () => {
    const short = entryCost(entry("claude-haiku-5-5", { input: HAIKU_LONG_PROMPT_TOKENS }));
    expect(short).toEqual({
      nanoUsd: 100_000 * 100,
      unpriced: false,
      longPrompt: false,
      card: "anthropic:claude-haiku-5-5@2026-10-20",
    });
    const long = entryCost(
      entry("claude-haiku-5-5", { input: 1, cacheRead: HAIKU_LONG_PROMPT_TOKENS, output: 10 }),
    );
    expect(long).toEqual({
      nanoUsd: 1 * 500 + HAIKU_LONG_PROMPT_TOKENS * 50 + 10 * 2500,
      unpriced: false,
      longPrompt: true,
      card: "anthropic:claude-haiku-5-5@2026-10-20#over100k",
    });
  });

  test("an unknown configured model is refused with a message naming the fix", () => {
    expect(() => requirePrice("claude-opus-9")).toThrow("no price for model claude-opus-9");
    expect(requirePrice("claude-opus-5-5")).toBe(CARDS["claude-opus-5-5"] ?? HAIKU_LONG);
    expect(PRICES).toBe(CARDS);
  });

  test("every price follows the cache multipliers: writes 1.25x and 2x of input", () => {
    for (const [model, p] of Object.entries(PRICES)) {
      expect([model, p.write5m * 4]).toEqual([model, p.input * 5]);
      expect([model, p.write1h]).toEqual([model, p.input * 2]);
    }
  });

  test("costs are exact sums (property)", () => {
    const n = fc.integer({ min: 0, max: 2_000_000 });
    fc.assert(
      fc.property(n, n, n, n, n, (input, w5, w1, read, output) => {
        const one = entry("claude-sonnet-5-5", {
          input,
          cacheWrite5m: w5,
          cacheWrite1h: w1,
          cacheRead: read,
          output,
        });
        const c = entryCost(one).nanoUsd;
        expect(Number.isSafeInteger(c)).toBe(true);
        expect(c).toBe(input * 2000 + w5 * 2500 + w1 * 4000 + read * 100 + output * 10000);
        expect(costOf([one, one]).nanoUsd).toBe(2 * c);
      }),
    );
  });

  test("every card has an id, its source and the date it was checked (phase 4 §2.9)", () => {
    for (const c of [...Object.values(CARDS), HAIKU_LONG]) {
      expect(c.id.startsWith(`anthropic:${c.model}@${ANTHROPIC_CHECKED}`)).toBe(true);
      expect([c.source, c.checked, c.provider]).toEqual([
        ANTHROPIC_PRICING_URL,
        "2026-10-20",
        "anthropic",
      ]);
    }
    expect(new Set([...Object.values(CARDS), HAIKU_LONG].map((c) => c.id)).size).toBe(7);
    // The pricing page, read 2026-10-20 (mUSD per million tokens = nUSD per token).
    expect(row("claude-opus-5-5")).toEqual([4000, 5000, 8000, 200, 20000]);
    expect(row("claude-sonnet-5-5")).toEqual([2000, 2500, 4000, 100, 10000]);
    expect(row("claude-haiku-5-5")).toEqual([100, 125, 200, 10, 500]);
    expect(row("claude-opus-5")).toEqual([5000, 6250, 10000, 500, 25000]);
    expect(row("claude-opus-4-8")).toEqual([5000, 6250, 10000, 500, 25000]);
    expect(row("claude-sonnet-5")).toEqual([2000, 2500, 4000, 200, 10000]);
    expect([
      HAIKU_LONG.input,
      HAIKU_LONG.write5m,
      HAIKU_LONG.write1h,
      HAIKU_LONG.cacheRead,
      HAIKU_LONG.output,
    ]).toEqual([500, 625, 1000, 50, 2500]);
    // Fallback targets are priced; Haiku 5.5 has none; the long-prompt card belongs to Haiku only.
    for (const targets of Object.values(FALLBACK_TARGETS)) {
      for (const t of targets) expect(CARDS[t]).toBeDefined();
    }
    expect(FALLBACK_TARGETS["claude-haiku-5-5"]).toBeUndefined();
    expect(cardsOf("claude-haiku-5-5").map((c) => c.id)).toEqual([
      "anthropic:claude-haiku-5-5@2026-10-20",
      "anthropic:claude-haiku-5-5@2026-10-20#over100k",
    ]);
    expect(cardsOf("claude-sonnet-5-5")).toHaveLength(1);
  });

  test("an unpriced model is charged under the max card's id; costOf lists the cards used", () => {
    const c = costOf([
      entry("claude-mystery-9", { input: 1 }),
      entry("claude-opus-5-5", { input: 1 }),
      entry("claude-mystery-9", { input: 1 }),
    ]);
    expect(c.cards).toEqual([MAX_PRICE_ID, "anthropic:claude-opus-5-5@2026-10-20"]);
  });

  test("cents for the design's tables round half up", () => {
    expect(formatCents(12_594_999_999)).toBe("$12.59");
    expect(formatCents(12_595_000_000)).toBe("$12.60");
    expect(formatCents(4_999_999)).toBe("$0.00");
    expect(formatCents(5_000_000)).toBe("$0.01");
  });

  test("USD amounts convert exactly", () => {
    expect(usdToNano("100")).toBe(100_000_000_000);
    expect(usdToNano("2.5")).toBe(2_500_000_000);
    expect(usdToNano("0.000000001")).toBe(1);
    expect(() => usdToNano("-1")).toThrow("not an amount in USD");
    expect(() => usdToNano("1e3")).toThrow("not an amount in USD");
    expect(formatUsd(49_462_000)).toBe("$0.049462");
    expect(formatUsd(100_012_000_000)).toBe("$100.012000");
  });
});
