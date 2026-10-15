import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { TokenUsage, UsageEntry } from "./adapter.ts";
import {
  HAIKU_LONG_PROMPT_TOKENS,
  MAX_PRICE,
  PRICES,
  costOf,
  entryCost,
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
    expect(short).toEqual({ nanoUsd: 100_000 * 100, unpriced: false, longPrompt: false });
    const long = entryCost(
      entry("claude-haiku-5-5", { input: 1, cacheRead: HAIKU_LONG_PROMPT_TOKENS, output: 10 }),
    );
    expect(long).toEqual({
      nanoUsd: 1 * 500 + HAIKU_LONG_PROMPT_TOKENS * 50 + 10 * 2500,
      unpriced: false,
      longPrompt: true,
    });
  });

  test("an unknown configured model is refused with a message naming the fix", () => {
    expect(() => requirePrice("claude-opus-9")).toThrow("no price for model claude-opus-9");
    expect(requirePrice("claude-opus-5-5")).toBe(PRICES["claude-opus-5-5"] ?? MAX_PRICE);
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
        expect(c).toBe(input * 2000 + w5 * 2500 + w1 * 4000 + read * 200 + output * 10000);
        expect(costOf([one, one]).nanoUsd).toBe(2 * c);
      }),
    );
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
