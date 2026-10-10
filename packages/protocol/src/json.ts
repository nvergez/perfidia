import { z } from "zod";

/**
 * A JSON value. Hashed data (state, events, log lines) holds safe integers only: canonical JSON
 * (engine `core`, §6.3) rejects floats, so this schema accepts them and the hash catches them.
 */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export const JsonSchema: z.ZodType<Json> = z.json();
export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), JsonSchema);

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
