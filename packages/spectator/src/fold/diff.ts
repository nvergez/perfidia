import { compareIds } from "@perfidia/protocol";

// The diff of the projection (phase-3 design §2.7): each entity is kept with its JSON, and a new
// projection is compared entity by entity, so a patch replaces whole entities (`null` deletes one)
// and applying it is a plain assign or delete. Entities are built with their keys in a fixed order
// (records copied from the state are sorted), so equal content gives equal JSON.

/** A collection of entities by id, with the JSON of each. */
export class EntityCache<T extends object> {
  private readonly map = new Map<string, { readonly json: string; readonly ent: T }>();

  get(id: string): T | undefined {
    return this.map.get(id)?.ent;
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  get size(): number {
    return this.map.size;
  }

  /**
   * Makes `next` the collection; returns what changed, ids in `compareIds` order: in `whole` the new
   * entities and `null` for those that are gone; in `fields` the changed top-level fields of the
   * others (or, with `fields: false`, those entities whole in `whole`).
   */
  replace(next: ReadonlyMap<string, T>, o: { readonly fields: boolean }): Changes<T> {
    const changes = this.update(next, o);
    for (const id of this.map.keys()) {
      if (next.has(id)) continue;
      this.map.delete(id);
      changes.whole.push([id, null]);
    }
    return done(changes);
  }

  /** Sets the entities of `next` and keeps the others; returns what changed, as `replace`. */
  merge(next: ReadonlyMap<string, T>, o: { readonly fields: boolean }): Changes<T> {
    return done(this.update(next, o));
  }

  private update(
    next: ReadonlyMap<string, T>,
    o: { readonly fields: boolean },
  ): { whole: [string, T | null][]; fields: [string, Partial<T>][] } {
    const whole: [string, T | null][] = [];
    const fields: [string, Partial<T>][] = [];
    for (const [id, ent] of next) {
      const json = JSON.stringify(ent);
      const prev = this.map.get(id);
      if (prev?.json === json) continue;
      this.map.set(id, { json, ent });
      if (prev === undefined || !o.fields) whole.push([id, ent]);
      else fields.push([id, changedFields(prev.ent, ent)]);
    }
    return { whole, fields };
  }

  /** Every entity, ids in `compareIds` order. */
  record(): Record<string, T> {
    const out: Record<string, T> = {};
    for (const id of [...this.map.keys()].toSorted(compareIds)) {
      const e = this.map.get(id);
      if (e !== undefined) out[id] = e.ent;
    }
    return out;
  }
}

/** What a collection's update changed: whole entities (or `null`), and changed fields. */
export interface Changes<T extends object> {
  readonly whole: Record<string, T | null> | null;
  readonly fields: Record<string, Partial<T>> | null;
}

function done<T extends object>(c: {
  whole: [string, T | null][];
  fields: [string, Partial<T>][];
}): Changes<T> {
  return {
    whole: c.whole.length === 0 ? null : patchOf(c.whole),
    fields: c.fields.length === 0 ? null : patchOf(c.fields),
  };
}

/** The top-level fields of `next` whose JSON differs from `prev`'s. */
function changedFields<T extends object>(prev: T, next: T): Partial<T> {
  const out: Partial<T> = {};
  for (const key in next) {
    if (!Object.hasOwn(next, key)) continue;
    if (JSON.stringify(prev[key]) !== JSON.stringify(next[key])) out[key] = next[key];
  }
  return out;
}

function patchOf<V>(entries: [string, V][]): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [id, v] of entries.toSorted((a, b) => compareIds(a[0], b[0]))) out[id] = v;
  return out;
}

/** One value (an array or an object) with its JSON. */
export class ValueCache<T> {
  private json: string;
  private current: T;

  constructor(initial: T) {
    this.current = initial;
    this.json = JSON.stringify(initial);
  }

  get value(): T {
    return this.current;
  }

  /** Makes `next` the value; returns it when it differs from the previous one, else undefined. */
  replace(next: T): T | undefined {
    const json = JSON.stringify(next);
    if (json === this.json) return undefined;
    this.json = json;
    this.current = next;
    return next;
  }
}
