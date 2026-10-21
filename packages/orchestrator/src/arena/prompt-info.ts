import type { Match } from "@perfidia/engine/kernel";
import { rulesInfo } from "@perfidia/gateway/present";
import { promptTimes, type PromptInfo } from "../seat/prompt.ts";

/**
 * The shared block's inputs for `match` (prompt version 3): the `rules` payload, as the rules tool
 * returns it, and the compiled build and recruit times it leaves out (`TIMES`).
 */
export function promptInfo(match: Match): PromptInfo {
  return { ...rulesInfo(match), times: promptTimes(match.rules) };
}
