import { z } from "zod";

/**
 * A JSON value. Hashed data (state, events, log lines) holds safe integers only: canonical JSON
 * (engine `core`, §6.3) rejects floats, so this schema accepts them and the hash catches them.
 */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

const PROTO_KEY = "__proto__";

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

/**
 * Appends to `path` the location of the first own `__proto__` key in `value` (in `value` itself
 * or, when `deep`, in any nested array or object) and returns whether there is one.
 */
function findProtoKey(value: unknown, deep: boolean, path: (string | number)[]): boolean {
  if (!isObject(value)) return false;
  if (Object.hasOwn(value, PROTO_KEY)) {
    path.push(PROTO_KEY);
    return true;
  }
  if (!deep) return false;
  const entries: [string | number, unknown][] = Array.isArray(value)
    ? [...value.entries()]
    : Object.entries(value);
  for (const [key, child] of entries) {
    path.push(key);
    if (findProtoKey(child, true, path)) return true;
    path.pop();
  }
  return false;
}

/**
 * `schema`, rejecting an input object that has an own `__proto__` key (`JSON.parse` creates one),
 * at any depth when `deep`, with the issue at that key. Zod's record parsing drops such a key
 * silently instead, so parsing would not be the identity at the log boundary: an action hashed
 * with the key in the live run would replay without it. Every record schema of this package
 * goes through `safeRecord` or `safePartialRecord` below, and every JSON value through
 * `JsonSchema` or `JsonObjectSchema`. (Strict objects already reject the key as unrecognised.)
 */
export function rejectProtoKey<T extends z.core.SomeType>(schema: T, deep = false) {
  return z.preprocess((value, ctx) => {
    const path: (string | number)[] = [];
    if (findProtoKey(value, deep, path)) {
      ctx.addIssue({
        code: "custom",
        path,
        input: value,
        message: `remove the "${PROTO_KEY}" key: it is never a valid id or config key`,
      });
    }
    return value;
  }, schema);
}

/** `z.record`, rejecting an own `__proto__` key instead of dropping it. */
export function safeRecord<K extends z.core.$ZodRecordKey, V extends z.core.SomeType>(
  key: K,
  value: V,
) {
  return rejectProtoKey(z.record(key, value));
}

/** `z.partialRecord`, rejecting an own `__proto__` key instead of dropping it. */
export function safePartialRecord<K extends z.core.$ZodRecordKey, V extends z.core.SomeType>(
  key: K,
  value: V,
) {
  return rejectProtoKey(z.partialRecord(key, value));
}

/** A JSON value; an own `__proto__` key at any depth is rejected, never dropped. */
export const JsonSchema: z.ZodType<Json> = rejectProtoKey(z.json(), true);
/** A JSON object; an own `__proto__` key at any depth is rejected, never dropped. */
export const JsonObjectSchema: z.ZodType<JsonObject> = rejectProtoKey(
  z.record(z.string(), z.json()),
  true,
);

/**
 * Recursively read-only view of a data type (state, config, compiled rules). Functions are kept
 * as they are; tuples and arrays become read-only tuples and arrays.
 *
 * Two constraints shape it, both covered by tests: live data must stay assignable to its view
 * (arrays go through `infer`, because a plain mapped type over a recursive `Json` field such as
 * `GameState.ext` exhausts the compiler's instantiation depth), and `T` must appear only in check
 * positions, so `Ruleset<SomeConfig, SomeExt>` stays assignable to `AnyRuleset` through method
 * bivariance.
 */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly [unknown, ...unknown[]]
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T extends readonly (infer U)[]
      ? readonly DeepReadonly<U>[]
      : T extends object
        ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
        : T;
