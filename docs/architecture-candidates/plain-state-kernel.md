# Architecture candidate: Plain-State Kernel: functional core with two doors (sync / apply)

> Phase-1 design input, superseded by docs/architecture.md once written.

**Pitch.** The engine is one plain JSON state object plus deterministic step functions that edit it in place, using integer maths only. There is no event heap: every scheduled thing is a timestamp on an entity, so cancelling means editing that entity. State changes through exactly two doors: sync(t) moves game time forward, and apply(seat, action, {t, ord}) applies a player action. The clock drivers (lockstep and real-time) decide only when those doors open. The JSONL log records what went through them, so replaying a match means re-opening the same doors, and an hourly hash of the state checks the result. Fog of war, briefings, caps, notes, archives and wake-ups are pure functions in the gateway around this core. Bots plug in as the same SeatController that the phase-2 LLM orchestrator will implement.

**Key trade-offs.**

- Engine steps edit an 'owned draft' in place instead of making immutable copies or using Immer. This is the fastest and most readable option, and copying a ~100 KB state on each of ~20k steps would cost seconds. The risk is aliasing: a caller keeps a reference that later changes. Mitigations: DeepReadonly types at the boundary, fresh objects in every projection, and property tests showing that validation and rejected actions change nothing and that key insertion order does not matter.
- There is no explicit event heap: due times are read from entity timestamps by scanning about 300 entities per step. This removes cancellation bookkeeping and keeps a single copy of every fact, at a cost of roughly 15M comparisons per match. A cached index can be added later behind nextDue() without changing behaviour.
- The engine emits messages and reports as events instead of storing them, and folds every event into a running evHash kept in the state. Hourly hashes stay small and cheap while still covering the whole event stream. The cost is that archives and seat state become gateway-derived data that is not snapshotted in phase 1, so resuming a match means replaying it.
- In real-time, writes are batched per game-second and applied in seeded order, as the brief requires, with no latency race inside a second. The cost is up to one game-second of extra wait per write (about 1.2 s at x3) and some async plumbing. The simpler alternative, applying writes as they arrive, would not be 'seeded'.
- Lockstep runs woken seats one after another in a seeded order, with immediate tool results. This is fully reproducible with bots. The costs are that later seats in the same second see earlier seats' actions, and that lockstep LLM runs in phase 2 will be slow. A parallel mode would stay replayable but not reproducible from run to run.
- The gateway reuses the engine's validateAction instead of validating against a separate view model, so the rules cannot drift between two copies. This requires every engine violation to be view-safe (only the actor's own or public facts), which a leakage test enforces.
- Resources are stored as fixed point x3600, so lazy accrual is exact and does not depend on when settlement happens, using integers only. The cost is that every display or comparison must go through helpers (idiv, canAfford) instead of reading raw numbers.
- The clock drivers and the MatchHost live in the gateway rather than in a separate runtime package. This means one package fewer now, and the phase-2 orchestrator and server can reuse them. The gateway carries more code, and the drivers may move to their own package later.
- The fake clock (VirtualTimeSource, which flushes pending work with a macrotask) makes full 7-day real-time runs deterministic and fast. It only works if nothing in a turn awaits real I/O, so log sinks are synchronous and bots do no I/O. A system-time test at about x50,000 then proves that the log captures real async interleavings.
- The state is hashed in full every game hour, and the rules are embedded in the log header. Verification is simple and strong and every run directory replays on its own, at a cost of O(state) per hour (168 hashes per match) and a larger header. FNV-1a 64 catches accidental divergence but not deliberate tampering, which is acceptable here.
- Engine version is kept out of the hashed state and the rules hash is kept in. Behaviour-preserving refactors therefore keep golden replays green, and goldens are only regenerated after a deliberate version bump, which `sim golden --update` enforces.
- Contracts come first: wave 2 creates every engine module as a stub with exact signatures, which lets 9 tasks run in parallel in wave 3. The cost is a dedicated integration wave (T41) to fix mismatches between modules.
- The default wake budget (6 non-urgent wakes per game day, plus exempt safety and urgent wakes) follows the brief's cost estimate of about 50 wakes per seat per match, not gameplay quality. Phase-1 summaries exist to measure the real rate and retune it.

---

# Perfidia: Phase-1 Technical Architecture ("Plain State, Two Doors")

> **Scope.** This covers phase 1 of `docs/brief.md`: the engine, both clocks, combat, scripted bots, a headless runner and replay verification. Phase 1 has no LLM, no database, no HTTP server and no web UI; logs and replays are files.
> **Design angle.** The simplest correct design: a functional core with an imperative shell, plain JSON-serializable state, reducer-style steps and minimal abstractions.
> **Toolchain facts checked against the local Bun cache** (T00 pins exact versions):
>
> - Bun 1.4.3.
> - typescript 7.0.2: the native `tsc` has `--build` and `--erasableSyntaxOnly`.
> - zod 4.6.5: has `z.templateLiteral` and `z.toJSONSchema`.
> - fast-check 4.10.2: has `fc.commands`, `fc.modelRun` and `fc.scheduler`.
> - oxlint 1.87 has these rules: `no-restricted-globals`, `no-restricted-imports`, `no-restricted-properties`, `overrides`, `require-array-sort-compare`, `switch-exhaustiveness-check`, `no-floating-promises`.
>
> Anything not checked is marked **verify**.

---

## 0. The design in ten lines

1. **State is one plain JSON object** (`EngineState`) made of normalized records keyed by short ids. Derived values (production rates, storage caps, population, points, slot occupancy) are never stored.
2. **Steps are in-place reducers.** `fn(state, rules, input, out)` edits the state it is given (an "owned draft"), pushes emitted events to `out`, and returns plain data. Given the same inputs, it always produces the same result. Callers clone the state when they need history.
3. **There is no explicit event heap.** Every scheduled thing is a timestamp on an entity: a queue head's `doneAt`, a movement's `arriveAt`, a deal's `expiresAt`, `nextCheckpointAt` and `meta.durationS`. `nextDue()` scans these fields. Cancelling or recalling means editing the entity.
4. **Total order of scheduled events: `(t, rank(kind), seq)`.** Within one game-second, scheduled events run before player actions. Player actions run in the `ord` order recorded in the log.
5. **Resources are stored as fixed point ×3600.** Lazy accrual is then `stock += ratePerHour × Δseconds`, which is exact, uses integers only, and gives the same result whatever the settlement points.
6. **Determinism kit:**
   - sfc32 as the PRNG;
   - FNV-1a 64 over the UTF-8 bytes of canonical JSON as the hash;
   - integer division helpers;
   - the canonical serializer throws on any non-integer number.
7. **The engine emits `GameEvent`s and does not store messages or reports.** A running `evHash` in the state folds in every emitted event, so one hourly state hash verifies both the state and the event stream.
8. **The gateway reuses the engine's `validateAction`** as its game-rule precheck, so the rules exist in one copy only. The gateway wraps it with schema, visibility, turn and cap checks. Engine violations are view-safe by contract: they only mention the actor's own entities and public facts.
9. **Clock drivers only decide when `sync`, `apply` and turns happen.**
   - Lockstep: turns run one after another in a seeded seat order, and actions apply instantly.
   - Real-time: actions land at `floor(speed × wall time)`. They are batched per game-second and applied in seeded order when that second closes.
10. **Replay uses the engine only.** The header (seed, rules, seats) plus the `action` entries are enough to recompute the hourly hashes. Wall time and async interleavings are frozen into `(t, ord)`.

### 0.1 Where this spec sharpens or questions the brief and the prompt

- **"Validate against the player's view."** A second validator written against a view model would drift from the engine. Instead, the gateway checks visibility of every referenced id (fog) and then calls the engine's own `validateAction`. The engine guarantees that its violations never leak hidden facts, and a test enforces this (§5, §11).
- **"Event queue with cancellation."** An explicit priority queue duplicates truth that already sits on entities, and every cancel then needs bookkeeping. Deriving due items from the entity timestamps removes that class of bugs. The cost is an O(entities) scan per step: about 300 entities, so roughly 15M comparisons per match, which is negligible.
- **"Seeded order recorded in the log."** In lockstep, the seeded order is the order of seat turns. In real-time, it is the sort order of each one-second batch. In both cases the log records `ord`, the actual position in which actions were applied, and that is what replay uses. The seeded `key` is recorded too, for information.
- **Engine version.** The engine version is stored in the log header and in the snapshot envelope, but **not** in the hashed state. Otherwise every version bump would invalidate every golden replay, even for refactors that change no behaviour. The rules hash **is** in the hashed state, because rules do change behaviour.
- **Real-time write latency.** Seeded ordering within a second means a write tool call can wait up to one game-second of wall time before it resolves: 1.2 s at ×3, near zero at test speeds. A simpler alternative is to apply on arrival and order by arrival, but that is not "seeded" as the brief requires.
- **Wake budget versus the cost model.** The brief estimates about 50 wake-ups per seat per match, about 7 per game day. The default budget is therefore 6 non-urgent wakes per day, plus the 12-hour safety wakes (exempt) and urgent wakes (exempt). Phase 1 exists to measure this; see §10.
- **Gaps in the brief** (also listed in §13):
  - The tools table has no archive-search tool; principle 5 mentions `battle_history`. This spec proposes `search_archives`.
  - "Queue finishes" is read here as "the queue becomes idle".
  - `docs/game-rules.md` does not exist yet, although CLAUDE.md points to it.

---

## 1. Packages and modules

Dependency direction: `protocol ← engine ← gateway ← bots ← sim`. An import never goes upwards.

`bots` imports **only `protocol`**. It reaches the game through tool calls that the gateway runs, and it never touches the engine.

