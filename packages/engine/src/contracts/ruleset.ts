import type {
  Action,
  City,
  CityId,
  CompiledRules,
  ConfigIssue,
  DeepReadonly,
  DomainEvent,
  GameTime,
  Island,
  IslandId,
  JsonObject,
  MatchResult,
  MovementId,
  PlayerId,
  RulesetRef,
  Res,
  ScheduledEvent,
  Standing,
  TravelGroup,
  UnitCounts,
  Violation,
  ZodType,
} from "@perfidia/protocol";
import type { ActionHandler, Ctx, ReadCtx } from "./ctx.ts";

// The ruleset interface (docs/architecture.md §3.2, §3.7). Types only.
//
// Hooks use method syntax (bivariant parameters), so a `Ruleset<PerfidiaConfig, PerfidiaExt>` is
// assignable to `AnyRuleset = Ruleset<unknown, unknown>` in the registry. Where a hook is a value in
// a record (`on`), `EventHook` gives it the same method-style variance.

export type { ConfigIssue, RulesetRef, TravelGroup };

/** `published` versions are frozen (§3.5); `test` rulesets are refused by `sim run` without `--allow-test`. */
export type RulesetStatus = "published" | "test";

export interface Ruleset<C = unknown, X = unknown> {
  /** E.g. `perfidia-1`; `/^[a-z][a-z0-9-]*$/`. */
  readonly id: string;
  /** E.g. `1.0.0`. */
  readonly version: string;
  /** E.g. `perfidia-1@1.0.0`. */
  readonly ref: RulesetRef;
  readonly status: RulesetStatus;
  readonly title: string;
  /** Strict objects; integers; fixed fields as `z.literal`; cross-field checks in `superRefine`. */
  readonly configSchema: ZodType<C>;
  /** Must parse with `configSchema` (tested). */
  readonly defaults: DeepReadonly<C>;
  /** Shape of `state.ext`. */
  readonly extSchema: ZodType<X>;
  /** Allowed N. */
  players(config: DeepReadonly<C>): { min: number; max: number };
  /** Pure. */
  compile(config: DeepReadonly<C>, players: number): CompiledRules;
  /** Ruleset-specific config checks, run after the kernel's generic `checkRules` (§3.6). */
  check?(config: DeepReadonly<C>, rules: DeepReadonly<CompiledRules>): ConfigIssue[];
  /** The game rules, rendered from the config; never a fixed string. */
  cheatSheet(config: DeepReadonly<C>, rules: DeepReadonly<CompiledRules>): string;
  readonly hooks: RulesetHooks<C, X>;
  /** Wording of the ruleset's violation and warning codes. */
  readonly errors: Readonly<Record<string, Explainer>>;
  /** At least one per `errors` code: explain tests and the fingerprint (§13.6). */
  readonly errorSamples: readonly Violation[];
  /** Optional extra agent tools (§3.7). */
  readonly tools?: readonly ExtraTool[];
  /** Every non-standard event type the ruleset emits (`{}` if none). */
  readonly eventSchemas: Readonly<Record<string, ZodType>>;
  /** Keys of `eventSchemas` whose payload depends on hidden data by design (§8.6), exempt from P15. */
  readonly intelEvents?: readonly string[];
}

/** A handler of one of the ruleset's own scheduled event kinds, with method-style variance. */
export type EventHook<C, X> = {
  handle(ctx: Ctx<C, X>, ev: ScheduledEvent): void;
}["handle"];

export interface RulesetHooks<C, X> {
  /** Map generation and starting state (pure). Ids follow the ruleset's own spec. */
  createWorld(w: WorldCtx<C>): WorldSetup<X>;
  /**
   * Map geometry. Must return ≥ `rules.time.minTravel` for every pair of islands, the same island
   * included (speed rule); checked at creation for every travel probe (§3.6).
   */
  travelTime(r: ReadCtx<C, X>, from: IslandId, to: IslandId, group: TravelGroup): number;
  /** Launch rules beyond the generic checks: target validity, recorded party (foe), carriers. Default `std.defaultDeparture`. */
  departure?(r: ReadCtx<C, X>, d: DepartureDraft): DepartureVerdict;
  /** Arrival resolution. `attack` and `spy` are mandatory; the others default to domain handlers. */
  readonly arrive: {
    attack(ctx: Ctx<C, X>, m: MovementId): void;
    spy(ctx: Ctx<C, X>, m: MovementId): void;
    support?(ctx: Ctx<C, X>, m: MovementId): void;
    shipment?(ctx: Ctx<C, X>, m: MovementId): void;
    found?(ctx: Ctx<C, X>, m: MovementId): void;
    return?(ctx: Ctx<C, X>, m: MovementId): void;
  };
  /** Handlers for the ruleset's own scheduled event kinds (`siege_end`, `domination_open`, …). */
  readonly on?: Readonly<Record<string, EventHook<C, X>>>;
  /** Cross-cutting pre-check run before every action's own validation (e.g. "origin is besieged"). */
  guard?(r: ReadCtx<C, X>, seat: PlayerId, a: Action): Violation | null;
  /**
   * Runs after every event and every accepted action, with the events it emitted: victory and
   * elimination checks, relation bookkeeping, siege abandonment, … Never compares `now` with a
   * threshold (§3.1): time-gated conditions are driven by world timers.
   */
  afterStep?(ctx: Ctx<C, X>, step: StepInfo): void;
  /** Relations of a player. Default `std.defaultRelations`: alliance members (`ally`) and pacts. */
  relations?(r: ReadCtx<C, X>, p: PlayerId): readonly Relation[];
  /** Score and ranking (leaderboard, final result). */
  standings(r: ReadCtx<C, X>): Standing[];
  /** Called by the kernel's `match_end` event at `rules.time.matchEnd`. */
  finish(ctx: Ctx<C, X>): MatchResult;
  /** Fog-of-war details; defaults in `std/visibility.ts`. */
  readonly visibility?: Partial<Visibility<C, X>>;
  /** Escape hatch: replace a domain action handler, or handle `ext` actions of extra tools. */
  readonly actions?: Partial<Record<Action["type"], ActionHandler>>;
  /** Also cover the ruleset's own event kinds (§13.3). */
  readonly invariants?: readonly Invariant[];
}

