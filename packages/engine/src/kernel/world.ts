import { CanonicalJsonError, fnv1a64 } from "@perfidia/engine/core";
import type { AnyRuleset, DomainModule, WorldSetup } from "@perfidia/engine/contracts";
import {
  DOMAIN_EVENT_KINDS,
  GameStateSchema,
  JsonSchema,
  MOVEMENT_KINDS,
  RESOURCE_IDS,
  compareIds,
  type City,
  type CompiledRules,
  type ConfigIssue,
  type DeepReadonly,
  type GameState,
  type MatchSetup,
  type Sha256,
  type UnitCounts,
} from "@perfidia/protocol";
import { MatchConfigError } from "./checks.ts";
import { jsonCopy } from "./copy.ts";
import { makeReadCtx, takeStream, type CtxEnv } from "./ctx.ts";
import { errorMessage } from "./errors.ts";
import { scheduleEvent } from "./queue.ts";

// Match creation (docs/architecture.md §5.3 "Creation", §3.6 "Creation checks"). Every failure here
// is a `MatchConfigError`, raised before any log line is written.

const MAX_LISTED = 12;

/** The movement kind an `arrive_<kind>` event resolves, or null for any other kind. */
export function arrivalKind(kind: string): (typeof MOVEMENT_KINDS)[number] | null {
  if (!kind.startsWith("arrive_")) return null;
  const k = kind.slice("arrive_".length);
  return MOVEMENT_KINDS.find((x) => x === k) ?? null;
}

/** Whether some handler resolves `kind` (§5.1 "Dispatch"). */
function hasHandler(kind: string, ruleset: AnyRuleset, domain: DomainModule): boolean {
  if (kind === "match_end") return true;
  const arrival = arrivalKind(kind);
  if (arrival !== null) {
    if (arrival === "attack" || arrival === "spy") {
      return typeof ruleset.hooks.arrive[arrival] === "function";
    }
    return (
      typeof ruleset.hooks.arrive[arrival] === "function" ||
      typeof domain.arrivals[arrival] === "function"
    );
  }
  const on = ruleset.hooks.on ?? {};
  return (
    (Object.hasOwn(on, kind) && typeof on[kind] === "function") ||
    (Object.hasOwn(domain.events, kind) && typeof domain.events[kind] === "function")
  );
}

/**
 * Every scheduled kind (the domain kinds, the ruleset's `on` kinds, the world timers' kinds) has a
 * class; every kind with a class has a handler; `match_end` is alone in its class and handled only
 * by the kernel.
 */
export function checkEventKinds(
  ruleset: AnyRuleset,
  domain: DomainModule,
  rules: DeepReadonly<CompiledRules>,
  timerKinds: readonly string[],
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const classes = rules.eventClasses;
  const on = ruleset.hooks.on ?? {};
  const needed = new Set<string>([...DOMAIN_EVENT_KINDS, ...Object.keys(on), ...timerKinds]);
  for (const kind of [...needed].toSorted(compareIds)) {
    if (!Object.hasOwn(classes, kind)) {
      issues.push({ path: `eventClasses.${kind}`, message: `event kind ${kind} has no class` });
    }
  }
  for (const kind of [...new Set([...needed, ...Object.keys(classes)])].toSorted(compareIds)) {
    if (!hasHandler(kind, ruleset, domain)) {
      issues.push({
        path: `eventClasses.${kind}`,
        message: `event kind ${kind} has no handler (ruleset hooks or domain module)`,
      });
    }
  }
  for (const kind of Object.keys(on).toSorted(compareIds)) {
    if (kind === "match_end" || arrivalKind(kind) !== null) {
      issues.push({
        path: "",
        message: `hooks.on.${kind} would never run: ${kind === "match_end" ? "the kernel handles match_end through hooks.finish" : "arrivals are handled by hooks.arrive"}`,
      });
    }
  }
  const endClass = classes["match_end"];
  if (endClass !== undefined) {
    const sharing = Object.keys(classes)
      .filter((k) => k !== "match_end" && classes[k] === endClass)
      .toSorted(compareIds);
    if (sharing.length > 0) {
      issues.push({
        path: "eventClasses.match_end",
        message: `match_end must have a class of its own; class ${endClass} is shared with ${sharing.join(", ")}`,
      });
    }
  }
  return issues;
}

