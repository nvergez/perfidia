# Architecture candidate: Verifiable Event Core (VEC): Perfidia phase-1 engine architecture

> Phase-1 design input, superseded by docs/architecture.md once written.

**Pitch.** A pure, integer-only engine. The state is normalized and JSON-serializable, and changes only in two ways: when the clock reaches a scheduled event in the binary-heap queue, or when a logged command arrives. Every change is checked before it is written (validate builds a plan, then apply runs it). Invariants are checked after it, and the change is fingerprinted with an incremental multiset FNV-1a-64 hash that is cross-checked against a full recompute. Game time and wall time are injected. Lockstep, virtual-time real-time and system-time real-time runs all write the same JSONL log, with hourly checkpoint hashes and optional per-call hashes, and one engine-only replayer verifies all three. Bots are stateless: they rebuild their plan from the briefing, tool results and their own notes on every wake, play only through the gateway's 22 tools, and are deterministic. That makes full re-simulation byte-identical, and the bot runs measure the wake-up rate before any LLM money is spent. The work is cut into 22 tasks that own disjoint files, spread over 9 waves, and each task can be tested on its own.

**Key trade-offs.**

- Lockstep runs seats woken at the same game-second one at a time, in a seeded order. This gives deterministic, immediately applied tool results and reproducible bot matches. The cost is no parallel thinking, so lockstep LLM benchmarks in phase 2 will be slower. The alternative is parallel turns against a snapshot, with actions applied at turn end, at the cost of provisional results.
- In real time, actions apply in arrival order and the log records that order, which keeps feedback immediate and matches 'takes effect when the agent makes it'. A per-second barrier with seeded ordering would be fairer within a second but would delay every tool result by up to one game-second. Replay is unaffected either way, because the log is the order.
- The incremental multiset hash (FNV-1a 64 per entity, summed mod 2^64) makes per-call hashes cheap, so replay can pinpoint the exact divergent call. In exchange, every write must go through store.mut(). A missed mut() is caught because hash() is checked against fullHash() at every step in tests. A weak, non-cryptographic hash is acceptable because nobody is adversarially forging collisions here.
- Fixed-point resources (x3600, so a rate of r/h adds exactly r units per second) make lazy accrual exact and independent of when it is computed. That removes a whole class of replay divergences, at the cost of a scale factor every display and cost path must respect.
- Commands are validated first, producing a plan, then applied without checks. A rejected command is guaranteed to be a no-op without copy-on-write state, at the cost of two code paths per command and the discipline that validate computes every number apply needs.
- Wake scheduling, notes and caps live in the gateway, not the engine. The engine stays pure and agent-agnostic, at the cost of a second piece of state: gateway seat state with its own gwHash, which must go into snapshots and is verified only by full re-simulation.
- Two verification levels: engine replay of logged commands (every run, any clock, browser-runnable), and full byte-identical re-simulation (deterministic agents only: bots in lockstep or under virtual time). Full re-simulation is stronger but cannot cover LLM or system-clock runs.
- No PRNG state is kept in GameState. In-match randomness and seat ordering are derived statelessly from keys such as (seed, t, round, seat), so they are robust to reordering and to resuming from a snapshot. Every random draw needs a stable key, and only world generation and in-turn bot planning use a stream PRNG.
- Strict file ownership across 9 waves, with group barrels exposed as package subpaths, means no merge conflicts and every task can be tested in isolation. In exchange the critical path is longer, and the gateway can import engine internals by subpath (for example @perfidia/engine/economy) instead of only the public barrel.
- Rules are data, compiled to explicit level tables, with formula shorthand expanded at load and the hash taken over the original config. This is deterministic and easy to inspect, but more verbose than formulas. Speed-rule and duration checks fail at rules-load time rather than mid-match.
- The match log embeds the full MatchConfig, rules and policy in its header. Each log is self-contained and its hash can be checked, at the cost of a larger header line compared with referencing an external rules file.
- Bots are stateless across wakes and keep their memory in notes capped at 2,000 chars, like a fresh LLM session per wake. This exercises notes, makes snapshot resume trivial and keeps the wake-rate measurement realistic, but the bots' strategic memory is constrained and must be compact.

---

# Perfidia phase 1: "Verifiable Event Core" architecture

Status: design proposal for phase 1 of `docs/brief.md` ("Engine only… a 7-game-day match runs without errors in both clocks and replays identically").
Repository state when this was written: only `CLAUDE.md` and `docs/brief.md` exist. `docs/game-rules.md` and `docs/architecture.md` are referenced by CLAUDE.md but do not exist yet. Game numbers are therefore treated as data (a `RulesConfig`), and this spec does not decide any balance values.

Design angle: robustness and verifiability first. Every claim of "deterministic" or "identical" below comes with a mechanism that checks it.

---

## 0. Principles (enforced, not aspirational)

| #   | Principle                                                                                                                                                                                                                           | Enforcement                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | `GameState` (engine) is the only source of truth. Views, briefings and summaries are pure projections of it.                                                                                                                        | Gateway has no game state of its own; only seat-level memory (notes, wake bookkeeping), which is hashed separately.                     |
| P2  | State changes only through `advanceTo(t)` (scheduled events) and `submit(seat, cmd, t)` (logged commands). Reads never write.                                                                                                       | `Store` API: reads return `DeepReadonly<…>`; writes need `store.mut(...)`. Property test: hash is unchanged by any query or projection. |
| P3  | Validate, then apply. `validate` reads only and returns a plan holding every computed number; `apply` does no checks and cannot fail. A rejected command is a no-op.                                                                | Property test: rejected command leaves hash unchanged. If `apply` throws, it is an engine bug and the match is aborted.                 |
| P4  | Integers only. Fractions use fixed point: resources ×3600, ratios in basis points (bps, 1/10 000) or ppm.                                                                                                                           | Architecture test greps the engine for forbidden tokens. Invariant check: every number in state is a safe integer.                      |
| P5  | Time is injected. The engine never reads a clock, and drivers read wall time from an injected `TimeSource`.                                                                                                                         | Engine tsconfig has no DOM/Bun/Node types; forbidden-token test; `Bun.build --target=browser` of the engine in CI.                      |
| P6  | Fog-safe by construction. Command validation may read only the actor's own state plus public state; projection only reveals what the seat is entitled to.                                                                           | Non-interference property test: changing hidden state does not change the view, the briefing or error texts.                            |
| P7  | Two verification levels. **Level E** (engine replay of logged commands) applies to every run. **Level G** (full re-simulation, byte-identical log) applies to deterministic agents (bots under lockstep or virtual-time real-time). | `sim verify` and `sim verify --resim`; golden logs in CI.                                                                               |

---

## 1. Packages, layout, dependency rules

Dependency direction: `protocol ← engine ← gateway ← bots ← sim`. Bots may import from the engine **only** `@perfidia/engine/core` (PRNG and hash utilities), never state or simulation code. An architecture test enforces this.

```
package.json            workspaces + catalog (zod, fast-check) + overrides typescript@7.0.2 + scripts
bunfig.toml
tsconfig.base.json      strict, noUncheckedIndexedAccess, verbatimModuleSyntax, isolatedModules, module/moduleResolution for bundler, noEmit
tests/architecture.test.ts   import-direction, purity greps, browser-bundle check of engine
docs/architecture.md    this document
packages/
  protocol/src/  ids.ts time.ts rules.ts policy.ts match.ts state.ts commands.ts events.ts errors.ts
                 tools.ts views.ts briefing.ts log.ts snapshot.ts agent.ts index.ts
  engine/src/    version.ts index.ts
    core/        int.ts prng.ts hash.ts canonical.ts heap.ts ids.ts index.ts
    state/       store.ts contracts.ts queue.ts accrual.ts hasher.ts invariants.ts snapshot.ts index.ts
    rules/       default.ts compile.ts validate.ts derived.ts hash.ts index.ts
    world/       generate.ts place.ts names.ts initial.ts index.ts
    economy/     build.ts recruit.ts cancel.ts transport.ts afford.ts pop.ts index.ts
    military/    launch.ts arrive.ts combat.ts spy.ts found.ts conquest.ts recall.ts index.ts
    diplomacy/   messages.ts proposals.ts alliances.ts relations.ts index.ts
    scoring/     points.ts leaderboard.ts victory.ts index.ts
    sim/         simulation.ts commands.ts dispatch.ts queries.ts domain-invariants.ts replay.ts index.ts
  gateway/src/   index.ts
    format/      time.ts numbers.ts index.ts
    seat/        state.ts caps.ts notes.ts index.ts
    wake/        scheduler.ts triggers.ts index.ts
    clock/       types.ts time-map.ts virtual.ts order.ts lockstep.ts realtime.ts index.ts
    view/        project.ts knowledge.ts briefing.ts observe.ts errors.ts archive.ts index.ts
    tools/       ctx.ts registry.ts prechecks.ts observe.ts economy.ts military.ts diplomacy.ts memory.ts turn.ts index.ts
    runtime/     host.ts session.ts log.ts create.ts result.ts index.ts
  bots/src/      bot.ts registry.ts index.ts
    strategies/  common.ts memory.ts builder.ts raider.ts expander.ts diplomat.ts index.ts
  sim/src/       cli.ts index.ts
    io/          jsonl.ts layout.ts snapshots.ts system-clock.ts index.ts
    summary/     metrics.ts table.ts index.ts
    verify/      verify.ts diff.ts index.ts
    run/         config.ts run.ts golden.ts index.ts
  sim/test/      exit-criterion.test.ts determinism.test.ts golden.test.ts perf.test.ts
  sim/fixtures/golden/*.jsonl
```

**Exports.** `engine` and `gateway` declare `".": "./src/index.ts"` and `"./*": "./src/*/index.ts"` (group barrels). `bots` declares `"."` and `"./strategies"`. `protocol` and `sim` declare `"."` only. Group barrels let later waves import finished groups (for example `@perfidia/engine/economy`) before the top barrel exists. Each barrel has exactly one owning task (see §12).

**Responsibilities**

- **protocol**: Zod schemas and inferred types for ids, time constants, `RulesConfig`, `GatewayPolicy`, `MatchConfig`, `GameState` (the snapshot format), engine `Command`s, `DomainEvent`s, `ErrorCode` and per-code `RejectDetails`, the 22 tool argument and result schemas, views and briefing, log lines, snapshot files, plus type-only `SeatAgent`/`TurnContext`. No logic beyond schemas and constants.
- **engine**: deterministic simulation; also the Level-E replayer (`replay.ts`), so the browser can replay later. Has no I/O, no clock and no logging.
- **gateway**: player boundary. Owns fog-of-war projection, briefings, the 22 tool handlers, prechecks, caps, notes and archive search, translation of engine rejections into explanatory errors, the wake scheduler, the clock drivers (against injected time sources) and the `MatchHost` that wires engine, gateway, log sink and agents. It contains no LLM code and makes no `setTimeout` or `Date` calls (time sources are injected), so it is browser-safe as well.
- **bots**: `SeatAgent` implementations that use only `TurnContext.roundTrip(toolCalls)`.
- **sim**: Bun CLI with the `run`, `verify`, `summary` and `golden` commands; file I/O (JSONL, snapshots); a `SystemClock` built on `performance.now`/`setTimeout`; end-to-end tests.

