// In-place helpers for arrays kept sorted (docs/architecture.md §5.1, §6.5): the event queue and
// the sorted state arrays. `cmp` must be a total order.

/**
 * Inserts `item` into `arr`, which is sorted by `cmp`, after every element that compares equal
 * (so equal items keep their insertion order). Binary search; returns the index of the new item.
 */
export function insertSorted<T>(arr: T[], item: T, cmp: (a: T, b: T) => number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cmp(arr[mid]!, item) <= 0) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, item);
  return lo;
}

/**
 * Removes in place every element of `arr` matching `pred`, keeping the order of the others, and
 * returns the removed elements in their original order (empty when nothing matched).
 *
 * Atomic: `pred` runs once per element, in order, on the untouched array, and `arr` changes only
 * after every call returned. If `pred` throws, `arr` is left exactly as it was. `pred` must not
 * modify `arr`.
 */
export function removeWhere<T>(arr: T[], pred: (item: T) => boolean): T[] {
  const n = arr.length;
  const matches: boolean[] = [];
  for (let i = 0; i < n; i += 1) matches.push(pred(arr[i]!));
  const removed: T[] = [];
  let w = 0;
  for (let i = 0; i < n; i += 1) {
    const item = arr[i]!;
    if (matches[i]) removed.push(item);
    else arr[w++] = item;
  }
  arr.length = w;
  return removed;
}
