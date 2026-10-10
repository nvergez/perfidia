import { z } from "@perfidia/protocol";
import type { RoundInput, RoundOutput, SeatAgent, Sleep, TimeSource } from "@perfidia/protocol";
import { describeError } from "./errors.ts";
import type { AgentFailure } from "./types.ts";

// One agent round as the drivers see it (§9.2, §9.3): it never rejects, so one failing agent
// cannot crash a driver or hide the other seats' outputs.

/** The shape a driver needs from an agent's answer; each call's tool and arguments are the host's to check. */
const RoundOutputShape = z.looseObject({
  calls: z.array(z.looseObject({ tool: z.string(), args: z.unknown() })),
  thought: z.string().optional(),
});

export type RoundSettlement =
  | { readonly ok: true; readonly out: RoundOutput }
  | ({ readonly ok: false } & AgentFailure);

export interface RoundTimeout {
  readonly time: TimeSource;
  readonly ms: number;
}

const failed = (error: string): RoundSettlement => ({ ok: false, error, cause: "error" });

function checkOutput(out: unknown): RoundSettlement {
  let parsed: ReturnType<typeof RoundOutputShape.safeParse>;
  try {
    parsed = RoundOutputShape.safeParse(out);
  } catch (e) {
    // `safeParse` reports a bad shape as issues, but lets a throwing getter or Proxy trap through.
    return failed(`invalid round output: ${describeError(e)}`);
  }
  if (parsed.success) {
    const { calls, thought } = parsed.data;
    return { ok: true, out: thought === undefined ? { calls } : { calls, thought } };
  }
  const issue = parsed.error.issues[0];
  const where =
    issue === undefined || issue.path.length === 0 ? "" : `${issue.path.map(String).join(".")}: `;
  return failed(`invalid round output: ${where}${issue?.message ?? "expected {calls: [...]}"}`);
}

/**
 * One entry of `Promise.allSettled` over `playRound`s, as a settlement. `playRound` never rejects,
 * so a rejected entry would be a bug of this module; it still closes only that seat's turn (§9.2).
 */
export function settlementOf(result: PromiseSettledResult<RoundSettlement>): RoundSettlement {
  return result.status === "fulfilled" ? result.value : failed(describeError(result.reason));
}

async function settle(
  agent: SeatAgent | undefined,
  input: RoundInput,
  timeout: RoundTimeout | undefined,
  timers: Set<Sleep> | undefined,
): Promise<RoundSettlement> {
  if (agent === undefined) return failed(`no agent for seat ${input.seat}`);
  let answer: Promise<RoundSettlement>;
  try {
    answer = Promise.resolve(agent.round(input)).then(checkOutput, (e: unknown) =>
      failed(describeError(e)),
    );
  } catch (e) {
    return failed(describeError(e));
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

/**
 * Asks `agent` for one round. Settles with the agent's output, or with the failure that closes
 * the turn: no agent for the seat, a throw or rejection (whatever value it carries), an answer that
 * is not a `RoundOutput`, or no answer before `timeout.ms` of `timeout.time` (a late answer is then
 * ignored). The timeout timer is cancelled as soon as the round settles; `timers` (optional) holds
 * it meanwhile, so a driver that stops early can cancel it. Never rejects: anything else that goes
 * wrong while the round is asked also becomes a failure of that turn alone.
 */
export function playRound(
  agent: SeatAgent | undefined,
  input: RoundInput,
  timeout?: RoundTimeout,
  timers?: Set<Sleep>,
): Promise<RoundSettlement> {
  return settle(agent, input, timeout, timers).catch((e: unknown) => failed(describeError(e)));
}
