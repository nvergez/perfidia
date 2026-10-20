import { promptTokens, type UsageEntry } from "./adapter.ts";

// Prices (phase-2 design §5.2; phase-4 design §2.9) in integer mUSD per million tokens, so one token
// costs exactly that many nano-dollars and every cost is an integer sum. A $100 cap is 10^11 nUSD, a
// safe integer. Every card has an id (logged on `preflight` lines and in `estimate.json`), its
// source and the date it was checked against that source. Phase 4 (Pass 1a) checked every Claude
// card against Anthropic's pricing page on 2026-10-20: Claude Sonnet 5.5's cache hits are $0.10 per
// million tokens (0.05× input; phase 2 had $0.20 from the claude-api skill's cached table). Pass 1b
// moves the cards to pico-dollars with validity windows for the other providers.

export interface Price {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly write5m: number;
  readonly write1h: number;
}

/** A price with where it comes from (phase 4 §2.9; Pass 1b adds endpoints and validity windows). */
export interface PriceCard extends Price {
  /** `provider:model@checked`, plus `#over100k` for Claude Haiku 5.5's long-prompt card. */
  readonly id: string;
  readonly provider: "anthropic";
  readonly model: string;
  readonly source: string;
  /** The UTC date the card was checked against its source. */
  readonly checked: string;
}

/** Anthropic's pricing page, the source of every Claude card (fetched as Markdown). */
export const ANTHROPIC_PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing.md";
/** The date the Claude cards were last checked against `ANTHROPIC_PRICING_URL`. */
export const ANTHROPIC_CHECKED = "2026-10-20";

const card = (
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  write5m: number,
  write1h: number,
  suffix = "",
): PriceCard =>
  Object.freeze({
    id: `anthropic:${model}@${ANTHROPIC_CHECKED}${suffix}`,
    provider: "anthropic",
    model,
    input,
    output,
    cacheRead,
    write5m,
    write1h,
    source: ANTHROPIC_PRICING_URL,
    checked: ANTHROPIC_CHECKED,
  });

/** The cards by model: the 5.5 seat models, then the fallback targets (Opus 5, Opus 4.8, Sonnet 5). */
export const CARDS: Readonly<Record<string, PriceCard>> = Object.freeze({
  "claude-opus-5-5": card("claude-opus-5-5", 4_000, 20_000, 200, 5_000, 8_000),
  "claude-sonnet-5-5": card("claude-sonnet-5-5", 2_000, 10_000, 100, 2_500, 4_000),
  "claude-haiku-5-5": card("claude-haiku-5-5", 100, 500, 10, 125, 200),
  "claude-opus-5": card("claude-opus-5", 5_000, 25_000, 500, 6_250, 10_000),
  "claude-opus-4-8": card("claude-opus-4-8", 5_000, 25_000, 500, 6_250, 10_000),
  "claude-sonnet-5": card("claude-sonnet-5", 2_000, 10_000, 200, 2_500, 4_000),
});

/** The price table by model (the cards without their provenance). */
export const PRICES: Readonly<Record<string, Price>> = CARDS;

/** Claude Haiku 5.5 bills prompts over this many tokens at its long-prompt card. */
export const HAIKU_LONG_PROMPT_TOKENS = 100_000;
/** Claude Haiku 5.5 for prompts over 100,000 tokens (all input tokens count, cache reads included). */
export const HAIKU_LONG: PriceCard = card(
  "claude-haiku-5-5",
  500,
  2_500,
  50,
  625,
  1_000,
  "#over100k",
);

/** The id of `MAX_PRICE`, what an unpriced served model is charged at. */
export const MAX_PRICE_ID = "max";

/** Per token kind, the highest price of the table: what an unpriced served model is charged. */
export const MAX_PRICE: Price = (() => {
  const all = [...Object.values(CARDS), HAIKU_LONG];
  const max = (k: keyof Price): number => Math.max(...all.map((p) => p[k]));
  return Object.freeze({
    input: max("input"),
    output: max("output"),
    cacheRead: max("cacheRead"),
    write5m: max("write5m"),
    write1h: max("write1h"),
  });
})();

