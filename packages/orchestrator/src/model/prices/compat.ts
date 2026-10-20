import type { PriceCard } from "./card.ts";

// OpenAI-compatible endpoints (`compat` seats: a local vLLM, any compatible base URL). No card is
// shipped: what a self-hosted or third-party endpoint bills is the owner's to state, from its own
// price page, with its source and the date it was checked (phase-4 review: a compat seat is
// refused at plan time until its card is here). Write each with `cardId("compat", model, null,
// checked)`, `cache: "implicit"` unless the endpoint documents explicit caching, and the same
// pico-dollar units as every other card (`card.ts`).

export const COMPAT_CARDS: readonly PriceCard[] = Object.freeze([]);
