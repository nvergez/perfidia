// @perfidia/orchestrator: the LLM harness (phase-2 design). The model layer (`ModelAdapter`, the
// Anthropic adapter, the fake), the seat layer (`LlmSeatAgent`, prompts, profiles, retries, the
// pause gate), the budget ledger and the run-directory logs. The arena CLI builds on these.

export * from "./model/adapter.ts";
export * from "./model/anthropic.ts";
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
