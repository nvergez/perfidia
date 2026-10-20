import type { GameTime, HandoffReason, PlayerId, SeatAgent } from "@perfidia/protocol";
import type { UsageEntry } from "../model/adapter.ts";
import { costOf, type Cost, type Pricer } from "../model/prices.ts";

// The budget ledger (phase-2 design §5.3; phase-4 design §5.2): what each LLM seat has spent, in
// integer nano-dollars, against its safety cap and its per-wake soft cap, and what the whole match
// has spent against its budget. The charge that crosses a seat's cap queues that seat's hand-off at
// once (idempotent); the ledger is also the `HandoffQueue` the gateway polls (structurally:
// `take(seat, t)`), so the next turn of that seat opens with a `controller` line and its bot plays
// from then on.
//
// The match budget is the guarantee (`MatchBudget`): every charge counts toward it, seat attempts
// and thought calls here, the start preflight, pause-gate probes and a crashed run's carry in the
// arena. When the spend reaches the kill threshold `K = budget − reserve` (the reserve is the most
// the attempts and the probe in flight at that moment can still add), the kill switch fires:
// `over(seat)` turns true for every seat, so no attempt starts after it (the seat agent checks it
// right before each attempt and thought call), and every LLM seat's hand-off is queued with reason
// `match_budget`. The match goes on with bots to its end. `halt(reason)` does the same for the
// operator (SIGINT or SIGTERM once).
//
// Pass 1b: each seat has its pricer (its provider's cards, its pinned endpoint, the card valid at
// the attempt's wall-clock start or the run's pinned price date, the platform fee included);
// without one, phase 2's Claude pricing applies.
//
// Fail-safe (phase-4 review): the accounting never depends on a hook. A charge updates the seat's
// and the match's spend before any hook runs; the kill switch halts every seat (`over()` reads the
// kill flag itself) before the arena's `onKill` (which writes a line and can fail on a full disk);
// and a hook that throws is reported through `onError`, never left to skip what follows it. A usage
// the pricer cannot price (a non-finite or absurd count) is charged the seat's attempt bound, flagged
// `invalidUsage`, instead of throwing away an attempt that was billed.

/** The new controller of a seat over its cap. */
export interface HandoffTarget {
  readonly label: string;
  readonly agent: SeatAgent;
}

export type { HandoffReason };

/** A hand-off decided by the ledger, for the `handoff` line of `llm_calls.jsonl`. */
export interface HandoffNote {
  readonly seat: PlayerId;
  readonly t: GameTime;
  readonly reason: HandoffReason;
  readonly label: string;
  readonly spentNanoUsd: number;
  readonly capNanoUsd: number;
}

/** The kill switch fired (`kill_switch` line). */
export interface KillNote {
  readonly t: GameTime;
  readonly spentNanoUsd: number;
  readonly killAtNanoUsd: number;
  readonly budgetNanoUsd: number;
}

export interface MatchBudgetOptions {
  /** The match budget in nano-dollars. */
  readonly budgetNanoUsd: number;
  /** Σ attempt bounds + one probe (+ the start preflight): what can land after the kill. */
  readonly reserveNanoUsd: number;
  /** Logged spend of a crashed earlier run (`--budget-carry`), counted from the start. */
  readonly carryNanoUsd?: number;
  /** Called once, by the charge that reaches the kill threshold, after every seat is halted. */
  readonly onKill?: (note: KillNote) => void;
  /**
   * A kill hook (a listener or `onKill`) threw: reported here, and the other hooks still run.
   * Absent: the first error is rethrown once every hook ran (the kill state is already set).
   */
  readonly onError?: (what: string, error: unknown) => void;
}

/** Runs `hooks` in order; a throw is reported (or rethrown after the last hook), never skips one. */
function runHooks(
  hooks: readonly (readonly [string, () => void])[],
  onError: ((what: string, error: unknown) => void) | undefined,
): void {
  let first: { readonly error: unknown } | null = null;
  for (const [what, hook] of hooks) {
    try {
      hook();
    } catch (error) {
      if (onError === undefined) first ??= { error };
      else onError(what, error);
    }
  }
  if (first !== null) throw first.error;
}

const checkNano = (n: number, what: string): number => {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error(`${what} must be an integer ≥ 0, got ${n}`);
  return n;
};

