// A small least-recently-used set of keys (phase-3 design §3.4): the finished timelines kept in
// memory in front of the disk cache. `touch` marks a key used and returns the keys pushed out.

export class Lru<K> {
  private readonly capacity: number;
  private readonly keys = new Set<K>();

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
  }

  touch(key: K): K[] {
    this.keys.delete(key);
    this.keys.add(key);
    const out: K[] = [];
    while (this.keys.size > this.capacity) {
      const oldest = this.keys.values().next();
      if (oldest.done === true) break;
      this.keys.delete(oldest.value);
      out.push(oldest.value);
    }
    return out;
  }

  delete(key: K): void {
    this.keys.delete(key);
  }

  get size(): number {
    return this.keys.size;
  }
}
