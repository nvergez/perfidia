import { promptTokens, type UsageEntry } from "./adapter.ts";

// Prices (phase-2 design §5.2) in integer mUSD per million tokens, so one token costs exactly that
// many nano-dollars and every cost is an integer sum. A $100 cap is 10^11 nUSD, a safe integer.
// Sources: the claude-api skill for Opus 5.5 (all five values), Sonnet 5.5 (input, output, cache
// read) and Haiku 5.5; cache writes elsewhere follow the 1.25x (5 min) / 2x (1 h) rule; the fallback
// targets are marked (verify) in the design and checked against the pricing page before a paid run.

export interface Price {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly write5m: number;
  readonly write1h: number;
}

const price = (
  input: number,
  output: number,
  cacheRead: number,
  write5m: number,
  write1h: number,
): Price => Object.freeze({ input, output, cacheRead, write5m, write1h });

export const PRICES: Readonly<Record<string, Price>> = Object.freeze({
  "claude-opus-5-5": price(4_000, 20_000, 200, 5_000, 8_000),
  "claude-sonnet-5-5": price(2_000, 10_000, 200, 2_500, 4_000),
  "claude-haiku-5-5": price(100, 500, 10, 125, 200),
  "claude-opus-5": price(5_000, 25_000, 500, 6_250, 10_000),
  "claude-opus-4-8": price(5_000, 25_000, 500, 6_250, 10_000),
  "claude-sonnet-5": price(2_000, 10_000, 200, 2_500, 4_000),
});

/** Claude Haiku 5.5 bills prompts over this many tokens at its long-prompt card. */
export const HAIKU_LONG_PROMPT_TOKENS = 100_000;
const HAIKU_LONG = price(500, 2_500, 50, 625, 1_000);

/** Per token kind, the highest price of the table: what an unpriced served model is charged. */
export const MAX_PRICE: Price = (() => {
  const all = [...Object.values(PRICES), HAIKU_LONG];
  const max = (k: keyof Price): number => Math.max(...all.map((p) => p[k]));
  return price(max("input"), max("output"), max("cacheRead"), max("write5m"), max("write1h"));
})();

export const isPriced = (model: string): boolean => Object.hasOwn(PRICES, model);

/** A configured model must be priced: an unknown one is refused at plan time (exit code 3). */
export function requirePrice(model: string): Price {
  const p = Object.hasOwn(PRICES, model) ? PRICES[model] : undefined;
  if (p === undefined) {
    throw new Error(
      `no price for model ${model}: add it to PRICES (packages/orchestrator/src/model/prices.ts) before using it`,
    );
  }
  return p;
}

export interface EntryCost {
  readonly nanoUsd: number;
  /** The served model has no price: charged at `MAX_PRICE`. */
  readonly unpriced: boolean;
  /** A Haiku 5.5 prompt over 100 K tokens, charged at the long-prompt card. */
  readonly longPrompt: boolean;
}

/** The card one usage entry is billed at: its model's, the long-prompt card, or `MAX_PRICE`. */
export function priceFor(e: UsageEntry): {
  readonly price: Price;
  readonly unpriced: boolean;
  readonly longPrompt: boolean;
} {
  const known = Object.hasOwn(PRICES, e.model) ? PRICES[e.model] : undefined;
  const longPrompt =
    e.model === "claude-haiku-5-5" && promptTokens(e.tokens) > HAIKU_LONG_PROMPT_TOKENS;
  return {
    price: longPrompt ? HAIKU_LONG : (known ?? MAX_PRICE),
    unpriced: known === undefined,
    longPrompt,
  };
}

/** The cost of one usage entry, in nano-dollars. Never zero for an unknown model, never a crash. */
export function entryCost(e: UsageEntry): EntryCost {
  const { price: p, unpriced, longPrompt } = priceFor(e);
  const t = e.tokens;
  const nanoUsd =
    t.input * p.input +
    t.output * p.output +
    t.cacheRead * p.cacheRead +
    t.cacheWrite5m * p.write5m +
    t.cacheWrite1h * p.write1h;
  if (!Number.isSafeInteger(nanoUsd) || nanoUsd < 0) {
    throw new Error(`cost of ${e.model} usage is not a safe integer: ${nanoUsd}`);
  }
  return { nanoUsd, unpriced, longPrompt };
}

export interface Cost {
  readonly nanoUsd: number;
  /** Served models without a price (charged at `MAX_PRICE`). */
  readonly unpriced: readonly string[];
  readonly longPrompt: boolean;
}

export function costOf(usage: readonly UsageEntry[]): Cost {
  let nanoUsd = 0;
  const unpriced: string[] = [];
  let longPrompt = false;
  for (const e of usage) {
    const c = entryCost(e);
    nanoUsd += c.nanoUsd;
    if (c.unpriced && !unpriced.includes(e.model)) unpriced.push(e.model);
    longPrompt ||= c.longPrompt;
  }
  return { nanoUsd, unpriced, longPrompt };
}

/** Whole US dollars to nano-dollars (`--cap-usd 100`), exact for decimal inputs up to 9 places. */
export function usdToNano(usd: string): number {
  const m = /^(\d{1,9})(?:\.(\d{1,9}))?$/.exec(usd.trim());
  if (m === null) throw new Error(`not an amount in USD: ${JSON.stringify(usd)} (e.g. 100 or 2.5)`);
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? "").padEnd(9, "0"));
  return whole * 1_000_000_000 + frac;
}

/** Nano-dollars as a USD string with 6 decimals, for reports. */
export function formatUsd(nanoUsd: number): string {
  const sign = nanoUsd < 0 ? "-" : "";
  const abs = Math.abs(nanoUsd);
  const whole = Math.floor(abs / 1_000_000_000);
  const micro = Math.floor((abs % 1_000_000_000) / 1_000);
  return `${sign}$${whole}.${String(micro).padStart(6, "0")}`;
}
