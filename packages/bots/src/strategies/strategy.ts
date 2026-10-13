// The contract between the turn engine and a strategy (docs/architecture.md §11.2).

import type { ToolCall } from "@perfidia/protocol";
import type { Knobs, Planner } from "../plan.ts";
import type { BotRng } from "../rng.ts";
import type { World } from "../world.ts";

/**
 * The strategy names, in the order `sim` cycles them over the seats by default. A new strategy is
 * appended here and its defs are added to the registry's `PUBLISHED` list (`registry.ts`).
 */
export const BOT_STRATEGIES = Object.freeze([
  "expander",
  "rusher",
  "turtle",
  "opportunist",
  "conqueror",
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

/**
 * One published version of a strategy. A behaviour change once goldens exist is a new def with the
 * next version, registered beside the old one, which stays frozen (§11.1, §13.5).
 */
export interface StrategyDef {
  readonly name: BotStrategy;
  /** An integer ≥ 1, unique per strategy. */
  readonly version: number;
  /**
   * A preview: registered (labels, `name@n`, Level G) but not the default yet, so unversioned
   * calls keep the highest version without the flag. A release drops it.
   */
  readonly preview?: boolean;
  brain(rng: BotRng): Brain;
}
