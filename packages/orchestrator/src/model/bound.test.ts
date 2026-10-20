// The attempt bound (phase-4 design §5.2): the most one attempt can cost, the premise of the match
// budget's guarantee. Any usage within an attempt's limits (a prompt of at most the prompt cap, in
// any split between input, cache writes and cache reads, at any card the model can bill; output up
// to the retry limit) costs no more than the bound, fallback iterations included when the spec's
// fallbacks are on; a broken stream's charge (the full max_tokens) is within it too. Pass 1b: every
// seat model of every provider, over every card valid from the run's start (later windows too), the
// platform fee included, and tight to a nano-dollar. Pinned values: the design's §5.2 table.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { seatAttemptBound } from "../arena/estimate.ts";
import {
  attemptBoundNano,
  brokenStreamOutput,
  completionUpper,
  maxAttemptOutput,
  type UsageEntry,
} from "./adapter.ts";
import { MODELS } from "./catalog.ts";
import { FALLBACK_TARGETS, cardsFrom, cardsOf, costOf, formatCents } from "./prices.ts";

const CAP = 160_000;

/** A usage of `model` with `prompt` tokens split by `w` (four weights) and `output` tokens. */
function usage(
  model: string,
  prompt: number,
  w: readonly [number, number, number, number],
  output: number,
  kind: "message" | "fallback" = "message",
): UsageEntry {
  const sum = w[0] + w[1] + w[2] + w[3] || 1;
  const input = Math.floor((prompt * w[0]) / sum);
  const w5 = Math.floor((prompt * w[1]) / sum);
  const w1 = Math.floor((prompt * w[2]) / sum);
  return {
    model,
    kind,
    tokens: {
      input,
      cacheWrite5m: w5,
      cacheWrite1h: w1,
      cacheRead: prompt - input - w5 - w1,
      output,
    },
    estimated: false,
  };
}

const weights = fc.tuple(fc.nat(100), fc.nat(100), fc.nat(100), fc.nat(100));

describe("attemptBoundNano", () => {
  test("the design's §5.2 figures × 1.1 (US-only inference): Sonnet 5.5 $1.06, Haiku 5.5 $0.26 at 16,000 tokens", () => {
    // The design's figures are at global prices (Sonnet $0.96, Haiku $0.24, claude-duo $1.68);
    // the review added US-only inference (1.1× every kind, a workspace setting) to every Claude
    // bound, so a mid-run change of the workspace's default geography stays within the reserve.
    expect(formatCents(seatAttemptBound("claude-sonnet-5-5", "off", 16_000, CAP))).toBe("$1.06");
    expect(formatCents(seatAttemptBound("claude-haiku-5-5", "off", 16_000, CAP))).toBe("$0.26");
    expect(seatAttemptBound("claude-sonnet-5-5", "off", 16_000, CAP)).toBe(
      Math.ceil((960_000_000 * 11) / 10),
    );
    // claude-duo: Sonnet + 3 Haiku = $1.85 ($1.68 × 1.1).
    const duo =
      seatAttemptBound("claude-sonnet-5-5", "off", 16_000, CAP) +
      3 * seatAttemptBound("claude-haiku-5-5", "off", 16_000, CAP);
    expect(formatCents(duo)).toBe("$1.85");
    // Opus 5.5 at 32,768 output tokens without fallbacks: $2.85 ($2.59, the design's comparison
    // figure, × 1.1); with them, one iteration per target (Opus 5, Opus 4.8) at the highest prices.
    expect(formatCents(seatAttemptBound("claude-opus-5-5", "off", 32_768, CAP))).toBe("$2.85");
    expect(formatCents(seatAttemptBound("claude-opus-5-5", "default", 16_000, CAP))).toBe("$7.39");
    expect(maxAttemptOutput({ maxOutputTokens: 16_000 })).toBe(32_000);
    expect(maxAttemptOutput({ maxOutputTokens: 128_000 })).toBe(128_000);
    expect(() =>
      attemptBoundNano({ maxOutputTokens: 1 }, { served: [], fallback: [] }, CAP),
    ).toThrow("served model's cards");
    expect(() =>
      attemptBoundNano(
        { maxOutputTokens: 1 },
        { served: cardsOf("claude-haiku-5-5"), fallback: [] },
        0,
      ),
    ).toThrow("prompt cap");
  });

  test("no attempt within its limits costs more than its bound (property)", () => {
    const models = ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"] as const;
    fc.assert(
      fc.property(
        fc.constantFrom(...models),
        fc.constantFrom("default" as const, "off" as const),
        fc.integer({ min: 1, max: 64_000 }),
        fc.integer({ min: 1_000, max: CAP }),
        fc.integer({ min: 0, max: 1000 }),
        weights,
        fc.integer({ min: 0, max: 1000 }),
        fc.array(
          fc.tuple(fc.integer({ min: 0, max: 1000 }), weights, fc.integer({ min: 0, max: 1000 })),
          {
            maxLength: 2,
          },
        ),
        (model, fallbacks, maxTokens, cap, promptPm, w, outPm, fb) => {
          const bound = seatAttemptBound(model, fallbacks, maxTokens, cap);
          const out = maxAttemptOutput({ maxOutputTokens: maxTokens });
          const entries: UsageEntry[] = [
            usage(model, Math.floor((cap * promptPm) / 1000), w, Math.floor((out * outPm) / 1000)),
          ];
          // Fallback iterations, cold, one per target, only when the spec sends fallbacks.
          const capable = model !== "claude-haiku-5-5" && fallbacks === "default";
          const targets = capable ? (FALLBACK_TARGETS[model] ?? []) : [];
          for (const [i, [pm, fw, opm]] of fb.entries()) {
            const target = targets[i];
            if (target === undefined) break;
            entries.push(
              usage(
                target,
                Math.floor((cap * pm) / 1000),
                fw,
                Math.floor((out * opm) / 1000),
                "fallback",
              ),
            );
          }
          expect(costOf(entries).nanoUsd).toBeLessThanOrEqual(bound);
          // The same attempt run in the US (1.1×, every entry) stays within the bound.
          const us: UsageEntry[] = [];
          for (const e of entries) us.push({ ...e, geo: "us" });
          expect(costOf(us).nanoUsd).toBeLessThanOrEqual(bound);
          // A broken stream at the retry limit is charged its full max_tokens: within the bound.
          const broken = usage(model, cap, w, brokenStreamOutput(out));
          expect(costOf([broken]).nanoUsd).toBeLessThanOrEqual(bound);
          expect(costOf([{ ...broken, geo: "us" }]).nanoUsd).toBeLessThanOrEqual(bound);
        },
      ),
      { numRuns: 400, seed: 7 },
    );
  });

  test("Haiku 5.5's long-prompt card is in its bound: a prompt over 100K tokens is priced 5×", () => {
    const bound = seatAttemptBound("claude-haiku-5-5", "off", 16_000, CAP);
    const long = usage("claude-haiku-5-5", CAP, [0, 0, 1, 0], 32_000);
    expect(costOf([long]).longPrompt).toBe(true);
    // At global prices, 1/1.1 of the bound; run in the US, exactly the bound.
    expect(costOf([long]).nanoUsd).toBe(240_000_000);
    expect(costOf([{ ...long, geo: "us" }]).nanoUsd).toBe(bound);
  });
});

