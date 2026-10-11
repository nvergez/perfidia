import type { DeepReadonly } from "@perfidia/protocol";

// Boundary copies (docs/architecture.md §6.6): what leaves the engine is a canonical round trip of
// what was hashed, so it never aliases engine state.

// `canonicalCopy` and `jsonCopy` are core's, re-exported for the kernel's modules.
export { canonicalCopy, jsonCopy } from "@perfidia/engine/core";

/** `value` typed as deeply read-only: a compile-time view, no copy and no freezing. */
export function readonlyView<T>(value: T): DeepReadonly<T> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- DeepReadonly<T> only adds readonly modifiers to T
  return value as DeepReadonly<T>;
}

/** `core.own` under the kernel's name: the own value of `key`, never a prototype member. */
export { own as lookup } from "@perfidia/engine/core";