**Purity enforcement (`tests/architecture.test.ts`, owned by T00)**

1. `package.json` dependencies and actual `import ... from "@perfidia/..."` statements follow the direction rules above.
2. `packages/engine/src/**` (non-test files) contains none of: `Math.random`, `Date`, `performance`, `setTimeout`, `setInterval`, `queueMicrotask`, `process.`, `Bun.`, `require(`, `from "node:`, `from "bun`, `console.`, `localeCompare`, `toLocale`, `Intl`, `parseFloat`, `toFixed`, `Number.EPSILON`, `Object.keys(`, `Object.values(`, `Object.entries(`, `for (const … in`, `.sort()` with no comparator, or `**`. `Math.` is allowed only in `core/int.ts`.
3. `packages/gateway/src/**` and `packages/bots/src/**`: none of `Math.random`, `Date`, `Intl`, `toLocale`, `localeCompare`, `process.`, `Bun.`. Error and briefing text gets logged and compared, so it must be locale-independent.
4. `Bun.build({ entrypoints: ["packages/engine/src/index.ts"], target: "browser" })` succeeds.
5. Self-test: each grep rule is shown to fire on an inline fixture string.

Engine `tsconfig.json`: `lib: ["ES2023"]`, `types: []`, excludes `**/*.test.ts`. A sibling `tsconfig.test.json` includes the tests with Bun types. Without DOM or Bun types, `setTimeout`, `performance` and `console` fail to typecheck in engine sources.

---

## 2. State model

### 2.1 Ids (protocol `ids.ts`)

Ids are short, stable, prefix plus a 1-based counter, allocated from `meta.counters` and never reused:

| Entity          | Prefix | Example |
| --------------- | ------ | ------- |
| Player / seat   | `p`    | `p3`    |
| City            | `c`    | `c12`   |
| Island          | `i`    | `i7`    |
| Movement        | `mv`   | `mv41`  |
| Queue item      | `q`    | `q90`   |
| Report          | `r`    | `r17`   |
| Message         | `msg`  | `msg88` |
| Alliance        | `a`    | `a2`    |
| Pact (NAP)      | `pa`   | `pa4`   |
| Proposal        | `pr`   | `pr5`   |
| Scheduled event | `e`    | `e1234` |

TypeScript types are template-literal types (`type CityId = \`c${number}\``) with regex-checked Zod schemas. T01 chooses the Zod 4 mechanism (`z.templateLiteral`if it is available in the installed Zod, otherwise a regex plus a type-predicate transform).`compareIds(a, b)` (engine core) orders by prefix, then numerically (`p2 < p10`). It is the only ordering used for iteration.

`BuildingId`, `UnitId` and resource names are strings declared by the rules and validated against the compiled rules at runtime.

### 2.2 `GameState` (protocol `state.ts`; Zod schema = snapshot format)

```ts
type GameTime = number; // integer game-seconds since match start
type ResVec = number[]; // length = rules.resources.kinds.length (3); fixed point: 1 resource = RES_FP = 3600
type UnitCounts = Record<UnitId, number>; // iterate in rules unit order, never Object.keys

interface GameState {
  v: 1; // state schema version
  meta: {
    now: GameTime;
    endsAt: GameTime;
    ended: boolean;
    seq: number; // scheduled-event insertion counter (tie-breaker)
    counters: Record<IdPrefix, number>; // next id per prefix
    lastCheckpointHour: number;
    result: MatchResult | null;
    ledger: { initial: ResVec; produced: ResVec; spent: ResVec; refunded: ResVec; wasted: ResVec }; // FP units, global
  };
  players: Record<PlayerId, Player>;
  islands: Record<IslandId, Island>;
  cities: Record<CityId, City>;
  movements: Record<MovementId, Movement>;
  events: Record<EventId, ScheduledEvent>; // canonical store; the heap is a derived index
  alliances: Record<AllianceId, Alliance>;
  pacts: Record<PactId, Pact>;
  proposals: Record<ProposalId, Proposal>;
  archive: { messages: Record<MessageId, Message>; reports: Record<ReportId, Report> }; // append-only, immutable entries
}

interface Player {
  id;
  name;
  alive: boolean;
  eliminatedAt: GameTime | null;
  alliance: AllianceId | null;
  stats: {
    recruited: UnitCounts;
    lost: UnitCounts;
    killed: UnitCounts;
    battles: number;
    conquests: number;
    foundings: number;
  };
}
interface Island {
  id;
  name;
  x: number;
  y: number;
  slots: number;
} // integer map coordinates
interface City {
  id;
  name;
  owner: PlayerId | null;
  island: IslandId;
  slot: number;
  foundedAt: GameTime;
  res: ResVec;
  resAt: GameTime; // lazy accrual anchor
  buildings: Record<BuildingId, number>; // levels
  buildQueue: BuildItem[];
  recruitQueue: RecruitItem[]; // [0] is in progress
  units: UnitCounts; // home units of the owner
  stationed: { owner: PlayerId; origin: CityId; units: UnitCounts }[]; // support from others, sorted by (owner, origin)
  siege: { by: PlayerId; endsAt: GameTime; event: EventId } | null;
}
interface BuildItem {
  id: QueueItemId;
  building: BuildingId;
  level: number;
  cost: ResVec;
  pop: number;
  duration: number;
  startAt: GameTime | null;
  endAt: GameTime | null;
  event: EventId | null;
}
interface RecruitItem {
  id: QueueItemId;
  unit: UnitId;
  count: number;
  cost: ResVec;
  pop: number;
  duration: number;
  startAt: GameTime | null;
  endAt: GameTime | null;
  event: EventId | null;
}
interface Movement {
  id;
  owner: PlayerId;
  kind: "attack" | "support" | "spy" | "transport" | "settle" | "return";
  from: CityId;
  to: CityId | null;
  site: { island: IslandId; slot: number } | null; // site for settle
  units: UnitCounts;
  cargo: ResVec;
  spyGold: number;
  departAt: GameTime;
  arriveAt: GameTime;
  event: EventId;
  returnOf: MovementId | null;
}
interface ScheduledEvent {
  id: EventId;
  at: GameTime;
  cls: number;
  seq: number;
  kind: EventKind;
  ref: string /* entity id */;
  sub?: string /* e.g. queue item id */;
}
interface Message {
  id;
  from: PlayerId;
  to: PlayerId[];
  at: GameTime;
  text: string;
}
interface Report {
  id;
  kind: "battle" | "spy" | "found" | "conquest" | "diplomacy";
  at: GameTime;
  parties: PlayerId[];
  city: CityId | null;
  data: ReportData;
}
interface Alliance {
  id;
  name: string;
  members: PlayerId[] /* sorted */;
  foundedAt: GameTime;
}
interface Pact {
  id;
  a: PlayerId;
  b: PlayerId /* a < b */;
  since: GameTime;
}
interface Proposal {
  id;
  from: PlayerId;
  to: PlayerId;
  kind: "alliance" | "nap";
  text: string;
  at: GameTime;
  expiresAt: GameTime;
  event: EventId;
}
```

**Rule: derived data is never stored.** Production rates, storage caps, population cap and used population, points and slot occupancy are always computed from stored facts (building levels, units, queues, cities) through `rules/derived.ts`. The one controlled exception is the immutable cost, pop and duration snapshot inside queue items, which pins the price paid at enqueue time.

### 2.3 Lazy resource accrual (exact, path-independent)

Rates are whole resources per game hour (integers derived from building levels and bps bonuses). Stock is held in fixed point with `RES_FP = 3600`, so `r` resources per hour adds exactly `r` FP units per second:

```ts
// state/accrual.ts. Rates >= 0, cap in FP.
export function accrue(stock: number, ratePerHour: number, cap: number, dt: number): number {
  if (stock >= cap) return stock; // over cap (e.g. warehouse lost): no growth, no loss
  return Math.min(cap, stock + ratePerHour * dt); // via int helpers in real code
}
export function projectCity(city: Ro<City>, rates: ResVec, caps: ResVec, now: GameTime): ResVec; // pure read
export function materialize(store: Store, cityId: CityId, rates: ResVec, caps: ResVec): void; // write; adds to ledger.produced
```

Because rates are non-negative and the cap is monotone, `accrue(accrue(s,a),b) === accrue(s,a+b)` for any split. (I checked this numerically during design with 100k random cases; it becomes property test S3.) So **when** the engine materializes cannot change the results. Materialization still only happens in `apply` and event handlers, before any change to rates, stock or caps of that city. Displayed amount = `floor(fp / 3600)`. Time until affordable = `ceilDiv(missingFp, rate)` seconds, which is exact.

### 2.4 Versioning

- `ENGINE_VERSION` (engine `version.ts`, semver). Bump the minor version for any change that alters simulation results; the golden tests force this.
- `STATE_FORMAT = 1`, `LOG_FORMAT = "perfidia-log/1"`, `SNAPSHOT_FORMAT = "perfidia-snapshot/1"` (protocol constants).
- `rulesHash = fnv64(canonical(rulesConfig))`, `policyHash`, and `configHash` (whole `MatchConfig`). These are stored in the log header and in every snapshot. Replay refuses a mismatched `engineVersion` or `rulesHash` unless `--force`, and with `--force` it still reports the mismatch.

---

## 3. Event queue and simulation core

### 3.1 Scheduled event kinds and ordering classes

| cls       | kind                 | ref                    | Notes                                                                            |
| --------- | -------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| (virtual) | checkpoint           | —                      | Not stored. Taken at each hour boundary **before** anything else at that second. |
| 1         | `build_done`         | city, sub = queue item | Economy settles first.                                                           |
| 2         | `recruit_done`       | city, sub = item       |                                                                                  |
| 3         | `arrive` (return)    | movement               | Returning troops are home before a battle in the same second.                    |
| 4         | `arrive` (transport) | movement               |                                                                                  |
| 5         | `arrive` (support)   | movement               | Supports arriving in the same second defend.                                     |
| 6         | `arrive` (spy)       | movement               |                                                                                  |
| 7         | `arrive` (attack)    | movement               | Battle.                                                                          |
| 8         | `arrive` (settle)    | movement               | Found a city.                                                                    |
| 9         | `siege_end`          | city                   | Only if `rules.conquest.mode = "siege"`.                                         |
| 10        | `proposal_expire`    | proposal               |                                                                                  |
| 15        | `match_end`          | —                      | Scheduled at `endsAt`, or at `now` on domination.                                |

**Total order:** `(at, cls, seq)`. `seq` is a unique, monotonically increasing insertion counter in `meta`, so the order is total and deterministic, and it does not depend on heap layout. **Commands submitted at second `t` are applied after all events at `t`.** No duration may be 0 (rules validation enforces `≥ 1`), so a command at `t` can only schedule events at `≥ t+1`. Events created by events (for example a conquest started by a battle) may be scheduled at `t` and run in the same `advanceTo` loop, because their `seq` is larger.

### 3.2 Indexed binary heap

`core/heap.ts` is a generic indexed min-heap: `push(id, key)`, `peek()`, `pop()`, `remove(id)` (O(log n)) and `has(id)`. The comparator compares `(at, cls, seq)`. `state/queue.ts` keeps the heap in sync with `state.events`:

