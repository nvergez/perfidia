import { promptTokens, type UsageEntry } from "./adapter.ts";
import { FALLBACK_TARGETS, modelInfo } from "./catalog.ts";
import { ANTHROPIC_CARDS, HAIKU_LONG_PROMPT_TOKENS } from "./prices/anthropic.ts";
import type { PicoPrices, PriceCard } from "./prices/card.ts";
import { GOOGLE_CARDS } from "./prices/google.ts";
import { OPENAI_CARDS } from "./prices/openai.ts";
import { OPENROUTER_CARDS } from "./prices/openrouter.ts";

// Prices (phase-2 design §5.2; phase-4 design §2.9). The cards (`model/prices/<provider>.ts`) are
// integer pico-dollars per token, keyed by provider, model, endpoint, service tier and region, with
// UTC validity windows, long-context tiers, time-of-day overrides and platform fees; each has an id,
// its source and the date it was checked. An attempt is priced at the card valid at its wall-clock
// start (`PriceContext.at`; a `--fake` run pins one date so it stays byte-identical): each usage
// entry costs Σ tokens × pUSD, rounded UP to whole nano-dollars (the ledger never undercounts), plus
// the card's platform fee, also rounded up. An unpriced model is charged at the highest price of
// every card (`MAX_CARD`). The match budget, logs and reports stay in integer nano-dollars.
//
// Phase 2 and Pass 1a's API stays: `costOf(usage)` without a context prices Claude usage at the
// Anthropic cards, and `CARDS`, `PRICES`, `HAIKU_LONG` and `MAX_PRICE` are the nano-dollar views
// (whole nano-dollars per token: mUSD per million tokens).

export type { PicoPrices, PriceCard } from "./prices/card.ts";
export { ANTHROPIC_CHECKED, ANTHROPIC_PRICING_URL } from "./prices/anthropic.ts";
export { FALLBACK_TARGETS, HAIKU_LONG_PROMPT_TOKENS };

/** Every card of this build, all providers. */
export const ALL_CARDS: readonly PriceCard[] = Object.freeze([
  ...ANTHROPIC_CARDS,
  ...OPENAI_CARDS,
  ...GOOGLE_CARDS,
  ...OPENROUTER_CARDS,
]);

/** Where an attempt is billed: the provider, the pinned endpoint, and when (a UTC instant). */
export interface PriceContext {
  readonly provider: string;
  readonly endpoint: string | null;
  /** ISO 8601 UTC instant: the attempt's wall-clock start, or the run's pinned price date. */
  readonly at: string;
}

/** The instant the legacy, context-free API prices at (every Claude card is valid then). */
export const LEGACY_AT = "2026-10-20T00:00:00Z";
/** Phase 2's pricing: Anthropic, no endpoint. */
export const ANTHROPIC_CONTEXT: PriceContext = Object.freeze({
  provider: "anthropic",
  endpoint: null,
  at: LEGACY_AT,
});

const ms = (iso: string): number => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`not a UTC instant: ${JSON.stringify(iso)}`);
  return t;
};

/** The card valid for (provider, model, endpoint) at `at`, or null. */
export function cardAt(
  provider: string,
  model: string,
  endpoint: string | null,
  at: string,
): PriceCard | null {
  const t = ms(at);
  for (const c of ALL_CARDS) {
    if (c.provider !== provider || c.model !== model || c.endpoint !== endpoint) continue;
    if (ms(c.validFrom) <= t && (c.validTo === null || t < ms(c.validTo))) return c;
  }
  return null;
}

/** Every card of (provider, model, endpoint) valid at `from` or later: what a run can be billed. */
export function cardsFrom(
  provider: string,
  model: string,
  endpoint: string | null,
  from: string,
): PriceCard[] {
  const t = ms(from);
  return ALL_CARDS.filter(
    (c) =>
      c.provider === provider &&
      c.model === model &&
      c.endpoint === endpoint &&
      (c.validTo === null || t < ms(c.validTo)),
  );
}

