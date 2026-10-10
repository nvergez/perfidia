import { canonicalJson } from "@perfidia/engine/core";
import type { DeepReadonly } from "@perfidia/protocol";

// Boundary copies (docs/architecture.md §6.6): what leaves the engine is a canonical round trip of
// what was hashed, so it never aliases engine state.

/**
 * `value` serialised once as canonical JSON and its parsed copy. Throws `CanonicalJsonError` on
 * non-JSON data (a float, `undefined` in an array, a `Map`, …).
 */
export function canonicalCopy<T>(value: T): { text: string; copy: T } {
  const text = canonicalJson(value);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- parsing the canonical text of `value` rebuilds a deep copy of `value`
  return { text, copy: JSON.parse(text) as T };
}

/** A canonical deep copy of `value` (see `canonicalCopy`). */
export function jsonCopy<T>(value: T): T {
  return canonicalCopy(value).copy;
}

/** `value` typed as deeply read-only: a compile-time view, no copy and no freezing. */
export function readonlyView<T>(value: T): DeepReadonly<T> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- DeepReadonly<T> only adds readonly modifiers to T
  return value as DeepReadonly<T>;
}

/** The own value of `key` in a record keyed by an id kind, or undefined (never a prototype key). */
export function lookup<V>(rec: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.hasOwn(rec, key) ? rec[key] : undefined;
}