export interface Relation {
  readonly player: PlayerId;
  readonly kind: "ally" | "pact";
  /** Pact expiry; `null` = no expiry. */
  readonly until: GameTime | null;
}

export interface WorldCtx<C> {
  /** uint32 match seed. */
  readonly seed: number;
  /** `p1..pN`. */
  readonly players: readonly PlayerId[];
  readonly config: DeepReadonly<C>;
  readonly rules: DeepReadonly<CompiledRules>;
  /** mulberry32 on stream `${seed}:${stream}`; each name once (§5.2). */
  rng(stream: string): Rng;
}

export interface WorldTimer {
  readonly kind: string;
  /** ≥ 1 (§3.6). Timers after `matchEnd` never fire. */
  readonly at: GameTime;
  readonly ref: string;
}

export interface WorldSetup<X> {
  /** Complete records, ids `i1..` in the ruleset's order. */
  readonly islands: readonly Island[];
  /** Capitals and neutral cities (e.g. the Crown); queues empty. */
  readonly cities: readonly City[];
  readonly ext: X;
  readonly timers: readonly WorldTimer[];
}

export interface DepartureDraft {
  readonly kind: "attack" | "support" | "found" | "spy" | "shipment";
  readonly owner: PlayerId;
  readonly from: CityId;
  /** `null` for found. */
  readonly to: CityId | null;
  /** Target island. */
  readonly island: IslandId;
  /** Found only, when `toolOptions.foundSlot` allows it. */
  readonly slot: number | null;
  readonly units: UnitCounts;
  readonly cargo: Res;
  readonly gold: number;
}

/** `party`: the recorded foe or party, `null` = neutral. `units` may adjust the group (e.g. carriers). */
export type DepartureVerdict =
  | { ok: true; party: PlayerId | null; units?: UnitCounts; warnings?: Violation[] }
  | { ok: false; violation: Violation };

export interface Visibility<C, X> {
  cityAccess(r: ReadCtx<C, X>, viewer: PlayerId, city: CityId): "full" | "public";
  movementAccess(
    r: ReadCtx<C, X>,
    viewer: PlayerId,
    m: MovementId,
  ): "own" | "full" | "incoming" | null;
  /** Extra fields (siege flag, Crown); may depend on the viewer. */
  publicCity(r: ReadCtx<C, X>, viewer: PlayerId, city: CityId): JsonObject;
  /** Public extras only (never raw battle points). */
  publicPlayer(r: ReadCtx<C, X>, p: PlayerId): JsonObject;
  /** E.g. tie-break order, countdowns. */
  publicMatch(r: ReadCtx<C, X>): JsonObject;
  /**
   * Seat-scoped ruleset state for the briefing (§8.2), e.g. the sieges the seat holds and the
   * countdowns it is part of. Optional; default `publicMatch(r)`. Counts in the briefing budget.
   */
  briefing?(r: ReadCtx<C, X>, viewer: PlayerId): JsonObject;
}

export interface StepInfo {
  readonly cause:
    | { kind: "event"; ev: ScheduledEvent }
    | { kind: "action"; seat: PlayerId; action: Action }
    /** Only through the testing kit (§5.3). */
    | { kind: "test" };
  /** Emitted during this step, in order. */
  readonly events: readonly DomainEvent[];
}

export interface Invariant {
  readonly name: string;
  /** Step invariants also run at checkpoints. */
  readonly level: "step" | "checkpoint";
  /** Human-readable violations; empty when fine. */
  check(r: ReadCtx): readonly string[];
}

/** Words a violation or warning code for agents, with numbers and game times. */
export type Explainer = (v: Violation, f: Fmt) => { message: string; hint: string };

/** `Ruleset<unknown, unknown>` (the defaults): the type of the registry's entries. */
export type AnyRuleset = Ruleset;

/** A ruleset's extra agent tool (§3.7). */
export interface ExtraTool {
  /** snake_case; must not collide with `TOOL_NAMES` or another extra (checked by the registry). */
  readonly name: string;
  readonly family: "observe" | "economy" | "military" | "diplomacy";
  readonly description: string;
  /** A `z.object`; must convert with `z.toJSONSchema` to a root `type: "object"` (checked). */
  readonly args: ZodType;
  /** `write` tools become the engine action `{type: "ext", tool, args}`, handled by `hooks.actions.ext`. */
  readonly kind: "read" | "write";
  /** Kind `read`; must be fog-safe. */
  read?(r: ReadCtx, seat: PlayerId, args: unknown): JsonObject;
}

// Structural types shared with core (core cannot import contracts, and they are written in parallel).

export interface Rng {
  /** mulberry32 output, uint32. */
  nextU32(): number;
}

export interface Fmt {
  /** `"D2 14:05"`, `"D2 14:05:30"`. */
  time(t: GameTime): string;
  /** `"1h20m"`, `"45s"`, `"4d 9h58m"`. */
  duration(s: number): string;
}
