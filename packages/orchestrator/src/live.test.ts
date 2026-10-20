// The opt-in live test (phase-2 design §7, item 11): it calls the real Claude API and spends money
// (under $0.20), so it runs only through `bun run test:live`, which sets PERFIDIA_LIVE=1, and only
// when PERFIDIA_ANTHROPIC_API_KEY is set: a plain `bun test` or `bun run check` never sends a
// request, even on a machine with the key exported. Never run in CI. The cloud container's egress
// proxy may block api.anthropic.com; the owner's machine is the expected place to run it.
//
// 1. An arena match of one game hour: one Claude Haiku 5.5 seat at `low` effort and five bots. The
//    preflight passes (the exact request shape is accepted, tool schemas included), the stop
//    reasons are the expected ones, the second call of a turn reads the cache, `llm_calls.jsonl`
//    is written, and Level E holds.
// 2. One Claude Opus 5.5 call at `low` (`arena smoke --model opus-5-5`): the `fallbacks` and
//    `betas` shape, and the operator entries as mid-conversation system messages.
// 3. Phase 4 Pass 2, Gemini (its own opt-in: PERFIDIA_LIVE=1 and PERFIDIA_GOOGLE_API_KEY): `arena
//    smoke --provider google` on Gemini 3.8 Flash at `low` with a 1,024-token output limit (the
//    preflight, a count and one streamed call; under $0.05 at the card of the day, asserted).

import { describe, expect, test } from "bun:test";
import { verifyLog } from "@perfidia/engine";
import { memoryIo } from "@perfidia/sim";
import { arenaEnv, planArena, providerEnv } from "./arena/plan.ts";
import { runGeminiSmoke } from "./arena/providers/gemini-smoke.ts";
import { smokeCommand } from "./arena/smoke.ts";
import { play, runDir } from "./arena/rig.test.ts";

const env = arenaEnv(process.env);
const LIVE = env.live && env.apiKey !== null;
const FIVE_MINUTES = 300_000;

describe.skipIf(!LIVE)("live: the real Claude API (opt-in)", () => {
  test(
    "a one-hour arena match with one Haiku 5.5 seat and five bots",
    async () => {
      const plan = planArena(
        {
          ruleset: "perfidia-1@1.1.0",
          overrides: ["time.matchEnd=3600"],
          seed: 1,
          idKey: "seed",
          seats: [
            "p1=claude:haiku-5-5:low:penelope",
            "p2=bot:turtle@3",
            "p3=bot:expander@2",
            "p4=bot:opportunist@3",
          ],
          capUsd: "0.5",
        },
        env,
      );
      const run = await play(plan, { dir: runDir("live") });
      console.log(run.stdout);
      expect(run.outcome.status).toBe("ended");
      expect(run.llm.length).toBeGreaterThan(0);
      for (const l of run.llm) {
        expect(["tool_use", "end_turn"]).toContain(l.stop);
        expect(l.error).toBeNull();
      }
      const byTurn = new Map<number, typeof run.llm>();
      for (const l of run.llm) byTurn.set(l.turn, [...(byTurn.get(l.turn) ?? []), l]);
      for (const calls of byTurn.values()) {
        for (const l of calls.slice(1)) expect(l.usage.at(-1)?.cacheRead ?? 0).toBeGreaterThan(0);
      }
      expect(verifyLog(run.lines).ok).toBe(true);
      expect(run.report.totals.costNanoUsd).toBeLessThan(200_000_000);
    },
    FIVE_MINUTES,
  );

  test(
    "one Opus 5.5 call at low effort: fallbacks, betas and system entries accepted",
    async () => {
      const io = memoryIo();
      const code = await smokeCommand({ env, io, model: "opus-5-5", effort: "low" });
      console.log(io.stdout(), io.stderr());
      expect(code).toBe(0);
    },
    FIVE_MINUTES,
  );
});

// Phase 4 Pass 2: the OpenAI adapter, behind PERFIDIA_LIVE=1 and PERFIDIA_OPENAI_API_KEY. One
// `arena smoke --provider openai` on GPT-6 Luna at low effort: the model's access, the production
// shape at 16 output tokens, the input-token count and one streamed call of a real round-0
// request capped at 4,000 output tokens, no retry. Its bound is printed first and asserted under
// $0.05 ($0.009973 at the 2026-10-20 card). The test name carries why it is skipped.
const OPENAI_LIVE = env.live && providerEnv(env, "openai").apiKey !== null;
if (!OPENAI_LIVE) {
  console.log(
    `live: the OpenAI test is skipped: it needs PERFIDIA_LIVE=1 (${env.live ? "set" : "not set"}) and PERFIDIA_OPENAI_API_KEY (${providerEnv(env, "openai").apiKey === null ? "not set" : "set"}); it spends under $0.05`,
  );
}

describe("live: the real OpenAI API (opt-in)", () => {
  test.skipIf(!OPENAI_LIVE)(
    "one GPT-6 Luna smoke at low effort, under $0.05 (skipped unless PERFIDIA_LIVE=1 and PERFIDIA_OPENAI_API_KEY are set)",
    async () => {
      const io = memoryIo();
      const code = await smokeCommand({ env, io, provider: "openai" });
      console.log(io.stdout(), io.stderr());
      const bound = /at most \$(\d+\.\d+)/.exec(io.stdout());
      expect(Number(bound?.[1] ?? "1")).toBeLessThan(0.05);
      expect(code).toBe(0);
    },
    FIVE_MINUTES,
  );
});

// Phase 4 Pass 2: the Gemini adapter, behind PERFIDIA_LIVE=1 and PERFIDIA_GOOGLE_API_KEY: one
// `arena smoke --provider google` on Gemini 3.8 Flash at low effort, under $0.05.
const GEMINI_LIVE = env.live && providerEnv(env, "google").apiKey !== null;
if (!GEMINI_LIVE) {
  console.log(
    "live Gemini test skipped: it needs PERFIDIA_LIVE=1 (bun run test:live) and PERFIDIA_GOOGLE_API_KEY",
  );
}

describe.skipIf(!GEMINI_LIVE)("live: the real Gemini API (opt-in)", () => {
  test(
    "arena smoke --provider google on Gemini 3.8 Flash at low: ok, under $0.05",
    async () => {
      const io = memoryIo();
      const r = await runGeminiSmoke({
        env,
        io,
        model: "gemini-3.8-flash",
        effort: "low",
        maxTokens: 1024,
      });
      console.log(io.stdout(), io.stderr());
      expect(r.code).toBe(0);
      expect(r.spentNanoUsd).toBeLessThan(50_000_000);
    },
    FIVE_MINUTES,
  );
});