```
packages/
  protocol/src/      Zod schemas + inferred types + tiny pure helpers. Runtime dep: zod.
    ids.ts           PlayerId `p${n}`, IslandId `i${n}`, CityId `c${n}`, MovementId `m${n}`, QueueItemId `q${n}`,
                     ReportId `r${n}`, MessageId `msg${n}`, DealId `d${n}`, AllianceId `a${n}` (z.templateLiteral)
    time.ts          GameTime, MINUTE/HOUR/DAY, CHECKPOINT_S=3600, MATCH_7D=604800,
                     formatGameTime(t) -> "D2 14:05", formatDuration(s) -> "1h20m",
                     DurationInputSchema ("1h20m" | seconds -> seconds), GameTimeInputSchema ("D2 14:05" | seconds)
    resources.ts     ResourceKey = "wood"|"stone"|"gold", Resources, UnitCounts, RES_SCALE=3600
    rules.ts         RulesConfigSchema (§2.6)
    state.ts         EngineStateSchema, STATE_VERSION, DeepReadonly<T>
    actions.ts       ActionSchema (engine-level, canonical, one action = one state change)
    errors.ts        ViolationSchema (engine), GatewayErrorCode, ErrorCode, ToolErrorSchema
    events.ts        GameEventSchema, BattleReportSchema, SpyReportSchema, Audience
    results.ts       Validation<P>, ActionResult, ActionEffect
    tools.ts         TOOL_NAMES, per-tool input schemas, ToolCall, ToolResult
    views.ts         CityView, IslandView, MapView, PlayerView, LeaderboardView, MovementView, ArchiveHit
    briefing.ts      BriefingSchema, WakeReasonSchema
    turn.ts          SeatController, RoundInput, RoundOutput   (the bot/LLM contract)
    config.ts        GatewayConfigSchema + DEFAULT_GATEWAY_CONFIG, MatchSetupSchema
    log.ts           Hash64, LogHeader, LogEntry union, LOG_FORMAT=1
    index.ts         barrel
  engine/src/        Pure simulation. Imports protocol types and constants only (`import type` where possible).
    version.ts       ENGINE_VERSION (semver)
    lib/intmath.ts   idiv, ceilDiv, mulDiv, isqrtCeil, clamp, assertSafeInt   (the only place Math.floor etc. may appear)
    lib/canonical.ts canonicalJson
    lib/hash.ts      fnv1a64, hashState, hashRules
    lib/prng.ts      sfc32: rngFrom, nextU32, nextInt, shuffle
    lib/ids.ts       allocId, compareIds, sortedKeys, sortedValues
    lib/order.ts     actionOrderKey, seatOrder
    rules/derive.ts  O(1) lookups and formulas: buildingLevel(), unitStats(), productionPerHour(), storageCap(),
                     popCapOf(), travelTimeS(), distance()
    rules/check.ts   checkRules(rules): string[]  (semantic checks + speed rule + integer bounds)
    rules/default.ts DEFAULT_RULES
    world.ts         generateWorld(seed, rules, players)
    economy.ts       resourcesAt, settle, spend, refund, canAfford, readyAt, popUsed, popCap
    construction.ts  build / cancel (build queue) + onBuildDone
    recruitment.ts   recruit / cancel (recruit queue) + onRecruitDone
    movement.ts      attack/support/spy/transport/found sends, recall, recall_support,
                     onSupportArrival / onTransportArrival / onReturnArrival
    combat.ts        resolveBattle (pure numbers) + onAttackArrival
    conquest.ts      onFoundArrival, transferCity, eliminateIfDead
    espionage.ts     onSpyArrival
    diplomacy.ts     message, propose, answer, leave, onDealExpiry, onHostileAction, removePlayer
    scoring.ts       points, standings, checkVictory, finalResult
    emit.ts          emit(s, out, ev): push + fold into s.evHash
    kernel.ts        createMatch, nextDue, nextEventTime, advanceTo, validateAction, applyAction
    replay.ts        verifyReplay, replayTo
    invariants.ts    checkInvariants(s, rules): string[]
    testing/         mini rules fixture + state builders (subpath export "@perfidia/engine/testing")
    index.ts         barrel (public API only; domain modules stay internal)
  gateway/src/       LLM-agnostic shell around the engine.
    explain.ts       Violation | gateway error -> ToolError {code, message, hint} with numbers
    projection.ts    fog-of-war views (pure)
    briefing.ts      buildBriefing (pure)
    seat.ts          SeatState + createSeatState
    wake.ts          wake policy (pure)
    caps.ts          per-turn / per-day caps (pure)
    notes.ts         notebook ops (pure)
    archive.ts       per-seat archive append + search (pure)
    tools.ts         tool registry: name -> {schema, kind, handler}
    turn.ts          runTurn (round loop shared by all clocks and all controllers)
    host.ts          createMatchHost: owns engine state + seat states + log sink (the imperative shell)
    clock/types.ts   TimeSource, ClockHost, ClockDriver, TurnEnv, ApplyMeta, MatchEnd
    clock/time.ts    systemTimeSource, VirtualTimeSource
    clock/signal.ts  Signal (level-triggered notify/wait)
    clock/lockstep.ts lockstepClock()
    clock/realtime.ts realTimeClock({ time, speedFactor })
    index.ts
  bots/src/          Scripted SeatControllers. Imports protocol only.
    kit.ts           helpers over protocol views (affordability, build orders, power estimates, targets)
    think.ts         withThinkTime(controller, { sleep, rng, minMs, maxMs })
    strategies/      turtle.ts raider.ts expander.ts diplomat.ts chaos.ts
    registry.ts      createBot(strategy, { seat, seed })
    index.ts
  sim/src/           Headless CLI (bun). Imports everything.
    cli.ts run.ts files.ts verify.ts summary.ts diff.ts index.ts
  sim/golden/        committed golden logs
tests/architecture.test.ts   (root) dependency-direction + engine purity guard
```

**Who does what:**

- **protocol**: owns every shape that crosses a boundary (files, tools, later MCP, DB and web). It contains no game logic.
- **engine**: owns the game rules as code (formulas) with numbers from `RulesConfig`. It does no I/O, uses no clock, has no randomness except the seeded kind, does no formatting of text for players, and has no module-level mutable state. It runs unchanged in a browser.
- **gateway**: the only way into a running match. It owns the fog of war, briefings, explanations, caps, notes, archives, wake-ups, the turn loop, the `MatchHost` shell and the clock drivers. The drivers live here because the phase-2 orchestrator and server will reuse them; `sim` is a CLI and must not be a library dependency. If the gateway grows too large, the drivers can later move to a `runtime` package.
- **bots**: scripted players behind `SeatController`, which is the same contract the LLM harness will implement.
- **sim**: does the file I/O and the CLI, wires the other packages together, verifies replays and writes summaries.

**Enforcement:**

1. **Package dependencies.** Each `package.json` lists only the packages below it.
2. **Architecture test.** `tests/architecture.test.ts` scans import specifiers per package and fails on any upward import. It also scans `packages/engine/src/**` (except `lib/`) for these banned tokens: `Math.random`, `Date`, `performance`, `process.`, `Bun.`, `setTimeout`, `setInterval`, `queueMicrotask`, `crypto`, `Intl`, `localeCompare`, `toLocaleString`, `toFixed`, `parseFloat`, `Math.(sqrt|pow|floor|ceil|round|log|exp|sin|cos|tan)`, `"node:` and `"bun:`. A self-test checks that the scanner catches a planted violation.
3. **oxlint `overrides`.**
   - For `packages/engine/src/**`:
     - `no-restricted-globals`: `Date`, `performance`, `process`, `Bun`, `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask`, `crypto`, `fetch`, `structuredClone`, `Intl`;
     - `no-restricted-properties`: `Math.random`, `Math.sqrt`, `Math.pow`, `Math.floor`, `Math.ceil`, `Math.round`, and the `localeCompare` property;
     - `no-restricted-imports`: `node:*`, `bun:*`, `@perfidia/gateway|bots|sim`.
   - A second override re-allows the `Math.*` integer helpers under `engine/src/lib/**`.
   - Bots get the same bans on `Math.random`, `Date` and `performance`.
   - On everywhere: `require-array-sort-compare` and `switch-exhaustiveness-check`. On in gateway and sim: `no-floating-promises`.
4. **Pure type-check.** `packages/engine/tsconfig.pure.json` and `packages/protocol/tsconfig.pure.json` use `lib: ["ES2023"]` and `types: []` and exclude tests, so a reference to `Bun`, `process` or the DOM fails to type-check. Test files are checked by the root config with `types: ["bun"]`.
5. **Browser build smoke.** `bun build packages/engine/src/index.ts --target=browser` must succeed.

TypeScript settings:

- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `moduleResolution: "bundler"`, `noEmit`;
- no `enum` and no `namespace` (use string-literal unions);
- named exports only.

---

## 2. State model

### 2.1 Ids

Ids are stable and short. Each kind gets its own counter, stored in `state.counters`, so ids within a kind are dense (`m1, m2, …`). Allocation: `allocId(s, "move") → "m" + ++s.counters.move`.

Players are `p1..pN` in seat order. Initial cities are `c1..cN`, one per player. Islands are `i1..iK`. Ids are never reused.

`compareIds` orders ids by prefix first, then numerically (`c2 < c10`).

### 2.2 Engine state (protocol/src/state.ts; the Zod schemas mirror these types)

```ts
export type Hash64 = string; // 16 lowercase hex chars
export interface EngineState {
  v: 1; // STATE_VERSION
  meta: { seed: string; rulesHash: Hash64; durationS: GameTime }; // hashed; NO engineVersion here (§2.5)
  now: GameTime; // last time advanced to (integer game-seconds)
  status: "running" | "ended";
  nextCheckpointAt: GameTime; // next multiple of 3600 not yet checkpointed
  evHash: Hash64; // running FNV-1a 64 over every emitted GameEvent
  counters: Record<"city" | "move" | "queue" | "report" | "msg" | "deal" | "alliance", number>;
  rng: [number, number, number, number]; // sfc32 state (uint32s); reserved for rules needing chance
  players: Record<PlayerId, Player>;
  islands: Record<IslandId, Island>;
  cities: Record<CityId, City>;
  movements: Record<MovementId, Movement>;
  deals: Record<DealId, Deal>; // open proposals only
  alliances: Record<AllianceId, Alliance>;
  pacts: Pact[]; // non-aggression pacts, sorted by (a, b)
  result: MatchResult | null;
}
export interface Player {
  id: PlayerId;
  name: string;
  alive: boolean;
  alliance: AllianceId | null;
}
export interface Island {
  id: IslandId;
  x: number;
  y: number;
  slots: number;
} // integer map coordinates
export interface City {
  id: CityId;
  name: string;
  owner: PlayerId;
  island: IslandId;
  slot: number;
  foundedAt: GameTime;
  stock: Resources; // fixed point: whole units × RES_SCALE (3600)
  stockAt: GameTime; // when `stock` was last settled
  buildings: Record<string, number>; // level per building key; zero entries removed
  units: UnitCounts; // owner's units at home; zero entries removed
  support: Record<CityId, UnitCounts>; // units stationed here, keyed by their home city
  buildQueue: QueueItem[]; // head first
  recruitQueue: QueueItem[];
}
export interface QueueItem {
  id: QueueItemId;
  key: string; // building or unit key
  level?: number;
  count?: number; // build target level | recruit count
  durationS: number; // fixed at enqueue time
  paid: Resources; // whole units, for exact refunds
  doneAt: GameTime | null; // only the head has a doneAt
}
export type MovementKind = "attack" | "support" | "spy" | "transport" | "found" | "return";
export interface Movement {
  id: MovementId;
  kind: MovementKind;
  owner: PlayerId;
  from: CityId;
  to: CityId | null;
  island?: IslandId; // `found` targets an island
  units: UnitCounts;
  cargo: Resources;
  gold: number; // whole units
  departAt: GameTime;
  arriveAt: GameTime;
  was?: Exclude<MovementKind, "return">; // on a return leg: what it came back from
}
export interface Deal {
  id: DealId;
  kind: "alliance" | "nap";
  from: PlayerId;
  to: PlayerId;
  createdAt: GameTime;
  expiresAt: GameTime;
}
export interface Alliance {
  id: AllianceId;
  members: PlayerId[];
  foundedAt: GameTime;
} // members sorted
export interface Pact {
  a: PlayerId;
  b: PlayerId;
  since: GameTime;
} // a < b
export interface MatchResult {
  endedAt: GameTime;
  reason: "time" | "domination";
  winner: PlayerId | AllianceId | null;
  standings: Standing[];
}
```

**Derived values are never stored.** Each one is a pure function of the state and the rules:

- production per hour;
- storage cap;
- population used and population cap;
- city and player points;
- free slots on an island;
- a player's cities;
- alliance membership of a city.

This keeps the state small and makes it impossible for two copies of the same fact to disagree.

### 2.3 Lazy resource accrual

