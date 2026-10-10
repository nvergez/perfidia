import { expect, test } from "bun:test";
import { compiledRules, gameState, logLines, snapshot } from "./fixtures.test.ts";
import type { CompiledRules, DeepReadonly, GameState, Json, LogLine, Snapshot } from "./index.ts";

test("live data is assignable to its DeepReadonly view, Json fields included", () => {
  // Each assignment is a compile-time check: a Json field inside an object used to exhaust the
  // compiler's instantiation depth, which would break `ReadCtx.state` in the kernel.
  const state: DeepReadonly<GameState> = gameState;
  const rules: DeepReadonly<CompiledRules> = compiledRules;
  const snap: DeepReadonly<Snapshot> = snapshot;
  const line: DeepReadonly<LogLine> = logLines.ev;
  const ext: DeepReadonly<Json> = gameState.ext;
  const nested: DeepReadonly<{ ext: Json; n: number }> = { ext: gameState.ext, n: 1 };
  expect([state.now, rules.players, snap.hour, line.k, ext, nested.n]).toEqual([
    7200,
    3,
    2,
    "ev",
    gameState.ext,
    1,
  ]);
});

test("DeepReadonly forbids writes at every depth (compile-time)", () => {
  const state: DeepReadonly<GameState> = gameState;
  const pair: DeepReadonly<[number, string]> = [1, "a"];
  // @ts-expect-error tuple element types are kept
  const swapped: DeepReadonly<[number, string]> = ["a", 1];
  const write = (): void => {
    // @ts-expect-error read-only
    state.now = 1;
    const city = state.cities["c1"];
    // @ts-expect-error read-only, deep
    if (city) city.stock.wood = 1;
    // @ts-expect-error read-only record entry
    if (city) city.units["guard"] = 3;
    // @ts-expect-error read-only array
    state.queue[0] = { at: 1, cls: 1, seq: 1, kind: "x", ref: "" };
    // @ts-expect-error read-only tuple
    pair[0] = 2;
  };
  expect(typeof write).toBe("function");
  expect(swapped).toHaveLength(2);
});
