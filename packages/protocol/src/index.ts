// @perfidia/protocol: Zod schemas, their inferred types and type-only contracts shared by every
// package (docs/architecture.md §2.2). No runtime logic beyond schemas, constants and `compareIds`.

export { z } from "zod";
export type { ZodType } from "zod";

export * from "./json.ts";
export * from "./ids.ts";
export * from "./resources.ts";
export * from "./events.ts";
export * from "./violations.ts";
export * from "./rules.ts";
export * from "./match.ts";
export * from "./state.ts";
export * from "./actions.ts";
export * from "./views.ts";
export * from "./briefing.ts";
export * from "./tools.ts";
export * from "./log.ts";
export * from "./arena.ts";
export * from "./spectator.ts";
export * from "./stats.ts";
export type * from "./agent.ts";
