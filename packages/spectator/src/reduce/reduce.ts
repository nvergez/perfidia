import type {
  CityEnt,
  Frame,
  Patch,
  PlayerEnt,
  QueueEnt,
  SeatEnt,
  Standing,
  Step,
} from "@perfidia/protocol/spectator";

// Applying steps to frames (phase-3 design §2.7, §4.4): the server materialises frames with it and
// the web plays steps with it. A patch replaces whole entities by id (`null` deletes one) and the
// arrays, `ext`, `status` and `result` whole, so applying it is a plain assign or delete. Inputs are
// never changed: the result is a new frame that shares every untouched entity with the old one.
// It imports `@perfidia/protocol/spectator` only, so a browser bundle carries nothing else.

/** The fields of an entity a patch may assign (a schema's partial: a field may read `undefined`). */
type Fields<T> = { readonly [K in keyof T]?: T[K] | undefined };

/** `ent` with the defined fields of `changed` assigned (a new object). */
function mergeFields<T extends object>(ent: T, changed: Fields<T>): T {
  const out: T = { ...ent };
  for (const key in changed) {
    const v = changed[key];
    if (Object.hasOwn(changed, key) && v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * `rec` with `whole` (entities set, or deleted by `null`) and then `fields` (fields assigned on an
 * entity it holds) applied. Fields for an entity it does not hold are a broken stream: the client
 * must resync, so this throws.
 */
function applyRecord<T extends object>(
  rec: Readonly<Record<string, T>>,
  whole: Readonly<Partial<Record<string, T | null>>> | undefined,
  fields: Readonly<Partial<Record<string, Fields<T>>>> | undefined,
): Record<string, T> {
  const out: Record<string, T> = { ...rec };
  writeRecord(out, whole, fields);
  return out;
}

/** `applyRecord` into `out`, a record the caller owns (a copy it made). */
function writeRecord<T extends object>(
  out: Record<string, T>,
  whole: Readonly<Partial<Record<string, T | null>>> | undefined,
  fields: Readonly<Partial<Record<string, Fields<T>>>> | undefined,
): void {
  for (const [id, ent] of Object.entries(whole ?? {})) {
    if (ent === null) Reflect.deleteProperty(out, id);
    else if (ent !== undefined) out[id] = ent;
  }
  for (const [id, changed] of Object.entries(fields ?? {})) {
    const ent = Object.hasOwn(out, id) ? out[id] : undefined;
    if (ent === undefined)
      throw new Error(`patch: fields for ${id}, which the frame does not hold`);
    if (changed !== undefined) out[id] = mergeFields(ent, changed);
  }
}

/** `frame` with `patch` applied (a new frame; `seq` and `t` unchanged). */
export function applyPatch(frame: Frame, patch: Patch): Frame {
  const next: Frame = { ...frame };
  if (patch.cities !== undefined || patch.cityFields !== undefined) {
    next.cities = applyRecord<CityEnt>(frame.cities, patch.cities, patch.cityFields);
  }
  if (patch.queues !== undefined || patch.queueFields !== undefined) {
    next.queues = applyRecord<QueueEnt>(frame.queues, patch.queues, patch.queueFields);
  }
  if (patch.movements !== undefined) {
    next.movements = applyRecord(frame.movements, patch.movements, undefined);
  }
  if (patch.players !== undefined || patch.playerFields !== undefined) {
    next.players = applyRecord<PlayerEnt>(frame.players, patch.players, patch.playerFields);
  }
  if (patch.seats !== undefined || patch.seatFields !== undefined) {
    next.seats = applyRecord<SeatEnt>(frame.seats, patch.seats, patch.seatFields);
  }
  if (patch.alliances !== undefined) {
    next.alliances = applyRecord(frame.alliances, patch.alliances, undefined);
  }
  if (patch.pacts !== undefined) next.pacts = patch.pacts;
  if (patch.proposals !== undefined) next.proposals = patch.proposals;
  if (patch.ext !== undefined) next.ext = patch.ext;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.result !== undefined) next.result = patch.result;
  return next;
}

/** `frame` after `step`: its patch applied, its cursor and time taken. */
export function applyStep(frame: Frame, step: Step): Frame {
  const next = step.patch === undefined ? { ...frame } : applyPatch(frame, step.patch);
  next.seq = step.seq;
  next.t = step.t;
  return next;
}

/**
 * `frame` after every step of `steps` beyond its cursor, in order: the same frame as applying them
 * one by one, but each record a step touches is copied once for the whole run (a replay applies
 * many steps at a time, and a record such as the queues is large).
 */
export function applySteps(frame: Frame, steps: Iterable<Step>): Frame {
  let out: Frame | null = null;
  const own = new Set<string>();
  for (const step of steps) {
    if (step.seq <= (out ?? frame).seq) continue;
    out ??= { ...frame };
    if (step.patch !== undefined) patchInto(out, step.patch, own);
    out.seq = step.seq;
    out.t = step.t;
  }
  return out ?? frame;
}

/** `applyPatch` into `next`, a frame the caller owns; `own` names the records it copied already. */
function patchInto(next: Frame, patch: Patch, own: Set<string>): void {
  const take = (key: string): boolean => {
    if (own.has(key)) return false;
    own.add(key);
    return true;
  };
  if (patch.cities !== undefined || patch.cityFields !== undefined) {
    if (take("cities")) next.cities = { ...next.cities };
    writeRecord<CityEnt>(next.cities, patch.cities, patch.cityFields);
  }
  if (patch.queues !== undefined || patch.queueFields !== undefined) {
    if (take("queues")) next.queues = { ...next.queues };
    writeRecord<QueueEnt>(next.queues, patch.queues, patch.queueFields);
  }
  if (patch.movements !== undefined) {
    if (take("movements")) next.movements = { ...next.movements };
    writeRecord(next.movements, patch.movements, undefined);
  }
  if (patch.players !== undefined || patch.playerFields !== undefined) {
    if (take("players")) next.players = { ...next.players };
    writeRecord<PlayerEnt>(next.players, patch.players, patch.playerFields);
  }
  if (patch.seats !== undefined || patch.seatFields !== undefined) {
    if (take("seats")) next.seats = { ...next.seats };
    writeRecord<SeatEnt>(next.seats, patch.seats, patch.seatFields);
  }
  if (patch.alliances !== undefined) {
    if (take("alliances")) next.alliances = { ...next.alliances };
    writeRecord(next.alliances, patch.alliances, undefined);
  }
  if (patch.pacts !== undefined) next.pacts = patch.pacts;
  if (patch.proposals !== undefined) next.proposals = patch.proposals;
  if (patch.ext !== undefined) next.ext = patch.ext;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.result !== undefined) next.result = patch.result;
}

/** The standings of a frame: its players in rank order, as the ruleset ranks them. */
export function standingsOf(frame: Frame): Standing[] {
  return Object.values(frame.players)
    .toSorted((a, b) => a.rank - b.rank)
    .map((p) => ({
      player: p.id,
      rank: p.rank,
      score: p.score,
      parts: { ...p.parts },
      cities: p.cities,
      alive: p.alive,
    }));
}
