import type {
  Claims,
  ModelAggregate,
  RatingItem,
  StatsInterval,
  StatsSeriesRef,
} from "@perfidia/protocol/spectator";
import { fmtInt, fmtUsd, plural } from "../lib/format.ts";
import {
  asReasoningKind,
  fullModelName,
  reasoningKindWords,
  type ModelRef,
  type ReasoningKind,
} from "../lib/models.ts";

// The model statistics in words and numbers (phase-4 design §6, docs/phase4.md §45): the claim
// state ("Too few matches: 70 more needed (power now 0.00)"), money below a cent, shares in
// permille, intervals, the display order of models (by name: the server sends them by id, and no
// order by outcome is shown below the claim threshold), and the words for a seat's harness channel,
// reminders, hand-off and series. Pure: the `/models` page and the dossier's model block use it.

/** Nano-dollars as dollars, with sub-cent figures kept: `$0.0207`, `$0.14`, `$12.05`. */
export function fmtUsdFine(nanoUsd: number): string {
  if (nanoUsd === 0) return "$0.00";
  if (nanoUsd >= 1_000_000_000) return fmtUsd(nanoUsd);
  if (nanoUsd < 100_000) return "<$0.0001";
  // Four decimals: tenths of a hundredth of a cent, rounded.
  const units = Math.round(nanoUsd / 100_000);
  const s = String(units).padStart(4, "0");
  return `$0.${s}`;
}

/** A permille as a percentage with one decimal: `617` → `61.7%`; null → "–". */
export function fmtPermille(p: number | null): string {
  if (p === null) return "–";
  return `${(Math.round(p) / 10).toFixed(1)}%`;
}

/** A share of two counts as a percentage (one decimal); "–" without a denominator. */
export function fmtShare(n: number, d: number): string {
  if (d <= 0) return "–";
  return `${(Math.round((n * 1000) / d) / 10).toFixed(1)}%`;
}

/** A probability with two decimals: `0.8104` → `0.81`. */
export function fmtProb(p: number): string {
  return (Math.round(p * 100) / 100).toFixed(2);
}

/** A number with `digits` decimals and a true minus sign. */
export function fmtFixed(x: number, digits = 2): string {
  const v = Math.round(x * 10 ** digits) / 10 ** digits;
  const s = Math.abs(v).toFixed(digits);
  return v < 0 ? `−${s}` : s;
}

/** An interval: `[0.43, 1.12]` (`digits` decimals), Elo-like intervals as integers. */
export function fmtInterval(i: StatsInterval, digits = 2): string {
  if (digits === 0) return `[${fmtInt(Math.round(i.lo))}, ${fmtInt(Math.round(i.hi))}]`;
  return `[${fmtFixed(i.lo, digits)}, ${fmtFixed(i.hi, digits)}]`;
}

/** Milliseconds as `850 ms`, `1.2 s`, `14 s`. */
export function fmtMs(ms: number): string {
  if (ms < 1000) return `${fmtInt(ms)} ms`;
  if (ms < 10_000) return `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
  return `${fmtInt(Math.round(ms / 1000))} s`;
}

/** A token count: `950`, `12.4K`, `1.23M`. */
export function fmtTokens(n: number): string {
  if (n < 1000) return fmtInt(n);
  if (n < 1_000_000) return `${(Math.round(n / 100) / 10).toFixed(1)}K`;
  return `${(Math.round(n / 10_000) / 100).toFixed(2)}M`;
}

// The claim state -----------------------------------------------------------------------------

/** The headline of the claim state: no ranking is shown unless it is `ok`. */
export function claimHeadline(c: Claims): string {
  if (c.state === "ok") {
    return `Enough matches for a ranking: ${plural(c.matches, "rated match", "rated matches")} for the pair that met least (${fmtInt(c.needed)} needed; power ${fmtProb(c.power)})`;
  }
  if (c.state === "no_comparison")
    return "No comparison yet: no two models have met in a rated match";
  return `Too few matches: ${fmtInt(c.more)} more needed (power now ${fmtProb(c.power)})`;
}

/** What the threshold is and where the statistics stand, in two sentences. */
export function claimExplanation(c: Claims): string {
  const alpha = c.pairs > 1 ? `α = 0.05 split over ${fmtInt(c.pairs)} pairs` : "α = 0.05";
  const rule = `A ranking is shown once every pair of models has met in ${plural(c.needed, "rated match", "rated matches")}: enough to see a ${c.gap} head-to-head edge 80% of the time (exact binomial test, ${alpha}).`;
  if (c.state === "no_comparison") {
    return `${rule} So far ${plural(c.models, "model")} took part, and no two met in a rated match.`;
  }
  return `${rule} ${plural(c.models, "model")}, ${plural(c.pairs, "pair")}; the pair that met least has met in ${plural(c.matches, "rated match", "rated matches")}.`;
}

/** Whether rankings, ratings and outcomes may be shown (the server withholds them otherwise). */
export function rankingShown(c: Claims): boolean {
  return c.state === "ok";
}

// Display order ----------------------------------------------------------------------------------

type Named = Pick<ModelAggregate, "id" | "key" | "kind" | "model" | "fake">;

/**
 * An item's display name: the model's full name, a bot's label, or its key; a rehearsal's says it
 * is a fake standing in for the model ("Fake for GPT-6 Luna"), never the model's name alone.
 */
export function itemName(m: Named): string {
  if (m.kind === "bot") return botName(m.key);
  if (m.model === null) return m.key;
  if (m.fake) return `Fake for ${fullModelName(rehearsedModel(m.model))}`;
  return fullModelName(m.model);
}

/** `bot:conqueror@3` → "Conqueror (bot, version 3)". */
export function botName(key: string): string {
  const m = /^bot:([a-z][a-z0-9_-]*)@([0-9]+)$/.exec(key);
  if (m === null) return key;
  const name = m[1] ?? "";
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} (bot, version ${m[2] ?? ""})`;
}

