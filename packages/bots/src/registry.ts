// The bots registry (docs/architecture.md §11): strategies by name, versioned labels
// `bot:<strategy>@<n>`, and the factory that `sim` uses for live runs and Level G re-simulation.
// Every published version of every strategy stays registered (§11.1), so the goldens of an older
// version keep their Level G check after a newer one ships: a behaviour change is a new def with the
// next version, added to `PUBLISHED` beside the frozen old one. Unversioned calls use the latest.

import type { SeatAgent } from "@perfidia/protocol";
import { BotAgent, type BotOptions } from "./agent.ts";
import { conqueror } from "./strategies/conqueror.ts";
import { conqueror2 } from "./strategies/conqueror2.ts";
import { expander } from "./strategies/expander.ts";
import { opportunist } from "./strategies/opportunist.ts";
import { rusher } from "./strategies/rusher.ts";
import { rusher2 } from "./strategies/rusher2.ts";
import { BOT_STRATEGIES, type BotStrategy, type StrategyDef } from "./strategies/strategy.ts";
import { turtle } from "./strategies/turtle.ts";

/**
 * Every published (strategy, version), in any order. A new version or a new strategy (its name in
 * `BOT_STRATEGIES`) is one more entry; an entry is never removed or changed once goldens use it.
 */
const PUBLISHED: readonly StrategyDef[] = Object.freeze([
  expander,
  rusher,
  rusher2,
  turtle,
  opportunist,
  conqueror,
  conqueror2,
]);

/** One registered version of a strategy. */
export interface BotVersion {
  readonly strategy: BotStrategy;
  readonly version: number;
}

/** A set of strategy versions, and the label parser and factories over it. */
export interface BotRegistry {
  /** The strategies, in `BOT_STRATEGIES` order. */
  readonly strategies: readonly BotStrategy[];
  /** The registered versions of `strategy`, ascending. */
  versions(strategy: BotStrategy): readonly number[];
  /** The highest registered version of `strategy`. */
  latest(strategy: BotStrategy): number;
  /** Every registered label, by strategy order then version. */
  labels(): readonly string[];
  /** The label of `version` of `strategy` (default the latest); throws when it is not registered. */
  label(strategy: BotStrategy, version?: number): string;
  /** A new bot of `version` of `strategy` (default the latest); throws when it is not registered. */
  create(strategy: BotStrategy, o: BotOptions, version?: number): SeatAgent;
  /** `bot:<strategy>@<n>` → its strategy and version, or null when malformed or not registered. */
  parse(label: string): BotVersion | null;
  /** The bot of exactly the version a label names, or null when the label is not registered. */
  fromLabel(label: string, o: BotOptions): SeatAgent | null;
}

export function isBotStrategy(s: string): s is BotStrategy {
  return (BOT_STRATEGIES as readonly string[]).includes(s);
}

const labelOf = (strategy: string, version: number): string => `bot:${strategy}@${version}`;

/**
 * A registry over `defs`. Throws on a def whose version is not a positive integer, on a
 * (strategy, version) given twice, on a def of a strategy outside `strategies`, and on a strategy
 * without any def.
 */
