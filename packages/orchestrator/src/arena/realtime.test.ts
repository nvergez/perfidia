// The arena in real time under virtual time (phase-2 design §7, item 8): the fake models think
// for a seeded 20–295 s per call against a 5-minute turn timeout (the agent's own deadline is 290 s),
// so some calls are aborted at the deadline: the attempt is charged its estimate and the turn
// closes. A hand-off happens through the queue in real time. Level E and the gateway rebuild hold.
// Then: in real time an operator-recoverable failure aborts the arena at once.

import { describe, expect, test } from "bun:test";
import { findRuleset, verifyLog } from "@perfidia/engine";
import { canonicalJson } from "@perfidia/engine/core";
import { rebuildGatewayState } from "@perfidia/gateway/runtime";
import { ModelError } from "../model/adapter.ts";
import type { FakeAdapter, Brain } from "../model/fake.ts";
import { botBrain } from "./brain.ts";
import type { LlmSeatPlan } from "./plan.ts";
import type { AdapterContext } from "./run.ts";
import { FlakyAdapter, fakePlan, play } from "./rig.test.ts";

const LONG = 120_000;
const resolve = (ref: string) => findRuleset(ref);
const auth = (): ModelError => new ModelError("auth", "invalid x-api-key", { status: 401 });

describe("arena in real time (virtual time)", () => {
  test(
    "deadline aborts are charged and close their turn; a hand-off in real time; Level E and the rebuild hold",
    async () => {
      const plan = fakePlan({ days: 1, clock: "realtime", seatCaps: ["p3=0.3"] });
      const run = await play(plan, { brainLatencyMs: [20_000, 295_000] });
      const { lines, llm, report } = run;
      expect(run.outcome.status).toBe("ended");
      expect(run.outcome.code).toBe(0);
      const header = lines[0];
      expect(header?.k === "header" ? header.clock : null).toEqual({
        kind: "realtime",
        speed: [3, 1],
        time: "virtual",
        latencyMs: [20_000, 90_000],
        turnTimeoutMs: 300_000,
      });

      // Aborted at the round deadline: charged an estimate (the 4 000-token output floor).
      const aborted = llm.filter((l) => l.error?.kind === "aborted");
      expect(aborted.length).toBeGreaterThan(0);
      for (const l of aborted) {
        expect(l.usage.every((u) => u.estimated && u.output === 4_000)).toBe(true);
        expect(l.costNanoUsd).toBeGreaterThan(0);
        const turn = lines.find((x) => x.k === "turn" && x.seat === l.seat && x.turn === l.turn);
        expect(turn?.k === "turn" ? [turn.why, turn.error] : []).toEqual([
          "error",
          `AgentError: llm ${l.seat} turn ${l.turn} round ${l.round}: request aborted at the round deadline`,
        ]);
      }
      // Think time is measured, so a real-time speed is recommended.
      expect(report.recommendedSpeed).not.toBeNull();
      expect(report.seats.every((s) => s.thinkMs.p95 > 0)).toBe(true);

      // The hand-off of p3 (over $0.30) through the queue, to its profile's bot.
      const controller = lines.find((l) => l.k === "controller");
      expect(controller?.k === "controller" ? [controller.seat, controller.label] : []).toEqual([
        "p3",
        "bot:turtle@3",
      ]);
      const at = controller?.k === "controller" ? controller.t : -1;
      expect(llm.filter((l) => l.seat === "p3").every((l) => l.t <= at)).toBe(true);

      const e = verifyLog(lines);
      expect(e.ok).toBe(true);
      const rebuilt = rebuildGatewayState(lines, resolve);
      expect(rebuilt.ok).toBe(true);
      expect(canonicalJson(rebuilt.gw)).toBe(canonicalJson(run.outcome.result?.gateway ?? null));
    },
    LONG,
  );

  test(
    "an operator-recoverable failure aborts a real-time arena at once (no pause): exit 2",
    async () => {
      let down = false;
      const adapterFor = (
        s: LlmSeatPlan,
        spec: ConstructorParameters<typeof FakeAdapter>[0],
        ctx: AdapterContext,
      ) => {
        const inner = botBrain({ label: s.brain, seat: s.seat, seed: ctx.seed, model: s.model });
        const brain: Brain = (req, n) => {
          if (s.seat === "p1" && req.meta.turn === 2) down = true;
          return down ? auth() : inner(req, n);
        };
        return new FlakyAdapter(spec, brain, () => (down ? auth() : null));
      };
      const run = await play(fakePlan({ days: 1, clock: "realtime" }), {
        adapterFor,
        brainLatencyMs: [1_000, 5_000],
      });
      expect(run.outcome.code).toBe(2);
      expect(run.report.status).toBe("aborted");
      expect(run.report.reason).toContain(
        "arena aborted (real time cannot pause): auth: invalid x-api-key",
      );
      expect(run.report.pauses.map((p) => [p.outcome, p.seat, p.pausedMs])).toEqual([
        ["aborted", "p1", 0],
      ]);
      expect(run.lines.some((l) => l.k === "end" || l.k === "fatal")).toBe(false);
      expect(verifyLog(run.lines).divergence?.kind).toBe("end");
      // The cut left the log consistent: the rebuild folds every line it holds.
      expect(rebuildGatewayState(run.lines, resolve).drift).toBeNull();
    },
    LONG,
  );
});