```ts
// economy.ts  (RES_SCALE = 3600, so 1 whole unit = 3600 stored units)
export function resourcesAt(c: DeepReadonly<City>, rules: RulesConfig, t: GameTime): Resources;
// per key k: min(storageCap × RES_SCALE, c.stock[k] + productionPerHour(c)[k] × (t − c.stockAt))   (pure)
export function settle(c: City, rules: RulesConfig, t: GameTime): void; // stock = resourcesAt(t); stockAt = t
export function canAfford(stock: Resources, cost: Resources): boolean; // cost[k] × RES_SCALE ≤ stock[k]
export function spend(c: City, cost: Resources): void; // caller settled first
export function refund(c: City, rules: RulesConfig, amount: Resources): void; // capped at storage
export function readyAt(
  c: DeepReadonly<City>,
  rules: RulesConfig,
  t: GameTime,
  cost: Resources,
): GameTime | null;
// earliest t' ≥ t when affordable: per key ceilDiv(missing, rate); null if rate is 0 or cost > cap
export function popUsed(s: DeepReadonly<EngineState>, rules: RulesConfig, city: CityId): number;
export function popCap(c: DeepReadonly<City>, rules: RulesConfig): number;
```

Why ×3600: rates are given per game hour, and one stored unit is 1/3600 of a whole unit. A rate of `r` units per hour therefore adds exactly `r` stored units per game-second. Accrual is exact, so the result does not depend on when settlement happened. `min(cap, ·)` keeps this property because rates are never negative; population is a cap, not an upkeep.

When settlement happens: only inside engine transitions that touch a city (spending, refunds, a building completing that changes rates or caps, deliveries, loot, conquest), and always at the transition's own time. **Reads never settle.** Views call `resourcesAt`.

Bounds: `storageCap ≤ 10^6` gives at most 3.6·10^9 stored units, far below 2^53. `checkRules` enforces this.

### 2.4 Gateway state (not hashed, not part of the engine)

```ts
export interface SeatState {
  seat: PlayerId;
  active: boolean;
  notes: string; // notebook (size-capped)
  archive: ArchiveEntry[]; // raw GameEvents relevant to this seat; projected when read
  inbox: GameEvent[]; // undelivered since the last briefing
  news: GameEvent[]; // public events since the last briefing (capped)
  wake: WakeState; // §6.7
  turn: { startedAt: GameTime; index: number; calls: number; writes: number } | null;
  day: { index: number; wakes: number; messages: number };
  stats: SeatStats; // wakes per day by reason, calls, rejects by code
}
```

Gateway state is derived data. It can be rebuilt by replaying the log (events plus `note` entries), so phase 1 does not snapshot it.

### 2.5 Versioning

- **`ENGINE_VERSION`** (engine/version.ts, semver). Bump the minor version when a change alters hashes for the same inputs; bump the patch version otherwise. It is stored in the log header and the snapshot envelope, and **excluded from the hashed state**.
- **`STATE_VERSION`** (protocol): the integer schema version of snapshots (`state.v`).
- **`rulesHash`** = `fnv1a64(canonicalJson(rules))`. It is stored in `state.meta`, where it is hashed, and in the header. The full rules object is embedded in the header, so every run directory replays on its own.
- **`gatewayHash`**: the hash of `GatewayConfig`, stored in the header. It affects behaviour (wake-ups) but not replay.
- **`LOG_FORMAT`** = 1.

### 2.6 Rules config (data-driven; numbers live in DEFAULT_RULES and docs/game-rules.md)

```ts
export interface RulesConfig {
  id: string; // e.g. "default-0.1"
  match: { durationS: number }; // 604800 for 7 game days
  map: {
    islands: { min: number; max: number; perPlayer: number };
    size: number;
    minGap: number;
    slots: { min: number; max: number };
  };
  start: { resources: Resources; buildings: Record<string, number>; units: UnitCounts };
  economy: { baseProductionPerHour: Resources; baseStorage: number; basePop: number };
  buildings: Record<
    string,
    {
      // keys match /^[a-z][a-z_]*$/ (never integer-like)
      maxLevel: number;
      requires?: Record<string, number>;
      levels: Array<{
        cost: Resources;
        timeS: number;
        pop: number;
        points: number;
        production?: Partial<Resources>;
        storage?: number;
        popCap?: number;
        wallPermille?: number;
        buildSpeedPermille?: number;
        recruitSpeedPermille?: number;
      }>;
    }
  >;
  units: Record<
    string,
    {
      role: "defense" | "attack" | "transport" | "warship" | "settler";
      naval: boolean;
      cost: Resources;
      pop: number;
      timeS: number;
      trainedIn: string;
      requires?: Record<string, number>;
      attack: number;
      defense: number;
      speed: number; // speed: map units per game hour
      capacity: number;
      loot: number; // capacity: land-unit seats (transports)
    }
  >;
  movement: {
    minAttackS: number;
    minTravelS: number;
    sameIslandS: number;
    recallWindowS: number | null;
  };
  combat: {
    wallPermillePerLevel: number;
    baseDefense: number;
    lootPermille: number;
    navalFirst: boolean;
  };
  conquest: { unit: string; keepBuildings: boolean };
  spy: { minGold: number; vaultBuilding: string; goldPerVaultLevel: number };
  diplomacy: {
    dealTtlS: number;
    maxAllianceSize: number;
    attackBreaksPacts: boolean;
    maxMessageChars: number;
  };
  visibility: { mapPublic: boolean; pointsPublic: boolean; incomingShowsUnits: boolean };
  points: { perCity: number };
  victory: { cityControlPermille: number; byAlliance: boolean };
  queues: { buildMax: number; recruitMax: number; cancelRefundPermille: number };
}
```

The resource set (wood, stone, gold) is fixed in the types because the brief fixes it. Buildings and units are data.

`checkRules` enforces:

- **The speed rule.** The fastest attack between any two start-eligible positions, sending the fastest unit, takes at least `max(minAttackS, 3600)` game-seconds.
- **Every key reference resolves:** `requires`, `trainedIn`, `conquest.unit`, `spy.vaultBuilding`.
- **Integer bounds:** all values are safe integers, and the costs, levels and caps keep every intermediate value below 2^53.

---

## 3. Event queue and kernel

### 3.1 Due items (an implicit queue)

| rank | kind           | read from                     | handler                                                                                                                                                                                                       |
| ---- | -------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10   | `build_done`   | `city.buildQueue[0].doneAt`   | `construction.onBuildDone`                                                                                                                                                                                    |
| 20   | `recruit_done` | `city.recruitQueue[0].doneAt` | `recruitment.onRecruitDone`                                                                                                                                                                                   |
| 30   | `arrival`      | `movement.arriveAt`           | kernel `switch (m.kind)` dispatches to: `combat.onAttackArrival`, `movement.onSupportArrival`, `movement.onTransportArrival`, `movement.onReturnArrival`, `espionage.onSpyArrival`, `conquest.onFoundArrival` |
| 40   | `deal_expiry`  | `deal.expiresAt`              | `diplomacy.onDealExpiry`                                                                                                                                                                                      |
| 90   | `checkpoint`   | `s.nextCheckpointAt`          | kernel: hash the state, call the hook, add 3600                                                                                                                                                               |
| 99   | `match_end`    | `s.meta.durationS`            | kernel: `scoring.finalResult`, `status = "ended"`                                                                                                                                                             |

```ts
interface Due {
  t: GameTime;
  rank: number;
  seq: number;
  kind: DueKind;
  ref: string;
} // seq = numeric part of ref id (0 for system)
export function nextDue(s: DeepReadonly<EngineState>): Due | null; // min by (t, rank, seq); O(entities)
export function nextEventTime(s: DeepReadonly<EngineState>): GameTime | null; // null once ended
```

The order `(t, rank, seq)` is total, because `(kind, seq)` is unique. Arrivals in the same second resolve in send order, because a lower movement id was sent first.

Engine invariant: every duration is at least 1 second. Anything scheduled while processing time `t` therefore lands after `t`. This is asserted in code.

### 3.2 Same-second semantics

At game-second `t`, the processing order is:

1. every scheduled item with time ≤ `t`, in `(t, rank, seq)` order (the checkpoint at `t` comes last, because rank 90);
2. then the actions landing at `t`, in `ord` order.

Example: an attack arrives at 14:02:00 and its owner sends `recall_troops` in the same second. The arrival resolves first, and the recall is rejected with "m41 already arrived at D2 14:02".

The hourly hash at H is therefore "state after all events ≤ H, before any action at H". All three paths (lockstep, real-time, replay) produce exactly this ordering, because they all go through `advanceTo` (§3.4).

### 3.3 Cancellation

There is nothing to deschedule, because cancelling edits the entity:

- **`cancel_queue(city, item)`.** Remove the item and refund `paid × cancelRefundPermille / 1000`, settling first. Later items of the same building are cancelled and refunded with it, because their target levels depended on it. If the head was removed, the next item becomes the head with `doneAt = now + durationS`. Items behind it keep their stored `durationS`, so their timing is implicit.
- **`recall_troops(movement)`** (outbound attack, support, transport or found leg, within `recallWindowS` if set). Mutate it to `kind: "return", was: <old kind>, arriveAt = now + (now − departAt)`. If `now == departAt`, restore the units to `from` immediately and delete the movement; no zero-length movements exist.
- **`recall_troops(city, from)`** (stationed support). Remove `city.support[from]` and create a return movement.

### 3.4 Kernel API (engine barrel)

```ts
export type CheckpointHook = (t: GameTime, hash: Hash64, s: DeepReadonly<EngineState>) => void;
export function createMatch(setup: MatchSetup, rules: RulesConfig): EngineState;
export function nextEventTime(s: DeepReadonly<EngineState>): GameTime | null;
export function advanceTo(
  s: EngineState,
  rules: RulesConfig,
  t: GameTime,
  out: GameEvent[],
  onCheckpoint?: CheckpointHook,
): void;
export function validateAction(
  s: DeepReadonly<EngineState>,
  rules: RulesConfig,
  seat: PlayerId,
  a: Action,
): Validation<Plan>;
export function applyAction(
  s: EngineState,
  rules: RulesConfig,
  seat: PlayerId,
  a: Action,
  out: GameEvent[],
): ActionResult;
export function hashState(s: DeepReadonly<EngineState>): Hash64; // fnv1a64(canonicalJson(s))
export function cloneState(s: DeepReadonly<EngineState>): EngineState; // JSON.parse(canonicalJson(s))
```

How the names in the task map here:

- `submit(seat, action, atGameTime)` is `advanceTo(t)` followed by `applyAction`. The `MatchHost` bundles these as `apply(seat, action, { t, ord, ... })`.
- `snapshot()` is `canonicalJson(s)` plus `hashState`.

`advanceTo` (the only place game time moves):

```ts
export function advanceTo(s, rules, t, out, onCheckpoint) {
  if (t < s.now) throw new Error(`time went backwards: ${t} < ${s.now}`); // programmer error
  for (let d = nextDue(s); d !== null && d.t <= t && s.status === "running"; d = nextDue(s)) {
    s.now = d.t; // handlers always run at the event's own time
    handleDue(s, rules, d, out, onCheckpoint); // exhaustive switch on d.kind
    if (changedOwnership(out)) maybeEnd(s, rules, out); // scoring.checkVictory -> early end
  }
  if (s.status === "running") s.now = t;
}
```

Composability: `advanceTo(a); advanceTo(b)` and `advanceTo(b)` give identical hashes for any `a ≤ b`, because handlers use `d.t`, not the target. This is property-tested. It is why lazy real-time `sync` calls, eager lockstep steps and replay all agree.

`applyAction`:

1. Return `MATCH_OVER` if the status is not running.
2. Run `validateAction`, which never mutates (property-tested).
3. Run the `execute*(s, rules, seat, plan, out)` that matches the action type.
4. For attack and spy actions, call `diplomacy.onHostileAction` (pact breaking). If ownership changed, call `scoring.checkVictory`.

A rejected action leaves the state hash unchanged; this is property-tested.

