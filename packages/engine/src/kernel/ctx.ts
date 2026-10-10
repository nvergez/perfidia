import { fnv1a64, streamRng, type OpaqueIdMinter } from "@perfidia/engine/core";
import type { AnyRuleset, Ctx, ReadCtx, Rng } from "@perfidia/engine/contracts";
import {
  MatchResultSchema,
  type AllianceId,
  type CityId,
  type CompiledRules,
  type DeepReadonly,
  type DomainEvent,
  type GameState,
  type GameTime,
  type MatchResult,
  type MessageId,
  type MovementId,
  type PlayerId,
  type ProposalId,
  type QueueItemId,
  type ReportId,
} from "@perfidia/protocol";
import { canonicalCopy, jsonCopy, lookup, readonlyView } from "./copy.ts";
import { EngineBug, errorMessage } from "./errors.ts";
import { deepFreeze } from "./freeze.ts";
import { cancelEvent, scheduleEvent } from "./queue.ts";

// The context objects of a step (docs/architecture.md §5.2, §6.4, §6.6).

/** The standard event of the end of a match; only `endMatch` emits it. */
const MATCH_ENDED = "match_ended";

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

  /** §6.4. `match_ended` is the kernel's own event: `endMatch` emits it and `emit` refuses it. */
  emit(e: Omit<DomainEvent, "t">): void {
    if (e.type === MATCH_ENDED) {
      throw new EngineBug(
        "engine",
        "match_ended is emitted by the kernel when ctx.endMatch(result) ends the match; call endMatch instead of emitting it",
      );
    }
    this.route(e);
  }

  /** Serialises once, folds `evHash` and collects the parsed copy (§6.4). */
  private route(e: Omit<DomainEvent, "t">): void {
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

  /**
   * Ends the match: checks `result` (the `MatchResult` schema, `endedAt = now`, winners and
   * standings naming distinct players of the match; `EngineBug` otherwise), stores a copy, sets
   * `status = "ended"` and emits the standard `match_ended` event `{reason, winners}`. The kernel
   * emits that event, exactly once per match: a ruleset never emits it itself (`emit` refuses it).
   * Nothing else is processed afterwards: no `afterStep`, no further event.
   */
  endMatch(result: MatchResult): void {
    if (this.state.status === "ended") {
      throw new EngineBug("engine", "endMatch called on a match that has already ended");
    }
    const copy = this.checkResult(result);
    this.state.status = "ended";
    this.state.result = copy;
    this.route({
      type: MATCH_ENDED,
      public: true,
      to: [],
      data: { reason: copy.reason, winners: copy.winners },
    });
  }

  /** A checked canonical copy of a result (see `endMatch`). */
  private checkResult(result: MatchResult): MatchResult {
    let copy: unknown;
    try {
      copy = jsonCopy<unknown>(result);
    } catch (error) {
      throw new EngineBug(
        "engine",
        `endMatch: the result is not canonical JSON: ${errorMessage(error)}`,
        {},
        error,
      );
    }
    const problems: string[] = [];
    const parsed = MatchResultSchema.safeParse(copy);
    if (!parsed.success) {
      for (const i of parsed.error.issues) {
        const path = i.path.map((p) => String(p)).join(".");
        problems.push(path === "" ? i.message : `${path}: ${i.message}`);
      }
    } else {
      const r = parsed.data;
      if (r.endedAt !== this.now) {
        problems.push(`endedAt is ${r.endedAt}; the match ends now, at ${this.now}`);
      }
      const names = (what: string, players: readonly PlayerId[]): void => {
        const seen = new Set<string>();
        for (const p of players) {
          if (lookup(this.state.players, p) === undefined) {
            problems.push(`${what} names ${p}, who is not a player of this match`);
          } else if (seen.has(p)) {
            problems.push(`${what} names ${p} twice`);
          }
          seen.add(p);
        }
      };
      names("winners", r.winners);
      names(
        "standings",
        r.standings.map((row) => row.player),
      );
      if (problems.length === 0) return r;
    }
    throw new EngineBug("engine", `endMatch: invalid result: ${problems.join("; ")}`, {
      problems,
    });
  }
}
