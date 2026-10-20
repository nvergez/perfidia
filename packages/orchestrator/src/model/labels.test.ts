// The controller-label grammar (phase-4 design §2.1, Pass 1b):
// `llm:<provider>/<model>[@<endpoint>]/<effort>:<profile>@<v>:p<PROMPT_VERSION>[-<variant>]`, with
// `%`, `/` and `@` escaped in model and endpoint ids, ids holding `:` refused, Anthropic labels
// byte-identical to phase 2's, and a parse that inverts the format for every catalogued model.

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { EFFORTS } from "@perfidia/protocol";
import {
  VARIANT_SUFFIX,
  adapterLabel,
  decodeLabelPart,
  encodeLabelPart,
  parseControllerLabel,
  type ModelSpec,
} from "./adapter.ts";
import { MODELS } from "./catalog.ts";

const spec = (
  provider: string,
  model: string,
  effort: ModelSpec["effort"],
  endpoint?: string,
): ModelSpec => ({
  provider,
  model,
  effort,
  maxOutputTokens: 32_768,
  cacheTtl: "5m",
  ...(endpoint === undefined ? {} : { endpoint }),
});

const label = (s: ModelSpec, profile: string, variant: keyof typeof VARIANT_SUFFIX) =>
  `llm:${adapterLabel(s)}:${profile}:p2${VARIANT_SUFFIX[variant]}`;

describe("controller labels", () => {
  test("Anthropic labels are phase 2's; OpenRouter ids escape / and @; the variant is a suffix", () => {
    expect(label(spec("anthropic", "claude-sonnet-5-5", "medium"), "odysseus@1", "system")).toBe(
      "llm:anthropic/claude-sonnet-5-5/medium:odysseus@1:p2",
    );
    expect(label(spec("openai", "gpt-6.1-sol", "medium"), "achilles@1", "developer")).toBe(
      "llm:openai/gpt-6.1-sol/medium:achilles@1:p2-dev",
    );
    const glm = label(
      spec("openrouter", "z-ai/glm-5.3", "medium", "z-ai/fp8"),
      "agamemnon@1",
      "envelope",
    );
    expect(glm).toBe("llm:openrouter/z-ai%2Fglm-5.3@z-ai%2Ffp8/medium:agamemnon@1:p2-env");
    expect(parseControllerLabel(glm)).toEqual({
      provider: "openrouter",
      model: "z-ai/glm-5.3",
      endpoint: "z-ai/fp8",
      effort: "medium",
      profile: "agamemnon",
      profileVersion: 1,
      promptVersion: 2,
      variant: "envelope",
    });
    expect(parseControllerLabel("llm:fake/claude-opus-5-5/medium:odysseus@1:p2")).toMatchObject({
      provider: "fake",
      model: "claude-opus-5-5",
      endpoint: null,
      variant: "system",
    });
    // Not labels of the grammar.
    for (const bad of [
      "bot:turtle@3",
      "llm:openrouter/z-ai/glm-5.3/medium:agamemnon@1:p2",
      "llm:x/m/huge:odysseus@1:p2",
      "llm:x/m%2/low:odysseus@1:p2",
      "llm:x/m/low:odysseus@1:p2-xyz",
    ]) {
      expect([bad, parseControllerLabel(bad)]).toEqual([bad, null]);
    }
  });

  test("ids holding ':' (OpenRouter's :free variants) or spaces are refused", () => {
    expect(() => encodeLabelPart("deepseek/deepseek-v4.1-flash:free")).toThrow('hold ":"');
    expect(() => encodeLabelPart("a b")).toThrow("spaces");
    expect(() => encodeLabelPart("")).toThrow("empty");
    expect(encodeLabelPart("100%/a@b")).toBe("100%25%2Fa%40b");
    expect(decodeLabelPart("100%25%2Fa%40b")).toBe("100%/a@b");
    expect(decodeLabelPart("bad%2")).toBeNull();
  });

  test("format and parse are inverses for every catalogued model and arbitrary ids (property)", () => {
    for (const m of MODELS) {
      const endpoint = m.endpoints[0]?.tag;
      const s = spec(m.provider, m.model, m.capabilities.efforts[0] ?? "low", endpoint);
      const parsed = parseControllerLabel(label(s, "penelope@1", "envelope"));
      expect([m.model, parsed?.model, parsed?.endpoint ?? undefined]).toEqual([
        m.model,
        m.model,
        endpoint,
      ]);
    }
    const idChar = fc.constantFrom(..."abcxyz019-._/@%".split(""));
    const id = fc.array(idChar, { minLength: 1, maxLength: 24 }).map((a) => a.join(""));
    fc.assert(
      fc.property(
        fc.constantFrom("anthropic", "openai", "google", "openrouter", "compat", "fake"),
        id,
        fc.option(id, { nil: undefined }),
        fc.constantFrom(...EFFORTS),
        fc.constantFrom("system", "developer", "envelope"),
        (provider, model, endpoint, effort, variant) => {
          const text = label(spec(provider, model, effort, endpoint), "odysseus@1", variant);
          expect(parseControllerLabel(text)).toEqual({
            provider,
            model,
            endpoint: endpoint ?? null,
            effort,
            profile: "odysseus",
            profileVersion: 1,
            promptVersion: 2,
            variant,
          });
        },
      ),
      { numRuns: 500, seed: 2626 },
    );
  });
});
