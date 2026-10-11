import type {
  Action,
  AllianceId,
  CityId,
  CompiledRules,
  DeepReadonly,
  DomainEvent,
  GameState,
  GameTime,
  JsonObject,
  MatchResult,
  MessageId,
  MovementId,
  PlayerId,
  ProposalId,
  QueueItemId,
  ReportId,
  ScheduledEvent,
  Violation,
} from "@perfidia/protocol";
import type { Invariant, Rng, Ruleset } from "./ruleset.ts";

// Context objects handed to hooks and handlers (docs/architecture.md §5.2). Types only.

/** A read-only view of the match. Reads never write, not even to materialise (§4.3). */
export interface ReadCtx<C = unknown, X = unknown> {
  readonly state: DeepReadonly<GameState>;
  readonly now: GameTime;
  readonly rules: DeepReadonly<CompiledRules>;
  readonly config: DeepReadonly<C>;
  readonly ruleset: Ruleset<C, X>;
  ext(): DeepReadonly<X>;
}

/** The context of a step: the owned draft state and the kernel's services. */
export interface Ctx<C = unknown, X = unknown> {
  /** The owned draft, edited in place. */
  readonly state: GameState;
  readonly now: GameTime;
  readonly rules: DeepReadonly<CompiledRules>;
  readonly config: DeepReadonly<C>;
  readonly ruleset: Ruleset<C, X>;
  ext(): X;
  read(): ReadCtx<C, X>;
  /**
   * Serialises `{...e, t: now}` once, folds it into `evHash` and routes a parsed copy (§6.4), so
   * later changes to `e` change neither the log nor any archive.
   */
  emit(e: Omit<DomainEvent, "t">): void;
  /** Schedules `kind` at `at > now` and returns its seq. */
  schedule(kind: string, at: GameTime, ref: string): number;
  /** Removes the event with this seq; `EngineBug` if it is missing. */
  cancel(seq: number): void;
  /** Public counters, in creation order. */
  nextId(kind: "c"): CityId;
  nextId(kind: "a"): AllianceId;
  /** Opaque ids, from the owner's own counter through the keyed permutation of §4.1. */
  nextId(kind: "m", owner: PlayerId): MovementId;
  nextId(kind: "r", owner: PlayerId): ReportId;
  nextId(kind: "q", owner: PlayerId): ProposalId;
  nextId(kind: "g", owner: PlayerId): MessageId;
  /** The next queue item number of the city (shared by build items and recruit batches). */
  nextItem(city: CityId): QueueItemId;
  /**
   * A fresh mulberry32 on `${seed}:${stream}`. No PRNG state is stored, so the same name repeats
   * the same draws: a name must be unique within the match, e.g. `${kind}:${ev.seq}` for a draw
   * made by a scheduled event. With step invariants the kernel throws `EngineBug` when a name is
   * requested twice (an in-memory debug set per `Match`, not state; it starts empty after
   * `loadMatch`).
   */
  rng(stream: string): Rng;
  /**
   * `status = "ended"`; nothing else is processed afterwards (no `afterStep`, no further event).
   * The kernel emits the standard `match_ended` event `{reason, winners}` itself, exactly once: a
   * ruleset never emits it (`emit` refuses it). The result is validated (`MatchResultSchema`,
   * `endedAt = now`, winners and standings naming players of the match, each once); an invalid one
   * is an `EngineBug`.
   */
  endMatch(result: MatchResult): void;
}

/**
 * A domain action handler. `validate` is pure and computes every number `apply` needs; `apply`
 * trusts the plan and cannot fail. A thrown exception in either is an engine bug (§5.2).
 */
export interface ActionHandler<A extends Action = Action, P = unknown> {
  validate(
    r: ReadCtx,
    seat: PlayerId,
    a: A,
  ): { ok: true; plan: P; warnings?: Violation[] } | { ok: false; violation: Violation };
  /** Returns the tool-facing result data. */
  apply(ctx: Ctx, seat: PlayerId, plan: P): JsonObject;
}

export type EventHandler = (ctx: Ctx, ev: ScheduledEvent) => void;

/** The default handlers, built on `std` and passed to the kernel (which never imports them). */
export interface DomainModule {
  readonly actions: Readonly<Record<Exclude<Action["type"], "ext">, ActionHandler>>;
  /** `build_done`, `recruit_done`, `proposal_expire`, `pact_expire`. */
  readonly events: Readonly<Record<string, EventHandler>>;
  readonly arrivals: Readonly<
    Record<"support" | "shipment" | "found" | "return", (ctx: Ctx, m: MovementId) => void>
  >;
  /** Bloc invariants run only if the ruleset keeps the default `propose`/`answer`/`leave`. */
  readonly invariants: readonly Invariant[];
}