/**
 * The match budget (phase-4 design §5.2). `spent` counts every charge, the carry included; the
 * kill switch fires when it reaches `killAtNanoUsd = budget − reserve`. Since at most one attempt
 * per LLM seat and one probe are in flight when it fires, and none starts after it, the final spend
 * is at most `K + reserve = budget`, provided each in-flight charge stays within its bound.
 */
export class MatchBudget {
  readonly budgetNanoUsd: number;
  readonly reserveNanoUsd: number;
  readonly killAtNanoUsd: number;
  readonly carryNanoUsd: number;
  private spentNano: number;
  private kill: KillNote | null = null;
  private readonly onKill: ((note: KillNote) => void) | undefined;
  private readonly onError: ((what: string, error: unknown) => void) | undefined;
  private readonly listeners: ((note: KillNote) => void)[] = [];

  constructor(o: MatchBudgetOptions) {
    this.budgetNanoUsd = checkNano(o.budgetNanoUsd, "the match budget");
    this.reserveNanoUsd = checkNano(o.reserveNanoUsd, "the reserve");
    this.carryNanoUsd = checkNano(o.carryNanoUsd ?? 0, "the carry");
    if (this.reserveNanoUsd > this.budgetNanoUsd) {
      throw new Error(
        `the reserve (${this.reserveNanoUsd} nUSD) exceeds the budget (${this.budgetNanoUsd} nUSD)`,
      );
    }
    this.killAtNanoUsd = this.budgetNanoUsd - this.reserveNanoUsd;
    this.spentNano = 0;
    this.onKill = o.onKill;
    this.onError = o.onError;
    this.add(this.carryNanoUsd, 0);
  }

  /** Every charge so far, the carry included. */
  get spentNanoUsd(): number {
    return this.spentNano;
  }

  get killed(): boolean {
    return this.kill !== null;
  }

  get killNote(): KillNote | null {
    return this.kill;
  }

  /**
   * Also called once when the kill switch fires, before `onKill` (the ledger halts its seats
   * through this, so a failing `onKill` cannot leave them running).
   */
  onKilled(listener: (note: KillNote) => void): void {
    this.listeners.push(listener);
    const kill = this.kill;
    if (kill !== null) runHooks([["a kill listener", () => listener(kill)]], this.onError);
  }

  /**
   * Adds one charge at game time `t`; the one that reaches the threshold fires the kill switch:
   * the flag first, then the listeners (the halt), then `onKill`, each hook guarded.
   */
  add(nanoUsd: number, t: GameTime): void {
    this.spentNano += checkNano(nanoUsd, "a charge");
    if (this.kill === null && this.spentNano >= this.killAtNanoUsd) {
      const note: KillNote = {
        t,
        spentNanoUsd: this.spentNano,
        killAtNanoUsd: this.killAtNanoUsd,
        budgetNanoUsd: this.budgetNanoUsd,
      };
      this.kill = note;
      const onKill = this.onKill;
      runHooks(
        [
          ...this.listeners.map((l) => ["a kill listener", () => l(note)] as const),
          ...(onKill === undefined ? [] : [["the kill hook", () => onKill(note)] as const]),
        ],
        this.onError,
      );
    }
  }
}

export interface LedgerOptions {
  /** The safety cap of each LLM seat, in nano-dollars. */
  readonly caps: ReadonlyMap<PlayerId, number>;
  /** The per-wake soft cap in nano-dollars; `null`: none. */
  readonly wakeCapNanoUsd: number | null;
  /** Per-seat wake caps over `wakeCapNanoUsd` (a lineup's §3.9 defaults); `null`: none. */
  readonly wakeCaps?: ReadonlyMap<PlayerId, number | null>;
  /** Builds the hand-off bot of a seat (the profile's, or `--handoff-bot`). */
  readonly handoffTo: (seat: PlayerId) => HandoffTarget;
  /** Called once per hand-off, when it is decided. */
  readonly onHandoff?: (note: HandoffNote) => void;
  /** The match budget every charge counts toward (phase 4); none: per-seat caps only. */
  readonly match?: MatchBudget;
  /** Per seat, how an attempt's usage is priced (Pass 1b); absent: the Claude cards. */
  readonly pricers?: ReadonlyMap<PlayerId, Pricer>;
  /**
   * Per seat, the most one attempt can cost (`attemptBoundNano`): what a usage the pricer cannot
   * price is charged. Absent for a seat: such a usage throws (phase 2).
   */
  readonly attemptBounds?: ReadonlyMap<PlayerId, number>;
  /** A hand-off hook (`onHandoff`) threw: reported here. Absent: rethrown once the state is set. */
  readonly onError?: (what: string, error: unknown) => void;
}

