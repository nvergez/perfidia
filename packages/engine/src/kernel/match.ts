import {
  canonicalJson,
  CanonicalJsonError,
  createOpaqueIdMinter,
  HOUR,
} from "@perfidia/engine/core";
import type {
  ActionHandler,
  AnyRuleset,
  Ctx,
  DomainModule,
  Invariant,
  ReadCtx,
  StepInfo,
} from "@perfidia/engine/contracts";
import {
  ActionSchema,
  MatchSetupSchema,
  ViolationSchema,
  compareIds,
  type Action,
  type CompiledRules,
  type DeepReadonly,
  type DomainEvent,
  type GameState,
  type GameTime,
  type Hash64,
  type JsonObject,
  type MatchResult,
  type MatchSetup,
  type MovementId,
  type PlayerId,
  type ScheduledEvent,
  type Sha256,
  type Snapshot,
  type Violation,
  MovementIdSchema,
} from "@perfidia/protocol";
import { MatchConfigError } from "./checks.ts";
import { jsonCopy } from "./copy.ts";
import { resolveConfigFull, rulesHashOf } from "./config.ts";
import { StepCtx, makeReadCtx, type CtxEnv } from "./ctx.ts";
import { EngineBug, EngineMisuse, SnapshotMismatch, asEngineBug, errorMessage } from "./errors.ts";
import { deepFreeze } from "./freeze.ts";
import {
  MintedIds,
  allInvariants,
  checkEvents,
  kernelInvariants,
  runInvariants,
  type InvariantLevel,
} from "./invariants.ts";
import { checkEnvelope, checkRef, copyState, makeSnapshot, stateHash } from "./snapshot.ts";
import { arrivalKind, buildInitialState, checkEventKinds } from "./world.ts";

// The match lifecycle (docs/architecture.md §5.3): creation, loading, `advanceTo` with hourly
// checkpoints, the `apply` pipeline, hashing and snapshots. The kernel receives the ruleset and the
// domain module as arguments and never imports `std`, `domain` or a ruleset.

export interface MatchOptions {
  /** Default `checkpoint`; tests use `step`. */
  invariants?: InvariantLevel;
  /** A full state hash after every applied action (debugging only). */
  traceHashes?: boolean;
}

export interface StepOutput {
  /** Copies (§6.6), in emission order. */
  events: DomainEvent[];
  checkpoints: { hour: number; t: GameTime; h: Hash64 }[];
}

export type ApplyOutput =
  | { ok: true; data: JsonObject; events: DomainEvent[]; warnings: Violation[]; h?: Hash64 }
  | { ok: false; violation: Violation };

export interface Match {
  readonly setup: MatchSetup;
  readonly ruleset: AnyRuleset;
  readonly rules: DeepReadonly<CompiledRules>;
  readonly config: unknown;
  readonly configHash: Sha256;
  readonly rulesHash: Sha256;
  readonly now: GameTime;
  readonly ended: boolean;
  /** A copy of the result once the match has ended. */
  readonly result: MatchResult | null;
  /** Read-only view for the gateway; never hand it to agents. */
  read(): ReadCtx;
  /** The time of the next scheduled event; null once ended. */
  nextEventTime(): GameTime | null;
  /** Runs every event up to `t` with the checkpoints on the way; `t >= now`, else `EngineMisuse`. */
  advanceTo(t: GameTime): StepOutput;
  /** Validates and applies one action at the current `now`. */
  apply(seat: PlayerId, a: Action): ApplyOutput;
  /**
   * The violation `apply(seat, a)` would return at the current `now`, or null when it would be
   * accepted; changes nothing (P3). The same pipeline as `apply` (`hooks.guard`, then the handler's
   * `validate`), guarded the same way: a throw in either is an `EngineBug`. The gateway uses it to
   * name the binding constraint of a `"max"` count that resolves to 0 (§7.4).
   */
  validate(seat: PlayerId, a: Action): Violation | null;
  /** FNV-1a 64 of the canonical state. */
  hash(): Hash64;
  /** A canonical copy, never a reference to the live state. */
  snapshot(afterN: number): Snapshot;
  /** Throws `EngineBug` on any violation. */
  checkInvariants(level: "step" | "checkpoint"): void;
}

