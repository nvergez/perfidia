// @perfidia/gateway/runtime: the tools, turn handles, `MatchHost`, `runMatch` and log sinks
// (docs/architecture.md §8.3, §8.7, §9.1, §10.1), and the chaos test agent (§11.2). The gateway
// state rebuild of §10.5 (`rebuild.ts`) joins in wave 6.

export { TOOL_DESCRIPTIONS } from "./descriptions.ts";
export {
  HostFailure,
  canonicalBytes,
  copyOf,
  createToolRegistry,
  invokeTool,
  jsonData,
  toolDefinitions,
  type CallOutcome,
  type ToolDefinition,
  type ToolEnv,
  type ToolRegistry,
  type ToolSpec,
} from "./tools.ts";
export {
  GatewayInternalError,
  HostTurn,
  MatchHost,
  type Handoff,
  type HostStats,
  type MatchHostOptions,
  type WakeCounts,
  type WallSource,
} from "./host.ts";
export { MemorySink, teeSink, type LogSink } from "./sink.ts";
export { runMatch, type RunMatchOptions, type RunResult, type RunStats } from "./run.ts";
export { ChaosAgent, ChaosResultError, createChaosAgent, type ChaosOptions } from "./chaos.ts";
