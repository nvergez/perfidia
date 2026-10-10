// Deep freezing under step invariants (docs/architecture.md §5.2): the ruleset descriptor, the
// compiled rules, the config and every routed event, so an accidental in-place edit of shared data
// (a sort of a table, a push into an event) throws in tests instead of corrupting a match.

/** Zod schemas cache data on themselves lazily; freezing one would break parsing. */
function isSchema(value: object): boolean {
  return Object.hasOwn(value, "_zod");
}

/**
 * Freezes `value` and every plain object and array reachable from it, leaving Zod schemas and the
 * objects behind them untouched. Functions are kept as they are (not frozen, not walked). Returns
 * `value`.
 */
export function deepFreeze<T>(value: T): T {
  const stack: object[] = [];
  if (typeof value === "object" && value !== null) stack.push(value);
  const seen = new Set<object>();
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (seen.has(node) || isSchema(node)) continue;
    seen.add(node);
    Object.freeze(node);
    for (const key of Object.keys(node)) {
      const child: unknown = Reflect.get(node, key);
      if (typeof child === "object" && child !== null) stack.push(child);
    }
  }
  return value;
}