/** A card by its id (a logged `priceCard`), long-context tiers included; null when unknown. */
export function cardById(id: string): (PicoPrices & { readonly id: string }) | null {
  for (const c of ALL_CARDS) {
    if (c.id === id) return c;
    if (c.longContext?.card.id === id) return c.longContext.card;
  }
  return null;
}

/** Per kind, the highest of the card's own price and its overrides' (an upper bound). */
export function effectivePrices(c: PicoPrices & { readonly overrides?: PriceCard["overrides"] }) {
  const out = {
    input: c.input,
    output: c.output,
    cacheRead: c.cacheRead,
    write5m: c.write5m,
    write1h: c.write1h,
  };
  for (const o of c.overrides ?? []) {
    for (const k of ["input", "output", "cacheRead", "write5m", "write1h"] as const) {
      const v = o.prices[k];
      if (v !== undefined && v > out[k]) out[k] = v;
    }
  }
  return out;
}

/** The id of `MAX_CARD`, what an unpriced served model is charged at. */
export const MAX_PRICE_ID = "max";

/** Per token kind, the highest price of every card and tier: an unpriced model's charge. */
export const MAX_CARD: PicoPrices = (() => {
  const all: PicoPrices[] = [];
  for (const c of ALL_CARDS) {
    all.push(effectivePrices(c));
    if (c.longContext !== null) all.push(c.longContext.card);
  }
  const max = (k: keyof PicoPrices): number => Math.max(...all.map((p) => p[k]));
  return Object.freeze({
    input: max("input"),
    output: max("output"),
    cacheRead: max("cacheRead"),
    write5m: max("write5m"),
    write1h: max("write1h"),
  });
})();

const ceilDiv = (n: number, d: number): number => Math.ceil(n / d);

/** Pico-dollars to nano-dollars, rounded up. */
export const picoToNano = (pico: number): number => ceilDiv(pico, 1000);

/** The fee on `nanoUsd` at `permille`, rounded up. */
export const feeOf = (nanoUsd: number, permille: number): number =>
  permille === 0 ? 0 : ceilDiv(nanoUsd * permille, 1000);

export interface EntryCost {
  /** Token cost plus the platform fee, in nano-dollars (each rounded up). */
  readonly nanoUsd: number;
  /** The platform fee part of `nanoUsd`. */
  readonly feeNanoUsd: number;
  /** The served model has no card for the context: charged at `MAX_CARD`. */
  readonly unpriced: boolean;
  /** Priced at the card's long-context tier (a prompt over its threshold). */
  readonly longPrompt: boolean;
  /** The card's id (`MAX_PRICE_ID` for an unpriced model). */
  readonly card: string;
}

/** The card one usage entry is billed at in `ctx`: its model's, its long-context tier, or the max. */
export function priceOf(
  e: UsageEntry,
  ctx: PriceContext,
): {
  readonly prices: PicoPrices;
  readonly feePermille: number;
  readonly unpriced: boolean;
  readonly longPrompt: boolean;
  readonly card: string;
} {
  const own = cardAt(ctx.provider, e.model, ctx.endpoint, ctx.at);
  if (own === null) {
    return {
      prices: MAX_CARD,
      feePermille: 0,
      unpriced: true,
      longPrompt: false,
      card: MAX_PRICE_ID,
    };
  }
  const long = own.longContext;
  const longPrompt = long !== null && promptTokens(e.tokens) > long.aboveTokens;
  return {
    prices: longPrompt && long !== null ? long.card : effectivePrices(own),
    feePermille: own.platformFeePermille,
    unpriced: false,
    longPrompt,
    card: longPrompt && long !== null ? long.card.id : own.id,
  };
}

/** The pico-dollar cost of `tokens` at `p`, per kind. */
export function picoByKind(e: UsageEntry, p: PicoPrices) {
  const t = e.tokens;
  return {
    input: t.input * p.input,
    cacheWrite5m: t.cacheWrite5m * p.write5m,
    cacheWrite1h: t.cacheWrite1h * p.write1h,
    cacheRead: t.cacheRead * p.cacheRead,
    output: t.output * p.output,
  };
}

