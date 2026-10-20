import { describe, expect, test } from "bun:test";
import { MODELS } from "@perfidia/orchestrator";
import fc from "fast-check";
import {
  asReasoningKind,
  effortWords,
  endpointVariant,
  fullModelName,
  hostName,
  isFakeSeat,
  modelLabel,
  modelName,
  modelWithRoute,
  playedBy,
  providerName,
  providerOfModel,
  reasoningKindTitle,
  reasoningKindWords,
  rehearsalOf,
  routeWords,
  seatReasoningKind,
} from "./models.ts";

const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const or = (model: string, endpoint: string | null) => ({
  provider: "openrouter",
  model,
  endpoint,
});
const seat = (provider: string, model: string, fake = false) =>
  ({ kind: "llm", fake, model: { provider, model, effort: "medium" } }) as const;

describe("model names", () => {
  test("known and family ids read as names; unknown ids show raw", () => {
    expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelName("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
    expect(modelName("claude-haiku-4")).toBe("Haiku 4");
    expect(modelName("claude-fable-5-1")).toBe("Fable 5.1");
    expect(modelName("gpt-6.1-sol")).toBe("GPT-6.1 Sol");
    expect(modelName("gpt-6-luna")).toBe("GPT-6 Luna");
    expect(modelName("gpt-7")).toBe("GPT-7");
    expect(modelName("gemini-4-argon")).toBe("Gemini 4 Argon");
    expect(modelName("gemini-3.8-flash")).toBe("Gemini 3.8 Flash");
    expect(modelName("gemini-3.5-flash-lite")).toBe("Gemini 3.5 Flash-Lite");
    expect(modelName("z-ai/glm-5.3")).toBe("GLM-5.3");
    expect(modelName("z-ai/glm-5.3-flash")).toBe("GLM-5.3 Flash");
    expect(modelName("moonshotai/kimi-k3")).toBe("Kimi K3");
    expect(modelName("deepseek/deepseek-v4.1-flash-1017")).toBe("DeepSeek V4.1 Flash");
    expect(modelName("gpt-x")).toBe("gpt-x");
    expect(modelName("qwen/qwen4-coder")).toBe("qwen/qwen4-coder");
    expect(modelName("")).toBe("");
  });

  test("every model of the arena's catalog has a display name, never its raw id", () => {
    expect(MODELS.length).toBeGreaterThanOrEqual(17);
    for (const m of MODELS) {
      const name = modelName(m.model);
      expect([m.model, name === m.model]).toEqual([m.model, false]);
      expect(providerName(m.provider)).not.toBe(m.provider);
      expect(providerOfModel(m.model)).toBe(m.provider);
    }
  });

  test("full names: Claude's family, first-party names, routed models with their route", () => {
    expect(fullModelName({ provider: "anthropic", model: "claude-opus-5-5" })).toBe(
      "Claude Opus 5.5",
    );
    expect(fullModelName({ provider: "anthropic", model: "claude-next" })).toBe("claude-next");
    expect(fullModelName({ provider: "openai", model: "gpt-6.1-sol" })).toBe("GPT-6.1 Sol");
    expect(fullModelName({ provider: "google", model: "gemini-4-argon" })).toBe("Gemini 4 Argon");
    expect(fullModelName(or("z-ai/glm-5.3", "z-ai/fp8"))).toBe("GLM-5.3 (Z.AI via OpenRouter)");
    expect(fullModelName(or("moonshotai/kimi-k3", "moonshotai/mxfp4"))).toBe(
      "Kimi K3 (Moonshot AI via OpenRouter)",
    );
    expect(fullModelName(or("z-ai/glm-5.3", null))).toBe("GLM-5.3 (via OpenRouter)");
    expect(fullModelName(or("acme/model-1", "newhost/fp4"))).toBe(
      "acme/model-1 (newhost via OpenRouter)",
    );
    expect(fullModelName({ provider: "compat", model: "local-llm" })).toBe(
      "local-llm (OpenAI-compatible endpoint)",
    );
    expect(modelWithRoute({ provider: "openai", model: "gpt-6-luna" })).toBe("GPT-6 Luna (OpenAI)");
    expect(modelWithRoute({ provider: "anthropic", model: "claude-haiku-5-5" })).toBe(
      "Claude Haiku 5.5 (Anthropic)",
    );
    expect(modelWithRoute(or("z-ai/glm-5.3-flash", "z-ai/fp8"))).toBe(
      "GLM-5.3 Flash (Z.AI via OpenRouter)",
    );
    expect(routeWords({ provider: "google", model: "gemini-3.8-flash" })).toBe("Google");
    expect(hostName("together")).toBe("Together AI");
    expect(endpointVariant("z-ai/fp8")).toBe("fp8");
    expect(endpointVariant("baseten/fp4/us")).toBe("fp4/us");
    expect(endpointVariant("together")).toBeNull();
    expect(providerName("mystery")).toBe("mystery");
  });

  test("efforts in the vendor's own terms", () => {
    expect(effortWords("anthropic", "medium")).toBe("effort medium");
    expect(effortWords("openai", "none")).toBe("reasoning effort none");
    expect(effortWords("openrouter", "low")).toBe("reasoning effort low");
    expect(effortWords("google", "high")).toBe("thinking level high");
    expect(effortWords("mystery", "max")).toBe("effort max");
  });

  test("a real LLM seat shows its model and effort; a bot shows Bot", () => {
    const llm = {
      kind: "llm",
      fake: false,
      model: { provider: "anthropic", model: "claude-opus-5-5", effort: "medium" },
    } as const;
    expect(modelLabel(llm)).toBe("Opus 5.5 · medium");
    expect(playedBy(llm)).toBe("Claude Opus 5.5 (Anthropic), effort medium");
    const glm = {
      kind: "llm",
      fake: false,
      model: { provider: "openrouter", model: "z-ai/glm-5.3", effort: "low", endpoint: "z-ai/fp8" },
    } as const;
    expect(modelLabel(glm)).toBe("GLM-5.3 · low");
    expect(playedBy(glm)).toBe("GLM-5.3 (Z.AI via OpenRouter), reasoning effort low");
    const gemini = {
      kind: "llm",
      fake: false,
      model: { provider: "google", model: "gemini-4-argon", effort: "medium" },
    } as const;
    expect(playedBy(gemini)).toBe("Gemini 4 Argon (Google), thinking level medium");
    expect(modelLabel({ kind: "bot", fake: false, model: null })).toBe("Bot");
    expect(playedBy({ kind: "bot", fake: false, model: null })).toBe("Scripted bot");
    expect(rehearsalOf(llm)).toBeNull();
  });

  test("provider fake, or a fake run, always reads Fake, never a model name", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "claude-opus-5-5",
          "claude-sonnet-4-5",
          "gpt-6-luna",
          "gemini-3.8-flash",
          "z-ai/glm-5.3-flash",
          "anything",
        ),
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
            // A rehearsal says whose seat it stands in for, as such.
            expect(rehearsalOf(s)?.startsWith("stands in for ")).toBe(true);
          }
        },
      ),
      { numRuns: 60 },
    );
    expect(
      rehearsalOf({
        fake: true,
        model: { provider: "fake", model: "z-ai/glm-5.3-flash", endpoint: "z-ai/fp8" },
      }),
    ).toBe("stands in for GLM-5.3 Flash (Z.AI via OpenRouter)");
    expect(
      rehearsalOf({
        fake: true,
        model: { provider: "fake", model: "gpt-6-luna", intended: "openai" },
      }),
    ).toBe("stands in for GPT-6 Luna (OpenAI)");
    expect(rehearsalOf({ fake: true, model: { provider: "fake", model: "anything" } })).toBe(
      "stands in for anything",
    );
  });

  test("reasoning kinds: a summary from the first-party APIs, raw text from open models", () => {
    expect(seatReasoningKind(seat("anthropic", "claude-haiku-5-5"))).toBe("summary");
    expect(seatReasoningKind(seat("openai", "gpt-6-luna"))).toBe("summary");
    expect(seatReasoningKind(seat("google", "gemini-3.8-flash"))).toBe("summary");
    expect(seatReasoningKind(seat("openrouter", "z-ai/glm-5.3-flash"))).toBe("raw");
    expect(seatReasoningKind(seat("compat", "local"))).toBe("raw");
    // A fake seat mirrors its intended model's kind (as the fake adapter logs it).
    expect(seatReasoningKind(seat("fake", "z-ai/glm-5.3-flash", true))).toBe("raw");
    expect(seatReasoningKind(seat("fake", "gpt-6-luna", true))).toBe("summary");
    expect(seatReasoningKind(seat("fake", "anything", true))).toBeNull();
    expect(seatReasoningKind({ kind: "bot", fake: false, model: null })).toBeNull();
    expect(reasoningKindWords("raw")).toBe("raw chain of thought");
    expect(reasoningKindWords("summary")).toBe("summary");
    expect(reasoningKindTitle("raw")).toBe("Raw chain of thought");
    expect(asReasoningKind("raw")).toBe("raw");
    expect(asReasoningKind("other")).toBeNull();
    expect(asReasoningKind(undefined)).toBeNull();
    // The catalog's kinds are the ones the web expects of each provider.
    for (const m of MODELS) {
      expect([m.model, seatReasoningKind(seat(m.provider, m.model))]).toEqual([
        m.model,
        m.capabilities.reasoning,
      ]);
    }
  });
});
