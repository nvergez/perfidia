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
 */
export function removeWhere<T>(arr: T[], pred: (item: T) => boolean): T[] {
  const removed: T[] = [];
  for (const item of arr.splice(0)) {
    if (pred(item)) removed.push(item);
    else arr.push(item);
  }
  return removed;
}
