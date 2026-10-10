import { expect, test } from "bun:test";
import { compiledRules, gameState, logLines, snapshot } from "./fixtures.test.ts";
import {
  JsonSchema,
  safePartialRecord,
  safeRecord,
  UnitCountsSchema,
  UnitIdSchema,
  WakeClassSchema,
  WakeRoleSchema,
  z,
  type CompiledRules,
  type DeepReadonly,
  type GameState,
  type Json,
  type LogLine,
  type Snapshot,
} from "./index.ts";

const issuesOf = (schema: z.ZodType, text: string): { path: PropertyKey[]; message: string }[] =>
  schema
    .safeParse(JSON.parse(text))
    .error?.issues.map(({ path, message }) => ({ path, message })) ?? [];

test("an own __proto__ key is reported at that key, never dropped (§6.3 log boundary)", () => {
  const message = 'remove the "__proto__" key: it is never a valid id or config key';
  expect(issuesOf(UnitCountsSchema, '{"guard":1,"__proto__":3}')).toEqual([
    { path: ["__proto__"], message },
  ]);
  expect(issuesOf(JsonSchema, '{"a":[{"b":{"__proto__":{"x":1}}}]}')).toEqual([
    { path: ["a", 0, "b", "__proto__"], message },
  ]);
  expect(issuesOf(UnitCountsSchema, '{"guard":1,"raider":2}')).toEqual([]);
  expect(issuesOf(JsonSchema, '{"a":[{"b":{"proto":1}}]}')).toEqual([]);
});

const outputJson = (schema: z.ZodType): unknown => z.toJSONSchema(schema);
const inputJson = (schema: z.ZodType): unknown => z.toJSONSchema(schema, { io: "input" });

test("the guarded records convert to the same JSON Schema as plain Zod records", () => {
  // Tool argument schemas use them (unit counts), and tool definitions are their JSON Schemas.
  const value = z.int().positive();
  const plain = z.record(UnitIdSchema, value);
  expect(outputJson(safeRecord(UnitIdSchema, value))).toEqual(outputJson(plain));
  expect(inputJson(UnitCountsSchema)).toEqual(inputJson(plain));
  expect(outputJson(safePartialRecord(WakeRoleSchema, WakeClassSchema))).toEqual(
    outputJson(z.partialRecord(WakeRoleSchema, WakeClassSchema)),
  );
});

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
