import type { GameTime, PlayerId, SeatAgent } from "@perfidia/protocol";
import type { UsageEntry } from "../model/adapter.ts";
import { costOf } from "../model/prices.ts";

// The budget ledger (phase-2 design §5.3): what each LLM seat has spent, in integer nano-dollars,
// against its safety cap and the per-wake soft cap. The charge that crosses a seat's cap queues
// its hand-off at once (idempotent); the ledger is also the `HandoffQueue` the gateway polls
// (structurally: `take(seat, t)`), so the next turn of that seat opens with a `controller` line
// and the profile's bot plays from then on.

/** The new controller of a seat over its cap. */
export interface HandoffTarget {
  readonly label: string;
  readonly agent: SeatAgent;
}

export type HandoffReason = "cap";

/** A hand-off decided by the ledger, for the `handoff` line of `llm_calls.jsonl`. */
export interface HandoffNote {
  readonly seat: PlayerId;
  readonly t: GameTime;
  readonly reason: HandoffReason;
  readonly label: string;
  readonly spentNanoUsd: number;
  readonly capNanoUsd: number;
}

export interface LedgerOptions {
  /** The safety cap of each LLM seat, in nano-dollars. */
  readonly caps: ReadonlyMap<PlayerId, number>;
  /** The per-wake soft cap in nano-dollars; `null`: none. */
  readonly wakeCapNanoUsd: number | null;
  /** Builds the hand-off bot of a seat (the profile's, or `--handoff-bot`). */
  readonly handoffTo: (seat: PlayerId) => HandoffTarget;
  /** Called once per hand-off, when it is decided. */
  readonly onHandoff?: (note: HandoffNote) => void;
}

/** What a charge did: its cost and the spends after it. */
export interface Charge {
  readonly costNanoUsd: number;
  readonly seatSpentNanoUsd: number;
  readonly wakeSpentNanoUsd: number;
  readonly capNanoUsd: number;
  /** Served models without a price, charged at the highest rates. */
  readonly unpriced: readonly string[];
  readonly longPrompt: boolean;
  /** This charge took the seat to or over its cap. */
  readonly crossedCap: boolean;
}

interface SeatBook {
  readonly cap: number;
  spent: number;
  wakeTurn: number;
  wakeSpent: number;
  /** The hand-off decided for the seat, until the host takes it. */
  pending: HandoffTarget | null;
  handedOff: boolean;
}

const checkNano = (n: number, what: string): number => {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error(`${what} must be an integer ≥ 0, got ${n}`);
  return n;
};

export class BudgetLedger {
  readonly wakeCapNanoUsd: number | null;
  private readonly seats = new Map<PlayerId, SeatBook>();
  private readonly handoffTo: (seat: PlayerId) => HandoffTarget;
  private readonly onHandoff: ((note: HandoffNote) => void) | undefined;

  constructor(o: LedgerOptions) {
    for (const [seat, cap] of o.caps) {
      this.seats.set(seat, {
        cap: checkNano(cap, `the cap of ${seat}`),
        spent: 0,
        wakeTurn: 0,
        wakeSpent: 0,
        pending: null,
        handedOff: false,
      });
    }
    this.wakeCapNanoUsd =
      o.wakeCapNanoUsd === null ? null : checkNano(o.wakeCapNanoUsd, "the wake cap");
    this.handoffTo = o.handoffTo;
    this.onHandoff = o.onHandoff;
  }

  private book(seat: PlayerId): SeatBook {
    const b = this.seats.get(seat);
    if (b === undefined) throw new Error(`${seat} is not an LLM seat of the ledger`);
    return b;
  }

  /** Adds the cost of one attempt (refused, truncated, failed and estimated ones included). */
  charge(seat: PlayerId, turn: number, t: GameTime, usage: readonly UsageEntry[]): Charge {
    const b = this.book(seat);
    const cost = costOf(usage);
    const before = b.spent;
    b.spent += cost.nanoUsd;
    if (b.wakeTurn !== turn) {
      b.wakeTurn = turn;
      b.wakeSpent = 0;
    }
    b.wakeSpent += cost.nanoUsd;
    const crossedCap = before < b.cap && b.spent >= b.cap;
    if (crossedCap) this.requestHandoff(seat, "cap", t);
    return {
      costNanoUsd: cost.nanoUsd,
      seatSpentNanoUsd: b.spent,
      wakeSpentNanoUsd: b.wakeSpent,
      capNanoUsd: b.cap,
      unpriced: cost.unpriced,
      longPrompt: cost.longPrompt,
      crossedCap,
    };
  }

  spent(seat: PlayerId): number {
    return this.book(seat).spent;
  }

  cap(seat: PlayerId): number {
    return this.book(seat).cap;
  }

  /** Spent during `turn` of the seat (0 for any other turn). */
  wakeSpent(seat: PlayerId, turn: number): number {
    const b = this.book(seat);
    return b.wakeTurn === turn ? b.wakeSpent : 0;
  }

  /** The seat reached its safety cap: it stops calling the model. */
  over(seat: PlayerId): boolean {
    const b = this.book(seat);
    return b.spent >= b.cap;
  }

  /** The current wake reached the per-wake soft cap: the turn ends at the next round. */
  wakeOver(seat: PlayerId, turn: number): boolean {
    return this.wakeCapNanoUsd !== null && this.wakeSpent(seat, turn) >= this.wakeCapNanoUsd;
  }

  /** Queues the seat's hand-off; a second request for the same seat does nothing. */
  requestHandoff(seat: PlayerId, reason: HandoffReason, t: GameTime): void {
    const b = this.book(seat);
    if (b.pending !== null || b.handedOff) return;
    const target = this.handoffTo(seat);
    b.pending = target;
    this.onHandoff?.({
      seat,
      t,
      reason,
      label: target.label,
      spentNanoUsd: b.spent,
      capNanoUsd: b.cap,
    });
  }

  handedOff(seat: PlayerId): boolean {
    return this.book(seat).handedOff;
  }

  /** `HandoffQueue.take`: polled by the gateway when `seat`'s turn opens. Never throws. */
  take(seat: PlayerId, _t: GameTime): HandoffTarget | null {
    const b = this.seats.get(seat);
    if (b === undefined || b.pending === null) return null;
    const target = b.pending;
    b.pending = null;
    b.handedOff = true;
    return target;
  }

  /** Spend per LLM seat, in seat order. */
  totals(): {
    readonly seat: PlayerId;
    readonly spentNanoUsd: number;
    readonly capNanoUsd: number;
  }[] {
    return [...this.seats.entries()].map(([seat, b]) => ({
      seat,
      spentNanoUsd: b.spent,
      capNanoUsd: b.cap,
    }));
  }
}
