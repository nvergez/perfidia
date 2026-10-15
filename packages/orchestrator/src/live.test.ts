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

import { describe, expect, test } from "bun:test";
import { verifyLog } from "@perfidia/engine";
import { memoryIo } from "@perfidia/sim";
import { arenaEnv, planArena } from "./arena/plan.ts";
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
