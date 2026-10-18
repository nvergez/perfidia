import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { isFakeSeat, modelLabel, modelName, playedBy } from "./models.ts";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

describe("model names", () => {
  test("known and family ids read as names; unknown ids show raw", () => {
    expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelName("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
    expect(modelName("claude-haiku-4")).toBe("Haiku 4");
    expect(modelName("gpt-x")).toBe("gpt-x");
  });

  test("a real LLM seat shows its model and effort; a bot shows Bot", () => {
    const llm = {
      kind: "llm",
      fake: false,
      model: { provider: "anthropic", model: "claude-opus-5-5", effort: "medium" },
    } as const;
    expect(modelLabel(llm)).toBe("Opus 5.5 · medium");
    expect(modelLabel({ kind: "bot", fake: false, model: null })).toBe("Bot");
  });

  test("provider fake, or a fake run, always reads Fake, never a model name", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("claude-opus-5-5", "claude-sonnet-4-5", "anything"),
        fc.constantFrom(...EFFORTS),
        fc.boolean(),
        (model, effort, flag) => {
          const seats = [
            { kind: "llm" as const, fake: flag, model: { provider: "fake", model, effort } },
            { kind: "llm" as const, fake: true, model: { provider: "anthropic", model, effort } },
          ];
          for (const s of seats) {
            expect(isFakeSeat(s)).toBe(true);
            expect(modelLabel(s)).toBe("Fake");
            expect(playedBy(s).includes(modelName(model))).toBe(false);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