describe("the attempt bound of every seat model (Pass 1b)", () => {
  // A run starting at each instant may be billed at every card valid from then on: the bound is
  // the worst attempt over those cards (the whole prompt cap at the dearest prompt kind, the retry's
  // output), the platform fee included, and no looser than a nano-dollar of rounding.
  test("every provider's worst attempt is its bound: later price windows and fees included", () => {
    const starts = ["2026-10-19T00:00:00Z", "2026-11-29T23:59:00Z", "2026-12-30T12:00:00Z"];
    const kinds = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ] as const;
    const seen: string[] = [];
    for (const m of MODELS.filter((x) => x.seat)) {
      const endpoint = m.endpoints[0]?.tag ?? null;
      // OpenRouter's completion may exceed max_tokens a little: its slack is part of the bound.
      const out = completionUpper(
        m.provider,
        maxAttemptOutput({ maxOutputTokens: 32_768 }, m.capabilities.maxOutputTokens),
      );
      for (const from of starts) {
        const bound = seatAttemptBound(m.model, "off", 32_768, CAP, {
          provider: m.provider,
          endpoint,
          from,
        });
        let worst = 0;
        for (const card of cardsFrom(m.provider, m.model, endpoint, from)) {
          const at = card.validFrom > from ? card.validFrom : from;
          // Every geography the card lists (Claude's US-only inference) next to the global price.
          for (const geo of [undefined, ...Object.keys(card.geo ?? {})]) {
            for (const w of kinds) {
              const u = usage(m.model, CAP, w, out);
              const c = costOf([geo === undefined ? u : { ...u, geo }], {
                provider: m.provider,
                endpoint,
                at,
              });
              expect(c.nanoUsd).toBeLessThanOrEqual(bound);
              worst = Math.max(worst, c.nanoUsd);
            }
          }
        }
        expect([m.model, from, bound - worst <= 1]).toEqual([m.model, from, true]);
        seen.push(`${m.provider}:${m.model}@${from.slice(0, 10)} ${formatCents(bound)}`);
      }
    }
    // Argon's bound doubles with its later card, whenever the run starts; GLM-5.3's carries the fee.
    expect(seen).toContain("google:gemini-4-argon@2026-10-19 $1.95");
    expect(seen).toContain("google:gemini-4-argon@2026-12-30 $1.95");
    expect(seen).toContain("openrouter:z-ai/glm-5.3@2026-10-19 $0.54");
  });
});
