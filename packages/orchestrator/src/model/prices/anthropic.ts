import { FIRST_READ, cardId, prices, type PriceCard, type Row } from "./card.ts";

// Claude cards (Anthropic's pricing page, read as Markdown). Phase 4 Pass 1a checked the 5.5 family
// and the fallback targets on 2026-10-20 (Claude Sonnet 5.5's cache hits are $0.10 per million
// tokens, 0.05× input; the design had $0.20 from the claude-api skill's cached table); Pass 1b adds
// Claude Fable 5.1 (the `frontier` preset; cache hits 0.025× input) from the same page, same day.
// Columns: base input, output, cache hits, 5-minute writes (1.25×), 1-hour writes (2×). Claude Haiku
// 5.5 bills a prompt over 100 000 tokens (cache reads and writes included) at its long-prompt card.
// Data residency (the same page, "Data residency pricing", checked 2026-10-20): for Claude 4.6 and
// later models, every card here, US-only inference (`inference_geo: "us"`, also a workspace's
// `default_inference_geo` when a request omits it) bills 1.1× on every token kind, Haiku 5.5's long
// tier included; global routing (the default) bills the card. `usage.inference_geo` says which.

/** Anthropic's pricing page, the source of every Claude card (fetched as Markdown). */
export const ANTHROPIC_PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing.md";
/** The date the Claude cards were last checked against `ANTHROPIC_PRICING_URL`. */
export const ANTHROPIC_CHECKED = "2026-10-20";

/** US-only inference on Claude 4.6 and later: 1.1× every price (pricing page, data residency). */
export const ANTHROPIC_GEO: Readonly<Record<string, number>> = Object.freeze({ us: 1100 });

/** Claude Haiku 5.5 bills prompts over this many tokens at its long-prompt card. */
export const HAIKU_LONG_PROMPT_TOKENS = 100_000;

function claude(model: string, r: Row, long: Row | null = null): PriceCard {
  return Object.freeze({
    id: cardId("anthropic", model, null, ANTHROPIC_CHECKED),
    provider: "anthropic",
    model,
    endpoint: null,
    serviceTier: "default",
    region: "global",
    validFrom: FIRST_READ,
    validTo: null,
    ...prices(r),
    longContext:
      long === null
        ? null
        : {
            aboveTokens: HAIKU_LONG_PROMPT_TOKENS,
            card: {
              ...prices(long),
              id: cardId("anthropic", model, null, ANTHROPIC_CHECKED, "#over100k"),
            },
          },
    overrides: [],
    platformFeePermille: 0,
    geo: ANTHROPIC_GEO,
    cache: "explicit",
    source: ANTHROPIC_PRICING_URL,
    checked: ANTHROPIC_CHECKED,
  });
}

/** The seat models first (Claude 5.5 and Fable 5.1), then the fallback targets. */
export const ANTHROPIC_CARDS: readonly PriceCard[] = Object.freeze([
  claude("claude-fable-5-1", ["10", "50", "0.25", "12.5", "20"]),
  claude("claude-opus-5-5", ["4", "20", "0.20", "5", "8"]),
  claude("claude-sonnet-5-5", ["2", "10", "0.10", "2.5", "4"]),
  claude(
    "claude-haiku-5-5",
    ["0.10", "0.50", "0.01", "0.125", "0.20"],
    ["0.50", "2.50", "0.05", "0.625", "1"],
  ),
  claude("claude-opus-5", ["5", "25", "0.50", "6.25", "10"]),
  claude("claude-opus-4-8", ["5", "25", "0.50", "6.25", "10"]),
  claude("claude-sonnet-5", ["2", "10", "0.20", "2.5", "4"]),
]);
