// @perfidia/orchestrator: the LLM harness (phase-2 design). The model layer (`ModelAdapter`, the
// Anthropic adapter, the fake), the seat layer (`LlmSeatAgent`, prompts, profiles, retries, the
// pause gate), the budget ledger, the run-directory logs, and the arena (`bun run arena --
// <command>`: plan, preflight, run, report, smoke; phase 4: estimate, lineups, reconcile).

export * from "./model/adapter.ts";
export * from "./model/anthropic.ts";
export * from "./model/catalog.ts";
export * from "./model/clock.ts";
export * from "./model/fake.ts";
export * from "./model/prices.ts";
export * from "./model/rate.ts";
export * from "./model/tools.ts";
export * from "./budget/ledger.ts";
export * from "./log/calls.ts";
export * from "./log/schema.ts";
export * from "./log/watch.ts";
export * from "./seat/agent.ts";
export * from "./seat/pause.ts";
export * from "./seat/personalities.ts";
export * from "./seat/prompt.ts";
export * from "./seat/retry.ts";
export * from "./seat/thought.ts";
export * from "./defaults.ts";
export * from "./arena/brain.ts";
export * from "./arena/cost.ts";
export * from "./arena/estimate.ts";
export * from "./arena/lineup.ts";
export * from "./arena/plan.ts";
export * from "./arena/providers.ts";
export * from "./arena/preflight.ts";
export * from "./arena/reconcile.ts";
export * from "./arena/report.ts";
export * from "./arena/run.ts";
export * from "./arena/smoke.ts";
export {
  USAGE as ARENA_USAGE,
  RUN_USAGE as ARENA_RUN_USAGE,
  ESTIMATE_USAGE as ARENA_ESTIMATE_USAGE,
  main as arenaMain,
  type MainOptions as ArenaMainOptions,
} from "./arena/cli.ts";