**Domain-module contract.** Each module exports `validateX(s, rules, seat, action) → Validation<XPlan>` and `executeX(s, rules, seat, plan, out) → XEffect`, plus its `on*` due handlers. The kernel dispatches with one exhaustive `switch`. There are no registries and no classes.

---

## 4. Determinism

**PRNG: sfc32** (Small Fast Chaotic, 4×uint32 state, passes PractRand). It is pure 32-bit integer maths with `| 0` and `>>> 0`, so every JavaScript engine gives the same results.

```ts
export type Rng = [number, number, number, number];
export function rngFrom(seed: string, stream: string): Rng;
// [a, b] = halves of fnv1a64(`${seed}|${stream}`), c = high half of fnv1a64(`${seed}|${stream}|2`), d = 1;
// then discard 15 outputs
export function nextU32(r: Rng): number; // standard sfc32 step; mutates r
export function nextInt(r: Rng, n: number): number; // 1 ≤ n ≤ 2^32; rejection: lim = 2^32 − (2^32 % n)
export function shuffle<T>(r: Rng, xs: T[]): void; // Fisher–Yates
```

Named streams keep consumers independent, so adding a bot call never shifts world generation:

| stream                      | used by                                                        |
| --------------------------- | -------------------------------------------------------------- |
| `world`                     | world generation                                               |
| `engine`                    | `state.rng`                                                    |
| `bot:${seat}:${t}:${round}` | bot decisions; a fresh stream per round, so bots are stateless |
| `think:${seat}`             | real-time think latency                                        |

**Ordering keys are hashes, not PRNG draws:**

```ts
actionOrderKey(seed, t, seat) = fnv1a64(`${seed}|ord|${t}|${seat}`)
seatOrder(seed, t, seats)      // sort by (actionOrderKey, seat id)
```

**Hash: FNV-1a 64** over the UTF-8 bytes of the canonical JSON.

- Offset basis `0xcbf29ce484222325`; prime `0x100000001b3 = 2^40 + 435`.
- Implemented with two uint32 halves, no BigInt. For each byte:
  ```
  lo ^= byte
  loMul = lo × 435          (< 2^41, exact)
  hiMul = hi × 435          (< 2^41, exact)
  carry = floor(loMul / 2^32)
  hi = (hiMul + carry + ((lo << 8) >>> 0)) >>> 0
  lo = loMul >>> 0
  ```
- UTF-8 is encoded inline from code points; a lone surrogate becomes `EF BF BD`. This means `fnv1a64` agrees with the standard `fnv1a64` CLI tools.
- Test vectors: `""` → `cbf29ce484222325`, `"a"` → `af63dc4c8601ec8c`, `"foobar"` → `85944171f73967e8`.
- FNV-1a is not collision-resistant against an adversary. That is acceptable here: it is an integrity and determinism check, not a security check.

**Canonical JSON** (`canonicalJson`, in the style of RFC 8785):

- object keys sorted by UTF-16 code unit;
- no whitespace;
- strings written with `JSON.stringify`, which is well-formed since ES2019;
- arrays in order;
- `undefined` properties omitted, and `undefined` inside an array throws;
- numbers must pass `Number.isSafeInteger` (`-0` is written as `0`). **Any float, NaN or Infinity throws**, so a stray division is caught at the next checkpoint at the latest;
- only plain objects and arrays are allowed: `Map`, `Set`, `Date`, BigInt and functions throw.

**Integer maths** (lib/intmath.ts):