```ts
export interface EventQueue {
  schedule(
    store: Store,
    e: { at: GameTime; kind: EventKind; ref: string; sub?: string; cls?: number },
  ): EventId; // assigns id, seq, cls
  cancel(store: Store, id: EventId): void; // removes from state.events and from the heap; throws if missing
  peek(): Ro<ScheduledEvent> | undefined;
  popDue(store: Store, upTo: GameTime): Ro<ScheduledEvent> | undefined;
  rebuild(state: Ro<GameState>): void; // on snapshot load; result is independent of insertion history
}
```

**Cancellation is real removal, not tombstones**, so the stored state never contains dead events (invariant: each pending event's `ref` exists and points back to it):

- `cancel_queue` on a non-head item: remove it from the array, refund `cost × rules.queues.cancelRefundBps.queued`, no event involved.
- `cancel_queue` on the head item: cancel its event, refund `inProgress` bps, then start the next item (`startAt = now`, `endAt = now + duration`, schedule its event).
- `recall_troops` on an outbound movement (inside `rules.movement.recallWindowSeconds` when set, and before arrival): cancel its `arrive` event, turn it into `kind:"return"` with `arriveAt = now + (now − departAt)`, and schedule a new event (cls 3).
- `recall_troops` on stationed support: remove the stack and create a `return` movement with the full travel time.
- Conquest: queues of the conquered city are cancelled without refund. Outbound movements from that city follow `rules.conquest.outboundOnLoss`. Proposals expire normally.

Only the head of each queue has an event. Estimated completion times of later items are computed on read (sum of durations).

### 3.3 Engine API (engine `sim/simulation.ts`, exported from `@perfidia/engine`)

```ts
export type InvariantLevel = "off" | "checkpoint" | "step";
export interface SimOptions {
  invariants: InvariantLevel;
  traceHashes: boolean;
} // tests: step + true

export function createSimulation(cfg: EngineConfig, opts?: Partial<SimOptions>): Simulation;
export function loadSimulation(
  snap: EngineSnapshot,
  cfg: EngineConfig,
  opts?: Partial<SimOptions>,
): Simulation; // verifies snap.hash

export interface Simulation {
  readonly now: GameTime;
  readonly endsAt: GameTime;
  readonly ended: boolean;
  readonly rules: RulesIndex;
  readonly state: Ro<GameState>; // read-only view for projections
  readonly q: Queries; // pure reads at `now`
  nextEventTime(): GameTime; // min(next scheduled event, endsAt); always > now after advanceTo(now)
  nextCheckpointTime(): GameTime; // (lastCheckpointHour + 1) * 3600
  advanceTo(t: GameTime): StepOutput; // t >= now, else throws EngineMisuse; clamps to endsAt
  submit(seat: PlayerId, cmd: Command, at: GameTime): SubmitOutput; // at MUST equal now (caller asserts its notion of time)
  hash(): Hash64; // incremental
  fullHash(): Hash64; // recompute from scratch (must equal hash())
  snapshot(): EngineSnapshot; // { format, engineVersion, rulesHash, hash, state } in canonical form
}
export interface StepOutput {
  events: DomainEvent[];
  checkpoints: Checkpoint[];
  processed: number;
}
export interface Checkpoint {
  hour: number;
  at: GameTime;
  hash: Hash64;
}
export type SubmitOutput =
  | { ok: true; data: CommandOk; events: DomainEvent[]; hash?: Hash64 }
  | { ok: false; reject: EngineReject };
export interface EngineReject {
  code: ErrorCode;
  details: RejectDetails[ErrorCode];
} // numbers only; no prose
```

`EngineConfig = { seed: string; durationSeconds: number; rules: RulesConfig; world: WorldParams; seats: { id: PlayerId; name: string }[] }`, the engine subset of `MatchConfig`.

`advanceTo` algorithm:

```
assert safeInt(t) && t >= now
target = min(t, endsAt)
loop:
  ck  = (lastCheckpointHour + 1) * 3600
  top = queue.peek()
  if ck <= target && (top == null || ck <= top.at):
      now = ck; lastCheckpointHour++; out.checkpoints.push({hour, at: ck, hash: hash()})
      invariants("checkpoint"); continue
  if top && top.at <= target:
      queue.popDue(); now = top.at; dispatch(top, emit); invariants("step"); out.processed++; continue
  break
now = target
```

Checkpoint `H` therefore describes the state after everything strictly before second `H·3600`. Commands at second `T` require `advanceTo(T)` first, so they always come after checkpoint `T`. The definition does not depend on the clock driver.

`submit`: if `at !== now`, throw `EngineMisuse`. If `ended`, reject `MATCH_ENDED`. Otherwise `validate` (authoritative), then on success `apply`, then post-hooks (betrayal detection, elimination and victory checks), then `invariants("step")`, then optional `hash()`. Engine errors fall into three classes: **player errors** are returned as data; **`EngineMisuse`** (a driver bug) and **`InvariantViolation`** (an engine bug) are thrown and abort the match.

### 3.4 Domain module contract (engine `state/contracts.ts`; generic over the rules type so W3 tasks share it)

```ts
export type Ro<T> = DeepReadonly<T>;
export interface ReadState {
  readonly s: Ro<GameState>;
  city(id: CityId): Ro<City> | undefined /* … per collection */;
}
export interface Store extends ReadState {
  mut<C extends Coll>(c: C, id: IdOf<C>): EntityOf<C>; // marks "c/id" dirty for hashing and incremental invariants
  insert<C extends Coll>(c: C, e: EntityOf<C>): void;
  remove<C extends Coll>(c: C, id: IdOf<C>): void;
  meta(): GameState["meta"]; // marks meta dirty
  nextId<P extends IdPrefix>(p: P): IdOf<P>;
  readonly queue: EventQueue;
}
export type Emit = (e: DomainEvent) => void;
export type Validation<P> =
  | { ok: true; plan: P }
  | { ok: false; code: ErrorCode; details: unknown };
export interface CommandModule<C extends Command, P, R> {
  validate(r: ReadState, rules: R, seat: PlayerId, cmd: C, now: GameTime): Validation<P>;
  apply(st: Store, rules: R, seat: PlayerId, plan: P, now: GameTime, emit: Emit): CommandOk;
}
export type EventHandler<R> = (st: Store, rules: R, ev: Ro<ScheduledEvent>, emit: Emit) => void;
```

### 3.5 Queries (engine `sim/queries.ts`, pure)

`resources(city)` (projected display units), `rates(city)`, `caps(city)`, `pop(city) → {used, cap}`, `queueEtas(city)`, `travelSeconds(from, to, units, kind)`, `affordableAt(city, cost) → GameTime | null`, `maxAffordable(city, unit)`, `points(player)`, `leaderboard()`, `messagesFor(seat, since)`, `reportsFor(seat, filter)`, `proposalsFor(seat)`, `relation(a, b) → "self"|"ally"|"nap"|"none"`, `freeSlots(island)`, `citiesOf(player)`, `movementsOf(player)`, `incomingTo(player)`. Queries return the **truth**; the gateway projection decides what each seat may see.

---

## 4. Determinism toolkit (engine `core/`)

**Integers (`int.ts`):** `assertSafeInt`, `ceilDiv`, `floorDiv`, `mulDiv(a, b, c, "floor"|"ceil")` (number path when `|a·b| ≤ 2^53`, otherwise an exact BigInt path, which is deterministic either way), `bps(x, b)`, `isqrt(n)` (integer Newton, exact), `clamp`, `dist(x1,y1,x2,y2) = isqrt(dx²+dy²)`. This is the only engine file allowed to use `Math.*`.

**PRNG (`prng.ts`): xoshiro128\*\*** (32-bit operations only, `Math.imul` and `>>>`, 128-bit state). Seeding uses a SplitMix32-style generator (Weyl step `0x9E3779B9` plus murmur3 `fmix32`) from the 64-bit hash of `(matchSeed, streamName)`. An all-zero state is rejected. API: `createRng(seedHash, stream)`, `nextU32`, `uniformInt(n)` (rejection sampling, no modulo bias), `pick`, `shuffle` (Fisher–Yates). Stream PRNG is used only for **world generation** and **bot planning within one turn**.

**Keyed (counter-based) randomness:** `keyedU32(seedHash, ...parts)` = `fmix32` of the low word of `fnv64(seedHash ‖ parts)`. It is stateless, so a value depends only on its key, never on history. It is used for lockstep seat order per tick, bot RNG seeding per turn, simulated latency, and any future in-match randomness (keyed by event id). **No PRNG state lives in `GameState`.**

**Canonical JSON (`canonical.ts`):** object keys sorted by UTF-16 code unit, no whitespace, numbers must be safe integers (throws on floats, NaN, ±Infinity; `-0` is written as `0`), `undefined` is an error, arrays keep their order. JSON escaping is identical to `JSON.stringify` for strings.

**Hash (`hash.ts`): FNV-1a 64** over UTF-8 bytes (inline encoder), offset `0xcbf29ce484222325`, prime `0x100000001b3 = 2^40 + 435`. It is implemented without BigInt as two uint32 words, with every intermediate value exact below 2^53:

```ts
lo = (lo ^ byte) >>> 0;
const p = lo * 435; // < 2^41
const nlo = p >>> 0;
const nhi = (hi * 435 + Math.floor(p / 4294967296) + ((lo << 8) >>> 0)) >>> 0; // x·2^40 contributes lo<<8 to hi
hi = nhi;
lo = nlo;
```

I checked this against a BigInt reference: `""→cbf29ce484222325`, `"a"→af63dc4c8601ec8c`, `"foobar"→85944171f73967e8`, plus a random differential run. `Hash64` is a 16-character lowercase hex string. `sum64`/`sub64` do add and subtract mod 2^64 on (hi, lo) pairs.

**Incremental state hash (`state/hasher.ts`):**

- `entityHash(coll, id, e) = fnv64(coll + "/" + id + "\u0000" + canonical(e))`.
- `stateHash = fnv64(canonical(meta) + "\u0000" + hex(Σ entityHash mod 2^64) + "\u0000" + entityCount)`, a multiset sum.
- `Store.mut/insert/remove` record dirty keys. `hash()` subtracts the cached old hash of each dirty key and adds the new one, at O(dirty) cost. Archive entries are hashed once on insert.
- `fullHash()` recomputes everything. In tests (`invariants: "step"`) the engine asserts `hash() === fullHash()` at every checkpoint, and property tests assert it after every step. A missing `mut` call therefore cannot go unnoticed.
- Gateway seat state has its own `gwHash = fnv64(canonical(seatStates))`.

**Iteration rules:** never iterate a `Record` with `Object.*`/`for…in`. Use `sortedIds(record)` from `core/ids.ts`, or the rules order for units, buildings and resources. Every `sort` takes a total comparator. Use no `Map`/`Set` iteration in game logic unless insertion order is itself deterministic and documented. Use no locale-sensitive APIs anywhere in engine, gateway or bots.

---

## 5. Action pipeline

```
SeatAgent ──roundTrip(calls[])──▶ TurnSession (gateway runtime)
   ├─ turn active? RT cap? calls-per-RT cap? match ended? seat alive?       → GameError (by: gateway)
   ├─ registry[tool].args.safeParse(args)                                     → INVALID_ARGS (Zod path in message)
   ├─ prechecks against the seat's VIEW: ids known (hidden == nonexistent),
   │   ownership, batch size, messages/day, note size                          → GameError (by: gateway)
   ├─ toCommand(): normalize (named resources → ResVec, "max" → number via q.maxAffordable)
   ├─ sim.submit(seat, cmd, now)  — engine validate (authoritative) → plan → apply → domain events
   │      reject {code, details}  → view/errors.ts → fog-safe {ok:false, code, message, hint, details} (by: engine)
   ├─ result data projected for the seat
   └─ log `call` line (args, cmd, ok/code, by, h?) ; wake.ingest(events)
```

**Error format** (protocol `errors.ts`): `{ ok: false, code: ErrorCode, message: string, hint: string, details?: Record<string, number | string> }`. `message` says what is wrong and `hint` says how to fix it, both with numbers. Bots read `details` and never parse prose. Example:

```json
{
  "ok": false,
  "code": "INSUFFICIENT_RESOURCES",
  "message": "Cannot queue barracks level 4 in c12: missing 120 wood and 30 stone.",
  "hint": "At current production (+180 wood/h, +60 stone/h) it is affordable at D2 14:40 (in 40m). Storage cap 2,000 is enough.",
  "details": {
    "missingWood": 120,
    "missingStone": 30,
    "affordableAt": 139200,
    "affordableIn": 2400
  }
}
```

`ErrorCode` (closed enum): `INVALID_ARGS, UNKNOWN_ID, NOT_YOURS, TURN_NOT_ACTIVE, TURN_ENDED, ROUND_TRIP_CAP, CALLS_PER_ROUND_TRIP_CAP, BATCH_TOO_LARGE, MATCH_ENDED, SEAT_ELIMINATED, INSUFFICIENT_RESOURCES, EXCEEDS_STORAGE, INSUFFICIENT_POPULATION, REQUIREMENT_MISSING, MAX_LEVEL, QUEUE_FULL, QUEUE_ITEM_NOT_FOUND, INSUFFICIENT_UNITS, NO_UNITS, TRANSPORT_CAPACITY, TARGET_IS_OWN_CITY, TARGET_INVALID, SLOT_TAKEN, SETTLER_REQUIRED, NOT_RECALLABLE, ALREADY_ARRIVED, NOTHING_STATIONED, MESSAGE_TOO_LONG, MESSAGE_CAP, NOTE_TOO_LONG, PROPOSAL_NOT_FOUND, ALREADY_ALLIED, ALLIANCE_FULL, NOT_IN_ALLIANCE, PACT_NOT_FOUND, WAKE_TOO_SOON, WAKE_AFTER_END, INTERNAL`. Protocol defines a typed `RejectDetails` per code. Stale-state errors carry times, for example `INSUFFICIENT_UNITS {unit, requested, home, awayUntil}` gives "40 hoplites requested, 0 at home: they left at D3 14:02 and return at D3 16:10".

**Fog-safe validation rule:** whether a command is valid may depend only on the actor's own state and public state (map, owners, points, alliances, free slots). For example, `send_resources` to a full warehouse is accepted, and the overflow is wasted on arrival and reported to the sender. Each `RejectDetails` field is tagged `own`/`public`, and `view/errors.ts` drops anything else. Non-interference tests (§11) enforce this.

**High-level actions** (prefix semantics, deterministic and explainable):

- `build({ city, buildings: BuildingId[] })` (≤ `policy.turn.maxBatchItems`): queue the longest valid prefix in the given order. The result is `{ok:true, data:{queued:[{item, building, level, endAt}], stoppedAt?:{index, error}}}`; if nothing could be queued it is `ok:false`. Duplicates queue successive levels.
- `recruit({ city, units: [{unit, count: number | "max"}] })`: same prefix semantics, one queue item per entry. The gateway resolves `"max"` and the log stores the resolved number.
- Every other mutating tool maps to exactly one engine command.

**Engine commands** (protocol `commands.ts`, discriminated on `type`): `build`, `recruit`, `cancel_queue {city, item}`, `send_resources {from, to, res}`, `attack {from, to, units}` (conquest when the units include `rules.conquest.unit`), `support {from, to, units}`, `spy {from, to, gold}`, `recall_troops {movement} | {city, origin}`, `found_city {from, island, slot, units}`, `send_message {to[], text}`, `propose_alliance {to, kind:"alliance"|"nap", text}`, `answer_proposal {proposal, accept}`, `leave_alliance {pact?}`. Messages and diplomacy go through the engine because they are world history (archives, spectators, betrayal detection).

**Domain events** (protocol `events.ts`; each has `at` and an audience `to: PlayerId[]`, and some have `public: true`): `build_done{queueEmpty}`, `recruit_done{queueEmpty}`, `movement_launched{movement, mkind, owner, from, to, arriveAt, targetOwner}`, `movement_recalled`, `support_arrived`, `resources_delivered{wasted}`, `battle{report, winner}`, `spy_report{success}`, `city_founded`, `city_conquered`, `player_eliminated`, `message`, `proposal`, `proposal_answered`, `alliance_changed`, `pact_changed`, `betrayal{attacker, victim, via}` (attack or spy launched against an ally or pact partner; public), `match_end{winner, reason}`.

---

## 6. Gateway

### 6.1 Projection (`view/project.ts`, `view/knowledge.ts`)

`projectView(state: Ro<GameState>, rules: RulesIndex, seat: PlayerId, now: GameTime): PlayerView` is pure.

| Knowledge level | Content                                                                                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Public**      | Map (islands, coordinates, slots, free slots), every city's owner, name, island and points, players' names, points and city counts, alliances and pacts, leaderboard.        |
| **Own**         | Everything about the seat's cities (projected resources, rates, caps, pop, queues with ETAs, home units, stationed support), its movements, reports, messages and proposals. |
| **Incoming**    | Movements targeting own cities, per `rules.visibility.incoming` (default: attacks and supports visible with origin, owner and `arriveAt`; units hidden; spies invisible).    |
| **Intel**       | Latest spy or battle report about a foreign city, shown with its age ("as of D2 10:00"). Allies get only public data by default (`rules.visibility.allyShares`).             |

### 6.2 Briefing (`view/briefing.ts`)

Compact JSON, deterministic, aiming at ≤ 400 tokens for a 3-city seat (test: `ceil(chars / 3.5) ≤ 600` on the fixture):

```json
{
  "t": "D3 14:02",
  "now": 223320,
  "left": "3d 9h58m",
  "turn": 17,
  "wake": ["incoming_attack mv41", "message msg88", "queue_done c12"],
  "cities": [
    {
      "id": "c12",
      "isl": "i7",
      "res": [1520, 800, 240],
      "cap": 2000,
      "rate": [180, 120, 40],
      "pop": [310, 400],
      "bq": ["barracks4 D3 15:10"],
      "rq": ["hoplite×20 D3 16:00"],
      "u": { "hoplite": 40, "slinger": 10 },
      "sup": 2
    }
  ],
  "moves": [
    { "id": "mv41", "k": "attack", "from": "c3/p2", "to": "c12", "at": "D3 15:02", "in": "1h0m" }
  ],
  "msgs": [{ "id": "msg88", "from": "p2", "at": "D3 13:55", "text": "…(≤400 chars)" }],
  "dipl": {
    "alliance": "a2:[p4]",
    "nap": ["p5"],
    "proposals": [{ "id": "pr5", "from": "p6", "kind": "nap" }]
  },
  "notes": "…notebook…",
  "budget": { "rt": 8, "calls": 10, "wakesLeftToday": 5 }
}
```

Resource arrays follow the order in `rules.resources.kinds`, which the `rules` tool documents. Times use the deterministic format `D{day} HH:MM` (D1 00:00 = t 0), and relative durations look like `1h20m`. Formatting lives in `format/` and uses no `Intl`.

### 6.3 Tools (names exactly as in the brief; registry in `tools/registry.ts`)

| Family    | Tool               | Mutates | Args (summary)                                                                                                                   |
| --------- | ------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Observe   | `view_city`        | –       | `{city}`: full view if own, public + intel otherwise                                                                             |
|           | `view_island`      | –       | `{island}`: slots, cities, owners, points, travel time from the seat's nearest city                                              |
|           | `view_map`         | –       | `{near?: CityId, radius?: number}`                                                                                               |
|           | `view_player`      | –       | `{player}`: public profile + relation to the caller                                                                              |
|           | `leaderboard`      | –       | `{}`                                                                                                                             |
|           | `rules`            | –       | `{section?}`: machine-readable rules and formulas                                                                                |
| Economy   | `build`            | engine  | `{city, buildings[]}`                                                                                                            |
|           | `recruit`          | engine  | `{city, units:[{unit, count}]}`                                                                                                  |
|           | `cancel_queue`     | engine  | `{city, item}`                                                                                                                   |
|           | `send_resources`   | engine  | `{from, to, resources:{wood?, stone?, gold?}}`                                                                                   |
| Military  | `attack`           | engine  | `{from, to, units}`                                                                                                              |
|           | `support`          | engine  | `{from, to, units}`                                                                                                              |
|           | `spy`              | engine  | `{from, to, gold}`                                                                                                               |
|           | `recall_troops`    | engine  | `{movement} \| {city, origin}`                                                                                                   |
|           | `found_city`       | engine  | `{from, island, slot, units}`                                                                                                    |
| Diplomacy | `send_message`     | engine  | `{to: PlayerId[], text}`                                                                                                         |
|           | `propose_alliance` | engine  | `{to, kind, text?}`                                                                                                              |
|           | `answer_proposal`  | engine  | `{proposal, accept}`                                                                                                             |
|           | `leave_alliance`   | engine  | `{pact?}`                                                                                                                        |
| Memory    | `write_note`       | gateway | `{text, mode?: "replace" \| "append"}`                                                                                           |
|           | `read_notes`       | –       | `{search?: {query, kinds?: ("messages"\|"reports")[], with?: PlayerId, since?: GameTime, limit?}, open?: MessageId \| ReportId}` |
| Turn      | `end_turn`         | gateway | `{wakeAt?: GameTime, wakeIn?: number}`: sets the next self-wake; must be the last call of its round trip                         |

```ts
// tools/ctx.ts
export interface ToolCtx {
  sim: Simulation;
  rules: RulesIndex;
  policy: GatewayPolicy;
  seat: PlayerId;
  seatState: SeatState;
  now: GameTime;
  turn: { index: number; rt: number; call: number };
}
export interface ToolSpec<N extends ToolName> {
  name: N;
  family: ToolFamily;
  mutates: "engine" | "gateway" | "none";
  args: z.ZodType<ToolArgs<N>>;
  handle(
    ctx: ToolCtx,
    args: ToolArgs<N>,
  ): { result: ToolResult<N>; cmd?: Command; events?: DomainEvent[]; by?: "gateway" | "engine" };
}
```

Handlers never throw on player input. A fuzz test with `fc.anything()` as args covers every tool.

**Archive search** (`view/archive.ts`): case-insensitive substring match over message text and deterministic report summaries the seat is party to. Results are newest first by `(at, id)`, at most `policy.archive.maxResults` (20), each a 160-character excerpt; `open` returns one full item. The brief names no archive tool (principle 5 mentions `battle_history`), so search goes into `read_notes` for now (see open question Q3).

### 6.4 Caps and seat state (`seat/`)

`GatewayPolicy` (protocol `policy.ts`, hashed into the header). Defaults:

```
turn:     { roundTrips: 8, callsPerRoundTrip: 10, maxBatchItems: 10, turnTimeoutMs: 300000 }
messages: { perGameDay: 20, maxChars: 1000, maxRecipients: 11 }
notes:    { maxChars: 2000 }
archive:  { maxResults: 20, excerptChars: 160 }
briefing: { maxMessages: 10, maxMessageChars: 400, maxEvents: 20 }
wake:     { safetyIntervalSeconds: 43200, groupWindowSeconds: 600, dailyBudget: 8, urgentDailyCap: 24,
            minSelfWakeDelaySeconds: 900, maxTurnsPerSeatPerTick: 3 }
```

`SeatState = { seat, notes, inbox: Notification[], cursors: {messages, reports}, caps: {day, messagesSent}, wake: SeatWakeState, turns: number }`. It is serializable, lives in snapshots and is hashed into `gwHash`. `write_note` over the limit fails with `NOTE_TOO_LONG` and numbers ("would be 2,340 chars, limit 2,000: remove 340").

### 6.5 Wake scheduler (`wake/scheduler.ts`, pure and deterministic)

```ts
export interface WakeScheduler {
  ingest(events: readonly DomainEvent[], now: GameTime): void; // via triggers.ts mapping
  request(
    seat: PlayerId,
    at: GameTime,
    now: GameTime,
  ): { ok: true; at: GameTime; note?: string } | GameError; // end_turn
  nextWakeTime(): GameTime | undefined;
  due(now: GameTime): PlayerId[]; // pending.at <= now, not in turn, alive; sorted by compareIds
  begin(seat: PlayerId, now: GameTime): WakeRecord; // consumes pending; returns reasons, urgent flag; accounts budget
  end(seat: PlayerId, now: GameTime): void; // safetyAt = now + 43200; urgent-during-turn → pending at now
  deferTo(seat: PlayerId, at: GameTime): void; // lockstep per-tick turn cap overflow
  snapshot(): SeatWakeState[];
}
```

Triggers (`triggers.ts`):

| Domain event                                        | Seat                                    | Reason            | Urgent |
| --------------------------------------------------- | --------------------------------------- | ----------------- | ------ |
| `movement_launched`, kind attack, visible to target | target owner                            | `incoming_attack` | yes    |
| `city_conquered`                                    | previous owner                          | `city_lost`       | yes    |
| `message`                                           | recipients                              | `message`         | no     |
| `proposal`, `proposal_answered`                     | addressee / proposer                    | `proposal`        | no     |
| `build_done`/`recruit_done` with `queueEmpty`       | owner                                   | `queue_done`      | no     |
| `battle`, `spy_report`                              | parties (not already woken by incoming) | `report`          | no     |
| `alliance_changed`, `pact_changed`                  | members / parties                       | `diplomacy`       | no     |

Per-seat algorithm (`pending: {at, reasons[], urgent} | null`):

1. **Urgent trigger at `e`:** if the seat is in a turn, set `urgentAfterTurn`; otherwise `pending.at = min(pending.at, e)` and mark urgent. Exempt from the daily budget up to `urgentDailyCap` per game day; beyond that it is downgraded to non-urgent (anti-abuse).
2. **Non-urgent trigger at `e`:** if today's budget (`floor(t / 86400)`) is exhausted, keep the reason for the next briefing and schedule nothing. Otherwise `pending.at = min(pending?.at ?? ∞, e + groupWindow)`, adding the reason. Close events thus group into one wake.
3. **Self wake (`end_turn`):** `at ≥ now + minSelfWakeDelay` and `≤ endsAt` (else `WAKE_TOO_SOON`/`WAKE_AFTER_END` with numbers). It is non-urgent and counted when it fires. If the budget is exhausted, it is accepted with a note naming the safety-wake time.
4. **Safety:** `pending.at = min(pending.at, lastTurnEnd + 43200)`; exempt from the budget.
5. **One turn at a time:** a seat in a turn is never due. At turn end, `urgentAfterTurn` makes the seat due at `now`.
6. **Start:** every seat gets `pending = {at: 0, reasons: ["start"]}`.

Properties tested: at most `dailyBudget` non-urgent wakes per seat per day; no seat goes more than 12 h without a wake while alive and the match runs; an urgent trigger produces a wake at `e` or at turn end; triggers inside the group window produce one wake.

---

## 7. Clocks

### 7.1 Interfaces (`clock/types.ts`)

```ts
export interface TimeSource {
  nowMs(): number;
} // integer, monotonic
export interface TimerHost {
  setTimer(atMs: number, cb: () => void): number;
  clearTimer(id: number): void;
}
export interface Rational {
  num: number;
  den: number;
} // game-seconds per wall-second, e.g. {3,1}
export interface LatencyModel {
  roundTripMs(seat: PlayerId, turn: number, rt: number): number;
}

export interface ClockHost {
  // implemented by runtime/host.ts (MatchHost)
  readonly now: GameTime;
  readonly endsAt: GameTime;
  readonly ended: boolean;
  readonly seedHash: Hash64;
  nextDueTime(): GameTime; // min(sim.nextEventTime, wake.nextWakeTime, sim.nextCheckpointTime, endsAt)
  advanceTo(t: GameTime): void; // engine step → wake.ingest → log ckpt/ev lines
  dueSeats(t: GameTime): PlayerId[];
  openTurn(seat: PlayerId, ord: { round: number; index: number }): TurnSession; // briefing + `wake` log line
  deferTo(seat: PlayerId, t: GameTime): void;
  finish(): MatchResult; // writes `end` line
}
export interface TurnSession {
  readonly seat: PlayerId;
  readonly turn: number;
  readonly briefing: Briefing;
  readonly limits: TurnLimits;
  roundTrip(calls: readonly ToolCall[]): readonly ToolResult[]; // SYNCHRONOUS critical section at host.now
  close(outcome: TurnOutcome | { error: string }): void; // `turn_end` line; wake.end
}
export interface ClockDriver {
  run(host: ClockHost, agents: ReadonlyMap<PlayerId, SeatAgent>): Promise<MatchResult>;
}
```

`TurnSession.roundTrip` is synchronous, so a group of calls is atomic with respect to the JS event loop. Real-time concurrency therefore needs no mutex, and calls are ordered by the order in which they reach the engine.

`SeatAgent`/`TurnContext` (protocol `agent.ts`, type-only):

```ts
export interface TurnContext {
  readonly seat: PlayerId;
  readonly turn: number;
  readonly briefing: Briefing;
  readonly limits: { roundTrips: number; callsPerRoundTrip: number };
  roundTrip(calls: readonly ToolCall[]): Promise<readonly ToolResult[]>;
}
export interface TurnOutcome {
  readonly thought: string;
}
export interface SeatAgent {
  readonly controller: string /* "bot:raider@1" */;
  takeTurn(ctx: TurnContext): Promise<TurnOutcome>;
}
```

### 7.2 Lockstep (`clock/lockstep.ts`)

Game time jumps from one due time to the next and stops while seats think. Seats woken at the same second play **serially** in a seeded order. Each call applies immediately, so later seats see earlier seats' effects:

```
host.advanceTo(0)
while !host.ended:
  t = host.now; round = 0; turns = Map<seat, n>
  loop:
    due = host.dueSeats(t).filter(s => (turns[s] ?? 0) < policy.wake.maxTurnsPerSeatPerTick)
    if due.empty: break
    order = sortBy(due, s => [keyedU32(seedHash, "order", t, round, s), s])        // clock/order.ts
    for (index, seat) in order:
      session = host.openTurn(seat, {round, index})
      ctx = { …session, roundTrip: async calls => session.roundTrip(calls) }        // resolves at time t
      session.close(await agents[seat].takeTurn(ctx).catch(toFailure)); turns[seat]++
    round++
  for s in host.dueSeats(t): host.deferTo(s, t + 1)                                // per-tick cap overflow
  host.advanceTo(host.nextDueTime())                                               // strictly > t
return host.finish()
```

The seeded order is recorded: `wake` lines carry `ord:[round, index]` and every call has a global sequence `n`. An urgent wake caused during the tick (for example B attacked A in round 0) runs in round 1 at the same `t`. If an agent throws, the turn ends with that error recorded. In `strict` mode (tests) the run fails instead.

### 7.3 Real-time (`clock/realtime.ts`)

`gameAt(ms) = max(host.now, floor((ms − t0) · num / (1000 · den)))` and `wallAt(g) = t0 + ceilDiv(g · 1000 · den, num)`, both through int helpers. Seats act asynchronously, and actions land at the current game time.

```
t0 = time.nowMs(); host.advanceTo(0); pump()
pump():                                   // timer callback; synchronous
  host.advanceTo(min(gameAt(time.nowMs()), endsAt))
  if host.ended: return endMatch()
  for seat in host.dueSeats(host.now) (compareIds order): startTurn(seat, index = arrival order)
  timer = timers.setTimer(wallAt(host.nextDueTime()), pump)
startTurn(seat):
  s = host.openTurn(seat, {round: 0, index})
  ctx.roundTrip = async calls => { await sleep(latency.roundTripMs(seat, s.turn, rt));
                                   if host.ended return calls.map(MATCH_ENDED)
                                   host.advanceTo(min(gameAt(nowMs), endsAt)); r = s.roundTrip(calls); rescheduleSoon(); return r }
  withTimeout(agent.takeTurn(ctx), policy.turn.turnTimeoutMs).then(s.close, e => s.close({error})).finally(rescheduleSoon)
endMatch(): await all in-flight turns (their further calls get MATCH_ENDED) → host.finish()
```

Same-second ordering in real time is **arrival order through the synchronous critical section**, recorded as `n`. Replay never depends on this order being reproducible, because the log is the order (see Q1). If the event loop lags, game time jumps: events still resolve at their own timestamps, actions land at `now`, and lag is recorded in metrics.

### 7.4 Time sources and fast tests

- `VirtualClock` (`clock/virtual.ts`): implements `TimeSource & TimerHost` plus `sleep(ms)`. Timers are ordered by `(atMs, insertionSeq)`. `run()` loops: `await yieldMacrotask()` (injected, for example `() => new Promise(r => setTimeout(r, 0))` from sim), then pop the earliest timer, set `nowMs`, call it. One macrotask yield drains every microtask chain, so in-process agents (bots) interleave deterministically. **Deadlock detector:** if no timer is pending while turns are in flight after a yield, throw `VirtualTimeDeadlock`. This means an agent awaited something virtual time does not drive (for example real I/O); virtual time is only valid for in-process agents. With seeded `LatencyModel` (e.g. 2–60 s per round trip), a 7-game-day real-time match at speed 3 runs in seconds and is **reproducible** (Level G).
- `SystemClock` (sim `io/system-clock.ts`): `performance.now()` floored plus `setTimeout`. Used for smoke runs at high speed (`86400/1`: one game day ≈ 1 wall-second; `100800/1`: 7 days ≈ 6 s).
- Driver unit tests use a scripted `FakeHost`: mapping is monotone (property), wakes fire at `wallAt(t)`, two seats can be in turns concurrently, one turn per seat, urgent wake after a turn, match end with in-flight turns, turn timeout, deadlock detection.

### 7.5 Why both clocks replay identically

Both drivers talk only to `ClockHost`, and `MatchHost` writes the same log lines in both modes. A `call` line carries `g` (game second applied) and `n` (global order). A `ckpt` line carries the engine hash after everything before `g`. The Level-E replayer (§8) uses only `config`, `cmd`, `g` and `n`, so it does not care which clock produced the log.

---

## 8. Match log and replay

### 8.1 Files (`sim/io/layout.ts`)

`<out>/match.jsonl` (authoritative), `<out>/summary.json`, `<out>/snapshots/h0024.json` (cadence configurable, default every 24 game hours plus final; `--snapshot-every 1` for hourly), `<out>/events.jsonl` (optional, all domain events, for debugging).

### 8.2 Line kinds (protocol `log.ts`; one JSON object per line; keys starting with `wall` are informational and excluded from comparison)

```jsonc
{"k":"header","format":"perfidia-log/1","engineVersion":"0.1.0","rulesHash":"…","policyHash":"…","configHash":"…",
 "config":{ /* full MatchConfig incl. rules, policy, world, seats with controller ids, seed, durationSeconds */ },
 "clock":{"kind":"lockstep"} | {"kind":"realtime","speed":[3,1],"time":"virtual"|"system","latency":[2000,60000]},
 "initialHash":"…","wallStart":"2026-10-10T12:00:00Z"}
{"k":"wake","g":0,"seat":"p3","turn":1,"ord":[0,4],"reasons":["start"],"urgent":false}
{"k":"call","n":17,"g":0,"seat":"p3","turn":1,"rt":2,"tool":"build","args":{…},"cmd":{…},"r":{"ok":true},"h":"…"}
{"k":"call","n":18,"g":0,"seat":"p3","turn":1,"rt":2,"tool":"attack","args":{…},"cmd":{…},"r":{"ok":false,"code":"INSUFFICIENT_UNITS","by":"engine"}}
{"k":"call","n":19,"g":0,"seat":"p3","turn":1,"rt":2,"tool":"write_note","args":{…},"r":{"ok":true,"by":"gateway"}}
{"k":"obs","n":20,"g":0,"seat":"p3","turn":1,"rt":3,"tool":"view_city","args":{"city":"c12"},"ok":true,"bytes":812}
{"k":"turn_end","g":0,"seat":"p3","turn":1,"rts":3,"calls":9,"next":7200,"why":"end_turn","thought":"…"}
{"k":"ev","g":5400,"e":{"kind":"battle", …}}           // notable public-relevant domain events only
{"k":"ckpt","g":3600,"hour":1,"h":"…","gw":"…","events":42}
{"k":"end","g":604800,"h":"…","gw":"…","result":{"winner":"p4","reason":"time","standings":[…]}}
{"k":"fatal","g":…,"error":{"kind":"invariant"|"engine"|"driver"|"agent","message":"…","details":{…}}}
```

`cmd` is present exactly when the call reached the engine (engine-accepted or engine-rejected). `h` (post-call incremental hash) appears when `traceHashes` is on (default on). Notable `ev` kinds are battle, city_founded, city_conquered, betrayal, alliance_changed, pact_changed, player_eliminated and match_end. They let `summary` work from `match.jsonl` alone, and Level E compares them too. Expected size for a 12-player, 7-day bot match: 15–40k lines, at most about 10 MB.

### 8.3 Replay verification

**Level E**: engine `sim/replay.ts` (pure, browser-runnable) plus `sim/verify` (files):

```ts
export interface ReplayInput {
  config: EngineConfig;
  initialHash: Hash64;
  calls: Iterable<{
    n: number;
    g: GameTime;
    seat: PlayerId;
    cmd: Command;
    r: { ok: boolean; code?: ErrorCode };
    h?: Hash64;
  }>;
  checkpoints: Iterable<{ hour: number; h: Hash64 }>;
  notable: Iterable<{ g: GameTime; e: DomainEvent }>;
  end?: { g: GameTime; h: Hash64 };
}
export interface ReplayReport {
  ok: boolean;
  calls: number;
  checkpoints: number;
  firstDivergence?: {
    kind: "initial" | "order" | "checkpoint" | "call_result" | "call_hash" | "event" | "end";
    g: GameTime;
    n?: number;
    hour?: number;
    expected: string;
    actual: string;
  };
  finalHash: Hash64;
}
export function replay(
  input: ReplayInput,
  opts?: { invariants?: InvariantLevel; from?: EngineSnapshot },
): ReplayReport;
```

Algorithm: build the initial state and compare `initialHash`. Then, for each `cmd` call in `n` order (assert `g` is non-decreasing): `advanceTo(g)`, compare emitted checkpoints and notable events with the expected streams, `submit`, compare `ok`/`code`, and compare `h` if present. Finally `advanceTo(end.g)` and compare remaining checkpoints, `ended` and the final hash. The report names the first mismatch. With per-call `h` that is the exact call; without it, the hour.

**Level G** (`sim verify --resim`): rebuild agents from the header (`controller` ids plus bot version, seed, clock and latency model), re-run, and compare the normalized log line by line: parse, drop `wall*` keys, canonicalize. Applies to lockstep and to real-time with virtual time.

**Snapshot seek:** `verify --from h072` loads `snapshots/h0072.json` (engine plus gateway state, `hour`, `afterN` = last applied call `n`), then replays calls with `n > afterN`. Property tested: resuming from a snapshot gives the same final hash as an uninterrupted run.

**Divergence diagnosis:** `verify --dump` writes the actual state at the first divergent checkpoint, and `verify/diff.ts` prints a structural JSON-path diff against the nearest saved snapshot.

**Golden discipline:** any result-changing commit either fixes a regression or bumps `ENGINE_VERSION` and regenerates goldens (`sim golden --update`). A golden failure with an unchanged version means an unintended behaviour change.

---

## 9. Bots

Bots are stateless across wakes, like an LLM session: everything they remember goes through `write_note` (compact JSON ≤ 2,000 chars). This exercises notes and makes snapshot resume trivial. The only thing allowed to outlive a turn is a cache that can be re-derived from the rules (keyed by `rulesHash`).

```ts
// bots/strategies/common.ts
export interface StrategyInput {
  seat: PlayerId;
  briefing: Briefing;
  observed: ObservationCache;
  memory: BotMemory;
  rng: Rng;
  round: number;
  rules: RulesView;
}
export interface StrategyStep {
  calls: ToolCall[];
  done: boolean;
  memory?: BotMemory;
  thought?: string;
}
export interface Strategy {
  readonly name: "builder" | "raider" | "expander" | "diplomat";
  step(i: StrategyInput): StrategyStep;
}
// bots/bot.ts
export function createBot(strategy: Strategy, matchSeed: string): SeatAgent; // controller "bot:<name>@<BOT_VERSION>"
```

The runner works in rounds. Round 0 observes (`rules` once per rules hash, `view_city` for own cities, `view_map`/`leaderboard` when memory is older than about 24 game hours). Round 1 or more acts. The last round does `write_note` and then `end_turn`. It respects `limits` (≤ 8 round trips, ≤ 10 calls each), never throws on `{ok:false}`, and reacts to `details` (for example it re-plans using `affordableIn`). RNG is `createRng(keyedU32(seed, seat, briefing.now, turn))`, so behaviour is a pure function of (briefing, results, notes, seed).

| Strategy                   | Behaviour (all parameters seeded and jittered)                                                                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **builder** (turtle)       | Economy first (production, warehouse, population), then wall and defensive units sized to its points. Accepts all alliances and pacts and never attacks. On an incoming attack it recruits `max` defense and messages allies asking for `support`.                                               |
| **raider**                 | Barracks and harbor early, then attackers and transports. Target is the nearest non-allied city with the lowest points/intel ratio. Spies first when gold allows. Attacks when estimated attack ≥ 1.5× estimated defense; recalls if a later spy report shows a stronger defense. Raids to loot. |
| **expander**               | Prioritizes settlers and `found_city` on free slots of the nearest islands, then conquest of weak neighbours (attack including the conquest unit).                                                                                                                                               |
| **diplomat** (opportunist) | On day 1, proposes NAPs or alliances to every neighbour and sends tribute to the strongest. On a seeded day (3–5) it picks the weakest ally, attacks it and leaves the alliance in the same turn (a betrayal event), while messaging "we remain friends".                                        |

These strategies exist to stress the rules: every tool gets used, conquests and betrayals happen, wake reasons vary, and the bots behave like LLMs on the wake-up rate (they schedule self-wakes on queue ETAs).

---

## 10. `sim` CLI (Bun; `bun run sim -- <cmd>`; flags parsed with `node:util` `parseArgs`, which I confirmed is available in Bun 1.4.3)

```
run     --seed <str>            (required; echoed in header)
        --players 12 --islands 40 --days 7
        --clock lockstep|realtime   --time virtual|system   --speed 3 | 5/2
        --latency 2000-60000        (virtual real-time only; seeded per seat/turn/rt)
        --bots builder,raider,expander,diplomat   (cycled over seats)  | --seat p3=raider (repeatable)
        --rules <file.json> --policy <file.json> --no-domination
        --out runs/<seed>-<clock>   --invariants off|checkpoint|step (default checkpoint)
        --snapshot-every <hours> (default 24) --trace-hashes (default on) --events --json --quiet
verify  <dir|match.jsonl> [--from h072] [--resim] [--invariants step] [--dump] [--force]
summary <dir|match.jsonl> [--json]
golden  --check | --update
```

Exit codes: `0` ok · `1` replay divergence · `2` fatal (invariant, engine or driver error) · `3` usage or config error (explanatory message).

**Summary** (`summary/metrics.ts`, a pure fold over log lines, plus `summary.json` and a text table):

- winner and victory reason; final points, cities and alive flag per seat; battles, conquests, foundings, alliances formed/left, pacts, betrayals
- **wake-ups per seat per game day**, split by reason and urgent/normal, with budget-suppressed and deferred counts
- round trips and calls per wake (mean and p95), rejections by code and by `gateway`/`engine`
- messages per seat per day
- engine events processed, turns, simulation wall time, events/s, peak RSS, log size

It also prints an LLM-load estimate: `seats × days × wakes/day × RT/wake`. This is the number phase 2 uses for the cost model in the brief.

---

## 11. Testing strategy (bun:test + fast-check)

Tests sit next to code as `*.test.ts`, plus end-to-end tests in `packages/sim/test/`. Long tests set explicit per-test timeouts (Bun's default per-test timeout is short). `PERFIDIA_SLOW=1` enables the heavy variants. Root scripts: `bun test` (fast suite), `bun run test:exit` (exit criterion, slow variants included).

**Unit tests:** int helpers (rounding modes, BigInt path), every rules-derived function, each command's validate and apply against small hand-built states, combat table cases, travel times, formatting, wake scheduler scenarios, tool handlers.

**Differential tests:** FNV-1a 64 and xoshiro128** against slow BigInt reference implementations written in the test; `mulDiv` against BigInt; `isqrt` against BigInt square root for random values below 2^52.

**Property tests (fast-check):**

| id  | Property                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1  | Random command and time-advance sequences (mostly valid commands generated from the current state, plus junk) with `invariants:"step"` never break an invariant and never throw (except `EngineMisuse` on deliberately wrong input). |
| S2  | A rejected command leaves `fullHash` unchanged; `validate` never changes `fullHash`.                                                                                                                                                 |
| S3  | Accrual is path-independent; materialization points never change outcomes.                                                                                                                                                           |
| S4  | `hash() === fullHash()` after every step.                                                                                                                                                                                            |
| S5  | Snapshot round trip: save → JSON → load → same hash; resume-and-continue equals the uninterrupted run.                                                                                                                               |
| S6  | Replay: a log recorded from a random run replays with zero divergences; tampering with any `args`/`cmd`/`h`/order is detected.                                                                                                       |
| S7  | Heap pops in `(at, cls, seq)` order under random push/remove.                                                                                                                                                                        |
| S8  | `canonical` ignores key order; `sum64`/`sub64` are inverses.                                                                                                                                                                         |
| S9  | Combat: survivors + losses = initial per side; adding attackers never lowers attacker power; wall levels never help the attacker; no negative counts.                                                                                |
| S10 | Hostile `arriveAt − departAt ≥ rules.movement.minHostileTravelSeconds` (≥ 3600, the brief's speed rule).                                                                                                                             |
| G1  | **Fog non-interference:** for random states S and S′ that differ only in data hidden from seat X, `projectView`, `buildBriefing` and the error responses of X's commands are identical.                                              |
| G2  | Fuzzed tool args (`fc.anything()`) always produce a schema-valid `ToolResult`, never an exception.                                                                                                                                   |
| G3  | Wake properties from §6.5.                                                                                                                                                                                                           |
| G4  | Caps are never exceeded; `end_turn` is last in its round trip.                                                                                                                                                                       |

**Invariants** (`state/invariants.ts` structural + `sim/domain-invariants.ts` domain). `step` level checks dirty entities plus O(1) ledger checks; `checkpoint` level runs a full scan:

- every number in state is a safe integer; counts, levels and stocks are ≥ 0
- referential integrity: owners, islands, origins, alliance members and event refs exist; unique `(island, slot)`
- events: every outbound movement has exactly one `arrive` event; every non-empty queue head has exactly one event; no event at `< now`; no orphan events; `meta.seq` and `counters` are above every used value
- population: `popUsed(city) ≤ popCap(city)`, with an explicit, documented exception for conquered cities
- unit conservation per player and unit type: home + stationed elsewhere + in movements = `recruited − lost`
- resource conservation: Σ stored stock + Σ cargo = `initial + produced − spent + refunded − wasted` (FP-exact)
- diplomacy symmetry (`player.alliance` ↔ `alliance.members`; pact `a < b`); time is monotonic; the speed rule holds

Mutation check of invariants: a test plants about 10 kinds of corruption (negative stock, dangling event, duplicated slot, …) and asserts that each is caught.

**Determinism tests:**

- the same seed with bots under lockstep, run twice, gives byte-identical normalized logs and identical checkpoint hashes; different seeds give different hashes
- the same holds for virtual-time real-time
- Level E holds for every produced log, system clock included

**Golden replays** (`sim/fixtures/golden/`): `lockstep-4p-1d.jsonl` and `rtvirtual-4p-1d.jsonl` (small, about 100–300 KB). The test runs `verify` (Level E) and `--resim` (Level G, byte-identical). They are regenerated only together with an `ENGINE_VERSION` bump.

**Phase-1 exit criterion** (`sim/test/exit-criterion.test.ts`):

1. Lockstep, 12 seats (3 of each strategy), 40 islands, 604,800 s, `--no-domination` so the full 7 days run, `invariants:"checkpoint"` with `hash===fullHash` every 24 h. Expect: no `fatal`, no `INTERNAL`, `ended` at 604800, 168 checkpoints, Level E zero divergences, and a second run byte-identical.
2. The same match in real time with a virtual clock (speed 3/1, latency 2–60 s): same expectations.
3. Real time with the system clock at speed 100800/1: completes and Level E passes (`PERFIDIA_SLOW`; the fast suite runs 1 game day at 86400/1).
4. A 1-day 12-seat variant at `invariants:"step"`.
5. A domination-enabled run ends early with a valid result and replays.

**Performance budget** (laptop target / CI hard limit):

| Scenario                                                       | Target           | CI limit    |
| -------------------------------------------------------------- | ---------------- | ----------- |
| Engine microbench, synthetic 100k events                       | ≥ 100k events/s  | ≥ 25k/s     |
| Lockstep 12p/40i/7d, bots, checkpoint invariants, trace hashes | ≤ 3 s            | 20 s        |
| Same with step invariants (incremental)                        | ≤ 8 s            | 60 s (slow) |
| Real-time virtual 12p/7d, speed 3, latency 2–60 s              | ≤ 5 s            | 30 s        |
| Real-time system 12p/1d at 86400/1                             | ≈ 1 s + overhead | 15 s        |
| Level-E replay of a 7-day log                                  | ≤ 2 s            | 15 s        |
| Briefing build (p95)                                           | ≤ 0.5 ms         | —           |
| Full state hash at day 7                                       | ≤ 10 ms          | —           |
| Peak RSS                                                       | ≤ 300 MB         | 1 GB        |

Expected volumes, for sanity checks: about 10–20k scheduled events, 1–1.5k turns and 10–20k tool calls per match. `perf.test.ts` prints these figures and asserts the CI limits.

---

## 12. Task breakdown (parallel implementation)

Conventions:

- Each task owns exactly the files listed and may read anything.
- T00 creates every barrel and group `index.ts` as a placeholder (`export {};`); ownership of each then passes to the task named below, and nobody else edits it.
- Within a wave, tasks import only from earlier waves; the only exception is the generic contracts in `state/contracts.ts`, which are owned by T03.
- The orchestrator runs `bun run check` at the end of each wave.
- Only T00 adds dependencies.

| Wave | Task                                                      | Package                   | Depends on              |
| ---- | --------------------------------------------------------- | ------------------------- | ----------------------- |
| 0    | T00 Workspace scaffold, guards, docs                      | root                      | —                       |
| 1    | T01 Protocol (all schemas)                                | protocol                  | T00                     |
| 1    | T02 Engine core primitives                                | engine/core               | T00                     |
| 2    | T03 Engine state layer                                    | engine/state              | T01, T02                |
| 2    | T04 Rules: default config, compile, validate, derived     | engine/rules              | T01, T02                |
| 2    | T05 Gateway format + seat + wake scheduler                | gateway                   | T01, T02                |
| 2    | T06 Gateway clocks                                        | gateway/clock             | T01, T02                |
| 2    | T07 Sim I/O + SystemClock                                 | sim/io                    | T01                     |
| 2    | T08 Bot strategies (pure)                                 | bots/strategies           | T01, T02                |
| 2    | T09 Sim summary metrics                                   | sim/summary               | T01                     |
| 3    | T10 World generation + initial state                      | engine/world              | T03, T04                |
| 3    | T11 Economy                                               | engine/economy            | T03, T04                |
| 3    | T12 Military                                              | engine/military           | T03, T04                |
| 3    | T13 Diplomacy + scoring                                   | engine/diplomacy, scoring | T03, T04                |
| 3    | T14 Bot runtime + bots barrel                             | bots                      | T08                     |
| 4    | T15 Engine simulation, replay, barrel                     | engine/sim                | T03, T04, T10–T13       |
| 4    | T16 Gateway view, briefing, errors, archive               | gateway/view              | T03, T04, T05, T11–T13  |
| 5    | T17 Gateway tools (22 handlers)                           | gateway/tools             | T05, T15, T16           |
| 5    | T18 Sim verify                                            | sim/verify                | T07, T15                |
| 6    | T19 Gateway runtime (MatchHost) + gateway barrel          | gateway/runtime           | T05, T06, T15–T17       |
| 7    | T20 Sim run + CLI + sim barrel                            | sim                       | T07, T09, T14, T18, T19 |
| 8    | T21 End-to-end: exit criterion, determinism, golden, perf | sim/test                  | T20                     |

### Task details

**T00: Workspace scaffold** (wave 0)

- Owns:
  - `package.json`, with exact pins: `typescript@7.0.2` in `overrides`, zod and fast-check via catalog, oxlint and oxfmt; scripts `typecheck`, `lint`, `format`, `format:check`, `test`, `check`, `sim`, `test:exit`
  - `bunfig.toml`, `tsconfig.base.json`, `tsconfig.json`, the oxlint config (type-aware) and the oxfmt config, `.gitignore` (adds `runs/`)
  - for every package: `package.json` (exports per §1), `tsconfig.json`, `tsconfig.test.json`
  - placeholder barrels and group indexes
  - `tests/architecture.test.ts`
  - `docs/architecture.md` (this spec, verbatim)
- Acceptance:
  - `bun install` succeeds and the lockfile is created
  - `bun run check` is green on the placeholders
  - the architecture test passes, and its self-tests show every forbidden-token rule fires
  - `Bun.build` of the engine with `target: "browser"` succeeds
  - the engine tsconfig rejects `setTimeout`/`console` usage, shown by a compile-fail fixture or a documented manual check
- Must verify TS 7.0.2 option support and the exact oxfmt and type-aware oxlint setup against the installed tools rather than assuming them.

**T01: Protocol** (wave 1)

- Owns: `packages/protocol/src/**`.
- Scope: Zod schemas and types for everything in §2–§8: ids, time constants (`HOUR`, `DAY`, `MATCH_7D = 604800`, `RES_FP = 3600`), `RulesConfig`, `GatewayPolicy` with defaults, `MatchConfig`, `GameState`, `Command`, `DomainEvent`, `ErrorCode` and `RejectDetails`, all 22 tools' args and results (with `family` and `mutates` metadata), `PlayerView`, `Briefing`, `LogLine`, `Snapshot`, and type-only `SeatAgent`/`TurnContext`.
- Acceptance:
  - valid fixtures parse and invalid ones fail with useful paths
  - the tool list equals the brief's 22 names exactly (test)
  - `LogLine` round-trips
  - the package contains only schemas and constants

**T02: Engine core** (wave 1)

- Owns: `packages/engine/src/core/**`.
- Scope: `int`, `prng` (xoshiro128**, SplitMix32 seeding, `keyedU32`), `hash` (FNV-1a 64 split, `sum64`/`sub64`), `canonical`, `heap` (indexed), `ids` (`compareIds`, `sortedIds`).
- Acceptance:
  - differential tests against BigInt references
  - FNV vectors (`""`, `"a"`, `"foobar"`)
  - S7, S8
  - committed golden vectors for `keyedU32`
  - unbiased `uniformInt` (chi-square with a fixed seed)

**T03: Engine state layer** (wave 2)

- Owns: `packages/engine/src/state/**`.
- Scope: `Store` (dirty tracking, `DeepReadonly` reads), `contracts.ts`, `EventQueue` (classes, `seq`, cancel, rebuild), `accrual`, `hasher` (incremental and full), the invariants framework plus structural invariants, `snapshot` save and load (Zod validation and hash check).
- Acceptance:
  - S3, S4 (random mutation scripts), S5 at the state level
  - queue ordering and cancel tests
  - planted-corruption detection test

**T04: Rules** (wave 2)

- Owns: `packages/engine/src/rules/**`.
- Scope:
  - `default.ts`: a complete V1 `RulesConfig` with 3 resources, 6–8 buildings, 4–6 units, `minHostileTravelSeconds: 3600` and placeholder balance. Numbers are transcribed from `docs/game-rules.md` if it exists; otherwise they are drafted and marked provisional.
  - `compile.ts`: `RulesIndex` with level tables and ordered ids
  - `validate.ts`: cross-field checks with explanatory errors (durations ≥ 1, references valid, speed rule, tables cover `maxLevel`)
  - `derived.ts`: rates, caps, pop cap, wall bonus, points, travel seconds
  - `hash.ts`: `rulesHash`
- Acceptance:
  - default rules validate
  - each of at least 12 broken variants is rejected with a precise message
  - derived values are monotone in level
  - `rulesHash` is stable (golden) and independent of key order

**T05: Gateway format, seat, wake** (wave 2)

- Owns: `packages/gateway/src/format/**`, `seat/**`, `wake/**`.
- Scope: deterministic time and number formatting, `SeatState` with `gwHash`, caps counters and checks, notes with limits, `WakeScheduler` and trigger mapping (§6.5).
- Acceptance: G3 properties, scenario tests (budget exhaustion, urgent during a turn, grouping), formatting snapshots, no `Intl`.

**T06: Gateway clocks** (wave 2)

- Owns: `packages/gateway/src/clock/**`.
- Scope: `types.ts` (§7.1), `time-map`, `VirtualClock` with deadlock detector, seeded `order`, `LockstepClock`, `RealTimeClock`.
- Acceptance: the `FakeHost` tests of §7.4, plus a property that the game-to-wall mapping is monotone and `gameAt(wallAt(g)) = g`.

**T07: Sim I/O** (wave 2)

- Owns: `packages/sim/src/io/**`.
- Scope: buffered JSONL writer, streaming reader with Zod validation and line numbers, out-dir layout, snapshot files, `SystemClock`.
- Acceptance: round trip of every `LogLine` kind; a corrupt line reports its line number; reading 100k lines keeps memory bounded; `SystemClock` fires timers in order.

**T08: Bot strategies** (wave 2)

- Owns: `packages/bots/src/strategies/**`.
- Scope: `common`, `memory` (≤ notes cap), and the four strategies (§9) as pure functions over protocol types.
- Acceptance:
  - same input gives the same calls
  - every emitted call parses with the protocol tool schemas
  - briefing fixtures produce the expected behaviour: the raider attacks a weak target and recalls on a strong report; the diplomat betrays on its seeded day; the builder answers an incoming attack
  - memory always fits the cap

**T09: Sim summary** (wave 2)

- Owns: `packages/sim/src/summary/**`.
- Scope: the fold over log lines into `MatchSummary` (§10) and the text table.
- Acceptance: hand-written fixture logs produce exact expected metrics, including wakes per seat per day by reason.

**T10: World** (wave 3)

- Owns: `packages/engine/src/world/**`.
- Scope: seeded archipelago generation (islands on an integer grid with minimum distance, slots), farthest-point starting placement, names, `createInitialState`.
- Acceptance:
  - same seed gives the same state hash; different seeds differ
  - property over 6–12 players × 30–50 islands: constraints hold and every pair of starting cities is at least the hostile minimum travel apart
  - impossible parameters produce an explanatory error

**T11: Economy** (wave 3)

- Owns: `packages/engine/src/economy/**`.
- Scope: `CommandModule`s for `build`, `recruit`, `cancel_queue` and `send_resources` (prefix semantics, `"max"`), handlers for `build_done`, `recruit_done` and transport arrival, `afford` (`affordableAt`, `maxAffordable`), `pop`.
- Acceptance: unit tables per rule; validate is pure; no negative stock; pop ≤ cap; ledger conservation; queue chaining and refund timing; the `queueEmpty` flag is correct.

**T12: Military** (wave 3)

- Owns: `packages/engine/src/military/**`.
- Scope: `CommandModule`s for `attack`, `support`, `spy`, `found_city` and `recall_troops`; arrival dispatch per kind; pure `resolveBattle` (naval then land phases, integer loss curves); loot; spy; conquest (instant or siege, queue cleanup, outbound policy); recall timing.
- Acceptance: S9, S10; no dangling events after conquest or recall; report contents match the visibility rules.

**T13: Diplomacy + scoring** (wave 3)

- Owns: `packages/engine/src/diplomacy/**`, `scoring/**`.
- Scope: messages, proposals (propose, answer, expire), alliances and pacts (join and leave), `relation(a, b)`, points, leaderboard, `checkVictory`, `checkElimination`.
- Acceptance: membership symmetry; expiry; points deterministic; victory threshold edge cases.

**T14: Bot runtime** (wave 3)

- Owns: `packages/bots/src/bot.ts`, `registry.ts`, `index.ts`.
- Scope: `createBot`; the round loop under the caps; observation cache; notes memory; thoughts; seeding.
- Acceptance: against a fake `TurnContext` it respects caps, survives `{ok:false}`, always ends with `end_turn`, and is deterministic.

**T15: Engine simulation** (wave 4)

- Owns: `packages/engine/src/sim/**`, `src/index.ts`, `src/version.ts`.
- Scope: `Simulation` (§3.3, `advanceTo` algorithm, checkpoints, end of match), command and event dispatch tables, post-hooks (betrayal, elimination, victory), `Queries`, domain invariants, `replay()`.
- Acceptance: S1, S2, S5, S6; checkpoint semantics tests (event exactly at an hour boundary, command at a boundary); `EngineMisuse` cases; browser bundle of the barrel; microbench reported.

**T16: Gateway view** (wave 4)

- Owns: `packages/gateway/src/view/**`.
- Scope: `projectView`, knowledge and intel, `buildBriefing` (§6.2), observe payload builders, `errors.ts` (reject to fog-safe `GameError` with numbers and hints, one template per `ErrorCode`), archive search.
- Acceptance: G1 non-interference; briefing token budget; a message and hint exist and contain numbers for every `ErrorCode` (snapshot test); deterministic output.

**T17: Gateway tools** (wave 5)

- Owns: `packages/gateway/src/tools/**`.
- Scope: `ToolCtx`, a registry of exactly 22 `ToolSpec`s, view prechecks, `toCommand` normalization, handlers.
- Acceptance: G2 fuzz; `INVALID_ARGS` names the Zod path; each mutating tool makes at most one `submit`; `end_turn` rules; archive limits.

**T18: Sim verify** (wave 5)

- Owns: `packages/sim/src/verify/**`.
- Scope: file-based Level E (streaming), snapshot seek, `--dump`, JSON-path diff.
- Acceptance: synthetic logs (built in the test by driving `Simulation` directly) verify clean; tampered args, hashes, order and checkpoints are each reported at the exact `n` or hour.

**T19: Gateway runtime** (wave 6)

- Owns: `packages/gateway/src/runtime/**`, `src/index.ts`.
- Scope: `MatchHost` implementing `ClockHost` (engine + wake + seats + tools + `LogSink`), `TurnSession` (caps, `call`/`obs` lines, `end_turn`), `MemorySink`, `createMatch(config, opts)`, `MatchResult`.
- Acceptance: a 1-day lockstep match with a scripted agent writes a schema-valid log that passes Level E; `gwHash` is deterministic; a real-time virtual run completes; a fatal path writes a `fatal` line and rethrows.

**T20: Sim run + CLI** (wave 7)

- Owns: `packages/sim/src/run/**`, `cli.ts`, `src/index.ts`.
- Scope: config from flags, bot assignment, driver selection, output files, snapshot cadence, progress output, exit codes, the `golden` command, `--help`.
- Acceptance: `bun run sim -- run --seed 1 --players 4 --days 1` produces a run that `verify` and `summary` accept; bad flags exit 3 with an explanation.

**T21: End-to-end** (wave 8)

- Owns: `packages/sim/test/**`, `packages/sim/fixtures/**`.
- Scope: the exit-criterion tests (§11), determinism (Level G), committed goldens and their test, `perf.test.ts` with CI limits.
- Acceptance: `bun run test:exit` is green; the fast suite stays under about 60 s total; budgets are printed.

The critical path is T00 → T01 → T03 → T11/T12 → T15 → T17 → T19 → T20 → T21 (9 waves). The widest wave, wave 2, has 7 parallel tasks.

---

## 13. Open questions (recommended default in **bold**) and risks

- **Q1 Same-second ordering in real time.** The brief says simultaneous actions are applied in a seeded order recorded in the log. Lockstep does exactly that. For real time I recommend **arrival order through the synchronous critical section, recorded as `n`**: immediate feedback, matching "a decision takes effect when the agent makes it". The alternative is a per-second barrier with seeded order: fairer within a second, but it delays every tool result by up to one game-second. Replay is unaffected either way.
- **Q2 Lockstep simultaneity.** Recommended: **serial seeded turns per tick** (deterministic, simple). Parallel "think against a snapshot, apply at turn end" would make lockstep LLM benchmarks faster in phase 2, but tool results within a turn would become provisional.
- **Q3 Archive tool.** The brief names `battle_history` (principle 5) but its tool table has no archive tool. Recommended: **fold search into `read_notes` now**; decide on `search_archives`/`battle_history` in phase 2.
- **Q4 Batch semantics.** Recommended: **prefix (queue as many as possible in order, report where it stopped)** rather than all-or-nothing.
- **Q5 "Queue finishes" wake.** Recommended: **wake when a city's queue becomes empty**, not on every item, to save wakes.
- **Q6 Notes location.** Recommended: **gateway seat state (separately hashed)** rather than engine state, so the engine stays agent-agnostic.
- **Q7 Default wake budget** (8 non-urgent per day plus safety plus urgent). The brief's estimate is about 50 wakes per match per seat. Phase-1 bot runs will measure the real figure; tune it in the policy, not in code.
- **Risks:**
  - TS 7 option deprecations and the exact oxfmt and type-aware oxlint configuration are unverified; T00 must validate them against the installed tools.
  - Zod 4 details (template literals, brand ergonomics) need checking in T01.
  - Incremental hashing depends on mutation discipline; mitigated by the full-hash cross-check.
  - Virtual time is unsound for agents doing real I/O; mitigated by the deadlock detector and a documented restriction.
  - Goldens are deliberately brittle and need the version-bump discipline.
  - State grows with archives (messages and reports); hashing is incremental, but snapshots grow. Move the archive into a separate append-only store in the DB phase.
  - Bot strategy quality can hide rule bugs (for example a combat formula nobody exercises); the strategy fixtures and the summary's battle and conquest counts must be non-zero in the exit test.