interface MatchParts {
  readonly setup: MatchSetup;
  readonly ruleset: AnyRuleset;
  readonly domain: DomainModule;
  readonly rules: DeepReadonly<CompiledRules>;
  readonly config: unknown;
  readonly configHash: Sha256;
  readonly rulesHash: Sha256;
  readonly env: CtxEnv;
  readonly state: GameState;
  readonly minted: MintedIds;
  readonly level: InvariantLevel;
  readonly trace: boolean;
  readonly lastHour: number;
}

function copyViolation(v: Violation, what: string): Violation {
  let copy: unknown;
  try {
    copy = jsonCopy<unknown>(v);
  } catch (error) {
    throw new EngineBug(
      "engine",
      `${what} returned a violation that is not canonical JSON: ${errorMessage(error)}`,
      {},
      error,
    );
  }
  const parsed = ViolationSchema.safeParse(copy);
  if (!parsed.success) {
    throw new EngineBug(
      "engine",
      `${what} returned an invalid violation: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return parsed.data;
}

function isMovementId(s: string): s is MovementId {
  return MovementIdSchema.safeParse(s).success;
}

class KernelMatch implements Match {
  readonly setup: MatchSetup;
  readonly ruleset: AnyRuleset;
  readonly rules: DeepReadonly<CompiledRules>;
  readonly config: unknown;
  readonly configHash: Sha256;
  readonly rulesHash: Sha256;
  private readonly domain: DomainModule;
  private readonly env: CtxEnv;
  private readonly state: GameState;
  private readonly level: InvariantLevel;
  private readonly trace: boolean;
  private readonly invariants: readonly Invariant[];
  /** The last checkpoint hour taken (in memory: it equals `floor(now / 3600)` while running). */
  private lastHour: number;
  /** Set once a step failed: the draft may be half-edited, so the match accepts no further step. */
  private aborted: string | null = null;

  constructor(p: MatchParts) {
    this.setup = p.setup;
    this.ruleset = p.ruleset;
    this.domain = p.domain;
    this.rules = p.rules;
    this.config = p.config;
    this.configHash = p.configHash;
    this.rulesHash = p.rulesHash;
    this.env = p.env;
    this.state = p.state;
    this.level = p.level;
    this.trace = p.trace;
    this.lastHour = p.lastHour;
    this.invariants = allInvariants(kernelInvariants(p.minted), p.domain, p.ruleset);
  }

  get now(): GameTime {
    return this.state.now;
  }

  get ended(): boolean {
    return this.state.status === "ended";
  }

  get result(): MatchResult | null {
    const result = this.state.result;
    return result === null ? null : this.guarded(() => this.canonical(() => jsonCopy(result)));
  }

  read(): ReadCtx {
    return makeReadCtx(this.env, this.state);
  }

  nextEventTime(): GameTime | null {
    if (this.state.status === "ended") return null;
    return this.state.queue[0]?.at ?? null;
  }

  hash(): Hash64 {
    return this.guarded(() => this.canonical(() => stateHash(this.state)));
  }

  snapshot(afterN: number): Snapshot {
    if (!Number.isSafeInteger(afterN) || afterN < 0) {
      throw new EngineMisuse(`snapshot(${afterN}): afterN is the n of a log line, an integer ≥ 0`);
    }
    return this.guarded(() =>
      this.canonical(() =>
        makeSnapshot({
          setup: this.setup,
          configHash: this.configHash,
          rulesHash: this.rulesHash,
          hour: this.lastHour,
          afterN,
          state: this.state,
        }),
      ),
    );
  }

  checkInvariants(level: "step" | "checkpoint"): void {
    this.guarded(() => runInvariants(this.invariants, level, this.read()));
  }

  advanceTo(t: GameTime): StepOutput {
    this.assertUsable("advanceTo");
    if (!Number.isSafeInteger(t) || t < this.state.now) {
      throw new EngineMisuse(
        `advanceTo(${t}) at now = ${this.state.now}: time is an integer and never goes backwards`,
      );
    }
    return this.guarded(() => {
      const state = this.state;
      const out: StepOutput = { events: [], checkpoints: [] };
      while (state.status === "running") {
        const ev = state.queue[0];
        const ck = (this.lastHour + 1) * HOUR;
        if (ev !== undefined && ev.at <= t && ev.at <= ck) {
          state.queue.shift();
          state.now = ev.at;
          out.events.push(...this.runEvent(ev));
        } else if (ck <= t) {
          state.now = ck;
          const h = this.canonical(() => stateHash(state));
          out.checkpoints.push({ hour: this.lastHour + 1, t: ck, h });
          if (this.level !== "off") runInvariants(this.invariants, "checkpoint", this.read());
          this.lastHour += 1;
        } else {
          break;
        }
      }
      if (state.status === "running") state.now = t;
      return out;
    });
  }

  apply(seat: PlayerId, a: Action): ApplyOutput {
    this.assertUsable("apply");
    const checked = this.check("apply", seat, a);
    if (!checked.ok) return checked;
    const { action, handler, plan, warnings } = checked;
    return this.guarded(() => {
      const state = this.state;
      const ctx = new StepCtx(this.env, state);
      const data = asEngineBug(`${action.type}.apply`, () => handler.apply(ctx, seat, plan));
      const copy = asEngineBug(`${action.type}.apply result`, () => jsonCopy(data));
      this.afterStep(ctx, { kind: "action", seat, action });
      this.finishStep(ctx);
      const result: ApplyOutput = { ok: true, data: copy, events: ctx.events, warnings };
      if (this.trace) result.h = this.canonical(() => stateHash(state));
      return result;
    });
  }

  validate(seat: PlayerId, a: Action): Violation | null {
    this.assertUsable("validate");
    const checked = this.check("validate", seat, a);
    return checked.ok ? null : checked.violation;
  }

  /**
   * The validation half of `apply`, which writes nothing: the seat, the action's shape, the match
   * end, elimination, `hooks.guard`, then the handler's `validate`.
   */
  private check(
    what: "apply" | "validate",
    seat: PlayerId,
    a: Action,
  ):
    | { ok: false; violation: Violation }
    | {
        ok: true;
        action: Action;
        handler: ActionHandler;
        plan: unknown;
        warnings: Violation[];
      } {
    const state = this.state;
    const player = Object.hasOwn(state.players, seat) ? state.players[seat] : undefined;
    if (player === undefined)
      throw new EngineMisuse(`${what}: ${seat} is not a seat of this match`);
    const action = parseAction(what, a);
    if (state.status === "ended" || state.now >= this.rules.time.matchEnd) {
      return {
        ok: false,
        violation: { code: "MATCH_ENDED", details: { matchEnd: this.rules.time.matchEnd } },
      };
    }
    if (!player.alive) {
      return {
        ok: false,
        violation: {
          code: "ELIMINATED",
          details: { player: seat, eliminatedAt: player.eliminatedAt },
        },
      };
    }
    return this.guarded(() => {
      const hooks = this.ruleset.hooks;
      const r = this.read();
      if (hooks.guard !== undefined) {
        const guard = hooks.guard.bind(hooks);
        const v = asEngineBug("hooks.guard", () => guard(r, seat, action));
        if (v !== null) return { ok: false, violation: copyViolation(v, "hooks.guard") };
      }
      const handler = this.handlerOf(action);
      if (handler === undefined) {
        const tool = action.type === "ext" ? action.tool : action.type;
        return {
          ok: false,
          violation: { code: "INVALID_ARGS", details: { tool, reason: "no_handler" } },
        };
      }
      const verdict = asEngineBug(`${action.type}.validate`, () =>
        handler.validate(r, seat, action),
      );
      if (!verdict.ok) {
        return {
          ok: false,
          violation: copyViolation(verdict.violation, `${action.type}.validate`),
        };
      }
      const warnings = (verdict.warnings ?? []).map((w) =>
        copyViolation(w, `${action.type}.validate`),
      );
      return { ok: true, action, handler, plan: verdict.plan, warnings };
    });
  }

  /** The testing kit's `testStep` (§5.3): `edit(ctx)` at `now`, `afterStep`, step invariants. */
  testStep(edit: (ctx: Ctx) => void): DomainEvent[] {
    this.assertUsable("testStep");
    return this.guarded(() => {
      const ctx = new StepCtx(this.env, this.state);
      edit(ctx);
      this.afterStep(ctx, { kind: "test" });
      checkEvents(this.ruleset, ctx.events, ctx.now);
      runInvariants(this.invariants, "step", this.read());
      return ctx.events;
    });
  }

  private handlerOf(action: Action): ActionHandler | undefined {
    const override = this.ruleset.hooks.actions?.[action.type];
    if (override !== undefined) return override;
    if (action.type === "ext") return undefined;
    const handler = this.domain.actions[action.type];
    if (handler === undefined) {
      throw new EngineBug("engine", `the domain module has no handler for ${action.type}`);
    }
    return handler;
  }

  private runEvent(ev: ScheduledEvent): DomainEvent[] {
    const ctx = new StepCtx(this.env, this.state);
    asEngineBug(`${ev.kind} handler`, () => this.dispatch(ctx, ev));
    this.afterStep(ctx, { kind: "event", ev });
    this.finishStep(ctx);
    return ctx.events;
  }

  private dispatch(ctx: StepCtx, ev: ScheduledEvent): void {
    const hooks = this.ruleset.hooks;
    if (ev.kind === "match_end") {
      const result = hooks.finish(ctx);
      ctx.endMatch(result);
      return;
    }
    const arrival = arrivalKind(ev.kind);
    if (arrival !== null) {
      const m = ev.ref;
      if (!isMovementId(m)) {
        throw new EngineBug(
          "engine",
          `${ev.kind} (seq ${ev.seq}) refers to "${m}", not a movement id`,
        );
      }
      if (arrival === "attack") hooks.arrive.attack(ctx, m);
      else if (arrival === "spy") hooks.arrive.spy(ctx, m);
      else {
        const own = hooks.arrive[arrival];
        if (own !== undefined) own.call(hooks.arrive, ctx, m);
        else this.domain.arrivals[arrival](ctx, m);
      }
      return;
    }
    const on = hooks.on;
    const hook = on !== undefined && Object.hasOwn(on, ev.kind) ? on[ev.kind] : undefined;
    if (hook !== undefined) {
      hook.call(on, ctx, ev);
      return;
    }
    const handler = Object.hasOwn(this.domain.events, ev.kind)
      ? this.domain.events[ev.kind]
      : undefined;
    if (handler === undefined) {
      throw new EngineBug("engine", `no handler for scheduled event kind ${ev.kind}`, {
        kind: ev.kind,
      });
    }
    handler(ctx, ev);
  }

  private afterStep(ctx: StepCtx, cause: StepInfo["cause"]): void {
    const hooks = this.ruleset.hooks;
    if (hooks.afterStep === undefined || this.state.status !== "running") return;
    const afterStep = hooks.afterStep.bind(hooks);
    const step: StepInfo = { cause, events: ctx.events.slice() };
    asEngineBug("hooks.afterStep", () => afterStep(ctx, step));
  }

  private finishStep(ctx: StepCtx): void {
    if (this.level === "off") return;
    checkEvents(this.ruleset, ctx.events, ctx.now);
    if (this.level === "step") runInvariants(this.invariants, "step", this.read());
  }

  private assertUsable(what: string): void {
    if (this.aborted !== null) {
      throw new EngineMisuse(
        `${what}: the match was aborted by an earlier error (${this.aborted})`,
      );
    }
  }

  /**
   * Runs `fn`, which serialises the state; a state that is not canonical JSON (a stray float, §6.3)
   * is an `EngineBug` of kind `invariant`.
   */
  private canonical<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (!(error instanceof CanonicalJsonError)) throw error;
      const t = this.state.now;
      throw new EngineBug(
        "invariant",
        `the state is not canonical JSON at t = ${t}: ${error.message}`,
        { t },
        error,
      );
    }
  }

  /**
   * Runs `fn` and aborts the match on any error but `EngineMisuse`. Only `EngineMisuse` and
   * `EngineBug` leave the kernel (§5.3): any other error is wrapped in an `EngineBug` of kind
   * `engine`.
   */
  private guarded<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof EngineMisuse) throw error;
      const bug =
        error instanceof EngineBug
          ? error
          : new EngineBug("engine", `the kernel threw ${errorMessage(error)}`, {}, error);
      this.aborted = errorMessage(bug);
      throw bug;
    }
  }
}

/**
 * The action parsed from its canonical text: a deep copy (no handler can keep a reference to the
 * caller's object) whose record keys are in canonical order, as in the logged `act` line, so a live
 * run and its replay hand handlers the same object.
 */
function parseAction(what: "apply" | "validate", a: Action): Action {
  let text: string;
  try {
    text = canonicalJson(a);
  } catch (error) {
    throw new EngineMisuse(`${what}: the action is not canonical JSON (${errorMessage(error)})`);
  }
  const parsed = ActionSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.map((p) => String(p)).join(".") ?? "";
    throw new EngineMisuse(
      `${what}: malformed action (${path === "" ? "" : `${path}: `}${issue?.message ?? "invalid"}); the gateway validates actions before the engine`,
    );
  }
  return parsed.data;
}

function makeEnv(
  ruleset: AnyRuleset,
  rules: DeepReadonly<CompiledRules>,
  config: unknown,
  idKey: string,
  level: InvariantLevel,
): CtxEnv {
  return {
    rules,
    config,
    ruleset,
    minter: createOpaqueIdMinter(idKey),
    streams: new Set<string>(),
    strictRng: level === "step",
    freezeEvents: level === "step",
  };
}

/**
 * Creates a match (§5.3 "Creation"): checks the setup, resolves and compiles the config, runs
 * `createWorld` with every creation check of §3.6, schedules the world timers and `match_end`, and
 * runs the checkpoint invariants. Throws `MatchConfigError` on any failure.
 */
export function createMatch(
  setup: MatchSetup,
  ruleset: AnyRuleset,
  domain: DomainModule,
  opts: MatchOptions = {},
): Match {
  const level = opts.invariants ?? "checkpoint";
  const parsed = MatchSetupSchema.safeParse(setup);
  if (!parsed.success) {
    throw new MatchConfigError(
      parsed.error.issues.map((i) => ({
        path: ["setup", ...i.path.map((p) => String(p))].join("."),
        message: i.message,
      })),
    );
  }
  // Frozen at every invariant level: `Match.setup` is this object, and every snapshot copies it.
  const s = deepFreeze(jsonCopy(parsed.data));
  if (s.ruleset !== ruleset.ref) {
    throw new MatchConfigError([
      {
        path: "setup.ruleset",
        message: `the setup names ${s.ruleset}, the ruleset is ${ruleset.ref}`,
      },
    ]);
  }
  const resolved = resolveConfigFull(ruleset, s.overrides);
  if (!resolved.ok) throw new MatchConfigError(resolved.errors);
  const n = s.seats.length;
  const rules = resolved.compiled.get(n);
  if (rules === undefined) {
    throw new MatchConfigError([
      {
        path: "setup.seats",
        message: `${n} seats; ${ruleset.ref} allows ${resolved.players.min}..${resolved.players.max} players`,
      },
    ]);
  }
  const rulesHash = rulesHashOf(rules);
  if (level === "step") {
    deepFreeze(ruleset);
    deepFreeze(rules);
    deepFreeze(resolved.config);
  }
  const env = makeEnv(ruleset, rules, resolved.config, s.idKey, level);
  const state = buildInitialState({
    setup: s,
    ruleset,
    domain,
    config: resolved.config,
    configHash: resolved.hash,
    rules,
    env,
  });
  const match = new KernelMatch({
    setup: s,
    ruleset,
    domain,
    rules,
    config: resolved.config,
    configHash: resolved.hash,
    rulesHash,
    env,
    state,
    minted: new MintedIds(env.minter),
    level,
    trace: opts.traceHashes ?? false,
    lastHour: 0,
  });
  try {
    match.checkInvariants("checkpoint");
    match.hash();
  } catch (error) {
    const failures =
      error instanceof EngineBug && Array.isArray(error.details["failures"])
        ? error.details["failures"].map((f) => (typeof f === "string" ? f : JSON.stringify(f)))
        : [errorMessage(error)];
    throw new MatchConfigError(failures.map((f) => ({ path: "", message: `initial state: ${f}` })));
  }
  return match;
}

/**
 * Loads a snapshot (§5.3 "Loading"): recomputes the config from `snap.setup`, recompiles with
 * N = the number of seats, and checks the ruleset refs, both hashes, the state schema, `state.ext`
 * against `extSchema` and the state hash. Throws `SnapshotMismatch` naming the field. The rng name
 * set starts empty.
 */
export function loadMatch(
  snap: Snapshot,
  ruleset: AnyRuleset,
  domain: DomainModule,
  opts: MatchOptions = {},
): Match {
  const level = opts.invariants ?? "checkpoint";
  const setup = deepFreeze(checkEnvelope(snap));
  checkRef(snap, setup, ruleset);
  const resolved = resolveConfigFull(ruleset, setup.overrides);
  if (!resolved.ok) {
    throw new SnapshotMismatch(
      "config",
      resolved.errors
        .map((i) => (i.path === "" ? i.message : `${i.path}: ${i.message}`))
        .join("; "),
    );
  }
  if (resolved.hash !== snap.configHash) {
    throw new SnapshotMismatch(
      "configHash",
      `the snapshot has ${snap.configHash}, the setup resolves to ${resolved.hash}`,
    );
  }
  const rules = resolved.compiled.get(setup.seats.length);
  if (rules === undefined) {
    throw new SnapshotMismatch(
      "setup",
      `${setup.seats.length} seats are outside ${ruleset.ref}'s player range`,
    );
  }
  const rulesHash = rulesHashOf(rules);
  if (rulesHash !== snap.rulesHash) {
    throw new SnapshotMismatch(
      "rulesHash",
      `the snapshot has ${snap.rulesHash}, ${ruleset.ref} compiles to ${rulesHash}`,
    );
  }
  const state = copyState(snap);
  if (state.configHash !== resolved.hash) {
    throw new SnapshotMismatch(
      "configHash",
      `the state has ${state.configHash}, the setup resolves to ${resolved.hash}`,
    );
  }
  const ext = ruleset.extSchema.safeParse(state.ext);
  if (!ext.success) {
    const issue = ext.error.issues[0];
    throw new SnapshotMismatch(
      "ext",
      `${issue?.path.map((p) => String(p)).join(".") ?? ""}: ${issue?.message ?? "invalid"}`,
    );
  }
  const hash = stateHash(state);
  if (hash !== snap.hash) {
    throw new SnapshotMismatch(
      "hash",
      `the snapshot says ${snap.hash}, its state hashes to ${hash}`,
    );
  }
  if (state.now !== snap.t)
    throw new SnapshotMismatch("t", `t is ${snap.t}, the state is at ${state.now}`);
  if (state.seed !== setup.seed) {
    throw new SnapshotMismatch("seed", `the state has seed ${state.seed}, the setup ${setup.seed}`);
  }
  const seats = setup.seats.map((x) => x.id).join(",");
  const players = Object.keys(state.players).toSorted(compareIds).join(",");
  if (players !== seats) {
    throw new SnapshotMismatch(
      "players",
      `the state has players ${players}, the setup seats ${seats}`,
    );
  }
  const expectedHour = Math.floor(state.now / HOUR);
  if (snap.hour > expectedHour || (state.status === "running" && snap.hour !== expectedHour)) {
    throw new SnapshotMismatch(
      "hour",
      `hour ${snap.hour} does not fit t = ${state.now} (${state.status})`,
    );
  }
  const kinds = checkEventKinds(
    ruleset,
    domain,
    rules,
    state.queue.map((e) => e.kind),
  );
  if (kinds.length > 0) {
    throw new SnapshotMismatch("queue", kinds.map((i) => i.message).join("; "));
  }
  if (level === "step") {
    deepFreeze(ruleset);
    deepFreeze(rules);
    deepFreeze(resolved.config);
  }
  const env = makeEnv(ruleset, rules, resolved.config, setup.idKey, level);
  return new KernelMatch({
    setup,
    ruleset,
    domain,
    rules,
    config: resolved.config,
    configHash: resolved.hash,
    rulesHash,
    env,
    state,
    minted: new MintedIds(env.minter),
    level,
    trace: opts.traceHashes ?? false,
    lastHour: snap.hour,
  });
}

/**
 * Runs `edit(ctx)` at `now`, then `afterStep({cause: {kind: "test"}, events})`, the emitted-event
 * check and the step invariants, and returns the events. For `@perfidia/engine/testing` only: it
 * edits the state outside the action pipeline and the log, so the kernel barrel does not export it.
 */
export function runTestStep(match: Match, edit: (ctx: Ctx) => void): DomainEvent[] {
  if (!(match instanceof KernelMatch)) {
    throw new EngineMisuse("runTestStep needs a match made by createMatch or loadMatch");
  }
  return match.testStep(edit);
}