function listIssues(issues: ConfigIssue[]): ConfigIssue[] {
  if (issues.length <= MAX_LISTED) return issues;
  return [
    ...issues.slice(0, MAX_LISTED),
    { path: "", message: `… and ${issues.length - MAX_LISTED} more issues of the same kind` },
  ];
}

function addUnits(into: UnitCounts, units: Readonly<UnitCounts>): void {
  for (const [unit, n] of Object.entries(units)) {
    if (n !== undefined && n > 0) into[unit] = (into[unit] ?? 0) + n;
  }
}

function stockIssues(rules: DeepReadonly<CompiledRules>, cities: readonly City[]): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const city of cities) {
    const level = city.buildings[rules.roles.storage] ?? 0;
    const cap = rules.levels.storage[level];
    if (cap === undefined) {
      issues.push({
        path: `cities.${city.id}.buildings.${rules.roles.storage}`,
        message: `the storage table does not cover level ${level}`,
      });
      continue;
    }
    for (const r of RESOURCE_IDS) {
      if (city.stock[r] > cap * rules.resourceScale) {
        issues.push({
          path: `cities.${city.id}.stock.${r}`,
          message: `start stock ${city.stock[r]} resource-seconds (${Math.floor(city.stock[r] / rules.resourceScale)} ${r}) exceeds the storage cap ${cap} of ${rules.roles.storage} level ${level}`,
        });
      }
    }
  }
  return issues;
}

/** The parameters of `buildInitialState`. */
export interface WorldParams {
  readonly setup: MatchSetup;
  readonly ruleset: AnyRuleset;
  readonly domain: DomainModule;
  readonly config: unknown;
  readonly configHash: Sha256;
  readonly rules: DeepReadonly<CompiledRules>;
  readonly env: CtxEnv;
}

/**
 * Runs `createWorld` and builds the initial state: players `p1..pN` and their private counters,
 * public counters from the largest ids, the ledger filled with the initial units, the world timers
 * and `match_end` scheduled. Runs the creation checks of §3.6 (event kinds, timers at ≥ 1, start
 * stock within the storage cap, every travel probe ≥ `time.minTravel` for every pair of islands,
 * the same island included). Throws `MatchConfigError`.
 */