/** What a charge did: its cost and the spends after it. */
export interface Charge {
  /** Token cost and platform fee. */
  readonly costNanoUsd: number;
  /** The platform fee part of `costNanoUsd`. */
  readonly feeNanoUsd: number;
  /** The card the requested model's usage was charged at; null when nothing was billed. */
  readonly card: string | null;
  readonly seatSpentNanoUsd: number;
  readonly wakeSpentNanoUsd: number;
  readonly capNanoUsd: number;
  /** Served models without a price, charged at the highest rates. */
  readonly unpriced: readonly string[];
  readonly longPrompt: boolean;
  /** This charge took the seat to or over its cap. */
  readonly crossedCap: boolean;
  /** The usage could not be priced (a non-finite or unsafe count): the seat's attempt bound was charged. */
  readonly invalidUsage: boolean;
}

interface SeatBook {
  readonly cap: number;
  readonly wakeCap: number | null;
  spent: number;
  wakeTurn: number;
  wakeSpent: number;
  /** The hand-off decided for the seat, until the host takes it. */
  pending: HandoffTarget | null;
  handedOff: boolean;
}

export class BudgetLedger {
  readonly wakeCapNanoUsd: number | null;
  readonly match: MatchBudget | null;
  private readonly seats = new Map<PlayerId, SeatBook>();
  private readonly handoffTo: (seat: PlayerId) => HandoffTarget;
  private readonly onHandoff: ((note: HandoffNote) => void) | undefined;
  private readonly pricers: ReadonlyMap<PlayerId, Pricer>;
  private readonly bounds: ReadonlyMap<PlayerId, number>;
  private readonly onError: ((what: string, error: unknown) => void) | undefined;
  /** Why every seat stopped calling its model (the kill switch, the operator); null: running. */
  private haltedBy: HandoffReason | null = null;

  constructor(o: LedgerOptions) {
    this.wakeCapNanoUsd =
      o.wakeCapNanoUsd === null ? null : checkNano(o.wakeCapNanoUsd, "the wake cap");
    for (const [seat, cap] of o.caps) {
      const own = o.wakeCaps?.get(seat);
      const wakeCap = own === undefined ? this.wakeCapNanoUsd : own;
      this.seats.set(seat, {
        cap: checkNano(cap, `the cap of ${seat}`),
        wakeCap: wakeCap === null ? null : checkNano(wakeCap, `the wake cap of ${seat}`),
        spent: 0,
        wakeTurn: 0,
        wakeSpent: 0,
        pending: null,
        handedOff: false,
      });
    }
    this.handoffTo = o.handoffTo;
    this.onHandoff = o.onHandoff;
    this.match = o.match ?? null;
    this.pricers = o.pricers ?? new Map();
    this.bounds = o.attemptBounds ?? new Map();
    this.onError = o.onError;
    this.match?.onKilled((k) => this.halt("match_budget", k.t));
  }

  private book(seat: PlayerId): SeatBook {
    const b = this.seats.get(seat);
    if (b === undefined) throw new Error(`${seat} is not an LLM seat of the ledger`);
    return b;
  }

  /**
   * Adds the cost of one attempt (refused, truncated, failed and estimated ones included); `at`:
   * the attempt's wall-clock start (ISO), which picks the card.
   */
  charge(
    seat: PlayerId,
    turn: number,
    t: GameTime,
    usage: readonly UsageEntry[],
    at?: string,
  ): Charge {
    const b = this.book(seat);
    const { cost, invalidUsage } = this.price(seat, usage, at);
    const before = b.spent;
    b.spent += cost.nanoUsd;
    if (b.wakeTurn !== turn) {
      b.wakeTurn = turn;
      b.wakeSpent = 0;
    }
    b.wakeSpent += cost.nanoUsd;
    const crossedCap = before < b.cap && b.spent >= b.cap;
    // The match counts the charge before any hook can fail (the cap's hand-off line below).
    this.match?.add(cost.nanoUsd, t);
    if (crossedCap) this.requestHandoff(seat, "cap", t);
    return {
      costNanoUsd: cost.nanoUsd,
      feeNanoUsd: cost.feeNanoUsd,
      card: usage.length === 0 ? null : (cost.cards[0] ?? null),
      seatSpentNanoUsd: b.spent,
      wakeSpentNanoUsd: b.wakeSpent,
      capNanoUsd: b.cap,
      unpriced: cost.unpriced,
      longPrompt: cost.longPrompt,
      crossedCap,
      invalidUsage,
    };
  }

