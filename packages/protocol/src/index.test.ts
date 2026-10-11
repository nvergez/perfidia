import { expect, test } from "bun:test";
import { actions, setup } from "./fixtures.test.ts";
import * as protocol from "./index.ts";
import {
  ACTION_TYPES,
  ActionSchema,
  DOMAIN_ERROR_CODES,
  MatchSetupSchema,
  z,
  type ZodType,
} from "./index.ts";

test("the placeholders are gone: no PROTOCOL_PACKAGE, no placeholder schema", () => {
  expect("PROTOCOL_PACKAGE" in protocol).toBe(false);
  expect("PackageNameSchema" in protocol).toBe(false);
});

test("z and ZodType are re-exported for rulesets", () => {
  const schema: ZodType<{ a: number }> = z.strictObject({ a: z.int() });
  expect(schema.parse({ a: 1 })).toEqual({ a: 1 });
});

test("ACTION_TYPES lists every action of the union", () => {
  const types = ActionSchema.options.map((o) => o.shape.type.value);
  expect([...ACTION_TYPES]).toEqual(types);
  expect(actions.map((a) => a.type)).toEqual([...ACTION_TYPES]);
});

test("DOMAIN_ERROR_CODES is the closed list of §7.3", () => {
  expect(DOMAIN_ERROR_CODES).toHaveLength(39);
  expect(new Set(DOMAIN_ERROR_CODES).size).toBe(39);
  expect(DOMAIN_ERROR_CODES).toContain("SPY_GOLD");
  expect(DOMAIN_ERROR_CODES).not.toContain("WAKE_RANGE");
  expect(DOMAIN_ERROR_CODES as readonly string[]).not.toContain("CITY_BESIEGED");
});

function issue(idKey: string): { path: PropertyKey[] } | undefined {
  return MatchSetupSchema.safeParse({ ...setup, idKey }).error?.issues[0];
}

test("MatchSetup rejects an idKey of the wrong length or case", () => {
  expect(issue(setup.idKey)).toBeUndefined();
  expect(issue(setup.idKey.slice(0, 31))?.path).toEqual(["idKey"]);
  expect(issue(`${setup.idKey}a`)?.path).toEqual(["idKey"]);
  expect(issue(setup.idKey.toUpperCase())?.path).toEqual(["idKey"]);
  expect(issue(`${setup.idKey.slice(0, 31)}g`)?.path).toEqual(["idKey"]);
});
