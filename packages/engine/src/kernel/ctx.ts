import { fnv1a64, streamRng, type OpaqueIdMinter } from "@perfidia/engine/core";
import type { AnyRuleset, Ctx, ReadCtx, Rng } from "@perfidia/engine/contracts";
import type {
  AllianceId,
  CityId,
  CompiledRules,
  DeepReadonly,
  DomainEvent,
  GameState,
  GameTime,
  MatchResult,
  MessageId,
  MovementId,
  PlayerId,
  ProposalId,
  QueueItemId,
  ReportId,
} from "@perfidia/protocol";
import { canonicalCopy, jsonCopy, readonlyView } from "./copy.ts";
import { EngineBug } from "./errors.ts";
import { deepFreeze } from "./freeze.ts";
import { cancelEvent, scheduleEvent } from "./queue.ts";

// The context objects of a step (docs/architecture.md §5.2, §6.4, §6.6).

/** What a `Ctx` needs from its match; kept by the match, never stored in the state. */
export interface CtxEnv {
  readonly rules: DeepReadonly<CompiledRules>;
  readonly config: unknown;
  readonly ruleset: AnyRuleset;
  readonly minter: OpaqueIdMinter;
  /** Stream names already handed out (an in-memory debug set, §5.2); checked only when `strictRng`. */
  readonly streams: Set<string>;
  readonly strictRng: boolean;
  /** Deep-freeze routed events (step invariants). */
  readonly freezeEvents: boolean;
}

/** A read-only view of the live `state`; `now` follows it. Reads never write (§4.3). */
export function makeReadCtx(env: CtxEnv, state: GameState): ReadCtx {
  const view = readonlyView(state);
  return {
    state: view,
    get now() {
      return state.now;
    },
    rules: env.rules,
    config: env.config,
    ruleset: env.ruleset,
    ext: () => view.ext,
  };
}

/** The `rng` service: a fresh mulberry32 on `${seed}:${stream}`, each name once when strict. */
export function takeStream(env: CtxEnv, seed: number, stream: string): Rng {
  if (env.strictRng) {
    if (env.streams.has(stream)) {
      throw new EngineBug(
        "engine",
        `rng("${stream}") requested twice: a stream name must be unique within the match, or it repeats the same draws (§5.2)`,
        { stream },
      );
    }
    env.streams.add(stream);
  }
  return streamRng(seed, stream);
}

function playerNumber(owner: PlayerId): number {
  const n = Number(owner.slice(1));
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new EngineBug("engine", `nextId: "${owner}" is not a player id`, { owner });
  }
  return n;
}

/** The kernel's `Ctx`: the owned draft state plus the services of one step at `now`. */
export class StepCtx implements Ctx {
  readonly state: GameState;
  readonly now: GameTime;
  readonly rules: DeepReadonly<CompiledRules>;
  readonly config: DeepReadonly<unknown>;
  readonly ruleset: AnyRuleset;
  /** The events emitted during this step, in order: parsed copies of the hashed text. */
  readonly events: DomainEvent[] = [];
  private readonly env: CtxEnv;

  constructor(env: CtxEnv, state: GameState) {
    this.env = env;
    this.state = state;
    this.now = state.now;
    this.rules = env.rules;
    this.config = env.config;
    this.ruleset = env.ruleset;
  }

  ext(): unknown {
    return this.state.ext;
  }

  read(): ReadCtx {
    return makeReadCtx(this.env, this.state);
  }

  emit(e: Omit<DomainEvent, "t">): void {
    const event: DomainEvent = { ...e, t: this.now };
    const { text, copy } = canonicalCopy(event);
    this.state.evHash = fnv1a64(`${this.state.evHash}\n${text}`);
    this.events.push(this.env.freezeEvents ? deepFreeze(copy) : copy);
  }

  schedule(kind: string, at: GameTime, ref: string): number {
    return scheduleEvent(this.state, this.rules, kind, at, ref);
  }

  cancel(seq: number): void {
    cancelEvent(this.state, seq);
  }

  nextId(kind: "c"): CityId;
  nextId(kind: "a"): AllianceId;
  nextId(kind: "m", owner: PlayerId): MovementId;
  nextId(kind: "r", owner: PlayerId): ReportId;
  nextId(kind: "q", owner: PlayerId): ProposalId;
  nextId(kind: "g", owner: PlayerId): MessageId;
  nextId(kind: "c" | "a" | "m" | "r" | "q" | "g", owner?: PlayerId): string {
    const ids = this.state.ids;
    if (kind === "c" || kind === "a") {
      ids[kind] += 1;
      return `${kind}${ids[kind]}`;
    }
    if (owner === undefined) {
      throw new EngineBug("engine", `nextId("${kind}") needs the owner of the id`, { kind });
    }
    const counters = ids.own[owner];
    if (counters === undefined) {
      throw new EngineBug("engine", `nextId("${kind}", "${owner}"): ${owner} is not a player`, {
        kind,
        owner,
      });
    }
    counters[kind] += 1;
    return this.env.minter(kind, playerNumber(owner), counters[kind]);
  }

  nextItem(city: CityId): QueueItemId {
    const record = this.state.cities[city];
    if (record === undefined) {
      throw new EngineBug("engine", `nextItem("${city}"): no such city`, { city });
    }
    record.itemSeq += 1;
    return record.itemSeq;
  }

  rng(stream: string): Rng {
    return takeStream(this.env, this.state.seed, stream);
  }

  endMatch(result: MatchResult): void {
    if (this.state.status === "ended") {
      throw new EngineBug("engine", "endMatch called on a match that has already ended", {
        reason: result.reason,
      });
    }
    const copy = jsonCopy(result);
    this.state.status = "ended";
    this.state.result = copy;
    this.emit({
      type: "match_ended",
      public: true,
      to: [],
      data: { reason: copy.reason, winners: copy.winners },
    });
  }
}
