import { FIRST_READ, cardId, prices, type PriceCard } from "./card.ts";

// OpenRouter cards, one per pinned endpoint (the full slug, so routing cannot change the model or
// its price), checked 2026-10-20 against the public endpoints JSON of each model
// (`pricing.prompt`, `completion`, `input_cache_read`; none of these endpoints lists
// `input_cache_write` or time-of-day `overrides`). Caching is implicit on all of them: no write
// premium, writes are billed as input. OpenRouter charges 5.5% when credits are bought (the FAQ):
// the ledger charges it on top of every line and reports it apart (`feeNanoUsd`); reconciliation
// compares amounts without it.

export const OPENROUTER_CHECKED = "2026-10-20";
/** OpenRouter's fee on credit purchases, in permille (the FAQ: "5.5% ($0.80 minimum)"). */
export const OPENROUTER_FEE_PERMILLE = 55;
export const OPENROUTER_FEE_SOURCE = "https://openrouter.ai/docs/faq.md";

const endpointsUrl = (model: string): string =>
  `https://openrouter.ai/api/v1/models/${model}/endpoints`;

/** `r`: prompt, completion, input cache read, in USD per million tokens. */
function routed(model: string, endpoint: string, r: readonly [string, string, string]): PriceCard {
  return Object.freeze({
    id: cardId("openrouter", model, endpoint, OPENROUTER_CHECKED),
    provider: "openrouter",
    model,
    endpoint,
    serviceTier: "default",
    region: "global",
    validFrom: FIRST_READ,
    validTo: null,
    ...prices([r[0], r[1], r[2], r[0], r[0]]),
    longContext: null,
    overrides: [],
    platformFeePermille: OPENROUTER_FEE_PERMILLE,
    cache: "implicit",
    source: `${endpointsUrl(model)} (fee: ${OPENROUTER_FEE_SOURCE})`,
    checked: OPENROUTER_CHECKED,
  });
}

export const OPENROUTER_CARDS: readonly PriceCard[] = Object.freeze([
  routed("z-ai/glm-5.3", "z-ai/fp8", ["1.40", "4.40", "0.26"]),
  routed("z-ai/glm-5.3-flash", "z-ai/fp8", ["0.15", "0.50", "0.03"]),
  routed("moonshotai/kimi-k3", "moonshotai/mxfp4", ["3", "15", "0.30"]),
  routed("deepseek/deepseek-v4.1-flash-1017", "together", ["0.30", "1.20", "0.006"]),
]);
