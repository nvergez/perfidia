import { FIRST_READ, cardId, prices, type PriceCard } from "./card.ts";

// Gemini cards (Paid tier, Standard), checked 2026-10-20 against the pricing page (fetched as
// Markdown text). Both models cache implicitly here (Gemini 4 Argon supports nothing else; Gemini
// 3.8 Flash's explicit caching is not used): no write premium, so writes are billed as input, and
// hits are not guaranteed. Output includes thinking tokens. Each model has two dated windows: the
// page says "through November 30, 2026" (Argon) and "through December 31, 2026" (3.8 Flash) with no
// timezone, so the higher card applies from 00:00 UTC of that last day (conservative, design §2.9).

export const GOOGLE_PRICING_URL = "https://ai.google.dev/gemini-api/docs/pricing.md.txt";
export const GOOGLE_CHECKED = "2026-10-20";

/** `r`: input, output (thinking included), context caching (a hit). */
function gemini(
  model: string,
  r: readonly [string, string, string],
  from: string,
  to: string | null,
  suffix: string,
): PriceCard {
  return Object.freeze({
    id: cardId("google", model, null, GOOGLE_CHECKED, suffix),
    provider: "google",
    model,
    endpoint: null,
    serviceTier: "default",
    region: "global",
    validFrom: from,
    validTo: to,
    ...prices([r[0], r[1], r[2], r[0], r[0]]),
    longContext: null,
    overrides: [],
    platformFeePermille: 0,
    cache: "implicit",
    source: GOOGLE_PRICING_URL,
    checked: GOOGLE_CHECKED,
  });
}

/** Gemini 4 Argon's introductory price ends here (the page: "through November 30, 2026"). */
export const ARGON_CHANGE = "2026-11-30T00:00:00Z";
/** Gemini 3.8 Flash's price doubles here (the page: "through December 31, 2026"). */
export const FLASH_CHANGE = "2026-12-31T00:00:00Z";

export const GOOGLE_CARDS: readonly PriceCard[] = Object.freeze([
  gemini("gemini-4-argon", ["2", "10", "0.10"], FIRST_READ, ARGON_CHANGE, ""),
  gemini("gemini-4-argon", ["4", "20", "0.20"], ARGON_CHANGE, null, "#from2026-11-30"),
  gemini("gemini-3.8-flash", ["0.75", "3.75", "0.075"], FIRST_READ, FLASH_CHANGE, ""),
  gemini("gemini-3.8-flash", ["1.50", "7.50", "0.15"], FLASH_CHANGE, null, "#from2026-12-31"),
]);
