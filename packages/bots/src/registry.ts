// The bots registry (docs/architecture.md §11): strategies by name, versioned labels
// `bot:<strategy>@<n>`, and the factory that `sim` uses for live runs and Level G re-simulation.
// Only the latest version of each strategy is kept (§11.1).

import type { SeatAgent } from "@perfidia/protocol";
import { BotAgent, type BotOptions } from "./agent.ts";
import { expander } from "./strategies/expander.ts";
import { opportunist } from "./strategies/opportunist.ts";
import { rusher } from "./strategies/rusher.ts";
import { BOT_STRATEGIES, type BotStrategy, type StrategyDef } from "./strategies/strategy.ts";
import { turtle } from "./strategies/turtle.ts";

const DEFS: Readonly<Record<BotStrategy, StrategyDef>> = Object.freeze({
  expander,
  rusher,
  turtle,
  opportunist,
});

export function isBotStrategy(s: string): s is BotStrategy {
  return (BOT_STRATEGIES as readonly string[]).includes(s);
}

/** The label of the current version of `strategy`, e.g. `bot:expander@1`. */
export function botLabel(strategy: BotStrategy): string {
  const def = DEFS[strategy];
  return `bot:${def.name}@${def.version}`;
}

/** A new bot for one seat of one match (its caches are its own: never share an instance). */
export function createBot(strategy: BotStrategy, o: BotOptions): SeatAgent {
  return new BotAgent(DEFS[strategy], o);
}

/** `bot:<strategy>@<n>` → its strategy and version, or null when malformed or not in the registry. */
export function parseBotLabel(label: string): { strategy: BotStrategy; version: number } | null {
  const m = /^bot:([a-z]+)@([1-9][0-9]*)$/.exec(label);
  if (m === null) return null;
  const name = m[1]!;
  const version = Number(m[2]);
  if (!isBotStrategy(name) || DEFS[name].version !== version) return null;
  return { strategy: name, version };
}

/** The bot a label names (Level G rebuilds agents from the log's labels), or null when unknown. */
export function botFromLabel(label: string, o: BotOptions): SeatAgent | null {
  const parsed = parseBotLabel(label);
  return parsed === null ? null : createBot(parsed.strategy, o);
}
