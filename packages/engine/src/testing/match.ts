import { idKeyFromSeed } from "@perfidia/engine/core";
import type { AnyRuleset, Ctx, DomainModule } from "@perfidia/engine/contracts";
import {
  ENGINE_VERSION,
  HOUR,
  MatchConfigError,
  createMatch,
  loadMatch,
  resolveConfig,
  rulesHashOf,
  runTestStep,
  stateHash,
  type InvariantLevel,
  type Match,
} from "@perfidia/engine/kernel";
import {
  GameStateSchema,
  PlayerIdSchema,
  SNAPSHOT_FORMAT,
  compareIds,
  type CompiledRules,
  type DomainEvent,
  type GameState,
  type Json,
  type MatchSetup,
  type Snapshot,
} from "@perfidia/protocol";
import { fakeDomain } from "./domain.ts";
import { FIXTURE_REF, fixtureRuleset, type FixtureExt } from "./fixture.ts";
import { buildState, scheduleAt } from "./state.ts";

// Matches for tests (docs/architecture.md §5.3): `matchFromState` wraps a hand-built state in a
// snapshot and loads it; `testStep` edits a match directly; the fixture helpers build the fixture
// ruleset's setups, rules, states and matches.

export interface FromStateOptions {
  /** Default: the state's seed and players, `idKeyFromSeed(seed)`, `overrides`. */
  readonly setup?: MatchSetup;
  readonly overrides?: Readonly<Record<string, Json>>;
  /** Default the testing kit's fake domain. */
  readonly domain?: DomainModule;
  /** Default `step`. */
  readonly invariants?: InvariantLevel;
}

/**
 * Loads a hand-built state as a match: resolves the config, sets `state.ruleset` and
 * `state.configHash` (in a copy), wraps it in a snapshot at its own time and loads it.
 */
export function matchFromState(
  state: GameState,
  ruleset: AnyRuleset,
  o: FromStateOptions = {},
): Match {
  const seats = Object.keys(state.players)
    .toSorted(compareIds)
    .map((id) => ({ id: PlayerIdSchema.parse(id) }));
  const setup: MatchSetup = o.setup ?? {
    ruleset: ruleset.ref,
    overrides: { ...o.overrides },
    seed: state.seed,
    idKey: idKeyFromSeed(state.seed),
    seats,
  };
  const resolved = resolveConfig(ruleset, setup.overrides);
  if (!resolved.ok) throw new MatchConfigError(resolved.errors);
  const rules = ruleset.compile(resolved.config, setup.seats.length);
  const copy = GameStateSchema.parse(state);
  copy.ruleset = ruleset.ref;
  copy.configHash = resolved.hash;
  const snap: Snapshot = {
    format: SNAPSHOT_FORMAT,
    engine: ENGINE_VERSION,
    setup,
    configHash: resolved.hash,
    rulesHash: rulesHashOf(rules),
    hour: Math.floor(copy.now / HOUR),
    t: copy.now,
    afterN: 0,
    hash: stateHash(copy),
    state: copy,
  };
  return loadMatch(snap, ruleset, o.domain ?? fakeDomain, { invariants: o.invariants ?? "step" });
}

/**
 * Runs `edit(ctx)` at `now`, then `afterStep({cause: {kind: "test"}, events})`, the emitted-event
 * check and the step invariants; returns the events emitted. E.g. to edit alliance membership
 * directly and watch a ruleset react.
 */
export function testStep(match: Match, edit: (ctx: Ctx) => void): DomainEvent[] {
  return runTestStep(match, edit);
}

export interface FixtureOptions {
  /** Default 2. */
  readonly players?: number;
  /** Default 7. */
  readonly seed?: number;
  readonly overrides?: Readonly<Record<string, Json>>;
}

/** A setup for the fixture ruleset, with `idKeyFromSeed(seed)`. */
export function fixtureSetup(o: FixtureOptions = {}): MatchSetup {
  const seed = o.seed ?? 7;
  const players = o.players ?? 2;
  return {
    ruleset: FIXTURE_REF,
    overrides: { ...o.overrides },
    seed,
    idKey: idKeyFromSeed(seed),
    seats: Array.from({ length: players }, (_, i) => ({ id: PlayerIdSchema.parse(`p${i + 1}`) })),
  };
}

/** A fixture match on the fake domain; step invariants by default. */
export function fixtureMatch(
  o: FixtureOptions & {
    readonly invariants?: InvariantLevel;
    readonly domain?: DomainModule;
    readonly ruleset?: AnyRuleset;
    readonly traceHashes?: boolean;
  } = {},
): Match {
  return createMatch(fixtureSetup(o), o.ruleset ?? fixtureRuleset, o.domain ?? fakeDomain, {
    invariants: o.invariants ?? "step",
    traceHashes: o.traceHashes ?? false,
  });
}

/** The fixture's compiled rules for N players under these overrides. */
export function fixtureRules(
  players = 2,
  overrides: Readonly<Record<string, Json>> = {},
): CompiledRules {
  const resolved = resolveConfig(fixtureRuleset, overrides);
  if (!resolved.ok) throw new MatchConfigError(resolved.errors);
  return fixtureRuleset.compile(resolved.config, players);
}

/** An empty fixture state (players, two islands, `match_end`), ready for the builders. */
export function fixtureState(
  o: { readonly players?: number; readonly seed?: number; readonly now?: number } = {},
): {
  state: GameState;
  rules: CompiledRules;
} {
  const rules = fixtureRules(o.players ?? 2);
  const now = o.now ?? 0;
  const openAt = fixtureRuleset.defaults.time.openAt;
  const ext: FixtureExt = { opened: now >= openAt, renames: 0 };
  const state = buildState({ rules, players: o.players ?? 2, seed: o.seed ?? 7, now, ext });
  if (now < openAt) scheduleAt(state, rules, "fixture_open", openAt, "");
  return { state, rules };
}