export function buildInitialState(p: WorldParams): GameState {
  const { setup, ruleset, rules } = p;
  const seats = setup.seats.map((s) => s.id);
  let world: WorldSetup<unknown>;
  try {
    world = ruleset.hooks.createWorld({
      seed: setup.seed,
      players: seats,
      config: p.config,
      rules,
      rng: (stream) => takeStream(p.env, setup.seed, stream),
    });
  } catch (error) {
    throw new MatchConfigError([{ path: "", message: `createWorld threw ${errorMessage(error)}` }]);
  }

  let copy: WorldSetup<unknown>;
  try {
    copy = jsonCopy({
      islands: world.islands,
      cities: world.cities,
      ext: world.ext,
      timers: world.timers,
    });
  } catch (error) {
    if (error instanceof CanonicalJsonError) {
      throw new MatchConfigError([
        { path: "", message: `createWorld returned non-canonical data: ${error.message}` },
      ]);
    }
    throw error;
  }

  const issues: ConfigIssue[] = [];
  const ext = JsonSchema.safeParse(copy.ext);
  if (!ext.success) {
    issues.push({
      path: "ext",
      message: `createWorld returned an ext that is not JSON: ${ext.error.issues[0]?.message ?? ""}`,
    });
  }
  issues.push(
    ...checkEventKinds(
      ruleset,
      p.domain,
      rules,
      copy.timers.map((t) => t.kind),
    ),
  );
  for (const [i, timer] of copy.timers.entries()) {
    if (!Number.isSafeInteger(timer.at) || timer.at < 1) {
      issues.push({
        path: `timers.${i}.at`,
        message: `world timer ${timer.kind} is at ${timer.at}; timers fire at t ≥ 1`,
      });
    }
  }

  const islands: GameState["islands"] = {};
  for (const island of copy.islands) {
    if (Object.hasOwn(islands, island.id)) {
      issues.push({ path: `islands.${island.id}`, message: "duplicate island id" });
    }
    islands[island.id] = island;
  }
  const cities: GameState["cities"] = {};
  let lastCity = 0;
  for (const city of copy.cities) {
    if (Object.hasOwn(cities, city.id)) {
      issues.push({ path: `cities.${city.id}`, message: "duplicate city id" });
    }
    cities[city.id] = city;
    lastCity = Math.max(lastCity, Number(city.id.slice(1)) || 0);
  }
  issues.push(...stockIssues(rules, copy.cities));

  const players: GameState["players"] = {};
  const own: GameState["ids"]["own"] = {};
  const ledger: GameState["ledger"] = { neutral: { made: {}, gone: {} } };
  for (const id of seats) {
    players[id] = { id, alive: true, eliminatedAt: null, alliance: null };
    own[id] = { m: 0, r: 0, q: 0, g: 0 };
    ledger[id] = { made: {}, gone: {} };
  }
  for (const city of copy.cities) {
    const home = ledger[city.owner ?? "neutral"];
    if (home !== undefined) addUnits(home.made, city.units);
    for (const group of city.stationed) {
      const entry = ledger[group.owner];
      if (entry !== undefined) addUnits(entry.made, group.units);
    }
  }

  const state: GameState = {
    v: 1,
    ruleset: ruleset.ref,
    configHash: p.configHash,
    seed: setup.seed,
    now: 0,
    status: "running",
    seq: 0,
    ids: { c: lastCity, a: 0, own },
    evHash: fnv1a64(""),
    queue: [],
    players,
    islands,
    cities,
    movements: {},
    proposals: {},
    alliances: {},
    pacts: [],
    ledger,
    ext: ext.success ? ext.data : null,
    result: null,
  };

  const shape = GameStateSchema.safeParse(state);
  if (!shape.success) {
    for (const issue of shape.error.issues) {
      issues.push({
        path: issue.path.map((x) => String(x)).join("."),
        message: `the initial state is invalid: ${issue.message}`,
      });
    }
  }
  if (issues.length > 0) throw new MatchConfigError(listIssues(issues));

  issues.push(...travelIssues(p, state));
  if (issues.length > 0) throw new MatchConfigError(listIssues(issues));

  for (const timer of copy.timers) scheduleEvent(state, rules, timer.kind, timer.at, timer.ref);
  scheduleEvent(state, rules, "match_end", rules.time.matchEnd, "");
  return state;
}

/** Every travel probe takes at least `time.minTravel` between every pair of islands (§3.6). */
function travelIssues(p: WorldParams, state: GameState): ConfigIssue[] {
  const { rules, ruleset } = p;
  const issues: ConfigIssue[] = [];
  if (rules.travelProbes.length === 0) {
    return [
      {
        path: "travelProbes",
        message: "no travel probe: the creation travel check needs the fastest group",
      },
    ];
  }
  const r = makeReadCtx(p.env, state);
  const ids = Object.values(state.islands)
    .map((i) => i.id)
    .toSorted(compareIds);
  for (const a of ids) {
    for (const b of ids) {
      for (const probe of rules.travelProbes) {
        let t: number;
        try {
          t = ruleset.hooks.travelTime(r, a, b, probe.group);
        } catch (error) {
          issues.push({
            path: "",
            message: `travelTime(${a}, ${b}, ${probe.label}) threw ${errorMessage(error)}`,
          });
          continue;
        }
        if (!Number.isSafeInteger(t) || t < rules.time.minTravel) {
          issues.push({
            path: "time.minTravel",
            message: `travelTime(${a}, ${b}, ${probe.label}) = ${t}, below time.minTravel (${rules.time.minTravel})`,
          });
        }
      }
    }
  }
  return issues;
}
