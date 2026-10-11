// Think time for bots in real time (docs/architecture.md §9.4): each round answers after a seeded
// latency on the injected `TimeSource`, so turns span game time and seats overlap like LLM seats.
// Under `VirtualTime` the latencies, and so the whole match, are reproducible (Level G).

import type { RoundInput, RoundOutput, SeatAgent, TimeSource } from "@perfidia/protocol";
import { randInt, streamOf } from "./rng.ts";

export interface ThinkTimeOptions {
  readonly time: TimeSource;
  /** Inclusive wall-clock latency range per round, in integer milliseconds. */
  readonly latencyMs: readonly [number, number];
  /** Seed of the latency draws (the match seed). */
  readonly seed: number;
}

/** The latency of one round: a pure function of the seed, the seat, the turn, the round and `t`. */
export function thinkLatencyMs(o: ThinkTimeOptions, input: RoundInput): number {
  const [lo, hi] = o.latencyMs;
  if (lo === hi) return lo;
  const rng = streamOf(o.seed, input.seat, "think", input.briefing.t, input.turn, input.round);
  return randInt(rng, lo, hi);
}

/**
 * `agent` with think time: each round's answer is returned after a seeded latency in
 * `latencyMs` (no sleep when it is 0). The label is the wrapped agent's: think time is a property
 * of the clock setup, recorded in the log header, not of the bot.
 */
export function withThinkTime(agent: SeatAgent, o: ThinkTimeOptions): SeatAgent {
  const [lo, hi] = o.latencyMs;
  if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || lo < 0 || lo > hi) {
    throw new RangeError(`latencyMs must be integers with 0 <= lo <= hi, got [${lo}, ${hi}]`);
  }
  if (hi - lo >= 2097152) throw new RangeError(`latencyMs range too wide: [${lo}, ${hi}]`);
  return {
    label: agent.label,
    async round(input: RoundInput): Promise<RoundOutput> {
      const out = await agent.round(input);
      const latency = thinkLatencyMs(o, input);
      if (latency > 0) await o.time.sleepUntil(o.time.nowMs() + latency).done;
      return out;
    },
  };
}