/**
 * The models Anthropic's server-side refusal fallback may run an attempt of a seat model on (the
 * claude-api skill and the models' `allowed_fallback_models`): Claude Opus 5.5 → Claude Opus 5 or
 * Claude Opus 4.8; Claude Sonnet 5.5 → Claude Sonnet 5 (`cyber`, `frontier_llm`); Claude Haiku 5.5
 * has none. The attempt bound counts one iteration per target; the preflight refuses a model whose
 * `allowed_fallback_models` holds anything else while its fallbacks are on.
 */
export const FALLBACK_TARGETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "claude-opus-5-5": Object.freeze(["claude-opus-5", "claude-opus-4-8"]),
  "claude-sonnet-5-5": Object.freeze(["claude-sonnet-5"]),
});

export const isPriced = (model: string): boolean => Object.hasOwn(CARDS, model);

/** A configured model must be priced: an unknown one is refused at plan time (exit code 3). */
export function requirePrice(model: string): PriceCard {
  const p = Object.hasOwn(CARDS, model) ? CARDS[model] : undefined;
  if (p === undefined) {
    throw new Error(
      `no price for model ${model}: add it to CARDS (packages/orchestrator/src/model/prices.ts) before using it`,
    );
  }
  return p;
}

/** Every card an attempt on `model` can be billed at without a fallback (its long-prompt card too). */
export function cardsOf(model: string): PriceCard[] {
  const own = requirePrice(model);
  return model === "claude-haiku-5-5" ? [own, HAIKU_LONG] : [own];
}

export interface EntryCost {
  readonly nanoUsd: number;
  /** The served model has no price: charged at `MAX_PRICE`. */
  readonly unpriced: boolean;
  /** A Haiku 5.5 prompt over 100 K tokens, charged at the long-prompt card. */
  readonly longPrompt: boolean;
  /** The card's id (`MAX_PRICE_ID` for an unpriced model). */
  readonly card: string;
}

/** The card one usage entry is billed at: its model's, the long-prompt card, or `MAX_PRICE`. */
export function priceFor(e: UsageEntry): {
  readonly price: Price;
  readonly unpriced: boolean;
  readonly longPrompt: boolean;
  readonly card: string;
} {
  const known = Object.hasOwn(CARDS, e.model) ? CARDS[e.model] : undefined;
  const longPrompt =
    e.model === "claude-haiku-5-5" && promptTokens(e.tokens) > HAIKU_LONG_PROMPT_TOKENS;
  const price = longPrompt ? HAIKU_LONG : (known ?? MAX_PRICE);
  return {
    price,
    unpriced: known === undefined,
    longPrompt,
    card: longPrompt ? HAIKU_LONG.id : (known?.id ?? MAX_PRICE_ID),
  };
}

/** The cost of one usage entry, in nano-dollars. Never zero for an unknown model, never a crash. */
export function entryCost(e: UsageEntry): EntryCost {
  const { price: p, unpriced, longPrompt, card: id } = priceFor(e);
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
  return { nanoUsd, unpriced, longPrompt, card: id };
}

export interface Cost {
  readonly nanoUsd: number;
  /** Served models without a price (charged at `MAX_PRICE`). */
  readonly unpriced: readonly string[];
  readonly longPrompt: boolean;
  /** The cards charged, in order of first use. */
  readonly cards: readonly string[];
}

export function costOf(usage: readonly UsageEntry[]): Cost {
  let nanoUsd = 0;
  const unpriced: string[] = [];
  const cards: string[] = [];
  let longPrompt = false;
  for (const e of usage) {
    const c = entryCost(e);
    nanoUsd += c.nanoUsd;
    if (c.unpriced && !unpriced.includes(e.model)) unpriced.push(e.model);
    if (!cards.includes(c.card)) cards.push(c.card);
    longPrompt ||= c.longPrompt;
  }
  return { nanoUsd, unpriced, longPrompt, cards };
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

/** Nano-dollars as whole cents ("$12.59"), rounded half up: the design's tables. */
export function formatCents(nanoUsd: number): string {
  const cents = Math.round(nanoUsd / 10_000_000);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
