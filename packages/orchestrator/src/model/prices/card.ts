// The shape of a price card (phase-4 design §2.9, Pass 1b): what one (provider, model, endpoint,
// service tier, region) bills per token, in integer pico-dollars (1 pUSD = 10⁻¹² USD, so $1 per
// million tokens is 1 000 000 pUSD per token and sub-nano prices stay exact), during a UTC window,
// with its long-context tier, OpenRouter's time-of-day overrides, the platform fee, its source and
// the date it was checked against that source. Cards are pure data: `model/prices.ts` selects them
// and prices usage.

/** Per-token prices in integer pico-dollars. */
export interface PicoPrices {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  /** The short-TTL write bucket (Anthropic 5 minutes, OpenAI's 30-minute writes). */
  readonly write5m: number;
  /** The long-TTL write bucket (Anthropic 1 hour); the short price where there is none. */
  readonly write1h: number;
}

/** A time-of-day price override (OpenRouter `pricing.overrides`): `HHMM` UTC bounds, end exclusive. */
export interface PriceOverride {
  readonly utcStart: number;
  readonly utcEnd: number;
  /** Lower-case English day names; absent: every day. */
  readonly days?: readonly string[];
  readonly prices: Partial<PicoPrices>;
}

export interface PriceCard extends PicoPrices {
  /** `provider:model[(endpoint)]@checked[#window or tier]`, logged on every line it priced. */
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  /** The routing endpoint (OpenRouter's full slug); null for direct providers. */
  readonly endpoint: string | null;
  readonly serviceTier: "default";
  /** OpenAI's regional processing adds 10%; every card here is `global`. */
  readonly region: "global" | "eu" | "us";
  /** UTC instant from which the card applies (inclusive). */
  readonly validFrom: string;
  /** UTC instant at which it stops applying (exclusive); null: open. */
  readonly validTo: string | null;
  /**
   * The source dates the change without a timezone (phase-4 review): the card applies from the
   * earliest instant the date can mean (`validFrom`, the conservative side, which the ledger and
   * the bounds use), and until this instant (the latest one it can mean) the provider may still
   * bill the card before it. `arena reconcile` counts that difference as conservative excess.
   */
  readonly uncertainUntil?: string;
  /** Prompt-length pricing: a request whose prompt is over `aboveTokens` pays `card` throughout. */
  readonly longContext: {
    readonly aboveTokens: number;
    readonly card: PicoPrices & { readonly id: string };
  } | null;
  /** Charged at their highest price per kind (an upper bound), reconciled with `usage.cost`. */
  readonly overrides: readonly PriceOverride[];
  /** A platform fee on top of the token cost, in permille (OpenRouter's 5.5% on credits: 55). */
  readonly platformFeePermille: number;
  /**
   * Inference geographies other than the global default and their multiplier on every price kind,
   * in permille (Anthropic's US-only inference: `{ us: 1100 }`). An attempt whose usage reports one
   * of them is charged at the scaled prices; attempt bounds take the scaled prices too. A reported
   * geography a card does not list is charged at `MAX_CARD`. Absent: none.
   */
  readonly geo?: Readonly<Record<string, number>>;
  /** `explicit`: writes priced as marked; `implicit`: no write premium, hits not guaranteed. */
  readonly cache: "explicit" | "implicit";
  /** The page the prices were read from. */
  readonly source: string;
  /** The UTC date the card was last checked against `source`. */
  readonly checked: string;
}

/**
 * USD per million tokens, written as the source writes it ("0.075"), as integer pico-dollars per
 * token: exact for up to six decimals.
 */
export function perMTok(usd: string): number {
  const m = /^(\d{1,6})(?:\.(\d{1,6}))?$/.exec(usd);
  if (m === null) throw new Error(`not a price in USD per million tokens: ${JSON.stringify(usd)}`);
  return Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0"));
}

/** The day every card without a dated window applies from: when the design read its sources. */
export const FIRST_READ = "2026-10-19T00:00:00Z";

/** Prices as the sources print them: input, output, cache read, short write, long write ($/MTok). */
export type Row = readonly [string, string, string, string, string];

export function prices(r: Row): PicoPrices {
  return {
    input: perMTok(r[0]),
    output: perMTok(r[1]),
    cacheRead: perMTok(r[2]),
    write5m: perMTok(r[3]),
    write1h: perMTok(r[4]),
  };
}

/** Prices scaled by `permille` (a geography's multiplier), each rounded up. */
export function scalePrices(p: PicoPrices, permille: number): PicoPrices {
  const k = (v: number): number => Math.ceil((v * permille) / 1000);
  return {
    input: k(p.input),
    output: k(p.output),
    cacheRead: k(p.cacheRead),
    write5m: k(p.write5m),
    write1h: k(p.write1h),
  };
}

/** The card id: `provider:model[(endpoint)]@checked[#suffix]`. */
export function cardId(
  provider: string,
  model: string,
  endpoint: string | null,
  checked: string,
  suffix = "",
): string {
  return `${provider}:${model}${endpoint === null ? "" : `(${endpoint})`}@${checked}${suffix}`;
}
