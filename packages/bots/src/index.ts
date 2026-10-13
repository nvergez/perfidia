// @perfidia/bots: scripted players that play exclusively through the `SeatAgent` contract the
// gateway drives (docs/architecture.md §11). Bots import only `protocol` at runtime.

export { BotAgent, type BotOptions } from "./agent.ts";
export {
  hintsFor,
  NO_HINTS,
  RULESET_HINTS,
  type CombatHints,
  type StrategyHints,
} from "./hints.ts";
export {
  botFromLabel,
  botLabel,
  botLabels,
  botVersions,
  createBot,
  createBotVersion,
  isBotStrategy,
  parseBotLabel,
  type BotVersion,
} from "./registry.ts";
export { BOT_STRATEGIES, type BotStrategy } from "./strategies/strategy.ts";
export { thinkLatencyMs, withThinkTime, type ThinkTimeOptions } from "./think.ts";
export {
  composeAck,
  composeCall,
  composeCancel,
  parseWar,
  WAR_LIMITS,
  WAR_ROLES,
  type WarAck,
  type WarCall,
  type WarCancel,
  type WarItem,
  type WarRole,
} from "./war.ts";
