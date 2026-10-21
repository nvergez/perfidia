# Perfidia phase-1 architecture

> **Status.** Final architecture for phase 1 of `docs/brief.md`: "Engine only. Rules, event queue, both clocks, combat, tested with scripted bots and no AI. Criterion: a 7-game-day match runs without errors in both clocks and replays identically."
>
> - It merges the two candidates kept in `docs/architecture-candidates/` (Verifiable Event Core, Plain-State Kernel) and adds the multi-ruleset requirement. The candidates are superseded; read them only for history.
> - The active ruleset is `perfidia-1@1.1.0` (the bare id `perfidia-1` resolves to it), specified in `docs/rulesets/perfidia-1.md`. `perfidia-1@1.0.0` stays published and replayable, frozen in `docs/rulesets/perfidia-1-v1.0.0.md` (§17.5). On a game rule, the ruleset document wins. On engineering (module layout, hashing, logs, materialisation), this document wins, and the ruleset header points here.
> - Section 15 is the implementation task breakdown. Each task names the sections it must follow. Section 16 records the decisions of both review rounds (design review, then completeness review), including the issues that were not applied as proposed and why.

**Contents:**

- 1 Decisions at a glance
- 2 Packages, modules and purity
- 3 Engine core and rulesets
- 4 State model
- 5 Event queue and kernel
- 6 Determinism
- 7 Action pipeline and errors
- 8 Gateway
- 9 Clocks
- 10 Match log, snapshots and replay
- 11 Bots
- 12 `sim` CLI
- 13 Testing strategy
- 14 Risks and open questions
- 15 Task breakdown
- 16 Review decisions
- 17 Deviations
- 18 Phase 2: first agents (the orchestrator; details in `docs/phase2.md`)
- 19 Phase 3: the spectator view (Pass A: the spectator projection and the read-only server; details in `docs/phase3.md`)

---

## 1. Decisions at a glance

| Topic               | Decision                                                                                                                                                                                                                                                                    | Source                | Rejected alternative and why                                                                                                                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State               | One plain JSON object of normalized records keyed by short ids. Derived values (rates, caps, pop, points) are never stored.                                                                                                                                                 | both                  | –                                                                                                                                                                                                                                         |
| Mutation            | Handlers edit an owned draft in place. Reads and validation never mutate (property-tested). Everything that leaves the engine is a copy (§6.6).                                                                                                                             | Plain-State Kernel    | VEC's `Store.mut()` with an incremental multiset hash: extra discipline for per-call hashes that hourly verification does not need.                                                                                                       |
| Scheduled events    | An explicit queue stored **in the state** as an array sorted by `(at, cls, seq)`, with real removal on cancel.                                                                                                                                                              | VEC semantics         | PSK's implicit scan over entity timestamps (every ruleset-specific timer would need its own scan hook); a heap index (a few hundred items: a sorted array is enough).                                                                     |
| Same-second order   | Events by `(time, class, seq)`, classes supplied by the ruleset. Actions after the events of their second. Lockstep: batch `b` at second `t` shuffled on stream `lockstep:<t>:<b>`. Real time: receipt order (a recorded deviation from the brief, §16.2). Both are logged. | `perfidia-1` §1.4     | PSK's per-second real-time batching (delays every result; the ruleset says receipt order). VEC's serial lockstep turns (the ruleset says batches).                                                                                        |
| PRNG                | mulberry32 with named streams seeded by FNV-1a-32 of `${seed}:${stream}`.                                                                                                                                                                                                   | `perfidia-1` §1.3     | xoshiro128\*\* (VEC), sfc32 (PSK): the ruleset fixes mulberry32.                                                                                                                                                                          |
| Ids                 | Public kinds (players, islands, cities, alliances) are counters. Private kinds (movements, reports, proposals, messages) are opaque: a permutation of (owner, the owner's own counter) keyed by a per-match secret `idKey`, not by the seed.                                | review                | Global counters for every kind: the gaps between ids an agent sees would count other players' hidden messages, spies and launches. A seed-keyed permutation: the seed can be recovered from public data.                                  |
| Hashes              | FNV-1a 64 over canonical JSON for state (hourly checkpoints) and a running event hash `evHash` kept in the state. SHA-256 for the effective config hash and the compiled rules hash.                                                                                        | PSK; `perfidia-1` §16 | Per-call incremental hashes (VEC): kept only as an opt-in debug mode (`traceHashes`), computed with a full hash.                                                                                                                          |
| Messages, reports   | Emitted as events and folded into `evHash`, never stored in engine state. Archives and the public feed live in the gateway.                                                                                                                                                 | PSK                   | Storing archives in the state (VEC): the state grows to megabytes and every hourly hash pays for it.                                                                                                                                      |
| Gateway state       | Notes, archives, the public feed, wake bookkeeping and caps live in gateway state. It is not hashed. `rebuildGatewayState` rebuilds it from the log (§10.5), and a test checks that the rebuild equals the live state.                                                      | PSK                   | A second hashed gateway state (VEC): replay of the engine is the criterion; full re-simulation already compares gateway behaviour byte for byte. Gateway snapshots: a resume would still need the fold over the lines after the snapshot. |
| Engine version      | Recorded in the log header and snapshot envelope, **not** in the hashed state.                                                                                                                                                                                              | PSK                   | Hashing it would break every golden replay on a behaviour-free refactor.                                                                                                                                                                  |
| Agent contract      | Round-based `SeatAgent.round(input)`: the host drives the turn loop, so caps are enforced in one place and lockstep can batch rounds of all woken seats.                                                                                                                    | PSK                   | VEC's `takeTurn(ctx)` with an awaited `roundTrip`: harder to batch across seats.                                                                                                                                                          |
| Wake budgets        | Two daily budgets per seat: **own** (self-wakes, queues, own reports) and **social** (triggers caused by other players). Urgent wakes are exempt but spaced by a short gap.                                                                                                 | review                | One shared budget: another player could drain it with messages and stall a seat's economy.                                                                                                                                                |
| Clocks              | Drivers live in the gateway and receive an injected `TimeSource`. `VirtualTime` runs real-time matches fast and deterministically.                                                                                                                                          | both                  | –                                                                                                                                                                                                                                         |
| Verification        | Level E: engine replay of logged actions, for every log. Level G: full re-simulation with deterministic agents, compared byte for byte.                                                                                                                                     | VEC                   | –                                                                                                                                                                                                                                         |
| Rulesets            | Versioned descriptors (`id@version`) with a Zod config schema, defaults, a `compile` step and a small set of hooks. Everything else is data in `CompiledRules`.                                                                                                             | new                   | Hard-coding perfidia-1 in the engine: old matches could not be re-simulated after a rules change.                                                                                                                                         |
| Where rulesets live | Inside `@perfidia/engine` (`src/rulesets/<id>/`), with lint enforcing that the core never imports them.                                                                                                                                                                     | new                   | A sixth package: stronger isolation, but it needs root and lockfile changes and changes the documented dependency chain. Revisit if the boundary leaks.                                                                                   |
| Freeze guard        | Per published ref: committed golden logs verified at Level E forever, and a fingerprint of every agent-visible artefact. Both are append-only.                                                                                                                              | review                | Final hashes of fresh bot runs: they break on every bot change and can be regenerated by bumping `ENGINE_VERSION`, which hides core drift.                                                                                                |
| Archive search      | Folded into `read_notes` (optional `search` with a `scope` over the seat's archive and the public feed, and `open`), so the tool list stays exactly the brief's 22.                                                                                                         | VEC                   | A 23rd `search_archives` tool (PSK). Revisit in phase 2.                                                                                                                                                                                  |

---

## 2. Packages, modules and purity

### 2.1 Dependency direction

`protocol` ← `engine` ← `gateway` ← `bots` ← `sim`, unchanged. Each `package.json` declares only its allowed upstream packages, and the isolated linker makes any other `@perfidia/*` import fail to resolve.

- `bots` depends on `gateway` and `protocol` in `package.json` (the dependency stays, so `bun.lock` does not change), but uses only `protocol` at runtime: bots reach the game exclusively through the `SeatAgent` contract that the gateway drives. Lint forbids runtime imports of `@perfidia/gateway` and `@perfidia/engine` in bot sources (§2.4).
- `engine` has no dependency on `zod`. `protocol` re-exports `z` and the type `ZodType` so rulesets can declare schemas (`import { z } from "@perfidia/protocol"`).

### 2.2 Layout and public module paths

```
packages/
  protocol/src/            Zod schemas + inferred types + type-only contracts (one barrel)
    json.ts ids.ts resources.ts state.ts actions.ts events.ts violations.ts rules.ts
    match.ts log.ts tools.ts views.ts briefing.ts agent.ts index.ts
  engine/src/
    core/        pure infrastructure, no game knowledge      -> @perfidia/engine/core
                 int.ts prng.ts hash.ts canonical.ts opaque.ts format.ts sorted.ts index.ts
    contracts/   types only: Ruleset, hooks, Ctx, handlers    -> @perfidia/engine/contracts
                 ruleset.ts ctx.ts index.ts
    kernel/      match lifecycle, dispatch, hashing, replay   -> @perfidia/engine/kernel
                 config.ts checks.ts world.ts queue.ts ctx.ts match.ts invariants.ts snapshot.ts
                 replay.ts version.ts index.ts
    testing/     fixture ruleset + state builders for tests   -> @perfidia/engine/testing
    std/         shared game model: derivations, primitives   -> @perfidia/engine/std
                 derive.ts stock.ts units.ts losses.ts queues.ts movement.ts cities.ts
                 diplomacy.ts visibility.ts audience.ts invariants.ts index.ts
    domain/      default handlers for actions and events      -> @perfidia/engine/domain
                 economy.ts military.ts recall.ts diplomacy.ts arrivals.ts timers.ts index.ts
    rulesets/
      index.ts   registry                                    -> @perfidia/engine/rulesets
      perfidia-1/  descriptor, config, compile, map, combat… -> @perfidia/engine/rulesets/perfidia-1
      sandbox-1/   test-only second ruleset                  -> @perfidia/engine/rulesets/sandbox-1
    index.ts     top barrel: bound createMatch/loadMatch/verifyLog, registry, version
  gateway/src/
    seat/        seat state, wake scheduler, caps, notes, archive, public feed -> @perfidia/gateway/seat
    clock/       TimeSource impls, ClockHost, lockstep and real-time drivers   -> @perfidia/gateway/clock
    present/     fog-of-war views, briefing, explain, rules payload            -> @perfidia/gateway/present
    runtime/     tools, turn handles, MatchHost, runMatch, sinks, rebuild      -> @perfidia/gateway/runtime
    index.ts     top barrel
  bots/src/      strategies, kit, think-time wrapper, hints, registry (one barrel)
  sim/src/       cli.ts, harness/, io/, run/, verify/, batch/, summary/, hardening/ (tests),
                 exit/ (tests), architecture.test.ts, integration.test.ts, golden.test.ts, index.ts
  sim/fixtures/  golden logs and ruleset fingerprints (append-only)
```

The `exports` maps of `engine` and `gateway` list every group above (`"./core": "./src/core/index.ts"`, …, `"./rulesets/*": "./src/rulesets/*/index.ts"`). Group barrels let a later wave import a finished group before the top barrel is rewritten, and they keep file ownership disjoint (§15). Tests live under `src/` so that each package's tsconfig type-checks them.

**Placeholders.** Each package barrel holds a placeholder `*_PACKAGE` constant (imported by the downstream placeholder) and a `*_UPSTREAM` constant with a placeholder test. The task that first rewrites a barrel deletes that package's `*_UPSTREAM` constant and placeholder test but keeps `*_PACKAGE`. The one exception is `BOTS_UPSTREAM`: it is a runtime import of `gateway`, which the bots lint of §2.4 forbids, so T01 deletes it together with the bots placeholder test. The last task removes the `*_PACKAGE` constants once nothing imports them (§15.1).

### 2.3 Layer rules inside the engine

| Layer                                       | May import                                       | Must never import                     |
| ------------------------------------------- | ------------------------------------------------ | ------------------------------------- |
| `core`                                      | nothing (no protocol either)                     | everything else                       |
| `contracts`                                 | `@perfidia/protocol`                             | `kernel`, `std`, `domain`, `rulesets` |
| `kernel`                                    | `protocol`, `core`, `contracts`                  | `std`, `domain`, `rulesets`           |
| `std`                                       | `protocol`, `core`, `contracts`                  | `kernel`, `domain`, `rulesets`        |
| `domain`                                    | `protocol`, `core`, `contracts`, `std`           | `kernel`, `rulesets`                  |
| `rulesets/<id>`                             | `protocol`, `core`, `contracts`, `std`, `domain` | `kernel`, other rulesets              |
| `rulesets/index.ts`, `testing/`, `index.ts` | anything in the engine                           | –                                     |

The kernel receives the domain module and the ruleset as arguments (`createMatch(setup, ruleset, domain)`); the top barrel binds them. The engine core in the product sense is `core + contracts + kernel + std + domain`: all of it is ruleset-agnostic. A test in the last hardening task scans these sources (and `gateway/src`, `bots/src` except `hints.ts`) for string literals naming a `perfidia-1` building, unit or queue id, or a ruleset id, and fails on any (§13.4).

**Enforcement.** The whole matrix is enforced by `packages/sim/src/architecture.test.ts` (T01, default suite): for every non-test source of a layer above, it reads every import and re-export specifier (type-only ones included), resolves package paths (`@perfidia/engine/<group>`) and relative paths to a group, and fails on any edge the table forbids. Inside the engine, nothing imports the top barrel `@perfidia/engine`, and a ruleset imports neither the registry (`rulesets/index.ts`) nor another ruleset's directory. Lint adds fast feedback for the most important edge only: nothing in `core`, `contracts`, `kernel`, `std` or `domain` imports `**/rulesets/**` (§2.4). Tests are exempt from the matrix: a `domain` or ruleset test may use the testing kit and the kernel.

### 2.4 Purity enforcement, and closing the tooling gap

Pure packages (`protocol`, `engine`, `gateway`) must run unchanged in a browser. Bots must be pure functions of their inputs (Level G, `VirtualTime`, P17), so the same bans apply to them.

- **Types (existing).** `tsconfig.lib.json` uses `lib: ES2024`, `types: []` and excludes tests; tests get Bun types through `tsconfig.test.json`. **Bots get the same split** (T01): today `packages/bots/tsconfig.json` gives the sources `types: ["bun"]`, so the type-check accepts every Bun and Node API there.
- **Lint (existing).** `no-restricted-imports` bans `bun`, `bun:*`, `node:*`, `elysia`, `@elysiajs/*` in pure sources (tests may import `bun:test` only), plus `Date` and `Math.random`.
- **The gap.** `/// <reference types="bun" />` in an engine file, or `import { env } from "bun"`, passes the type-check because the pure packages list `@types/bun` as a dev dependency for their tests. Lint catches some of these only incidentally, and `import fs from "fs"` (no `node:` prefix) is not caught at all. In bots, `fs`, `node:*`, `Bun.file`, `process.env`, `crypto.randomUUID()`, `setImmediate`, `queueMicrotask`, `fetch` and a runtime import of `@perfidia/gateway` all pass today.
- **Override semantics (verified with oxlint 1.87).** A later override **replaces** an earlier override's options for the same rule. Every override that sets `no-restricted-imports` must therefore repeat the full ban list (`bun`, `bun:*`, `node:*`, `elysia`, `@elysiajs/*`) next to its own patterns. The pattern `**/rulesets/**` does match relative specifiers such as `../rulesets/x/index.ts`.
- **Verified with oxlint 1.87 in a scratch probe** (completeness review): `no-restricted-imports` patterns accept `allowTypeImports: true` (a type-only import passes, a value import fails); `no-restricted-properties` catches `Math.tan(1)`, `Math["tan"](1)` and `const { tan } = Math`, and a `property`-only entry (`toLocaleUpperCase`) applies to any object; it does **not** catch `const m = Math; m.tan(1)`, `Reflect.get(Math, "tan")` or `globalThis.Math.tan(1)`; `no-restricted-globals` catches `globalThis`, `WeakRef`, `FinalizationRegistry`, `crypto` and `fetch`; there is **no** `no-restricted-syntax` rule, so nothing in oxlint can ban the `**` operator; `typescript/require-array-sort-compare` exists.
- **The fix (task T01).** For `packages/engine/**` and `packages/protocol/**` (sources and tests), for `packages/gateway/src/**` sources (not tests, which need `setTimeout` to drive virtual time), and for `packages/bots/src/**` sources (bots tests: the import bans only):
  - `typescript/triple-slash-reference` with `{ "types": "never" }`;
  - the `import` plugin, enabled per override with `plugins: ["import"]` (not globally), and `import/no-nodejs-modules`;
  - `no-restricted-imports` for `bun`, `bun:*` (except `bun:test` in tests), `node:*`, `elysia`, `@elysiajs/*`; in bots sources also `@perfidia/gateway`, `@perfidia/gateway/*`, `@perfidia/engine` and `@perfidia/engine/*` with `allowTypeImports: true`;
  - `no-restricted-globals` for `Bun`, `process`, `require`, `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask`, `Date`, `performance`, `Intl`, `parseFloat`, `crypto`, `fetch`, `WeakRef`, `FinalizationRegistry` and `globalThis` (which closes `globalThis.Math` and `globalThis.Date`);
  - `no-restricted-properties` for `Math.random` and every implementation-approximated `Math` member: `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`, `sinh`, `cosh`, `tanh`, `asinh`, `acosh`, `atanh`, `exp`, `expm1`, `log`, `log1p`, `log2`, `log10`, `cbrt`, `hypot`, `pow`; and, on any object, `localeCompare`, `toLocaleString`, `toLocaleUpperCase`, `toLocaleLowerCase`, `toFixed`, `toPrecision` and `toExponential` (§6.5). `Math.sqrt` stays allowed: `isqrt` corrects it;
  - `typescript/require-array-sort-compare`.
- **Source scan** (`packages/sim/src/architecture.test.ts`, T01, mandatory). Lint cannot see aliasing or syntax, so the test reads every non-test source of `protocol`, `engine`, `gateway` and `bots`, drops comments (for example with `new Bun.Transpiler({ loader: "ts" }).transformSync`, which keeps `**`), and fails on: the `**` and `**=` operators (use a literal or `core`'s `ipow`); any reference to `Math` other than `Math.<member>` with a member from the allowlist `abs`, `ceil`, `floor`, `trunc`, `sign`, `min`, `max`, `round`, `imul`, `clz32`, `sqrt`; and every forbidden layer edge of §2.3.
- **Engine layers in lint.** A `no-restricted-imports` override for `core`, `contracts`, `kernel`, `std` and `domain` sources bans `**/rulesets/**` and `@perfidia/engine/rulesets*`, repeating the ban list. The full matrix is the source scan's job (§2.3), so lint carries no further copies of the ban list.
- **The `import` plugin's categories.** With the plugin on, its `correctness`, `suspicious` and `perf` rules apply to the files of those overrides. `import/no-named-as-default-member` flags `fc.assert`/`fc.property` on fast-check's default import; T01 decides explicitly (disable it for tests, or switch tests to named imports) and says which.
- **Fixtures.** `packages/sim/fixtures/**` is in `.oxfmtrc.json` `ignorePatterns`, so regenerated fixture JSON never turns `format:check` red.

---

## 3. Engine core and rulesets

### 3.1 What is core and what is a ruleset

All four ruleset designs (`perfidia-1` and the three candidates) share one game model: islands with city slots, cities with 3 resources and leveled buildings, unit stacks, a build queue and recruit queues, six movement kinds (attack, support, found, spy, shipment, return), proposals, relations between players (alliances, pacts), and a score. That model is implemented once, data-driven:

- `std` and `domain` read only `CompiledRules` (§3.3), never a ruleset's raw config or id.
- A ruleset supplies its config (Zod schema plus defaults), a `compile` step that turns the config into `CompiledRules` tables, and **hooks** at the points where the designs genuinely differ (§3.4).
- Ruleset-specific state (sieges, the Crown's bonus, battle points, domination countdowns, renown) lives in `state.ext`, validated by the ruleset's `extSchema`.
- **Time-gated conditions.** A condition that can become true merely because time passes ("from day 4, a bloc holding 40% wins") is driven by a scheduled event: the ruleset schedules a world timer in `createWorld`, its `on` handler sets a flag in `ext` and evaluates, and `afterStep` reads the flag. `afterStep` never compares `now` with a threshold, because the first step after a threshold depends on when agents happen to act. A handler may compare `now` with a threshold for the step it resolves (an arrival before t = 172800 meets an immune capital).

### 3.2 The ruleset interface (`engine/src/contracts/ruleset.ts`)

Hooks are declared with method syntax so that a `Ruleset<PerfidiaConfig, PerfidiaExt>` is assignable to `AnyRuleset = Ruleset<unknown, unknown>` in the registry.

```ts
import type { ZodType } from "@perfidia/protocol";

export type RulesetRef = `${string}@${number}.${number}.${number}`; // from protocol

export interface Ruleset<C = unknown, X = unknown> {
  readonly id: string; // "perfidia-1"; /^[a-z][a-z0-9-]*$/
  readonly version: string; // "1.0.0"
  readonly ref: RulesetRef; // "perfidia-1@1.0.0"
  readonly status: "published" | "test"; // "test" rulesets are refused by `sim run` without --allow-test
  readonly title: string;
  readonly configSchema: ZodType<C>; // strict objects; integers; cross-field checks in superRefine
  readonly defaults: DeepReadonly<C>; // must parse with configSchema (tested)
  readonly extSchema: ZodType<X>; // shape of state.ext
  players(config: DeepReadonly<C>): { min: number; max: number }; // allowed N
  compile(config: DeepReadonly<C>, players: number): CompiledRules; // pure
  check?(config: DeepReadonly<C>, rules: DeepReadonly<CompiledRules>): ConfigIssue[]; // ruleset-specific config checks (§3.6)
  cheatSheet(config: DeepReadonly<C>, rules: DeepReadonly<CompiledRules>): string; // rendered, never a fixed string
  readonly hooks: RulesetHooks<C, X>;
  readonly errors: Readonly<Record<string, Explainer>>; // wording of ruleset violation and warning codes
  readonly errorSamples: readonly Violation[]; // at least one per `errors` code: explain tests and the fingerprint (§13.6)
  readonly tools?: readonly ExtraTool[]; // optional extra agent tools (§3.7)
  readonly eventSchemas: Readonly<Record<string, ZodType>>; // every non-standard event type it emits ({} if none)
  readonly intelEvents?: readonly string[]; // keys of eventSchemas whose payload depends on hidden data by design (§8.6)
}
export interface ConfigIssue {
  path: string; // dotted config path, e.g. "time.siegeDuration"
  message: string;
}

export interface RulesetHooks<C, X> {
  // Map generation and starting state (pure). Ids follow the ruleset's own spec.
  createWorld(w: WorldCtx<C>): WorldSetup<X>;
  // Map geometry. Must return >= rules.time.minTravel for every pair of islands, the same island
  // included (speed rule); checked at creation for every travel probe (§3.6).
  travelTime(r: ReadCtx<C, X>, from: IslandId, to: IslandId, group: TravelGroup): number;
  // Launch rules beyond the generic checks: target validity, recorded party (foe), carriers.
  departure?(r: ReadCtx<C, X>, d: DepartureDraft): DepartureVerdict; // default: std.defaultDeparture
  // Arrival resolution. attack and spy are mandatory; the others default to domain handlers.
  readonly arrive: {
    attack(ctx: Ctx<C, X>, m: MovementId): void;
    spy(ctx: Ctx<C, X>, m: MovementId): void;
    support?(ctx: Ctx<C, X>, m: MovementId): void;
    shipment?(ctx: Ctx<C, X>, m: MovementId): void;
    found?(ctx: Ctx<C, X>, m: MovementId): void;
    return?(ctx: Ctx<C, X>, m: MovementId): void;
  };
  // Handlers for the ruleset's own scheduled event kinds (siege_end, domination_open, …).
  readonly on?: Readonly<Record<string, (ctx: Ctx<C, X>, ev: ScheduledEvent) => void>>;
  // Cross-cutting pre-check run before every action's own validation (e.g. "origin is besieged").
  guard?(r: ReadCtx<C, X>, seat: PlayerId, a: Action): Violation | null;
  // Runs after every event and every accepted action, with the events it emitted:
  // victory and elimination checks, relation bookkeeping, siege abandonment, ….
  // Never compares `now` with a threshold (§3.1).
  afterStep?(ctx: Ctx<C, X>, step: StepInfo): void;
  // Relations of a player. Default std.defaultRelations: alliance members ("ally") and pacts.
  relations?(r: ReadCtx<C, X>, p: PlayerId): readonly Relation[];
  // Score and ranking (leaderboard, final result).
  standings(r: ReadCtx<C, X>): Standing[];
  // Called by the kernel's match_end event at rules.time.matchEnd.
  finish(ctx: Ctx<C, X>): MatchResult;
  // Fog-of-war details; defaults in std/visibility.ts.
  readonly visibility?: Partial<Visibility<C, X>>;
  // Escape hatch: replace a domain action handler, or handle "ext" actions of extra tools.
  readonly actions?: Partial<Record<Action["type"], ActionHandler>>;
  readonly invariants?: readonly Invariant[]; // also cover the ruleset's own event kinds (§13.3)
}

export interface Relation {
  readonly player: PlayerId;
  readonly kind: "ally" | "pact";
  readonly until: GameTime | null; // pact expiry; null = no expiry
}

export interface WorldCtx<C> {
  readonly seed: number; // uint32 match seed
  readonly players: readonly PlayerId[]; // p1..pN
  readonly config: DeepReadonly<C>;
  readonly rules: DeepReadonly<CompiledRules>;
  rng(stream: string): Rng; // mulberry32 on stream `${seed}:${stream}`; each name once (§5.2)
}
export interface WorldSetup<X> {
  readonly islands: readonly Island[]; // complete records, ids i1.. in the ruleset's order
  readonly cities: readonly City[]; // capitals, neutral cities (e.g. the Crown); queues empty
  readonly ext: X;
  readonly timers: readonly { kind: string; at: GameTime; ref: string }[]; // at >= 1 (§3.6)
}

export interface TravelGroup {
  readonly kind: MovementKind; // "spy" and "shipment" carry no units
  readonly units: UnitCounts;
}
export interface DepartureDraft {
  readonly kind: "attack" | "support" | "found" | "spy" | "shipment";
  readonly owner: PlayerId;
  readonly from: CityId;
  readonly to: CityId | null; // null for found
  readonly island: IslandId; // target island
  readonly slot: number | null; // found only, when toolOptions.foundSlot allows it
  readonly units: UnitCounts;
  readonly cargo: Res;
  readonly gold: number;
}
export type DepartureVerdict =
  | { ok: true; party: PlayerId | null; units?: UnitCounts; warnings?: Violation[] } // party: recorded foe/party, null = neutral
  | { ok: false; violation: Violation };

export interface Visibility<C, X> {
  cityAccess(r: ReadCtx<C, X>, viewer: PlayerId, city: CityId): "full" | "public";
  movementAccess(
    r: ReadCtx<C, X>,
    viewer: PlayerId,
    m: MovementId,
  ): "own" | "full" | "incoming" | null;
  publicCity(r: ReadCtx<C, X>, viewer: PlayerId, city: CityId): JsonObject; // extra fields (siege flag, Crown); may depend on the viewer
  publicPlayer(r: ReadCtx<C, X>, p: PlayerId): JsonObject; // public extras only (never raw battle points)
  publicMatch(r: ReadCtx<C, X>): JsonObject; // e.g. tie-break order, countdowns
  // Seat-scoped ruleset state for the briefing (§8.2), e.g. the sieges the seat holds and the
  // countdowns it is part of. Optional; default: publicMatch(r). Counts in the briefing budget.
  briefing?(r: ReadCtx<C, X>, viewer: PlayerId): JsonObject;
}

export interface StepInfo {
  readonly cause:
    | { kind: "event"; ev: ScheduledEvent }
    | { kind: "action"; seat: PlayerId; action: Action }
    | { kind: "test" }; // only through the testing kit (§5.3)
  readonly events: readonly DomainEvent[]; // emitted during this step, in order
}

export interface Invariant {
  readonly name: string;
  readonly level: "step" | "checkpoint"; // step invariants also run at checkpoints
  check(r: ReadCtx): readonly string[]; // human-readable violations; empty when fine
}

export type Explainer = (v: Violation, f: Fmt) => { message: string; hint: string };
export type AnyRuleset = Ruleset<unknown, unknown>;

// Structural types shared with core (core cannot import contracts, contracts are written in parallel):
export interface Rng {
  nextU32(): number; // mulberry32 output, uint32
}
export interface Fmt {
  time(t: GameTime): string; // "D2 14:05", "D2 14:05:30"
  duration(s: number): string; // "1h20m", "45s", "4d 9h58m"
}
```

### 3.3 `CompiledRules`: the data contract between rulesets and the core

`CompiledRules` is a Zod schema in `protocol/src/rules.ts`. The `rules` tool returns the agent-relevant part of it, together with the interface rules, the cheat sheet and the effective config (§8.1), so bots and LLMs read the same tables the engine uses. Code receives it as `DeepReadonly<CompiledRules>`; with `invariants: "step"` the kernel deep-freezes it.

```ts
export interface CompiledRules {
  ruleset: RulesetRef;
  players: number; // N for this match
  time: { matchEnd: number; attackFrom: number; minTravel: number }; // the game day is always 86400 (core DAY)
  resourceScale: number; // stock is stored × scale (3600: a rate of r/h adds r per second)
  buildings: BuildingTable[]; // canonical order
  units: UnitTable[]; // canonical order
  roles: {
    producers: Record<ResourceId, BuildingId>; // perfidia-1: lumber, quarry, mine
    storage: BuildingId; // warehouse: cap table index
    population: BuildingId; // hall: pop cap table index
    buildSpeed: BuildingId | null; // hall: second index of build times; null = no speed-up
    wall: BuildingId | null; // null when the ruleset has no wall
    settler: UnitId; // the unit that founds cities; its cost scales with k
  };
  levels: { production: number[]; storage: number[]; population: number[] }; // [level 0..max]
  queues: {
    build: { max: number; requiresOn: "projected" | "completed" };
    recruit: { id: QueueId; building: BuildingId; maxBatches: number; maxCount: number }[];
    delivery: "trickle" | "batch"; // units one by one (perfidia-1) or all at batch end
    refund: {
      build: { queuedPm: number; active: "prorata" | { pm: number } };
      // "uncompleted": the active batch keeps its completed units and refunds the others at queuedPm
      recruit: { queuedPm: number; active: "uncompleted" | { pm: number } };
    };
  };
  settlerCost: Res[]; // index k = cities + settlers owned; clamped to the last entry
  newCity: CitySeed; // buildings, stock, units of a founded city (escort is added)
  neutralProduction: boolean; // false: neutral cities (the Crown) do not produce
  movement: {
    recall: {
      window: number;
      kinds: ("attack" | "support" | "found")[];
      stationed: "partial" | "whole" | "none";
      dismiss: boolean;
    };
    shipment: { base: number; perLevel: number; building: BuildingId } | null; // in-flight cargo cap
    transportRule: boolean; // land units crossing water need carrier capacity
    spyMinGold: number;
  };
  diplomacy: {
    allianceMax: number; // perfidia-1: max(2, floor(N/3)), computed by compile
    maxPacts: number;
    pactDuration: number | null; // null = pacts never expire (unless `until` is used)
    maxOpenProposals: number;
    proposalTtl: number;
    messageMaxChars: number;
    proposalTextMaxChars: number;
    allianceNameMaxChars: number;
  };
  toolOptions: { foundSlot: boolean; pactUntil: boolean }; // optional tool arguments this ruleset accepts (§3.7)
  gateway: GatewayRules; // §8.4
  travelProbes: { label: string; group: TravelGroup }[]; // view_map columns, e.g. transport / warship / spy
  eventClasses: Record<string, number>; // every scheduled event kind -> class (§5.1)
}
export interface BuildingTable {
  id: BuildingId;
  maxLevel: number;
  cost: Res[]; // [target level]; index 0 unused
  time: number[][]; // [target level][buildSpeed level at enqueue]; every entry >= 1
  requires: Partial<Record<BuildingId, number>>; // checked on levels per queues.build.requiresOn
}
export interface UnitTable {
  id: UnitId;
  domain: "land" | "naval";
  attack: number;
  defense: number;
  naval: number;
  carry: number;
  capacity: number; // > 0: a carrier (transport)
  pop: number;
  cost: Res; // the settler's real cost comes from settlerCost[k]
  queue: QueueId;
  requires: Partial<Record<BuildingId, number>>; // checked on completed levels
  time: number[]; // [level of the queue's building at enqueue]; every entry >= 1
  maxPerOrder: number;
}
```

`rulesHash = sha256Hex(canonicalJson(rules))` identifies the compiled tables of a match. It is stored in the log header and in snapshots (§10).

### 3.4 Hook points, derived from the candidates

Each row is a place where at least one candidate differs from `perfidia-1`. Rows marked _data_ are absorbed by `compile` and need no code; rows marked with a hook name need code in the ruleset.

| Variation                                     | perfidia-1                                                                                  | archipelago-classic                             | lean-ring                                       | ring-crown                                                                                     | Mechanism                                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Map layout, island kinds, ids, seat placement | polar ring, 0.1° sine table, Crown, hubs for N ≤ 7                                          | polar ring, 1° cosine table                     | ring of copied sectors, wrapping x              | polar ring + 12-fold hub + Crown                                                               | `createWorld`                                                                                                                                             |
| Starting cities, neutral cities               | capital seeds; Crown with 400 guards                                                        | capitals only                                   | capitals only                                   | capitals; Crown                                                                                | `createWorld`; `newCity`, `neutralProduction` _data_                                                                                                      |
| Distance and travel time                      | `max(minTravel, isqrt(pace²·d²))`; same island `sameIslandTravel` (both 3600); slowest ship | `max(3600, 1200 + d·pace)`; land walk speeds    | `3600 + 600·d` for everything                   | milli-tiles, `ceilDiv(d·pace, 1000)`; same island 4000                                         | `travelTime`; `travelProbes` _data_                                                                                                                       |
| Production, storage, pop curves               | quadratics                                                                                  | quadratics                                      | linear                                          | per-level tables                                                                               | _data_ (`levels`)                                                                                                                                         |
| Build cost and time                           | `base·w(L)/10`, `/(9 + hall)`                                                               | same family                                     | `50L`, `900L` s                                 | growth per mille                                                                               | _data_ (`buildings[].cost/time`)                                                                                                                          |
| Build requirements                            | projected levels                                                                            | completed levels                                | –                                               | projected levels                                                                               | _data_ (`queues.build.requiresOn`)                                                                                                                        |
| Recruit delivery                              | trickle                                                                                     | trickle                                         | whole order                                     | trickle                                                                                        | _data_ (`queues.delivery`)                                                                                                                                |
| Cancel and refunds                            | tail cancel; build 100% / pro rata; recruit 100% of uncompleted                             | cancel later items of the same building         | tail cancel; 100% / 50%                         | grace tiers (100% ≤ 600 s, 80%, 50%), cascade on broken requirements, remaining items close up | _data_ (`queues.refund`) for tail cancels; `actions.cancel_queue` override on std's `removeQueueItems` and `reflowQueue` for classic and ring-crown       |
| Settler cost scaling                          | `base × min(k, 10)`                                                                         | –                                               | `1000·N`                                        | +60% per city                                                                                  | _data_ (`settlerCost[k]`)                                                                                                                                 |
| Attack protection                             | 12 h                                                                                        | 24 h                                            | none                                            | 12 h                                                                                           | _data_ (`time.attackFrom`)                                                                                                                                |
| Recall rules                                  | 600 s; attack/support/found; stationed partial; dismiss                                     | same                                            | support only; stationed whole                   | 900 s                                                                                          | _data_ (`movement.recall`)                                                                                                                                |
| Shipments                                     | harbor cargo cap                                                                            | cap, one in flight                              | carried by auto-assigned transports             | cap                                                                                            | `movement.shipment` _data_ + `departure`                                                                                                                  |
| Founding slot                                 | lowest free slot                                                                            | lowest free slot                                | lowest free slot                                | requested slot, else lowest                                                                    | _data_ (`toolOptions.foundSlot`)                                                                                                                          |
| Target rules and recorded foe at launch       | foe/party, relief of own besieged city                                                      | foe/party                                       | owner at launch                                 | owner at launch; ally aborts                                                                   | `departure`                                                                                                                                               |
| Battle, loot, morale, rams, renown, reports   | naval gate, square law, wall breach, morale by cities                                       | naval losses aboard, drowning                   | no base defense, half-stock loot                | rams, morale by score, ^1.5 losses, renown                                                     | `arrive.attack` (losses allocated by `std.allocateLosses`)                                                                                                |
| Siege or instant capture; re-home or disband  | 6 h siege, garrison battles, re-home to oldest city                                         | siege, homed units removed                      | instant capture, units removed, capitals immune | instant capture, disband                                                                       | `arrive.*`, `on.*`, `afterStep`, std primitives                                                                                                           |
| Espionage                                     | counter-intel with pop                                                                      | counter-intel                                   | always succeeds, target told                    | watch value                                                                                    | `arrive.spy`                                                                                                                                              |
| Support, shipment, return on arrival          | siege-aware                                                                                 | siege-aware                                     | owner change returns                            | owner change variants                                                                          | `arrive.support/shipment/return` (domain defaults)                                                                                                        |
| Betrayal                                      | on impact                                                                                   | at launch                                       | none                                            | on impact                                                                                      | inside `arrive.attack`, or `afterStep` on the launch action                                                                                               |
| Relation model                                | named blocs, capped                                                                         | pairwise relations (≤ 2 allies, not transitive) | named blocs                                     | named blocs + rejoin cooldown                                                                  | `relations` hook (all relation queries go through `std.relation`); `actions` overrides of propose/answer/leave for classic; `guard` + `ext` for cooldowns |
| Pacts                                         | 48 h, max 2                                                                                 | 48 h, max 2                                     | no expiry                                       | until a chosen time                                                                            | _data_ (`pactDuration`, `maxPacts`, `toolOptions.pactUntil`)                                                                                              |
| Visibility                                    | allies see cities live                                                                      | allies see units present and incoming           | allies also see movements and reports           | allies see cities                                                                              | `visibility` (`publicCity` receives the viewer; `briefing` for seat-scoped state); reports are emitted per recipient by the ruleset                       |
| Score                                         | cities + levels + Crown + capped battle points                                              | cities + levels + battle points / 10            | 20 + levels                                     | 100 + 5·levels + renown                                                                        | `standings`                                                                                                                                               |
| Victory, elimination                          | bloc domination from day 4 with 24 h hold; last standing; time                              | individual 30% with 24 h hold                   | alliance > 50% with 24 h hold; no elimination   | individual threshold by day, instant                                                           | world timers + `on.*`, `afterStep`, `finish`, `std.eliminate`                                                                                             |
| Same-second event classes                     | 12 classes                                                                                  | 12 classes                                      | 7 classes                                       | 7 classes                                                                                      | _data_ (`eventClasses`)                                                                                                                                   |
| Wake budgets and caps                         | own 12 + social 8; urgent gap 600 s; §14 of the ruleset                                     | similar                                         | similar                                         | urgent gap 1800 s, 40 calls per wake, self-wake budget only                                    | _data_ (`gateway`: budgets, `urgentMinGap`, `toolCallsPerWake`)                                                                                           |
| Message and proposal caps by kind             | 20 messages per day                                                                         | similar                                         | similar                                         | separate public and private caps, recipient limit, proposals per day                           | future `GatewayRules` extension gated by a `CompiledRules` field (§3.5); not needed by phase-1 rulesets                                                   |
| Lockstep same-second action order             | shuffle on `lockstep:<t>:<b>`                                                               | unspecified                                     | shuffle on `seed ^ t`                           | hash sort                                                                                      | **core**: not a hook. Any seeded order is equally fair.                                                                                                   |

The hook set is therefore: `createWorld`, `travelTime`, `departure`, `arrive`, `on`, `guard`, `afterStep`, `relations`, `standings`, `finish`, `visibility`, plus the `actions` override for structurally different diplomacy and cancels and for extra tools. Every other difference is data.

### 3.5 Registry, versions and freezing

```ts
// engine/src/rulesets/index.ts
export const RULESETS: readonly AnyRuleset[]; // [perfidia1_1_0_0, perfidia1_1_1_0, sandbox1_1_0_0]
export function findRuleset(refOrId: string): AnyRuleset | undefined; // bare id: latest published, else latest test
export function getRuleset(refOrId: string): AnyRuleset; // throws UnknownRuleset listing RULESETS
export function parseRulesetRef(s: string): { id: string; version: string } | null;
export function validateRegistry(): void; // throws on the first problem; run by a test and on every getRuleset call (no module state, §6.5)
```

- A ruleset is identified by `id@MAJOR.MINOR.PATCH`. `validateRegistry` rejects: duplicate refs; defaults that do not parse; for every N in `players(defaults)`, a `compile` output that fails the checks of §3.6; an `eventClasses` map missing a domain or ruleset kind, or where `match_end` shares its class with another kind; an `intelEvents` entry that is not a key of `eventSchemas`; an extra tool whose name collides with `TOOL_NAMES` or another extra, whose `args` do not convert with `z.toJSONSchema` or convert to anything but a root `type: "object"` (§3.7), or which is a `write` tool while `hooks.actions.ext` is missing; a `gateway.wake` key or `publicOncePerDay` entry that is neither a standard event type nor a key of `eventSchemas` (a misspelt key would silently wake nobody), or a `publicOncePerDay` type whose data has no required `key` field; an `errors` code that reuses a domain code or a gateway warning (the gateway words those itself, so the ruleset's text would be dead, and a later gateway code of that name would change what agents read under a frozen ref).
- A bare id resolves to the latest published version, otherwise to the latest test version (which `sim run` still refuses without `--allow-test`).
- **A published version is frozen.** Anything that can change a match's state hashes, its events, or what agents see (cheat sheet, config defaults, compiled tables, wording of ruleset errors and warnings) requires a new version. Refactors that change none of these keep the version.
- **Layout.** `rulesets/perfidia-1/` holds `1.0.0`. A later `1.1.0` adds a new descriptor file (`v1_1_0.ts`) that reuses the unchanged modules of `1.0.0` and new files for what changed. Files used by a published version are never edited for behaviour.
- **The core must not move under a published ruleset.** A core change that alters the outcome of an existing ruleset version is a bug, whatever `ENGINE_VERSION` says. If a core fix must change behaviour, it is gated by a `CompiledRules` field that old versions do not set. The same applies to a new gateway policy (for example message caps by kind): it is a new `GatewayRules` field whose absence keeps the old behaviour.
- **Freeze guard** (§13.5, §13.6): for every published ref, committed golden logs verified at Level E by every `bun test` (so every `bun run check` and CI run), forever, and a fingerprint of its agent-visible artefacts, recomputed by the same test. Both are **append-only**: no tool rewrites an existing golden or fingerprint entry, and an `ENGINE_VERSION` bump does not permit it.
- `ENGINE_VERSION` (`kernel/version.ts`, semver) is recorded in every log and snapshot. Replay warns on a mismatch and proceeds; the hashes decide.

**Publishing a ruleset version**: write the descriptor, add it to `RULESETS`, add its goldens and fingerprint (`sim golden --update` creates only missing files), add a header to its spec document stating `id@version`. **Re-simulating an old match**: `sim verify` resolves the header's ref in the registry; an unknown ref is a clear error naming the refs this build contains.

### 3.6 Match setup, overrides and config checks

```ts
// protocol/src/match.ts
export interface MatchSetup {
  ruleset: RulesetRef; // always the exact ref, even if the CLI was given "perfidia-1"
  overrides: Record<string, Json>; // dotted config paths -> values
  seed: number; // uint32
  idKey: string; // 32 lowercase hex chars (128 bits): the secret key of opaque ids (§4.1); never shown to agents
  seats: { id: PlayerId }[]; // p1..pN in order; N within ruleset.players(config). Seats have no names (§4.2).
}
export interface Standing {
  player: PlayerId;
  rank: number; // 1-based, no shared ranks
  score: number;
  parts: Record<string, number>; // ruleset-defined, public, e.g. cityPoints, battleScore
  cities: number;
  alive: boolean;
}
export interface MatchResult {
  endedAt: GameTime;
  reason: string; // "time", "domination", "last_standing", or a ruleset-specific reason
  winners: PlayerId[]; // one player, or a winning bloc's members
  standings: Standing[];
}
// engine/src/kernel/config.ts
export function parseOverride(s: string): { path: string; value: Json } | { error: string }; // "a.b=3"
export function resolveConfig<C>(
  rs: Ruleset<C>,
  overrides: Readonly<Record<string, Json>>,
): { ok: true; config: C; hash: Sha256 } | { ok: false; errors: ConfigIssue[] };
// engine/src/kernel/checks.ts
export function checkRules(rules: DeepReadonly<CompiledRules>): ConfigIssue[]; // generic checks below
export class MatchConfigError extends Error {
  readonly issues: ConfigIssue[]; // sim exit code 3
}
```

- **Override syntax**: `key.path=value`. The value is parsed as JSON when it parses (`5`, `true`, `[1,2]`, `"x"`), otherwise taken as a string. Array elements use numeric segments (`homeRadius.6=200`).
- **Resolution**: deep-clone `defaults`, set every path (an unknown path is an error that lists the valid sibling keys), then validate the **whole** result with `configSchema`. Every number in a config is an integer (`z.number().int()`); fields a ruleset fixes are `z.literal` (an override that changes them fails with a message naming the field as fixed by the ref). Cross-field rules live in `superRefine`. A `canonicalJson` failure while hashing is reported as a config error, never thrown.
- **Compile checks.** `resolveConfig` then runs, for every N in `players(config)`: `compile(config, N)`, the generic `checkRules` on the result, and `ruleset.check?.(config, rules)`. A failing config is rejected with path-addressed errors (`sim` exit code 3), never by an `EngineBug` or a hang mid-match. `checkRules` asserts:
  - every build and recruit time is ≥ 1, every start stock fits the storage cap of its city's start level (`newCity` here; capitals and neutral cities are checked at creation), and the queue and pop tables cover `maxLevel`;
  - `resourceScale` is a multiple of 3600, so that every rate per game hour accrues a whole number of stored units per second (`std.accrualPerSecond` throws otherwise, an `EngineBug` at the first accrual);
  - `time.matchEnd ≥ 1` and `gateway.urgentMinGap < time.minTravel`;
  - `gateway.selfWake.min ≥ 1`, `selfWake.min ≤ selfWake.max` and `gateway.safetyWake ≥ selfWake.min` (otherwise clamping breaks, and a 0 s safety wake wakes every seat every second);
  - `gateway.roundTripsPerWake ≥ 1`, `gateway.toolCallsPerRoundTrip ≥ 1`, `gateway.toolCallsPerWake` null or ≥ 1 (otherwise every turn is empty);
  - `gateway.ownWakesPerDay ≥ 1` and `gateway.socialWakesPerDay ≥ 1` (an exhausted budget moves a wake to the next day, which with a budget of 0 would repeat forever);
  - `diplomacy.proposalTtl ≥ 1` and `diplomacy.pactDuration` null or ≥ 1 (a 0 s duration would schedule an expiry at `now`, an `EngineBug` mid-match).

  `perfidia-1`'s `check` adds `siegeDuration > recallWindow` and `sameIslandTravel ≥ minTravel` (ruleset §16).

- **Creation checks.** `createMatch` throws `MatchConfigError` (not `EngineBug`) when `setup` fails the `MatchSetup` schema (an `idKey` that is not 32 lowercase hex characters, for example), when `setup.ruleset !== ruleset.ref`, when N is outside `players(config)`, when a world timer is at `< 1`, when a start city's stock exceeds its storage cap, when `travelTime(r, a, b, probe.group) < rules.time.minTravel` for some pair of islands `(a, b)`, the same island included, and some travel probe (the probes must therefore include the fastest group the ruleset allows; the `std` invariant of §13.3 backs this up at runtime), or when the checkpoint invariants fail on the freshly created world. Timers after `matchEnd` are allowed; they never fire.
- **Hash**: `configHash = sha256Hex(canonicalJson({ ruleset: ref, config }))`, over the effective config. An override equal to the default does not change the hash.
- The log header stores the engine version, the ruleset ref, the overrides, the full effective config, its hash and `rulesHash` (§10.2). Replay recomputes the effective config from the ruleset and the overrides and checks the embedded config and both hashes.
- Convention: every ruleset keeps `time.matchEnd` in its config, so the CLI's `--days N` is sugar for `--override time.matchEnd=N·86400`.

### 3.7 Tool shapes, and optional extra tools

The 22 tools of the brief have the same names and argument shapes in every ruleset. Ruleset differences reach agents through the `rules` tool (cheat sheet, config, `CompiledRules`) and through `ext` fields in views and briefings.

**Root shape.** Every tool's arguments are a single `z.object` (with refinements where modes exclude each other), so each converts to a JSON Schema with root `type: "object"` and no root `anyOf`, `oneOf` or `allOf`. Anthropic `input_schema`, OpenAI function parameters and Gemini function declarations all expect a root object schema; a root union would make a later reshape a breaking interface change.

**Evolution rule.** A tool's argument schema changes only by adding **optional** fields. A ruleset opts into each optional field through `CompiledRules.toolOptions`; the gateway rejects an optional field the ruleset does not support with `INVALID_ARGS` naming the ruleset ("perfidia-1@1.0.0 always uses the lowest free slot: remove `slot`"). Two such fields are reserved now so that `ring-crown` needs no protocol change: `found_city.slot` (`toolOptions.foundSlot`; carried in `DepartureDraft.slot`) and `propose_alliance.until` (`toolOptions.pactUntil`; carried in `Proposal.until`).

If a ruleset needs a new verb, it declares an extra tool:

```ts
export interface ExtraTool {
  readonly name: string; // snake_case; must not collide with TOOL_NAMES (checked by the registry)
  readonly family: "observe" | "economy" | "military" | "diplomacy";
  readonly description: string;
  readonly args: ZodType; // a z.object; must convert with z.toJSONSchema to a root type "object" (checked)
  readonly kind: "read" | "write";
  read?(r: ReadCtx, seat: PlayerId, args: unknown): JsonObject; // kind "read"; must be fog-safe
}
```

- A `write` extra tool becomes the engine action `{ type: "ext", tool, args }`, logged and replayed like any other action and handled by the ruleset's `hooks.actions.ext` (required when the ruleset declares a write tool). If an `ext` action reaches the kernel with no handler, it is rejected as a `Violation` (`INVALID_ARGS`), never thrown.
- The gateway lists extra tools after the 22, applies the same turn gate, caps and fog prechecks, and includes them in the `rules` payload. `toolDefinitions(ruleset)` (§8.3) returns the name, description and JSON Schema of the 22 tools plus that ruleset's extras. Bots ignore tools they do not know.
- `sandbox-1` declares one read tool and one write tool (§3.8), so the whole path is exercised in phase 1. The testing kit's fixture ruleset does too.

### 3.8 The second ruleset: `sandbox-1@1.0.0` (status `test`)

Its only purpose is to prove that two rulesets coexist in one build and that the core does not secretly depend on `perfidia-1`. It therefore differs from `perfidia-1` on every axis where core, gateway or bot code could quietly hard-code a `perfidia-1` id or number: no building, unit or queue id is shared, event classes, gateway caps, wake table, recall, diplomacy and visibility all differ, and it has world timers, a non-empty `ext` and extra tools. Every `CompiledRules` field is listed below; all numbers are config defaults.

| Area             | sandbox-1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Players          | `players()` = 2–12.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Map              | Ring of N sectors, 40 tiles wide, `W = 40N`. Sector k: island `i(2k+1)` (kind `home`) at `(40k, 0)` with 2 slots, richness 1000; island `i(2k+2)` (kind `shared`) at `(40k+20, 15)` with 2 slots, richness 1500. Distance `d = min(dx, W−dx) + dy`. Seats: `perm = shuffle([0..N−1])` on stream `seats`; player `p(j+1)` gets sector `perm[j]` and its capital `c(j+1)` in slot 0 of that home island. No neutral city.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Time             | `matchEnd` 604800 (7 days), `minTravel` 4800 (not perfidia-1's 3600, so a hard-coded 3600 fails), `attackFrom` 21600, `resourceScale` 3600. `neutralProduction` false (there is no neutral city).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Travel           | `minTravel + 60·d` for every movement kind, i.e. `4800 + 60·d`; same island `minTravel` (4800). One travel probe, labelled `any`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Buildings        | `keep` (population), `sawmill` (wood), `pit` (stone), `forge` (gold), `depot` (storage), `camp` (land recruits), `docks` (boats). No wall, no build speed-up (`buildSpeed: null`). Max level 8. Level L costs `30L / 30L / 10L` and takes `600·L` s. Production 20 at level 0, `40 + 40L` per hour from level 1; storage `800 + 700L`; pop `50 + 40L`. `camp` and `docks` require keep 2. Requirements are checked on **completed** levels (`requiresOn: "completed"`).                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Units            | `spearman` (land, att 5, def 15, carry 10, pop 1, 20/30/20, 240 s, queue `camp`, camp 1), `axeman` (land, att 15, def 5, carry 25, pop 1, 30/20/25, 240 s, `camp`, camp 1), `colonist` (settler, land, pop 5, cost `300 × min(k, 6)` of each, 3600 s, `camp`, camp 2, `maxPerOrder` 1), `boat` (naval, capacity 15, pop 2, 100/30/50, 900 s, `docks`, docks 1). No warship. Unit times do not depend on building levels. `maxPerOrder` 300 except the colonist.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Start            | Capital: keep, sawmill, pit, forge, depot at 1; 500 of each; 8 spearmen. Founded city: the same buildings, 200 of each, plus its escort.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Queues           | Build max 4. Recruit queues `camp` (building camp) and `docks` (building docks), 4 batches of ≤ 300 each. **Batch delivery.** Refunds: build and recruit 100% queued, 50% of the active item (`{pm: 500}`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Movement         | Recall: window 900 s, kinds `support` only, stationed `whole`, no dismiss. Shipment cap `300 + 300 × docks`. Transport rule on. `spyMinGold` 50. `toolOptions`: `foundSlot` true (the requested slot if free at arrival, else the lowest free slot, else bounce), `pactUntil` false.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Combat           | Land only. `A = Σ attack` of attacking land units; `D = Σ defense` of every land unit present not owned by the attacker `+ 10 × keep`. Boats count in neither. `A > D` wins, ties to the defender. The loser's land units all die; the winner loses `cas(n, lossPm(loser, winner))` per stack, allocated with `std.allocateLosses`. The defender's boats die when the defender loses; the attacker's boats always survive and sail home with the survivors. Every battle emits the standard `battle` (public) and per-recipient `battle_report` events; every participant's copy (attacker, owner, stationed defenders) carries the same full battle data, only the report id differs (no redaction). An attack fights only the owner recorded at launch (its party): if the target changed owner meanwhile, the attacker included, it bounces home with reason `owner_changed`. No betrayal mechanic. |
| Capture and loot | Attacker wins with a surviving colonist, and the target is not a capital or the attack lands at t ≥ 172800 → **immediate capture**: 1 colonist consumed, survivors and boats become the city's home units, units homed in the city are **disbanded** everywhere, queues cleared without refund, standard `city_conquered`; the former owner is eliminated if it has no city left. Otherwise loot: `lootable_r = floor(stock_r / 2)`, `T = Σ lootable`; if `T ≤ carry` take everything, else `take_r = floor(lootable_r × carry / T)`.                                                                                                                                                                                                                                                                                                                                                                  |
| Espionage        | Success iff `gold > 50 + Σ land pop present`. Failure: `spy_failed` to the spier, `spy_detected` to the target.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Diplomacy        | Domain defaults with `allianceMax` 3 (independent of N), `maxPacts` 1, `pactDuration` null (pacts never expire), `maxOpenProposals` 2, `proposalTtl` 21600, `messageMaxChars` 500, `proposalTextMaxChars` 200, `allianceNameMaxChars` 16.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Visibility       | `std` defaults, except `movementAccess`: allies see each other's movements in full. `publicCity` adds `{name}` (player-chosen, see `rename_city`); `publicMatch` adds the hill status.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Event classes    | 0 `build_done`, `recruit_done`; 1 `arrive_return`, `arrive_support`, `arrive_shipment`, `arrive_found`; 2 `arrive_spy`; 3 `arrive_attack`; 4 `proposal_expire`, `pact_expire`, `hill_open`; 5 `match_end`. Build and recruit completions of one second resolve by seq, unlike `perfidia-1` (build 1 before recruit 2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Gateway          | `roundTripsPerWake` 6, `toolCallsPerRoundTrip` 8, `toolCallsPerWake` 30, `ownWakesPerDay` 8, `socialWakesPerDay` 6, `groupWindow` 300, `urgentMinGap` 300, `selfWake` 1800–21600, `safetyWake` 21600, `attackLaunchesPerDay` 10, `messagesPerDay` 10, `notesMaxChars` 2000. Wake table: urgent for `incoming_attack` (party) and `city_conquered` (target); own for `queue_empty` (self), `battle_report` (self), `spy_report` (self), `spy_failed` (self); social for `message`, `proposal`, `proposal_answered` (target), `battle_report` (target, stationed), `spy_detected` (target), `incoming_attack` (ally).                                                                                                                                                                                                                                                                                    |
| Score, end       | 50 per city + 2 per building level (parts `cityPoints`, `levelPoints`). **Hill victory**: the world timer `hill_open` at t = 172800 sets `ext.hillOpen`; from then on, `afterStep` declares the winner (reason `hill`) when one player owns ≥ `ceilDiv(totalCities, 2)` cities and ≥ 2; when several qualify in the same step, the one with more cities wins, then the higher score, then the lower player number, and the winner is ranked first. Last standing wins (checked before the hill). Otherwise the highest score at `matchEnd` (ties: cities, then player number). `ext` = `{hillOpen: boolean}`.                                                                                                                                                                                                                                                                                          |
| Extra tools      | `hill_status` (read, observe): `{open, opensAt: [t, text], threshold, totalCities, leaders: [{player, cities}]}` from public data, `leaders` being the three players owning the most cities (ties by player number); `publicMatch.hill` has the same shape. `rename_city {city, name}` (write, economy): own city, name ≤ 16 characters among ASCII letters and digits, space, `-`, `_`, `.` (the protocol name schema); handled by `hooks.actions.ext`; a name that breaks the rules is the sandbox violation `CITY_NAME_INVALID` (details `city`, `reason` `length` or `characters`, `length`, `max`; the limit is config `names.cityMaxChars`, 16), so a non-perfidia ruleset code goes through the gateway's ruleset-error path; emits the sandbox event `city_renamed {city, name}` (public; declared in `eventSchemas`).                                                                         |

---

## 4. State model

### 4.1 Ids and primitives (`protocol/src/ids.ts`, `resources.ts`, `json.ts`)

```ts
export type GameTime = number; // integer game-seconds since match start
export type PlayerId = `p${number}`; // seat order
export type IslandId = `i${number}`;
export type CityId = `c${number}`; // keeps its id when it changes owner
export type AllianceId = `a${number}`;
export type MovementId = `m${string}`; // opaque: prefix + 5 chars of lowercase Crockford base 32
export type ReportId = `r${string}`; // opaque
export type ProposalId = `q${string}`; // opaque
export type MessageId = `g${string}`; // opaque
export type QueueItemId = number; // per city, shared by build items and recruit batches; shown as "#7"
export type Hash64 = string; // 16 lowercase hex chars (FNV-1a 64)
export type Sha256 = string; // 64 lowercase hex chars
export type ResourceId = "wood" | "stone" | "gold"; // fixed by the brief, canonical order
export type Res = { wood: number; stone: number; gold: number };
export type BuildingId = string; // /^[a-z][a-z_]*$/, validated against CompiledRules
export type UnitId = string; // same
export type QueueId = string; // "build" or a recruit queue id from CompiledRules
export type UnitCounts = Partial<Record<UnitId, number>>; // zero entries are omitted
export function compareIds(a: string, b: string): number; // prefix; then numeric for p, i, c, a; code-unit order for opaque kinds
```

- **Public kinds** (`p`, `i`, `c`, `a`) are counters in creation order; their creation is public anyway.
- **Private kinds** (`m`, `r`, `q`, `g`) are opaque, so that the value and the gaps of the ids an agent sees reveal nothing about other players' hidden activity (how many private messages were exchanged, how many spies or supports were launched). Each player has its own counter per private kind (`state.ids.own`); the owner is the mover, the report's recipient, the proposer or the sender. `core/opaque.ts` maps (owner, counter) to the id with a keyed bijection, so ids are unique without any collision check (messages and reports are not in the state, so collisions could not be checked anyway):

  ```
  opaqueId(idKey, prefix, owner, n):    owner = player number (1..15), 1 ≤ n < 2^20 (EngineBug beyond)
    v = n · 16 + owner                                          a 24-bit value
    L = v >>> 12; R = v & 0xfff
    repeat 8 times (round = 0..7):
      F = parseInt(sha256Hex(`${idKey}:${prefix}:${round}:${R}`).slice(0, 3), 16)   12 bits
      [L, R] = [R, L ^ F]
    return prefix + base32(L · 4096 + R, 5 digits)               alphabet 0123456789abcdefghjkmnpqrstvwxyz
  ```

  - **The key is a per-match secret**, `setup.idKey` (128 bits, §3.6), not derived from the seed: the uint32 seed can be recovered from public data (the map and the tie-break order), and a key derived from it, or FNV rounds keyed by it, would let an agent with code execution decode every id it sees into (owner, counter). The key is in the log header and snapshots (operator data) and never reaches an agent. Callers that need no secrecy (tests, goldens, bot batches) use `idKeyFromSeed(seed) = sha256Hex("perfidia-idkey:" + seed).slice(0, 32)` from `core`; LLM matches (phase 2 on) use a random key.
  - SHA-256 round function, 8 rounds, as format-preserving schemes on small domains use. Cost: 8 SHA-256 blocks per id, a few tens of thousands of ids per match; a per-`Match` memo of round values (not state, not module-level) is allowed.
  - Residual limit: a 24-bit domain is small, so this resists decoding, not every statistical test; see §14.

  A player's own ids depend only on the key and its own history, never on other players' actions (property P15). Nothing may assume that the order of private ids is creation order: code that needs creation order uses the `seq` of the entity's event.

- `compareIds` lives in `protocol` because bots, gateway and engine must sort identically. It is a total order: prefix first, then the numeric value for public kinds and code-unit order for private kinds (fixed width, so the two never mix within a kind). Zod schemas use `z.templateLiteral` plus a regex for the opaque kinds. `DeepReadonly<T>` and `Json`/`JsonObject` are defined in `json.ts`.
- **Player-authored names** (alliance names, `sandbox-1` city names) use ASCII letters and digits, space, `-`, `_` and `.` only (`/^[A-Za-z0-9 _.-]+$/`, protocol schema); their length limit comes from `CompiledRules`. ASCII, not `\p{L}`: Unicode property classes depend on the runtime's Unicode version, so a name could validate in Bun and fail in a browser replay.

### 4.2 `GameState` (`protocol/src/state.ts`; its Zod schema is the snapshot format)

```ts
export interface GameState {
  v: 1;
  ruleset: RulesetRef;
  configHash: Sha256;
  seed: number;
  now: GameTime;
  status: "running" | "ended";
  seq: number; // last scheduled-event seq (global, monotonic)
  ids: {
    c: number; // last allocated city number
    a: number; // last allocated alliance number
    own: Record<PlayerId, { m: number; r: number; q: number; g: number }>; // private kinds, per owner
  };
  evHash: Hash64; // running hash of every emitted event (§6.4)
  queue: ScheduledEvent[]; // sorted by (at, cls, seq)
  players: Record<PlayerId, Player>;
  islands: Record<IslandId, Island>;
  cities: Record<CityId, City>;
  movements: Record<MovementId, Movement>;
  proposals: Record<ProposalId, Proposal>;
  alliances: Record<AllianceId, Alliance>;
  pacts: Pact[]; // sorted by (a, b), a < b
  ledger: Record<PlayerId | "neutral", { made: UnitCounts; gone: UnitCounts }>; // unit conservation
  ext: Json; // ruleset-owned, validated by ruleset.extSchema
  result: MatchResult | null;
}
export interface Player {
  id: PlayerId; // players have no names: agents know each other only by id
  alive: boolean;
  eliminatedAt: GameTime | null;
  alliance: AllianceId | null; // read only by std's default relations (§5.4)
}
export interface Island {
  id: IslandId;
  x: number;
  y: number; // integer tiles
  kind: string; // ruleset label: "home", "frontier", "crown", …
  slots: number;
  richnessPm: number; // production multiplier, per mille
}
export interface City {
  id: CityId;
  name: string; // the id unless a ruleset lets players rename cities (sandbox-1); player-authored
  owner: PlayerId | null; // null = neutral (the Crown)
  island: IslandId;
  slot: number;
  capitalOf: PlayerId | null;
  tag: string | null; // ruleset marker, e.g. "crown"
  foundedAt: GameTime;
  stock: Res; // resource-seconds: whole units × resourceScale
  stockAt: GameTime; // last materialisation
  buildings: Record<BuildingId, number>; // every building of the ruleset, 0 included
  units: UnitCounts; // the owner's units at home (neutral garrison when owner is null)
  stationed: Stationed[]; // sorted by (owner, home, role)
  itemSeq: number; // last queue item number allocated in this city
  build: BuildItem[]; // queue order; each item has its own event
  recruit: Record<QueueId, RecruitBatch[]>;
}
export interface Stationed {
  owner: PlayerId; // may be the city's owner (units homed in its other cities)
  home: CityId; // units keep their home city
  role: "support" | "hold"; // "hold" = holding the city against its owner (perfidia-1 siege garrison)
  units: UnitCounts;
}
export interface BuildItem {
  id: QueueItemId;
  building: BuildingId;
  level: number; // projected target at enqueue (cost and duration); completion adds +1 to the current level
  cost: Res;
  start: GameTime;
  end: GameTime;
  seq: number;
}
export interface RecruitBatch {
  id: QueueItemId;
  unit: UnitId;
  count: number;
  done: number; // units already materialised (trickle)
  unitTime: number;
  costEach: Res;
  popEach: number;
  start: GameTime;
  end: GameTime;
  seq: number;
}
export type MovementKind = "attack" | "support" | "found" | "spy" | "shipment" | "return";
export interface Movement {
  id: MovementId;
  kind: MovementKind;
  owner: PlayerId;
  home: CityId; // where the units belong (destination of a return)
  from: CityId;
  fromIsland: IslandId;
  to: CityId | null; // null for found
  toIsland: IslandId;
  slot: number | null; // requested founding slot (toolOptions.foundSlot)
  party: PlayerId | null; // recorded at launch by the departure hook; null = neutral or n/a
  units: UnitCounts;
  cargo: Res; // whole units (shipments, loot, returning cargo)
  gold: number; // spy
  departAt: GameTime;
  arriveAt: GameTime;
  seq: number; // its arrival event
  back: { kind: MovementKind; at: GameTime } | null; // a return made by recall or bounce
}
export interface Proposal {
  id: ProposalId;
  from: PlayerId;
  to: PlayerId;
  kind: "alliance" | "pact";
  name: string | null;
  until: GameTime | null; // pact end chosen by the proposer (toolOptions.pactUntil)
  expiresAt: GameTime;
  seq: number;
}
export interface Alliance {
  id: AllianceId;
  name: string;
  members: PlayerId[];
  formedAt: GameTime;
}
export interface Pact {
  a: PlayerId;
  b: PlayerId;
  since: GameTime;
  expiresAt: GameTime | null;
  seq: number | null;
}
```

Rules:

- **Derived values are never stored**: rates, storage cap, pop cap, pop used, points, free slots, a player's cities.
- **Messages, reports, notes and proposal texts are not in the state.** They are events (§6.4, §8.4).
- **Only the queue item snapshot is cached**: cost, pop and duration are pinned at enqueue, as the ruleset requires. Views show a build item's target as the current completed level plus its position among the queued items of that building, so a wall breach is reflected at once.
- **Ruleset state**: `perfidia-1`'s `ext` holds sieges `{by, startedAt, endsAt, seq}` by city, battle points by player, the public tie-break order, relation end times for the kill-credit cooldown, the domination flag and countdowns. Garrison units are `Stationed` groups with `role: "hold"`, so pop, conservation and recall work on them generically.

### 4.3 Lazy accrual and materialisation

- Stock is stored in resource-seconds (`stock_r = whole × resourceScale`), so `stock(t1) = min(cap × scale, stock(t0) + rate × (t1 − t0))` is exact and path-independent (rates are non-negative and a cap only stops growth).
- Trickled recruits: unit `j` of a batch completes at `start + j·unitTime`; `done` counts those already moved to `units`.
- `std.materialize(ctx, city)` brings stock and trickle up to `ctx.now`. It runs only inside `apply` and event handlers, before any change of stock, rate, cap, level, units or ownership of that city.
- **Reads and validation never materialise**: views use `std.stockAt(r, city, t)` and `std.unitsAtHome(r, city, t)`, which compute without writing. Otherwise the stored representation, and so the hash, would depend on who looked at a city; gateway reads are not replayed at Level E, so live and replayed hashes would diverge. Property test P3 enforces it.
- Visible stock is `floor(stock / scale)`. Every addition is capped by the warehouse and reports what was lost.

---

## 5. Event queue and kernel

### 5.1 Scheduled events

```ts
export interface ScheduledEvent {
  at: GameTime;
  cls: number; // from rules.eventClasses[kind]
  seq: number; // global, assigned at (re)scheduling
  kind: string; // "build_done", "arrive_attack", "siege_end", …
  ref: string; // entity id: city, movement, proposal, pact key "p1|p4", or ""
}
```

- **Total order** `(at, cls, seq)`: `seq` is unique, so the order never depends on insertion history. Launch order decides between same-second arrivals (attack trains).
- **Domain kinds**: `build_done`, `recruit_done`, `arrive_return`, `arrive_support`, `arrive_shipment`, `arrive_spy`, `arrive_attack`, `arrive_found`, `proposal_expire`, `pact_expire`, `match_end`. Rulesets add their own (`perfidia-1`: `siege_end`, `domination_open`, `domination_end`; `sandbox-1`: `hill_open`).
- `perfidia-1` classes (§1.4 of the ruleset): build 1, recruit 2, return 3, support 4, shipment 5, spy 6, attack 7, found 8, siege end 9, proposal/pact/domination-opening timers 10, domination end 11, match end 12. `sandbox-1` uses six classes (§3.8).
- **`match_end` has a class of its own** (checked by the registry and at creation). The highest class lets every other event of that second resolve first (`perfidia-1`); the lowest would let none resolve (`ring-crown`). Each ruleset chooses explicitly.
- **Storage**: `state.queue`, a sorted array. `core/sorted.ts` provides `insertSorted` (binary search) and `removeWhere`; the kernel's `schedule(kind, at, ref)` asserts `at > now` (every duration ≥ 1 s, guaranteed by the config checks of §3.6) and returns the seq; `cancel(seq)` removes the item and throws `EngineBug` if it is missing. Entities store the `seq` of their pending event.
- **Cancellation is real removal**: a tail cancel removes the events of the removed items; a recall cancels the arrival and schedules `arrive_return` with a new seq (the ruleset's "rescheduled").
- **Dispatch**: `match_end` → kernel; `arrive_<kind>` → `ruleset.hooks.arrive[kind] ?? domain.arrivals[kind]`; other kinds → `ruleset.hooks.on[kind] ?? domain.events[kind]`. A kind with no handler, or without a class, is rejected when the match is created.
- World timers (§3.2 `WorldSetup.timers`) drive time-gated conditions (§3.1).

### 5.2 Context objects (`contracts/ctx.ts`)

```ts
export interface ReadCtx<C = unknown, X = unknown> {
  readonly state: DeepReadonly<GameState>;
  readonly now: GameTime;
  readonly rules: DeepReadonly<CompiledRules>;
  readonly config: DeepReadonly<C>;
  readonly ruleset: Ruleset<C, X>;
  ext(): DeepReadonly<X>;
}
export interface Ctx<C = unknown, X = unknown> {
  readonly state: GameState; // the owned draft
  readonly now: GameTime;
  readonly rules: DeepReadonly<CompiledRules>;
  readonly config: DeepReadonly<C>;
  readonly ruleset: Ruleset<C, X>;
  ext(): X;
  read(): ReadCtx<C, X>;
  emit(e: Omit<DomainEvent, "t">): void; // serialises once, folds evHash, routes a copy (§6.4)
  schedule(kind: string, at: GameTime, ref: string): number;
  cancel(seq: number): void;
  nextId(kind: "c" | "a"): string; // public counters
  nextId(kind: "m" | "r" | "q" | "g", owner: PlayerId): string; // opaque, per owner (§4.1)
  nextItem(city: CityId): QueueItemId;
  // A fresh mulberry32 on `${seed}:${stream}`. No PRNG state is stored, so the same name repeats
  // the same draws: a name must be unique within the match, e.g. `${kind}:${ev.seq}` for a draw
  // made by a scheduled event. With step invariants the kernel throws EngineBug when a name is
  // requested twice (an in-memory debug set per Match, not state; it starts empty after loadMatch).
  rng(stream: string): Rng;
  endMatch(result: MatchResult): void; // status = "ended"; nothing else is processed. The kernel emits match_ended
  // {reason, winners} itself (rulesets never emit it) and validates the result (schema, endedAt = now, known players).
}
export interface ActionHandler<A extends Action = Action, P = unknown> {
  validate(
    r: ReadCtx,
    seat: PlayerId,
    a: A,
  ): { ok: true; plan: P; warnings?: Violation[] } | { ok: false; violation: Violation };
  apply(ctx: Ctx, seat: PlayerId, plan: P): JsonObject; // tool-facing result data; cannot fail
}
export type EventHandler = (ctx: Ctx, ev: ScheduledEvent) => void;
export interface DomainModule {
  readonly actions: Readonly<Record<Exclude<Action["type"], "ext">, ActionHandler>>;
  readonly events: Readonly<Record<string, EventHandler>>; // build_done, recruit_done, proposal_expire, pact_expire
  readonly arrivals: Readonly<
    Record<"support" | "shipment" | "found" | "return", (ctx: Ctx, m: MovementId) => void>
  >;
  readonly invariants: readonly Invariant[]; // bloc invariants run only if the ruleset keeps propose/answer/leave
}
```

`validate` computes every number `apply` needs; `apply` trusts the plan. A thrown exception inside a handler is an engine bug: the match is aborted with a `fatal` log line. With `invariants: "step"`, the kernel deep-freezes the ruleset descriptor, `CompiledRules` and the config, so an accidental in-place sort of a shared table throws in tests.

### 5.3 Kernel API (`engine/src/kernel/match.ts`)

```ts
export type InvariantLevel = "off" | "checkpoint" | "step";
export interface MatchOptions {
  invariants?: InvariantLevel; // default "checkpoint"; tests use "step"
  traceHashes?: boolean; // full hash after every applied action (debugging only)
}
export function createMatch(
  setup: MatchSetup,
  ruleset: AnyRuleset,
  domain: DomainModule,
  opts?: MatchOptions,
): Match; // throws MatchConfigError (§3.6)
export function loadMatch(
  snap: Snapshot,
  ruleset: AnyRuleset,
  domain: DomainModule,
  opts?: MatchOptions,
): Match; // throws SnapshotMismatch
export interface Match {
  readonly setup: MatchSetup;
  readonly ruleset: AnyRuleset;
  readonly rules: DeepReadonly<CompiledRules>;
  readonly config: unknown;
  readonly configHash: Sha256;
  readonly rulesHash: Sha256;
  readonly now: GameTime;
  readonly ended: boolean;
  readonly result: MatchResult | null;
  read(): ReadCtx; // read-only view for the gateway; never hand it to agents
  nextEventTime(): GameTime | null; // null once ended
  advanceTo(t: GameTime): StepOutput; // t >= now, else EngineMisuse
  apply(seat: PlayerId, a: Action): ApplyOutput; // at the current `now`
  validate(seat: PlayerId, a: Action): Violation | null; // steps 1–3 of apply below, guarded alike; writes nothing
  hash(): Hash64; // FNV-1a 64 of canonical state
  snapshot(afterN: number): Snapshot; // a canonical copy, never a reference to the live state
  checkInvariants(level: "step" | "checkpoint"): void; // throws EngineBug
}
export interface StepOutput {
  events: DomainEvent[]; // copies (§6.6)
  checkpoints: { hour: number; t: GameTime; h: Hash64 }[];
}
export type ApplyOutput =
  | { ok: true; data: JsonObject; events: DomainEvent[]; warnings: Violation[]; h?: Hash64 } // copies
  | { ok: false; violation: Violation };
```

The top barrel exports the bound versions `createMatch(setup, ruleset, opts)`, `loadMatch(snap, ruleset, opts)` and `verifyLog(lines, opts)` with the domain module and the registry filled in. The testing kit (`@perfidia/engine/testing`, never the top barrel) adds `matchFromState(state, ruleset, {setup?, domain?})`, which wraps a hand-built state in a snapshot and loads it, and `testStep(match, edit)`, which runs `edit(ctx)` at `now`, then `afterStep({cause: {kind: "test"}, events})` and the step invariants (e.g. to edit alliance membership directly and watch domination react).

**Creation**: check `setup.ruleset === ruleset.ref`; resolve the config (§3.6); `compile(config, N)` and `rulesHash`; check `eventClasses` (every kind covered, `match_end` alone in its class); run `createWorld`; build players `p1..pN` and their private id counters; set public id counters from the largest ids; fill the ledger with the initial units; check the creation rules of §3.6; schedule the world's timers and `match_end` at `rules.time.matchEnd`; run the checkpoint invariants; then hash. That hash is the log's `initialHash`. Every failure here is a `MatchConfigError`.

**Loading**: `loadMatch` recomputes the config from `snap.setup` with `resolveConfig`, recompiles with N = `snap.setup.seats.length`, and checks that `snap.setup.ruleset`, `state.ruleset` and `ruleset.ref` are equal, that the recomputed `configHash` and `rulesHash` equal the snapshot's, that the state parses with the `GameState` schema and `state.ext` with `ruleset.extSchema`, and that the state hash equals `snap.hash`. Any mismatch throws `SnapshotMismatch` naming the field.

**`advanceTo(t)`**:

```
assert safeInt(t) and t >= now                      (EngineMisuse otherwise)
loop while status = running:
  ev = queue[0]; ck = (lastHour + 1) · 3600
  if ev and ev.at <= t and ev.at <= ck:             events at a boundary second come before its checkpoint
    remove ev; now = ev.at; dispatch(ev); afterStep; invariants("step")
  else if ck <= t:
    now = ck; record checkpoint {hour, t: ck, h: hash()}; invariants("checkpoint"); lastHour += 1
  else break
if status = running: now = t
```

- **Checkpoint H** is the state after every event with time ≤ 3600·H and before any action stamped 3600·H. The definition does not depend on the clock. `advanceTo(3600·H)` leaves the match exactly in checkpoint state H, which is where snapshots are taken (§10.3).
- Checkpoints are taken while the match runs. The `end` line carries the final hash. A 7-day match therefore has the initial hash, checkpoints 1–167 (the match ends at 604800 before checkpoint 168 is due) and the final hash.
- **Composability**: `advanceTo(a); advanceTo(b)` equals `advanceTo(b)` for `a ≤ b`, because handlers run at the event's own time (property P5).

**`apply(seat, a)`**:

1. Reject `MATCH_ENDED` if the match has ended or `now ≥ matchEnd`; reject `ELIMINATED` if the seat is out.
2. `ruleset.hooks.guard?.(r, seat, a)`; a violation rejects.
3. `handler = ruleset.hooks.actions?.[a.type] ?? domain.actions[a.type]`; with no handler (an `ext` action of a ruleset without one) reject `INVALID_ARGS`. `validate` (pure). A violation rejects; the state is untouched.
4. `apply`; `afterStep({cause: action, events})`; `invariants("step")`; optional trace hash. The result carries the validation warnings.

`validate(seat, a)` runs steps 1–3 only and returns the violation `apply` would return, or `null`. A throw in the guard or the handler's `validate` is an `EngineBug` there too. The gateway uses it to name the binding constraint of a `"max"` count that resolves to 0 (§7.4), so it never calls a ruleset hook outside the kernel's guard.

Engine errors fall into four classes: **player errors** are `Violation` data; **`MatchConfigError`** and **`SnapshotMismatch`** reject a setup or a snapshot before anything runs; **`EngineMisuse`** (a driver bug, e.g. time going backwards) and **`EngineBug`** (an invariant failure or a handler throwing) are thrown and abort the match.

### 5.4 Shared primitives (`engine/src/std`)

`std` is the shared game model every ruleset builds on. Derivations take a `ReadCtx` and never write; primitives take a `Ctx`.

```ts
// derive.ts
export function sortedIds<T extends string>(rec: Readonly<Record<T, unknown>>): T[];
export function stockAt(r: ReadCtx, city: CityId, t?: GameTime): Res; // whole units
export function rates(r: ReadCtx, city: CityId): Res; // per game hour
export function storageCap(r: ReadCtx, city: CityId): number;
export function popCap(r: ReadCtx, city: CityId): number;
export function popUsed(r: ReadCtx, city: CityId): number; // homed units anywhere + queued
export function unitsAtHome(r: ReadCtx, city: CityId, t?: GameTime): UnitCounts; // incl. trickle
export function affordableAt(r: ReadCtx, city: CityId, cost: Res): GameTime | null; // null = never
export function maxAffordable(r: ReadCtx, city: CityId, unitCost: Res): number;
export function travel(r: ReadCtx, from: IslandId, to: IslandId, g: TravelGroup): number; // via hook
export function freeSlots(r: ReadCtx, island: IslandId): number[];
export function citiesOf(r: ReadCtx, p: PlayerId): CityId[]; // sorted
export function relationsOf(r: ReadCtx, p: PlayerId): readonly Relation[]; // hooks.relations ?? defaultRelations
export function relation(r: ReadCtx, a: PlayerId, b: PlayerId): "self" | "ally" | "pact" | "none"; // via relationsOf
export function settlerK(r: ReadCtx, p: PlayerId): number; // cities + settlers owned
export function fallbackCity(r: ReadCtx, p: PlayerId): CityId | null; // lowest city number owned
export function queueEtas(r: ReadCtx, city: CityId): QueueEta[];
export function inFlightCargo(r: ReadCtx, origin: CityId): number; // shipments + returns of bounced shipments homed there
// stock.ts, units.ts
export function materialize(ctx: Ctx, city: CityId): void;
export function spend(ctx: Ctx, city: CityId, cost: Res): void;
export function addCapped(ctx: Ctx, city: CityId, res: Res): Res; // returns the amount lost
export function setLevel(ctx: Ctx, city: CityId, b: BuildingId, level: number): void;
export function spawnUnits(ctx: Ctx, city: CityId, units: UnitCounts): void; // ledger.made
export function takeHome(ctx: Ctx, city: CityId, units: UnitCounts): void; // for departures
export function removeUnits(
  ctx: Ctx,
  where: UnitSlot,
  units: UnitCounts,
  why: "killed" | "consumed" | "disbanded",
): void; // ledger.gone
// losses.ts
export function stackGroups(r: ReadCtx, city: CityId, owner: PlayerId | null): UnitSlot[]; // home first, then (home, role)
export function allocateLosses(groupSizes: readonly number[], loss: number): number[]; // largest remainder (ruleset §8.3)
// movement.ts
export function launch(ctx: Ctx, d: DepartureDraft, party: PlayerId | null): MovementId; // schedules, emits incoming_*
export function turnBack(ctx: Ctx, m: MovementId): void; // recall in window: home at now + max(1, now − departAt); max(minTravel, …) if the home is held (below)
export function startReturn(ctx: Ctx, spec: ReturnSpec): MovementId;
export function bounce(ctx: Ctx, m: MovementId): void;
export function deliverShipment(ctx: Ctx, m: MovementId): void; // adds capped; recipient copy with amounts, sender copy without (§8.6)
export function station(ctx: Ctx, city: CityId, g: Stationed): void; // merges by (owner, home, role)
export function unstation(
  ctx: Ctx,
  city: CityId,
  owner: PlayerId,
  home: CityId,
  units?: UnitCounts,
): UnitCounts;
// queues.ts
export function enqueueBuild(ctx: Ctx, city: CityId, b: BuildingId): BuildItem;
export function enqueueRecruit(ctx: Ctx, city: CityId, unit: UnitId, count: number): RecruitBatch;
export function completeBuild(ctx: Ctx, city: CityId, item: QueueItemId): void; // +1 on the current level, capped
export function cancelFrom(ctx: Ctx, city: CityId, item: QueueItemId): Res; // tail cancel per queues.refund, capped
export function removeQueueItems(
  ctx: Ctx,
  city: CityId,
  queue: QueueId,
  items: readonly QueueItemId[],
  refundPm: readonly number[],
): Res; // building block for cancel overrides
export function reflowQueue(ctx: Ctx, city: CityId, queue: QueueId): void; // close gaps, reschedule events
export function clearQueues(ctx: Ctx, city: CityId, refund: boolean): void; // never emits queue_empty (below)
// cities.ts
export function foundCity(
  ctx: Ctx,
  island: IslandId,
  owner: PlayerId,
  escort: UnitCounts,
  slot: number | null,
): CityId; // the requested slot if free, else the lowest free slot
export function transferCity(ctx: Ctx, city: CityId, to: PlayerId | null): void;
export function rehomeAll(ctx: Ctx, from: CityId, to: CityId): void; // returns heading to `from` sail on
export function disbandHomed(ctx: Ctx, city: CityId): void;
export function eliminate(ctx: Ctx, p: PlayerId): void; // units, movements, proposals, alliance, pacts
// diplomacy.ts
export const defaultRelations: (r: ReadCtx, p: PlayerId) => readonly Relation[]; // blocs and pacts
export function leaveAlliance(ctx: Ctx, p: PlayerId, cause: "left" | "betrayal" | "eliminated"): void;
export function endPact(
  ctx: Ctx,
  a: PlayerId,
  b: PlayerId,
  cause: "left" | "betrayal" | "expired" | "eliminated" | "superseded",
): void;
export function cancelProposalsOf(ctx: Ctx, p: PlayerId): void;
// visibility.ts, audience.ts
export const defaultVisibility: Visibility<unknown, unknown>; // perfidia-1 §12 semantics without sieges
export function defaultDeparture(r: ReadCtx, d: DepartureDraft): DepartureVerdict;
export function incomingAudience(r: ReadCtx, m: MovementId): Recipient[]; // one entry per player, roles by priority (§8.6)
// invariants.ts
export const stdInvariants: readonly Invariant[];
```

- `UnitSlot` is `{at: "home", city} | {at: "stationed", city, owner, home, role} | {at: "movement", id}`.
- **`queue_empty`** is emitted only by a completion (`build_done`, `recruit_done`) that empties a queue. `cancelFrom`, `removeQueueItems`, `reflowQueue` and `clearQueues` never emit it: the owner's own cancel needs no wake, and a siege or a conquest clearing the queues must not spend the victim's own wake budget (§8.5).
- **Returns into a held city.** A city is _held_ when a stationed group with `role: "hold"` of another player is in it (a `perfidia-1` siege garrison). A return into a held home will fight, so it is a hostile movement for the speed rule: `turnBack` makes it arrive at `now + max(time.minTravel, now − departAt)` instead of `now + max(1, now − departAt)`. Otherwise an in-window recall could land a homecoming battle seconds after the recall.
- **Relations.** `std`, `domain`, the gateway's presentation and the audience code decide "are a and b allies / pact partners" only through `relation`/`relationsOf`, never by reading `player.alliance` or `pacts` directly. A ruleset with another relation model (archipelago-classic's pairwise alliances) replaces `hooks.relations` and the `propose`/`answer`/`leave` handlers, and keeps the relation data in `ext`.
- The `domain` module (§15, T10) builds every default action and event handler from these primitives.

---

## 6. Determinism

### 6.1 Integer maths (`core/int.ts`)

- Integers only; `number` is safe because every product stays below 2⁵³ (`perfidia-1` §1.2 bounds them below 4·10⁹). `assertSafeInt` guards hot formulas in tests.
- Helpers: `floorDiv`, `ceilDiv(a, b)`, `rdiv(n, d)` (signed, half away from zero), `isqrt(n)` (`floor(Math.sqrt(n))` corrected by ±1 until exact), `clamp`, `mulDiv(a, b, c)` (asserts `a·b` is safe), and the square-law helpers `lossPm(L, W)` and `cas(n, q)` exactly as `perfidia-1` §1.2 defines them.
- **Only exactly specified maths.** ECMAScript leaves `Math.sin`, `cos`, `tan`, the inverse and hyperbolic functions, `exp`, `expm1`, `log*`, `cbrt`, `hypot`, `pow` and the `**` operator implementation-approximated, so Bun (JavaScriptCore) and a browser (V8) may disagree. Engine, protocol, gateway and bots use none of them (lint plus the source scan, §2.4); `Math.sqrt` is correctly rounded and is used only inside `isqrt`. Integer powers use a literal (`4294967296`) or `ipow(b, e)` (repeated multiplication, asserting a safe result). Rulesets use committed integer tables (`perfidia-1`: `SIN10K`, 901 entries, a code constant regenerated by a test, not a config field). A published ruleset that used an approximated function could never drop it (§3.5), hence the ban from day one.

### 6.2 PRNG (`core/prng.ts`)

- `mulberry32(state): Rng` exactly as `perfidia-1` §1.3, where `Rng = { nextU32(): number }` (§3.2); `fnv1a32(s)` over UTF-8 bytes (offset 2166136261, prime 16777619 via `Math.imul`, `>>> 0`).
- `streamRng(seed, name)` seeds mulberry32 with `fnv1a32` of the string `${seed}:${name}`. Streams are independent: adding a draw to one never shifts another.
- `randInt(rng, lo, hi) = lo + floor(u · (hi − lo + 1) / 2³²)` (asserts `hi − lo < 2²¹` so the product stays exact); `shuffle(rng, list)` is Fisher–Yates from the end with `j = randInt(0, i)`.
- Streams in use: `map`, `seats`, `tiebreak` (perfidia-1 world), `lockstep:<t>:<b>` (lockstep driver). No PRNG state is stored in `GameState`: combat, loot and spying are deterministic, and opaque ids come from a keyed permutation, not a stream (§4.1). A future ruleset that draws mid-match (map events, say) names each stream after the entity that draws, since a reused name repeats its draws (§5.2).

### 6.3 Canonical JSON and hashes (`core/canonical.ts`, `core/hash.ts`)

- **Canonical JSON**: object keys sorted by UTF-16 code unit, no whitespace, strings written with `JSON.stringify`, arrays in order, `undefined` properties omitted, and an error on `undefined` in arrays, on any number that is not a safe integer (floats, `NaN`, `±Infinity`; `-0` is written `0`), and on `Map`, `Set`, `Date`, BigInt or functions. A stray float is therefore caught at the next emitted event or checkpoint at the latest. Log lines are written with it too.
- **FNV-1a 64** over UTF-8 bytes (inline encoder; a lone surrogate becomes `EF BF BD`), offset `0xcbf29ce484222325`, prime `0x100000001b3 = 2⁴⁰ + 435`, computed on two uint32 halves without BigInt:

  ```
  lo = (lo ^ byte) >>> 0
  p  = lo * 435                                                  // < 2^41, exact
  hi = (hi * 435 + Math.floor(p / 4294967296) + ((lo << 8) >>> 0)) >>> 0
  lo = p >>> 0
  ```

  Vectors: `""` → `cbf29ce484222325`, `"a"` → `af63dc4c8601ec8c`, `"foobar"` → `85944171f73967e8`. It catches accidental divergence, not deliberate forgery, which is acceptable here.

- **SHA-256** (pure TypeScript, for the config and rules hashes and the ruleset fingerprints). Vectors: `""` → `e3b0c442…b855`, `"abc"` → `ba7816bf…15ad` (full vectors in the test).
- **State hash** = `fnv1a64(canonicalJson(state))`.

### 6.4 The event hash

`ctx.emit(e)` computes `s = canonicalJson({...e, t: now})` **once**, sets `state.evHash = fnv1a64(state.evHash + "\n" + s)`, and collects `JSON.parse(s)` for routing (deep-frozen when invariants are `"step"`). Since `evHash` is part of the state, every hourly checkpoint also verifies every message, report and notification emitted so far, though none of them is stored. Because the routed event is a copy of what was hashed, a handler that keeps mutating an object it passed to `emit` changes neither the log nor any archive. Initial `evHash` is `fnv1a64("")`.

### 6.5 Iteration order

1. Never let object key order decide anything: iterate records with `sortedIds` (the `compareIds` order), or the `CompiledRules` order for buildings, units and resources. A state loaded from a snapshot has a different insertion order than a live one (property P9).
2. State arrays are ordered by meaning (queues) or kept sorted (members, pacts, stationed groups).
3. Every `sort` takes a total comparator (lint `typescript/require-array-sort-compare` if oxlint has it, otherwise review).
4. No `Map`/`Set` in the state; allowed as local temporaries only when their order cannot reach a result.
5. No `localeCompare`, `Intl`, `toLocaleString`, `toLocaleUpperCase`, `toLocaleLowerCase`, `toFixed`, `toPrecision`, `toExponential` or `parseFloat` in engine, protocol, gateway or bots: text that is logged or compared must be locale-independent (lint, §2.4). Case-insensitive matching (archive search) folds ASCII `A–Z` only, and schemas use ASCII classes, never Unicode property escapes, so results do not depend on the runtime's Unicode tables.
6. No module-level mutable state in the engine, the gateway or the bots. Memoisation keyed by a `CompiledRules` object in a `WeakMap` is allowed; bot caches live in the bot instance (§11.1). No `WeakRef` or `FinalizationRegistry` (garbage-collector timing).

### 6.6 Boundary copies

Nothing that leaves the engine aliases engine state, and nothing that reaches an agent aliases gateway state. Otherwise a report that aliases a city's units would become a live view of a foreign city, a stored snapshot would track the live state, and an in-process agent could change the engine outside the log.

- `emit` routes a parsed copy of the hashed text (§6.4).
- `snapshot()` stores `JSON.parse(canonicalJson(state))`.
- `apply` returns `data` and `events` as copies; `advanceTo` returns copies of its events.
- Gateway views build fresh objects (§8.1). Every `ToolResult` and every `RoundInput` is a canonical round-trip copy before it reaches an agent.
- `LogSink.write` serialises the line at once (§8.7): what a sink holds can no longer change.
- Tests: after an `emit`, mutating the state leaves the logged line, the archive entry and the hash unchanged; P16 runs a chaos agent that mutates every object it receives and checks the state hash is unaffected.

---

## 7. Action pipeline and errors

### 7.1 Engine actions (`protocol/src/actions.ts`)

```ts
export type Action =
  | { type: "build"; city: CityId; building: BuildingId }
  | { type: "recruit"; city: CityId; unit: UnitId; count: number }
  | { type: "cancel_queue"; city: CityId; item: QueueItemId } // that item and every later item of its queue
  | { type: "send_resources"; from: CityId; to: CityId; res: Res }
  | { type: "attack"; from: CityId; to: CityId; units: UnitCounts }
  | { type: "support"; from: CityId; to: CityId; units: UnitCounts }
  | { type: "spy"; from: CityId; to: CityId; gold: number }
  | { type: "found_city"; from: CityId; island: IslandId; units: UnitCounts; slot: number | null }
  | { type: "recall"; movement: MovementId }
  | { type: "recall_stationed"; at: CityId; home: CityId | null; units: UnitCounts | null } // null units = whole group(s)
  | { type: "dismiss"; city: CityId; player: PlayerId }
  | { type: "send_message"; to: PlayerId[] | "all"; text: string }
  | {
      type: "propose";
      to: PlayerId;
      kind: "alliance" | "pact";
      name: string | null;
      text: string;
      until: GameTime | null;
    }
  | { type: "answer"; proposal: ProposalId; accept: boolean }
  | { type: "leave"; with: PlayerId | null } // null: leave my alliance; a player: end my relation with them
  | { type: "ext"; tool: string; args: Json };
```

- Messages and diplomacy go through the engine: they are world history, they must be ordered and logged, and they trigger wake-ups and betrayal detection. Message text is carried by the `message` event, not stored.
- `recall_stationed` with several groups of the seat in the city (one per home) and a unit list but no `home` is rejected with `AMBIGUOUS_GROUP`; the explanation lists the groups (home and units). `units: null` recalls the named group whole, or every group of the seat there.
- `leave` with `with` naming a pact partner ends that pact; naming an ally leaves the alliance (the default diplomacy module). A ruleset with pairwise relations interprets `with` as "end my relation with that player".

### 7.2 Layers

| #   | Layer                              | Where                                       | Rejects with (examples)                                                                                                                                                     | Logged as                  |
| --- | ---------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 1   | Turn gate                          | gateway runtime                             | `TURN_OVER` (after `end_turn` in the same round, or a closed turn), `ROUND_TRIP_CAP`, `CALLS_CAP` (calls beyond the per-round or per-wake cap), `MATCH_ENDED`, `ELIMINATED` | `gw` line                  |
| 2   | Schema                             | gateway runtime (`ToolSpec.args.safeParse`) | `INVALID_ARGS` with the Zod path and the expected shape; also an optional field the ruleset does not support (§3.7)                                                         | `gw`                       |
| 3   | Ids and visibility (fog)           | gateway runtime, via the seat's view        | `UNKNOWN_ID` (a hidden id reads exactly like a missing one), `NOT_OWNER`                                                                                                    | `gw`                       |
| 4   | Interface caps                     | gateway seat logic                          | `DAILY_CAP` (attacks, messages), `NOTE_TOO_LONG`                                                                                                                            | `gw`                       |
| 5   | Normalisation                      | gateway runtime                             | – (batch expansion; `"max"` counts resolved per item; `end_turn` times clamped; the log stores resolved numbers); a `"max"` item resolved to 0 fails (§7.4)                 | `gw` with `i` (that item)  |
| 6   | Authoritative validation and apply | engine (`guard`, then the handler)          | engine `Violation`s                                                                                                                                                         | `act` line with its result |

- **Fog-safe validation**: whether an engine action is valid may depend only on the actor's own state and public state. For example, a shipment to a full warehouse is accepted, and the overflow is reported on arrival to the recipient only (§8.6). Violation `details` contain only own or public facts; non-interference properties P10 and P15 check every code and event.
- **Gateway rejections never reach the engine** and are not replayed; their `gw` lines exist for statistics and for the `lastTurn` report (§8.2).

### 7.3 Error format, warnings and times

```ts
// protocol/src/violations.ts
export interface Violation {
  code: string; // a DomainErrorCode or a ruleset code
  details: Record<string, number | string | boolean | null>; // numbers and ids, no prose
}
// protocol/src/tools.ts
export type ToolResult =
  | { ok: true; t: GameTime; data: JsonObject; warnings?: { code: string; message: string }[] }
  | {
      ok: false;
      t: GameTime;
      code: string;
      message: string;
      hint: string;
      details?: Violation["details"];
    };
```

- **Every result carries `t`**, the game second at which the call was applied, so an agent always knows "now" in real time.
- **Domain codes** (closed enum in protocol): `INVALID_ARGS`, `UNKNOWN_ID`, `NOT_OWNER`, `TURN_OVER`, `ROUND_TRIP_CAP`, `CALLS_CAP`, `DAILY_CAP`, `MATCH_ENDED`, `ELIMINATED`, `NOTE_TOO_LONG`, `INSUFFICIENT_RESOURCES`, `EXCEEDS_STORAGE`, `INSUFFICIENT_POPULATION`, `REQUIREMENT_MISSING`, `MAX_LEVEL`, `QUEUE_FULL`, `QUEUE_ITEM`, `BATCH_LIMIT`, `INSUFFICIENT_UNITS`, `NO_UNITS`, `TRANSPORT_CAPACITY`, `SHIPMENT_CAPACITY`, `ATTACK_PROTECTION`, `INVALID_TARGET`, `NO_FREE_SLOT`, `SETTLER_REQUIRED`, `SPY_GOLD`, `NOT_RECALLABLE`, `NOTHING_STATIONED`, `AMBIGUOUS_GROUP`, `TEXT_TOO_LONG`, `PROPOSAL_LIMIT`, `PROPOSAL_NOT_FOUND`, `ALREADY_ALLIED`, `ALLIANCE_FULL`, `NOT_IN_ALLIANCE`, `PACT_LIMIT`, `PACT_NOT_FOUND`, `INTERNAL`. `perfidia-1` adds the violations `CITY_BESIEGED` and `NOT_BESIEGER`.
- **`INTERNAL`** is returned only by the gateway, when its own code throws unexpectedly before anything reached the engine: a read tool, a gateway tool (`write_note`, `read_notes`, `end_turn`), an extra read tool, or layers 1–5 of an engine tool (the turn gate included). The state is untouched, and a `gw` line records the call with `code: "INTERNAL"` and the error message (§10.2). In strict mode (tests) it is fatal. Anything thrown inside the engine (`validate`, `apply`, `advanceTo`, a ruleset hook) is never `INTERNAL`: it is an `EngineBug` and aborts the match with a `fatal` line (§5.3). The exit test counts `INTERNAL` `gw` lines and requires zero.
- **After the call changed something** (an engine action was submitted, a batch item's `gw` line was written, the notebook was rewritten or `end_turn` set the wake and ended the turn), a gateway throw is never `INTERNAL`, whose "nothing was applied" would be false and whose retry could apply an attack twice: it is a `HostFailure`, which aborts the match with a `fatal` line of kind `driver`. So that wording bugs cannot cause it, explanations given after such a change (an engine rejection, a batch item, a warning) fall back to the bare code as their message when their explainer throws, as `recordAct` does for `lastTurn`; a gateway line that was written but could not be recorded (`recordGw`) is a `HostFailure` too.
- **Warnings** are accepted actions with a caveat. Gateway warnings: `WAKE_CLAMPED` (`end_turn`, §8.3). Ruleset warnings come from `DepartureVerdict.warnings` or `validate`; `perfidia-1` emits `CAPITAL_IMMUNE` when an attack carrying settlers will land on a capital before t = 172800 ("a win will be a raid; the settlers come back").
- **Details conventions** (bots rely on them, never on prose): details are flat; resources use `need_wood`, `have_wood`, `rate_wood` (same for stone and gold); any time-gated rejection carries `availableAt` (game time, `null` = never); unit shortages carry `unit`, `requested`, `home` and, when units are away, `backAt`; `QUEUE_ITEM` carries `city`, `item`.
- **Wording**: `gateway/present/explain.ts` maps each domain code to `{message, hint}` with numbers and game times; ruleset codes and warnings use `ruleset.errors[code]`. Both receive the deterministic formatter `fmt: Fmt` from `core/format.ts`. For `QUEUE_ITEM`, the explainer looks up the seat's archive: "#12 of c14 completed at D3 14:02:10" or "c14 has no item #12; queued: #13, #14".
- **Times.** `fmtTime(t)` is `"D{floor(t / 86400) + 1} HH:MM"`, with `":SS"` appended when the seconds are not zero (`"D3 14:02:50"`). `fmtDuration(s)` prints days, then hours, minutes and seconds, omitting zero parts, with a space after the days: `0 → "0s"`, `45 → "45s"`, `7200 → "2h"`, `4800 → "1h20m"`, `4805 → "1h20m5s"`, `381480 → "4d 9h58m"`. No `Intl`. **Every time and duration shown to an agent** is a pair of the integer and its text: `"arrive": [226620, "D3 14:57"]`, `"left": [381480, "4d 9h58m"]`.

With 1210 gold exactly in stock (S = 1210 · 3600) at t = 223320 and +310 gold/h, the 290 missing gold arrive after `ceilDiv(290 · 3600, 310) = 3368` s, at t = 226688:

```json
{
  "ok": false,
  "t": 223320,
  "code": "INSUFFICIENT_RESOURCES",
  "message": "c12 needs 1500 gold for settler (k = 2), has 1210.",
  "hint": "At +310 gold/h it is affordable at D3 14:58:08 (in 56m8s).",
  "details": { "city": "c12", "need_gold": 1500, "have_gold": 1210, "availableAt": 226688 }
}
```

### 7.4 High-level actions

- `build(city, buildings[])` and `recruit(city, orders[])` expand to one engine action per item, applied as consecutive actions (consecutive `n` in the log), as `perfidia-1` §1.4 requires. Every item is attempted, and the result reports each item: `{ok: true, t, data: {items: [{ok: true, item: 7, building: "hall", level: 3, end: [7200, "D1 02:00"]}, {ok: false, code, message, hint}]}}`. The top-level `ok` is `false` only when layers 1–4 reject the whole call. Batches are not atomic; the `interface` block of the `rules` tool says so (§8.1).
- **`"max"` counts** are resolved for each item just before it is submitted, after the earlier items of the batch were applied, as the minimum of: affordable by current stock, free pop under the cap (queued pop included), the queue's `maxCount`, the unit's `maxPerOrder`, and nothing if the queue is full. If it resolves to 0, the item fails with the error of the binding constraint (the violation `Match.validate` gives a count of 1, §5.3) and no engine action is sent: a `gw` line with the item's index `i`, the code and its details records it, numbered in sequence with the batch's `act` lines, so the summary counts it and `lastTurn` lists it exactly as it lists the engine's rejection of the same order with an explicit count (§8.2, §10.2). The log stores the resolved count of every order that reached the engine.
- `recall_troops` has three modes, exactly one per call: `{movement}` → `recall`, `{stationedAt, home?, units?}` → `recall_stationed`, `{dismiss: {city, player}}` → `dismiss`. They are optional fields of one object (§3.7); a call naming no mode or two modes, or `home`/`units` without `stationedAt`, is `INVALID_ARGS`.
- Every success result carries the useful consequences: ids, queue item numbers, completion or arrival times (as pairs), and the cost paid.

---

## 8. Gateway

The gateway is the only way into a running match. It is pure and LLM-agnostic. Its parts:

- `seat/`: seat state, wake scheduler, caps, notes, archive, public feed;
- `clock/`: time sources and drivers (§9);
- `present/`: projection, briefing, explanations, `rules` payload;
- `runtime/`: tools, turn handles, `MatchHost`, `runMatch`, log sinks, `rebuildGatewayState`.

### 8.1 Projection: fog of war (`present/`)

Pure functions of `(match.read(), seat, gatewayState)` that always build fresh objects (never references into the state):

| Function                          | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `viewCity(r, seat, city, gw)`     | `cityAccess = "full"`: stock, rates, cap, pop, buildings, queues with item numbers and ETAs, units at home, stationed groups, visible incoming movements (with foe, launch and arrival times), `ext`. Otherwise public fields, the extras of `publicCity(r, seat, city)`, and the latest intel snapshot from the seat's archive (spy or battle report) with its age.                                                                                                                                  |
| `viewIsland(r, seat, island)`     | kind, coordinates, richness, slots and occupants, travel times from each own city for every `travelProbe`.                                                                                                                                                                                                                                                                                                                                                                                            |
| `viewMap(r, seat, fromCity?)`     | every island and city (public fields); with `fromCity`, travel time to every island for every `travelProbe`.                                                                                                                                                                                                                                                                                                                                                                                          |
| `viewPlayer(r, seat, player, gw)` | public profile: cities, score parts, `relations` (`[{player, kind, until}]` through `std.relationsOf`), `publicPlayer` extras, relation to the viewer. **On the seat itself**, a `private` section: every own movement (id, kind, from, to, units, cargo, launch, arrival, recallable until), every own stationed group abroad (city, role `support` or `hold`, home, units), settler `k` and the next settler cost, open proposals to and from the seat, today's counters and the pending self-wake. |
| `leaderboard(r)`                  | `ruleset.hooks.standings(r)` + each player's `relations` + `publicMatch` extras (countdowns, tie-break order).                                                                                                                                                                                                                                                                                                                                                                                        |
| `rulesInfo(match)`                | `{ruleset, title, configHash, rulesHash, interface, cheatSheet, config, rules, extraTools}` (below).                                                                                                                                                                                                                                                                                                                                                                                                  |

- Movements are shown according to `movementAccess`: `"own"` and `"full"` in full, `"incoming"` without composition (`perfidia-1`: id, origin city and owner, recorded foe, launch and arrival times, "turned back at t" when recalled). Launch and arrival times together reveal the pace; `perfidia-1`'s cheat sheet says so.
- **`rulesInfo`** carries:
  - `interface`: a gateway-owned text block, the same template for every ruleset and versioned with `ENGINE_VERSION`, rendered from `GatewayRules` and the tool semantics. It covers the wake classes and both budgets, the self-wake range (clamping, delay or absolute time, how it counts, that it stays pending, that `end_turn {}` keeps it and that giving both fields is an error), the safety wake, grouping and the urgent gap, the round-trip and call caps, batch non-atomicity, `"max"`, `end_turn` and `lastTurn`, the time pairs, opaque ids and queue item numbers.
  - `cheatSheet`: the ruleset's game rules only (`perfidia-1` §0).
  - `config`: the effective config. `rules`: the agent-relevant part of `CompiledRules`; engine-internal fields are left out or rendered compactly (`eventClasses` as the ordered list of same-second classes). **`rules.gateway` is kept whole**: every numeric `GatewayRules` field, the wake table and `publicOncePerDay`, as structured data; `interface` renders the same numbers as text for LLMs. Bots read caps only from `rules.gateway`, `RoundInput` and the briefing's `budget`, never by parsing `interface` (§11.1).
- **Size budgets** (tests): the `rules` payload ≤ 12,000 characters and `view_map` with `fromCity` ≤ 9,000 characters, for `perfidia-1` at N = 12. If a budget cannot be met, the task reports it with measurements instead of loosening it silently. **Measured on the merged presentation (T13), these budgets and the briefing's are not met**: `rules` is 18,783 characters (config 4,277, agent rules 7,801, cheat sheet 2,306, interface 4,082), `view_map` with `fromCity` is at most 8,325 at the start but 10,531–10,579 in a mid-game world of 37 cities, and a busy 3-city briefing is 2,505 (three incoming attacks) to 3,571 (full queues) characters. The tests pin these sizes; reaching the targets needs a decision here (drop or shorten a part of `rules`, such as the config the agent rules repeat in compiled form) or looser protocol schemas (`CityRowSchema`, `BriefingCitySchema`).

### 8.2 Briefing

`buildBriefing(r, seat, gw, wake): Briefing` is compact, deterministic JSON. Target: ≤ 2,400 characters for a 3-city seat **excluding `notes`** (≈ 600 tokens at 4 chars/token). `notes` is always included verbatim and is bounded by `notesMaxChars`. A test checks a fixture with the notebook full and several long messages.

```json
{
  "you": "p3",
  "t": 223320,
  "time": "D3 14:02",
  "left": [381480, "4d 9h58m"],
  "ruleset": "perfidia-1@1.0.0",
  "wake": { "urgent": true, "reasons": ["incoming_attack m0k4qz", "message g09xr2"] },
  "lastTurn": {
    "ended": "end_turn",
    "unseen": [
      {
        "tool": "attack",
        "code": "INSUFFICIENT_UNITS",
        "message": "c12 has 10 raiders at home, 60 requested."
      }
    ],
    "warnings": [],
    "nextWake": { "at": [230520, "D3 16:02"], "kind": "self" }
  },
  "cities": [
    {
      "id": "c12",
      "isl": "i7",
      "res": [1520, 800, 240],
      "rate": [180, 120, 40],
      "cap": 2040,
      "pop": [96, 118],
      "build": [{ "item": 21, "b": "barracks", "lvl": 2, "end": [227400, "D3 15:10"] }],
      "recruit": {
        "barracks": [{ "item": 22, "unit": "guard", "n": 20, "end": [230400, "D3 16:00"] }]
      },
      "units": { "guard": 40, "raider": 10 },
      "stationed": 1
    }
  ],
  "incoming": [
    {
      "id": "m0k4qz",
      "kind": "attack",
      "from": "c3",
      "by": "p2",
      "foe": "p3",
      "to": "c12",
      "depart": [221820, "D3 13:37"],
      "arrive": [226620, "D3 14:57"]
    }
  ],
  "moves": [{ "id": "m3f8ta", "kind": "support", "to": "c9", "arrive": [224400, "D3 14:20"] }],
  "msgs": [{ "id": "g09xr2", "from": "p5", "to": ["p3"], "text": "…" }],
  "proposals": [
    {
      "id": "q1c7hn",
      "from": "p6",
      "to": "p3",
      "kind": "pact",
      "name": null,
      "text": "…",
      "expires": [262800, "D4 01:00"]
    }
  ],
  "events": [{ "type": "queue_empty", "city": "c9", "queue": "build" }],
  "news": [{ "type": "alliance_left", "player": "p2", "alliance": "a1" }],
  "notes": "…",
  "budget": {
    "roundTrips": 8,
    "callsPerRoundTrip": 10,
    "ownWakesLeft": 7,
    "socialWakesLeft": 5,
    "selfWakeAt": [230520, "D3 16:02"],
    "attacksLeft": 20,
    "messagesLeft": 18
  },
  "ext": {
    "holding": [{ "city": "c20", "owner": "p6", "ends": [240000, "D3 18:40"] }],
    "countdowns": []
  }
}
```

- Resource arrays follow `wood, stone, gold`. Times and durations are pairs (§7.3).
- **Ruleset state.** Each city entry carries `ext`, the ruleset's `publicCity(r, seat, city)` extras, omitted when empty: for `perfidia-1`, a besieged own city shows `"ext": {"siege": {"by": "p2", "ends": [t, text]}}`, so an agent never plans a build or a shipment from it. The top-level `ext` is `visibility.briefing(r, seat)` (default `publicMatch(r)`): for `perfidia-1`, the sieges the seat holds as besieger (city, owner, end) and every running domination countdown. Both count in the 2,400-character budget.
- **Every** incoming attack is listed, with its recorded foe, whatever the truncation (`perfidia-1` §14.2).
- Other lists are truncated with a `"more"` count that names the exact call to dig further: `moves` → `view_player` on yourself; `msgs` → `read_notes {search: {scope: "mine", kinds: ["message"], since, before}}`; `news` → `read_notes {search: {scope: "public", since, before}}`; `events` → the same search of the event types left out. `before` is one past the readable number `e` of the newest entry left out, so the call lists exactly the entries left out, newest first, and none the briefing kept; past 20 hits its `more` pages on with `before` (§8.3). A time bound alone cannot do it: in lockstep every seat's turn at a second shares one `t`, and a burst of more than a page of entries in one second is the normal case.
- `proposals` lists **every** open proposal to and from the seat, with its text (taken from the seat's archive) and name.
- Player-authored text (message and proposal texts, alliance and city names) is a typed field, never part of the instructions; control characters are stripped. A message body is cut at 300 characters in the briefing (`"cut": true`); `read_notes {open: id}` returns the full text.
- `lastTurn` says how the previous turn ended (`end_turn`, `empty_round`, `round_cap`, `timeout`, `error`, `match_ended`, `eliminated`), lists the failed results the agent never saw (`unseen`: the last round's failures, batch items included, and calls rejected with `TURN_OVER` or `CALLS_CAP`), the warnings on accepted calls it never saw (`warnings`: those of the last round, `end_turn`'s `WAKE_CLAMPED` included, since no round follows the last one and the usual pattern is `[actions…, end_turn]` in one round trip), and gives the effective next wake. Repeated `TURN_OVER` and `CALLS_CAP` rejections are folded into one entry per code with a `count`, so the list stays bounded however many calls an agent sends.

### 8.3 Tools (`runtime/tools.ts`)

The registry has exactly the brief's 22 names (`TOOL_NAMES` in protocol, test-checked), plus any `ruleset.tools`.

| Family    | Tool               | Kind    | Arguments (Zod in `protocol/src/tools.ts`)                                                                                                   | Maps to                                   |
| --------- | ------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Observe   | `view_city`        | read    | `{city}`                                                                                                                                     | `viewCity`                                |
|           | `view_island`      | read    | `{island}`                                                                                                                                   | `viewIsland`                              |
|           | `view_map`         | read    | `{fromCity?}`                                                                                                                                | `viewMap`                                 |
|           | `view_player`      | read    | `{player}`                                                                                                                                   | `viewPlayer`                              |
|           | `leaderboard`      | read    | `{}`                                                                                                                                         | `leaderboard`                             |
|           | `rules`            | read    | `{}`                                                                                                                                         | `rulesInfo`                               |
| Economy   | `build`            | engine  | `{city, buildings: BuildingId[1..queue max]}`                                                                                                | N × `build`                               |
|           | `recruit`          | engine  | `{city, orders: [{unit, count: int ≥ 1 \| "max"}][1..5]}`                                                                                    | N × `recruit`                             |
|           | `cancel_queue`     | engine  | `{city, item}`                                                                                                                               | `cancel_queue`                            |
|           | `send_resources`   | engine  | `{from, to, wood?, stone?, gold?}`                                                                                                           | `send_resources`                          |
| Military  | `attack`           | engine  | `{from, to, units}`                                                                                                                          | `attack`                                  |
|           | `support`          | engine  | `{from, to, units}`                                                                                                                          | `support`                                 |
|           | `spy`              | engine  | `{from, to, gold}`                                                                                                                           | `spy`                                     |
|           | `recall_troops`    | engine  | `{movement?, stationedAt?, home?, units?, dismiss?: {city, player}}`, exactly one mode (§7.4)                                                | `recall` / `recall_stationed` / `dismiss` |
|           | `found_city`       | engine  | `{from, island, units, slot?}` (`slot` needs `toolOptions.foundSlot`)                                                                        | `found_city`                              |
| Diplomacy | `send_message`     | engine  | `{to: PlayerId[] \| "all", text}`                                                                                                            | `send_message`                            |
|           | `propose_alliance` | engine  | `{to, kind: "alliance" \| "pact", name?, text?, until?}` (`until` needs `toolOptions.pactUntil`)                                             | `propose`                                 |
|           | `answer_proposal`  | engine  | `{id, accept}`                                                                                                                               | `answer`                                  |
|           | `leave_alliance`   | engine  | `{with?}`                                                                                                                                    | `leave`                                   |
| Memory    | `write_note`       | gateway | `{text, mode: "append" \| "replace"}`                                                                                                        | seat notes                                |
|           | `read_notes`       | read    | `{search?: {scope?: "mine" \| "public" \| "all", text?, kinds?, with?, since?, until?, before?, limit? ≤ 20}, open?: MessageId \| ReportId}` | notes, archive and public feed            |
| Turn      | `end_turn`         | gateway | `{nextWakeIn?, wakeAt?}`, at most one (seconds ahead, or an absolute game time)                                                              | wake scheduler                            |

Every argument schema is one `z.object` (§3.7). The table's argument shapes are those of `protocol/src/tools.ts`; each converts with `z.toJSONSchema` to a root `type: "object"`.

**Turn rules** (all reported in the next briefing's `lastTurn`):

- A round runs its first `toolCallsPerRoundTrip` calls (and stops at `toolCallsPerWake` if set); the others are rejected with `CALLS_CAP`.
- `end_turn` ends the turn after its round. Calls placed after it in the same round are rejected with `TURN_OVER`.
- `end_turn` clamps the requested wake into `[now + selfWake.min, now + selfWake.max]` and returns `{wakeAt: [t, text], clamped}` with a `WAKE_CLAMPED` warning when it moved it. That result is never handed to the agent (no round follows the one that ends the turn), so the `turn` line records the clamp (`clamp: {requested, at}`) and the next briefing's `lastTurn.warnings` lists the warning; the rebuild regenerates it from the line. The self-wake stays pending until it fires or a later `end_turn` replaces it; an urgent or social wake in between does not consume it.
- `read_notes {search}` lists at most 20 hits, newest first; `before: e` keeps the entries whose readable number is below `e`, so a search with `more: true` continues with `before` set to the last hit's `e`. `read_notes {open}` returns the entry whole (a message body is never cut there), rendered like every view: player text with control characters stripped, times as pairs.
- `cancel_queue` returns `{city, removed, refund, lost}`: what was credited to the stock and what the storage cap cut from the refund (`perfidia-1` §4.3).
- `end_turn {}` ends the turn and keeps any pending self-wake unchanged (it returns the pending one, or `wakeAt: null`). Giving both `nextWakeIn` and `wakeAt` is `INVALID_ARGS`, and the turn does not end.
- A turn also ends on an empty round, at the round cap, on a timeout or error, or when the match ends.

```ts
export interface ToolSpec<A = unknown> {
  readonly name: string;
  readonly family: "observe" | "economy" | "military" | "diplomacy" | "memory" | "turn";
  readonly kind: "read" | "engine" | "gateway";
  readonly description: string; // gateway-owned, identical in every ruleset, versioned with ENGINE_VERSION
  readonly args: ZodType<A>; // a z.object (§3.7)
  handle(env: ToolEnv, args: A): ToolResult; // never throws on player input (fuzz test P12); INTERNAL otherwise (§7.3)
}
export interface ToolEnv {
  readonly match: Match;
  readonly seat: PlayerId;
  readonly gw: GatewayState;
  readonly gatewayRules: GatewayRules; // daily caps, self-wake range
  readonly turn: { index: number; round: number; call: number };
  submit(a: Action, i: number): ApplyOutput; // writes the `act` line; host routes events
  rejectItem(i: number, error: ToolError): void; // a batch item that never reached the engine ("max" = 0): its `gw` line with `i`
  note(mode: "append" | "replace", text: string): void; // the `note` line of an accepted write_note
  endTurn(wakeAt: GameTime | null): { at: GameTime; clamped: boolean } | null; // sets the self-wake (null keeps it), ends the turn after the round
}
// Every change of state a tool makes goes through submit, rejectItem, note or endTurn: invokeTool
// tracks them to tell INTERNAL (nothing changed) from a HostFailure (§7.3).
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject; // z.toJSONSchema(args): root type "object"
}
// The 22 tools in TOOL_NAMES order, then the ruleset's extras: for phase-2 MCP and function calling.
export function toolDefinitions(ruleset: AnyRuleset): ToolDefinition[];
```

Tool descriptions are agent-visible text owned by the gateway, so a snapshot test covers `toolDefinitions` for both rulesets, like the `interface` block (§13.6).

### 8.4 Caps, notes, archives and the public feed (`seat/`)

`GatewayRules` (in `CompiledRules.gateway`, so part of the hashed rules; `perfidia-1` §14.1):

```ts
export type WakeClass = "urgent" | "own" | "social";
export interface GatewayRules {
  roundTripsPerWake: number; // 8
  toolCallsPerRoundTrip: number; // 10
  toolCallsPerWake: number | null; // null: no per-wake cap (perfidia-1)
  ownWakesPerDay: number; // 12: self-wakes and own-activity triggers
  socialWakesPerDay: number; // 8: triggers caused by other players
  groupWindow: number; // 600 s
  urgentMinGap: number; // 600 s; < time.minTravel (checked)
  selfWake: { min: number; max: number }; // 600..43200 s ahead
  safetyWake: number; // 43200 s after the end of the last wake
  attackLaunchesPerDay: number; // 20 (counted on engine-accepted launches)
  messagesPerDay: number; // 20 (one call counts once)
  notesMaxChars: number; // 4000
  wake: Record<string, Partial<Record<Role | "public", WakeClass>>>; // event type -> class by role; absent = no wake
  publicOncePerDay: string[]; // event types whose public wake fires once per game day per data.key
}
```

```ts
export interface SeatState {
  readonly seat: PlayerId;
  alive: boolean;
  notes: string;
  inbox: Delivered[]; // addressed to the seat since its last briefing
  archive: Delivered[]; // everything ever addressed to the seat, append-only
  lastBriefingAt: GameTime;
  lastBriefingE: number; // gw.delivered at the last briefing: the seat's news is the feed after it
  wake: SeatWake;
  day: { index: number; ownWakes: number; socialWakes: number; attacks: number; messages: number };
  turns: number;
  lastTurn: LastTurn | null;
  turnFailures: TurnFailure[]; // failures of the turn in progress, for lastTurn.unseen
}
export interface GatewayState {
  readonly seats: Record<PlayerId, SeatState>;
  readonly feed: Delivered[]; // every public event, append-only; a seat's news = feed after lastBriefingE
  readonly onceKeys: Record<string, true>; // `${type}:${key}:${day}` already used by publicOncePerDay
  delivered: number; // running delivery number
}
export interface Delivered {
  readonly e: number; // delivery number, in ev-line order
  readonly event: DomainEvent;
}
export function createGatewayState(players: readonly PlayerId[]): GatewayState;
export function deliver(
  gw: GatewayState,
  events: readonly DomainEvent[],
  wake: WakeScheduler,
): void; // archive, inbox, feed; wake.ingest per role and "public"; player_eliminated → wake.eliminate
export function briefed(gw: GatewayState, seat: PlayerId, t: GameTime): void; // after the briefing: inbox emptied, news cursor moved
export function writeNote(
  s: SeatState,
  text: string,
  mode: "append" | "replace",
  max: number,
  t: GameTime, // the call's time, which every ToolResult carries
): ToolResult;
export function searchArchive(gw: GatewayState, seat: PlayerId, q: ArchiveQuery): ArchiveHit[]; // newest first by (t, e), ≤ 20
export function searchArchivePage(gw: GatewayState, seat: PlayerId, q: ArchiveQuery): ArchiveSearch; // {hits, more}: read_notes
export function recordAct(gw: GatewayState, line: ActLine, message: string | null): void; // daily counters, the turn's failures
export function recordGw(gw: GatewayState, line: GwLine, message: string): void; // the turn's failures
export function closeTurn(
  gw: GatewayState,
  wake: WakeScheduler,
  line: TurnLine,
): Pick<TurnLine, "selfAt" | "next">; // wake.end, selfAt, lastTurn
```

- The whole gateway state is JSON-serialisable and is not hashed. **Every change to it is driven by a logged line** (`ev`, `wake`, `act`, `gw`, `note`, `turn`, `defer`), through the same `seat/` functions the live host calls, so `rebuildGatewayState` (§10.5) can rebuild it from the log. The `ev` lines alone would not do: notes come from `note` lines, `selfAt` and `lastEnd` from `turn` lines, budgets and `lastUrgentStart` from `wake` lines, counters from `act` and `gw` lines, and the `lastTurn` failure messages need the engine re-run.
- Per-day counters are keyed by `floor(t / 86400)`.
- A seat's news (`unreadNews`) is the feed after the delivery number `lastBriefingE`, not after the time `lastBriefingAt` (a time cannot split the events of one second into those delivered before and after the briefing), and leaves out the events addressed to the seat, which its inbox already holds.
- `seatErrorText` words `DAILY_CAP`, `CALLS_CAP`, `ROUND_TRIP_CAP` and `NOTE_TOO_LONG` from the details a `gw` line keeps, so the rebuild regenerates the same `lastTurn` messages; `present/explain.ts` delegates to it for these codes.
- `write_note` over the limit fails with numbers: "note would be 4,340 chars, limit 4,000: remove 340 or use mode=replace".
- Archive search: `scope` `"mine"` (the seat's archive), `"public"` (the feed) or `"all"` (default; both, an event that is public and addressed to the seat appearing once). Case-insensitive substring over message text and a deterministic one-line summary of each event, filtered by kind, counterpart and time range; `open` returns one full entry by message or report id. No `Intl`.
- `Role` is `"self" | "target" | "ally" | "stationed" | "party"` (§8.6).

### 8.5 Wake-up scheduler (`seat/wake.ts`, pure)

```ts
export interface SeatWake {
  inTurn: boolean; // the only notion of "in flight" used by the drivers
  urgentAt: GameTime | null; // earliest undelivered urgent trigger
  urgentReasons: WakeReason[]; // reasons of the undelivered urgent triggers (they may outlive a wake, below)
  lastUrgentStart: GameTime | null; // start of the last wake that carried an urgent reason
  ownFirst: GameTime | null; // first undelivered own trigger (queue empty, own reports)
  socialFirst: GameTime | null; // first undelivered social trigger
  selfAt: GameTime | null; // requested self-wake; pending until it fires or is replaced
  lastEnd: GameTime; // end of the last turn (safety base)
  reasons: WakeReason[]; // own and social reasons, drained into the next briefing
  deferTo: GameTime | null; // no wake before this time (lockstep per-second cap); cleared at the next wake
}
export interface WakeScheduler {
  readonly rules: GatewayRules; // deliver reads publicOncePerDay here
  ingest(seat: PlayerId, ev: DomainEvent, role: Role | "public"): void;
  // now: the end_turn call's time, the base of the clamp range (in real time it is neither lastEnd nor the wake time)
  requestSelfWake(seat: PlayerId, at: GameTime, now: GameTime): { at: GameTime; clamped: boolean };
  nextWakeTime(): GameTime | null; // idle seats only
  due(t: GameTime): PlayerId[]; // idle, alive, wake time <= t; sorted by player number
  peek(seat: PlayerId): { at: GameTime; kind: WakeKind | "start" } | null; // the effective next wake (turn.next, lastTurn.nextWake)
  begin(seat: PlayerId, t: GameTime): WakeRecord; // {reasons, urgent, charge: "own" | "social" | null, day, used}
  end(seat: PlayerId, t: GameTime): void; // clears inTurn synchronously
  defer(seat: PlayerId, to: GameTime): void; // lockstep per-second turn cap
  eliminate(seat: PlayerId): void;
}
```

The wake time of an **idle** seat is the minimum of:

- **urgent**: `max(urgentAt, lastUrgentStart + urgentMinGap)` (exempt from both budgets);
- **own**: `min(ownFirst + groupWindow, selfAt)`, moved to the start of the next game day while that day's own allowance is used up (repeat as needed);
- **social**: `socialFirst + groupWindow`, moved likewise while the day's social allowance is used up;
- **safety**: `lastEnd + safetyWake` (exempt).

Rules:

- **Start**: every seat wakes at t = 0 (exempt).
- **One turn at a time.** A seat in a turn has no wake time: `nextWakeTime()` and `due()` ignore it, so the drivers never spin on it. Triggers that arrive during a turn wait for its end.
- **`end(seat, t)`** clears `inTurn` and sets `lastEnd = t`. The own, social and safety times are then at least `t + 1`: a normal trigger that arrived during a long real-time turn wakes the seat at `max(first + groupWindow, t + 1)`. An urgent trigger pending at the end wakes the seat as soon as its gap allows, possibly at `t` itself.
- **`begin(seat, t)`** drains every pending reason (urgent, own, social, safety, start), except a self-wake still in the future and an urgent reason still inside its `urgentMinGap`: such an urgent trigger stays pending through an earlier non-urgent wake and fires at the end of its gap, which keeps the gap rule and the urgent-timing property below (every briefing still lists every incoming attack). The wake is charged to no budget if it carries an urgent, safety or start reason; otherwise to the own budget if an own reason was due, else to the social budget. A wake with an urgent reason sets `lastUrgentStart = t`.
- **Classification**: `rules.wake[event.type][role]`; no entry means no wake (inbox or news only). `perfidia-1` (§14.2): urgent for `incoming_attack` (party), `siege_started` (target, ally), `city_conquered` (target), `betrayal` (target), `domination_started` (public, once per bloc per game day); own for `queue_empty` (self), `battle_report` (self), `spy_report` (self), `spy_failed` (self); social for `message`, `proposal`, `proposal_answered` (target), `battle_report` (target, stationed, party), `spy_detected` (target), `incoming_attack` (target, ally, stationed). Public messages never wake.
- **Properties** (P11, model test with `fc.commands`):
  - per seat and game day, at most `ownWakesPerDay` own-charged and `socialWakesPerDay` social-charged wakes;
  - no sequence of other seats' actions produces an own-charged wake, so other players can never reduce a seat's own wakes;
  - no alive seat goes more than `safetyWake` without a wake while the match runs;
  - an urgent trigger wakes the seat at `max(its time, the end of the seat's turn, lastUrgentStart + urgentMinGap)`;
  - at most `ceil(86400 / urgentMinGap) + 1` urgent wakes per seat per game day;
  - triggers of one class inside a group window produce one wake;
  - after a turn ending at `t`, the next wake is `> t` unless an urgent trigger is pending and its gap has passed;
  - a turn that ends without a self-wake request (`end_turn {}`, an empty round, the round cap) leaves a pending `selfAt` unchanged.

### 8.6 Event envelope and audiences (`protocol/src/events.ts`)

```ts
export interface DomainEvent {
  t: GameTime;
  type: string;
  public: boolean; // in everyone's news feed
  to: Recipient[]; // seats addressed with a role (wake rules, archive); one entry per player
  data: JsonObject;
}
export interface Recipient {
  p: PlayerId;
  as: "self" | "target" | "ally" | "stationed" | "party";
}
```

- **Audiences are computed when the event happens**, by the engine (std helpers and rulesets), using the ruleset's visibility and relations, because relations can change within a second. The gateway applies the same hooks to project current state. Fog of war is therefore one policy, the ruleset's, used in two places.
- **Roles.** `self`: the actor, or the owner of the queue, movement or report concerned. `party`: the recorded foe or party of a movement (for an attack on a city: its owner, or the besieger for a relief or homecoming). `target`: the owner of the city concerned when it is not the party. `stationed`: owners of groups stationed there. `ally`: allies of the target. A player appears once, with the first role in the order party, self, target, stationed, ally.
- **Per-recipient payloads.** An event whose content differs by audience is emitted once per audience, each copy addressed only to its recipients. Sender copies never carry data the sender could not see: `shipment_delivered` goes to the recipient with the amounts and any overflow lost, and to the sender as `{movement, to, outcome: "delivered"}` only; `support_arrived` tells the sender only that its group is stationed; `bounced` gives the mover the movement and the public reason.
- **Standard event types** keep one name and data shape in every ruleset, so summaries, the gateway and the future spectator view work across rulesets: `build_done`, `recruit_done`, `queue_empty`, `incoming_attack` (`{movement, from, by, foe, to, departAt, arriveAt, homecoming}`), `incoming_support`, `incoming_shipment`, `movement_recalled`, `support_arrived`, `shipment_delivered`, `bounced`, `returned`, `city_founded`, `message`, `proposal`, `proposal_answered`, `proposal_expired`, `alliance_formed`, `alliance_joined`, `alliance_left`, `alliance_dissolved`, `pact_signed`, `pact_renewed`, `pact_ended` (cause `left`, `betrayal`, `eliminated` or `superseded`), `pact_expired`, `battle` (headline `{city, attacker, defender, kind, winner}`), `battle_report`, `spy_report`, `spy_failed`, `spy_detected`, `city_conquered` (`{city, from, to}`), `player_eliminated`, `betrayal` (`{by, against, relation, city}`), `match_ended`. A ruleset whose battles are not public still emits `battle`, with `public: false`. Rulesets add their own types, each declared in `eventSchemas` (`perfidia-1`: `siege_started`, `siege_broken`, `domination_started`, `domination_cancelled`; `sandbox-1`: `city_renamed`).
- **Checked emission.** A kernel step invariant checks every emitted event: its type is in `STANDARD_EVENT_TYPES` or in `keys(ruleset.eventSchemas)`, and its data parses with the matching schema. Every test, and the exit runs at checkpoint level, therefore catch a ruleset that emits `captured` instead of `city_conquered` or a `battle` without `winner`, which would otherwise show zero conquests in the batch table.
- **Intel events.** `INTEL_EVENT_TYPES` (protocol) lists the **standard** events whose payload depends on hidden data by design: `battle`, `battle_report`, `spy_report`, `spy_failed`, `spy_detected`, `city_conquered`, `player_eliminated`, `betrayal`. A ruleset declares its own in `Ruleset.intelEvents`, a subset of its `eventSchemas` keys checked by the registry (`perfidia-1`: `siege_started`, `siege_broken`), so protocol never names a ruleset event. Every other event type must pass the transition non-interference property P15.
- Reports are emitted **per recipient**, already redacted by the ruleset (`perfidia-1` §8.10: the attacker's copy shows only the outcome when no attacker survived).

### 8.7 Runtime: `MatchHost` and `runMatch` (`runtime/`)

`MatchHost` implements `ClockHost` (§9.1): it owns the engine `Match`, the gateway state, the wake scheduler, the tool registry and the log sink. `advanceTo` runs the engine step (split at snapshot hours, §10.3), delivers the events (§8.4), writes `ev` and `ckpt` lines and snapshots; `openTurn` applies any due hand-off (writing a `controller` line), asks the scheduler, builds the briefing and writes the `wake` line; `TurnHandle.execute` runs the turn rules of §8.3, each call's `ToolSpec` and the `act`/`gw`/`obs`/`note` lines; `close` writes the `turn` line; `defer` writes a `defer` line. Every result handed to an agent is a copy (§6.6).

```ts
export interface LogSink {
  write(line: LogLine): void; // synchronous; serialises the line at once (canonical JSON)
  snapshot?(snap: Snapshot): void; // serialises at once
  flush?(): void; // called after each step that wrote ckpt lines, after the end line and after a fatal line (§10.1)
}
export class MemorySink implements LogSink {
  readonly lines: string[]; // canonical JSON text, one per line, byte-identical to the file sink
  readonly snapshots: string[];
  parsed(): LogLine[];
}
export interface RunMatchOptions {
  setup: MatchSetup;
  ruleset: AnyRuleset; // resolved by the caller through the registry; must equal setup.ruleset
  agents: ReadonlyMap<PlayerId, SeatAgent>;
  clock:
    | {
        kind: "lockstep";
        maxTurnsPerSecond?: number; // default 3
        roundTimeoutMs?: number; // optional; needs `time`; recorded in the header
        time?: TimeSource;
      }
    | {
        kind: "realtime";
        speed: { num: number; den: number };
        time: TimeSource;
        timeKind: "virtual" | "system"; // recorded in the header
        latencyMs?: [number, number]; // recorded for Level G
        turnTimeoutMs?: number;
      };
  sink: LogSink;
  // A seat handed to another controller (the brief: a seat out of budget goes to a scripted bot).
  // Applied when the seat's first turn at or after `at` opens; the host writes a `controller` line.
  handoffs?: readonly { seat: PlayerId; at: GameTime; label: string; agent: SeatAgent }[];
  wall?: { nowMs(): number; iso(): string }; // injected by sim (SystemTime); absent in tests: no wall* keys
  invariants?: InvariantLevel; // default "checkpoint"
  snapshotEvery?: number; // game hours; default 24; 0 = final only
  strict?: boolean; // agent errors are fatal (tests)
}
export interface RunStats {
  turns: number;
  calls: number;
  engineEvents: number;
  wakes: Record<
    PlayerId,
    {
      urgent: number;
      own: number;
      social: number;
      safety: number;
      start: number;
      deferred: number;
    }[]
  >; // per game day
  lagMaxMs: number; // real time only
}
export function runMatch(
  o: RunMatchOptions,
): Promise<{ result: MatchResult; finalHash: Hash64; stats: RunStats; gateway: GatewayState }>; // gateway: a copy of the final live state (rebuild test, §10.5)
```

- `MatchHost` lives in gateway sources, where `Date` and `performance` are banned: it gets wall-clock values only through `wall`, and lockstep turn durations only through the optional `time`.
- On an `EngineBug`, `EngineMisuse`, `HostFailure` (a sink that failed, or a gateway throw after the call changed something, §7.3) or (strict) agent error or `INTERNAL`, the host writes a `fatal` line, flushes and rethrows. A `MatchConfigError` is thrown before the header line is written.

---

## 9. Clocks

### 9.1 Interfaces

```ts
// protocol/src/agent.ts (type-only)
export interface RoundInput {
  seat: PlayerId;
  turn: number;
  round: number; // 0-based
  maxRounds: number;
  maxCalls: number; // this round's call cap
  briefing: Briefing; // the same object every round of the turn
  results: ToolResult[]; // results of the previous round's calls ([] in round 0)
}
export interface RoundOutput {
  calls: ToolCall[]; // [] ends the turn
  thought?: string; // the last one becomes the turn's public thought
}
export interface SeatAgent {
  readonly label: string; // "bot:expander@1"
  round(input: RoundInput): Promise<RoundOutput>;
}
export interface Sleep {
  readonly done: Promise<void>;
  cancel(): void; // the timer is removed; `done` never settles
}
export interface TimeSource {
  nowMs(): number; // integer, monotonic
  sleepUntil(ms: number): Sleep;
}
// gateway/src/clock/types.ts
export interface ClockHost {
  readonly seed: number;
  readonly endsAt: GameTime;
  now(): GameTime;
  ended(): boolean;
  start(): void; // header line, advanceTo(0)
  advanceTo(t: GameTime): void; // engine step, event delivery, ev/ckpt lines, snapshots
  nextTime(): GameTime | null; // min(next engine event, next idle seat's wake); null when ended
  dueSeats(t: GameTime): PlayerId[]; // idle seats only
  openTurn(seat: PlayerId): TurnHandle; // wake line + briefing at now(); the seat is in a turn
  logBatch(t: GameTime, b: number, order: readonly PlayerId[]): void;
  defer(seat: PlayerId, to: GameTime): void;
  finish(): MatchResult; // end line
}
export interface TurnHandle {
  readonly seat: PlayerId;
  readonly done: boolean; // end_turn, empty round, round cap, match ended, seat eliminated
  input(): RoundInput;
  // Synchronous: applies the calls at host.now(), in order. Never called after end_turn, an empty round
  // or the round cap; called once more when `done` became true while the agent thought (the match ended
  // or the seat was eliminated): the host then answers each call MATCH_ENDED or ELIMINATED.
  execute(out: RoundOutput): void;
  // turn line, then wake.end (clears inTurn synchronously). `failure` = {error, cause: "error" | "timeout"}
  // when an agent failure closes the turn: its cause becomes the turn line's `why`, so a timeout is logged
  // as `timeout`; without it the host derives `why` from the turn's state.
  close(failure?: AgentFailure): void;
}
export interface AgentFailure {
  readonly error: string; // one deterministic line, no stack
  readonly cause: "error" | "timeout";
}
export interface ClockDriver {
  run(host: ClockHost, agents: ReadonlyMap<PlayerId, SeatAgent>): Promise<MatchResult>;
}
```

`TurnHandle.execute` is synchronous: a round's calls are a critical section with respect to the JavaScript event loop, so real time needs no mutex, and the log order is the application order. Every timer a driver starts and no longer needs is cancelled, so no stale timer keeps a process alive or makes virtual time jump to a dead deadline.

### 9.2 Lockstep (`clock/lockstep.ts`)

Game time jumps from one due time to the next and stands still while agents think. All seats woken at second `t` play their rounds **together**; batch `b` is one round of every open turn.

```
host.start()
while not host.ended():
  t = host.nextTime(); if t is null: break
  host.advanceTo(t)
  open = []; b = 0; turns = {}
  loop:
    for seat in host.dueSeats(t) not open and turns[seat] < maxTurnsPerSecond: open += host.openTurn(seat); turns[seat] += 1
    if open is empty: break
    outs = await allSettled(open.map(h => roundWithTimeout(agents[h.seat], h.input())))
    for each rejected or timed-out seat: close its handle with the error (fatal in strict mode); drop it
    acting = seats of open whose output has ≥ 1 call, sorted by player number
    order = shuffle(acting, streamRng(seed, `lockstep:${t}:${b}`))
    host.logBatch(t, b, order)
    for seat in order: handle(seat).execute(out(seat))          each seat keeps its own call order
    for idle handles: execute([])                                 an empty round ends the turn
    close every done handle; b += 1
  for seat in host.dueSeats(t): host.defer(seat, t + 1)          per-second turn cap (default 3)
host.finish()
```

- `allSettled`: one agent that throws never loses the other seats' outputs or crashes the driver. Its turn closes with the error recorded in the `turn` line.
- `roundTimeoutMs` (optional, recorded in the header) bounds a hung agent: its round counts as failed and a late answer is ignored. It needs the clock's `time`; bots never hit it, so Level G stays reproducible.
- Reads in batch `b` see every write of batches `< b` and the writes of seats earlier in batch `b`'s order.
- An urgent wake caused at `t` (A attacks idle B) opens B's turn in the next batch at the same `t`, unless B's urgent gap is still running.
- Termination: after the inner loop, every seat still due at `t` is deferred, so `nextTime() > t`.
- Phase 2 benefits directly: LLM seats woken at the same second think in parallel, one round at a time.

### 9.3 Real time (`clock/realtime.ts`)

Game time follows wall time at `speed = num/den` game-seconds per wall-second; seats act asynchronously, and an action takes effect at the game second when it is received.

```
gameAt(ms) = min(endsAt, floor((ms − wall0) · num / (1000 · den)))
wallAt(g)  = wall0 + ceilDiv(g · 1000 · den, num)    gameAt(wallAt(g)) = g while speed ≤ 1000 (a game second lasts ≥ 1 ms);
                                                     faster, one ms spans several game seconds and gameAt(wallAt(g)) ≥ g

host.start(); wall0 = time.nowMs()
while not host.ended():
  host.advanceTo(max(host.now(), gameAt(time.nowMs())))
  for seat in host.dueSeats(host.now()): start runTurn(seat)                     (not awaited; dueSeats skips seats in a turn)
  next = host.nextTime()                                                          (idle seats and engine events only)
  sleep = time.sleepUntil(wallAt(max(next, host.now() + 1)))
  await race(sleep.done, kick.wait()); sleep.cancel()
await all in-flight turns; host.finish()

runTurn(seat):
  h = host.openTurn(seat)
  while not h.done:
    out = await roundWithTimeout(agents[seat], h.input())                        think time elapses here
    host.advanceTo(max(host.now(), gameAt(time.nowMs())))
    h.execute(out); kick.notify()                                                an action may make another seat due earlier
  h.close(); kick.notify()                                                       close() clears inTurn before the notify
```

- **Waking the loop.** The loop sleeps until the next wake it knows of. An action can make an idle seat due earlier (A attacks B: an urgent wake for B at once; A messages B: a social wake 600 s later), so every `execute` notifies `kick`, and the loop recomputes `next`. B's turn therefore opens at the game second of the trigger (± one loop iteration), not when A's turn ends.
- **No spinning.** Seats in a turn have no wake time (§8.5), and the loop never sleeps until a time `≤ now`, so a trigger that arrives during a long turn cannot make the loop busy-wait or, under `VirtualTime`, starve the agents' own timers.
- Same-second actions are applied in receipt order through the synchronous critical section, as `perfidia-1` §1.4 requires; replay never needs that order to be reproducible, because the log records it.
- Lag: if the loop falls behind, game time jumps; events still resolve at their own timestamps, actions land at `now`. The driver records the lag in its stats.
- After the match ends, in-flight turns receive `MATCH_ENDED` for further calls and finish within their round cap; `turnTimeoutMs` bounds runaway agents (the timer is cancelled when the round answers).
- `Signal` (`kick`) is level-triggered so no notification is lost.

### 9.4 Time sources and fast real-time tests

- **`VirtualTime`** (`clock/virtual.ts`, pure): implements `TimeSource` with timers ordered by `(ms, insertion seq)`; `cancel()` removes a timer. `run(main)` loops: `await yieldMacrotask()` (injected; the `sim` harness passes `() => new Promise(r => setImmediate(r))`), return if `main` settled, otherwise jump `nowMs` to the earliest timer and resolve it. One macrotask yield drains every microtask chain, so in-process agents interleave deterministically. If `main` is pending with no timer left, it throws `VirtualTimeDeadlock` (an agent awaited something virtual time does not drive, such as real I/O). Several matches may each run their own `VirtualTime` in one process (§13.4).
- **`SystemTime`** (`sim/src/harness/time.ts`, with the `VirtualTime` wiring): `Math.floor(performance.now())` and a cancellable `setTimeout`. Used for smoke runs at very high speed (e.g. 100800×: 7 game days in about 6 s).
- **Bots in real time** are wrapped by `withThinkTime(agent, {time, latencyMs, seed})` (bots package): each round sleeps a seeded latency (e.g. 2–60 s of wall time), so turns span game time and seats overlap. Under `VirtualTime` a 7-day match at speed 3 runs in seconds and is reproducible (Level G); under `SystemTime` it is not reproducible, but Level E must pass, which proves the log captures real async interleavings.
- Driver tests use a scripted `FakeHost`. The game-to-wall mapping is monotone and `gameAt(wallAt(g)) = g` for speeds up to 1000 game-seconds per wall-second (property; above that a wall millisecond spans several game seconds and `gameAt(wallAt(g)) ≥ g`, so a wake can open a few game seconds late, e.g. up to 100 at 100800×); interleavings of a small scenario are explored with `fc.scheduler` (every round resolves once, log order is consistent, replay passes).

### 9.5 Why both clocks replay identically

Every state change goes through `advanceTo` or `apply`, both synchronous and deterministic given the state and their arguments. The host writes log lines in the order it calls them, and checkpoints come from inside `advanceTo`. Replay calls `advanceTo(line.t)` then `apply` for each `act` line in `n` order. By composability (§5.3) and the same-second rule, it reproduces every checkpoint. The clock only decides **which** `(t, n, action)` tuples exist, never how they are interpreted.

---

## 10. Match log, snapshots and replay

### 10.1 Run directory

```
runs/<name>/
  match.jsonl           authoritative, append-only, one canonical JSON object per line
  snapshots/h0024.json  at checkpoint hours (every --snapshot-every game hours, default 24) plus the final state
  summary.json          §12.2
```

`LogSink` is synchronous (`write(line)`, `snapshot(snap)`, `flush()`) and serialises at `write`: the file sink buffers the text and appends it at each `flush`, and the host calls `flush` after every engine step that wrote `ckpt` lines (so before that hour's snapshot), after the `end` line (before the final snapshot) and after a `fatal` line. A killed run therefore keeps its log up to its last checkpoint, and no snapshot file exists without its `ckpt` line on disk. `MemorySink` keeps the same text in an array for tests, so a golden built in memory is byte-identical to a CLI file.

### 10.2 Line kinds (`protocol/src/log.ts`)

Keys starting with `wall` are informational, present only when the host has a `wall` source, and excluded from byte-for-byte comparisons. One example of each kind (not a chronological excerpt):

```jsonc
{"k":"header","format":"perfidia-log/1","engine":"0.1.0","setup":{"ruleset":"perfidia-1@1.0.0","overrides":{"time.dominationStart":604801},"seed":42,"idKey":"<32 hex>","seats":[{"id":"p1"}]},
 "config":{ /* effective config */ },"configHash":"<sha256>","rulesHash":"<sha256>","controllers":{"p1":"bot:expander@1"},
 "clock":{"kind":"lockstep","maxTurnsPerSecond":3} | {"kind":"realtime","speed":[3,1],"time":"virtual","latencyMs":[2000,60000]},
 "initialHash":"<fnv64>","wallStart":"2026-10-10T12:00:00Z"}
{"k":"wake","t":0,"seat":"p3","turn":1,"reasons":["start"],"urgent":false,"charge":null,"day":0,"used":{"own":0,"social":0}}
{"k":"batch","t":0,"b":0,"order":["p3","p1","p2"]}
{"k":"act","n":17,"t":0,"seat":"p3","turn":1,"rt":0,"tool":"build","i":0,"a":{"type":"build","city":"c3","building":"hall"},"r":{"ok":true}}
{"k":"act","n":18,"t":0,"seat":"p3","turn":1,"rt":0,"tool":"build","i":1,"a":{"type":"build","city":"c3","building":"barracks"},"r":{"ok":false,"code":"REQUIREMENT_MISSING"}}
{"k":"gw","n":19,"t":0,"seat":"p3","turn":1,"rt":0,"tool":"attack","r":{"ok":false,"code":"DAILY_CAP","details":{"cap":20,"used":20}}}
{"k":"gw","n":20,"t":0,"seat":"p3","turn":1,"rt":0,"tool":"view_city","r":{"ok":false,"code":"INTERNAL"},"error":"…"}
{"k":"obs","n":21,"t":0,"seat":"p3","turn":1,"rt":1,"tool":"view_city","args":{"city":"c3"},"bytes":812}
{"k":"note","n":22,"t":0,"seat":"p3","turn":1,"mode":"replace","text":"…"}
{"k":"turn","t":0,"seat":"p3","turn":1,"rounds":3,"calls":9,"why":"end_turn","selfAt":7200,"next":{"at":7200,"kind":"self"},"thought":"…","wallMs":12}
{"k":"defer","t":5400,"seat":"p4","to":5401}
{"k":"controller","t":43200,"seat":"p2","label":"bot:turtle@1"}
{"k":"ev","t":5400,"e":{ /* DomainEvent */ }}
{"k":"ckpt","t":3600,"hour":1,"h":"<fnv64>"}
{"k":"end","t":604800,"h":"<fnv64>","result":{ /* MatchResult */ }}
{"k":"fatal","t":5400,"error":{"kind":"invariant"|"engine"|"driver"|"agent","message":"…","details":{}}}
```

- `n` is a global sequence over `act`, `gw`, `obs` and `note` lines, without gaps: Level E requires each to be one more than the previous (from a snapshot, one more than its `afterN`), so a lost `gw`, `obs` or `note` line, or a rejected `act` line, none of which changes an engine hash, is an `order` divergence at the next `n`. `act` lines exist exactly for calls that reached the engine, accepted or rejected; `i` is the item index of an expanded batch. A `gw` line records a call rejected by the gateway (layers 1–4 of §7.2, with the `details` its explanation needs), an `INTERNAL` failure (with `error`), or, with the item index `i`, a batch item the gateway failed before it reached the engine (a `"max"` count resolved to 0, §7.4), in sequence with the batch's `act` lines.
- Every engine event gets an `ev` line (needed by summaries, the gateway rebuild and the future spectator view; covered by `evHash`). The batch line records the seeded lockstep order (§9.2).
- `turn.selfAt` is the self-wake pending after the turn (or `null`); `next` is the effective next wake, which may be an earlier urgent or social one. `defer` records a seat moved to `to` by the lockstep per-second turn cap. `controller` records a hand-off (§8.7); the header's `controllers` are the controllers at t = 0.
- **Line order.** The host writes lines in the order it changes state: an `act` line comes before the `ev` lines of the events its action emitted; the `ev` and `ckpt` lines produced by `advanceTo(t)` come before the next `act`, `wake`, `batch`, `defer` or `controller` line stamped `t`; a `ckpt` line follows the `ev` lines of every event at or before its hour boundary. `verifyLog` with `compareEvents` and `rebuildGatewayState` rely on this order.
- The header (seed, `idKey`, controller labels) and any model or personality data are operator and spectator data and never reach agents. The header carries no seat names.
- Expected size of a 12-seat 7-day bot match: 30–60k lines, a few MB.

### 10.3 Snapshots

`{format: "perfidia-snapshot/1", engine, setup, configHash, rulesHash, hour, t, afterN, hash, state}`.

- Snapshots are taken **only at checkpoints**: the host splits `advanceTo` at `3600·H` for every snapshot hour H (safe by composability), snapshots, then continues. The snapshot's `hash` therefore equals the `h` of the `ckpt` line of hour H, and `afterN` is the `n` of the last line written before that `ckpt` line. The final snapshot is taken after the `end` line.
- The envelope stores the full `setup` (ruleset ref, overrides, seed, `idKey`, seats), so a snapshot of a match with overrides loads on its own (§5.3).
- Only engine state is snapshotted. **Gateway state is rebuilt from the whole log** by `rebuildGatewayState` (§10.5), which a test keeps honest; this, not a gateway snapshot, is what a phase-2 resume after a crash builds on (load the engine from the rebuild, close any turn left open with `why: "error"`). Phase 1 does not resume live matches. A gateway snapshot next to each engine snapshot can come later as an optimisation; it would not remove the fold over the lines after the snapshot.

### 10.4 Replay verification (`kernel/replay.ts`, pure, browser-runnable)

```ts
export interface ReplayReport {
  ok: boolean;
  actions: number;
  checkpoints: number;
  finalHash: Hash64 | null;
  warnings: string[]; // e.g. engine version differs
  divergence?: {
    kind:
      | "header"
      | "config"
      | "rules"
      | "snapshot"
      | "initial"
      | "order"
      | "result"
      | "event"
      | "checkpoint"
      | "end";
    t: GameTime;
    n?: number;
    hour?: number;
    expected: string;
    actual: string;
  };
}
export function verifyLog(
  lines: Iterable<LogLine>,
  resolve: (ref: string) => AnyRuleset | undefined,
  domain: DomainModule,
  opts?: {
    invariants?: InvariantLevel;
    from?: Snapshot;
    compareEvents?: boolean;
    onCheckpoint?: (hour: number, r: ReadCtx) => void; // pacing and other per-hour measurements
    // Every line in file order, after the engine has processed it; `applied` for act lines.
    // rebuildGatewayState (§10.5) is a fold over these calls.
    onLine?: (line: LogLine, r: ReadCtx, applied?: ApplyOutput) => void;
  },
): ReplayReport;
```

Algorithm:

1. Resolve the header's ruleset; recompute the effective config from the overrides and compare it and its hash with the header; compile and compare `rulesHash` right away (a mismatch is a `rules` divergence: "compiled tables differ for perfidia-1@1.0.0 under the same config"); create the match and compare `initialHash`.
2. For each line in file order: assert `t` is non-decreasing (and `n` increasing on lines that carry one); `advanceTo(t)`, comparing each produced checkpoint with the next `ckpt` line; on an `act` line, `apply` and compare `ok` and `code`. Lines other than `act`, `ev`, `ckpt` and `end` do not touch the engine (the `batch` order is already the order of the `act` lines).
3. With `compareEvents` (default on), compare produced events with the `ev` lines, in the order of §10.2; this localises a divergence to the event before the hour does.
4. `advanceTo(end.t)`; compare the remaining checkpoints, the result and the final hash.

`from: snapshot` loads the snapshot (§5.3) and resumes **right after the `ckpt` line of its hour** in the file, whose `h` must equal the snapshot's hash. The report names the first divergence.

**Level E** is this algorithm, for every log of any clock. **Level G** (`sim verify --resim`) re-runs the match from the header (bots rebuilt from the header's controller labels and the `controller` lines, which become `handoffs`, same clock spec and latency model, through the `sim` harness) and compares the normalised logs line by line; it applies to lockstep and virtual-time runs whose controller labels all exist in the current bots registry.

### 10.5 Gateway state rebuild (`gateway/src/runtime/rebuild.ts`)

```ts
export function rebuildGatewayState(
  lines: Iterable<LogLine>,
  resolve: (ref: string) => AnyRuleset | undefined,
): { gw: GatewayState; report: ReplayReport };
```

- It runs the engine's `verifyLog` (Level E, so the engine re-run supplies the violation details that the `lastTurn` messages need) and folds every line through `onLine`, calling the same `seat/` functions as the live host: `ev` → `deliver`; `wake` → `begin` (checking the line's reasons, charge and budgets), then `briefed`; `act` → `recordAct` (daily counters and the round's failures); `gw` → `recordGw` (the round's failures, batch items with `i` included; the message is regenerated from the code and details, and is the bare code when the explainer throws, as in the live host, §7.3); `note` → `writeNote`; `turn` → `closeTurn` (`end`, `selfAt` and `lastTurn`); `defer` → `defer`. `obs`, `batch`, `controller`, `ckpt` and `end` change no gateway state.
- **Test** (T16, in `sim/src/hardening/` with the default bots, since `gateway` cannot depend on `bots`): at the end of 1-day lockstep and `VirtualTime` runs of both rulesets, the rebuilt state equals the live one returned by `runMatch` (canonical JSON). A drift means a gateway-state change that no line records; the fix is a line, never a special case in the rebuild.
- A turn still open at the end of the log (a crash) is reported in the result (`inTurn: true`); closing it is the resuming host's job.

---

## 11. Bots

### 11.1 Contract and memory

- Every bot is a `SeatAgent` (§9.1) and sees only briefings and tool results, exactly like an LLM. Bots import only `protocol` at runtime.
- **Stateless across wakes**: strategic memory goes through `write_note` (compact JSON, within `notesMaxChars`), mirroring "one wake = one fresh session". A bot may take over a seat mid-match (hand-off, §8.7), so it treats a notebook it cannot parse (empty, free text written by an LLM, or full) as empty memory, never throws on it, and rewrites it within the cap. The only in-memory state allowed to outlive a turn is a cache of data the bot could fetch again: the rules keyed by `(configHash, players)` and the map. Caches live **in the bot instance** (one `createBot` per seat per match), never at module level, so matches running side by side in one process (batch mode, coexistence tests) cannot share them.
- **Seeded**: a bot's choices use its own small mulberry32 (`bots/src/rng.ts`, same algorithm as `core`), seeded from `(matchSeed, seat, briefing.t, turn, round)`. A bot is a pure function of its inputs, so Level G holds.
- **Ruleset-agnostic by default**: in round 0 the bot calls `rules` once per match and reads structured data only, never the `interface` prose: caps and wake rules from `rules.gateway` (and per turn from `RoundInput` and the briefing's `budget`), and from `CompiledRules`: producers by role, storage and population buildings, wall (may be absent), unit roles derived from stats (defender: best defense per cost among land units; attacker: best attack per cost; settler: `roles.settler`; carriers: `capacity > 0`; warships: `naval > 0`, may be absent), costs, queues and requirements (`requiresOn`). Travel times come from `view_map(fromCity)`; free slots from `view_map`/`view_island`; its own movements and stationed groups from `view_player` on itself; time-gated rejections are retried at `details.availableAt`. Bot code never names a building, unit or queue id outside `hints.ts` (§2.3 scan test).
- **Optional hints** (`bots/src/hints.ts`): `Record<ref | rulesetId, StrategyHints>`, looked up by `hintsFor` with the exact ref first, then the id (a version that renames ids has its own entry: `perfidia-1@1.1.0` names the `olympus` tag and the acropolis's quad, and `perfidia-1@1.0.0` keeps the id entry, unchanged), e.g. for `perfidia-1` the island preference of the reference bot (home slot, frontier, backyard, inner, next frontier) and the Crown's tag. `combat` (read by `rusher@2`, `rusher@3`, the conqueror, `@1` to `@3`, and the relief pack of §11.2 only) gives the paths, in the effective config (`rules` → `config`, so overrides count), of the battle numbers `CompiledRules` does not carry: capital immunity, base defense by building level (`perfidia-1`: the hall's quad `economy.baseDefense`; `sandbox-1`: `combat.keepDefense` per keep level), wall bonus, morale; for `rusher@3` also the loot each warehouse level protects (`perfidia-1`: `economy.lootProtectPerLevel`). The bots read the battle numbers through one function, `combatNumbers` (`kit.ts`), so the hints mean the same to all of them: a base defense that resolves turns them on, and then a wall bonus or morale the hints do not name counts as none (`sandbox-1` has neither). Without a resolvable base defense a bot still plays (the conqueror then pads its estimates, assumes a morale of 800 ‰ and no capital immunity; `rusher@2` and `rusher@3` count the units only, behind a wider margin). `domination` gives where the briefing lists the countdowns and the leaderboard the threshold in cities (`need`); for `perfidia-1@1.1.0` also the taken cities the threshold asks for (`needTaken`, leaderboard) and those of the seat's own bloc (`ownTaken`, briefing). `opportunist@2` and `@3` hold back their betrayal while their bloc is within 2 cities of the threshold (`dominationInReach`); with the taken paths, a bloc short of taken cities is not in reach, since it can only get them by conquest. The 1.0.0 entries have no taken paths, so the bots play 1.0.0 exactly as before and its goldens keep their Level G; the hints of 1.1.0 changed before its release, with its goldens regenerated, so no bot label moved.
- Bots never throw on `{ok: false}`, respect the caps in `RoundInput`, cancel by queue item number, and end with `end_turn` carrying a self-wake (`wakeAt`) chosen from their queue ETAs (this is what makes the measured wake rate realistic). A strategy may also ask to be awake at given times (`Planner.wakes`, `Planner.wakeAt`: a timed launch, a launch window opening, its army coming home): `chooseWake` keeps the earliest of them (its `firm` times) even below the cadence and the spread of the own-wake budget, clamped by `selfWake.min` only. Such a wake still costs an own wake: when the day's own wakes are used up, the gateway moves it to the next day or the safety wake. So a strategy that relies on one counts what will wake it before (`ownWakesBefore` in `plan.ts`: its queues that empty and its reports that land, grouped by `groupWindow`) against the own wakes left: `conqueror@1` plans a train only when they cover its timed launch, and queues nothing while the train waits; `rusher@2` starts no idle queue while they barely cover its next firm time; `rusher@3` also paces every wake it causes over the day (`wakePacer`: the own wakes used by then within an even share of the budget plus two). The phase-1 bots (`expander@1`, `rusher@1`, `turtle@1`, `opportunist@1`) ask for none.
- **Labels are versions.** A bot's label is `bot:<strategy>@<n>`. Any change to a bot's behaviour after the first goldens are committed bumps `n` (§13.5). The registry (`bots/src/registry.ts`) keeps **every published version** of every strategy, never only the latest: a new version is a new `StrategyDef` added to its `PUBLISHED` list beside the old one, which stays frozen, so the goldens recorded with the old label keep their Level G check. `botLabel(strategy)` and `createBot(strategy, …)` use the latest version, `createBotVersion(strategy, n, …)` a given one, and `parseBotLabel`/`botFromLabel` accept and build exactly the registered version a label names (an unknown name or version gives `null`). A new strategy is its name appended to `BOT_STRATEGIES` plus its def in `PUBLISHED`. A version may be registered as a **preview** (`StrategyDef.preview`): its label, `name@n` and its Level G check work as for any version, but the unversioned calls (`botLabel`, `createBot`, the default lineup) keep the highest version without the flag until a release drops it, so the default goldens do not move before then (`conqueror@3` was one until the war-call integration made it the default). `sim/src/golden/labels.test.ts` asserts that every `bot:` label of every committed golden is still registered.

### 11.2 Strategies (`bots/src/strategies/`)

| Strategy        | Behaviour (all parameters seeded and jittered)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expander@1`    | The peaceful reference bot of `perfidia-1` §15.1: acts every 2 h (self-wake 7200), economy first, settlers as soon as affordable to the nearest valuable free slots, surplus to defenders and attackers 1:1, never attacks. Supports its own cities.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `expander@2`    | expander@1 (`strategies/expander.ts`, frozen) plus the relief pack (`relief.ts`, `pace.ts`): **relief** of its own besieged cities (its attackers, which now come with carriers, are its relief force); **stop the leader** while a rival bloc runs a domination countdown (never on a pact partner's city: the battle would end the pact as a betrayal); **own-wake pacing**. It stays the peaceful reference player otherwise: it starts no war, its only attacks being reliefs and countdown strikes (seeds 1–20, 6 seats, lineup `expander@2,rusher@2,turtle@2,opportunist@2,conqueror@1,expander@2`: 86 launches in 40 seats, 48 reliefs and 38 countdown strikes, none else).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `rusher@1`      | The @1 behaviour, frozen since its goldens (`strategies/rusher.ts`): early barracks, attackers and carriers; spies the nearest non-allied target; raids when its attack exceeds the estimated defense by a seeded margin (≥ 1.5×); conquest attempts with 2 settlers on weak colonies; recalls within the window if a fresher report shows a stronger defense.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `rusher@2`      | Frozen since its goldens (`strategies/rusher2.ts`): a rush that lands when protection ends (`perfidia-1` §15.1–§15.2). Opening: producers of the attackers' resources (L3), the attackers' unlock, then the carriers' when the nearest stranger is across water; everything else on attackers, in few batches (each batch end and each report costs an own wake). It spies the two nearest strangers (colonies first) so that the reports land at `attackFrom`, wakes then and launches at once on the weakest target that passes its margin (in the 6-seat batch: about 17 attackers and a carrier at 12:00, first launch by 12:09 in 9 seats of 12, first battle D1 ≈ 15:00). Then, whenever its army is home: a conquest attempt with one founder on the weakest colony on a fresh spy report (seeded margin 1.75–1.95×, above the 1.41× a lone founder needs; the army waits for that report), else a raid on the weakest target (1.2–1.4×). Its defense estimate adds the buildings' share (`combat` hints), what the target's stock can train on warning, the support the owner's other cities on that island can walk over and an age margin; morale applies. It leaves a city alone for a seeded cooldown after it beat an attack or a spy, spies at most six cities a day (one at a time, two side by side in the first 6 h after protection ends, so that the first strike does not wait a round trip per candidate), asks to be awake when its army comes home, keeps one founder ready while a colony is in reach, settles only once none is, and recalls within the window on a fresher, stronger spy report. Its recruit orders fit the room of each queue (attackers alone when only one batch fits), and it starts no idle queue while its own wakes barely cover its next firm wake (§11.1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `rusher@3`      | The latest rusher (`strategies/rusher3.ts`): `rusher@2`'s rush, played by a seat that means to last (it copies what it keeps of the frozen `rusher@2`). Kept: the opening, the two spies whose reports land as the rush starts, the first wave launched at once (15–18 attackers and a carrier), the strike estimates, cooldowns, recalls and one-founder conquests on fresh spy reports. The rush starts at `max(attackFrom, D1 12:00)`; before it, a spied target its army already beats is struck as soon as protection ends. **Grows**: once the first wave has left (or 6 h after the rush starts) it recruits founders and settles one city at a time, wanting 2 cities on day 1 and 3–4 by the end of day 2, then up to 5–7 while free land is in reach (from day 3 while it owns 20 attackers per day played); the founder's price is reserved first in the main city, where loot lands, and the other cities ship their surplus to the city that trains the army, each cargo cut to what that city can still store when it lands (its stock after the turn's orders, its production on the way and the cargo already heading there; above it the cargo would be lost). **Garrisons**: every own city keeps a defense of at least 150 + 100 per game day, raised to 1.1–1.4× the strongest army its last day's spy reports showed at home in a stranger's city (at most 3× that floor); cities with spare defenders support those short of them, a siege it holds gets defenders once, and a besieged own city is relieved when the army beats the besieger's garrison by its raid margin + 0.2. **Strikes** leave from every city with enough attackers, each on its own target, planned for when enough attackers are home (those on their way back and those its queues deliver count). **Raids** need a spy report; a city it shows without defenders is raided only for loot worth the trip (300–500 above what its storage protects, `combat.lootProtectPerLevel`), and not again for a day after a raid found it so. **Wakes**: queues sized to run until its next wake, an idle queue started only with a batch that lasts that long (unless its store is nearly full), every other wake it causes paced over the day (`wakePacer`, §11.1); the first strike goes regardless. Batch (6 seats, `expander@1,rusher@3,turtle@1,opportunist@1,conqueror@1,expander@1`, seeds 1–20, 7 days; `rusher@2` in its seat in brackets): eliminated in 2 runs (10), cities founded in every run, 3.5 a run (0), 2.1 cities at the end of day 2 and 5.9 at the end (1.4), first battle D1 15:14 (15:20), 11 % of its battles on a city without defenders (30 %), own wakes used up at 19.7 h on day 1 (17.5 h). With protection ending at 06:00: first battle D1 15:14 (D2 05:14), eliminated in 4 runs (10); at 18:00: D1 21:13 (21:39), 5 runs (8). (Measured again after the review fixes: shipments fitted to the receiver's room, one training time per unit.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `turtle@1`      | Economy, wall (when the ruleset has one) and defenders; accepts every alliance and pact; never attacks; on an incoming attack recruits `max` defenders and asks allies for `support` by message.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `turtle@2`      | turtle@1 (`strategies/turtle.ts`, frozen) as the supportive ally: defenders and attackers 3:1 with carriers (its relief force), **relief** of its own and its allies' besieged cities with its attackers and half the defenders of each city that sends a wave, **support** of an ally's city with an attack on its way (a share of the nearest city's defenders, called home 8 h later unless an attack is still on its way), countdown strikes (never on a pact partner's city) and own-wake pacing. It braces a threatened city once per turn: turtle@1 cancelled the same build item again for each further attack on that city and ordered `max` defenders again on an empty stock (the `cancel_queue` `QUEUE_ITEM` and `recruit` `INSUFFICIENT_RESOURCES` rejections of the batches, 10 and 13 in 20 runs).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `turtle@3`      | The latest turtle (`strategies/turtle3.ts`): turtle@2 (frozen) answering its allies' war calls (`war.ts`, through the responder side `respond.ts`) as the supportive ally it is. A `hold` or `siege` call gets defenders: a seeded share (its relief share plus 10–25 points) of the defenders of the own cities that land inside the window, the strongest group's launch aimed at a seeded 15–40% of the window (a siege's defense leaves only once the ally's siege has ended: only the besieger may support a besieged city), answered `yes, landing …`; a strike is declined (`no: i defend, no strikes`). It never sends a call and its only attacks stay reliefs and countdown strikes. It **holds an ally's conquest**: an ally's siege seen on the map is remembered with its end, and once the ally owns the city the nearest own city with defenders sends a share of them (called home 8 h later, as every support of an ally's city); never a city taken from itself, an ally or a pact partner. It accepts every proposal except a betrayer's: a player that betrayed it is never allied again, nor are its calls answered (`tb<seat>`, for the rest of the match). Everything else as turtle@2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `opportunist@1` | Ally-then-betray: proposes pacts or an alliance to its neighbours on day 1, sends a small tribute to the strongest, records "ally pX since D1" in its notes; from a seeded day (3–5), if it ranks in the top 2 and an ally's city is weaker than its army, it messages "we remain friends", attacks that city and keeps the alliance until the betrayal lands (it may leave the alliance afterwards).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `opportunist@2` | Ally first, betray later (`strategies/opportunist2.ts`), with opportunist@1's seeded betrayal day (D3–D5, top 2 of the leaderboard) and day-1 courting. It **never betrays while its own bloc runs a countdown** or holds nearly enough cities for one (within 2 of the leaderboard's threshold), and turns back a betrayal still in its recall window when a countdown of its bloc starts; a rival bloc's countdown is fought by force (stop the leader, a pact partner included). **Raids**: it spies the nearest strangers (no alliance or pact, never a besieged city or one the hints avoid; 3–5 spies a day, spread over the day) and raids the weakest on a fresh report when its army, morale applied, beats the estimate by a seeded 1.4–1.8×, leaving a city that beat it alone for 10–18 h. **Allies with fighters**: from D2, while it has no ally, it proposes an alliance to a neighbour seen attacking in the public battle headlines (nearest first; a player that let an offer expire is not asked again for 2 days), else to its nearest neighbour, and accepts one alliance from anyone. Relief of its own and its ally's cities, support of its ally's threatened cities and own-wake pacing as turtle@2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `opportunist@3` | The latest opportunist (`strategies/opportunist3.ts`): opportunist@2 (frozen, its draws first) that fights beside its allies. **Answers calls** (`respond.ts`): a strike gets a seeded 70–90% of the attackers (warships across water, with their carriers) of the own cities that land inside the window, at least a seeded 150–300 attack; a hold or a siege a share of its defenders; yes with its landing or no with the reason, then a firm self-wake at the planned launch, where the call is judged again before anything leaves (a target besieged meanwhile, an attack on its way to the seat, a cancelled call: nothing leaves). While a strike it promised has not left, its attackers stay home. **Joins its allies' wars**: `war on pX` in an ally's private message (conqueror@2 writes it) makes pX's cities its first raid targets for a day. **Calls its allies** against a common enemy it raids (no relation to it or, by the leaderboard, to any of its allies): a target nearer than a seeded 4–6 h becomes a joint raid (the call now, its own army leaving so as to land that far ahead, mid-window; a cancel when the target is besieged or changed hands by then), a farther one is raided at once with a call around its landing; 1–3 calls a day, never to an ally that refused or ignored one within a day. **Ally first, betray later** as opportunist@2 (never during or near its own bloc's countdown); while a betrayal is in reach (an ally's city its army beats by its margin), that ally's calls get no answer and it calls that ally no more. An alliance or a pact offered by a player its raid is on the way to is accepted only once that raid is called back (within its 600 s) or has landed: landing on a new ally it would be a betrayal, and end the countdown the alliance may start; a player that betrayed it is never allied again, nor are its calls answered. A raid whose target one of its own calls under way already names (the window overlapping) sends no second call. Holds an ally's conquest as turtle@3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `conqueror@1`   | The @1 behaviour, frozen since its goldens (`strategies/conqueror.ts`). Plays for eliminations (perfidia-1 §9.7, §13.3). **Victim**: among the players it can reach and is not allied with, the fewest cities, then the nearest (a recent attacker weighs less, a pact partner more), seeded tie-break; kept in its notes (`av`, `ac`) once a conquest wave left for it, changed only when the victim is gone or clearly out of reach (3 more cities than another candidate). **Economy**: founds up to 4 cities like the expander until the conquests begin (the day after attacks open), then every founder leads a conquest; defenders and attackers 1:2 in batches of at least 4 packs, with carriers for the attackers, half the defenders and the founders. **Targets**: the victim's capital first once it can fall (capital immunity from the config, via hints), then its oldest cities (they recruit the founders of its new colonies); a city the army could break but cannot strike yet holds the founders for itself, a city too strong for the whole army is passed over. **Strikes**: battles estimated from spy reports (refreshed when older than 6–10 h): the units seen, those its queues train before the waves land and those its stock trains on warning (as `rusher@2` counts them), grown with the intel's age at landing, with the config's base defense, wall bonus and morale (hints, `combatNumbers`) and a pad, plus half the units of the owner's other cities on that island (they can walk over); within a day of a report that showed more (an army away comes home) or of a strike lost there (taken as at least the attack it beat), the defense is not assumed lower; one island lands in one second: clearing waves, the founders' wave (2 founders when it has them, sized for the defense they leave), then a garrison of the attackers and defenders left, which joins the siege; when that is not enough, a **train**: helpers from islands 10 min–2 h farther leave first and the founders' island's waves leave at a precise self-wake so as to land a minute after them (§8.11, §15.2); a train leaves only when the own wakes left today cover what will wake the seat before that self-wake (§11.1), and the seat queues nothing while it waits. **Founders** are recruited just in time (one spare once conquering) in the city best placed to lead the strike, other cities shipping what its price lacks; the founder left over by a two-founder wave stays with the garrison in the city taken, for the next hop. **Sieges**: defenders from the nearest city once per siege (a city besieged anew is reinforced anew), from the two nearest that land before each attack on it; a garrison no help can reach, facing an attack its spy report shows twice as strong, is recalled. Supports its own cities; pacts (and one alliance) with anyone but its victim. **Notes**: flags that no longer matter are dropped every turn (a city no longer the victim's, a siege no longer held, a day-old attacker), and the victim's and the train's flags sort first, so a notebook cut to its cap drops them last.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `conqueror@2`   | Frozen since its goldens (`strategies/conqueror2.ts`): conqueror@1's battle model (spy-based estimates, one-second waves, timed trains, sieges held, just-in-time founders, the helpers it exports) under a new strategy, as a proxy for a competent warlike player. **Victim by expected value**: for every player it can reach and is not allied with, its best city's value over its cost (the defense after morale, an overhead and the travel; without intel, a defense prior that grows by the day), weighted up for a bloc running a domination countdown the seat is not in (stop the leader; the countdowns read through the `domination` hints, as the relief pack reads them), for the leader once its score is 10 % above the seat's (from day 2), for a player that attacked the seat within a day, for the player an ally names, for a city the seat lost within 2 days (retake) and for a player with 1 to 3 cities once all of them can fall; down for a pact partner and for a city the whole army cannot break yet (unless a wave already left for it); the victim is kept unless another is clearly better (×1.5 before a wave left for it, ×2–2.5 after), and the next one follows at once when it falls or costs too much. **Targets**: the victim's capital first once the army could strike it, then its cities cheapest first; colonies from the end of protection, capitals once their immunity ends. **Defense**: conqueror@1's estimate plus half the units of the victim's two nearest cities on other islands whose support, sent when the first wave leaves, lands before the waves (their travel timed on the map's coordinates with the seat's own sea pace, the lower median of its travel times per tile; none from a city a spy report shows without carriers when the rules need them to cross water, half the target's own units for one without intel): conqueror@1 counted only the owner's cities on the target's island, and a fifth of its strikes died against defenders shipped over. **Founders**: a free slot or a conquest, whichever is worth more (a conquest counts twice: a city gained, one taken from a rival), so it keeps founding while slots are in reach; founders a strike wants or holds stay home (held 4 h at most), a committed campaign whose next strike could finish its victim keeps them all; carriers are recruited where founders are. **Trains**: a check spy (paid to see through twice the land pop last seen) leaves with the helpers; at the timed launch a fresher report showing more than twice the defense planned on, or one with which the waves no longer win, or the check spy's failure, calls the founders' waves off (helpers still in their recall window come back). Only a train can be called off on fresher intel: an ordinary strike's waves leave together, and no report can land within their recall window. **Scouting**: one spy a turn on another player's best city whose intel is older than 12 h. **Own wakes** (a queue that empties, a report that lands: each wakes the seat on its own budget), paced as the relief pack's bots (`pace.ts`): an idle recruit queue gets a batch only when it lasts until its next own wake, an idle build queue starts and a scouting spy leaves only with own wakes in hand (two for a scouting spy) under an even share of the day's budget, the queues started this turn (founders' included) and the reports due counting; a spy whose report may lead to a strike may take a wake beyond that share. The first gate (one wake per 4 h kept for the rest of the day, checked once before every city's queues were filled) spent the twelfth own wake by noon and left no launch after it (default bots, 6 seats, seeds 1–8, 7 days: twelfth own wake at a median 11.2 h, 0 of 93 launches after 12:00; paced, 19.5 h and 31 % of 51). **Army**: the attackers' unlock first, units before buildings in the capital, 80–90 % of the rest spent, and a city whose attackers cannot cross water asks for its carriers first; the garrison's carriers fit the pop the turn's orders leave free. **Early game**: it launches nothing before day 3 (its army of days 1–2, 8–16 raiders, breaks no city by its margins): the conflict of days 1–2 is rusher@3's. **Diplomacy**: from day 2, once a day while it has no alliance, a war alliance to the strongest of its three nearest neighbours that is neither its victim nor in a rival bloc (a pact when that neighbour is allied already); pacts and one alliance from anyone but its victim and a rival bloc; it tells its allies `war on pX` once per victim, weighs for a day the player an ally names (`war on pX`, or `by pX` in a call for help), and supports an ally's city under attack with a third of the defenders of its nearest city whose support lands first. **Notes**: conqueror@1's flags plus `ae`/`ap` (a train's planned defense, and when), `hw` (since when founders are held), `lo<city>` (a city lost), `sc<city>` (a scouting spy), `dp`, `mv`, `jv`/`jt` (diplomacy), `u<unit>` (a unit's training time when the rules carry no table, `pace.ts`); handled ids `a<movement>` (an attack on an ally's city answered).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `conqueror@3`   | The latest conqueror (`strategies/conqueror3.ts`; a preview until the war-call integration made it the default): conqueror@2 (frozen) played as a warlord that holds what it takes and fights beside its allies; it copies what it keeps (victim by expected value, targets cheapest first, founders between free slots and conquests, trains and their check spy, scouting, own-wake pacing, diplomacy). **Strike force**: once its second city stands, the forge city raises attackers first while the seat owns fewer than 50 (before capitals can fall, and before its founders), then 50 + 15 a day; the rest of the army is two defenders for one attacker. **Safer strikes**: the defense a strike meets adds the support its attacks provoke, since every attack is seen at launch (the owner's nearest city whose support lands first sends half its defenders per attack, each ally of the owner 40 % of its nearest city's per attack; a city without a report counts at a prior, and a spy goes to the one that decides a strike), weighed for the founders' city's flight; a strike flies 2.5 h at most (longer flights lost every unit far more often) and leaves on a spy report younger than 1.5–2.5 h (a spy first, the strike at its report's wake, unless no own wake is left for one); a colony seen founded in the public feed counts at a young city's prior. **Garrison**: the troops that follow the founders' wave go as supports landing in the same second (a support of the attacker stationed in the target stands aside in the battle and joins the siege, `perfidia-1` §8.1, §9.1), with covering supports from its other cities landing within the hour, sized to hold against the relief the owner can send (the attackers of its three strongest other cities on their last reports, at a prior without one, after morale); one attack instead of two or three is seen, so less support comes; a support stranded in a stranger's city (a failed strike) is called home. **Sieges held**: no strike (and no founder recruited for it) whose garrison could not deter the owner's known army: at least 1.15× the relief it can send (the relief pack launches only reliefs that beat a garrison by 1.15× at least), weighed from the founders' city or, before a founder is home, from the city that would lead the strike and recruit its founders (weighing it from the nearest city, often a fresh colony with no defender, kept a fifth of these checks at a potential of 200 or less and no founder was ever recruited for that island); each attack on a siege is met with defenders from the cities whose support lands first, enough for the founders to survive what it likely brings; a garrison facing a relief its origin's spy report shows stronger than every helper can make is called home before anything more is sent (the siege is lost, the units live; without a report the garrison is raised and stays: giving up on an estimate, a relief beating the garrison by 1.15×, lost more conquests than units it saved in the batches). **War calls** (`war.ts`): a strike on a capital or a city of D ≥ 1000 with allies in reach is called to them first (`strike`: a 30-minute window ending before its founders land, at least 3 h ahead, and an hour after its allies' armies can land: the travel from their capitals, where their armies gather, at most 5 h; from their nearest city only, `opportunist@3` answered `no: too far` to every strike call of the 20-run preview batches). Such a city its army cannot break alone is a **joint target** when its allies make up the difference: it reads the two cities of each ally nearest the target (an ally's city is seen in full) and counts on 45 % of their attackers at home. Its own waves leave at a timed wake and are weighed again then on the intel of then, counting only the allies that answered yes with a landing in the window (and the support each of their attacks provokes): without them a joint target is called off and the call cancelled. An ally it called that answered no, or nothing, is not waited for within a day (`wd<seat>`; the allies a call went to are kept, `wm<call>`, so that an ally never called is not judged); a siege asks its allies to hold the city once it falls (`siege`). It answers its allies' calls as the responders do (`respond.ts`: its own victim's cities first; a strike gets 50–70 % of the attackers, with their carriers and a share of warships across water, of two of its cities that land in the window, whatever their flight, since capping it at 4 h cut its yes to strike calls from 15 to 6 in 30 matches; defenders for a `hold` or a `siege`): an own wake left for the launch, yes first in one message per caller and messages kept in hand, the launch judged again at its wake and re-timed when it moved, a late no when nothing can leave, `no: busy` while its own train waits or a strike it promised has not left; never while an attack is on its way to it, nor for a player that attacked it within a day or ever betrayed it (a betrayer is never allied again either). Its supports in an ally's city are called home 8 h after it saw them there, unless an attack is on its way (`sa<city>`); a fighter it prefers for a war alliance is one seen attacking someone else. **Call-offs**: a train or a joint strike stays home on a report showing more than 1.4–1.6× the defense planned on (conqueror@2: 2×), a failed check spy, or a garrison that would not hold. **Victim** kept 4 h once chosen; a war alliance goes first to a neighbour seen attacking; a player asked is not asked again for 2 days. **Notes**: conqueror@2's flags plus `aj`, `wq`, `jx` (joint strikes and calls), `wm<call>` (the allies a strike call went to), `wd<seat>` (an ally that left a call unanswered or said no), `gw<city>` (a siege's call sent), `tb<seat>` (a betrayer), `sa<city>` (a support in an ally's city), `vt`, `fc<city>`, `f<seat>`, `pd<seat>`; handled ids `w<movement>` (a relief answered), `wk<call>`; the war book as `wc` memo lines. Measured (`sim batch`, `perfidia-1@1.0.0`, seeds 1–20, 6 seats, `--pacing`, against the same lineup with `conqueror@2`): in `expander@2,rusher@3,turtle@2,opportunist@2,conqueror@n,expander@2` its sieges conquered 19 of 23 (83 %; @2: 12 of 27, 44 %), 0.9 cities conquered a seat (0.6), score 1023 (1032), 2 wins (3); in `rusher@3,conqueror@n,expander@2,rusher@3,conqueror@n,turtle@2` 44 of 58 (76 %; @2: 37 of 56, 66 %), 1.1 conquered a seat (0.9) and 1.3 lost (1.0), score 1053 (1125), 12 wins of 40 (15); strike groups with founders that lost every unit: 2 of 26 and 2 of 63; own wakes 11.9 a day (11.9), messages 0.5 a day. Allied to another `conqueror@3` (`conqueror@3,rusher@3,conqueror@3,rusher@3,rusher@3,rusher@3`): 21 war calls, answered 11 yes and 10 no, 2 joint attacks, 47 of 53 sieges conquered. These numbers predate the review fixes measured below. It does not strike earlier than conqueror@2: before the fixes its first attack came at D5 07:01 in the median seat of the re-baseline (D4 03:30 for conqueror@2), 12 seats of 30 never besieged; no conquest before day 3 (its day-2 estimates of the colonies in reach, D 400–650, exceed the army it is still raising; no target lies within its 2.5 h before then in most matches), no elimination. |

**The relief pack** (`bots/src/relief.ts`, `bots/src/pace.ts`; called by `expander@2`, `turtle@2` and `opportunist@2` only, so the published versions are unchanged). Battles are weighed with the battle model of `rusher@2` and `conqueror@1` (`combatNumbers`: base defense, wall bonus and morale from the hints, or padded units without them) and the square law of losses.

- **Relief.** A besieged own (or allied) city is seen in full, so its garrison is known exactly: its `hold` groups and the besieger's supports landing before the relief. Cities send their attackers (`turtle@2` also half its defenders) against the besieger when the waves, in landing order, break the siege by seeded margins: the last wave wins by 1.15–1.35×, or the waves kill every founder of the garrison (a lost relief kills a lone founder from A ≥ 0.71·D, perfidia-1 §9.3) with a 1.10–1.25× margin. Among the six nearest cities, the fewest waves that do (three at most), then the earliest to land: a small wave that would only die first stays home. None that would sink in a naval phase or land after the siege's end; never against an ally (nor, for an ally's city, a pact partner). A relief in flight is weighed again on every turn, against the besieger's supports landing before it, and called back while it can be when it no longer breaks the siege; otherwise no other relief is sent there. An ally's siege that another player's relief is already heading to is left to that relief. The seat's own sieges get defenders from the nearest city once, and from the two nearest against each attack on them.
- **Stop the leader.** While a bloc the seat is not in runs a domination countdown, the seat spies that bloc's nearest cities (two a turn; a pact partner's only for `opportunist@2`, since a battle against a pact partner ends the pact as a betrayal) and strikes the weakest on a fresh report with founders (a raid does not stop a countdown: a besieged city still counts for its owner): the attackers of its other cities that land first, then from the city with founders (or able to recruit them, its other cities shipping what the founder's price lacks) a clearing wave and, in the same second, the founders with their escort, or one wave of everything; only when the conquest can end before the countdown does. It founds no city with its founders meanwhile. A besieged city is never a target: its foe would be the besieger.
- **Own-wake pacing.** Every queue that empties wakes the seat on its own budget (perfidia-1 §14.2), so an empty recruit queue gets a batch (the strategy's mix, and its carriers, three at least) only when it lasts until the seat's next own wake: its cadence, or the rest of the day spread over the own wakes left. Otherwise the resources wait for that wake; a batch bound by pop goes anyway. Unit times come from the rules' tables when `rules` carries them, else from the views and the briefing's queues and `recruit_done` events, remembered in the notes. An empty build queue (its items' lengths are unknown before they are ordered) starts only with an own wake in hand: the own wakes used today, those already due before the next own wake (queues that empty, reports that land, spies planned this turn), the queues this turn starts and that next wake may not run past an even share of the day's budget at that wake, plus two (never past the budget). The richest idle cities go first, and a city whose stock nears its storage cap builds anyway. A seat that spent extra wakes in the morning gets them back as the day goes on. (The first version held every empty build queue for the rest of the day as soon as the own wakes left no longer covered the cadence, which on `sandbox-1`, 8 own wakes a day, is from the first wake: its paced bots built nothing until their stock filled.)
- **Hints** (`hints.ts`, optional): `siege` (where a city's public extras name the besieger and the end, and the config the siege length) and `domination` (where the briefing lists the countdowns, and the leaderboard the threshold). Without them a besieger is found from the `hold` groups, a siege has no known end, and the bot never reacts to a countdown.

Measured (`sim batch`, `perfidia-1@1.0.0`, seeds 1–20, 6 seats, `--pacing`; the relief pack's lineup `expander@2,rusher@2,turtle@2,opportunist@2,conqueror@1,expander@2` against the same lineup with the @1 versions; measured again after the review fixes of the paced build queue and the relief's waves): relief battles 3.9 a run (0 before), 75 of the 125 sieges started broken by a relief (0 of 162); `opportunist@2` launches 9.4 attacks a match (`opportunist@1`: 0.35) and betrays 10 times, never during its own bloc's countdown (`opportunist@1`: 7, one of them cancelling its bloc's countdown); the twelfth own wake of the paced bots comes at a median 17.5 h (`opportunist@2`), 20.6 h (`turtle@2`) and 21.5 h (`expander@2`) of the game day instead of 13.5–15.7 h. Domination ends rise from 2 to 12 runs of 20: every countdown (17) is opened by `opportunist@2` and an ally (`expander@2` 14, `conqueror@1` 3), 15 of them at the 2N = 12 floor (the others at 13 and 15), with 4 conquered cities in all; 5 are cancelled when the bloc loses a city. This is the `perfidia-1@1.0.0` threshold (§13.3) exposed by a bloc that no longer betrays itself, not a target the bots tune for.

**The war-call protocol** (`bots/src/war.ts`; used by no published version, so every published bot is unchanged; a new version opts in, as with the relief pack). Allies ask each other to fight together in plain text that people and models read as it is, with a tag the bots parse: a **call** `WAR#k3 strike c12 vs p5 land D3 14:00-14:20 (I land 14:05)` (id, role, target city, the target's owner for readers, the landing window on the game clock, the caller's own landing), an **answer** `WAR#k3 yes, landing D3 14:12` or `WAR#k3 no: too far`, a **cancel** `WAR#k3 cancel: siege broken`. A call goes to every ally in one private message (one send against the daily cap of `perfidia-1` §11.1); several answers to one caller ride in one message (`; `); every war message stays within 100 characters, which a briefing never truncates. A briefing over its size target may still leave whole messages out, the oldest first (`more.msgs`, §8.2): in the re-baseline 2 calls of 97, 1 of 55 and 1 of 15 never reached their ally that way, and 2 answers of 104 their caller. The war-call bots then search their archive for the messages left out that mention a war (`read_notes`, the briefing's own search narrowed to `war`, `droppedWarSearch`), open the newest four not their own in a follow-up read (`droppedWarOpens`, `Brain.moreReads`, a round the published bots never ask for), and read them before the briefing's under the same trust rules (`warMessages`): measured below. Events and news give way before messages, so on a busy turn a betrayal of the seat or a conquest may be missing from both (in the first re-baseline only 1 of 5, 7 of 16 and 1 of 4 betrayals of a war-call bot were remembered, and conqueror@3 re-allied with its betrayer 600 s later). The war-call bots read them from every source a player has (`seenEvents`): the briefing's lists; the wake reasons, which a briefing never cuts (`betrayal p3` wakes only its victim, `city_conquered c12` only the city's former owner, perfidia-1 §14.2; a reason counts only when the rules' wake table wakes the event's target alone); and one archive search a turn of the kinds the cut lists may hold (`droppedEventSearch`: the cut `events` name the kinds they left out, the cut `news` may hold any; `betrayal` and `city_conquered` for all three, plus `battle` and `city_founded` for conqueror@3 and `battle` for opportunist@3, in a second search so that headlines never crowd a betrayal out), whose hits they read back from their one-line summaries. The learned recruit pace (`pace.ts`, shared with the published bots) still reads `recruit_done` from the briefing alone: own city views and queued batches come first there, and a learned pace is kept. A seat keeps messages in hand: it answers yes while more than 1 send is left today, calls or cancels while more than 2, and answers no only while more than 6 (a silent no costs nothing: the caller plans without that ally).

- **Roles**, from what a movement does to a besieged city (§7.3, §7.5, §9.2 of `perfidia-1`): `strike` attacks the target to land inside the window, before the caller's founders, to break its garrison; it is never launched at a besieged city (an attack fights the foe recorded at launch, the besieger: against the caller's own siege that is a betrayal) and one in flight when the caller's siege starts bounces. `siege` supports the caller's siege: only the besieger may reinforce a garrison, so an ally holds the conquest instead, with defenders landing inside the window once the target is the caller's. `hold` sends defenders to one of the caller's cities.
- **Trust.** Calls, answers and cancels are read from private messages of current allies only: a public message, the seat's own and a non-ally's are ignored however well formed, and at most 4 tags among a message's first 600 characters are parsed (a tag with any other text, or numbers out of range, is skipped; an id given twice keeps its first item). A call is declined when it would help against the seat, an ally or a pact partner, when its caller is distrusted (one of its attacks on its way to the seat, or a betrayal the seat learns of, `seenEvents`), when its target does not fit its role (a strike at a neutral or besieged city; a hold of a city that is not the caller's, or with no attack seen on its way there, so that one fake call cannot strip the seat; a siege the caller does not hold, or of a city of the seat, an ally or a pact partner), when its window starts more than a day ahead or cannot be reached, when an attack is on its way to the seat, or when the force it could send is too small.
- **Helpers**: compose and parse (`composeCall`, `composeAck`, `composeCancel`, `joinWar`, `parseWar`, `hearWar`), the notes book (one memo line `wc <caller> <id> <role> <target> <t0> <t1> <state> <at>` per call, with each ally's answer on the seat's own calls; written after the other memo lines, kept until an hour after the window, 6 at most, the seat's promises and own calls under way first so that an ally's calls never push them out; a call under an id the seat already said yes to or acted on is not a new call until it is cancelled; a line it cannot read is not its), launch timing (`launchTime`: now, or a self-wake at least `selfWake.min` ahead, never before `time.attackFrom` for a strike, landing as near the window's middle as it can; `launchFrom` times a group at its slowest ship's pace, `groupTravel`), the decision (`judgeCall`, `judgeWar` on the world: target and besieger from the map's public extras, distrust and threats from the briefing, the force of `warOptions`: a share of each city's units fit for the role, from the cities that can land in time) and the choice among several calls (`pickCall`: against the seat's own enemies first, then strikes, sieges, holds, then the earliest landing).

**The responder side** (`bots/src/respond.ts`; called by `turtle@3`, `opportunist@3` and `conqueror@3` only, so every published bot is unchanged). Each turn the seat takes the briefing's war messages (and those a full briefing left out, fetched) into its book (`openDesk`), distrusting for the rest of the match a player that betrayed it (`rememberBetrayers`, `tb<seat>`: a betrayal counts in `distrustOf` only on the turn it is reported), then:

- **Answers** each open call of an ally (`answerCalls`): judged by `judgeCall` on what it would really send, a share of the units fit for the role at home in each own city (attackers, and warships across water, for a strike; defenders otherwise), lifted by its carriers and timed at the group's slowest ship (`groupTravel`, `launchTime` with a seeded aim in the window); a `siege` call's defense may leave only once the siege has ended (the map's `siege.ends`, hints): before, a support to a besieged city is refused at launch. The best strike and the best defense it can serve are answered `yes, landing …` (`pickCall`: an enemy the strategy names first), the others `no: busy` (a new strike too, while one it promised has not left); a launch later today needs an own wake left for it and one to spare (`canWakeAt`: otherwise the self-wake would move to the next day, perfidia-1 §14.2), else `no: no wake left today`; a role the strategy does not play is declined with its reason; a refusal says why (`too far`, `too weak`, `under attack`, `we have a pact`, …); a call more than a day ahead waits unanswered, as does a caller the strategy keeps silent towards. Answers to one caller ride in one message, sent while messages are in hand (`WAR_RESERVE`).
- **Keeps its word** (`keepWord`): a yes is a planned launch with a firm self-wake; at that wake the call is judged again on the world as it is, and every own city whose group lands inside the window leaving now goes (two at most); a call it can no longer serve, or one from which nothing could leave, gets a late no while its window is open (a yes queued the same turn is taken back, the caller never hears both), a cancelled one nothing, and a strike still in its 600 s recall window whose call is cancelled is called back (`openDesk`).
- **Holds an ally's conquest** (`holdConquests`): an ally's siege on the map (or its conquest in the news) is remembered with its end (`gw<city>`, firm self-wake at the end + 120 s); once the ally owns the city, not besieged, the nearest own city with defenders sends a share of them, unless the seat already answered a call for that city; never a siege of a city of the seat, an ally or a pact partner, nor a conquest taken from one of them.

Measured with these responders (`sim batch`, `perfidia-1@1.0.0`, seeds 1–20, 6 seats, `--pacing`; each lineup against the same seats with `turtle@2` and `opportunist@2`, in parentheses; the logs read again for what the tables do not show). No caller of the other side ran here: the calls are `opportunist@3`'s own.

- **Two opportunists** (`opportunist@3,rusher@3,turtle@3,opportunist@3,conqueror@2,expander@2`): 108 calls, 56 answered: 14 yes, each followed by a strike that landed inside its window, and 42 no (23 `i defend, no strikes` from `turtle@3`, 13 `too far`, the others `under attack`, `too weak` or `no wake left today`); 7 joint raids called off by their caller. 14 joint attacks in 7 runs, 13 of them after a call (1, none after a call); 38 conquests (27); 4 domination ends (9).
- **Default-like** (`expander@2,rusher@3,turtle@3,opportunist@3,conqueror@2,expander@2`): the opportunist's ally is mostly an `expander@2`, which answers nothing, so 53 calls get 15 answers, all `turtle@3`'s no, and no joint attack; 24 conquests (25), 7 domination ends (10).
- **Alliance-heavy** (`conqueror@2,opportunist@3,turtle@3,conqueror@2,opportunist@3,turtle@3`): `conqueror@2` sends no call, but `opportunist@3` joins its `war on pX`: 58 of its 89 attacks in the day after such a message hit pX (23 of 89); an ally's conquest gets 16 supports within 6 h (12 from `opportunist@3`, 4 from `turtle@3`; none); 3 joint attacks, 2 after a call (1); 37 conquests (49), 6 domination ends (7).
- In every lineup `turtle@3` sends no call and launches only reliefs and countdown strikes; no betrayal of `opportunist@3` lands during its own bloc's countdown (one did before the guard on alliance offers: a raid in flight on the player that offered the alliance); `opportunist@3` sends 0.5–0.6 messages a seat-day (0.07–0.08) and `turtle@3` 0.2–0.3 (0.09), with as many turns a seat-day as the @2 seats (within 0.4); no internal error, every replay verified. The @2 lineup gives the same final hashes on seeds 1–20 as before this change.

**What these bots cannot show** (written before `conqueror@3`, `opportunist@3` and `turtle@3`, measured above). No bot answers an ally's call to war (`war on pX`) with strikes of its own: an alliance with `conqueror@2` fights as one conqueror and a passive ally, and `rusher@3` refuses every proposal, so a batch with these bots does not measure joint offense. `conqueror@2` launches nothing before day 3. Reliefs break most sieges, so conquests are few and eliminations rare (none in the 70 matches of the first re-baseline with these bots): the elimination and capital-immunity rules are not measured either. A bot that joins an ally's war is the next step before relying on those numbers. The teamwork measures of §12.2 on that re-baseline's 30 default-bot runs at 6 seats (seeds 1–30, logs read again): no joint attack; 281 sieges, 147 reinforced by their besieger, 244 met by a relief, 51 conquered, 222 broken by a relief, 2 abandoned, 6 other; the largest bloc held 16.3 cities on average (0.53 of them conquered), a bloc with 2 conquered cities 13.9 at most (10 runs), and R1 (18 cities, 2 conquered) was met in 1 run of 30. Before the responders were merged, a batch measured joint offense only where two `conqueror@3` were allied (2 joint attacks in the 20 runs of `conqueror@3,rusher@3,conqueror@3,rusher@3,rusher@3,rusher@3`).

**The re-baseline with the war-call bots** (`sim batch`, `perfidia-1@1.0.0`, `--pacing`, at the integration of `conqueror@3`, `opportunist@3` and `turtle@3`; the logs read again for the war calls). Default bots at 6 seats (seeds 1–30) against the PR #8 defaults (`expander@2,rusher@3,turtle@2,opportunist@2,conqueror@2`, in parentheses; that batch reproduces the PR #8 re-baseline's final hashes, 30 of 30): 15 joint attacks in 4 runs, 14 after a war call (0); 133 war calls, 54 answered, 21 yes; 260 sieges (281), 51 conquered (51), 207 broken by a relief (222), 0 abandoned (2); `conqueror@3`'s sieges conquered 27 of 36, 75 % (`conqueror@2`: 22 of 52, 42 %), its first siege at D5 12:06 in the median run (D4 08:59); 1.7 conquests a match (1.7), no elimination (none), no conquest before day 3 (none); R1 met in 1 run (1); 9 domination ends (12), their blocs 1 conquered city in 128 (2 in 159); free slots at the end of D5 4.4 (4.7); launches by 6 h band 39 / 30 / 25 / 7 % (41 / 29 / 22 / 8 %). Allied conquerors and responders (`conqueror@3,opportunist@3,turtle@3,conqueror@3,expander@2,rusher@3`): 34 joint attacks in 13 runs, all after a call (31 called by `opportunist@3` and joined by `conqueror@3`, 3 by `conqueror@3`); 2.5 conquests a match, `conqueror@3`'s sieges 44 of 60 conquered; R1 met in 1 run of 30, 5 domination ends. Default bots at 8 seats (seeds 1–10): 3 joint attacks, 2.3 conquests a match (1.9 with the PR #8 bots), R1 (20 cities) and domination never met (never). A fighting alliance now exists in the batches, but it does not hold more cities: reliefs still break most sieges of the other bots, and the blocs that dominate are still peaceful.

**After the review of the war-call bots** (the same batches again on the fixed bots; the re-baseline above in parentheses). Default bots at 6 seats (seeds 1–30): 9 joint attacks in 4 runs, 8 after a call (15 in 4); 132 war calls, 55 answered, 14 yes (133, 54, 21); 270 sieges (260), 55 conquered (51), 211 broken by a relief (207); `conqueror@3`'s sieges 28 of 44 conquered (27 of 36), its median seat's first siege at D5 08:36 (D5 10:47), 7 seats of 30 that never besieged (12), still no attack before day 3; 1.8 conquests a match (1.7), no elimination; R1 met in 3 runs (1); 8 domination ends (9), whose countdowns' blocs held 12 conquered cities of 658. Allied conquerors and responders (`conqueror@3,opportunist@3,turtle@3,conqueror@3,expander@2,rusher@3`, seeds 1–30): 21 joint attacks in 8 runs, all after a call (34 in 13); `conqueror@3` answered 36 strike calls of `opportunist@3`, 22 yes, 21 launched and landed in the window, 1 late no (50, 37, 33, 4 late noes); 2.3 conquests a match (2.5), `conqueror@3`'s sieges 40 of 61 conquered (44 of 60), 24 of its 60 seats never besieged (18); R1 met in 1 run (1); 8 domination ends (5). Default bots at 8 seats (seeds 1–10): no joint attack (3), 2.2 conquests a match (2.3), R1 and domination never met. Every war call (135) and answer (141) of these 70 matches reached its reader, and 7 of 9 cancels (the re-baseline lost 5 calls and 5 answers, most in briefings that left messages out). There are fewer joint attacks than in the re-baseline: its count included promises `conqueror@3` could not keep (4 late noes there; 14 of its 76 yes in the review's batches), joint attacks of an ally with the player that had betrayed it within a day (5 of 34), and yes to launches its own wakes could not reach; the rest of the gap is the stricter launch (an own wake for it, two cities, its carriers' lift).

**After the betrayal-memory fix** (events also read from wake reasons and a `read_notes` search when a briefing cuts them; the paragraph above in parentheses). Every betrayal of a war-call bot is now remembered on the betrayal turn (default 5 of 5, war lineup 18 of 18; 1 of 5 and 7 of 16 before), with no re-alliance, pact, yes or joint attack between a victim and its betrayer. Default bots at 6 seats (seeds 1–30): 7 joint attacks (9), 134 war calls with 9 yes and 41 no, 57 conquests (55), no elimination, R1 met in 2 runs (3), 9 domination ends (8). War lineup (seeds 1–30): 15 joint attacks (21; 7 of those were betrayer and victim), 107 war calls with 26 yes and 41 no, 64 conquests (69), no elimination, R1 never met (1), 11 domination ends (8), every winning bloc with 0 conquered cities.

**Reliefs, by besieger.** The pooled share of sieges broken by a relief (78 % in the default batch above) measures `rusher@3`'s targets and the relief pack's win-only reliefs more than the siege length or the relief rules: of the sieges a relief battle came to, `conqueror@3` held 6 of 22 in the default batch and 13 of 30 in the war lineup (8 of 22 in the re-baseline), `rusher@3` 3 of 147 and 0 of 144, all bots 16 of 228 in the default batch; without a relief, `conqueror@3` conquered 22 of 22 and 27 of 31. A decision on `siegeDuration` or the relief rules should quote these rates per besieger and conditional on a relief coming.

**What the default lineup measures.** Little teamwork: two seats of six are `expander@2`, which answers no call; `turtle@3` declines every strike; no bot calls its allies against a rival bloc's countdown; so 9 joint attacks in 30 matches at 6 seats and none at 8, and its domination ends are peaceful (their blocs 12 conquered cities of 658). Batches that choose values for R1 or for domination use the war lineup, and say so; a version of `expander@2` that answers calls, and a call against a rival bloc's countdown, are not written yet.

Tests also use a `chaos` agent (in the gateway runtime tests, not a bot strategy): seeded random calls to every tool with valid and invalid arguments, which must never crash the gateway or the engine, and which mutates every object it receives (P16).

---

## 12. `sim` CLI

### 12.1 Commands (`bun run sim -- <command>`; the root script runs `bun packages/sim/src/cli.ts`)

```
run     --ruleset <id@version | id>   (default: latest published perfidia-1)
        --override <key=value>        (repeatable; validated by the ruleset schema and the config checks)
        --seed <uint32> --players <N> --days <N>
        --id-key <32 hex> | --id-key random            (default: idKeyFromSeed(seed), not secret; §4.1)
        --bots expander,rusher,turtle,opportunist,conqueror  (default; cycled over seats, each at its latest version, `DEFAULT_BOTS`)
        --seat p3=rusher | p3=rusher@1 (repeatable)
        --clock lockstep|realtime  --time virtual|system  --speed 3 | 5/2  --latency 2000-60000
        --invariants off|checkpoint|step  --snapshot-every <hours>  --trace-hashes  --allow-test
        --out runs/<name>  --quiet  --json
verify  <run-dir | match.jsonl> [--from h072] [--resim] [--dump] [--invariants step]
batch   --variant "<label>: <ref> [key=value ...]"      (repeatable; label optional)
        --seeds 1-10 | 1,5,9  --players <N> --bots …   (same seeds and seat assignment for every variant)
        [--days N] [--per-match] [--pacing] [--json out.json] [--out runs/batch-<name>]
summary <run-dir | match.jsonl> [--json]
golden  --check | --update
```

- Exit codes: `0` ok, `1` replay divergence (including a snapshot that does not match), `2` fatal (invariant, engine, driver or agent error in strict mode), `3` usage or config error (explanatory message listing valid flags, refs, override paths or the ruleset's player range).
- `run` refuses a `test` ruleset without `--allow-test`; `batch` reports any variant whose player range excludes `--players`.
- `--bots` and `--seat` name a bot as a strategy (its latest version) or as `strategy@n`, a version the registry keeps (§11.1): `--bots expander,rusher@1,turtle,opportunist` reruns the phase-1 composition from any later build, next to the latest bots. An unknown strategy or version is a usage error listing the registered versions.
- `verify --from` loads the snapshot with its own setup and resumes after the matching `ckpt` line (§10.4). `verify --dump` writes the actual state at the first divergent checkpoint and prints a structural diff (up to 20 JSON paths) against the nearest saved snapshot.
- `golden --check` verifies every committed golden (§13.5) and fingerprint (§13.6). `golden --update` only **adds** files: goldens and fingerprint entries for a ref or a bot label that has none. It refuses to rewrite an existing file or entry, whatever `ENGINE_VERSION` says.
- **Shared harness** (`sim/src/harness/`, used by the CLI, the integration test, the hardening tests, the golden test and the exit tests, so `verify --resim` and the golden tests cannot drift apart): `SystemTime`, `VirtualTime` wiring with `setImmediate`, `optionsFromHeader(header, lines)` (bots from the header's controller labels and the `controller` lines as `handoffs`, clock spec, latency model), `normaliseLog(lines)` (drops `wall*` keys) and `normalisedHash`, the canonical JSONL reader and writer (gzip for `.jsonl.gz`), the golden check and add-only writer, and the ruleset fingerprint. The golden check and the fingerprint functions take the fixtures directory and the ruleset list as arguments, so a test can run them on a tampered copy or a modified descriptor.

### 12.2 Summary and batch table

`summarize(lines): MatchSummary` is a pure fold over log lines:

- winner, victory reason, end time (days); final standings with the controller of each seat (with its hand-offs from `controller` lines, e.g. `llm:x → bot:turtle@1 at D3 06:00`);
- battles, conquests, foundings, eliminations, sieges started/held/broken (`perfidia-1` events), alliances formed and left, pacts, betrayals, messages;
- **wake-ups per seat per game day**, split into urgent, own, social, safety and start, with deferred counts from `defer` lines;
- `INTERNAL` failures (from `gw` lines), which must be zero;
- round trips and calls per wake (mean and p95), rejections by code and by layer (`gw` or engine);
- engine events processed, turns, wall time, events per second, log size.

`batch` runs every variant over the same seeds and bots in lockstep (id keys from `idKeyFromSeed`, so every row is reproducible from its seed) and prints one row per variant (or per match with `--per-match`). Its JSON records, for each variant, the ref, the overrides, `configHash`, `rulesHash`, `ENGINE_VERSION`, the bot labels and the seeds, and for each match its final hash and end reason, so every row can be reproduced. The numbers below are illustrative only:

```
variant                        runs  winners (by strategy)            end day  battles  conquests  elims  wakes/seat/day (mean / max)
perfidia-1@1.0.0                 10  opportunist 4, rusher 3, …           7.0    212.4       14.1    1.2   17.3 / 26
fast: perfidia-1@1.0.0 time.protectionEnd=21600
                                 10  rusher 5, opportunist 3, …           6.6    251.0       18.7    2.0   18.1 / 27
sandbox-1@1.0.0                  10  rusher 6, expander 2, …              5.9    140.2       21.5    3.4   14.0 / 22
```

**Fight times.** Because counts alone hide _when_ a match starts fighting, every batch row also records, from its `ev` lines by event type (`sim/src/batch/fights.ts`, ruleset-agnostic): `firstBattleT`, `firstConquestT` and `firstEliminationT` (game-seconds of the first `battle`, `city_conquered` and `player_eliminated`, `null` when none), `dominationCountdowns` (the `domination_started` events, i.e. countdowns opened; a ruleset without domination, such as `sandbox-1`, has none) and `firstDominationT`. Each variant aggregates them: `reasons` (ended runs per end reason: `time`, `domination`, `last_standing`, `hill`, …), `firstBattle`, `firstConquest` and `firstElimination` (`{runs, mean, min}`: the runs that had one, the mean rounded to the second and the earliest), `runsWithElimination` and `runsWithCountdown`; and who eliminated whom: per match `eliminatedBy` (`<who> > <whom>`, the controllers of the seat that took the last city in that second and of the eliminated seat, e.g. `conqueror@1 > rusher@2`; `?` when no conquest took it), per variant `eliminationsBy` (counts, the fights table's last column). Every batch prints a fights table after its main table (per-variant or per-match); game times are printed on the game clock to the minute, `D1 13:12`, everywhere in the batch output, a mean over fewer runs than the variant has says so (`(4 of 6)`), and `--per-match` rows carry their own first battle, conquest, elimination and countdowns (`2 from D4 03:10`). Illustrative:

```
fights · game clock to the minute, mean / earliest over the runs that had one
variant           runs  ends                  1st battle (mean / min)  1st conquest (mean / min)     1st elim (mean / min)  runs with elim  runs with countdown  elims (who > whom)
base: perfidia-1     6  time 5, domination 1  D1 21:40 / D1 13:05      D2 09:10 / D2 01:30 (4 of 6)  -                                   0                    1  -
```

**Per seat, per bot, battles, land and countdowns** (`sim/src/batch/seats.ts`, `battles.ts`, `slots.ts`, `countdowns.ts`; everything from the log lines the batch already holds, no engine change, no replay). Every match row also carries:

- `seats`, one row per seat in seat order: `bot` (its controller at the end without `bot:`, e.g. `rusher@2`), `winner`, `rank`, `score` and `parts` exactly as the final standings give them (`perfidia-1`: `cityPoints`, `battleScore`; `sandbox-1`: `cityPoints`, `levelPoints`), then the components `cityPoints`, `levelPoints`, `crownPoints`, `battleScore` and `battlePoints`. A component the standings expose is taken as is; one they do not is derived from the log only, or left `null`: `crowns` counts the cities the seat took from no owner (`city_conquered` with `from: null`, the Crown in `perfidia-1`) and still holds, `crownPoints = crowns × scoring.crownBonus` and `levelPoints = cityPoints − scoring.cityBase × cities − crownPoints` (the `perfidia-1` §13.1 formula, read from the header's config, only when it has those keys), both `null` for an eliminated seat (its score is frozen with its last city, §9.7); `battlePoints` sums the `points` of one full `battle_report` per battle (credited points before the cap; `null` when the battles' reports carry none). Then `cities` at the end, `founded` (`city_founded`), `conquered` (cities gained by `city_conquered`, a retake included) and `lost`, `eliminatedAt`, `eliminatedBy` (the seat that took its last city) and `eliminations` (seats it eliminated).
- `battleSplit`: each public `battle` headline is joined to its `battle_report` copies (same second, city, attacker and kind; a ruleset emits its reports all before its headline, as `perfidia-1` does, or all after, as `sandbox-1` does, and the first battle of the log says which) and counted `defended` (a full report's defender stacks hold at least one unit), `empty` (none: a raid on an empty city) or `unknown` (no full report shows the defenders: every copy redacted, or a ruleset without stacks). A **relief** is a battle fought against the besieger of a city while its siege holds: the log opens a siege with the public `siege_started {city, owner, by}` and closes it with `siege_broken` or `city_conquered`, and a relief's headline names the besieger as its defender (kind `relief` in `perfidia-1`); a homecoming (kind `homecoming`: a return fighting its way into its besieged home) is counted apart. `relief`, `reliefByOwner` (launched by the besieged city's owner; the rest came from a third player) and `reliefBroke` (a `siege_broken` of the city followed in the same second) count them; `homecoming` counts the others.
- `freeSlots` (`null` unless the match ended): `initial`, `d5` (end of game day 5, `null` when the match ended before), `d7` (end of day 7, or the match end when it came earlier) and `end`. A city is only ever added, by a founding into a free slot, so these are the free slots of the initial world (created again from the header's setup) less the `city_founded` events so far, which are the numbers the pacing replay measures at each day's end (§13.9; a test checks it day by day on a bots golden).
- `countdowns`, one per `domination_started`: `key`, `members`, `bots`, `cities` and `threshold` as the event gives them, the bloc's cities at the start split into `conquered` (held by a member that took it by conquest), `founded` and `initial` (the rest: starting cities), and `outcome`: `won` (the match ended by domination at its `endsAt` with its members as winners), `cancelled` (with the event's `reason` and in `detail` the same-second events behind it, e.g. `p2 left a1 (betrayal)`, `c12 lost to p5`) or `open` (still running when the match ended), with `endedAt`.

Each variant aggregates them: `ends` (`{time, domination, lastStanding, other}`, always present, so domination and last-standing ends are counted apart even when zero), `countdowns` (opened, won, cancelled, open, cancellations by reason, and totals of the bloc cities at their start with their conquered, founded and initial ones), `battleSplit` (means per run), `freeSlots` (`d5`, `d7`, `end`: `{runs, mean}` over the runs that have one), and `strategies`, one row per bot label over the seats of the ended runs: `seats`, `wins` (seats among the winners: a bloc win counts for each of its seats), `winsPerSeat` with `winsPerSeatCi` (the 95% Wilson score interval), means per seat of the score, its components, cities, `founded`, `conquered` and `lost`, and totals of `crowns`, `eliminated` (suffered) and `inflicted`. After the fights table every batch prints the **ends and land** table, the **battles** table, the **bots** table and, when any countdown opened, the list of **domination countdowns**; `--per-match` adds **battles and land per match** and one row per seat (**seats**). Illustrative:

```
bots · per seat over the ended runs · wins/seat with its 95% Wilson interval · means per seat, eliminations in total
variant           bot            seats  wins  wins/seat [95% CI]   score  city pts  levels  crown  battle  cities  founded  conquered  lost  elims suffered  inflicted
base: perfidia-1  conqueror@1        3     0  0.00 [0.00, 0.56]    922.3     892.7   292.7    0.0    29.7     6.0      2.3        3.3   0.7               0          1
                  expander@1         6     2  0.33 [0.10, 0.70]   1095.5    1092.0   308.7    0.0     3.5     7.8      8.2        0.0   1.3               0          0

domination countdowns · bloc cities at the start: conquered / founded / initial · end: when won or cancelled, else when due
variant           seed  start     end       bloc                                  cities (threshold)  conquered / founded / initial  outcome
base: perfidia-1     1  D5 01:33  D6 01:33  a1: p1 expander@1 + p4 opportunist@1  12 (12)             0 / 10 / 2                     won
```

**Teamwork** (`sim/src/batch/teams.ts`, from the log lines alone; `perfidia-1` measures, which other rulesets show as zeros). Every match row also carries:

- `joint`: the **joint attacks**, battles at one city by attackers of at least two players in the same alliance at the time, landing within 60 minutes of each other (`JOINT_WINDOW`; a chain of waves is one joint attack, homecomings never count): first and last landing, city, defender, attackers and their controllers, battles, and `caller`, the attacker whose war call (`WAR#` call naming the city, `bots/src/war.ts`) went to another attacker within the day before, or `null`. Private messages are in the log with their text (spectators see them, `perfidia-1` §12), so callers are known.
- `sieges`: every siege (`siege_started` to `city_conquered` or `siege_broken`, or still open at the end): city, owner, besieger and its controller, `joined` (groups that joined the garrison after the start: the besieger's supports and later waves, from `support_arrived`), `sent` (supports the besieger launched to the city during the siege, from its accepted `act` lines), `reliefs` and `homecomings` fought against the garrison, and `outcome` (`conquered`, the `siege_broken` cause `relief`, `homecoming`, `abandoned` or `eliminated`, or `open`).
- `warCalls`: calls sent (one per call, whatever the recipients), calls answered by a recipient, answers yes and no, cancels by the caller, and `stray` tags (an answer from a non-recipient, a cancel by anyone else, a public tag); `warCallers` counts calls and answers per sender controller.
- `r1`: how near a bloc (an alliance, or a player outside any) came to the R1 domination rule of `perfidia-1@1.1.0` §13.3, with the match's own numbers (a 1.0.0 log: 1.1.0's defaults, `R1_SHARE_PM` 350 and `R1_CONQUERED` 2, with the log's floor and timers): the map's city `slots` (every island's, from the header's setup), `need = max(dominationMinPerPlayer × N, ceil(pm × slots / 1000))` (16 at 6 seats, 18 at 8, 26 at 12 with the defaults) and `needTaken`, the largest bloc at any time (`maxCities`, `maxConquered` of them taken, `maxAt`, `maxBloc` controllers), `fightingMax` (the most cities a bloc held while `needTaken` of them were taken) and `shortfall` (`need − fightingMax`), `mostConquered`, `reachedAt` / `reachedBy` (the first time a bloc met R1) with `takenFromBloc` (the cities of that bloc one member had conquered from another, which R1 does not count), and `heldAt`, when a bloc first held R1 for `dominationHold` from the opening on, ending by `matchEnd`. A city is taken for its owner's bloc when the owner conquered it and no member of the bloc ever owned it. The batch table prints `need` and `taken` per variant (`-` when its runs differ).

Each variant aggregates them as `team` (joint attacks per run, runs with one, total and after a call; war-call totals; sieges reinforced, relieved, conquered, broken by a relief, abandoned and other; R1 runs met, means of the largest bloc's cities and conquests, and of `fightingMax` over the runs that had one) and `teamBots`, one row per bot label (joint attacks called and joined, sieges as the besieger, war messages sent). After the bots table every batch prints a **teamwork** table and a **sieges and teamwork by bot** table (an `all` row, then one per besieger); `--per-match` adds **teamwork per match**. With the default bots (`bun run sim -- batch --variant "base: perfidia-1" --seeds 1-3 --players 6 --pacing`, before any bot uses the war-call protocol):

```
teamwork · joint attack: battles at one city by ≥ 2 players allied at the time, landing within 60 min · war calls: private WAR# messages · R1: a bloc with ≥ 40% of the map's city slots, ≥ 2 of them conquered
variant           runs  joint attacks/run  runs with one  after a call  war calls  answered  yes  no  cancels  R1 need  R1 met  largest bloc: cities / conquered  bloc with ≥ 2 conquered: cities (runs)
base: perfidia-1     3               0.00              0             0          0         0    0   0        0       18  0 of 3  16.7 / 0.00                       -

sieges and teamwork by bot · totals over the runs · reinforced: the besieger sent a support or a later wave joined its garrison · other: a homecoming, the besieger eliminated, or still open at the end · joint: attacks called (by a war call) and joined (all: joint attacks in total)
variant           besieger     sieges  reinforced  relief came  conquered  broken by relief  abandoned  other  joint: called  joined  war calls  yes / no
base: perfidia-1  all              21  10 (48%)    19 (90%)     2 (10%)    19 (90%)          0          0                  0       0          0  0 / 0
                  conqueror@2       4  4 (100%)    3 (75%)      1 (25%)    3 (75%)           0          0                  0       0          0  0 / 0
                  expander@2        2  1 (50%)     2 (100%)     0          2 (100%)          0          0                  0       0          0  0 / 0
                  rusher@3         13  5 (38%)     12 (92%)     1 (8%)     12 (92%)          0          0                  0       0          0  0 / 0
                  turtle@2          2  0           2 (100%)     0          2 (100%)          0          0                  0       0          0  0 / 0
```

The batch JSON carries `format: "perfidia-batch/<n>"` (`BATCH_FORMAT`); `n` is bumped whenever the JSON shape changes, so a reader can tell which fields to expect. `perfidia-batch/2` added the fight times above, the end reasons and the per-day conquests and eliminations of the pacing rows; `perfidia-batch/3` added who eliminated whom; `perfidia-batch/4` added the seats, battle split, free slots and countdowns of each match, and per variant the end counts, countdown totals, battle split and free-slot means and the per-bot rows; `perfidia-batch/5` added the teamwork of each match (`joint`, `sieges`, `warCalls`, `warCallers`, `r1`) and per variant `team` and `teamBots`.

`batch --pacing` replays each run through `verifyLog` with `onCheckpoint` and adds the per-day pacing table of §13.9. This is how rules get tuned with bots before any LLM spend.

**Reading a bot batch.** Every number of a batch measures the rules and the bots together, so variants are compared within one bot composition only (`--bots`, versions included), and an older composition is rerun with `name@n` (`--bots expander,rusher@1,turtle,opportunist`: the phase-1 bots). With the default bots of the build whose latest rusher was `rusher@2`, on `perfidia-1@1.0.0` (lockstep, 7 days, seeds 11–20 at 6 and 8 seats, seeds 1–6 at 6 seats; `rusher@3`'s own figures are in its row of §11.2):

- Eliminations are almost all `conqueror@1 > rusher@2` (11 of 13; one `rusher@2 > rusher@2`, one `conqueror@1 > opportunist@1`). The conqueror goes for the fewest cities, and `rusher@2` settles a second city only once no colony is in reach, so the one-city rusher is its prey; whether a run has an elimination depends on how near the two seats are (3 runs of 10 at 6 seats, 6 of 10 at 8 seats, 3 of 6 on seeds 1–6). An elimination rate measures that pair more than the rules: read it with the `elims (who > whom)` column.
- Domination countdowns are rare: one in 26 runs (seed 1 at 6 seats, an expander and an opportunist allied once the rusher was gone). No bot builds a bloc that holds the threshold on purpose, so a `time.dominationStart` comparison says little with these bots.
- At 6 seats the cycle holds one rusher and one conqueror (the phase-1 default had two rushers): 36.7 battles a run against 64.4 for the phase-1 bots on seeds 11–20, with the first battle at D1 15:25 against D2 07:23 on average.

---

## 13. Testing strategy

All tests use `bun:test` and live next to the code as `*.test.ts` under `src/`; `fast-check` drives the properties. Long tests set explicit per-test timeouts.

- **Default suite** (`bun test`, part of `bun run check`, so of the CI `check` job): stays under about 90 s. Every match-length test in it runs **1 game day** (`time.matchEnd=86400`), except the golden replays of `packages/sim/src/golden.test.ts` (§13.5), which run in it on purpose: the freeze guard must hold on every `bun test`, not only in the exit job or the merge gate.
- **Exit suite** (`bun run test:exit`, i.e. `PERFIDIA_EXIT=1 bun test packages/sim/src/exit`): the 7-day exit runs of §13.7. Its tests skip unless `PERFIDIA_EXIT=1`. CI runs it as a separate job with its own timeout.

### 13.1 Unit tests

- `core`: FNV-1a 64/32 and SHA-256 vectors; mulberry32 golden outputs; `randInt`, `shuffle`; `isqrt`, `ipow`, `ceilDiv`, `rdiv`, `mulDiv`, `lossPm`, `cas` against BigInt or exhaustive oracles; canonical JSON rejections; `opaqueId` is a bijection (no collision over every owner and the first 2¹⁶ counters, stable vectors) and changes completely with the key; `fmtTime(0) = "D1 00:00"`, `fmtTime(604800) = "D8 00:00"`, `fmtTime(223370) = "D3 14:02:50"`, and the `fmtDuration` vectors of §7.3.
- `std`/`domain`: one table test per rule and per violation code (numbers right, `availableAt` right); queue chaining, cancel by item and refunds (build pro rata; a recruit batch cancelled mid-unit refunds the unit in training at 100%); trickle and batch delivery; loss allocation by largest remainder; a queued wall item completing after a breach.
- `perfidia-1`: §8.12 and §9.8 worked examples as exact engine tests (the split stack and the homecoming included); §15.2 D values; cheat sheet equals §0 verbatim for the defaults; config validation rejects each rule of §16 "Validation"; map fairness (§2.5) with fast-check over seeds for N = 6..12 plus the exhaustive sweep of `rot` and jitter extremes.
- `sandbox-1`: map, capture, disbanding, hill victory at the `hill_open` timer, extra tools.
- Gateway: one explain snapshot per code; the `interface` block snapshot; briefing fixture within budget; `rules` and `view_map` size budgets; wake scenarios (both budgets, urgent gap, urgent during a turn, grouping, self-wake kept across an urgent wake); driver tests against `FakeHost`.

### 13.2 Property tests

| Id  | Property                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | The event queue pops in `(at, cls, seq)` order under random schedule/cancel sequences.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| P2  | Accrual is path-independent: any split of an interval gives the same stock.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| P3  | `validate`, every derivation and every gateway view leave the canonical state byte-identical; a rejected action leaves the hash unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| P4  | For each ruleset: random sequences of action intents (resolved against the current state so most are valid, plus junk) and time advances never throw (except `EngineMisuse` on purpose) and keep step-level invariants. The intents include alliances between pact partners and recalls with several stationed groups.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| P5  | `advanceTo(a); advanceTo(b)` ≡ `advanceTo(b)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| P6  | Snapshot round trip keeps the hash; resuming from a snapshot and continuing equals the uninterrupted run, with a non-empty override set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| P7  | A log recorded from a random run replays with zero divergence; tampering with any `a`, `r`, order, `ev` or `ckpt` is reported at the right `n` or hour.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| P8  | Canonical JSON ignores key insertion order and throws on non-integers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| P9  | Shuffling the insertion order of every record of a state changes neither its hash nor the results and events of the next steps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| P10 | **Fog non-interference at one state**: for states that differ only in data hidden from seat X, X's views, briefing, tool results and errors are identical (UNKNOWN_ID for a hidden id reads exactly like a missing one). The perturbations add, remove or change hidden entities and other owners' id counters, but never change the id of an entity X can see. An ally's view of a city shows the owner's outgoing movements exactly as `movementAccess` grants: never in `perfidia-1`, in full in `sandbox-1`.                                                                                                                                                                                                                                                                                                             |
| P11 | Wake scheduler model test (§8.5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| P12 | Fuzzed tool arguments (`fc.anything()`) always produce a schema-valid `ToolResult`, never an exception.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| P13 | Combat: survivors + losses = initial per stack and per group; adding attackers never lowers attacker strength; walls never help the attacker.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| P14 | Overrides: any valid override set resolves, and the hash changes iff the effective config changes; invalid overrides (schema or compile checks) are rejected with a path; a fixed field cannot be overridden.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| P15 | **Transition non-interference**: (a) perturbing data hidden from X before a step leaves X's copies of the step's non-intel events (§8.6: standard intel types and the ruleset's `intelEvents` are exempt) identical, after every opaque id not owned by X is replaced by a placeholder of its kind and the copies are compared as a multiset. Other owners' id counters are hidden data, so the ids they mint during the step legitimately differ; the keyed permutation of §4.1 is what makes them carry no information, and the order of entities sorted by such ids is just as uninformative. (b) Inserting hidden-only actions by other seats (private messages between others, spies, supports and shipments between others, builds, recruits) before X's calls leaves every result X receives identical, ids included. |
| P16 | **Boundary copies**: mutating any object received from the engine or the gateway (events, results, briefings, snapshots) never changes the state hash, the log or another seat's view.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| P17 | **Coexistence**: matches interleaved in one process give the same normalised logs as each match run alone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

### 13.3 Invariants (framework in `kernel/invariants.ts`)

- Kernel (structural): queue sorted with unique seqs; no event before `now`; for **domain kinds**, every pending event's `ref` exists and points back to it (`arrive_*` to `movement.seq`, `build_done` and `recruit_done` to the item's `seq`, `proposal_expire`, `pact_expire`); every movement has exactly one arrival event; every queue item has its event; id counters above every used id; status/result consistent; every emitted event has a known type and valid data (§8.6); at checkpoints, `ruleset.extSchema` parses `state.ext`. Rulesets cover their own event kinds in `hooks.invariants`.
- `std` (domain): every number in the state is a safe integer ≥ 0 (coordinates excepted); stock ≤ cap × scale; pop reserved by recruit batches equals `count × popEach`; **unit conservation** per owner and unit type: home + stationed + in movements = `ledger.made − ledger.gone`; stationed groups non-empty and sorted; `(island, slot)` unique and below `slots`; eliminated players own nothing; every `attack` movement lasts ≥ `minTravel` (`arriveAt − departAt`, backing up the creation check of §3.6). The `minTravel` floor of a return turned back into a held home (§5.4) is covered by `std` and ruleset unit tests.
- `domain` diplomacy (only while the ruleset keeps the default `propose`/`answer`/`leave`): alliance membership symmetric with `player.alliance`, alliances ≤ `allianceMax`; pacts sorted, unique, between non-allies.
- `perfidia-1`: every siege has a `hold` garrison with ≥ 1 settler; besieged cities have empty queues; every `siege_end` and `domination_end` event matches its `ext` record; countdown membership matches the bloc.
- Levels: `off`, `checkpoint` (default in `sim`), `step` (tests). A mutation test plants about ten kinds of corruption and checks each is caught.

### 13.4 Determinism, coexistence and the ruleset boundary

- The same setup twice gives byte-identical normalised logs: lockstep, and real time under `VirtualTime`, for both rulesets.
- The same comparison across **two separate `bun` processes** (catches hidden module state).
- **Coexistence** (P17): in one process, three matches interleaved with `Promise.all`, under lockstep and under `VirtualTime`: a `perfidia-1` match, a `sandbox-1` match and a second `perfidia-1` match with the same config and another seed. Each normalised log equals the same match run alone. `batch` run twice with the variant order reversed gives the same results.
- Every log produced by any test passes Level E, including system-time runs.
- **Boundary scan.** A test fails when non-test sources in engine `core`, `contracts`, `kernel`, `std` and `domain`, in `gateway/src`, or in `bots/src` (except `hints.ts`) contain a string literal naming a building, unit or queue id of any ruleset of `RULESETS`, at any allowed N (`build` excepted, the generic queue), or a ruleset id.

### 13.5 Golden logs (freeze guard, part 1)

`packages/sim/fixtures/golden/<ref>/<name>.jsonl` (gzip-compressed as `.jsonl.gz` above 1 MB), per published ruleset ref, plus `sandbox-1`:

| Ref                | Golden                           | What it covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `perfidia-1@1.0.0` | `lockstep-6p-4d`                 | default config, four bots, 4 game days: past capital immunity (172800) and the domination opening (259200)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
|                    | `rt-virtual-6p-1d`               | real time under `VirtualTime`, speed 3, latency 2–60 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
|                    | `scenario-late`                  | a scripted scenario agent playing through the gateway with time-compressing overrides (for example `time.protectionEnd=0 time.capitalImmunityEnd=3600 time.siegeDuration=3600 time.pactDuration=7200 time.dominationStart=7200 time.dominationHold=3600`, plus victory thresholds low enough for the scenario): a siege, a relief, a homecoming, a capital conquest with fallback re-homing, an elimination, a pact expiry, a pact superseded by an alliance, a domination start, cancel and win, within a few game hours. Overrides change only numbers, so the code paths are those of the defaults. |
|                    | `lockstep-12p-1d`                | default config, four bots, 12 seats (the largest N), 1 game day: the seat-count dependent setup (the map without hubs, `homeRadius`, the tie-break order) replayed at N = 12                                                                                                                                                                                                                                                                                                                                                                                                                           |
|                    | `lockstep-6p-4d-bots-3cd67627`   | the same match with the default bots of PR #7 (`expander@1`, `rusher@2`, `turtle@1`, `opportunist@1`, `conqueror@1`): sieges, conquests and an elimination played by bots                                                                                                                                                                                                                                                                                                                                                                                                                              |
|                    | `rt-virtual-6p-1d-bots-3cd67627` | `rt-virtual-6p-1d` with the PR #7 bots                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
|                    | `lockstep-12p-1d-bots-c5bd73c9`  | `lockstep-12p-1d` with the PR #7 bots (battles on day 1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
|                    | `lockstep-6p-4d-bots-9ac064bb`   | the same match with the default bots of PR #8 (`expander@2`, `rusher@3`, `turtle@2`, `opportunist@2`, `conqueror@2`): sieges, conquests, a siege broken by a relief battle and a domination countdown played by bots                                                                                                                                                                                                                                                                                                                                                                                   |
|                    | `rt-virtual-6p-1d-bots-9ac064bb` | `rt-virtual-6p-1d` with the PR #8 bots                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
|                    | `lockstep-12p-1d-bots-24a01286`  | `lockstep-12p-1d` with the PR #8 bots (battles on day 1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
|                    | `lockstep-6p-4d-bots-aeaf1d12`   | the same match with the default bots of this build (`DEFAULT_BOTS`, every strategy at its latest version: `expander@2`, `rusher@3`, `turtle@3`, `opportunist@3`, `conqueror@3`, the war-call bots): sieges, a siege broken by a relief battle and a domination countdown played by bots (no conquest in these 4 days: every siege is relieved; `lockstep-6p-6d-war` has conquests by them)                                                                                                                                                                                                             |
|                    | `rt-virtual-6p-1d-bots-aeaf1d12` | `rt-virtual-6p-1d` with the default bots                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
|                    | `lockstep-12p-1d-bots-52f1a52b`  | `lockstep-12p-1d` with the default bots (battles on day 1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
|                    | `lockstep-6p-6d-war`             | the war-call bots allied as in the decision batches (`conqueror@3,opportunist@3,turtle@3,conqueror@3,expander@2,rusher@3`, seed 33, 6 game days): `conqueror@3` answering an `opportunist@3`'s strike calls yes and keeping its word, joint attacks after a call, `turtle@3` answering a `conqueror@3`'s `siege` call yes, conquests held by an ally                                                                                                                                                                                                                                                   |
| `perfidia-1@1.1.0` | `lockstep-6p-4d`                 | the 1.1.0 defaults with the default bots of its release (`DEFAULT_BOTS`), 4 game days: sieges, capital immunity, and the domination opening (259200) without a countdown, since these bots take no city in 4 days and a bloc needs taken cities (ruleset §13.3)                                                                                                                                                                                                                                                                                                                                        |
|                    | `rt-virtual-6p-1d`               | real time under `VirtualTime`, speed 3, latency 2–60 s, with the default bots                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
|                    | `lockstep-12p-1d`                | 12 seats (the largest N), 1 game day, with the default bots (battles on day 1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
|                    | `lockstep-6p-6d-war`             | the war-call lineup of the 1.0.0 golden, seed 14: of seeds 1–30 over 6 days, the first whose countdown ends in a domination win (seed 11's starts on day 6 and is still open at the end): a `conqueror@3` pair takes 2 cities, starts its countdown on day 5 with 16 cities, 2 of them taken, still qualifies after losing another city to `expander@2`, and wins on day 6, so domination by conquest and the conquest records in the views are under Level G                                                                                                                                          |
|                    | `scenario-r1`                    | a scripted scenario (`sim/src/exit/scenario_r1.ts`, label `scenario:r1@1`, number-only overrides, threshold 6 cities with 2 taken): an alliance holding 6 cities with 1 taken (no countdown), then 7 with 2 (a countdown), a recapture by the former owner that cancels it (`condition`), Olympus taken from no owner, and the domination win 4 hours later                                                                                                                                                                                                                                            |
| `sandbox-1@1.0.0`  | `lockstep-6p-3d`                 | past `hill_open` (172800)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
|                    | `rt-virtual-6p-1d`               | as above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
|                    | `lockstep-6p-3d-bots-3cd67627`   | `lockstep-6p-3d` with the PR #7 bots                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
|                    | `rt-virtual-6p-1d-bots-3cd67627` | as above, with the PR #7 bots                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
|                    | `lockstep-6p-3d-bots-9ac064bb`   | `lockstep-6p-3d` with the PR #8 bots                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
|                    | `rt-virtual-6p-1d-bots-9ac064bb` | as above, with the PR #8 bots                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
|                    | `lockstep-6p-3d-bots-aeaf1d12`   | `lockstep-6p-3d` with the default bots                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
|                    | `rt-virtual-6p-1d-bots-aeaf1d12` | as above, with the default bots                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

- **Level E** of every golden runs in every `bun test`, forever, through `packages/sim/src/golden.test.ts` (T17; default suite, outside `exit/`). It replays logged actions, so it does not depend on the bots. The test walks `fixtures/golden/**`, runs Level E on each golden and Level G when it replays and its labels exist (a re-simulation that throws is reported as that golden's problem), recomputes the fingerprints of §13.6, and asserts that every published ref in `RULESETS` has at least one golden and a fingerprint entry, and that every golden a fingerprint entry records is still on disk (a deleted golden fails the guard). It also runs the same checks on a tampered temporary copy of a golden and on a `perfidia-1` descriptor whose cheat sheet is altered, and asserts that both fail.
- **Level G** runs only for goldens whose controller labels all exist in the current bots registry (the scenario agents are not registered bots, so `scenario-late` and `scenario-r1` are Level E only). A bot behaviour change bumps its label (§11.1); the new label gets new goldens, and the old ones keep their Level E check and, since the registry keeps every published version, their Level G check too.
- **Append-only**: `sim golden --update` writes only goldens that do not exist yet (a new ref or a new bot label). Nothing rewrites a committed golden, whatever `ENGINE_VERSION` says. A log-format change keeps a reader for the old format. CI enforces it on pull requests (the `append-only` job): no file under `fixtures/golden` of the base branch may be modified, renamed or deleted, and `sim golden --check --base <base fingerprints.json>` fails when an entry of the base branch's `fingerprints.json` was rewritten or removed (new refs and new golden entries are allowed).

### 13.6 Ruleset fingerprints (freeze guard, part 2)

`packages/sim/fixtures/fingerprints.json` maps each published ruleset ref to:

- `artefacts`: `sha256Hex(canonicalJson({title, defaults, configSchema, compiled, cheatSheets, worlds, errors, tools, events, intelEvents}))`, where, for every N in `players(defaults)`, `compiled[N] = compile(defaults, N)`, `cheatSheets[N] = cheatSheet(defaults, compiled[N])` and `worlds[N]` is the state hash of a match created with seed 1 and `idKeyFromSeed(1)` (so `createWorld` and the initial `ext` are covered at every N, not only at the goldens' N); `errors` is every `ruleset.errors` explainer rendered on the ruleset's `errorSamples` with core `fmt`; `tools` lists every extra tool's name, family, kind, description and argument JSON Schema; `configSchema` and `events` are the JSON Schemas of the config and of the ruleset's own event types.
- `goldens`: the final hash of each committed golden at Level E.
- `views`: for each committed golden, the fingerprint of what the ruleset's hooks show agents during its match: at every checkpoint of its Level E replay, for every seat, the briefing extras, the public city, player and match extras, every player's relations, every city's and movement's access (as the gateway resolves the hooks with the `std` defaults), the standings, and every argument-less read extra tool (`sim/src/harness/fingerprint.ts`, `checkpointView`).

`golden.test.ts` recomputes all three in the default suite. A mismatch means a core or ruleset change altered a published version (§3.5). Entries are append-only, like the goldens. The gateway's own agent-visible text and rendering (the `interface` block, the tool descriptions of `toolDefinitions`, the briefing and view shapes) is versioned with `ENGINE_VERSION` and covered by snapshot tests instead, so the `views` fingerprint hashes the hooks' outputs, not the gateway's rendering of them.

### 13.7 Phase-1 exit criterion (`packages/sim/src/exit/exit-criterion.test.ts`, exit suite)

For **each** of `perfidia-1@1.0.0` and `sandbox-1@1.0.0`, with 12 seats (3 of each strategy), 7 game days, and `--override time.dominationStart=604801` for `perfidia-1`, so that the full 7 days normally run (an earlier last-standing or hill end is accepted and reported). 604801 is after `matchEnd`, so `domination_open` never fires; 604800 would fire it in the last second, in class 10 before `match_end`:

1. **Lockstep**: no `fatal`, no `INTERNAL` `gw` line, ends at `matchEnd` (or by a legitimate victory), checkpoint invariants with the hourly hash checks, Level E zero divergence, and a second run whose normalised log hash is identical.
2. **Real time, virtual clock** (speed 3, latency 2–60 s per round): the same expectations.
3. **Real time, system clock** at a very high speed: completes and passes Level E.
4. Drama minimum for `perfidia-1` lockstep: at least one battle and one alliance (required); conquests and betrayals reported.
5. **Published defaults**: one more `perfidia-1@1.0.0` lockstep run, 12 seats, 7 days, **no override**, so domination from day 4 runs at full scale: no `fatal`, no `INTERNAL`, Level E zero divergence, domination closed before t = 259200 and open at every checkpoint from then on; a domination end is accepted and reported. A further run of the same config with only the threshold lowered (`victory.dominationPm=110`, `victory.dominationMinPerPlayer=0`), which the bots reach, must start countdowns and cancel them or end by domination, so the whole domination path runs at full scale.

The default suite already runs these scenarios over 1 game day (the integration test of T14), without the drama minimum. The exit job's output (all clocks, both rulesets, with the performance figures) is attached to the final task's report.

### 13.8 Performance budget

| Scenario                                                            | Target  | CI limit |
| ------------------------------------------------------------------- | ------- | -------- |
| Lockstep, perfidia-1, 12 seats, 7 days, bots, checkpoint invariants | ≤ 5 s   | 20 s     |
| Real time under `VirtualTime`, same match, speed 3                  | ≤ 10 s  | 40 s     |
| Level E replay of a 7-day log                                       | ≤ 3 s   | 15 s     |
| Full state hash at day 7                                            | ≤ 10 ms | –        |
| Briefing build (p95)                                                | ≤ 1 ms  | –        |
| Default `bun test` suite                                            | ≤ 90 s  | –        |

The exit tests print these figures. Missing a target is reported before any design change.

### 13.9 Pacing report (`perfidia-1` §19.5)

`sim batch --pacing` replays each run with `verifyLog(…, {onCheckpoint})` and prints, per game day and per N: cities per player (mean, min, max), free slots left, army pop, score, battles, conquests, eliminations, and sieges started, held and broken. The final task runs it for N = 6, 8 and 12 with the four bots and attaches the report. The §19.5 criteria are **reported, never asserted**: bots alone may miss them, and a missed criterion becomes a proposal for `perfidia-1@1.1.0`, never a change to 1.0.0.

---

## 14. Risks and open questions

**Open questions (the default assumed here is in parentheses):**

1. **Archive tool** (search folded into `read_notes` with a scope over the archive and the public feed; a dedicated `search_archives` can come in phase 2).
2. **Config hash function** (SHA-256 as `perfidia-1` §16 says; state hashes use FNV-1a 64 for speed). If one hash function is preferred, FNV-1a 64 can replace SHA-256 at the cost of the ruleset's wording.
3. **Second ruleset** (`sandbox-1`, a deliberately different tiny ruleset; a `perfidia-1` variant would prove less).
4. **Lockstep fairness**: within a batch, later seats see earlier seats' writes; the seeded rotation keeps it fair on average.
5. **Wake budgets** (own 12 + social 8 per day, urgent gap 600 s, from the ruleset); phase-1 summaries measure the real rates by class before any LLM spend.
6. **Opaque ids** (5 characters after the prefix, keyed by a per-match secret): LLMs quote them less easily than `m41`. Phase 2 will show whether that matters; the alternative, per-viewer aliases, would break ids quoted between players. The 24-bit domain resists decoding by an agent that knows its own ids, but it is a small-domain permutation, not a proven cipher. If later harnesses with code execution (Claude Code, Codex) need more, a wider id (more characters) is a log-format change gated by a new `MatchSetup` field, so old logs keep replaying.
7. **Tool schemas under provider strict modes** (each tool is a root object, §3.7). `units` is a record (`additionalProperties` of integers), and `recruit.orders[].count` and `send_message.to` hold inner unions. OpenAI's strict mode, for one, requires every property listed and `additionalProperties: false`, which a record cannot meet. Phase 2 checks `toolDefinitions` against each provider (Anthropic, OpenAI, Gemini) and, if needed, adds an alternative optional field (a list of `{unit, count}`), following the evolution rule.
8. **Phase 2 has 4 LLM agents on a small map**, but `perfidia-1@1.0.0` fixes `players` to 6..12 and `homeRadius` covers only 6..12. Default plan: a mixed N = 6 match, 4 LLM seats plus 2 bots, which `RunMatchOptions.agents` already supports. The alternative is a new version or ruleset with players 4..12 and `homeRadius` entries for 4 and 5.

**Risks and mitigations:**

- **Hidden nondeterminism** (key order, sorting, module state, floats, implementation-approximated maths, locale and Unicode tables, materialising reads, aliasing): iteration rules, the lint and source-scan bans of §2.4, canonical JSON throwing on floats, boundary copies, P3, P9, P16, P17, the two-process test.
- **Information leaks** (id gaps, sender copies of events, raw battle points): opaque private ids, per-recipient payloads, public score parts only, P10 and P15.
- **Core drift under published rulesets**: append-only goldens verified at Level E and fingerprints of agent-visible artefacts per published version, kept forever; no `ENGINE_VERSION` escape.
- **The ruleset boundary leaking** (core code testing `rules.ruleset === "perfidia-1"` or hard-coding `"barracks"`): forbidden; `sandbox-1` differs on every axis and must pass the same suites; the boundary scan test; lint enforces imports.
- **Integration drift between parallel tasks**: exact signatures here; a merge gate after every wave (§15.1); one integration task with fix rights; the last tasks own cross-package fixes.
- **Virtual time with hidden real I/O**: synchronous sinks, bots without I/O, the deadlock error, cancellable sleeps.
- **Tooling assumptions** (import plugin categories, per-override options, `exports` subpaths under the isolated linker): T01 verifies each with a probe before other tasks rely on it, and runs first.
- **Boring bot matches**: the `perfidia-1` lockstep exit run requires at least one battle and one alliance and reports conquests and betrayals (§13.7); the final task tunes the bots, never the published ruleset.
- **Overrides that pass the schema but break a match**: the generic config checks and the creation travel check of §3.6 reject them with a path before the header is written (P14 cases in T04 and T06).
- **Crash resume in phase 2**: real-time matches last days; `rebuildGatewayState` plus Level E replay rebuild everything from the log, and a test compares the rebuild with the live state (§10.5).
- **Test time**: 1-day variants in the default suite, the 7-day runs in a separate exit job.

---

## 15. Task breakdown

### 15.1 Rules for every task

- **Step 0 (orchestrator, before any task, after the user has reviewed these docs).** Today only `CLAUDE.md` and `docs/brief.md` are tracked: the scaffold is untracked, so a worktree would contain none of it. The orchestrator commits the scaffold and the docs to the integration branch (root configs, `bun.lock`, `packages/*` without `node_modules` and build info, `.github/`, `docs/architecture.md`, `docs/rulesets/**`), then checks that a fresh worktree passes `bun install --frozen-lockfile && bun run check`. Only then does it create the wave-1 worktree.
- **Worktrees.** Each task runs in its own git worktree branched from the integration branch after the previous wave's merge, and owns exactly the files listed. Within a wave, owned files are disjoint; ownership of a path can pass to another task in a later wave.
- **Dependencies.** The orchestrator runs `bun install --frozen-lockfile` in every new worktree before handing it over, so `bun run check` works. Tasks never run `bun install` or `bun add` (as `CLAUDE.md` says) and need no new dependency: `zod` reaches the engine through `protocol`, and `sim` uses Bun built-ins. A task fails if `git diff --exit-code bun.lock` reports a change.
- **Root files.** Only T01 edits `.oxlintrc.json`, `.oxfmtrc.json`, the root `package.json` scripts, the `exports` maps of package manifests and the `tsconfig*.json` files of packages. Only T17 edits `.github/workflows/ci.yml`.
- **Placeholders** (§2.2). The task that first rewrites a package barrel deletes that package's `*_UPSTREAM` constant and placeholder test and keeps `*_PACKAGE` (T01 bots, because its new lint forbids `BOTS_UPSTREAM`'s runtime import of `gateway`; T02 protocol, T03 engine, T14 gateway, T15 sim, which also deletes `SIM_PACKAGE`). T17 removes the remaining `*_PACKAGE` constants once nothing imports them. New code never imports a `*_PACKAGE` constant.
- If a shape you need is missing or wrong in a file you do not own, define a local type, report the deviation, and do not edit the upstream file. Tasks with fix rights (T14, T16, T17) say so explicitly; a fix right covers bugs, and each fix is reported with its cause.
- Import other groups through their public paths (`@perfidia/engine/std`, `@perfidia/gateway/seat`, …), never through deep relative paths into another task's files.
- Run `bun run check` before finishing and report its output honestly. After editing markdown, run `bun run format`. No `git commit`, `git push` or branch creation.
- **Merge gate (orchestrator).** After each wave, the orchestrator merges the wave's branches in task-id order and runs `bun install --frozen-lockfile && bun run check` (from wave 7 on, also `bun run sim -- golden --check`). A red merge spawns a fix task, with rights over that wave's files, before the next wave starts.

| Wave | Task | Title                                                   | Package(s)           | Depends on                        |
| ---- | ---- | ------------------------------------------------------- | -------------------- | --------------------------------- |
| 1    | T01  | Tooling: purity and determinism guards, layers, exports | root, bots config    | –                                 |
| 2    | T02  | Protocol schemas and engine contracts                   | protocol, engine     | T01                               |
| 2    | T03  | Engine core primitives                                  | engine               | T01                               |
| 3    | T04  | Engine kernel and testing kit                           | engine               | T02, T03                          |
| 3    | T05  | Engine std: derivations and primitives                  | engine               | T02, T03                          |
| 3    | T06  | perfidia-1: config, world and pure rules                | engine               | T02, T03                          |
| 3    | T07  | Gateway seat logic: wakes, caps, notes, archive, feed   | gateway              | T02, T03                          |
| 3    | T08  | Gateway clocks                                          | gateway              | T02, T03                          |
| 3    | T09  | Bots                                                    | bots                 | T02                               |
| 4    | T10  | Engine domain handlers and bound API                    | engine               | T04, T05                          |
| 4    | T11  | perfidia-1: mechanics hooks and descriptor              | engine               | T04, T05, T06                     |
| 4    | T12  | sandbox-1 ruleset                                       | engine               | T04, T05                          |
| 4    | T13  | Gateway presentation                                    | gateway              | T04, T05, T06, T07                |
| 5    | T14  | Gateway runtime, registry, sim harness and integration  | gateway, engine, sim | T07, T08, T09, T10, T11, T12, T13 |
| 6    | T15  | sim CLI: run, verify, batch, summary, golden            | sim                  | T14                               |
| 6    | T16  | Cross-ruleset hardening and gateway rebuild             | sim, gateway, fixes  | T14                               |
| 7    | T17  | Exit criterion, freeze artefacts, pacing report, CI     | sim, CI, fixes       | T15, T16                          |

Critical path: T01 → T02 → T04/T05 → T10/T11 → T14 → T16 → T17. Goldens and fingerprints are generated last, after every fix, because any later behaviour change would invalidate them; the log format (every line kind of §10.2, `defer` and `controller` included) and the opaque-id scheme are fixed before that for the same reason.

### 15.2 Wave 1

**T01 — Tooling: purity and determinism guards, engine layer rules, exports, scripts.**

- Owns: `.oxlintrc.json`; `.oxfmtrc.json` (`ignorePatterns` only); root `package.json` (scripts only: `"sim": "bun packages/sim/src/cli.ts"` and `"test:exit": "PERFIDIA_EXIT=1 bun test packages/sim/src/exit"`); `packages/engine/package.json` and `packages/gateway/package.json` (`exports` only); `packages/bots/tsconfig*.json` (split into `tsconfig.lib.json` with `lib: ES2024, types: []` excluding tests, `tsconfig.test.json` with Bun types, and a solution `tsconfig.json`, like the pure packages); `packages/bots/src/index.ts` and `packages/bots/src/index.test.ts` (only to delete `BOTS_UPSTREAM` and the placeholder test; keep `BOTS_PACKAGE`); the `tsconfig*.json` of `protocol`, `engine`, `gateway` only if a probe proves a change is needed; `packages/sim/src/architecture.test.ts` (mandatory source scan).
- Do: implement §2.4 (lint and source scan), the layer matrix of §2.3 and the `exports` maps of §2.2. Engine: `.`, `./core`, `./contracts`, `./kernel`, `./testing`, `./std`, `./domain`, `./rulesets` → `./src/<group>/index.ts`, and `./rulesets/*` → `./src/rulesets/*/index.ts`. Gateway: `.`, `./seat`, `./clock`, `./present`, `./runtime`. Every override that sets `no-restricted-imports` repeats the full ban list (a later override replaces an earlier one's options). Enable the `import` plugin per override (`plugins: ["import"]`) and decide explicitly on `import/no-named-as-default-member`, which flags the fast-check default-import idiom (`fc.assert`). Apply the bans to engine and protocol (sources and tests), gateway sources and bots sources (bots tests: import bans only), including the bots-only bans on runtime imports of `@perfidia/gateway*` and `@perfidia/engine*` (`allowTypeImports: true`). The source scan fails on `**`/`**=`, on any `Math` reference outside the allowlist of §2.4, and on every forbidden edge of the §2.3 matrix (type-only imports included; tests exempt). Add `packages/sim/fixtures/**` to the oxfmt ignore list. Re-verify every oxlint 1.87 finding of §2.4 (rule names, option shapes, per-override plugins, which `import` rules the categories turn on) and say what you found.
- Acceptance:
  - Each probe, planted temporarily, makes `bun run check` fail on the expected rule or scan check (lint, type-check or `architecture.test.ts`), and reverting it makes the check green again. The report lists every probe with what failed.
  - Pure packages: `/// <reference types="bun" />` in an engine source and a protocol source; `import { env } from "bun"`, `import { readFileSync } from "fs"` and `from "node:fs"` in **each of** `engine/src/core`, `src/contracts`, `src/kernel`, `src/std`, `src/domain`, `src/rulesets/x`, `src/testing`, one engine test file, `protocol/src` and `gateway/src`; each of `Bun.version`, `process.env`, `require("x")`, `setTimeout`, `setInterval`, `setImmediate`, `queueMicrotask`, `Date.now()`, `globalThis.Date`, `globalThis.Math.tan(1)`, `performance.now()`, `Intl.NumberFormat`, `parseFloat("1")`, `crypto.randomUUID()`, `fetch("x")`, `new WeakRef({})`, `new FinalizationRegistry(() => {})`, `"a".localeCompare("b")`, `"a".toLocaleUpperCase()`, `"a".toLocaleLowerCase()`, `(1).toFixed(2)`, `(1).toPrecision(2)`, `(1).toExponential(2)`, `x.toLocaleString()`, `Math.random()` and each banned `Math` member of §2.4 (`Math.sin(1)` … `Math.pow(2, 3)`) in an engine source and a protocol source; `Date.now()` in an engine test; `setTimeout` in a gateway source fails while a gateway test may use it.
  - Source scan: `2 ** 3`, `x **= 2`, `const m = Math; m.tan(1)` and `Reflect.get(Math, "tan")` in an engine source each fail; `Math.floor(1)` and `Math.sqrt(4)` pass; a `**` inside a comment passes.
  - Layers: one probe per forbidden edge of §2.3 (for example `import "../kernel/index.ts"` and `import "@perfidia/engine/kernel"` in `std`; `@perfidia/engine/std` in `kernel`; `@perfidia/protocol` in `core`; `@perfidia/engine/testing` and `../../kernel/index.ts` in `rulesets/x`; `../sandbox-1/index.ts` in `rulesets/perfidia-1`; `@perfidia/engine` in `domain`), each failing the scan, in the package-path form and, where one exists, the relative form; `import "../rulesets/x/index.ts"` from each of `core`, `contracts`, `kernel`, `std`, `domain` also fails lint; the same import in a `std` test passes.
  - Bots sources: `import fs from "fs"`, `from "node:fs"`, `from "bun"`, `Bun.file("x")`, `process.env`, `crypto.randomUUID()`, `setImmediate`, `queueMicrotask`, `fetch("x")`, `new WeakRef({})`, `Date.now()`, `Math.random()`, `Math.tan(1)`, `2 ** 3`, a value import of `@perfidia/gateway` and of `@perfidia/engine/core` each fail; `import type { … } from "@perfidia/gateway"` passes lint; `Bun.file` also fails the type-check of the new `tsconfig.lib.json`.
  - `[3, 1].sort()` fails `typescript/require-array-sort-compare`.
  - A test using `fc.assert(fc.property(…))` with fast-check's default import passes lint, or the chosen alternative is documented and applied to the existing tests.
  - Compact JSON under `packages/sim/fixtures/` passes `format:check`; `bun run test:exit` is defined (it may report no test files until T17).
  - A temporary consumer in `gateway` importing `@perfidia/engine/core` (backed by a temporary file) resolves under `tsc -b` and `bun test`; all probes are removed afterwards.
  - `BOTS_UPSTREAM` and the bots placeholder test are gone, `BOTS_PACKAGE` is kept and the sim placeholder still resolves it; `bun install --frozen-lockfile` still passes (no `bun.lock` change); `bun run check` is green at the end.

### 15.3 Wave 2

**T02 — Protocol schemas and engine contracts.**

- Owns: `packages/protocol/src/**`, `packages/engine/src/contracts/**`.
- Do: write every boundary shape as a Zod schema with its inferred type, and the engine's contract types, transcribing §3.2, §3.3, §3.6, §3.7, §4.1, §4.2, §5.1, §5.2, §7.1, §7.3, §8.1–8.7, §9.1, §10.2 and §10.3.
  - Protocol modules (§2.2): `json`; `ids` (public counters and opaque kinds with `z.templateLiteral` plus a regex, `QueueItemId`, `RulesetRef`, `compareIds`, the ASCII player-authored name schema of §4.1); `resources`; `state`; `actions`; `events` (`ScheduledEvent`, `DomainEvent`, `Recipient`, `STANDARD_EVENT_TYPES` with data schemas, `INTEL_EVENT_TYPES` with standard types only, §8.6); `violations` (`Violation`, `DOMAIN_ERROR_CODES`); `rules` (`CompiledRules`, `GatewayRules`, `WakeClass`, `CitySeed`, `TravelGroup`); `match` (`MatchSetup` with `idKey` as 32 lowercase hex characters, clock specs, `Standing`, `MatchResult`, `ConfigIssue`); `log` (`LogLine` union with every kind of §10.2, `defer` and `controller` included, `turn.selfAt`, `gw` lines with `details` and `error`; header; `Snapshot`); `tools` (`TOOL_NAMES` = the brief's 22, argument schemas of §8.3 each a single `z.object`, `recall_troops` refined to exactly one mode and `end_turn` to at most one field, result schemas, `ToolCall`, `ToolResult` with `t` and `warnings`); `views` (city full and public, island, map, player with its private section and relations, leaderboard, movement, intel snapshot, archive hit, `RulesInfo` with `rules.gateway` kept whole); `briefing` (§8.2 with `lastTurn`, time pairs, budgets, city and top-level `ext`; `WakeReason`); `agent` (type-only `SeatAgent`, `RoundInput`, `RoundOutput`, `Sleep`, `TimeSource`). Re-export `z` and the type `ZodType`. No runtime logic beyond schemas, constants and `compareIds`. Delete `PackageNameSchema` and protocol's placeholder test; keep `PROTOCOL_PACKAGE`.
  - Engine contracts: `contracts/ruleset.ts` (everything in §3.2 including `intelEvents` and `Visibility.briefing`, `ExtraTool` §3.7, `Relation`, `ConfigIssue`, `Rng`, `Fmt`) and `contracts/ctx.ts` (§5.2, with the stream-name rule of `rng` as a doc comment), with `contracts/index.ts`. Types only.
- Acceptance: valid fixtures parse and invalid ones fail with useful paths, for every schema; `TOOL_NAMES` equals the brief's 22 names exactly; every tool argument schema converts with `z.toJSONSchema` to a root `type: "object"` with no root `anyOf`, `oneOf` or `allOf`; `recall_troops` rejects no mode, two modes and `home` without `stationedAt`; `end_turn` accepts `{}` and rejects both fields together; every `LogLine` kind and `Snapshot` round-trips through JSON; `compareIds` orders `p2 < p10`, groups by prefix, orders opaque ids by code unit and is a total order (property); opaque id schemas accept `m0k4qz` and reject `m41` and `m0k4qi`; the name schema rejects control characters and non-ASCII letters such as `é`; `MatchSetup` rejects an `idKey` of the wrong length or case; `INTEL_EVENT_TYPES` names no ruleset event; a type-level test shows `Ruleset<SomeConfig, SomeExt>` is assignable to `AnyRuleset`; `PROTOCOL_PACKAGE` is still exported; `bun run check` green.

**T03 — Engine core primitives.**

- Owns: `packages/engine/src/core/**`, `packages/engine/src/index.ts`, `packages/engine/src/index.test.ts` (to delete it).
- Do: §4.1 (`opaqueId`, `idKeyFromSeed`), §6.1–6.3 and the formatter of §7.3. `int.ts` (`floorDiv`, `ceilDiv`, `rdiv`, `isqrt`, `ipow`, `clamp`, `mulDiv`, `assertSafeInt`, `lossPm`, `cas`), `prng.ts` (`mulberry32`, `fnv1a32`, `streamRng`, `randInt`, `shuffle`, with `Rng = { nextU32(): number }`), `hash.ts` (UTF-8 encoder, `fnv1a64` on two uint32 halves, `sha256Hex`), `canonical.ts` (`canonicalJson` with every rejection of §6.3), `opaque.ts` (`opaqueId(idKey, prefix, owner, n)`, the 8-round SHA-256 Feistel of §4.1, and `idKeyFromSeed(seed)`), `format.ts` (`DAY = 86400`, `fmtTime`, `fmtDuration`, `fmt: Fmt`), `sorted.ts` (`insertSorted(arr, item, cmp)`, `removeWhere`). No `**` and no approximated `Math` (§6.1). `core` imports nothing, not even `protocol`. The barrel exports `core`, keeps `ENGINE_PACKAGE`, and deletes `ENGINE_UPSTREAM` with the engine placeholder test.
- Acceptance: FNV-1a 64 vectors of §6.3 and a differential test against a BigInt reference; FNV-1a 32 vectors; SHA-256 vectors (`""`, `"abc"`, the 448-bit NIST message); mulberry32 golden outputs checked against a reference written in the test; `randInt` bounds and `shuffle` permutation properties; `isqrt` exact against BigInt for random n < 2⁵²; `ipow` exact against BigInt and throwing beyond 2⁵³; `ceilDiv`, `rdiv`, `mulDiv` properties; `lossPm`/`cas` reproduce `perfidia-1` values (`lossPm(1,2) = 250`, `cas(8, 609) = 5`, `cas(360, 665) = 239`, `cas(1, 665) = 1`); canonical JSON property P8 and each rejection; `opaqueId` has no collision over owners 1..15 × n < 2¹⁶, matches committed vectors, uses only the base-32 alphabet, throws for n ≥ 2²⁰, and two keys give different ids for the same (owner, n); `idKeyFromSeed` returns 32 lowercase hex characters; `fmtTime(0) = "D1 00:00"`, `fmtTime(604800) = "D8 00:00"`, `fmtTime(223370) = "D3 14:02:50"`; `fmtDuration`: 0 → `"0s"`, 45 → `"45s"`, 60 → `"1m"`, 7200 → `"2h"`, 4800 → `"1h20m"`, 4805 → `"1h20m5s"`, 86400 → `"1d"`, 381480 → `"4d 9h58m"`; `bun run check` green.

### 15.4 Wave 3

**T04 — Engine kernel and testing kit.**

- Owns: `packages/engine/src/kernel/**`, `packages/engine/src/testing/**`, `packages/engine/src/index.ts`.
- Do: §3.6 (`parseOverride`, `resolveConfig` with the compile checks for every N, `checkRules` with every check listed there, `ruleset.check`, `MatchConfigError`, `configHash`, `rulesHash`), §5.1–5.3 (the `Ctx` with copying `emit`, per-owner opaque `nextId` keyed by `setup.idKey`, `nextItem`, `schedule`/`cancel` through `core/sorted`, `rng` with the stream-name rule; creation with every check, the `MatchSetup` schema and the travel check of §3.6 included; `loadMatch` with the setup checks and `SnapshotMismatch`; `advanceTo` with checkpoints; the `apply` pipeline with warnings and the `ext` fallback violation; deep-freezing under step invariants), §6.4, §6.6, §10.3, §10.4 (`verifyLog` advancing on every line, with the `rules` divergence, `from` resuming after the snapshot's `ckpt` line, `onCheckpoint` and `onLine`, `compareEvents` in the line order of §10.2) and the kernel invariants of §13.3 (domain kinds only, emitted-event checks, `extSchema` at checkpoints). `ENGINE_VERSION = "0.1.0"`. The kernel takes the `DomainModule` and the ruleset as arguments and imports neither `std` nor `domain`. Testing kit (`src/testing/`): a fixture ruleset (two islands, constant travel, trivial attack and spy, simple standings, one world timer, a non-empty `ext`, `eventSchemas` with one `intelEvents` entry, `errorSamples`, one read and one write extra tool with `hooks.actions.ext`, and a `visibility` with a `publicCity` extra and a `briefing` hook driven by `ext`, so gateway tests can exercise both), a fake `DomainModule` sufficient for kernel tests, state builders (`buildState`, `addCity`, `addMovement`, …), `matchFromState` and `testStep` (§5.3), reused by later tasks.
- Acceptance: P1 through the kernel; P5; P6 with a non-empty override; P7 on logs produced by driving the kernel with the fixture ruleset (tampering reported at the exact `n` or hour), including logs with `defer` and `controller` lines; P14 (including compile-check rejections and a fixed field), with one rejection per generic check of §3.6 (`selfWake.min > selfWake.max`, `safetyWake < selfWake.min`, `roundTripsPerWake = 0`, `toolCallsPerRoundTrip = 0`, `toolCallsPerWake = 0`, `ownWakesPerDay = 0`, `socialWakesPerDay = 0`, `matchEnd = 0`, `urgentMinGap ≥ minTravel`) each naming its path; checkpoint semantics (an event exactly at an hour boundary precedes its checkpoint, an action at the boundary follows it, no checkpoint after the end); `resolveConfig` rejects an unknown path listing sibling keys, an invalid value with its path and a float, and reports a canonical-JSON failure as a config error; the hash is independent of key order and unchanged by an override equal to the default; `createMatch` throws `MatchConfigError` for an invalid `idKey`, a ref mismatch, N out of range, an event kind without class or handler, `match_end` sharing its class, a world timer at 0, a start stock above its cap, a fixture `travelTime` below `minTravel` for one island pair (the same island included) and failing initial invariants; `loadMatch` throws `SnapshotMismatch` when the ref, `configHash`, `rulesHash`, `ext` or hash differ; after an `emit`, mutating the state leaves the collected event, a taken snapshot and the hash unchanged; a rejected action leaves the hash unchanged; an `ext` action without a handler is a `Violation`; an undeclared event type or invalid standard event data fails the step invariant; requesting the same `rng` stream name twice under step invariants throws `EngineBug`; `EngineMisuse` when time goes backwards; each structural invariant catches a planted corruption; `verifyLog` reports a `rules` divergence before replaying, resumes from a snapshot after its `ckpt` line and calls `onLine` for every line in order; `bun run check` green.

**T05 — Engine std: derivations and primitives.**

- Owns: `packages/engine/src/std/**`.
- Do: §4.3, §5.4 (the exact function list, the `queue_empty` rule and the `turnBack` floor for held homes), §6.6, the audiences, roles and per-recipient payloads of §8.6 (incoming events with foe and times; a `deliverShipment` helper that adds the cargo capped and emits the recipient and sender copies) and the `std` invariants of §13.3. Derivations are pure over `ReadCtx`; relation queries go through `relationsOf` (hook, else `defaultRelations`). Primitives take a `Ctx` and emit the standard events. `defaultVisibility` and `defaultDeparture` implement the ruleset-independent parts of `perfidia-1` §12 and §7.3 (no sieges). Read only `CompiledRules`, never a ruleset's raw config, and never test the ruleset id. Write a small local test `Ctx` (naive sorted array) and a hand-built `CompiledRules` fixture in your own test helpers; the kernel is written in parallel.
- Acceptance: P2; `materialize` is idempotent and agrees with `stockAt`/`unitsAtHome`; trickle and batch delivery; `affordableAt` exact (`ceilDiv`) and `null` when unreachable; `cancelFrom`: an active build item refunds pro rata, a recruit batch cancelled mid-unit keeps its completed units and refunds the unit in training at 100%, the `{pm}` variants, refunds capped by storage, events of removed items removed; `completeBuild` after a breach lands one level below the projected target; `allocateLosses` gives 44/29 for 73 losses over groups of 60 and 40, gives ties to the earlier group, and always sums to the loss (property); random sequences of launch, turn back, return, bounce, station and unstation keep unit conservation; `turnBack` returns at `now + max(1, now − departAt)`, and at `now + max(minTravel, now − departAt)` when a `hold` group of another player is in the home city; `cancelFrom`, `removeQueueItems` and `clearQueues` emit no `queue_empty`, even when they empty a queue; `rehomeAll` makes returns heading to the lost city sail on; `transferCity` and `eliminate` leave no dangling reference; `inFlightCargo` counts returns of bounced shipments; the sender copy of `shipment_delivered` carries no amounts; a fixture `relations` hook changes `relation` results; derivations never write (P3, std part); every `std` invariant catches a planted corruption; `bun run check` green.

**T06 — perfidia-1: config, world and pure rules.**

- Owns: `packages/engine/src/rulesets/perfidia-1/**` (wave-3 files: `config.ts`, `check.ts`, `compile.ts`, `cheatsheet.ts`, `sin10k.ts`, `map.ts`, `travel.ts`, `combat.ts`, `spy.ts`, `scoring.ts`, `domination.ts`, `ext.ts`, `errors.ts`, `index.ts` and their tests; T11 extends the directory in wave 4).
- Do: `docs/rulesets/perfidia-1.md` §0–§6, the maths of §8 and §10, §13, §14.1–14.2 and §16, as pure modules:
  - `config.ts`: the Zod schema of §16 (no `id`, no sine table; integers; the fixed fields as `z.literal`), defaults exactly as specified, the validation rules of §16 that belong to the schema;
  - `check.ts`: `siegeDuration > recallWindow` and `sameIslandTravel ≥ minTravel` (the generic checks are the kernel's);
  - `compile.ts`: `CompiledRules` (level tables from the quadratics, build times `[level][hall]` and recruit times `[level]` with `max(1, …)`, `settlerCost` for k = 0..10, `allianceMax = max(2, floor(N/3))`, `queues.build.requiresOn = "projected"`, refunds build pro rata and recruit `uncompleted` at 1000‰, `toolOptions` both false, `gateway` with the two budgets, `urgentMinGap`, `toolCallsPerWake: null`, the wake table of §8.5 and `publicOncePerDay: ["domination_started"]`, `eventClasses` of §5.1, `travelProbes` transport / warship / spy);
  - `cheatsheet.ts`: §0 rendered from the config; `sin10k.ts` (code constant), `map.ts` (`createWorld` per §2.3 and §3: island and city ids, seats, tie-break order, Crown, timer `domination_open`), `travel.ts` (`travelTime` per §7.2, reading `time.sameIslandTravel` and `time.minTravel` from the config, never a literal 3600);
  - `combat.ts` (morale, naval phase, land phase, losses, loot, battle-point split, as pure functions over numbers), `spy.ts`, `scoring.ts` (city points, battle score, standings and final ranking of §13.4), `domination.ts` (qualification and same-second ordering), `ext.ts` (`extSchema` and typed accessors), `errors.ts` (explainers for `CITY_BESIEGED`, `NOT_BESIEGER` and the warning `CAPITAL_IMMUNE`, plus `errorSamples`);
  - `index.ts` exporting these modules.
- Acceptance: defaults parse; each validation rule of §16 is rejected with a precise path; overriding a fixed field is rejected; `time.matchEnd=86400` and `time.dominationStart=604801` both parse; P14 cases: `time.sameIslandTravel=1800` and `time.minTravel=7200` alone are each rejected by `check` naming `time.sameIslandTravel`, while `time.minTravel=7200 time.sameIslandTravel=7200` (with `gateway.urgentMinGap` below it) resolves and gives `travel = max(7200, …)` and 7200 on the same island; tables match §4.1, the §5.2 examples (hall 2 at H1: 144/144/96 and 2880 s; lumber 5 at H5: 92/230/138 and 4928 s; harbor 10 at H10: 17178 s; hall 10 at H9: 13600 s) and the §6.3 recruit times (guard 300/214/157 s); the compile output has the refunds, `requiresOn`, `toolOptions`, gateway rules and wake table above; the cheat sheet equals §0 verbatim for the defaults and changes under an override; §2.5 fairness with fast-check over seeds for N = 6..12 plus the exhaustive sweep of `rot` and jitter extremes; §2.4 island and slot counts per N; the §8.12 and §9.8 battle numbers (the split stack and the homecoming included) and the §15.2 D values exact through the pure functions; spy thresholds of §10; ranking examples; P13; `bun run check` green.

**T07 — Gateway seat logic: wake scheduler, caps, notes, archive, public feed.**

- Owns: `packages/gateway/src/seat/**`.
- Do: §8.4–8.6 and the state side of §8.2–8.3: `GatewayState`, `SeatState`, `Delivered`, `createGatewayState`, `deliver` (archive, inbox, public feed, `publicOncePerDay`, wake triggers by role or public), cap checks (round trips, calls per round and per wake, attacks and messages per day) returning `ToolError`s with numbers, `writeNote`, `searchArchive` with scopes (ASCII case folding, §6.5), `lastTurn` bookkeeping, and the `WakeScheduler` of §8.5 exactly (two budgets, urgent gap, clamped self-wakes kept until they fire, a turn ended without a request keeping `selfAt`, seats in a turn without a wake time, `end` at `t + 1`). Pure functions over protocol types and `GatewayRules`; all state JSON-serialisable. Every function takes exactly the data a log line carries (§10.2), so the live host and `rebuildGatewayState` (§10.5) call the same code. Exposed as `@perfidia/gateway/seat`.
- Acceptance: P11 (every bullet of §8.5, model test with `fc.commands`, whose commands include ending a turn with no self-wake request, as `end_turn {}` does); scenarios: an exhausted own budget moves own wakes to the next day while social wakes still fire, and the reverse; 30 messages a day from another seat never produce an own-charged wake; two attacks launched 100 s apart wake the target at t and t + 600; a normal trigger during a turn longer than `groupWindow` wakes at `max(first + window, end + 1)`; a self-wake survives an urgent wake and fires later, and survives a turn ended without a request; clamping is reported; safety wake 43200 s after the last turn's end; the start wake is exempt; public messages never wake; `domination_started` wakes the public role once per bloc per game day; a public event truncated from news is found by `read_notes` scope `public`; archive search order `(t, e)`, filters and the `all` scope without duplicates are deterministic; cap and note errors carry numbers; state round-trips through JSON; `bun run check` green.

**T08 — Gateway clocks.**

- Owns: `packages/gateway/src/clock/**`.
- Do: §9.1–9.4: `ClockHost`, `TurnHandle`, `ClockDriver` types; `VirtualTime` (timers by `(ms, seq)`, cancellable, injected macrotask yield, deadlock error); a level-triggered `Signal`; the lockstep driver (batch order from `streamRng`/`shuffle` of `@perfidia/engine/core`, `allSettled`, optional `roundTimeoutMs`); the real-time driver exactly as the §9.3 pseudo-code (kick after every `execute` and `close`, sleeps to `wallAt(max(next, now + 1))`, losing sleeps and timeout timers cancelled). No wall clock in sources: time only through the injected `TimeSource`.
- Acceptance, against a scripted `FakeHost`: lockstep plays all seats due at `t` in batches, orders acting seats by the shuffle on `lockstep:<t>:<b>` (golden order for a fixture), lets an urgent wake at `t` join the next batch, defers seats over the per-second cap to `t + 1`, keeps `nextTime()` strictly increasing, closes open turns when the match ends, closes only the turn of an agent that throws while applying the others' outputs, and times out a hung agent when `roundTimeoutMs` is set; real time: the game-to-wall mapping is monotone and `gameAt(wallAt(g)) = g` for speeds up to 1000 (property), two seats can be in turns at once, one turn per seat, calls land at the game second of receipt, a finished turn wakes the loop, in-flight turns finish after the end, **an action during A's long turn that makes idle B urgently due opens B's turn at that game second (± one loop iteration), not when A's turn ends**, **a normal trigger for a seat during its own turn longer than `groupWindow` lets the run finish under `VirtualTime` without deadlock and within a bounded number of loop iterations**, and no timer is left pending after the run; `VirtualTime` gives identical traces twice, throws on deadlock and drops cancelled timers; an `fc.scheduler` interleaving property on a small scenario; `bun run check` green.

**T09 — Bots.**

- Owns: `packages/bots/src/**`.
- Do: §11 with §9.1 (`SeatAgent`, `RoundInput`, `RoundOutput`, `TimeSource`), §9.4 (think time), §7.3 (details conventions, time pairs) and §8.1–8.3 (views, briefing, tool shapes): `rng.ts` (mulberry32 + FNV-1a 32, same algorithms as `core`), `kit.ts` (roles from `RulesInfo`/`CompiledRules`, caps from `rules.gateway`, never from the `interface` text, `requiresOn`, affordability, build orders, target scoring, travel lookups from `view_map`, own forces from `view_player` on itself), `memory.ts` (notes as compact JSON within the cap; a notebook it cannot parse is empty memory), `think.ts` (`withThinkTime(agent, {time, latencyMs, seed})`), `hints.ts` (the only file that may name a ruleset or its ids), the four strategies of §11.2, and the registry (`createBot(strategy, {seat, seed, hints?})`, `BOT_STRATEGIES`, `botFromLabel("bot:<strategy>@1")`). Caches live in the bot instance. Bots cancel by queue item number, use the one-object `recall_troops` and `end_turn` shapes of §8.3, and self-wake with `wakeAt`. Bots import only `protocol` at runtime (lint enforces it since T01, which already removed `BOTS_UPSTREAM` and the placeholder test); keep `BOTS_PACKAGE`.
- Acceptance: same inputs give the same outputs; a bot started mid-match (turn > 1) with an empty, a free-text (LLM-written) or a full notebook plays without throwing and rewrites its notes within the cap; two bot instances never share a cache (no module-level mutable state); every emitted call parses with the protocol tool schemas; caps from `RoundInput` respected; `{ok: false}` never throws; every turn ends with `end_turn` and a `wakeAt` in range; fixture behaviours: the expander queues economy and sends a settler to the nearest valuable free slot, the rusher attacks a weak target above its margin and recalls on a stronger report, the turtle recruits `max` defenders and asks allies for support on an incoming attack, the opportunist proposes on day 1 and attacks an ally on its seeded day; strategies work on rules fixtures shaped like `perfidia-1` (wall, warships, projected requirements) and `sandbox-1` (`keep`/`camp`/`depot`, completed requirements, no wall, no warship, `foundSlot`); notes always fit the cap; no string literal outside `hints.ts` names a `perfidia-1` id; `bun run check` green.

### 15.5 Wave 4

**T10 — Engine domain handlers and bound API.**

- Owns: `packages/engine/src/domain/**`, `packages/engine/src/index.ts`.
- Do: the `DomainModule` (§5.2) built on `std`, data-driven by `CompiledRules`, following §7.1–7.4 and the generic parts of `perfidia-1` §5.3, §6.2–6.4, §7.1–7.6 and §11: `build` (requirements per `requiresOn`, projected targets, max level, queue max, cost at enqueue, duration) and `build_done` through `completeBuild`; `recruit` (settler cost by k, `maxPerOrder`, `EXCEEDS_STORAGE` naming the storage level needed, pop); `cancel_queue` by item (`QUEUE_ITEM`); `send_resources` (cap through `inFlightCargo`); `attack`/`support`/`spy`/`found_city` (generic departure checks, `attackFrom`, transport rule, `slot` only with `toolOptions.foundSlot`, then `hooks.departure ?? std.defaultDeparture` with its warnings, then `std.launch`); `recall`/`recall_stationed` (`home`, `AMBIGUOUS_GROUP`, whole or partial per `movement.recall`)/`dismiss` (support groups only); `send_message`; `propose` (`until` only with `toolOptions.pactUntil`), `answer` (caps re-checked at acceptance; pacts between new allies end as `superseded`), `leave` (`with`); the events `build_done`, `recruit_done` (+ `queue_empty`), `proposal_expire`, `pact_expire`; the default arrivals for support, shipment (through `deliverShipment`), found and return; the diplomacy invariants of §13.3, active only while the ruleset keeps `propose`/`answer`/`leave`. Violation details follow §7.3. The barrel exports `core`, contracts, `kernel`, `std`, `domain` and the bound `createMatch`, `loadMatch`, `verifyLog(lines, resolve, opts)`; keep `ENGINE_PACKAGE`.
- Acceptance: a table test per action and per violation code (numbers, `availableAt`); items of a batch are independent consecutive actions; `validate` is pure (P3); P4 and P9 with a test ruleset made of the testing kit's fixture hooks plus the domain defaults; recall arrives at `now + max(1, now − departAt)`, and at `now + max(minTravel, now − departAt)` when the home city holds another player's `hold` group; `build_done` and `recruit_done` emit `queue_empty` only when they empty their queue, and a `cancel_queue` that empties one emits none; cancel by item is a tail cancel, and an item that already completed gives `QUEUE_ITEM`; a queued wall item completes at current + 1 after a breach applied with `testStep`; the shipment cap counts bounced returns; `recall_stationed` with groups from two homes: a partial recall without `home` gives `AMBIGUOUS_GROUP`, with `home` it takes from that group, `units: null` sends both groups as separate returns; accepting an alliance between pact partners ends the pact with cause `superseded` and frees the slot; `leave {with}` ends a pact; alliance size cap, both-allied acceptance invalid, at most `maxPacts` with renewal not counting, proposal limits and expiry; message audiences; `slot` and `until` rejected when `toolOptions` is off and honoured when on; violation details are fog-safe; `bun run check` green.

**T11 — perfidia-1: mechanics hooks and descriptor.**

- Owns: `packages/engine/src/rulesets/perfidia-1/**` (the whole directory, T06's files included).
- Do: `perfidia-1.md` §3, §7.3–7.7, §8, §9, §10, §11.3–11.5, §12, §13 as hooks over `std` and T06's pure modules (import `core`, contracts and `std`, not `domain`, which is written in parallel): `departure` (foe and party, relief of an own besieged city, `NOT_BESIEGER`, the `CAPITAL_IMMUNE` warning), `guard` (`CITY_BESIEGED`, no dismiss of a garrison), `arrive.attack` (city, relief and homecoming battles, the homecoming's foe being the besieger and its naval phase depending on the return's departure island, stand-aside, morale, naval gate, land phase, losses allocated with `std.allocateLosses`, wall breach, siege start with queue refunds, capital immunity, raid and loot, battle points with the 86400 s anti-collusion cooldown, betrayal on impact, per-recipient reports and the public `battle` headline), incoming `incoming_attack` events with `homecoming: true` to the besieger for returns heading into a besieged city (at siege start and when the return is created), `arrive.spy/support/shipment/return/found` (siege-aware; shipments through `deliverShipment`), `on.siege_end` (conquest, fallback re-homing, elimination), `on.domination_open` (sets the flag), `domination_started` carrying `key` = the bloc key (for `publicOncePerDay`), `on.domination_end` (same-second countdowns resolved together in the §13.3 order), `afterStep` (relation history, siege abandonment, domination evaluation at every step from the flag: cancel, then start in bloc order; last standing), `standings` (public parts only), `finish`, `visibility` (siege flag and end in `publicCity`, Crown, countdowns, tie-break order; no raw battle points; `briefing` listing the sieges the seat holds with owner and end time, and every running countdown, §8.2), `invariants` (its own event kinds included), `eventSchemas`, `intelEvents` (`siege_started`, `siege_broken`), and the descriptor `perfidia1_1_0_0` (`ref: "perfidia-1@1.0.0"`, `status: "published"`) exported from `index.ts`. Keep every export of T06's `index.ts` unchanged; only add.
- Acceptance: the §8.12 and §9.8 worked examples reproduced through the kernel (hand-built states and movements, arrivals fired by `advanceTo`) with exact unit counts, wall changes, loot, battle points and siege start, hold and break, the split stack (c11 loses 44, c12 loses 29) and the homecoming alternative included; a conquest on a capital before t = 172800 becomes a raid and its launch carries the `CAPITAL_IMMUNE` warning; the Crown (D = 10187, Nd = 500, morale 1000, frozen production, +100 once captured); re-homing makes returns sail on; elimination clears everything; a founding that makes a bloc qualify starts a countdown at that step; a membership change applied with `testStep` cancels it; same-second countdown ordering and the win; betrayal ends the pact or alliance only on impact and emits a public event; a return heading into a besieged city reaches the besieger as an incoming attack with role `party`; an attack recalled within 600 s after its home city was besieged meanwhile lands `minTravel` (3600 s) after the recall as a homecoming battle, and the besieger receives its `incoming_attack` at the recall (perfidia-1 §7.4); a siege start refunds the queues and emits no `queue_empty`; a relief attack addresses the besieger as `party` and the owner as `target`; the `briefing` hook lists a held siege and a countdown, and `publicCity` shows a besieged city's siege end; standings and views never expose raw battle points; step invariants (emitted-event checks included) hold; T06's exports are unchanged; `bun run check` green.

**T12 — sandbox-1 ruleset.**

- Owns: `packages/engine/src/rulesets/sandbox-1/**`.
- Do: §3.8 completely: config schema and defaults (integers), `players`, `compile` (every field as listed), cheat sheet, `createWorld` with the `hill_open` timer, `travelTime`, `arrive.attack` (land only, boats, `std.allocateLosses`, immediate capture, disbanding, loot rounding), `arrive.spy`, `on.hill_open`, `afterStep` (hill victory from the flag, last standing), the `movementAccess` override, `publicCity`/`publicMatch` extras, `standings`, `finish`, `extSchema`, the extra tools `hill_status` and `rename_city` with `hooks.actions.ext`, `eventSchemas` (`city_renamed`), `errors` and `errorSamples`, and the descriptor `sandbox1_1_0_0` (`status: "test"`). It imports only `core`, contracts and `std` (`domain` is written in parallel), never `perfidia-1`.
- Acceptance: defaults parse and compile for N = 2..12; the compile output matches §3.8 (no building, unit or queue id shared with `perfidia-1`; classes, gateway rules, wake table, recall, diplomacy, `toolOptions`, refunds); map ids, coordinates and distances for N = 2, 7 and 12; travel = 4800 + 60·d, and 4800 on the same island; capture, disbanding and elimination through the kernel on hand-built states; the loot rounding and boat rules; a player who already qualifies wins at the `hill_open` event at t = 172800, not at the next action; battles emit the standard `battle`, `battle_report`, `city_conquered` and `player_eliminated` shapes (step invariant); `rename_city` works through the kernel's `ext` action and `hill_status` reads public data only; a build and a recruit completing in the same second resolve in seq order; no import of another ruleset; `bun run check` green.

**T13 — Gateway presentation.**

- Owns: `packages/gateway/src/present/**`.
- Do: §8.1 (views, the private section of `viewPlayer`, relations, `publicCity` with the viewer, `rulesInfo` with the `interface` block and the trimmed `rules` keeping `rules.gateway` whole, size budgets), §8.2 (the briefing exactly: time pairs, `lastTurn`, budgets, proposals with texts, message cut, typed fields, `"more"` naming the exact call, each city's `ext` from `publicCity` and the top-level `ext` from `visibility.briefing`, default `publicMatch`), the wording of §7.3 (`explain` for every domain code and warning, ruleset codes through `ruleset.errors`, `QUEUE_ITEM` completion times from the archive) and the rendering of §8.6. Pure functions of `(match.read(), seat, gw)` using `std` derivations, the ruleset's visibility hooks with `std.defaultVisibility` as fallback, and `core`'s `fmt`. Test with the engine testing kit's state builders and `perfidia-1`'s `compile`.
- Acceptance: P10 at one state for views, briefing and errors, as §13.2 states it (an ally sees the owner's outgoing movements exactly as `movementAccess` grants, checked with a fixture that denies it and one that grants it); one explain snapshot per domain code and warning with numbers and times; `QUEUE_ITEM` names the completion time from the archive; a snapshot of the `interface` block, which states that `end_turn {}` keeps a pending self-wake and that both fields together are an error; `rules.gateway` carries every numeric `GatewayRules` field and the wake table; the briefing fixture is ≤ 2,400 characters excluding notes with the notebook full and several long messages, and lists every incoming attack with its foe and time pairs; with the testing kit's fixture ruleset, a besieged-like own city shows its `publicCity` extra in its `ext` and a held group listed by the `briefing` hook appears in the top-level `ext`, within the budget; `rules` ≤ 12,000 characters and `view_map` with `fromCity` ≤ 9,000 characters for `perfidia-1` at N = 12, or the gap reported; `view_player` on oneself lists movements, stationed groups (a hold garrison included), settler k and cost; views are fresh objects and never mutate the state (P3, gateway part); outputs are deterministic; `bun run check` green.

### 15.6 Wave 5

**T14 — Gateway runtime, ruleset registry, sim harness and first integration.**

- Owns: `packages/gateway/src/runtime/**` (except `rebuild.ts`, T16's), `packages/gateway/src/index.ts`, `packages/gateway/src/index.test.ts` (to delete it), `packages/engine/src/rulesets/index.ts`, `packages/engine/src/index.ts`, `packages/sim/src/harness/**`, `packages/sim/src/integration.test.ts`. Fix rights, exclusive in this wave, over `packages/{protocol,engine,gateway,bots}/src/**` for integration bugs; report each fix.
- Do: the registry of §3.5 (`RULESETS`, `findRuleset` with the test-version fallback, `getRuleset`, `parseRulesetRef`, `validateRegistry` with the `intelEvents` subset and the root-object check of extra tools); the engine barrel exports it and a `verifyLog(lines, opts)` that resolves through it; the extra-tool path of §3.7 and `toolDefinitions(ruleset)` with gateway-owned descriptions; the tool registry of §8.3 (layers 1–5 of §7.2, the turn rules including `end_turn {}` and both fields, batch expansion with consecutive `n`, per-item `"max"`, `INTERNAL` as §7.3 defines it); `TurnHandle` and `MatchHost` implementing §9.1 and §8.7 (snapshots at checkpoints by splitting `advanceTo`, copies to agents, `wall` injection, `handoffs` with `controller` lines, every line kind and the line order of §10.2: `turn.selfAt`, `gw` details, `defer`); `LogSink` serialising at `write`, `MemorySink` and `runMatch` returning a copy of the final gateway state; a `chaos` test agent that also mutates what it receives; the gateway barrel (delete `GATEWAY_UPSTREAM` and the gateway placeholder test, keep `GATEWAY_PACKAGE`); the `sim` harness of §12.1 (`SystemTime`, `VirtualTime` wiring, `optionsFromHeader` with `controller` lines as `handoffs`, `normaliseLog`, `normalisedHash`, JSONL reader and writer with gzip, golden check and add-only writer and the ruleset fingerprint, both taking the fixtures directory and the ruleset list as arguments; `idKeyFromSeed` as the default key). The sim integration test runs the four real bots (the gateway cannot depend on `bots`).
- Acceptance: exactly 22 tools plus ruleset extras (two for `sandbox-1`); a snapshot test of `toolDefinitions` for both rulesets, every `inputSchema` with root `type: "object"`; P12 and P16 with the chaos agent, with zero `INTERNAL` in strict mode; a read tool made to throw (test double) returns `INTERNAL`, writes a `gw` line with the error and leaves the hash unchanged, and is fatal in strict mode; cap rejections produce `gw` lines with their `details` and never reach the engine; batch items get consecutive `n` and per-item results; `[{guard, "max"}, {raider, "max"}]` resolves the second order against what the first left; calls beyond the round cap get `CALLS_CAP` and calls after `end_turn` get `TURN_OVER`, both reported in the next `lastTurn`; `end_turn` clamps and warns, `end_turn {}` keeps a pending self-wake, and both fields give `INVALID_ARGS` without ending the turn; the registry rejects duplicate refs, extra-tool collisions, an extra tool whose args are not a root object, a write extra without `actions.ext`, an `intelEvents` entry missing from `eventSchemas` and `match_end` sharing a class, and a bare id falls back to a test version; for both rulesets, 1-game-day matches with the four bots under lockstep and under real time with `VirtualTime` end without `fatal`, pass Level E with zero divergence, and two lockstep runs are byte-identical; a lockstep log shows `act` lines before their `ev` lines and `defer` lines when the per-second cap binds; a 1-day lockstep run that hands `p2` to another bot at t = 43200 writes a `controller` line and passes Level E and Level G; P4 for both rulesets through the tools; the in-process coexistence test of §13.4 (P17) under lockstep and `VirtualTime`; `rename_city` calls are replayed at Level E; every snapshot's hash equals its `ckpt` line; `MemorySink` text equals the harness file writer's output; a fatal path writes a `fatal` line and rethrows; `bun run check` green.

### 15.7 Wave 6

**T15 — sim CLI: run, verify, batch, summary, golden.**

- Owns: `packages/sim/src/**` except `src/harness/**`, `src/hardening/**`, `src/exit/**`, `src/architecture.test.ts`, `src/golden.test.ts` and `src/integration.test.ts`.
- Do: §12, §10.1–10.4 and §3.6 through the harness: `cli.ts` (`node:util` `parseArgs`), `io/` (buffered file sink, streaming reader validating each line with Zod and reporting line numbers, snapshot files), `run/` (setup from flags, `--id-key` with the seed-derived default and `random` from `crypto.getRandomValues`, bots from `--bots`/`--seat` via the bots registry, clock selection, latency, `wall` from `SystemTime`, `--allow-test`), `verify/` (Level E via the engine `verifyLog`, `--from`, `--dump` with a structural diff, `--resim` for Level G), `batch/` (variants × seeds with identical bots, seat assignment and seed-derived id keys, lockstep, table, JSON with provenance, `--pacing`), `summary/` (pure fold of §12.2 with wakes by class, deferred counts from `defer` lines, controllers with hand-offs from `controller` lines, `INTERNAL` count), the `golden` command (harness check and add-only writer), `index.ts`. Delete the `SIM_*` placeholder constants and `packages/sim/src/index.test.ts`; never import a `*_PACKAGE` constant.
- Acceptance: `bun run sim -- run --ruleset perfidia-1@1.0.0 --seed 1 --players 6 --days 1` writes a run that `verify` and `summary` accept, and running it twice gives the same log; `--id-key random` writes the key into the header and `verify --resim` reproduces the run; an invalid override exits 3 naming the path, an override of a fixed field exits 3, N outside the player range exits 3 showing the range, an unknown ruleset exits 3 listing the refs, and `sandbox-1` needs `--allow-test`; `batch` with two variants × two seeds prints the table and writes JSON with provenance; `batch --pacing` prints the per-day table; summary metrics are exact on hand-written fixture logs (wakes per seat per day by class, deferred wakes from `defer` lines, a hand-off from a `controller` line and an `INTERNAL` `gw` line included); a tampered log makes `verify` exit 1 naming the divergence; `verify --from <mid-run snapshot>` passes for both rulesets with a non-empty override; `--resim` is byte-identical for lockstep; a corrupt JSONL line reports its line number; a 1-day system-clock run at very high speed passes `verify`; `golden --update` refuses to overwrite an existing golden; `bun run check` green.

**T16 — Cross-ruleset hardening and gateway rebuild.**

- Owns: `packages/sim/src/hardening/**` (the rebuild-equality test with the four bots included); `packages/gateway/src/runtime/rebuild.ts` and its unit test with scripted test agents (exported through `runtime/index.ts` under the fix rights below). Fix rights, exclusive in this wave, over `packages/{protocol,engine,gateway,bots}/src/**` and over `packages/sim/src/harness/**` (which T15 does not own); never the rest of `sim`; report each fix.
- Do: `rebuildGatewayState` of §10.5 as a fold over `verifyLog`'s `onLine`, calling the `seat/` functions; the cross-ruleset properties of §13.2 and the checks of §13.4, for both rulesets, through the harness: P4 at scale; P9 (snapshot mid-run, shuffle the insertion order of every record, continue, compare hashes and events); P10 at tool level as §13.2 states it (two states that differ only in data hidden from seat X give X byte-identical results for every tool, errors included; `recall_troops {movement}` on another player's movement answers exactly like a missing id; `perfidia-1`'s siege, Crown and countdown extras never leak; ally movement visibility exactly as `movementAccess` grants, so never in `perfidia-1` and in full in `sandbox-1`); P15 (both parts, part (a) with the placeholder and multiset comparison of §13.2, intel types from protocol and `ruleset.intelEvents` exempt); P16 at match scale; the two-process determinism test; the boundary scan test; a performance printout of the 1-day runs.
- Acceptance: the rebuilt gateway state equals the live state returned by `runMatch` (canonical JSON) at the end of 1-day lockstep and `VirtualTime` runs for both rulesets, and the rebuild of a log with a missing `turn` line differs (the test can fail); every test above green for both rulesets; each fix reported with its cause; the default `bun test` suite measured and still under about 90 s; `bun run check` green.

### 15.8 Wave 7

**T17 — Exit criterion, freeze artefacts, pacing report, CI.**

- Owns: `packages/sim/src/exit/**`, `packages/sim/src/golden.test.ts`, `packages/sim/fixtures/**`, `.github/workflows/ci.yml` (add an `exit` job); fix rights over `packages/{protocol,engine,gateway,bots}/src/**` and over `packages/sim/src/**` (T17 runs alone in wave 7, and relies on T15's CLI and T14's harness); removal of the remaining `*_PACKAGE` constants; a "17. Deviations" section appended to `docs/architecture.md`.
- Do: §13.5–13.9. The exit-criterion tests of §13.7 for both rulesets in the three clocks (exit suite, `PERFIDIA_EXIT=1`, `perfidia-1` with `time.dominationStart=604801`), comparing second runs by normalised-log hash, plus the run on unmodified `perfidia-1` defaults (item 5); a scenario agent (`exit/scenario.ts`) for the `scenario-late` golden; bot tuning (bots only, never published ruleset numbers) to reach the drama minimum, **before** any golden is written; the goldens of §13.5 and `fingerprints.json` of §13.6 through the harness's add-only writer; `golden.test.ts` in the default suite (§13.5); `batch` twice with the variant order reversed; the pacing report of §13.9 for N = 6, 8 and 12; the CI `exit` job running `bun run test:exit` with a timeout; removal of `PROTOCOL_PACKAGE`, `ENGINE_PACKAGE`, `GATEWAY_PACKAGE`, `BOTS_PACKAGE` once nothing imports them; every deviation from this document recorded; `bun run format`.
- Acceptance: `bun run test:exit` is green for both rulesets in lockstep, virtual-clock and system-clock real time with zero `INTERNAL` `gw` lines, and on unmodified `perfidia-1` defaults (a domination end accepted), and its output (with the §13.8 figures) is attached; the goldens and fingerprints are committed and `bun run sim -- golden --check` passes; a plain `bun test` runs `golden.test.ts`, which passes, and fails on a tampered temporary copy of a golden and on a `perfidia-1` descriptor with an altered cheat sheet; every published ref in `RULESETS` has at least one golden and a fingerprint entry; `lockstep-6p-4d` reaches t ≥ 259200; `scenario-late` contains a siege, a relief, a homecoming, a capital conquest with re-homing, an elimination, a pact expiry, a superseded pact, and a domination start, cancel and win (asserted from its events); reversed-order batches give identical results; the pacing report is attached and not asserted; the CI `exit` job exists; the performance CI limits are met or the gap is reported with measurements; the default suite stays under about 90 s; no placeholder constant remains; deviations are recorded; `bun run format` then `bun run check` green.

---

## 16. Review decisions

### 16.1 Design review

The design review's issues were applied, except the variants and rejections below.

1. **Same-second trains (`arriveAt` on `attack`/`support`): rejected.** Scheduled departures need new hidden state, a new event kind and validation deferred to departure time. `perfidia-1` §8.11 and §15.2 now say that waves from different islands land minutes apart, in arrival order.
2. **Amending `CLAUDE.md` for `bun install`: not needed.** The orchestrator installs dependencies in every worktree (§15.1), so the rule "do not run `bun install`" holds as written.
3. **Shared vision and the fake-attack bluff: the transparency is stated** (`perfidia-1` §8.9) instead of hiding pop used from allies. Allies see units at home live, so hiding pop alone would not restore the bluff, and hiding units would empty shared vision.
4. **Opaque ids: a keyed permutation of (owner, own counter)** instead of a PRNG stream with collision redraws. Messages and reports are not in the state, so collisions could not be checked; per-owner counters also make a player's own ids independent of others' actions, which P15 can test.
5. **Queue item numbers: a per-city counter** instead of the event `seq`, which is global and would leak other players' activity like global ids did.
6. **A build item after a wall breach adds +1 to the current level**, rather than lowering the targets of queued items at the breach: no state rewrite, and the projection formula stays valid.
7. **Partial recall with several stationed groups: optional `home` and an `AMBIGUOUS_GROUP` rejection**, rather than an implicit allocation order, so agents know exactly which units leave.
8. **Seat names are removed** from the setup and the state rather than constrained to the player id: same effect, less surface.
9. **`WAKE_RANGE` is removed**: `end_turn` now clamps and warns. **`SPY_GOLD` moves to the domain codes**, since `spyMinGold` is generic `CompiledRules` data (a consistency fix found while applying the review).
10. **Urgent wake gap of 600 s.** `judgments.md` rejected ring-crown's 1800 s gap as contrary to the brief ("as soon as the turn ends"). The brief also says close events are grouped; 600 s is read as that grouping for urgent events. It is far below the 1 h minimum warning, and every briefing lists every incoming attack.
11. **Homecoming visibility: visible to the besieger**, as an `incoming_attack` with `homecoming: true` and an urgent wake, since it is a battle on the besieger's garrison.
12. **Lockstep round timeout: optional**, needing an injected `TimeSource`; bots never hit it, so Level G stays reproducible.
13. **Snapshots only at checkpoints**, rather than a running event index in `ev` lines: the snapshot hash is then checkable against the `ckpt` line, and `--from` needs no new line field.
14. **Long default-config golden: 4 game days, 6 seats**, not 7 days with 12 seats: it passes the day-4 domination opening and capital immunity, and the time-compressed `scenario-late` golden covers the late mechanics. Committing 7-day 12-seat logs per ref would cost several MB each.
15. **Message and proposal caps by kind (ring-crown): deferred.** No phase-1 ruleset needs them; they will be a new `GatewayRules` field gated as §3.5 requires.
16. **Placeholder removal is spread** over the barrel-owning tasks plus T17, instead of one cleanup task, so no merged tree ever imports a removed constant.
17. **Plan shape: 7 waves instead of 5.** T01 runs alone first (lint before code), cross-ruleset hardening gets its own task, and the freeze artefacts come last, after every fix.

### 16.2 Completeness review

Every gap was applied: the freeze-guard test in the default suite (§13.5), the bots purity guard and the approximated-maths bans (§2.4, §6.1), the config checks (§3.6), the gateway rebuild (§10.5), the briefing channel for ruleset state (§8.2), one-object tool schemas with descriptions (§3.7, §8.3), and the minor fixes (P10 and P15, `sandbox-1`'s `minTravel`, file ownership, the `defer` and `controller` lines and the line order, `end_turn {}`, `queue_empty`, recalls into a besieged home, `intelEvents`, `rng` stream names, the §7.3 example, `INTERNAL`, the exit criterion, the opaque-id key, phase 2's player count, bots reading `rules.gateway`). Where the fix differs from the proposal, or a choice was offered:

1. **Layer matrix: enforced by the source scan, not by one lint override per layer.** `architecture.test.ts` resolves package and relative specifiers exactly, sees type-only imports and keeps the matrix in one table. Seven lint overrides would each have to repeat the whole ban list, since a later override replaces an earlier one's options, and a forgotten copy would silently drop a ban. Lint keeps the `**/rulesets/**` edge for fast feedback.
2. **`**` and aliased `Math`: a source scan.** Verified with oxlint 1.87: it has no `no-restricted-syntax`, and `no-restricted-properties` misses `const m = Math` and `Reflect.get(Math, …)`. The scan uses an allowlist of exact `Math` members, so a member added to the language later is banned by default. `globalThis` is banned outright, which also closes `globalThis.Math` and `globalThis.Date`.
3. **Bots: `BOTS_UPSTREAM` goes in wave 1 (T01)**, not wave 3: the new ban on runtime imports of `gateway` would otherwise turn `bun run check` red until T09. The `gateway` dependency stays in `package.json`, so `bun.lock` does not change.
4. **Config checks: more than proposed.** Besides the proposed checks, `time.matchEnd ≥ 1` (the kernel schedules `match_end` at creation and asserts `at > now`), `toolCallsPerWake` null or ≥ 1, and `ownWakesPerDay`, `socialWakesPerDay ≥ 1` (a budget of 0 would move a wake to the next day forever).
5. **Gateway rebuild: a fold over the log (option a), not gateway snapshots.** A snapshot alone cannot resume a real-time match: the lines after it still need the fold. The fold reuses `verifyLog` through a new `onLine` callback, so the engine re-run supplies the violation details. It is T16's (wave 6, with fix rights over the gateway) rather than T14's, which is already the largest task; T14 produces the lines it needs.
6. **P10 and P15: neither proposed option alone works.** Excluding other owners' id counters from perturbations forbids adding or removing hidden entities, since each needs its counter. Renaming ids consistently breaks when entities are emitted in id order, because the order of pseudo-random ids changes. Hence P10 stays exact, with perturbations that never change an id X can see, and P15(a) compares placeholders as a multiset.
7. **Recall into a besieged home: the return takes `max(minTravel, now − departAt)`**, rather than rejecting the recall: rejection would strand the army exactly when its owner needs it. It lives in `std.turnBack` and keys on generic `hold` groups, so any ruleset with sieges gets the speed rule for free.
8. **Opaque ids: fixed now, not documented as a limit.** The scheme freezes into the goldens' hashes, and the fix costs one `MatchSetup` field: a 128-bit `idKey` and SHA-256 rounds (8 instead of 4, as small-domain format-preserving schemes use). `idKeyFromSeed` keeps tests, goldens and `batch` reproducible from the seed; only LLM matches need a random key.
9. **Same-second order in real time: receipt order, a deliberate deviation from the brief.** The brief says same-second actions are applied "in a seeded order, recorded in the log". Lockstep does that. Real time applies receipt order, which is logged, so replay is unaffected; seeding the order would mean holding every action until its second ends, which delays every real-time result. `docs/brief.md` ("Game loop") still says "seeded order"; its owner should update it.
10. **Hand-offs: runtime support now**, not only a reserved line kind. `RunMatchOptions.handoffs` plus the `controller` line let Level G rebuild a handed-off match, and the log format is cheapest to extend before the goldens exist.
11. **ASCII names and ASCII case folding** (found while applying the approximated-maths fix): Unicode property classes and full case mapping depend on the runtime's Unicode tables, like `Intl`.

---

## 17. Deviations

Every place where the code differs from this document, or adds to it, as of the phase-1 freeze (T17). Each one is also noted where it is defined and pinned by a test. Where this document and the code disagree, the code and this section win until the sections above are amended.

### 17.1 Recorded by earlier tasks

- **Gateway seat functions (§8.2, §8.4, §8.5, §10.5; T07, T16).** The full list is in the header of `gateway/src/seat/index.ts`. In short:
  - `requestSelfWake(seat, at, now)` and `writeNote(s, text, mode, max, t)` take the call time. The clamp range of §8.3 starts at the `end_turn` call time, and every `ToolResult` carries `t`.
  - The folds of §10.5 are `wake.begin` then `briefed`, `closeTurn`, `recordAct` and `recordGw`.
  - `WakeScheduler` also has `rules` and `peek(seat)`. The state adds `SeatWake.urgentReasons`, `SeatWake.deferTo`, `SeatState.lastBriefingE` and `SeatState.turnFailures`.
  - A seat's news is the feed after the delivery number of its last briefing, not after a time, and leaves out events already in its inbox.
  - `lastTurn.unseen` folds repeated `TURN_OVER` and `CALLS_CAP` rejections into one entry per code, with a `count`.
  - `wake.begin` drains an urgent reason only once its `urgentMinGap` has passed.
  - `deliver` eliminates the seat on `player_eliminated`.
  - `seatErrorText` words the gateway's own cap codes, so the rebuild can regenerate them.
- **`read_notes` numbering (§8.4; T16).** `ArchiveHit.e` and `ArchiveEntry.e` number only the entries the seat can read (its archive and the public feed), not the global delivery number, which let a seat count hidden events between two of its entries (P15).
- **`INTERNAL` in the rebuild (§10.5; T16).** An `INTERNAL` whose explainer throws is regenerated with the host's fixed `INTERNAL_FALLBACK` text, as the live host words it, not as the bare code.
- **`TurnHandle.close(failure?)` (§9.1; T08).** It takes the agent failure instead of `error?: string`, so a timed-out round is logged as `why: "timeout"`.
- **Gateway presentation additions (§8.1, §8.2; T13).**
  - `view_city` of an own or allied city lists `outgoing` movements, as far as `movementAccess` grants.
  - Briefing `events` and `news` entries carry `at`, the time the event happened.
  - `more` also names a call for truncated `events`.
  - When even the newest message does not fit with a 300-character cut, it is kept, cut shorter (down to `MESSAGE_MIN_CUT`).
- **Boundary scan (§13.4; T16).** The `read_notes` scope literal `"mine"` collides with the `perfidia-1` building id. It is allowed in `seat/archive.ts` and `present/briefing.ts` only; §13.4 excepts only `build`.
- **`perfidia-1` standings while the match runs (ruleset §13.2; T16).** Ties are broken by cities, then the public tie-break order. Battle points, which §12 keeps private, break ties only in the final ranking of §13.4. Under P10 the order of tied players showed raw battle points. This is a clarification of `perfidia-1@1.0.0`, written into ruleset §13.2 and frozen by the `views` fingerprint of every golden, which hashes the standings at every checkpoint (§13.6).
- **`perfidia-1` config bounds (§16; T06).** The schema adds upper bounds (table sizes, tiles, paces, jitter) so that no schema-valid config makes `compile` or `createWorld` throw or lose integer exactness (§3.6).
- **`sim run --trace-hashes` (§5.3, §12.1; T15).** `runMatch` has no option to forward the engine's trace, so the trace is computed by a Level E replay of the written log. A test checks that it agrees with the engine's own trace.
- **`sim batch` and test rulesets (§12.1; T15).** `batch` runs test rulesets such as `sandbox-1` without `--allow-test` and prints a note, since the batch table of §12.2 compares them with `perfidia-1`.

### 17.2 Introduced by T17

- **`scenario-late` overrides (§13.5).** The scenario is `sim/src/exit/scenario.ts`: one scripted agent per seat (label `scenario:late@1`), seed 1, six seats, lockstep, strict, step invariants. It ends by domination at t = 15600, in about 4 h 20. The overrides change only numbers, but they are not the example set of §13.5:
  - `time.matchEnd=86400`, `time.protectionEnd=0`, `time.capitalImmunityEnd=3600`, `time.siegeDuration=7200`, `time.pactDuration=7200`, `time.dominationStart=7200` and `time.dominationHold=3600`.
  - `siegeDuration` is 7200, not 3600, so that a relief and a homecoming launched at the siege start land before its end (travel is at least `minTravel`).
  - `units.transport.seaPace=20` and `movement.homeboundPace=20` put neighbouring capitals 1 h apart.
  - `start.capital.units={"guard":10,"raider":200,"settler":4,"transport":20}` gives every capital an army in its seed: one object-valued override of the seed's unit counts.
  - `victory.dominationPm=375` and `victory.dominationMinPerPlayer=0` set the domination threshold to 3 of the 8 cities.
- **Writing `scenario-late` (§12.1, §13.5).** `sim golden --update` writes it through the same add-only writer as the bot goldens. A `GoldenSpec` is either a bot run or a scripted scenario. A scenario golden is kept when its name exists, and a changed script needs a new name. Its coverage (siege, relief, homecoming, a capital conquered from a player who keeps a fallback city, with that player's army abroad re-homed there, elimination, pact expiry, superseded pact, domination start, cancel and win) is asserted from its lines in `golden.test.ts`. So is a re-run of the scenario, byte for byte (normalised). Both run in the default suite.
- **Bot tuning (§11.2, before the first goldens).** The `expander` accepts every pact and one alliance while it has none; before, it declined every alliance. Only opportunists offer alliances, and both the expander and the rusher declined them. On `perfidia-1`, 12 seats, 7 days, `time.dominationStart=604801`, seeds 1–10:
  - matches with an alliance went from 5/10 to 7/10;
  - matches with a betrayal went from 3/10 to 7/10.

  Labels stay `@1`: no golden existed before the change (§11.1).

- **Exit suite details (§13.7, §13.8).**
  - Seed 1 for every run.
  - The system-clock runs use speed 86400 (one game day per wall second), at which the bots still play whole turns.
  - The CI limits of §13.8 are asserted; the targets are printed.
  - The exit suite also runs `batch` twice with its variant order reversed at full scale: `perfidia-1` and `sandbox-1`, 2 seeds, 12 seats, 7 days.
  - The CI `exit` job (20 min timeout) also runs `bun run sim -- golden --check`, as the merge gate does.
- **Placeholders (§2.2, §15.1).** `PROTOCOL_PACKAGE`, `ENGINE_PACKAGE`, `GATEWAY_PACKAGE` and `BOTS_PACKAGE` are removed, and tests assert that they are gone.

### 17.3 Measured at the freeze

**Exit runs (§13.7, §13.8).** Seed 1, 12 seats (3 of each bot), 7 game days, on an Apple M4 Pro laptop; `bun run test:exit` took 49 s, and the timed runs follow a 1-day warm-up match of each ruleset. Every run ended at t = 604800 by time, with no `fatal` and no `INTERNAL`, and passed Level E. Lockstep and virtual-clock second runs were identical; system-clock runs depend on wall time and vary from run to run. The published defaults run started no domination countdown: at day 7 the threshold, `max(2N, 40%)` of about 73 cities, is 30, and no bloc reached it.

| Run                             | Wall   | Level E | Battles | Conquests | Alliances | Betrayals |
| ------------------------------- | ------ | ------- | ------- | --------- | --------- | --------- |
| `perfidia-1` lockstep           | 2.48 s | 0.37 s  | 62      | 6         | 2         | 1         |
| `perfidia-1` virtual, speed 3   | 2.32 s | 0.38 s  | 65      | 7         | 2         | 2         |
| `perfidia-1` system, 86400×     | 7.07 s | 0.42 s  | 88      | 6         | 2         | 2         |
| `sandbox-1` lockstep            | 1.26 s | 0.24 s  | 29      | 5         | 2         | 0         |
| `sandbox-1` virtual, speed 3    | 1.25 s | 0.23 s  | 36      | 8         | 2         | 0         |
| `sandbox-1` system, 86400×      | 7.07 s | 0.24 s  | 45      | 6         | 2         | 0         |
| `perfidia-1` published defaults | 2.19 s | 0.38 s  | 62      | 6         | 2         | 1         |

Against the budget of §13.8, every target is met:

- lockstep 2.5 s (target 5 s, CI limit 20 s);
- real time under `VirtualTime` 2.3 s (10 s, 40 s);
- Level E replay of a 7-day log 0.37 s (3 s, 15 s);
- full state hash at day 7 0.96 ms, p95 of 20 (10 ms);
- briefing build p95 0.14 ms (1 ms);
- default `bun test` suite 50 s, the golden replays included (90 s).

**Pacing report (`perfidia-1` §19.5, §13.9), reported and never asserted.** `sim batch --pacing`, `perfidia-1@1.0.0` defaults, the four bots, seeds 1–10, 7 days. Each cell is the mean over the 10 matches, measured at the end of the day. The min and max of cities are over every player of every match. Battles and sieges count that day's events only. The table shows days 1, 3, 5 and 7.

| N   | Day | Cities / player (min–max) | Free slots | Army pop | Score | Battles | Sieges started / held / broken |
| --- | --- | ------------------------- | ---------- | -------- | ----- | ------- | ------------------------------ |
| 6   | D1  | 2.0 (2–2)                 | 30.0       | 19.6     | 232.9 | 0.1     | 0 / 0 / 0                      |
| 6   | D3  | 3.6 (2–5)                 | 20.3       | 217.0    | 474.4 | 8.2     | 0 / 0 / 0                      |
| 6   | D5  | 5.0 (2–8)                 | 11.7       | 693.0    | 709.7 | 7.2     | 1.9 / 1.8 / 0                  |
| 6   | D7  | 6.2 (2–11)                | 4.6        | 1445.3   | 910.7 | 15.5    | 0.5 / 0.5 / 0                  |
| 8   | D1  | 2.0 (2–2)                 | 32.0       | 18.8     | 233.7 | 0.1     | 0 / 0 / 0                      |
| 8   | D3  | 3.9 (2–5)                 | 17.0       | 213.3    | 506.5 | 8.9     | 0 / 0 / 0                      |
| 8   | D5  | 5.2 (2–8)                 | 6.1        | 719.3    | 734.8 | 9.6     | 1.7 / 1.5 / 0.2                |
| 8   | D7  | 6.0 (3–10)                | 0.1        | 1507.3   | 885.6 | 11.8    | 1.1 / 1.1 / 0                  |
| 12  | D1  | 2.0 (2–2)                 | 48.0       | 18.9     | 233.7 | 0.2     | 0 / 0 / 0                      |
| 12  | D3  | 3.8 (2–5)                 | 26.2       | 216.6    | 499.3 | 15.0    | 0.1 / 0.1 / 0                  |
| 12  | D5  | 5.2 (2–8)                 | 9.3        | 727.3    | 733.3 | 16.7    | 2.0 / 2.0 / 0                  |
| 12  | D7  | 6.0 (2–10)                | 0.1        | 1481.6   | 886.4 | 19.6    | 0.6 / 0.5 / 0.1                |

Winners by strategy:

- N = 6: expander 7, opportunist 3;
- N = 8: expander 6, opportunist 4;
- N = 12: opportunist 7, expander 3.

There were no eliminations. Against the §19.5 criteria:

- **Free land gone by day 4–5: missed.** At the end of D5, 11.7 (N = 6), 6.1 (N = 8) and 9.3 (N = 12) free slots are left. Land is nearly gone (0.1 slot left) only at the end of D7 for N = 8 and 12, and 4.6 slots are still free then for N = 6.
- **At least one siege per player-pair border by day 5: missed.** By the end of D5, matches have started 2.2 (N = 6, 6 borders), 2.2 (N = 8, 8 borders) and 3.3 (N = 12, 12 borders) sieges.
- **No bot type winning more than 60% of seeds: missed for N = 6 and 12, met for N = 8.** The expander wins 70% at N = 6 and 60% at N = 8, and the opportunist wins 70% at N = 12. The rusher and the turtle never win.

These numbers are proposals for `perfidia-1@1.1.0`. `perfidia-1@1.0.0` does not change. Bots alone may miss the criteria (§13.9), so the gap is a property of these bots and these rules together.

### 17.4 Final review (before the phase-1 merge)

`perfidia-1@1.0.0` and `sandbox-1@1.0.0` are published when `phase1` merges into `main`. The final review's fixes that change behaviour were therefore made in `1.0.0` itself, and every golden and fingerprint entry was regenerated with `sim golden --update` after deleting the old ones. From the merge on, §3.5 applies in full. `ENGINE_VERSION` stays `0.1.0` (no version was released).

- **Fog of war: a return's origin (ruleset §9.3, §12).** A return seen with `incoming` access (the besieger of its home) shows `from: null` in `MovementView` and `BriefingIncoming`, and `perfidia-1`'s homecoming `incoming_attack` notice carries `from: null`. The origin was the target of a bounced movement, or a city where the returning player had troops stationed. The P10 and P15 staging adds a siege held by the observer, with a return heading into it, and a `returnOrigin` perturbation.
- **Warnings of a turn's last round (§8.2, §8.3).** `lastTurn.warnings` lists them, because no round follows the last one and the usual pattern is `[actions…, end_turn]`. The `turn` line records `end_turn`'s clamp (`clamp: {requested, at}`), so the rebuild regenerates `WAKE_CLAMPED`. No compact success list is added: the next briefing's cities and `moves` show the new queue items and movements.
- **`read_notes` paging (§8.2, §8.3).** `search.before` is a cursor on the readable number `e`. Each `more` call of the briefing targets exactly the entries left out.
- **Freeze guard (§13.5, §13.6).** The artefacts add the title, the config and event JSON Schemas, the extra tools and the initial world at every N. A `views` fingerprint per golden covers the hooks' outputs. A 12-seat golden is added. A CI job enforces append-only on pull requests (`sim golden --check --base`).
- **Homecoming reports (ruleset §14.2).** The returning owner's `battle_report` of a homecoming is addressed as `target`, a social wake: other players can force a homecoming (a dismissal, a bounce), and they never spend a seat's own budget.
- **Refunds lost to the warehouse cap (ruleset §4.3, §9.1).** `cancel_queue` returns `lost` next to `refund` (`std.cancelFrom`, `removeQueueItems` and `clearQueues` return `{refund, lost}`). At a siege start, the owner alone gets the `perfidia-1` event `queues_refunded {city, refund, lost}`, an intel event for P15.
- **`time.recallWindow = 0` (ruleset §18).** It disables recalls: `perfidia-1` compiles `recall.kinds: []`. An inclusive window of 0 s still allowed a recall in the launch second.
- **Checks.** `checkRules` requires `resourceScale` to be a multiple of 3600 (§3.6). `validateRegistry` checks the wake and `publicOncePerDay` event types, the `key` field of `publicOncePerDay` types, and `errors` codes against the domain and gateway codes (§3.5). The boundary scan takes its ids from every ruleset of `RULESETS` (§13.4).
- **Level E (§10.2, §10.4).** Numbered lines must be consecutive. A missing last numbered line just before the `end` line is still not detected: the `end` line carries no count.
- **One mechanism for siege clean-up (`perfidia-1` §9.7, §7.7).** `afterStep`'s sweeps break the sieges of an eliminated besieger and announce returns re-homed onto a besieged fallback. The explicit duplicates in `eliminatePlayer` and `conquer` are gone, and the events are unchanged.
- **Agent-visible text.** The interface block gains a `BRIEFING` line naming every compact field and array order. The turn, self-wake, `end_turn` and `read_notes` texts describe `lastTurn.warnings` and `before`. `read_notes {open}` renders its entry like every view: control characters stripped, times as pairs. One `stripControl` (C0, DEL, C1, U+2028, U+2029) and one `copyJson` live in `gateway/src/seat/clean.ts`. Spy-report queue times (`start`, `end`) render as pairs.
- **Clean-ups.** Core holds the one `own`, `HOUR`, `canonicalCopy` and `jsonCopy`; `protocol/log.ts` keeps its own `HOUR`, since protocol imports nothing from the engine. `perfidia-1`'s combat allocates split-stack losses with `std.allocateLosses`. An unreachable domination branch now fails as an `EngineBug`. The sim reads every log, the goldens included, with one strict reader (`harness/reader.ts`). Unused exports are removed. The chaos agent stays exported, because the sim's hardening and integration tests use it. The clock's fake host is a `*.test.ts` kit (`clock/testkit.test.ts`).
- **Exit suite (§13.7).** The published-defaults run asserts that domination opens on day 4. A further run with a lower threshold must start countdowns. Re-measured after these fixes (seed 1): the `perfidia-1` lockstep run took 2.27 s (Level E 0.35 s) for 62 battles, 6 conquests, 2 alliances and 1 betrayal. The domination run started 4 countdowns, cancelled 2 and ended by domination at t = 345600. The default `bun test` suite took about 46 s.

### 17.5 `perfidia-1@1.1.0` (domination by conquest, Greek ids)

`perfidia-1@1.1.0` is published next to `1.0.0` and is the default (`docs/rulesets/perfidia-1.md` §0.1 lists the rule changes; `docs/rulesets/perfidia-1-v1.0.0.md` keeps the 1.0.0 text). `1.0.0` does not change: its goldens and fingerprint entries are untouched and pass (`sim golden --check --base` against the previous commit's `fingerprints.json`; artefacts `6e3b2195…` as before).

- **Module layout.** A names table (`names.ts`, `NAMES_1_0_0` and `NAMES_1_1_0`: the building, unit and island-kind ids and the prize tag) parameterises the parts both versions share: the config sections (`schema.ts`), the compiler (`compiler.ts`), the map (`world.ts`), the score rows (`score.ts`), the cheat-sheet helpers (`text.ts`), the siege hooks (`siegeHooksWith`) and the invariants (`perfidiaInvariantsFor`). The 1.0.0 modules bind them to `NAMES_1_0_0` and keep their exports (the T06 export-list test is unchanged). This refactor came first, in its own commit, and changed no behaviour: the 1.0.0 and `sandbox-1` fingerprints and every golden's Level E and G were unchanged, and 5,650 generated override sets gave the same config errors before and after. The 1.1.0 modules are the `*_1_1.ts` files and `v1_1_0.ts`.
- **Domination by conquest (ruleset §13.3).** The ext records each conquest (`conquests[city] = {by, former}`); a city is taken for its owner's bloc when the owner conquered it and no member of the bloc ever owned it (`holdByOwner` reads each owner's bloc as it is now). The countdown condition is 1.0.0's with `taken ≥ victory.dominationMinConquests` added, a countdown starts only until `matchEnd − dominationHold`, and the threshold counts the map's city slots, Olympus included. `domination_started` carries `taken` and `needTaken`; the leaderboard and the briefing show each bloc's taken count next to the threshold.
- **Config checks (ruleset §16).** Bounds on `victory.dominationPm` (1..1000), `dominationMinPerPlayer` (≥ 1) and `dominationMinConquests` (≥ 0), and per N a threshold that is neither 0 nor above the map's slots and a taken count the threshold can hold, each with a message saying how to fix it, all skipped when domination is off (`time.dominationStart` after `time.matchEnd`).
- **Bots and sim.** Hints by exact ref (§11.1). The batch's prize bonus reads `olympusBonus`, and the R1 reachability metric (`teams.ts`) applies the taken rule with former owners. The hardening kit and hidden-state tests cover both refs. Tests that pinned 1.0.0 behaviour name `perfidia-1@1.0.0`; none was weakened.
- **The reskin is not neutral for the bots.** The bots iterate config records such as a building's `requires` in canonical key order, which the new ids change (`acropolis` sorts before `barracks`, `hall` after it). The same seed and lineup therefore diverge at t = 0 between the two versions (seed 1, 6 seats, default bots: at the third log line, a turtle's first build), before any rule difference applies. Comparisons of 1.0.0 and 1.1.0 batches measure the ids and the rules together. `sim/src/reskin.test.ts` checks the engine side instead: the actions of three 1.0.0 bot goldens, ids renamed and domination off, replay under 1.1.0 to the same events and results.
- **Cost.** `validateRegistry`, run on every `getRuleset` call, checks one more descriptor: about 46–61 ms per call against 32–38 ms before on the 4-vCPU machine. The freeze guard test replays 27 goldens instead of 22: about 90 s alone against about 67 s before, so its timeout is 240 s.
- **Calibration, before the first release.** The defaults were calibrated before `1.1.0` left its branch, so they changed in place (ruleset §0.1, "Why these values"): `victory.dominationPm` 350 instead of 1.0.0's 400, `dominationMinConquests` 2 and `dominationMinPerPlayer` 2 kept, the conquest-trophy key `scoring.conquestBonus` (0 until then) removed, every time kept. Only the goldens and the fingerprint entry `1.1.0` had added were regenerated; 1.0.0's and `sandbox-1`'s are untouched. Method: `sim batch --pacing --per-match --json` from a snapshot of the commit, bots pinned, two batches at a time on the 4-vCPU machine (about 13 s per 6-seat match, 17–20 s at 8 seats, 31 s at 12), 820 matches plus 30 to pick the war golden's seed; the default lineup `expander@2,rusher@3,turtle@3,opportunist@3,conqueror@3` (cycled) and the war-call lineup `conqueror@3,opportunist@3,turtle@3,conqueror@3,expander@2,rusher@3`; for example `bun run sim -- batch --variant "v110: perfidia-1@1.1.0" --variant "pm350: perfidia-1@1.1.0 victory.dominationPm=350" --seeds 1-60 --players 6 --bots <lineup> --pacing --per-match --json <out>.json --out <dir>`. Variants are compared paired by seed, with exact McNemar tests on seat wins and bootstrap intervals on per-run counts; the rule changes were replayed offline on the logs first (the offline replay at 350‰ predicted the 9 domination wins of the real 60-seed batches exactly).
  - **Control.** `perfidia-1@1.0.0` with the same bots: the final hashes of seeds 1–30 in both lineups equal those recorded at `22dc9c1` (60 of 60); 20 and 21 of 60 six-seat matches end by domination, 39 of the 41 winning blocs holding 0 or 1 conquered city. Each 1.0.0/1.1.0 pair of a seed diverges at t = 0 (the bots' key order, above), so decisions compare 1.1.0 variants only.
  - **`dominationPm`.** At 400‰: 1 of 60 six-seat matches by domination per lineup, 11 countdowns (9 started on day 7, too late to end), none at 8 or 12 seats. At 350‰: 4 of 60 (default) and 10 of 120 (war) six-seat matches (7% [3, 16] and 8% [5, 15]); paired with 400‰, +3 and +4 domination ends (90% intervals [+0.02, +0.10] and [+0.02, +0.12] per run), conquests 1.78 → 1.83 and 3.32 → 3.32 per run, relief rates and seat wins unchanged within 1–3 wins (McNemar p ≥ 0.25). Every winning bloc is a pair holding 16–17 cities at its countdown's start with exactly 2 taken, none from its own members. 300‰ (offline): 6 and 8 of 60; 350‰ with 1 taken city (offline): 12 and 19 of 60, 17 of those 31 winners holding a single taken city. At 8 seats (18 of 49) the best bloc holding 2 taken cities stays 1–13 cities short (4.8 on average in the war lineup); at 12 seats (26 of 73), 7–21. One war-lineup bloc met R1 with both taken cities taken from its own new ally (seed 63 of 61–120: `conqueror@3` took two `opportunist@3` cities, then they allied on day 7 and started a countdown at once), the conquest-then-alliance path that the review's bloc rule closed (below).
  - **Wins per seat at 350‰** (Wilson 95%): default 6 seats `opportunist@3` 0.33 [0.23, 0.46], `expander@2` 0.25, `conqueror@3` 0.23; war 6 seats (120 seeds) `opportunist@3` 0.39 [0.31, 0.48], `expander@2` 0.33, `conqueror@3` 0.18; 8 seats `expander@2` 0.37 [0.26, 0.49] (default) and `conqueror@3` 0.19 (war); `rusher@3` at most 0.15 and `turtle@3` 0 everywhere (`turtle@3` last on average). The battle score is 2.5–3.6% of all points.
  - **R2 (conquest trophy, battle-score levers).** Rescored offline from the final standings and the conquest records (exact for the score, approximate for bots that read the leaderboard), then one real batch: +30 per taken city moves no winner in the default lineup and 2–4 of 30 at 8 seats; in the war lineup it moves 7 of 60 wins from `opportunist@3` (0.47 → 0.35, McNemar p = 0.016) to `conqueror@3`, as predicted. `killPopPerPoint` 3 or 5 with `killCapPm` 500 lift `opportunist@3` to 0.55 and 0.52 in the war lineup. Left out because the effect depends on the lineup (none in the default one, a significant rebalance in the war one) and seed-set variance (about ±0.15 wins per seat between seed sets) exceeds the margin of the 0.45 cap, so the cap cannot decide; the trophy of 30 stays an option for the owner (ruleset §0.1).
  - **Times.** Geometric relievability (transport travel from an unbesieged city of the owner or an ally, plus the 600 s urgent wake, within the siege): 6 h reaches 100%, 99% and 97–98% of sieges at 6, 8 and 12 seats, 4 h reaches 99–100%, 96% and 92–94%. A paired 6-seat batch at 4 h (`time.siegeDuration=14400`): conquests +19% (90% interval [+0.07, +0.65] per run) in the default lineup and +7% ([−0.12, +0.58]) in the war lineup, reliefs arriving 82% → 76% and 64% → 60% of sieges. That is short of the +25% in every lineup a change needed, and 4 h is not relievable enough at 12 seats: `siegeDuration` stays 21600. `protectionEnd`, `capitalImmunityEnd` and `matchEnd` stay: first battle at 15:00–16:10 on day 1 on average, no capital conquered and no elimination in any 1.1.0 match, winner's median margin 4–9%, 15–25% of conquests on day 7.
  - **Acceptance criteria of the decision report (§6.6) with these bots.** Met: no domination with fewer than 2 taken cities; no strategy above 0.45 per seat (`opportunist@3` 0.39 over 120 war seeds, though 0.47 [0.35, 0.59] on seeds 1–60 alone); `turtle@3` at 0; median margin ≥ 5% at 6 and 8 seats (4.0% at 12); replays 100% OK. Not met: domination and last-standing ends 15–35% (7–8% at 6 seats, 0 at 8); an elimination in 30% of matches (0 in every batch, 1.0.0 included); `conqueror@3` within 0.20–0.45 (0.23 default and 0.18 war at 6 seats, 0 default and 0.19 war at 8); at most 5 free slots at the end of day 5 (5.6 in the war lineup at 6 seats; 4.6 default, 0.7–2.3 at 8 seats). Whether domination happens as often as intended depends on the players: no bot seeks taken cities.
  - The batch R1 metric reads a 1.0.0 log with 1.1.0's defaults (`R1_SHARE_PM` 350).
- **Review fixes (before the release).** A review of the calibrated branch led to these changes of the unpublished 1.1.0, with its goldens and fingerprint entry regenerated (1.0.0's and `sandbox-1`'s untouched: `sim golden --check --base` against the `fingerprints.json` of `835254c` passes, 27 goldens, the 1.0.0 artefacts still `6e3b2195…`):
  - **Taken cities per bloc.** A city counts as taken for a bloc only when no member ever owned it, so two players can no longer trade cities and then ally (seed 63 above) or count a city an ally recaptured for a member; a conquest after a betrayal still counts. Engine (`isTaken` with the owner's bloc, `holdByOwner`, `takenNow` for the city views) and the batch R1 metric follow the same rule; `takenFromBloc` now counts the cities a bloc conquered from its own members, which R1 does not count.
  - **Countdown cutoff.** A countdown starts only while it can end by `matchEnd` (until `matchEnd − dominationHold`); before, 19 of the 35 countdowns of the first calibration started on day 7 and expired, each with a public event and an urgent wake for every seat. The WIN line of the cheat sheet gives the cutoff ("must start by D7 00:00").
  - **Bounds whatever the domination switch.** `map.kinds.*.slots` ≤ 100 and `victory.dominationMinPerPlayer`, `dominationMinConquests` ≤ 1000 in the 1.1.0 schema: before, `{"map.kinds.frontier.slots": 1e14, "time.dominationStart": 604801}` was accepted and the first step threw `EngineBug: … dividend must be a safe integer` (with domination on, the same config was rejected only as `check(config) threw RangeError`). `afterStep` also computes nothing for domination while it is closed.
  - **Cheat sheet.** A UNITS line gives each unit's role from its numbers (the new names no longer say which unit attacks), and the WIN line names the floor per player only when it is the larger term. `woodcutter` became `sawmill` (a place, like `quarry` and `goldmine`, and `sandbox-1`'s wood producer).
  - **Bots.** The 1.1.0 hints add `needTaken` and `ownTaken` (§11.1): `opportunist@2` and `@3` no longer hold back a betrayal for a countdown their bloc cannot start for want of taken cities. `opportunist@3` now betrays in 41 of 60 default and 47 of 60 war matches (34 and 45 before).
  - **Re-calibration** from a snapshot of the working tree (two batches at a time, about 35 min for 180 six-seat matches): `bun run sim -- batch --variant "h24: perfidia-1@1.1.0" --variant "h12: perfidia-1@1.1.0 time.dominationHold=43200" --variant "h18: perfidia-1@1.1.0 time.dominationHold=64800" --seeds 1-60 --players 6 --bots <lineup> --pacing --per-match --json <out>.json --out <dir>` for both lineups; the same three variants with `--bots conqueror@3,conqueror@3,opportunist@3 --seeds 1-20`; `--players 9 --seeds 1-20` with the default lineup; and the war golden's seed search (`--days 6 --seeds 1-30`, war lineup: seed 14 is still the first that ends by domination, so `WAR_SEED_1_1` stays 14). Results at 24 h: domination 3 of 60 (5% [2, 14]) default and 4 of 60 (7% [3, 16]) war; every countdown's bloc a pair with 16–17 cities and 2 or 3 taken, none conquered from a member, and every winner exactly 2 taken; wins per seat `opportunist@3` 0.32 [0.21, 0.44] and 0.48 [0.36, 0.61], `expander@2` 0.26 and 0.28, `conqueror@3` 0.22 and 0.15, `rusher@3` and `turtle@3` 0; battle score 2.5–2.6% of all points; no elimination; replays 100% OK. Of the 9 and 10 matches where a bloc met R1, 6 and 5 met it first after D7 00:00.
  - **Hold (kept at 24 h).** Paired by seed, 12 h gives 8 of 60 dominations in both lineups (13% [7, 24]; difference per match [+0.03, +0.15] and [+0.02, +0.12]), seat wins within +4/−1 per strategy (McNemar p ≥ 0.125), conquests −3%; 18 h gives 3 and 5 of 60. In the aggressive lineup (20 seeds), 24 h: 5 countdowns on day 6, all broken by rivals, no domination; 12 h: the same 5 broken, and 3 countdowns started on D7 before 12:00 win; 18 h: 1. The extra dominations of 12 h come from blocs that qualify on day 7, a consequence of the bots' late founding, so the hold stays as the decision report set it (ruleset §0.1); 12 h is the lever to try if LLM blocs also qualify late.
  - **Seat counts.** 9 seats (20 seeds, default lineup): no countdown; blocs of three peaceful bots reached 20 and 23 cities with no taken city, and blocs with 2 taken cities held 9.1 cities on average (20 needed). With the 8- and 12-seat batches above, only N = 6 produced dominations; ruleset §0.1 recommends N = 6 for matches where domination should be live.
- **For the owner.** Resource ids and positional island kinds keep their 1.0.0 names. Domination by conquest needs players that seek taken cities; pilot LLM matches will show whether 350‰ is reachable often enough.

### 17.6 Phase 2: the orchestrator

- **SDK.** The LLM harness uses the official `@anthropic-ai/sdk` (pinned exactly at `0.131.0` in the root catalog) behind the provider-agnostic `ModelAdapter`, not the Vercel AI SDK the brief names: the latter lags the provider features the harness needs (adaptive thinking with explicit effort, server-side refusal fallbacks, per-block cache TTLs, refusal `stop_details`, per-iteration usage, mid-conversation `system` messages). Only `orchestrator/src/model/anthropic.ts` imports it; an oxlint override and the orchestrator's architecture test enforce it. The brief's stack row is the owner's to update in its source document.
- **MCP.** Gateway exposure over MCP is deferred to the server phase. Phase-2 LLM seats call the gateway's tools through the provider's function calling, in process (`CLAUDE.md` said "MCP exposure comes in phase 2").
- **Gateway.** One additive change: `RunMatchOptions.handoffQueue` (§8.7), polled when a seat's turn opens after the static hand-offs, writing the same `controller` line. Existing paths are unchanged (every golden's Level E and G).
- **Formats.** The run-directory formats of the orchestrator (`llm_calls.jsonl`, `seats.json`, `arena.json`) are Zod schemas in `orchestrator/src/log/schema.ts`, not in `protocol`, until phase 3 reads them. The spectator feed format is phase 3's; the arena writes the readable `feed.txt` only.

## 18. Phase 2: first agents

Roadmap step 2 (4 Claude seats and 2 bots on a 6-seat `perfidia-1` map) is built as `packages/orchestrator`; **`docs/phase2.md` describes it as built**: layers, the LLM seat's turn loop, the Anthropic adapter, budget and hand-offs, failures and the arena pause gate, the run directory and `arena.json`, costs, and how to run the first real match.

- **Dependency direction:** `protocol` ← `engine` ← `gateway` ← `bots` ← `sim` ← `orchestrator`. The future `server` sits downstream of it.
- **Seat contract.** `LlmSeatAgent implements SeatAgent` (§9.1): the gateway drives the rounds, and engine and gateway stay LLM-agnostic. Every LLM action goes through the same tools, validation and log lines as a bot's, so Level E holds for every arena log in both clocks; Level G does not apply to LLM seats (`resimProblem`).
- **CLI.** `bun run arena -- <command>` (`run`, `cost`, `personalities`, `smoke`); exit codes as `sim`'s (§12.1). `arena run --fake` plays every LLM seat with a bot-backed fake model: the whole pipe, no network, $0.
- **Environment.** Only `PERFIDIA_ANTHROPIC_API_KEY` and `PERFIDIA_ANTHROPIC_BASE_URL` (and `PERFIDIA_LIVE` for the opt-in live test) are read, once, by the arena CLI; nothing reads `ANTHROPIC_*`. No test touches the network.
- **Suites.** The default `bun test` includes a full 2-day lockstep arena match on fake models (Level E, gateway rebuild, exit-criterion report) and a 7-day match stopped after day 1 (`--stop-after`). `bun run test:exit` runs four 7-day arena matches to their end. `bun run test:live` (opt-in, spends under $0.20) is the only test that calls the API.
- **Not built in phase 2:** crash resume (lockstep matches that crash are rerun; required before a multi-day real-time match), the optional red-team check, the spectator feed.

## 19. Phase 3: the spectator view

Roadmap step 3 (a live map, a diplomatic feed and a leaderboard) is built in passes; **`docs/phase3.md` describes Passes A, B and C as built**: Pass A (data and server) is the incremental replay and gateway fold, the `@perfidia/spectator` projection, the spectator schemas and the read-only server (how to run it, its API, what is public); Pass B (§14, §15 there) is the web app `@perfidia/web`, served by the server with `--web-dist`, its end-to-end smoke test, the measurements and the deviations. Pass C (§16 there) adds the extras, loaded on demand: the turn detail (each round's reasoning, tool calls with ✓/✗ and codes, cost and tokens; `?turn=pN.T`), the dossier extras (turns, messages and betrayals at the playhead, hourly sparklines of score and cities, the notebook's history; `TIMELINE_VERSION` 4) and the live per-round reasoning in the Thoughts column.

- **Dependency direction:** `protocol` ← `engine` ← `gateway` ← `spectator` ← `server`, beside `bots` ← `sim` ← `orchestrator`; `protocol/spectator` ← `spectator/reduce` ← `web`. Web sources import only those two sub-paths, React and the pinned UI packages (an architecture test and a lint override); the web package's tests may use `server` and `orchestrator` (dev dependencies of the smoke test).
- **Purity.** The engine's replayer and the spectator projection stay browser-pure (the pure lint override covers `packages/spectator/src`; `src/reduce` imports `@perfidia/protocol/spectator` only). The server folds in worker threads only, never on its main thread.
- **Steps depend on `match.jsonl` only.** Costs, reasoning and replies are annotations, served apart, so a live fold, a refold after a restart and a fold of the finished file give the same steps and clients resume by cursor.
- **CLI.** `bun run serve -- --runs <dir> [--cache <dir>] (--publish <file> | --all-runs)`. It binds 127.0.0.1 unless given a `publish.json` and its public host names (`--public-host`), answers only to its own `Host` names; it reads only `PORT` and `PERFIDIA_SERVE_TRUST_PROXY`, and never serves seeds, id keys, prompts, transcripts, request ids or error texts.
- **Web.** A React SPA bundled by `Bun.build` with Tailwind through its CLI (`bun run web:build`, budget 200 KB of JS gzipped, checked by the build and by a test), `bun run dev` for development, and `bun run test:e2e` (opt-in: headless Chromium through playwright-core against an in-process server; skipped with a printed reason otherwise). Player text is plain text only; ruleset ids live in `src/skins/` only.
- **Not built yet:** the outsider exit test on a real match (an owner step); hosting, the database and MCP (later steps).

## 20. Phase 4: the multi-model arena

Roadmap step 4 (seats with different models, budgets, per-model stats; criterion: the cost per match is known and under the set budget) is built in passes; **`docs/phase4.md` describes Pass 1a, Pass 1b, Pass 2 and Pass 3 (statistics and web) as built**: the exit path on the Claude family, the provider plumbing, the adapters and calibration, then per-model statistics. "Known and under budget" has four parts: predicted before the run (`arena estimate`, and `estimate.json` written once before turn 1 with its sha256 in `seats.json`), guaranteed during it (a match budget whose kill switch stops every model attempt at `K = budget − reserve`), reported after it (`arena.json` `perfidia-arena/2`, its `budget` and `exit4` blocks) and reconciled with the provider's usage page (`arena reconcile`, exit code 4 outside tolerance).

- **Where.** `orchestrator` only, plus additive schema changes in `protocol/src/arena.ts` (hand-off reasons `cap | match_budget | outage | operator`, the `preflight`, `prompt_cap`, `kill_switch`, `operator` and `carry` lines, the estimate, lineup and reconcile files) and the spectator annotations (they read the widened reasons and skip the new lines). Engine, gateway, bots and sim are untouched; goldens and fingerprints are unchanged.
- **Guarantee.** `MatchBudget` (`budget/ledger.ts`) counts every charge (attempts, thought calls, the start preflight, probes, the carry of a crashed run); the reserve is one attempt bound per LLM seat (the prompt cap at the highest input-side price plus the retry limit's output at the highest output price, fallback iterations included) plus one probe and the start preflight. The kill flag is checked right before every attempt and thought call, after the pause and rate gates; a fast-check scheduler test drives real seat agents to show spend never exceeds the budget.
- **Lineups.** `perfidia-lineup/1` files; presets in `packages/orchestrator/lineups/` (`claude-duo`, the exit lineup of the Claude form, and `claude-family`). Pass 1a plans `anthropic` seats only and keeps the Anthropic prompt bytes and controller labels of ec8e2ad (pinned by hash); a seat with fallbacks `off` sends no `fallbacks` field.
- **CLI.** `bun run arena -- estimate|run|reconcile|cost …` with `--lineup`, `--budget-usd`, `--on-budget handoff|abort`, `--budget-carry`, `--prompt-cap`; exit code 4 is a reconciliation outside tolerance. Pass 1a left the environment unchanged (`PERFIDIA_ANTHROPIC_*` only, read in `arena/`; Pass 1b widens it below); the Anthropic client refuses redirects (`redirect: "error"`).
- **Pass 1b (provider plumbing).** A provider registry (`arena/providers.ts`: `anthropic`, `openai`, `google`, `openrouter`, `compat`) with `PERFIDIA_<PROVIDER>_API_KEY` and `_BASE_URL` only; `model/http.ts`, the only `fetch` (origin-pinned, header allowlist, no redirects, SSE, error codes before statuses); price cards in integer pico-dollars per provider, endpoint, tier and validity window with sources and check dates (every model of the design's §5.4, OpenRouter's 5.5% fee charged and logged apart), attempt bounds over every card valid from the run's start; the label grammar `llm:<provider>/<model>[@<endpoint>]/<effort>:<profile>@<v>:p<N>[-dev|-env]` (escaped ids; Anthropic labels unchanged), parsed by the server; operator-channel variants (`system` = phase 2's bytes, `developer`, `[harness]` envelope) and a per-lineup reminder cadence; a tool transform hook with per-seat hashes in `seats.json`; the fake path mirroring each seat's intended provider and cards (`--price-date` for byte-identical runs); the `budget-mix`, `mid-tier`, `mid-tier-flash` and `frontier` presets. Seats of every provider plan and run on `--fake`; only Anthropic seats run for real. All schema changes are additive; engine, gateway, bots and sim are untouched.
- **Review fixes** (`docs/phase4.md` §25): the kill switch halts every seat before any hook runs and survives a failing one; every Claude bound covers US-only inference (1.1×, read from `usage.inference_geo`; a non-global workspace is refused at the preflight); a crashed run's carry includes its reserve; signals are taken from before the start preflight (SIGHUP included); the client redacts its key from error messages; reconcile accepts estimated output and dated-window excess; `perfidia-arena/1` reports have a reader schema.
- **Pass 2 (adapters and calibration).** Three raw-`fetch` adapters on `model/http.ts`, each with Zod wire schemas in `model/wire/`: the OpenAI Responses API (`model/openai.ts`), Gemini `generateContent` with the pinned `gemini@1` tool transform (`model/gemini.ts`, `model/gemini-tools.ts`), and OpenRouter / OpenAI-compatible Chat Completions with a full-slug endpoint pin, a served-endpoint check and the plan-time live metadata check (`model/compat.ts`, `arena/providers/openrouter.ts`). The registry's `create` builds every non-Anthropic seat; every provider runs for real. Usage maps so the ledger is never below the bill (cached and written prompt tokens, reasoning billed as output, OpenRouter's reported cost and fee); an unknown usage is charged the attempt bound. `arena smoke --provider … --record <dir>` writes sanitised `perfidia-recording/1` exchanges; `arena calibrate` builds `perfidia-profile/1` profiles from real lockstep runs, which give `measured-point` and `calibrated` predictions; `arena series` rotates a lineup over Latin and Graeco-Latin squares (`perfidia-series/1`). A cross-adapter conformance suite and a 2-day four-provider wire-stub match (loopback stubs, the real adapters, the bot-backed brain) pin the behaviour; nothing has called a real API yet (the owner's smokes, §36 of `docs/phase4.md`). Engine, gateway, bots and sim are untouched.
- **Pass 3 statistics** (`docs/phase4.md` §41–§48). `protocol/src/stats.ts` (`perfidia-stats/1` per seat per match, `perfidia-model-stats/1` across matches, the claim state; re-exported by `@perfidia/protocol/spectator`); a pure fold in `@perfidia/spectator/stats` over the spectator fold and the side files (diplomacy from verified event fields, pacts kept and broken, same-model and cross-model counts, hand-offs, caps, tool-call errors, the parallel-call share, cost and tokens); `packages/server/src/stats/`: aggregation per model (or profile, prompt variant, model × profile) grouped by the root's `series.json`, MAP Plackett–Luce ratings (prior σ 1.5) with Laplace intervals widened to a seeded block bootstrap's from 5 blocks (their union) and pairs at the claim's Bonferroni level, intention-to-treat headline and clean sensitivity, cost per lineup, and the claim threshold of an exact binomial test at 80% power over every pair of compared models plus a balanced rotation (no outcome or ranking below it; `unbalanced` otherwise; the server drops them from any file below it); `bun run stats -- match|aggregate|power`; `GET /api/matches/:id/stats`, `/api/models` and `/api/models/:id` (`serve --stats <file>`, `publish.json` visibility, `--no-costs`). Engine, gateway, bots, sim and the orchestrator are untouched.
- **Pass 3 web** (`docs/phase4.md` §49–§54). `web/src/lib/models.ts`: display names for every catalog model and provider (`GLM-5.3 (Z.AI via OpenRouter)`), efforts in each vendor's terms, the reasoning kind a seat shows; reasoning-kind tags wherever reasoning shows (a provider's summary or a raw chain of thought); the dossier's model block (`players/model-block.tsx`, from `GET /api/matches/:id/stats`, fetched again when the match's status moves on; its whole-match figures cut at the playhead unless the viewer asks for them); the `/models` and `/models/:id` page (`models/**`), ratings only above the claim threshold and "too few matches: N more needed" below it; all loaded on demand (initial JS 177.6 KB gzipped of 185). The Pass 3 review's fixes are in `docs/phase4.md` §55.
- **Not built yet:** the optional red team (agent H).