export function createBotRegistry(
  defs: readonly StrategyDef[],
  strategies: readonly BotStrategy[] = BOT_STRATEGIES,
): BotRegistry {
  const byName = new Map<BotStrategy, Map<number, StrategyDef>>(
    strategies.map((s) => [s, new Map()]),
  );
  for (const def of defs) {
    const versions = byName.get(def.name);
    if (versions === undefined) {
      throw new Error(`bots registry: ${def.name} is not a strategy (${strategies.join(", ")})`);
    }
    if (!Number.isSafeInteger(def.version) || def.version < 1) {
      throw new Error(`bots registry: ${def.name} has version ${def.version}, not an integer ≥ 1`);
    }
    if (versions.has(def.version)) {
      throw new Error(`bots registry: ${labelOf(def.name, def.version)} is registered twice`);
    }
    versions.set(def.version, def);
  }
  const sorted = new Map<BotStrategy, readonly number[]>();
  for (const [name, versions] of byName) {
    if (versions.size === 0) throw new Error(`bots registry: ${name} has no version`);
    sorted.set(name, Object.freeze([...versions.keys()].toSorted((a, b) => a - b)));
  }
  const all = Object.freeze(
    strategies.flatMap((s) => (sorted.get(s) ?? []).map((v) => labelOf(s, v))),
  );

  const versionsOf = (strategy: BotStrategy): readonly number[] => {
    const v = sorted.get(strategy);
    if (v === undefined) throw new Error(`bots registry: unknown strategy ${strategy}`);
    return v;
  };
  const latest = (strategy: BotStrategy): number => versionsOf(strategy).at(-1) ?? 0;
  const find = (strategy: BotStrategy, version: number): StrategyDef | undefined =>
    byName.get(strategy)?.get(version);
  const defOf = (strategy: BotStrategy, version: number | undefined): StrategyDef => {
    const v = version ?? latest(strategy);
    const def = find(strategy, v);
    if (def === undefined) {
      throw new Error(
        `bots registry: no ${labelOf(strategy, v)}; ${strategy} has ${versionsOf(strategy)
          .map((n) => `@${n}`)
          .join(", ")}`,
      );
    }
    return def;
  };
  const known = (s: string): s is BotStrategy => (strategies as readonly string[]).includes(s);
  const parse = (label: string): BotVersion | null => {
    const m = /^bot:([a-z]+)@([1-9][0-9]*)$/.exec(label);
    const strategy = m?.[1] ?? "";
    const version = Number(m?.[2]);
    if (!known(strategy) || find(strategy, version) === undefined) return null;
    return { strategy, version };
  };

  return Object.freeze({
    strategies: Object.freeze([...strategies]),
    versions: versionsOf,
    latest,
    labels: () => all,
    label: (strategy: BotStrategy, version?: number): string => {
      const def = defOf(strategy, version);
      return labelOf(def.name, def.version);
    },
    create: (strategy: BotStrategy, o: BotOptions, version?: number): SeatAgent =>
      new BotAgent(defOf(strategy, version), o),
    parse,
    fromLabel: (label: string, o: BotOptions): SeatAgent | null => {
      const p = parse(label);
      return p === null ? null : new BotAgent(defOf(p.strategy, p.version), o);
    },
  });
}

/** The registry of this build: every published version of every strategy. */
export const BOTS: BotRegistry = createBotRegistry(PUBLISHED);

/** The registered versions of `strategy`, ascending. */
export function botVersions(strategy: BotStrategy): readonly number[] {
  return BOTS.versions(strategy);
}

/** Every registered label, e.g. `bot:expander@1`, by strategy order then version. */
export function botLabels(): readonly string[] {
  return BOTS.labels();
}

/** The label of the latest version of `strategy` (or of `version`), e.g. `bot:expander@1`. */
export function botLabel(strategy: BotStrategy, version?: number): string {
  return BOTS.label(strategy, version);
}

/** A new bot of the latest version of `strategy` for one seat of one match (never share an instance). */
export function createBot(strategy: BotStrategy, o: BotOptions): SeatAgent {
  return BOTS.create(strategy, o);
}

/** A new bot of exactly `version` of `strategy`; throws when that version is not registered. */
export function createBotVersion(strategy: BotStrategy, version: number, o: BotOptions): SeatAgent {
  return BOTS.create(strategy, o, version);
}

/** `bot:<strategy>@<n>` → its strategy and version, or null when malformed or not in the registry. */
export function parseBotLabel(label: string): BotVersion | null {
  return BOTS.parse(label);
}

/** The bot of exactly the version a label names (Level G rebuilds agents from the log's labels), or null. */
export function botFromLabel(label: string, o: BotOptions): SeatAgent | null {
  return BOTS.fromLabel(label, o);
}