  /** The cost of a usage; one the pricer cannot price costs the seat's attempt bound. */
  private price(
    seat: PlayerId,
    usage: readonly UsageEntry[],
    at: string | undefined,
  ): { readonly cost: Cost; readonly invalidUsage: boolean } {
    const pricer = this.pricers.get(seat);
    try {
      const cost = pricer === undefined ? costOf(usage) : pricer(usage, at);
      checkNano(cost.nanoUsd, "a cost");
      checkNano(cost.feeNanoUsd, "a fee");
      return { cost, invalidUsage: false };
    } catch (error) {
      const bound = this.bounds.get(seat);
      if (bound === undefined) throw error;
      return {
        cost: { nanoUsd: bound, feeNanoUsd: 0, unpriced: [], longPrompt: false, cards: [] },
        invalidUsage: true,
      };
    }
  }

  spent(seat: PlayerId): number {
    return this.book(seat).spent;
  }

  cap(seat: PlayerId): number {
    return this.book(seat).cap;
  }

  /** The seat's per-wake soft cap; `null`: none. */
  wakeCap(seat: PlayerId): number | null {
    return this.book(seat).wakeCap;
  }

  /** Spent during `turn` of the seat (0 for any other turn). */
  wakeSpent(seat: PlayerId, turn: number): number {
    const b = this.book(seat);
    return b.wakeTurn === turn ? b.wakeSpent : 0;
  }

  /**
   * The seat may make no more model attempts: it reached its safety cap, or every seat was halted
   * (the match budget's kill switch, the operator). Checked right before every attempt.
   */
  over(seat: PlayerId): boolean {
    return this.overReason(seat) !== null;
  }

  /**
   * Why `over(seat)` holds: the halt's reason (the kill flag counts by itself, whatever its hooks
   * did), then the seat's own cap; `null` when it does not.
   */
  overReason(seat: PlayerId): HandoffReason | null {
    const b = this.book(seat);
    const halted = this.halted;
    if (halted !== null) return halted;
    return b.spent >= b.cap ? "cap" : null;
  }

  /** Why every seat was halted (the first halt, or the kill flag itself); `null` while the ledger runs. */
  get halted(): HandoffReason | null {
    return this.haltedBy ?? (this.match?.killed === true ? "match_budget" : null);
  }

  /**
   * Stops every LLM seat at once: no attempt starts from now on, and each seat not yet handed off
   * gets its hand-off queued with `reason`. Idempotent: the first halt's reason stays.
   */
  halt(reason: HandoffReason, t: GameTime): void {
    if (this.haltedBy !== null) return;
    this.haltedBy = reason;
    for (const seat of this.seats.keys()) this.requestHandoff(seat, reason, t);
  }

  /** The current wake reached the per-wake soft cap: the turn ends at the next round. */
  wakeOver(seat: PlayerId, turn: number): boolean {
    const cap = this.book(seat).wakeCap;
    return cap !== null && this.wakeSpent(seat, turn) >= cap;
  }

  /**
   * Queues the seat's hand-off; a second request for the same seat does nothing. The hand-off is
   * queued before `onHandoff` runs, and a throwing `onHandoff` is reported through `onError`.
   */
  requestHandoff(seat: PlayerId, reason: HandoffReason, t: GameTime): void {
    const b = this.book(seat);
    if (b.pending !== null || b.handedOff) return;
    const target = this.handoffTo(seat);
    b.pending = target;
    const onHandoff = this.onHandoff;
    if (onHandoff === undefined) return;
    const note: HandoffNote = {
      seat,
      t,
      reason,
      label: target.label,
      spentNanoUsd: b.spent,
      capNanoUsd: b.cap,
    };
    runHooks([["the hand-off hook", () => onHandoff(note)]], this.onError);
  }

  handedOff(seat: PlayerId): boolean {
    return this.book(seat).handedOff;
  }

  /** Every LLM seat was handed off, or has its hand-off queued: no model call can follow. */
  allHandedOff(): boolean {
    for (const b of this.seats.values()) if (!b.handedOff && b.pending === null) return false;
    return true;
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
