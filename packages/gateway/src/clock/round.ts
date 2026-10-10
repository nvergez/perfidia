import { z } from "@perfidia/protocol";
import type { RoundInput, RoundOutput, SeatAgent, Sleep, TimeSource } from "@perfidia/protocol";
import { describeError } from "./errors.ts";
import type { TurnFailure } from "./types.ts";

// One agent round as the drivers see it (§9.2, §9.3): it never rejects, so one failing agent
// cannot crash a driver or hide the other seats' outputs.

/** The shape a driver needs from an agent's answer; each call's tool and arguments are the host's to check. */
const RoundOutputShape = z.looseObject({
  calls: z.array(z.looseObject({ tool: z.string(), args: z.unknown() })),
  thought: z.string().optional(),
});

export type RoundSettlement =
  | { readonly ok: true; readonly out: RoundOutput }
  | { readonly ok: false; readonly error: string; readonly cause: TurnFailure };

export interface RoundTimeout {
  readonly time: TimeSource;
  readonly ms: number;
}

function checkOutput(out: unknown): RoundSettlement {
  const parsed = RoundOutputShape.safeParse(out);
  if (parsed.success) {
    const { calls, thought } = parsed.data;
    return { ok: true, out: thought === undefined ? { calls } : { calls, thought } };
  }
  const issue = parsed.error.issues[0];
  const where =
    issue === undefined || issue.path.length === 0 ? "" : `${issue.path.map(String).join(".")}: `;
  return {
    ok: false,
    error: `invalid round output: ${where}${issue?.message ?? "expected {calls: [...]}"}`,
    cause: "error",
  };
}

/**
 * Asks `agent` for one round. Settles with the agent's output, or with the failure that closes
 * the turn: no agent for the seat, a throw or rejection, an answer that is not a `RoundOutput`, or
 * no answer before `timeout.ms` of `timeout.time` (a late answer is then ignored). The timeout
 * timer is cancelled as soon as the round settles; `timers` (optional) holds it meanwhile, so a
 * driver that stops early can cancel it.
 */
export async function playRound(
  agent: SeatAgent | undefined,
  input: RoundInput,
  timeout?: RoundTimeout,
  timers?: Set<Sleep>,
): Promise<RoundSettlement> {
  if (agent === undefined) {
    return { ok: false, error: `no agent for seat ${input.seat}`, cause: "error" };
  }
  let answer: Promise<RoundSettlement>;
  try {
    answer = Promise.resolve(agent.round(input)).then(checkOutput, (e: unknown) => ({
      ok: false,
      error: describeError(e),
      cause: "error",
    }));
  } catch (e) {
    return { ok: false, error: describeError(e), cause: "error" };
  }
  if (timeout === undefined) return answer;
  const sleep = timeout.time.sleepUntil(timeout.time.nowMs() + timeout.ms);
  timers?.add(sleep);
  const expired = sleep.done.then((): RoundSettlement => ({
    ok: false,
    error: `no answer within ${timeout.ms} ms`,
    cause: "timeout",
  }));
  try {
    return await Promise.race([answer, expired]);
  } finally {
    sleep.cancel();
    timers?.delete(sleep);
  }
}
