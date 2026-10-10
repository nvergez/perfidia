// The contract between the turn engine and a strategy (docs/architecture.md §11.2).

import type { ToolCall } from "@perfidia/protocol";
import type { Knobs, Planner } from "../plan.ts";
import type { BotRng } from "../rng.ts";
import type { World } from "../world.ts";

export const BOT_STRATEGIES = Object.freeze([
  "expander",
  "rusher",
  "turtle",
  "opportunist",
] as const);
export type BotStrategy = (typeof BOT_STRATEGIES)[number];

/** A strategy instance for one seat, with its parameters drawn once per (match seed, seat). */
export interface Brain {
  readonly knobs: Knobs;
  /** Reads wanted after the base views (targets, the leaderboard); duplicates are dropped. */
  reads(w: World): readonly ToolCall[];
  /** Plans this turn's calls on the planner, highest priority first. */
  plan(p: Planner): void;
}

export interface StrategyDef {
  readonly name: BotStrategy;
  /** Bumped on any behaviour change once goldens exist (§11.1, §13.5). */
  readonly version: number;
  brain(rng: BotRng): Brain;
}
