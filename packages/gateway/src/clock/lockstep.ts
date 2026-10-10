import { shuffle, streamRng } from "@perfidia/engine/core";
import { compareIds } from "@perfidia/protocol";
import type {
  GameTime,
  MatchResult,
  PlayerId,
  RoundOutput,
  SeatAgent,
  TimeSource,
} from "@perfidia/protocol";
import { AgentRoundError, ClockError } from "./errors.ts";
import { playRound, type RoundTimeout } from "./round.ts";
import type { ClockDriver, ClockHost, TurnHandle } from "./types.ts";

// The lockstep driver (docs/architecture.md §9.2): game time jumps from one due time to the next
// and stands still while agents think. Every seat woken at second t plays its rounds together with
// the others: batch b is one round of every open turn, applied in the seeded order of the stream
// `lockstep:<t>:<b>`.

export const DEFAULT_MAX_TURNS_PER_SECOND = 3;

export interface LockstepOptions {
  /** Turns a seat may open within one game second before it is deferred to t + 1 (default 3). */
  readonly maxTurnsPerSecond?: number;
  /** Bounds a hung agent: a round not answered within this many ms of `time` fails. Needs `time`. */
  readonly roundTimeoutMs?: number;
  readonly time?: TimeSource;
  /** Agent errors and timeouts are fatal (tests): the turn is closed, then `run` rejects. */
  readonly strict?: boolean;
}

const byPlayer = (a: PlayerId, b: PlayerId): number => compareIds(a, b);
const bySeat = (a: { readonly seat: PlayerId }, b: { readonly seat: PlayerId }): number =>
  compareIds(a.seat, b.seat);

/**
 * The order in which the acting seats of batch `b` at second `t` apply their calls: the seats by
 * player number, shuffled with the stream `lockstep:<t>:<b>` of the match seed.
 */
export function lockstepOrder(
  seed: number,
  t: GameTime,
  b: number,
  acting: readonly PlayerId[],
): PlayerId[] {
  return shuffle(streamRng(seed, `lockstep:${t}:${b}`), acting.toSorted(byPlayer));
}

function positiveInt(value: number | undefined, what: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new ClockError(`${what} must be a positive integer, got ${value}`);
  }
}

export function createLockstepDriver(options: LockstepOptions = {}): ClockDriver {
  const maxTurns = options.maxTurnsPerSecond ?? DEFAULT_MAX_TURNS_PER_SECOND;
  positiveInt(maxTurns, "lockstep maxTurnsPerSecond");
  positiveInt(options.roundTimeoutMs, "lockstep roundTimeoutMs");
  let timeout: RoundTimeout | undefined;
  if (options.roundTimeoutMs !== undefined) {
    if (options.time === undefined) {
      throw new ClockError("lockstep roundTimeoutMs needs a time source (options.time)");
    }
    timeout = { time: options.time, ms: options.roundTimeoutMs };
  }
  const strict = options.strict ?? false;

  /** Plays every turn due at `t`, batch by batch, then defers the seats over the per-second cap. */
  async function playSecond(
    host: ClockHost,
    agents: ReadonlyMap<PlayerId, SeatAgent>,
    t: GameTime,
  ): Promise<void> {
    const turns = new Map<PlayerId, number>();
    let open: TurnHandle[] = [];
    for (let b = 0; ; b += 1) {
      if (!host.ended()) {
        for (const seat of host.dueSeats(t)) {
          const opened = turns.get(seat) ?? 0;
          if (opened >= maxTurns || open.some((h) => h.seat === seat)) continue;
          turns.set(seat, opened + 1);
          const handle = host.openTurn(seat);
          if (handle.done) handle.close();
          else open.push(handle);
        }
        open = open.toSorted(bySeat);
      }
      if (open.length === 0) break;

      // oxlint-disable-next-line no-await-in-loop -- batch b + 1 must see every write of batch b
      const settled = await Promise.all(
        open.map((h) => playRound(agents.get(h.seat), h.input(), timeout)),
      );
      const answered: {
        readonly seat: PlayerId;
        readonly h: TurnHandle;
        readonly out: RoundOutput;
      }[] = [];
      for (const [i, h] of open.entries()) {
        const r = settled[i];
        if (r === undefined) throw new ClockError(`no settlement for ${h.seat}'s round`);
        if (r.ok) {
          answered.push({ seat: h.seat, h, out: r.out });
          continue;
        }
        h.close(r.error, r.cause);
        if (strict) throw new AgentRoundError(h.seat, r.cause, r.error);
      }

      const acting = answered.filter((a) => a.out.calls.length > 0);
      const order = lockstepOrder(
        host.seed,
        t,
        b,
        acting.map((a) => a.seat),
      );
      host.logBatch(t, b, order);
      for (const seat of order) {
        const a = acting.find((x) => x.seat === seat);
        if (a === undefined) throw new ClockError(`batch order names ${seat}, which did not act`);
        a.h.execute(a.out);
      }
      for (const a of answered.filter((x) => x.out.calls.length === 0).toSorted(bySeat)) {
        a.h.execute(a.out);
      }

      const ended = host.ended();
      open = [];
      for (const a of answered.toSorted(bySeat)) {
        if (ended || a.h.done) a.h.close();
        else open.push(a.h);
      }
    }
    if (host.ended()) return;
    for (const seat of host.dueSeats(t)) host.defer(seat, t + 1);
  }

  return {
    async run(host: ClockHost, agents: ReadonlyMap<PlayerId, SeatAgent>): Promise<MatchResult> {
      host.start();
      let last = -1;
      while (!host.ended()) {
        const t = host.nextTime();
        if (t === null) break;
        if (t <= last) {
          throw new ClockError(
            `host.nextTime() returned ${t} after second ${last} was played: lockstep needs strictly increasing times`,
          );
        }
        last = t;
        host.advanceTo(t);
        // oxlint-disable-next-line no-await-in-loop -- seconds are played one after the other
        await playSecond(host, agents, t);
      }
      return host.finish();
    },
  };
}