/** The cost of one usage entry in `ctx` (default: Anthropic), in nano-dollars. Never a crash. */
export function entryCost(e: UsageEntry, ctx: PriceContext = ANTHROPIC_CONTEXT): EntryCost {
  const sel = priceOf(e, ctx);
  const k = picoByKind(e, sel.prices);
  const pico = k.input + k.cacheWrite5m + k.cacheWrite1h + k.cacheRead + k.output;
  if (!Number.isSafeInteger(pico) || pico < 0) {
    throw new Error(`cost of ${e.model} usage is not a safe integer: ${pico}`);
  }
  const tokens = picoToNano(pico);
  const fee = feeOf(tokens, sel.feePermille);
  return {
    nanoUsd: tokens + fee,
    feeNanoUsd: fee,
    unpriced: sel.unpriced,
    longPrompt: sel.longPrompt,
    card: sel.card,
  };
}

export interface Cost {
  readonly nanoUsd: number;
  /** The platform fee part of `nanoUsd`. */
  readonly feeNanoUsd: number;
  /** Served models without a price (charged at `MAX_CARD`). */
  readonly unpriced: readonly string[];
  readonly longPrompt: boolean;
  /** The cards charged, in order of first use. */
  readonly cards: readonly string[];
}

/** The cost of an attempt's usage entries in `ctx` (default: Anthropic, phase 2's pricing). */
export function costOf(usage: readonly UsageEntry[], ctx: PriceContext = ANTHROPIC_CONTEXT): Cost {
  let nanoUsd = 0;
  let feeNanoUsd = 0;
  const unpriced: string[] = [];
  const cards: string[] = [];
  let longPrompt = false;
  for (const e of usage) {
    const c = entryCost(e, ctx);
    nanoUsd += c.nanoUsd;
    feeNanoUsd += c.feeNanoUsd;
    if (c.unpriced && !unpriced.includes(e.model)) unpriced.push(e.model);
    if (!cards.includes(c.card)) cards.push(c.card);
    longPrompt ||= c.longPrompt;
  }
  return { nanoUsd, feeNanoUsd, unpriced, longPrompt, cards };
}

/** Prices one attempt's usage at its wall-clock start (or the run's pinned date). */
export type Pricer = (usage: readonly UsageEntry[], at: string | undefined) => Cost;

/**
 * The pricer of a seat billed by `provider` (at `endpoint`): `fixedAt` pins every attempt to one
 * instant (`--price-date`, `--fake` runs); otherwise each attempt is priced at its wall start, or
 * at `fallbackAt` when it has none.
 */
export function pricerFor(o: {
  readonly provider: string;
  readonly endpoint: string | null;
  readonly fixedAt: string | null;
  readonly fallbackAt: string;
}): Pricer {
  return (usage, at) =>
    costOf(usage, {
      provider: o.provider,
      endpoint: o.endpoint,
      at: o.fixedAt ?? at ?? o.fallbackAt,
    });
}

// The nano-dollar views of phase 2 and Pass 1a (Claude only) -------------------------------------

/** Per-token prices in whole nano-dollars (mUSD per million tokens). */
export interface Price {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly write5m: number;
  readonly write1h: number;
}

/** A Claude card in nano-dollars, with its provenance. */
export interface NanoCard extends Price {
  readonly id: string;
  readonly provider: "anthropic";
  readonly model: string;
  readonly source: string;
  readonly checked: string;
}

/** A whole nano-dollar price from pico-dollars (every Claude price is one). */
const wholeNano = (v: number): number => {
  if (v % 1000 !== 0) throw new Error(`a Claude price is not whole nano-dollars: ${v} pUSD`);
  return v / 1000;
};

const nanoOf = (p: PicoPrices): Price => {
  const n = wholeNano;
  return {
    input: n(p.input),
    output: n(p.output),
    cacheRead: n(p.cacheRead),
    write5m: n(p.write5m),
    write1h: n(p.write1h),
  };
};