const rankOf = (m: Named): number => (m.kind === "bot" ? 2 : m.fake ? 1 : 0);
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Items for display: models first, then rehearsals (fake seats), then bots, each by name (then
 * id). Never by outcome: the ranking has its own table, shown above the claim threshold only.
 */
export function displayOrder<T extends Named>(items: readonly T[]): T[] {
  const key = (m: T): string =>
    m.fake && m.model !== null ? fullModelName(rehearsedModel(m.model)) : itemName(m);
  return items.toSorted(
    (a, b) =>
      rankOf(a) - rankOf(b) ||
      byText(key(a).toLowerCase(), key(b).toLowerCase()) ||
      byText(a.id, b.id),
  );
}

/** Rating items by strength, strongest first (only above the claim threshold), then by id. */
export function ratingOrder(items: readonly RatingItem[]): RatingItem[] {
  return items.toSorted((a, b) => b.strength - a.strength || byText(a.id, b.id));
}

/**
 * Where `x` sits on a scale from `lo` to `hi`, in percent (0–100), for an interval bar; the scale
 * is widened a little so no mark sits on an edge.
 */
export function scalePercent(x: number, lo: number, hi: number): number {
  if (!(hi > lo)) return 50;
  const pad = (hi - lo) * 0.05;
  const p = ((x - (lo - pad)) / (hi - lo + 2 * pad)) * 100;
  return Math.min(100, Math.max(0, p));
}

// A seat's harness and reasoning -----------------------------------------------------------------

/** What its reasoning was, attempt by attempt: "raw chain of thought (56), none (4)". */
export function reasoningKindsWords(kinds: Readonly<Record<string, number>>): string {
  const parts = Object.entries(kinds)
    .filter(([, n]) => n > 0)
    .toSorted((a, b) => b[1] - a[1] || byText(a[0], b[0]))
    .map(([k, n]) => {
      const kind = asReasoningKind(k);
      return `${kind === null ? k : reasoningKindWords(kind)} (${fmtInt(n)})`;
    });
  return parts.length === 0 ? "not logged" : parts.join(", ");
}

/** The reasoning kind most attempts showed, a summary or raw text before none; null if none logged. */
export function mainReasoningKind(kinds: Readonly<Record<string, number>>): ReasoningKind | null {
  let best: ReasoningKind | null = null;
  let most = 0;
  for (const k of ["raw", "summary"] as const) {
    const n = kinds[k] ?? 0;
    if (n > most) {
      best = k;
      most = n;
    }
  }
  if (best !== null) return best;
  return (kinds["none"] ?? 0) > 0 ? "none" : null;
}

const CHANNEL: Readonly<Record<string, string>> = Object.freeze({
  system: "system messages",
  developer: "developer messages",
  envelope: "[harness] text in its user turns",
});

/** How harness text reaches the model (the prompt variant). */
export function channelWords(variant: string): string {
  return CHANNEL[variant] ?? variant;
}

const REMINDERS: Readonly<Record<string, string>> = Object.freeze({
  "every-round": "reminders after every round",
  "last-round": "reminders at the turn's start and last round only",
});

/** The reminder cadence of the lineup. */
export function remindersWords(r: string): string {
  return REMINDERS[r] ?? r;
}

const HANDOFF: Readonly<Record<string, string>> = Object.freeze({
  cap: "its spending cap was reached",
  match_budget: "the match budget ran out",
  outage: "its provider failed",
  operator: "the operator handed it over",
});

/** Why a seat went to its bot. */
export function handoffWords(reason: string | null): string {
  if (reason === null) return "reason not recorded";
  return HANDOFF[reason] ?? reason;
}

/** A series match: "series budget-mix, block 1, match 2" (blocks shown from 1). */
export function seriesWords(s: StatsSeriesRef): string {
  return `series ${s.lineup}, block ${fmtInt(s.block + 1)}, match ${fmtInt(s.index)}`;
}

/** Counts by label, largest first: "INVALID_ARGS 3, NOT_ENOUGH 2"; "none" when empty. */
export function countsWords(c: Readonly<Record<string, number>>, limit = 4): string {
  const xs = Object.entries(c)
    .filter(([, n]) => n > 0)
    .toSorted((a, b) => b[1] - a[1] || byText(a[0], b[0]));
  if (xs.length === 0) return "none";
  const shown = xs.slice(0, limit).map(([k, n]) => `${k} ${fmtInt(n)}`);
  const rest = xs.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${plural(rest, "other")}` : shown.join(", ");
}

/** The sum of counts by label. */
export function total(c: Readonly<Record<string, number>>): number {
  return Object.values(c).reduce((n, x) => n + x, 0);
}

/** A model reference for a fake item: the model it rehearses (its intended provider's). */
export function rehearsedModel(m: NonNullable<ModelAggregate["model"]>): ModelRef {
  return { provider: m.intended ?? m.provider, model: m.model, endpoint: m.endpoint };
}