- `idiv(a, b) = (a − a % b) / b`. It is exact for safe integers; plain `Math.floor(a / b)` can round wrongly near 2^53.
- `ceilDiv`.
- `mulDiv(a, b, c)`, which asserts that `a × b` is a safe integer.
- `isqrtCeil` (Newton's method on integers) for distances.
- `clamp`, `assertSafeInt`.

Percentages are written in permille (`× n / 1000` through `mulDiv`). Travel time is `max(minTravelS, ceilDiv(isqrtCeil(dx² + dy²) × 3600, speed))`, floored at `minAttackS` for attacks.

**Iteration order rules:**

1. Never let object key order decide anything. Iterate with `sortedKeys` or `sortedValues` (the `compareIds` order). JS iterates in insertion order, and a state loaded from a snapshot has a different insertion order than a live one.
2. Arrays in the state are ordered by meaning (queues) or kept sorted (alliance members, pacts).
3. Every `sort` takes a comparator (lint enforces this). `Array.prototype.sort` is stable since ES2019.
4. No `Map` or `Set` in the state; they are allowed as local temporaries only when their order does not reach a result.
5. No `localeCompare` and no `Intl`.
6. No module-level mutable state in the engine. Memoisation keyed by a `rules` object in a `WeakMap` is allowed, because it is pure.

Property test: shuffling the insertion order of every record in the state does not change the hash after the same steps.

**Exceptions.** The engine never throws for player mistakes; those are `Violation` data. It throws only when an invariant is broken, which is a bug. The run then crashes with the seed, `t` and the last action, so it can be reproduced.

---

## 5. Action pipeline

Each layer lists where it runs, what it rejects with, and how the rejection is logged.

1. **Turn gate.** Runs in gateway `caps.ts`. The seat must be in a turn and within its round and call caps. Rejects with `NOT_IN_TURN` or `TURN_CAP`. Logged as a `reject` trace.
2. **Schema.** Runs in gateway `tools.ts`: Zod parses the tool arguments. Rejects with `INVALID_ARGS`, with a summary of the issues and the expected shape. Logged as `reject`.
3. **Visibility (fog).** Runs in gateway `projection.ts`. Every referenced id must be in the seat's view with the right role:
   - `from` is one of the seat's own cities;
   - `to` is a known city;
   - a movement or queue item belongs to the seat;
   - a deal is addressed to the seat.

   Rejects with `UNKNOWN_ID` or `NOT_OWNER`. These messages are uniform, so they cannot leak whether a hidden id exists. Logged as `reject`.

4. **Interface caps.** Runs in gateway `caps.ts`: writes per turn, messages per day, recipients, text length, note size. Rejects with `TURN_CAP`, `DAILY_CAP` or `TOO_LONG`. Logged as `reject`.
5. **Game-rule precheck.** In real-time only, the gateway calls `engine.validateAction` against the current state. This is the fast-fail path. Rejects with an engine violation. Logged as `reject`.
6. **Authoritative apply.** `engine.applyAction` runs at the landing time and validates again; in real-time the state may have changed inside the second. Rejects with an engine violation. Logged as an `action` entry with its result.

**Contract: engine violations are view-safe.** A violation may only mention the actor's own entities and public facts. For example, "c3 lacks 120 wood" or "c12 belongs to your ally p4" are fine, because alliances are public. A violation must never mention the target's troops or resources. A test runs every violation code through the leakage harness (§11).

**Error format.** Every error is data:

```ts
type ToolError = {
  ok: false;
  code: ErrorCode;
  message: string;
  hint: string;
  data?: Record<string, string | number>;
};
// engine side (protocol/errors.ts) — structured, presentation-free:
type Violation =
  | { code: "MATCH_OVER" }
  | {
      code: "INSUFFICIENT_RESOURCES";
      city: CityId;
      need: Resources;
      have: Resources;
      missing: Partial<Resources>;
      readyAt: GameTime | null;
    }
  | { code: "QUEUE_FULL"; city: CityId; queue: "build" | "recruit"; max: number }
  | { code: "MAX_LEVEL"; building: string; max: number }
  | { code: "REQUIREMENT"; building: string; level: number; has: number }
  | { code: "POPULATION"; city: CityId; need: number; free: number; cap: number }
  | {
      code: "UNITS_UNAVAILABLE";
      city: CityId;
      unit: string;
      requested: number;
      available: number;
      lastLeftIn: MovementId | null;
      lastLeftAt: GameTime | null;
    }
  | { code: "TRANSPORT_CAPACITY"; need: number; have: number }
  | { code: "NO_FREE_SLOT"; island: IslandId }
  | { code: "INVALID_TARGET"; reason: "own_city" | "same_city" | "eliminated" | "not_ally" }
  | {
      code: "NOT_RECALLABLE";
      movement: MovementId;
      reason: "arrived" | "window_passed" | "kind";
      at: GameTime | null;
    }
  | { code: "DEAL_CLOSED"; deal: DealId }
  | { code: "NOT_IN_ALLIANCE" }
  | { code: "ALLIANCE_FULL"; max: number }
  | { code: "BAD_ARGUMENT"; field: string; reason: string };
```

`gateway/explain.ts` turns every code into a message and a hint, with formatted numbers and game times. The engine does no wording at all.

```json
{"ok":false,"code":"INSUFFICIENT_RESOURCES","message":"c3 lacks 120 wood and 40 stone for barracks level 4 (needs 600 wood, 400 stone, 100 gold).","hint":"At current production (wood 180/h, stone 90/h) c3 can afford it at D2 15:10 (in 40m), or send resources from c8."}
{"ok":false,"code":"UNITS_UNAVAILABLE","message":"c3 has 4 hoplite at home, 20 requested: 16 left with m41 at D2 14:02.","hint":"Send at most 4 hoplite, or recall m41 (back at D2 14:30 if recalled now)."}
```

**High-level actions.** One tool call becomes N canonical engine actions:

- `build({city, buildings: ["farm","warehouse","barracks"]})` becomes 3 `build` actions;
- `recruit({city, units: {hoplite: 20, archer: 10}})` becomes 2 `recruit` actions.

The N actions are applied in order with consecutive `ord` values. Each item gets its own result: `{ok: true, items: [{ok: true, queued: "q17", level: 4, doneAt: "D2 16:40"}, {ok: false, code, message, hint}]}`. A batch is not atomic, and the documentation says so. The top-level `ok` is `false` only when layers 1–4 reject the whole call. A success result always carries the useful consequence: ids, completion or arrival times, and the cost paid.

**Engine actions** (protocol/actions.ts):

```ts
type Action =
  | { type: "build"; city: CityId; building: string }
  | { type: "recruit"; city: CityId; unit: string; count: number }
  | { type: "cancel"; city: CityId; item: QueueItemId }
  | { type: "attack" | "support"; from: CityId; to: CityId; units: UnitCounts }
  | { type: "spy"; from: CityId; to: CityId; gold: number }
  | { type: "transport"; from: CityId; to: CityId; cargo: Partial<Resources> }
  | { type: "found"; from: CityId; island: IslandId; units: UnitCounts }
  | { type: "recall"; movement: MovementId }
  | { type: "recall_support"; at: CityId; from: CityId }
  | { type: "message"; to: PlayerId[]; text: string } // to: sorted unique
  | { type: "propose"; kind: "alliance" | "nap"; to: PlayerId }
  | { type: "answer"; deal: DealId; accept: boolean }
  | { type: "leave_alliance" };
```

Messages are engine actions: they are ordered, logged, delivered at once as a `message` event, and trigger wake-ups. Their text is **not** kept in the state. The archives keep it, and `evHash` covers it.

---

## 6. Gateway

### 6.1 MatchHost (the imperative shell)

```ts
export function createMatchHost(o: {
  setup: MatchSetup;
  rules: RulesConfig;
  config: GatewayConfig;
  sink: LogSink;
  clock: ClockInfo;
  seats: SeatInfo[];
  checkInvariants?: boolean;
}): MatchHost;
export interface LogSink {
  write(e: LogEntry): void;
  snapshot?(t: GameTime, hash: Hash64, json: string): void;
} // synchronous
export interface MatchHost extends ClockHost {
  state(): DeepReadonly<EngineState>;
  seat(id: PlayerId): DeepReadonly<SeatState>;
  beginTurn(seat: PlayerId, t: GameTime): Briefing; // drains inbox and wake reasons, writes a `wake` entry
  callTool(seat: PlayerId, call: ToolCall, env: TurnEnv): Promise<ToolResult>;
  endTurn(
    seat: PlayerId,
    t: GameTime,
    info: { selfWakeAt?: GameTime; thought?: string; rounds: number },
  ): void;
}
```

`sync(t)` and `apply(...)` are the two doors.

**`sync(t)`:**

1. Calls `engine.advanceTo(t)` with a checkpoint hook that writes the `checkpoint` entry, the snapshot and, optionally, the `checkInvariants` result.
2. Routes every emitted event:
   - writes an `event` log entry;
   - for each recipient in `ev.to`: appends to the archive (archivable kinds), appends to the inbox, and passes the event to `wake.noteTrigger`;
   - for public events: appends to `news` for every active seat (no wake-up).

**`apply(...)`:**

1. Asserts `t ≥ now`, then runs `sync(t)`.
2. Calls `engine.applyAction`.
3. Writes an `action` entry with its result.
4. Routes the emitted events the same way.

**`precheck(seat, action)`** calls `engine.validateAction`. When the check fails, it also writes the `reject` trace entry.

### 6.2 Fog-of-war projection (pure)

`projectCity`, `projectIsland`, `projectMap`, `projectPlayer`, `projectLeaderboard`, `projectMovements` and `projectEvent` all have the shape `(s, rules, seat, archive?) → View`.

| data                                              | owner sees                                                                    | others see                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| map: islands, slots, cities, owners               | yes                                                                           | yes, when `visibility.mapPublic`                                          |
| city name and points                              | yes                                                                           | yes (points when `pointsPublic`)                                          |
| city resources, buildings, queues, units, support | yes                                                                           | no; only the latest spy report from the archive, stamped "as of D2 10:00" |
| own movements                                     | yes, in full                                                                  | no                                                                        |
| incoming movements to own cities                  | id, kind, origin, sender, arrival time (units only when `incomingShowsUnits`) | no                                                                        |
| battle report                                     | each participant gets a filtered copy                                         | no                                                                        |
| messages and deals                                | sender, recipients, parties                                                   | no                                                                        |
| alliances, pacts, conquests, eliminations         | public                                                                        | public                                                                    |
| personalities and models                          | not in the game at all                                                        | no                                                                        |

Projections always build fresh objects and never hand out references into the state.

### 6.3 Briefing (pure, compact JSON)

`buildBriefing(s, rules, seat, { reasons, inbox, news, notes, capsLeft, config }) → Briefing`

Example:

```json
{
  "you": "p3",
  "t": "D2 14:05",
  "left": "5d 9h 55m",
  "wake": ["incoming attack m41 from c12 (p6) → c7 at D2 15:12", "message msg18 from p5"],
  "cities": [
    {
      "id": "c7",
      "isl": "i4",
      "res": [1200, 800, 300],
      "prod": [180, 150, 60],
      "cap": 5000,
      "pop": [212, 300],
      "build": ["barracks→4 D2 15:20", "wall→2 D2 16:40"],
      "recruit": ["20 hoplite D2 15:00"],
      "units": { "hoplite": 35, "trireme": 4 },
      "support": { "c9": { "hoplite": 10 } }
    }
  ],
  "moves": [
    { "id": "m41", "kind": "attack", "from": "c12", "by": "p6", "to": "c7", "at": "D2 15:12" }
  ],
  "inbox": [{ "id": "msg18", "from": "p5", "at": "D2 13:50", "text": "…" }],
  "events": ["q31 done: farm→6 (c7)", "r12 battle at c15: won, lost 3 hoplite"],
  "news": ["p2 left alliance a1"],
  "notes": "…",
  "caps": { "rounds": 8, "calls": 40, "wakesLeftToday": 4 }
}
```

Budget:

- Target ≤ 1,600 characters (about 400 tokens); hard cap `briefing.maxChars` = 2,400.
- Lists are truncated as `"+3 more: search_archives / view_city"`.
- Message text is a typed field and never part of the instructions. Control characters are stripped and the text is truncated to `messages.maxChars`.
- Phase 1 estimates tokens as characters ÷ 4. A real tokenizer comes in phase 2.

### 6.4 Tools (names exactly as in the brief, plus one proposed tool)

**Observe** (reads, no engine action):

- `view_city {city}` → `CityView`;
- `view_island {island}`;
- `view_map {}`;
- `view_player {player}`;
- `leaderboard {}`;
- `rules {section?}` → rules JSON plus the gateway caps.

**Economy** (writes):

- `build {city, buildings[1..5]}` → N × `build`;
- `recruit {city, units}` → N × `recruit`;
- `cancel_queue {city, item}` → `cancel`;
- `send_resources {from, to, res}` → `transport`.

**Military** (writes):

- `attack {from, to, units}` → `attack`;
- `support {from, to, units}` → `support`;
- `spy {from, to, gold}` → `spy`;
- `recall_troops {movement} | {city, from}` → `recall` | `recall_support`;
- `found_city {from, island, units}` → `found`.

**Diplomacy** (writes):

- `send_message {to: PlayerId | PlayerId[], text}` → `message`;
- `propose_alliance {to, kind?: "alliance" | "nap"}` → `propose`;
- `answer_proposal {deal, accept}` → `answer`;
- `leave_alliance {}` → `leave_alliance`.

**Memory** (gateway only):

- `write_note {text, mode?: "replace" | "append"}`;
- `read_notes {}`;
- `search_archives {query?, kind?, with?, since?, until?, id?, limit≤20}`. This one is **proposed**: the brief requires searchable archives but names no tool (§13).

**Turn:** `end_turn {wake_in? | wake_at?, thought?}` sets `selfWakeAt`, which must be ≥ now + `minSelfWakeS`.

Notes:

- The registry is `Record<ToolName, { input: ZodType; kind: "read" | "write" | "meta"; handler }>`.
- `toolJsonSchemas()` exports `z.toJSONSchema` for every input, ready for MCP in phase 2.
- Tool arguments accept `"D2 14:05"`, `"1h30m"` or raw game-seconds.

### 6.5 Caps (GatewayConfig; data, also returned by the `rules` tool)

```ts
DEFAULT_GATEWAY_CONFIG = {
  turn: { maxRounds: 8, maxCalls: 40, maxWrites: 20, maxTurnGameS: 1800 }, // maxTurnGameS: real-time only
  wake: {
    groupWindowS: 900,
    urgentMinGapS: 120,
    safetyS: 43200,
    budgetPerDay: 6,
    minSelfWakeS: 600,
  },
  messages: { maxChars: 1000, perDay: 30, maxRecipients: 5 },
  notes: { maxChars: 2000 },
  briefing: { maxInbox: 5, maxEvents: 12, maxNews: 5, maxChars: 2400 },
  archive: { maxHits: 20 },
};
```

Per-turn counters reset when a turn begins. Per-day counters are keyed by `idiv(t, 86400)`.

### 6.6 Notes and archives

**Notes.** `write_note` replaces or appends text. The result is checked against `notes.maxChars` and rejected with numbers: "note would be 2,340 chars, limit 2,000; remove 340 or use mode=replace". Each write appends a `note` log entry. The notes appear in every briefing.

**Archives.** These are the seat's raw relevant `GameEvent`s (messages in and out, battle and spy reports, deals, conquests), projected when read. `search_archives`:

- matches case-insensitive substrings over a projected summary line;
- filters by kind, counterpart and time range;
- returns newest first, sorted by `(t desc, id)`, and is deterministic;
- `id` returns one full entry.

### 6.7 Wake-up scheduler (pure, gateway/wake.ts)

```ts
interface WakeState {
  urgentAt: GameTime | null; // earliest undelivered urgent trigger
  firstPendingAt: GameTime | null; // earliest undelivered non-urgent trigger
  selfAt: GameTime | null; // from end_turn
  lastWakeAt: GameTime;
  lastTurnEndAt: GameTime;
  reasons: WakeReason[]; // drained into the next briefing
}
export function wakeTriggerFor(
  ev: GameEvent,
  seat: PlayerId,
): { urgent: boolean; reason: WakeReason } | null;
export function noteTrigger(
  w: WakeState,
  trig: { urgent: boolean; reason: WakeReason },
  t: GameTime,
): void;
export function nextWakeAt(
  w: WakeState,
  day: DayCounters,
  cfg: WakeConfig,
): { at: GameTime; exempt: boolean };
export function onTurnStart(w: WakeState, t: GameTime): WakeReason[];
export function onTurnEnd(
  w: WakeState,
  t: GameTime,
  selfAt: GameTime | null,
  cfg: WakeConfig,
): void;
```

**Triggers:**

- An incoming **attack** (detected at send time), or a city lost: urgent.
- A message, a deal proposed or answered, or a queue becoming idle: not urgent.
- Not wake triggers: battle reports, spy reports, support arrivals, single queue items. They go into the next briefing; bots and agents schedule a wake themselves if they care.

**Computation:**

```
safety  = lastTurnEndAt + safetyS                                  (exempt)
urgent  = urgentAt == null ? ∞ : max(urgentAt, lastWakeAt + urgentMinGapS)   (exempt)
grouped = firstPendingAt == null ? ∞ : firstPendingAt + groupWindowS (budgeted; events closer than the window share one wake)
self    = selfAt ?? ∞                                              (budgeted)
b = min(grouped, self); if day(b) has used ≥ budgetPerDay -> b = start of the next day
wakeAt = min(safety, urgent, b)
```

Rules:

- The match start (`t = 0`) is an exempt wake for every seat.
- A wake counts against the budget only when no exempt trigger is due at that time.
- **One turn at a time.** A seat in a turn is never due. Triggers during a turn go into the inbox. An urgent trigger re-wakes the seat at `max(t, lastWakeAt + urgentMinGapS)` after the turn ends, which is "as soon as the turn ends" up to a 2-minute anti-spam gap.
- **Guarantee.** After a turn at `t`, every wake candidate of that seat is later than `t`. This is what makes lockstep terminate (§7.2).
- **Attack spam is bounded** by the urgent gap, by the attacker's `maxWrites` per turn, and by the attacker's own wake budget.

### 6.8 Turn runner and the controller contract

```ts
// protocol/turn.ts — implemented by bots now, by the LLM orchestrator in phase 2
export interface RoundInput {
  seat: PlayerId;
  round: number;
  maxRounds: number;
  briefing: Briefing;
  results: ToolResult[];
}
export interface RoundOutput {
  calls: ToolCall[];
  thought?: string;
} // empty calls = turn over
export interface SeatController {
  readonly label: string;
  round(input: RoundInput): Promise<RoundOutput>;
}
// gateway/turn.ts
export async function runTurn(
  host: MatchHost,
  seat: PlayerId,
  ctl: SeatController,
  env: TurnEnv,
  cfg: TurnConfig,
): Promise<void>;
```

`runTurn` does the following:

1. `sync(env.now())`, then `beginTurn`, which returns the briefing.
2. For up to `maxRounds` rounds:
   - stop if the turn has used more than `maxTurnGameS`;
   - `await ctl.round(...)`;
   - run the calls one after another through `host.callTool`;
   - `end_turn` stops the loop.
3. `endTurn` records the thought and the self-wake, and writes a `turn` entry.

If the controller throws, the error is written as a `turn_error` trace and the turn ends. In tests, any `turn_error` fails the test.

---

## 7. Clocks

### 7.1 Interfaces (gateway/clock/types.ts)

```ts
export interface TimeSource {
  nowMs(): number;
  sleepUntil(ms: number, signal?: AbortSignal): Promise<void>;
}
export interface ApplyMeta {
  t: GameTime;
  ord: number;
  key: Hash64;
  n: number;
  call: string;
}
export interface TurnEnv {
  now(): GameTime;
  submit(seat: PlayerId, actions: Action[], call: string): Promise<ActionResult[]>;
}
export interface ClockHost {
  readonly seed: string;
  readonly endsAt: GameTime;
  now(): GameTime;
  ended(): boolean;
  sync(t: GameTime): void; // door 1
  apply(seat: PlayerId, a: Action, at: ApplyMeta): ActionResult; // door 2
  precheck(seat: PlayerId, a: Action): ActionResult;
  nextTime(): GameTime | null; // min(engine nextEventTime, earliest seat wakeAt); null when ended
  dueSeats(t: GameTime): PlayerId[]; // active, not in turn, wakeAt ≤ t, in seatOrder(seed, t)
  runTurn(seat: PlayerId, ctl: SeatController, env: TurnEnv): Promise<void>;
  finish(): MatchEnd; // writes the `end` entry
}
export interface ClockDriver {
  readonly kind: "lockstep" | "realtime";
  run(host: ClockHost, seats: ReadonlyMap<PlayerId, SeatController>): Promise<MatchEnd>;
}
```

### 7.2 Lockstep: game time jumps from event to event and waits for every woken seat

```ts
async run(host, seats) {
  host.sync(0);
  while (!host.ended()) {
    const t = host.nextTime(); if (t === null) break;
    host.sync(t);                                  // events ≤ t, checkpoints, wake triggers
    const ran = new Set<PlayerId>(); const perSeat = new Map<PlayerId, number>(); let ord = 0;
    for (let seat = firstNotIn(host.dueSeats(t), ran); seat; seat = firstNotIn(host.dueSeats(t), ran)) {
      ran.add(seat);                               // a seat urgently re-woken at t waits until t + urgentMinGapS
      const env: TurnEnv = { now: () => t, submit: async (s, actions, call) => actions.map((a) => {
        const n = perSeat.get(s) ?? 0; perSeat.set(s, n + 1);
        return host.apply(s, a, { t, ord: ord++, key: actionOrderKey(host.seed, t, s), n, call });
      }) };
      await host.runTurn(seat, controllerOf(seats, seat), env);
    }
    // invariant (asserted): host.nextTime() > t
  }
  return host.finish();
}
```

Properties:

- Turns run one after another in the seeded seat order. Actions apply instantly, so tool results are immediate. Game time is frozen during a turn.
- Fully reproducible with deterministic bots. A later seat in the same second sees the actions of earlier seats; the per-second seeded rotation keeps this fair on average.
- Phase 2 may add `concurrency: "parallel"`, applying actions in arrival order. That stays replayable but not reproducible from run to run.

### 7.3 Real-time: game time = speedFactor × wall time; seats act asynchronously

```
gameNow() = min(endsAt, floor((time.nowMs() − t0) × speedFactor / 1000))
pending: Map<second, Submission[]>        // writes waiting for their game-second to close

syncTo(g): for s in sorted(pending.keys()) with s < g: closeSecond(s); then host.sync(g)
closeSecond(s): host.sync(s); sort batch by (key = actionOrderKey(seed, s, seat), n);
                batch.forEach((p, ord) => p.resolve(host.apply(p.seat, p.action, { t: s, ord, key, n, call })))
env.submit(seat, actions, call):
  g = gameNow(); syncTo(g)
  per action: pre = host.precheck(seat, a) -> if !ok resolve(pre) now; else enqueue at g, return a promise
  signal.notify()
loop until host.ended():
  g = gameNow(); syncTo(g)
  for seat of host.dueSeats(g) not in flight: start host.runTurn(seat, ctl, env) (not awaited);
      on settle: remove from in-flight, signal.notify()
  next = min(host.nextTime() ?? ∞, minPendingSecond + 1, endsAt)
  await race(time.sleepUntil(t0 + ceil(next × 1000 / speedFactor), abort), signal.wait()); abort the loser
end: syncTo(endsAt + 1)   // leftover writes get MATCH_OVER
     await all in-flight turns; host.finish()
```

Properties:

- **`engine.now ≤ min(pending seconds)` always holds**, because a second closes only after the clock has passed it, and closes before the engine moves beyond it. So the order "events ≤ s, then the seeded batch at s" is exactly the same as in lockstep and replay.
- **Reads** run `syncTo(gameNow())` first. Since tool calls inside a turn are awaited one after another, a seat always reads its own earlier writes.
- **Lag:** when the loop falls behind, `gameNow()` jumps ahead, `syncTo` closes the seconds in order, and wake-ups start late. That is correct, only later than planned. The summary reports the lag.
- **Turn timeout:** `maxTurnGameS`. After it, further calls get `TURN_EXPIRED`.

### 7.4 How bots plug in

- **Lockstep.** `seats.set(p, createBot(strategy, { seat: p, seed }))`. `round()` resolves at once. Decisions use `rngFrom(seed, "bot:p:t:round")`, so they are reproducible.
- **Real-time.** The same bot, wrapped as `withThinkTime(bot, { sleep: (ms) => time.sleepUntil(time.nowMs() + ms), rng: rngFrom(seed, "think:p"), minMs, maxMs })`. Each round costs wall time, so game time advances between rounds, writes land at `gameNow()`, and several seats think at once.
- **Phase 2.** The LLM orchestrator implements `SeatController` with one model round trip per `round()`. Nothing else changes.

### 7.5 Testing real-time quickly

1. **Virtual time, deterministic.**
   - `VirtualTimeSource` keeps a heap of timers ordered by `(ms, seq)`.
   - `run(main)` loop: flush with one macrotask (`setImmediate` when present, otherwise `setTimeout(0)`); if `main` has settled, return its value; otherwise jump `nowMs` to the earliest timer and resolve it.
   - If `main` is still pending but no timers remain, it throws a deadlock error.
   - With speed ×3 and think times of 20–120 s per round, 7 game days run in seconds of CPU. Two runs give byte-identical logs, which the test checks.
   - The requirement: nothing in a turn awaits real I/O. That is why `LogSink` is synchronous.
2. **System time, high speed.** `systemTimeSource()` (`performance.now` and `setTimeout`) with speed ≈ 50,000 and think times of 0.2–2 ms runs 7 game days in about 12 s of wall time. Logs differ between runs, but **`verifyReplay` must pass**. This proves that the real async interleavings are fully captured in `(t, ord)`.
3. **Interleaving property.** `fc.scheduler()` drives the promise resolutions of the real-time driver over a small scenario. For every interleaving:
   - every submit resolves exactly once;
   - the log's `(t, ord)` order is strictly increasing;
   - replay reproduces the hashes.

### 7.6 Why both clocks replay identically

Every state change goes through `sync` or `apply`. Both are synchronous and deterministic, given the state and their arguments. The host writes the log entries in the order it calls them, and the checkpoints come from inside `advanceTo`. Replay calls `advanceTo(entry.t)` and then `applyAction` for each `action` entry in file order. By composability (§3.4) and the same-second rule (§3.2), it reproduces the same state at every checkpoint. The clock only changes **which** `(t, ord, action)` tuples exist, never how they are interpreted.

---

## 8. Match log and replay

### 8.1 Run directory

```
runs/<name>/
  match.jsonl      append-only log (header first)
  snapshots.jsonl  one line per game hour: {"t":3600,"hash":"…","engineVersion":"…","state":{…}}  (--snapshots hourly|none)
  summary.json     §10
```

`LogSink` is synchronous. It buffers entries and flushes with `appendFileSync` at each checkpoint and at the end.

### 8.2 Entries (protocol/log.ts; one JSON object per line)

```ts
type LogEntry =
  | {
      type: "header";
      format: 1;
      engineVersion: string;
      stateVersion: number;
      seed: string;
      durationS: number;
      seats: { id: PlayerId; name: string; controller: string }[];
      rules: RulesConfig;
      rulesHash: Hash64;
      gateway: GatewayConfig;
      gatewayHash: Hash64;
      clock:
        | { kind: "lockstep" }
        | { kind: "realtime"; speedFactor: number; time: "virtual" | "system" };
      initialHash: Hash64;
      wallStart?: string;
    } // wallStart: informational only
  | {
      type: "action";
      t: GameTime;
      ord: number;
      seat: PlayerId;
      key: Hash64;
      n: number;
      call: string;
      action: Action;
      result: { ok: true } | { ok: false; code: ErrorCode };
    } // REPLAYED
  | { type: "checkpoint"; t: GameTime; hash: Hash64 } // VERIFIED (every 3600 s)
  | { type: "end"; t: GameTime; result: MatchResult; finalHash: Hash64 } // VERIFIED
  | { type: "event"; t: GameTime; ev: GameEvent } // derived (covered by evHash) — for summaries/spectators
  | {
      type: "wake";
      t: GameTime;
      seat: PlayerId;
      reasons: WakeReason[];
      exempt: boolean;
      day: number;
      used: number;
    }
  | {
      type: "turn";
      t: GameTime;
      seat: PlayerId;
      startedAt: GameTime;
      rounds: number;
      calls: number;
      writes: number;
      rejects: number;
      selfWakeAt?: GameTime;
      thought?: string;
    }
  | { type: "reject"; t: GameTime; seat: PlayerId; call: string; tool: string; code: ErrorCode }
  | { type: "note"; t: GameTime; seat: PlayerId; text: string }
  | { type: "turn_error"; t: GameTime; seat: PlayerId; error: string };
```

`call` is a reference of the form `"p3/w12/r2.1"`: seat, wake index, round, call index. Entries are in non-decreasing `t`. Within one `t`, `action.ord` is strictly increasing.

### 8.3 Checkpoint and snapshot cadence

There is one checkpoint every game hour (`CHECKPOINT_S = 3600`), plus `initialHash` in the header and `finalHash` in the `end` entry: 168 checkpoints for a 7-day match.

The hash covers the whole state, including `evHash`, so it also verifies every message and report.

Snapshots are the canonical state JSON written next to each checkpoint. Expected size: about 50–100 KB per snapshot, so about 8–17 MB per match. Turn them off in CI.

### 8.4 Verifier (engine/replay.ts, pure; sim wraps the file I/O)

```ts
export interface ReplayReport {
  ok: boolean;
  actions: number;
  checkpoints: number;
  finalHash: Hash64;
  warnings: string[]; // e.g. engineVersion differs
  mismatch?: {
    kind: "header" | "initial" | "order" | "result" | "checkpoint" | "end";
    t: GameTime;
    entryIndex: number;
    expected: string;
    actual: string;
  };
}
export function verifyReplay(
  header: LogHeader,
  entries: Iterable<LogEntry>,
  hooks?: { onCheckpoint?: CheckpointHook },
): ReplayReport;
export function replayTo(header: LogHeader, entries: Iterable<LogEntry>, t: GameTime): EngineState; // debugging / spectator seek
```

Algorithm:

1. Check `rulesHash` against the embedded rules and run `checkRules`.
2. `createMatch(setupFrom(header), header.rules)` and compare its hash with `initialHash`.
3. For each `action` entry: assert the `(t, ord)` order, `advanceTo(t)` (the hook compares with the next expected `checkpoint`), apply the action, and compare `ok`/`code`.
4. At the end: `advanceTo(end.t)`, then compare `finalHash` and the result, and check that every checkpoint was matched.
5. Trace entries are ignored.

`sim verify` adds one thing: at the first mismatching checkpoint it loads the stored snapshot and prints a structural diff of up to 20 differing JSON paths (`sim/diff.ts`).

### 8.5 Golden replays

There are two small committed logs in `packages/sim/golden/`: a 1-day lockstep run with 4 bots and a 1-day real-time run with virtual time. `bun test` verifies them.

When behaviour changes on purpose:

1. Bump `ENGINE_VERSION`.
2. Run `bun run sim golden --update`. It refuses to run if `ENGINE_VERSION` equals the version in the existing goldens.
3. Review the diff.

A behaviour-preserving refactor keeps the goldens green, because the engine version is not part of the hashed state.

---

## 9. Bots

**Interface.** Each bot is a `SeatController` (§6.8):

```ts
export type Strategy = "turtle" | "raider" | "expander" | "diplomat" | "chaos";
export function createBot(strategy: Strategy, o: { seat: PlayerId; seed: string }): SeatController;
export function withThinkTime(
  ctl: SeatController,
  o: { sleep(ms: number): Promise<void>; rng: Rng; minMs: number; maxMs: number },
): SeatController;
```

Bots import only `protocol`. They see only briefings and tool results, exactly like an LLM. Their memory across wakes lives in **notes**: no hidden in-memory state, except a per-process cache of the `rules` tool result keyed by `rulesHash`. This exercises the notebook path and mirrors the "one wake = one fresh session" rule.

**Typical rounds:**

1. Read the briefing; call `rules` once per process, `view_city` for each own city, and `view_map` at the start.
2. Issue writes.
3. `end_turn` with `wake_in` set to the next interesting time, which bounds the wake rate.

**Strategies** (all seeded and deterministic):

| strategy                 | play                                                                                                                                                                                                                                                                    | tools exercised                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `turtle` (builder)       | economy first, warehouse kept ahead of production, wall, defensive units at about 30% of population; accepts every alliance offer; never attacks; asks allies for support when attacked                                                                                 | build, recruit, cancel_queue (when a queue blocks), propose/answer, send_message, support      |
| `raider`                 | barracks and harbor, then attackers and transports; spies the nearest non-allied city; attacks when its own power ≥ 1.3 × the estimated defence from the latest spy report; recalls if a newer report shows a stronger defender; loops on loot                          | spy, attack, recall_troops, view_island, search_archives                                       |
| `expander`               | settlers, `found_city` on the nearest free slots, `send_resources` between its own cities, moderate defence                                                                                                                                                             | found_city, send_resources, view_map                                                           |
| `diplomat` (opportunist) | proposes alliances or pacts to 1–2 neighbours early; writes "ally p4 since D1" in its notes; from day 3, if it ranks in the top 2 and an adjacent ally is weaker, it leaves the alliance and attacks that ally (a betrayal); answers proposals according to the ranking | propose_alliance, answer_proposal, leave_alliance, send_message, write_note/read_notes, attack |
| `chaos` (tests only)     | seeded random calls to every tool, with valid and invalid arguments                                                                                                                                                                                                     | every error path; must never crash the gateway or the engine                                   |

---

## 10. sim CLI (bun)

```
bun run sim run     --seed s42 --players 8 --bots turtle,raider,expander,diplomat [--chaos 1]
                    --clock lockstep|realtime [--time virtual|system] [--speed 3] [--think 20s-120s]
                    [--days 7] [--rules path.json] [--snapshots hourly|none] [--check-invariants] --out runs/s42
bun run sim verify  runs/s42 [--snapshots]       # replay + diff at first mismatch
bun run sim summary runs/s42 [--json]
bun run sim state   runs/s42 --at "D3 12:00"     # replayTo + print projected or raw state
bun run sim golden  [--update]
```

Defaults: `--players 8` (allowed range 6–12); islands from `rules.map` (30–50); `--days 7`.

Exit codes:

- `0`: OK;
- `1`: run error (exception, `turn_error` or invariant violation);
- `2`: verify mismatch.

**Summary** (printed table plus `summary.json`):

- the winner, the reason and the end time;
- per seat: strategy, points, cities, battles won and lost, conquests made and suffered, units lost;
- totals: battles, conquests, foundings, alliances formed, betrayals (`pact_broken`), messages;
- **wake-ups per seat per game day**: average and maximum, split into budgeted, urgent, safety, self and start;
- rounds per wake and tool calls per wake;
- gateway rejects by code;
- in real-time runs: the 95th-percentile turn duration in game-seconds and wall seconds, the driver lag, and the speed-rule check (fastest attack in wall minutes ≥ 10 × the 95th-percentile turn);
- an LLM cost driver line: seats × wakes × rounds. This is the estimate the brief asks phase 1 to measure.

---

## 11. Testing strategy (bun:test + fast-check)

**Unit tests**, next to the code:

- lib: FNV vectors; sfc32 against an independent BigInt reference implementation in the test; `nextInt` rejection sampling; `idiv`, `mulDiv` and `isqrtCeil` against a BigInt oracle; `canonicalJson` rejects floats and non-plain values.
- One table test per violation code (the numbers are right).
- `resolveBattle` table: wall, naval phase, zero defenders, ties go to the defender, bounds.
- Wake policy scenarios.
- One snapshot per `explain` code.
- Briefing fixtures.

**Engine property tests** (`fc` over seeds and over lists of _action intents_ that are resolved against the current state, so most actions are valid and shrinking still works):

- no negative resource; `stock ≤ cap × RES_SCALE`; population used ≤ cap;
- unit conservation per player: home + moving + stationed + lost = recruited;
- cargo conservation;
- all due times > now after `advanceTo`;
- referential integrity (movements, queues, owners);
- `checkInvariants` returns empty;
- `validateAction` never mutates; a rejected `applyAction` never mutates;
- composability: `advanceTo(a); advanceTo(b) ≡ advanceTo(b)`;
- shuffling key insertion order gives the same hash;
- the JSON round trip keeps the hash.

**Gateway:**

- **Fog leakage:** for random states, perturbing data the seat must not see (other players' units, resources, queues and unrelated movements) leaves the canonical JSON of every view and briefing for that seat byte-identical. The same harness runs every engine violation.
- **Wake scheduler model test** (`fc.commands` against a small reference model): one turn at a time; the budget holds except for exempt wakes; the gap between turns is never more than 12 h; after a turn at `t`, the next wake is later than `t`; close events are grouped.
- Briefing ≤ `maxChars`.
- Caps and notes limits with explicit numbers.

**Clocks:**

- lockstep termination and ordering;
- real-time batching sorted by key, lag catch-up, end of match;
- `VirtualTimeSource` determinism;
- the `fc.scheduler` interleaving property (§7.5).

**Determinism:**

- the same seed and bots give byte-identical lockstep logs, compared in **two separate `bun` processes** (catches hidden module state); the header's `wallStart` is ignored;
- two virtual-time real-time runs are identical;
- every log produced in any test passes `verifyReplay`.

**Golden replays:** §8.5.

**Phase-1 exit-criterion test** (`packages/sim/test/exit-criterion.test.ts`): 7 game days, 8 strategy bots (2 of each) plus 1 chaos bot, default rules.

- (a) lockstep;
- (b) real-time with virtual time at ×3;
- (c) real-time with system time at about ×50,000.

Each run must:

- finish with an `end` entry at `t ≤ 604800`;
- have zero exceptions and zero `turn_error`;
- have `checkInvariants` empty at all 168 checkpoints;
- pass `verifyReplay` (every checkpoint and the end).

In addition:

- run (a) twice gives an identical log;
- strategy bots (not chaos) have a gateway reject rate below 5%;
- run (a) shows at least one battle, conquest, alliance and betrayal, so phase 2 has drama to start from.

Performance budgets: (a) under 10 s, (b) under 30 s, (c) about 15 s wall, verify under 5 s. If a budget is missed, report it before changing the design.

---

## 12. Phase-1 task breakdown (parallel agents)

Rules for every task:

- Inside a wave, the files each task owns are disjoint. A file may change owner between waves.
- Each package barrel has exactly one owner per wave: protocol → T10; engine → T20, then T41; gateway → T40; bots → T38; sim → T50.
- **Contracts first.** T20 creates every engine module as a stub with the exact signatures from §3–§6, returning a `NOT_IMPLEMENTED` violation or a no-op. This lets the wave-3 tasks code in parallel and call each other.
- Each task leaves `bun test` green for its own files, and the wave ends with `bun run check` green.
- No git, no dependency installs (except T00), no edits outside the owned files.

| ID  | Wave | Package  | Owns                                                                                                                                                                                                                                                                                                                     | Depends on              |
| --- | ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| T00 | 0    | root     | `package.json`, `bun.lock`, `bunfig.toml`, `tsconfig*.json`, `.oxlintrc.json`, oxfmt config, `.gitignore`, `packages/*/package.json`, `packages/*/tsconfig*.json`, placeholder `packages/*/src/index.ts`, `tests/architecture.test.ts`, `docs/architecture.md` (this spec)                                               | –                       |
| T10 | 1    | protocol | `packages/protocol/src/**` (all files in §1, tests, barrel)                                                                                                                                                                                                                                                              | T00                     |
| T11 | 1    | engine   | `packages/engine/src/lib/**`                                                                                                                                                                                                                                                                                             | T00                     |
| T20 | 2    | engine   | `version.ts`, `emit.ts`, `kernel.ts`, `economy.ts`, `replay.ts`, `rules/derive.ts`, `index.ts`, `testing/**`; **stubs**: `world.ts`, `construction.ts`, `recruitment.ts`, `movement.ts`, `combat.ts`, `conquest.ts`, `espionage.ts`, `diplomacy.ts`, `scoring.ts`, `invariants.ts`, `rules/check.ts`, `rules/default.ts` | T10, T11                |
| T21 | 2    | gateway  | `src/clock/types.ts`, `src/clock/time.ts`, `src/clock/signal.ts`                                                                                                                                                                                                                                                         | T10                     |
| T30 | 3    | engine   | `construction.ts`, `recruitment.ts`                                                                                                                                                                                                                                                                                      | T20                     |
| T31 | 3    | engine   | `movement.ts`, `espionage.ts`                                                                                                                                                                                                                                                                                            | T20                     |
| T32 | 3    | engine   | `combat.ts`, `conquest.ts`                                                                                                                                                                                                                                                                                               | T20                     |
| T33 | 3    | engine   | `diplomacy.ts`, `scoring.ts`                                                                                                                                                                                                                                                                                             | T20                     |
| T34 | 3    | engine   | `world.ts`, `rules/check.ts`, `rules/default.ts`, `docs/game-rules.md`                                                                                                                                                                                                                                                   | T20                     |
| T35 | 3    | gateway  | `explain.ts`, `projection.ts`, `briefing.ts`                                                                                                                                                                                                                                                                             | T20                     |
| T36 | 3    | gateway  | `seat.ts`, `wake.ts`, `caps.ts`, `notes.ts`, `archive.ts`                                                                                                                                                                                                                                                                | T10                     |
| T37 | 3    | gateway  | `clock/lockstep.ts`, `clock/realtime.ts`                                                                                                                                                                                                                                                                                 | T21, T11                |
| T38 | 3    | bots     | `packages/bots/src/**`                                                                                                                                                                                                                                                                                                   | T10                     |
| T40 | 4    | gateway  | `tools.ts`, `turn.ts`, `host.ts`, `index.ts`                                                                                                                                                                                                                                                                             | T30–T37                 |
| T41 | 4    | engine   | all of `packages/engine/src/**` (exclusive): `invariants.ts`, `testing/gen.ts`, property tests, integration fixes                                                                                                                                                                                                        | T30–T34                 |
| T42 | 4    | sim      | `files.ts`, `verify.ts`, `summary.ts`, `diff.ts`                                                                                                                                                                                                                                                                         | T20, T10                |
| T50 | 5    | sim      | `cli.ts`, `run.ts`, `index.ts`, sim run tests                                                                                                                                                                                                                                                                            | T40, T41, T42, T38, T37 |
| T60 | 6    | all      | `packages/sim/test/exit-criterion.test.ts`, `packages/sim/test/golden.test.ts`, `packages/sim/golden/**`; exclusive right to fix any package; `docs/architecture.md` updates                                                                                                                                             | T50                     |

Critical path: T00 → T10 → T20 → (wave 3, 9 tasks) → (T40, T41, T42) → T50 → T60.

**Acceptance criteria:**

**T00 — Scaffold and guardrails**

- Workspaces `packages/*`, with the catalog pinning exact versions: zod 4.x, fast-check 4.x, oxlint, oxfmt, `@types/bun`.
- `overrides` forces typescript 7.0.2; `engines` says bun 1.4.3.
- Root scripts: `typecheck`, `lint`, `format`, `format:check`, `test`, `check`, `sim`.
- `bun run check` is green on the empty packages.
- The engine and protocol pure tsconfigs reject `Bun`, `process` and DOM globals; prove it with a temporary file.
- The oxlint overrides from §1 are active.
- The architecture test catches a planted upward import and a planted `Math.random`.
- `bun build packages/engine/src/index.ts --target=browser` succeeds.
- Package `exports` point to `src/*.ts`, and engine has a `./testing` subpath.

**T10 — Protocol**

- Every schema in §1 has a Zod schema and an inferred type, matching §2.2, §5, §6 and §8.
- Ids use `z.templateLiteral`.
- `TOOL_NAMES` equals the brief's 22 tools plus `search_archives`.
- `z.toJSONSchema` succeeds for every tool input.
- Round-trip tests for every union member.
- `formatGameTime(0) = "D1 00:00"` and `formatGameTime(604800) = "D8 00:00"`.
- `DurationInputSchema` parses `"1h30m"`, `"90m"` and `5400` to 5400.
- No imports beyond zod.

**T11 — Engine lib**

- The FNV-1a 64 vectors in §4 pass.
- sfc32 matches a BigInt reference over 10k outputs for 3 seeds.
- `nextInt` uses rejection sampling.
- `canonicalJson` gives the same output for any key insertion order (property) and throws on floats, NaN, `undefined` in arrays, Map and Date.
- `idiv`, `ceilDiv`, `mulDiv` and `isqrtCeil` match the BigInt oracle (property).
- `compareIds("c2", "c10") < 0`.
- `actionOrderKey` and `seatOrder` are stable.

**T20 — Engine core and contracts**

- `createMatch` builds a state with a stub line world.
- `nextDue` order `(t, rank, seq)` is property-tested.
- `advanceTo` composability is property-tested.
- A checkpoint every 3600 s goes through the hook; `match_end` happens at `durationS`.
- Economy accrual is exact and settlement-path-independent (property); `readyAt` is right.
- `emit` folds `evHash`.
- `validateAction` never mutates; an action on a stub returns `NOT_IMPLEMENTED` without mutating.
- `verifyReplay` reproduces a synthetic log and detects a tampered hash.
- The barrel exports the §3.4 API plus the economy and scoring read helpers, `checkRules`, `DEFAULT_RULES`, the lib, `checkInvariants` and `ENGINE_VERSION`.
- The mini-rules fixture and the state builders are in `testing/`.

**T21 — Clock primitives**

- `VirtualTimeSource`: timers ordered by `(ms, seq)`; abort cancels; `run()` returns the result; a deadlock error is thrown when work is pending with no timers; two identical programs give an identical resolution trace.
- `systemTimeSource` uses `performance.now` and `setTimeout`.
- `Signal` loses no notification.

**T30 — Construction and recruitment**

- Builds and recruits are paid when queued.
- Queues are sequential with only the head timed.
- A cancel cascades to later items of the same building and refunds by permille.
- Requirements, maximum level, queue size and population are checked.
- `build_done`, `recruit_done` and `queue_idle` are emitted.
- Every violation carries its numbers, including `readyAt`.
- Property: random build, recruit and cancel sequences keep resources ≥ 0, resources ≤ cap and population ≤ cap.

**T31 — Movement and espionage**

- Sending checks: unit availability with `lastLeftIn`/`lastLeftAt`, transport capacity, and travel time from `derive` (attacks ≥ `minAttackS`).
- An `incoming` event reaches the target's owner when the movement is sent.
- Recall: in-flight, a same-second recall restores at once, and the recall window applies. Stationed support can be recalled too.
- Arrivals for support, transport and return; spy resolution and reports; a failed spy is detected.
- Property: units are conserved across send, recall and return.

**T32 — Combat and conquest**

- `resolveBattle` is pure and integer-only, with bounded intermediates (`mulDiv`), passing the table tests from §11.
- Attack arrival: defender losses (home units and supports), survivors return with loot up to capacity, and each participant receives a report.
- Conquest when the conquest unit survives a win.
- Found arrival creates a city or bounces back when the slot is taken.
- A player who loses the last city is eliminated through `diplomacy.removePlayer`.

**T33 — Diplomacy and scoring**

- Messages: recipients exist and are alive, the length is within `maxMessageChars`, and the text is not stored in the state.
- Deals propose, answer and expire; alliances form, join and leave with a maximum size; pacts.
- `onHostileAction` emits a public `pact_broken` and applies `attackBreaksPacts`.
- `points`, `standings` and `checkVictory` (permille, by player or by alliance); `finalResult` uses deterministic tie-breaks (points, then cities, then id).

**T34 — World, default rules, rules check, game-rules doc**

- Islands count within [30, 50], scaled by player count; integer coordinates with a minimum gap; slots per island.
- Start positions use seeded maximin spreading, and each start island has a free slot.
- Same seed gives the same world hash; different seeds give different worlds.
- `DEFAULT_RULES` has 3 resources, 6–8 buildings and 5 units, as in the brief.
- `checkRules(DEFAULT_RULES)` is empty, and each crafted bad rules object yields its specific error, including the speed rule.
- `docs/game-rules.md` documents every formula and number, marked as a draft awaiting product sign-off.

**T35 — Gateway views**

- `explain` covers every `ErrorCode` with message and hint, checked by snapshot tests that include numbers and times.
- Every view is built with fresh objects.
- The fog leakage property from §11 passes.
- Briefings are schema-valid, within budget and truncated by the §6.3 rules.

**T36 — Seat logic**

- Wake policy as in §6.7, with a table test per rule and the `fc.commands` model test.
- Caps, notes limits and the archive search (deterministic order) work as specified.

**T37 — Clock drivers**

- Lockstep and real-time follow §7.2 and §7.3, tested against a fake `ClockHost`.
- Lockstep: `nextTime()` is greater than `t` after each step; seeded seat order.
- Real-time: batches sorted by `(key, n)`; `engine.now ≤ min pending` holds; lag catch-up; end-of-match behaviour.
- With virtual time, two runs give identical traces.
- The `fc.scheduler` interleaving property passes.

**T38 — Bots**

- Five strategies, `kit`, `withThinkTime` and `registry`; imports only protocol.
- Determinism: the same inputs give the same calls.
- Each strategy emits its expected tool set on fixture briefings and views.
- `chaos` covers every tool with valid and invalid arguments.
- No `Math.random` and no `Date`.

**T40 — Gateway shell**

- `createMatchHost` implements `ClockHost` and `MatchHost`.
- All tools are wired exactly as in §6.4.
- `runTurn` follows §6.8.
- Event routing (archive, inbox, wake, news) and log writing follow §6.1 and §8.2.
- A scripted controller plays 1 game day under both clocks with every tool used at least once; the produced log passes `verifyReplay`.
- Gateway rejects never reach the engine.
- `toolJsonSchemas()` is exported.

**T41 — Engine integration**

- `checkInvariants` is complete.
- `testing/gen.ts` provides the intent generator.
- All engine properties from §11 pass for 200 seeds × 2,000 steps.
- Cross-module mismatches left over from wave 3 are fixed.
- No engine stub remains.

**T42 — Sim I/O**

- A synchronous JSONL `LogSink` with flush at checkpoints; a snapshot writer; a streaming log reader with Zod validation.
- `verifyRun(dir)` with a snapshot diff at the first mismatch.
- `summarize(entries)` produces every §10 metric, tested on synthetic logs.

**T50 — Sim run and CLI**

- `runMatch(options)` wires the host, drivers, bots and time sources.
- Every §10 command and its exit codes work.
- 1-day runs under all three clock and time modes pass `verify`.
- The two-process determinism test passes.
- `golden --update` refuses to run when `ENGINE_VERSION` has not changed.

**T60 — Exit criterion and hardening**

- The §11 exit-criterion test passes.
- The goldens are committed and verified in `bun test`.
- The performance budgets are met, or the gap is reported.
- Bot tuning gives the drama minimum (at least one battle, conquest, alliance and betrayal).
- `docs/architecture.md` is updated with every deviation from this spec.

---

## 13. Open questions and risks

**Questions** (the default assumed in this spec is in parentheses):

1. **Rules numbers.** `docs/game-rules.md` does not exist yet; T34 drafts it. Who signs off the balance? (Bots only need it to be playable.)
2. **Archive search tool.** The brief requires searchable archives but names no tool, and principle 5 mentions `battle_history`. (`search_archives`, which also covers battle history.)
3. **"Queue finishes".** (Wake when a queue becomes **idle**, not on every item, which saves wake-ups.)
4. **Alliances.** Multi-member? Shared victory? Does attacking an ally automatically break the alliance? (Multi-member up to `maxAllianceSize`; victory per player; attacking is allowed, and emits a public `pact_broken` and ends the pact or alliance when `attackBreaksPacts` is set.)
5. **Incoming attacks.** (Visible when sent, showing origin, sender and arrival; units hidden.)
6. **Same-island attacks** are subject to the 1-game-hour minimum (`minAttackS`) because of the speed rule.
7. **Wake budget default** (6 per day) comes from the cost model, not from gameplay. Retune from the phase-1 summaries.
8. **Messages.** (Private, delivered instantly, 1 to 5 recipients.)

**Risks and mitigations:**

- **Hidden nondeterminism** (key order, sorting, module state, floats). Mitigated by the iteration rules, lint, the architecture test, `canonicalJson` throwing on floats, the shuffle property and the two-process test.
- **Integer overflow.** Mitigated by `mulDiv` and `assertSafeInt` in hot formulas, and by the bounds in `checkRules`.
- **Integration drift between stubbed modules.** Mitigated by the exact signatures in this spec, the stubs from T20, and the T41 integration wave.
- **Real-time lag at extreme speeds.** Wake-ups start late; this is reported in the summary and is fine at ×3.
- **Fake time breaking on hidden real I/O.** If a turn ever awaits real I/O, `VirtualTimeSource` stops being deterministic. Mitigated by the synchronous `LogSink`, by bots doing no I/O, and by the deadlock error.
- **Fairness in lockstep.** A later seat in the same second sees earlier seats' actions. Mitigated by the per-second seeded rotation.
- **Boring bot matches** (no fights). T60 tunes bots and rules until the drama minimum is met.