/** The Claude cards by model, in nano-dollars (the 5.5 family, Fable 5.1, the fallback targets). */
export const CARDS: Readonly<Record<string, NanoCard>> = Object.freeze(
  Object.fromEntries(
    ANTHROPIC_CARDS.map((c) => [
      c.model,
      Object.freeze({
        ...nanoOf(c),
        id: c.id,
        provider: "anthropic" as const,
        model: c.model,
        source: c.source,
        checked: c.checked,
      }),
    ]),
  ),
);

/** The Claude price table by model (the cards without their provenance). */
export const PRICES: Readonly<Record<string, Price>> = CARDS;

/** Claude Haiku 5.5 for prompts over 100,000 tokens, in nano-dollars. */
export const HAIKU_LONG: NanoCard = (() => {
  const haiku = ANTHROPIC_CARDS.find((c) => c.model === "claude-haiku-5-5");
  const long = haiku?.longContext;
  if (haiku === undefined || long === null || long === undefined) {
    throw new Error("no Claude Haiku 5.5 long-prompt card");
  }
  return Object.freeze({
    ...nanoOf(long.card),
    id: long.card.id,
    provider: "anthropic" as const,
    model: haiku.model,
    source: haiku.source,
    checked: haiku.checked,
  });
})();

/** `MAX_CARD` in nano-dollars, rounded up. */
export const MAX_PRICE: Price = Object.freeze({
  input: picoToNano(MAX_CARD.input),
  output: picoToNano(MAX_CARD.output),
  cacheRead: picoToNano(MAX_CARD.cacheRead),
  write5m: picoToNano(MAX_CARD.write5m),
  write1h: picoToNano(MAX_CARD.write1h),
});

/** A Claude model has a card. */
export const isPriced = (model: string): boolean => Object.hasOwn(CARDS, model);

/** A configured Claude model must be priced: an unknown one is refused at plan time (exit 3). */
export function requirePrice(model: string): NanoCard {
  const p = Object.hasOwn(CARDS, model) ? CARDS[model] : undefined;
  if (p === undefined) {
    throw new Error(
      `no price for model ${model}: add it to packages/orchestrator/src/model/prices/anthropic.ts before using it`,
    );
  }
  return p;
}

/** A card or a long-context tier, at its highest prices: what an attempt can be billed at. */
export type BillableCard = PicoPrices & { readonly id: string };

/**
 * Every card and tier an attempt can be billed at: each card at its highest override, and its
 * long-context tier when a prompt of up to `promptCap` tokens can exceed its threshold.
 */
export function billable(
  cards: readonly PriceCard[],
  promptCap: number = Number.POSITIVE_INFINITY,
): BillableCard[] {
  const out: BillableCard[] = [];
  for (const c of cards) {
    out.push({ ...effectivePrices(c), id: c.id });
    if (c.longContext !== null && promptCap > c.longContext.aboveTokens)
      out.push(c.longContext.card);
  }
  return out;
}

/** Every Claude card and tier an attempt on `model` can be billed at, without a fallback (pUSD). */
export function cardsOf(model: string): BillableCard[] {
  const own = ANTHROPIC_CARDS.filter((c) => c.model === model);
  if (own.length === 0) requirePrice(model);
  return billable(own);
}

/** The card a Claude usage entry is billed at, in nano-dollars (phase 2's view). */
export function priceFor(e: UsageEntry): {
  readonly price: Price;
  readonly unpriced: boolean;
  readonly longPrompt: boolean;
  readonly card: string;
} {
  const sel = priceOf(e, ANTHROPIC_CONTEXT);
  const price = sel.unpriced ? MAX_PRICE : nanoOf(sel.prices);
  return { price, unpriced: sel.unpriced, longPrompt: sel.longPrompt, card: sel.card };
}

/** Whether `model` (of `provider`) has server-side fallbacks planned by this build. */
export function fallbackTargetsOf(provider: string, model: string): readonly string[] {
  return modelInfo(provider, model)?.fallbackTargets ?? [];
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
