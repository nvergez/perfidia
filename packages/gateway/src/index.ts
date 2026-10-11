// @perfidia/gateway: the only way into a running match (docs/architecture.md §8): seat state and
// the wake scheduler (`./seat`), the clocks (`./clock`), what a seat sees (`./present`) and the
// runtime that ties them to the engine (`./runtime`). Each group is also its own public path.

export * from "./seat/index.ts";
export * from "./clock/index.ts";
export * from "./present/index.ts";
export * from "./runtime/index.ts";
// Both `seat` and `clock` name a type `TurnFailure`: the seat's (a failed call of the turn in
// progress) keeps the name here, the clock's (why a driver closed a turn) is renamed.
export type { TurnFailure } from "./seat/index.ts";
export type { TurnFailure as ClockTurnFailure } from "./clock/index.ts";
