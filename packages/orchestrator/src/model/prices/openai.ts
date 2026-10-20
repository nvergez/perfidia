import { FIRST_READ, cardId, prices, type PriceCard, type Row } from "./card.ts";

// OpenAI cards (Standard tier, global processing), checked 2026-10-20 against each model's page and
// the pricing page's "Standard pricing data" table (fetched as Markdown). Cache writes (30-minute
// TTL) bill 1.25× input and go in the short write bucket; there is no 1-hour bucket, so the long
// one carries the same price. A prompt over 272K input tokens is billed at 2× input and cache rates
// and 1.5× output for the whole request (the long-context card; the 160K prompt cap keeps every
// attempt under it). Regional processing (+10%), Flex, Batch, Fast and Ultrafast are not used.

export const OPENAI_PRICING_URL = "https://developers.openai.com/api/docs/pricing.md";
export const OPENAI_CHECKED = "2026-10-20";
/** The long-context threshold of every GPT-6 card. */
export const OPENAI_LONG_PROMPT_TOKENS = 272_000;

const modelPage = (model: string): string =>
  `https://developers.openai.com/api/docs/models/${model}.md`;

/** `r`: input, output, cached input, cache writes; `long`: the same over 272K tokens. */
function gpt(model: string, r: readonly [string, string, string, string], long: typeof r) {
  const row: Row = [r[0], r[1], r[2], r[3], r[3]];
  const longRow: Row = [long[0], long[1], long[2], long[3], long[3]];
  return Object.freeze({
    id: cardId("openai", model, null, OPENAI_CHECKED),
    provider: "openai",
    model,
    endpoint: null,
    serviceTier: "default",
    region: "global",
    validFrom: FIRST_READ,
    validTo: null,
    ...prices(row),
    longContext: {
      aboveTokens: OPENAI_LONG_PROMPT_TOKENS,
      card: { ...prices(longRow), id: cardId("openai", model, null, OPENAI_CHECKED, "#over272k") },
    },
    overrides: [],
    platformFeePermille: 0,
    cache: "explicit",
    source: `${modelPage(model)} and ${OPENAI_PRICING_URL}`,
    checked: OPENAI_CHECKED,
  } satisfies PriceCard);
}

export const OPENAI_CARDS: readonly PriceCard[] = Object.freeze([
  gpt("gpt-6.1-sol", ["2", "10", "0.10", "2.5"], ["4", "15", "0.20", "5"]),
  gpt("gpt-6-sol", ["2", "10", "0.20", "2.5"], ["4", "15", "0.40", "5"]),
  gpt("gpt-6-luna", ["0.10", "0.50", "0.01", "0.125"], ["0.20", "0.75", "0.02", "0.25"]),
  gpt("gpt-6-astra", ["10", "50", "1", "12.5"], ["20", "75", "2", "25"]),
]);
