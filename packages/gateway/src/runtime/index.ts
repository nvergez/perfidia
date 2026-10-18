// @perfidia/gateway/runtime: the tools, turn handles, `MatchHost`, `runMatch` and log sinks
// (docs/architecture.md §8.3, §8.7, §9.1, §10.1), the gateway state rebuild (§10.5) and the chaos
// test agent (§11.2), exported because the sim hardening and integration tests play with it.

export { TOOL_DESCRIPTIONS } from "./descriptions.ts";
export {
  HostFailure,
  INTERNAL_FALLBACK,
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
  type HandoffQueue,
  type HostStats,
  type MatchHostOptions,
  type QueuedHandoff,
  type WakeCounts,
  type WallSource,
} from "./host.ts";
export { MemorySink, teeSink, type LogSink } from "./sink.ts";
export { runMatch, type RunMatchOptions, type RunResult, type RunStats } from "./run.ts";
export {
  rebuildGatewayState,
  type GatewayRebuild,
  type RebuildDrift,
  type RebuildOptions,
} from "./rebuild.ts";
export { ChaosAgent, ChaosResultError, type ChaosOptions } from "./chaos.ts";
