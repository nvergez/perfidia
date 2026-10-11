// Own-key record access (docs/architecture.md §6.5): ids are record keys, and a key such as
// `__proto__` or `constructor` must never read a prototype member. The one copy every layer uses.

/** The own value of `key` in a record keyed by ids, or `undefined` (never a prototype member). */
export function own<V>(rec: Readonly<Record<string, V>>, key: string): V | undefined {
  return Object.hasOwn(rec, key) ? rec[key] : undefined;
}
