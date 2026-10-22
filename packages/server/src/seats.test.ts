// Who plays a seat, for phase 4's providers (Pass 1b): the server reads the controller-label grammar
// the orchestrator writes (`llm:<provider>/<model>[@<endpoint>]/<effort>:<profile>@<v>:p<N>[-dev|-env]`,
// model and endpoint ids escaping `%`, `/` and `@`), phase 2's labels unchanged; an OpenRouter seat
// is an LLM seat with its routing endpoint, with or without `seats.json`, never a bot.
// The fake mid-tier run served by the server runs in the slow suite (PERFIDIA_SLOW=1,
// docs/architecture.md §13.8: `bun run test:slow`, run by `bun run test:exit`).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  MODELS,
  VARIANT_SUFFIX,
  adapterLabel,
  parseControllerLabel,
  type ModelSpec,
} from "@perfidia/orchestrator";
import { EFFORTS, type Effort } from "@perfidia/protocol";
import fc from "fast-check";
import { parseLlmLabel, seatInfos } from "./service/seats.ts";
import {
  fakeRun,
  headerOf,
  metaOf,
  parseLog,
  rows,
  serve,
  stopServers,
  tempDir,
  testConfig,
  warText,
} from "./testkit.test.ts";

const SLOW = process.env["PERFIDIA_SLOW"] === "1";
/** A test of the slow suite: skipped unless PERFIDIA_SLOW=1. */
const xtest = test.skipIf(!SLOW);

const LONG = 120_000;
const GLM = "llm:openrouter/z-ai%2Fglm-5.3@z-ai%2Ffp8/medium:agamemnon@1:p2-env";

const spec = (provider: string, model: string, effort: Effort, endpoint?: string): ModelSpec => ({
  provider,
  model,
  effort,
  maxOutputTokens: 32_768,
  cacheTtl: "5m",
  ...(endpoint === undefined ? {} : { endpoint }),
});

const label = (s: ModelSpec, variant: keyof typeof VARIANT_SUFFIX): string =>
  `llm:${adapterLabel(s)}:odysseus@1:p2${VARIANT_SUFFIX[variant]}`;

/** The server reads `text` as the orchestrator does. */
function same(text: string): void {
  const theirs = parseControllerLabel(text);
  if (theirs === null) throw new Error(`the orchestrator does not parse ${text}`);
  expect(parseLlmLabel(text)).toEqual({
    provider: theirs.provider,
    model: theirs.model,
    endpoint: theirs.endpoint,
    effort: theirs.effort,
    profile: theirs.profile,
  });
}

describe("parseLlmLabel", () => {
  test("phase 2's labels, phase 4's escaped ids, endpoints, variants and efforts", () => {
    expect(parseLlmLabel("llm:fake/claude-opus-5-5/medium:odysseus@1:p2")).toEqual({
      provider: "fake",
      model: "claude-opus-5-5",
      endpoint: null,
      effort: "medium",
      profile: "odysseus",
    });
    expect(parseLlmLabel(GLM)).toEqual({
      provider: "openrouter",
      model: "z-ai/glm-5.3",
      endpoint: "z-ai/fp8",
      effort: "medium",
      profile: "agamemnon",
    });
    expect(parseLlmLabel("llm:openai/gpt-6.1-sol/none:achilles@1:p2-dev")?.effort).toBe("none");
    expect(parseLlmLabel("llm:google/gemini-4-argon/max:penelope@1:p2-env")?.effort).toBe("max");
    for (const bad of [
      "bot:turtle@3",
      "llm:openrouter/z-ai/glm-5.3/medium:agamemnon@1:p2",
      "llm:x/m%2/low:odysseus@1:p2",
      "llm:x/m/huge:odysseus@1:p2",
      "llm:x/m@/low:odysseus@1:p2",
    ]) {
      expect([bad, parseLlmLabel(bad)]).toEqual([bad, null]);
    }
  });

  test("it reads every label the orchestrator formats (catalogued models and arbitrary ids)", () => {
    for (const m of MODELS) {
      for (const effort of m.capabilities.efforts) {
        same(label(spec(m.provider, m.model, effort, m.endpoints[0]?.tag), "envelope"));
      }
    }
    const id = fc
      .array(fc.constantFrom(..."abcxyz019-._/@%".split("")), { minLength: 1, maxLength: 24 })
      .map((a) => a.join(""));
    fc.assert(
      fc.property(
        fc.constantFrom("anthropic", "openai", "google", "openrouter", "compat", "fake"),
        id,
        fc.option(id, { nil: undefined }),
        fc.constantFrom(...EFFORTS),
        fc.constantFrom("system", "developer", "envelope"),
        (provider, model, endpoint, effort, variant) => {
          same(label(spec(provider, model, effort, endpoint), variant));
        },
      ),
      { numRuns: 300, seed: 2627 },
    );
  });
});

describe("an OpenRouter seat", () => {
  test("from the header alone: an LLM seat with its endpoint, not a bot", () => {
    const header = headerOf(parseLog(rows(warText())[0] ?? ""));
    const seats = seatInfos(
      { ...header, controllers: { ...header.controllers, p1: GLM } },
      null,
      null,
    );
    expect(seats[0]).toMatchObject({
      seat: "p1",
      kind: "llm",
      name: "Agamemnon",
      fake: false,
      model: {
        provider: "openrouter",
        model: "z-ai/glm-5.3",
        effort: "medium",
        endpoint: "z-ai/fp8",
      },
    });
    expect(seats[1]?.kind).toBe("bot");
  });

  let root = "";
  beforeAll(async () => {
    if (!SLOW) return;
    const run = await fakeRun({ days: 1, seed: 3, lineup: "mid-tier" });
    root = tempDir("seats");
    cpSync(run.dir, join(root, "mid"), { recursive: true });
    cpSync(run.dir, join(root, "bare"), { recursive: true });
    rmSync(join(root, "bare", "seats.json"));
  }, LONG);
  afterAll(stopServers);

  xtest(
    "served from a fake mid-tier run, with and without seats.json",
    async () => {
      const s = serve(testConfig({ runs: root, adapter: "raw" }));
      const mid = await metaOf(s, "mid", { settled: true });
      const bare = await metaOf(s, "bare", { settled: true });
      const view = (seats: typeof mid.seats) =>
        seats.map((x) => [
          x.seat,
          x.kind,
          x.fake,
          x.model?.model ?? null,
          x.model?.endpoint ?? null,
        ]);
      const expected = [
        ["p1", "llm", true, "claude-sonnet-5-5", null],
        ["p2", "llm", true, "gpt-6.1-sol", null],
        ["p3", "llm", true, "gemini-4-argon", null],
        ["p4", "llm", true, "z-ai/glm-5.3", "z-ai/fp8"],
        ["p5", "bot", false, null, null],
        ["p6", "bot", false, null, null],
      ];
      expect(view(mid.seats)).toEqual(expected);
      expect(view(bare.seats)).toEqual(expected);
      // The mid-tier preset names GLM's listed effort, `low` (phase-4 Pass 2 review, §30.4).
      expect(mid.seats[3]?.label).toBe("llm:fake/z-ai%2Fglm-5.3@z-ai%2Ffp8/low:agamemnon@1:p3-env");
      expect(mid.seats[3]?.model?.effort).toBe("low");
    },
    LONG,
  );
});
