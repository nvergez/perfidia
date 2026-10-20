import { FIRST_READ, cardId, prices, type PriceCard, type Row } from "./card.ts";

// OpenAI cards (Standard tier, global processing), checked 2026-10-20 against each model's page and
// the pricing page's "Standard pricing data" table (fetched as Markdown). Cache writes bill 1.25×
// input for the default 30-minute lifetime (the short write bucket) and 2.5× input for the 12-hour
// one (the long bucket: the pricing page's "Short context 12h write" and "Long context 12h write"
// columns, and the prompt-caching guide's `cache_write_tokens_details.ttl_12h_tokens`, both re-read
// 2026-10-20 after the Pass 2 review). The adapter asks for 30-minute writes only; a 12-hour write
// it is billed anyway is priced at its own rate, and the attempt bound covers it. A prompt over
// 272K input tokens is billed at 2× input and cache rates and 1.5× output for the whole request
// (the long-context card; the 160K prompt cap keeps every attempt under it). Regional processing
// (+10%), Flex, Batch, Fast and Ultrafast are not used.

export const OPENAI_PRICING_URL = "https://developers.openai.com/api/docs/pricing.md";
export const OPENAI_CHECKED = "2026-10-20";
/** The long-context threshold of every GPT-6 card. */
export const OPENAI_LONG_PROMPT_TOKENS = 272_000;

const modelPage = (model: string): string =>
  `https://developers.openai.com/api/docs/models/${model}.md`;

/** `r`: input, output, cached input, 30-minute and 12-hour writes; `long`: the same over 272K. */
function gpt(model: string, r: Row, long: Row) {
  const row: Row = r;
  const longRow: Row = long;
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
  gpt("gpt-6.1-sol", ["2", "10", "0.10", "2.5", "5"], ["4", "15", "0.20", "5", "10"]),
  gpt("gpt-6-sol", ["2", "10", "0.20", "2.5", "5"], ["4", "15", "0.40", "5", "10"]),
  gpt(
    "gpt-6-luna",
    ["0.10", "0.50", "0.01", "0.125", "0.25"],
    ["0.20", "0.75", "0.02", "0.25", "0.50"],
  ),
  gpt("gpt-6-astra", ["10", "50", "1", "12.5", "25"], ["20", "75", "2", "25", "50"]),
]);
