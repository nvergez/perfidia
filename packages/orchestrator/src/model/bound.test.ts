// The attempt bound (phase-4 design §5.2): the most one attempt can cost, the premise of the match
// budget's guarantee. Any usage within an attempt's limits (a prompt of at most the prompt cap, in
// any split between input, cache writes and cache reads, at any card the model can bill; output up
// to the retry limit) costs no more than the bound, fallback iterations included when the spec's
// fallbacks are on; a broken stream's charge (the full max_tokens) is within it too. Pinned values:
// the design's §5.2 table.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { seatAttemptBound } from "../arena/estimate.ts";
import {
  attemptBoundNano,
  brokenStreamOutput,
  maxAttemptOutput,
  type UsageEntry,
} from "./adapter.ts";
import { FALLBACK_TARGETS, cardsOf, costOf, formatCents } from "./prices.ts";

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
  test("the design's §5.2 figures: Sonnet 5.5 $0.96, Haiku 5.5 $0.24 at 16,000 tokens", () => {
    expect(formatCents(seatAttemptBound("claude-sonnet-5-5", "off", 16_000, CAP))).toBe("$0.96");
    expect(formatCents(seatAttemptBound("claude-haiku-5-5", "off", 16_000, CAP))).toBe("$0.24");
    // claude-duo: Sonnet + 3 Haiku = $1.68.
    const duo =
      seatAttemptBound("claude-sonnet-5-5", "off", 16_000, CAP) +
      3 * seatAttemptBound("claude-haiku-5-5", "off", 16_000, CAP);
    expect(formatCents(duo)).toBe("$1.68");
    // Opus 5.5 at 32,768 output tokens without fallbacks: $2.59 (the design's comparison figure);
    // with them, one iteration per target (Opus 5, Opus 4.8) at the highest target prices.
    expect(formatCents(seatAttemptBound("claude-opus-5-5", "off", 32_768, CAP))).toBe("$2.59");
    expect(formatCents(seatAttemptBound("claude-opus-5-5", "default", 16_000, CAP))).toBe("$6.72");
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
          // A broken stream at the retry limit is charged its full max_tokens: within the bound.
          const broken = usage(model, cap, w, brokenStreamOutput(out));
          expect(costOf([broken]).nanoUsd).toBeLessThanOrEqual(bound);
        },
      ),
      { numRuns: 400, seed: 7 },
    );
  });

  test("Haiku 5.5's long-prompt card is in its bound: a prompt over 100K tokens is priced 5×", () => {
    const bound = seatAttemptBound("claude-haiku-5-5", "off", 16_000, CAP);
    const long = usage("claude-haiku-5-5", CAP, [0, 0, 1, 0], 32_000);
    expect(costOf([long]).longPrompt).toBe(true);
    expect(costOf([long]).nanoUsd).toBe(bound);
  });
});
