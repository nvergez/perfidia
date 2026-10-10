import type { OpaqueIdMinter } from "@perfidia/engine/core";
import type { AnyRuleset, DomainModule, Invariant, ReadCtx } from "@perfidia/engine/contracts";
import {
  DOMAIN_EVENT_KINDS,
  DomainEventSchema,
  MOVEMENT_KINDS,
  STANDARD_EVENT_DATA,
  compareIds,
  type DomainEvent,
  type ScheduledEvent,
  type ZodType,
} from "@perfidia/protocol";
import { lookup } from "./copy.ts";
import { EngineBug } from "./errors.ts";
import { compareScheduled } from "./queue.ts";

// The invariant framework and the kernel's structural invariants (docs/architecture.md §13.3).
// Levels: `off`, `checkpoint` (default), `step` (tests). Step invariants also run at checkpoints.

export type InvariantLevel = "off" | "checkpoint" | "step";

const DOMAIN_KINDS: ReadonlySet<string> = new Set(DOMAIN_EVENT_KINDS);
const ARRIVAL_KINDS: ReadonlySet<string> = new Set(MOVEMENT_KINDS.map((k) => `arrive_${k}`));

/** Every value of a record, in `compareIds` order of its keys (§6.5). */
function sortedEntries<V>(rec: Readonly<Record<string, V>>): [string, V][] {
  return Object.entries(rec).toSorted((a, b) => compareIds(a[0], b[0]));
}

function idNumber(id: string): number | null {
  const n = Number(id.slice(1));
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/**
 * The opaque ids an owner's counters have minted so far, extended lazily (an in-memory cache of the
 * match, never state). Lets the id-counter invariant check that every private id in the state was
 * minted for its owner at or below the owner's counter.
 */
export class MintedIds {
  private readonly minter: OpaqueIdMinter;
  private readonly cache = new Map<string, Map<string, number>>();

  constructor(minter: OpaqueIdMinter) {
    this.minter = minter;
  }

  /** The counter value that minted `id` for (prefix, owner), if it is ≤ `upTo`; null otherwise. */
  counterOf(prefix: string, owner: number, id: string, upTo: number): number | null {
    const key = `${prefix}${owner}`;
    let ids = this.cache.get(key);
    if (ids === undefined) {
      ids = new Map<string, number>();
      this.cache.set(key, ids);
    }
    for (let n = ids.size + 1; n <= upTo; n += 1) ids.set(this.minter(prefix, owner, n), n);
    const n = ids.get(id);
    return n !== undefined && n <= upTo ? n : null;
  }
}

function checkQueue(r: ReadCtx): string[] {
  const out: string[] = [];
  const s = r.state;
  const seen = new Set<number>();
  let prev: ScheduledEvent | undefined;
  for (const [i, ev] of s.queue.entries()) {
    if (prev !== undefined && compareScheduled(prev, ev) >= 0) {
      out.push(
        `queue[${i}] (${ev.kind} at ${ev.at}, class ${ev.cls}, seq ${ev.seq}) is not after queue[${i - 1}] (${prev.kind} at ${prev.at}, class ${prev.cls}, seq ${prev.seq})`,
      );
    }
    if (seen.has(ev.seq)) out.push(`seq ${ev.seq} appears twice in the queue`);
    seen.add(ev.seq);
    if (ev.seq > s.seq) out.push(`queue seq ${ev.seq} is above state.seq ${s.seq}`);
    if (ev.at < s.now) out.push(`${ev.kind} (seq ${ev.seq}) is at ${ev.at}, before now (${s.now})`);
    const cls = r.rules.eventClasses[ev.kind];
    if (cls === undefined) out.push(`${ev.kind} (seq ${ev.seq}) has no class in eventClasses`);
    else if (cls !== ev.cls) {
      out.push(`${ev.kind} (seq ${ev.seq}) has class ${ev.cls}, eventClasses says ${cls}`);
    }
    prev = ev;
  }
  return out;
}

function pactKey(a: string, b: string): string {
  return `${a}|${b}`;
}

/** Every pending event of a domain kind points to an entity that points back to it. */
function checkEventRefs(r: ReadCtx): string[] {
  const out: string[] = [];
  const s = r.state;
  let matchEnds = 0;
  for (const ev of s.queue) {
    if (!DOMAIN_KINDS.has(ev.kind)) continue;
    const what = `${ev.kind} "${ev.ref}" (seq ${ev.seq})`;
    if (ARRIVAL_KINDS.has(ev.kind)) {
      const m = lookup(s.movements, ev.ref);
      if (m === undefined) out.push(`${what}: no such movement`);
      else if (`arrive_${m.kind}` !== ev.kind) out.push(`${what}: movement ${m.id} is a ${m.kind}`);
      else if (m.seq !== ev.seq) out.push(`${what}: movement ${m.id} points to seq ${m.seq}`);
      else if (m.arriveAt !== ev.at) {
        out.push(`${what}: movement ${m.id} arrives at ${m.arriveAt}, the event is at ${ev.at}`);
      }
      continue;
    }
    switch (ev.kind) {
      case "build_done":
      case "recruit_done": {
        const city = lookup(s.cities, ev.ref);
        if (city === undefined) {
          out.push(`${what}: no such city`);
          break;
        }
        const items =
          ev.kind === "build_done"
            ? city.build.map((b) => ({ id: b.id, seq: b.seq, end: b.end }))
            : sortedEntries(city.recruit).flatMap(([, batches]) =>
                batches.map((b) => ({ id: b.id, seq: b.seq, end: b.end })),
              );
        const item = items.find((x) => x.seq === ev.seq);
        if (item === undefined) out.push(`${what}: no queue item of ${city.id} has this seq`);
        else if (item.end !== ev.at) {
          out.push(`${what}: item #${item.id} ends at ${item.end}, the event is at ${ev.at}`);
        }
        break;
      }
      case "proposal_expire": {
        const p = lookup(s.proposals, ev.ref);
        if (p === undefined) out.push(`${what}: no such proposal`);
        else if (p.seq !== ev.seq) out.push(`${what}: proposal ${p.id} points to seq ${p.seq}`);
        else if (p.expiresAt !== ev.at) {
          out.push(`${what}: proposal ${p.id} expires at ${p.expiresAt}, the event is at ${ev.at}`);
        }
        break;
      }
      case "pact_expire": {
        const pact = s.pacts.find((p) => pactKey(p.a, p.b) === ev.ref);
        if (pact === undefined) out.push(`${what}: no such pact`);
        else if (pact.seq !== ev.seq) out.push(`${what}: the pact points to seq ${pact.seq}`);
        else if (pact.expiresAt !== ev.at) {
          out.push(
            `${what}: the pact expires at ${String(pact.expiresAt)}, the event is at ${ev.at}`,
          );
        }
        break;
      }
      case "match_end":
        matchEnds += 1;
        if (ev.ref !== "") out.push(`${what}: match_end has the empty ref`);
        if (ev.at !== r.rules.time.matchEnd) {
          out.push(
            `${what}: match_end is at ${ev.at}, not at time.matchEnd (${r.rules.time.matchEnd})`,
          );
        }
        break;
      default:
        break;
    }
  }
  if (s.status === "running" && matchEnds !== 1) {
    out.push(`a running match has ${matchEnds} match_end events; it needs exactly one`);
  }
  return out;
}

/** Every movement has exactly one arrival event, every queue item and pact expiry its own event. */
function checkEntityEvents(r: ReadCtx): string[] {
  const out: string[] = [];
  const s = r.state;
  const bySeq = new Map<number, ScheduledEvent>();
  const arrivals = new Map<string, number>();
  for (const ev of s.queue) {
    bySeq.set(ev.seq, ev);
    if (ARRIVAL_KINDS.has(ev.kind)) arrivals.set(ev.ref, (arrivals.get(ev.ref) ?? 0) + 1);
  }
  const expect = (what: string, seq: number, kind: string, ref: string): void => {
    const ev = bySeq.get(seq);
    if (ev === undefined) out.push(`${what}: its event (seq ${seq}) is not in the queue`);
    else if (ev.kind !== kind || ev.ref !== ref) {
      out.push(`${what}: seq ${seq} is ${ev.kind} "${ev.ref}", expected ${kind} "${ref}"`);
    }
  };
  for (const [id, m] of sortedEntries(s.movements)) {
    const count = arrivals.get(id) ?? 0;
    if (count !== 1) out.push(`movement ${id} has ${count} arrival events; it needs exactly one`);
    expect(`movement ${id}`, m.seq, `arrive_${m.kind}`, id);
  }
  for (const [id, city] of sortedEntries(s.cities)) {
    for (const item of city.build)
      expect(`${id} build item #${item.id}`, item.seq, "build_done", id);
    for (const [queue, batches] of sortedEntries(city.recruit)) {
      for (const b of batches) {
        expect(`${id} ${queue} batch #${b.id}`, b.seq, "recruit_done", id);
      }
    }
  }
  for (const [id, p] of sortedEntries(s.proposals)) {
    expect(`proposal ${id}`, p.seq, "proposal_expire", id);
  }
  for (const pact of s.pacts) {
    if (pact.seq !== null)
      expect(`pact ${pactKey(pact.a, pact.b)}`, pact.seq, "pact_expire", pactKey(pact.a, pact.b));
    else if (pact.expiresAt !== null) {
      out.push(`pact ${pactKey(pact.a, pact.b)} expires at ${pact.expiresAt} but has no event`);
    }
  }
  return out;
}

/** Record keys equal ids, and every id counter is at or above every id it allocated. */
function checkIds(r: ReadCtx, minted: MintedIds): string[] {
  const out: string[] = [];
  const s = r.state;
  const records: [string, Readonly<Record<string, { readonly id: string }>>][] = [
    ["players", s.players],
    ["islands", s.islands],
    ["cities", s.cities],
    ["movements", s.movements],
    ["proposals", s.proposals],
    ["alliances", s.alliances],
  ];
  for (const [name, rec] of records) {
    for (const [key, value] of sortedEntries(rec)) {
      if (value.id !== key) out.push(`${name}.${key} has id ${value.id}`);
    }
  }
  for (const id of Object.keys(s.players)) {
    if (lookup(s.ids.own, id) === undefined) {
      out.push(`player ${id} has no private id counters (ids.own)`);
    }
  }
  for (const [id, city] of sortedEntries(s.cities)) {
    const n = idNumber(id);
    if (n !== null && n > s.ids.c) out.push(`city ${id} is above the city counter ${s.ids.c}`);
    const items = [...city.build, ...Object.values(city.recruit).flat()];
    for (const item of items) {
      if (item.id > city.itemSeq) {
        out.push(`${id} queue item #${item.id} is above its item counter ${city.itemSeq}`);
      }
      if (item.seq > s.seq)
        out.push(`${id} queue item #${item.id} has seq ${item.seq} above state.seq`);
    }
  }
  for (const id of Object.keys(s.alliances)) {
    const n = idNumber(id);
    if (n !== null && n > s.ids.a)
      out.push(`alliance ${id} is above the alliance counter ${s.ids.a}`);
  }
  for (const [id, m] of sortedEntries(s.movements)) {
    const counters = s.ids.own[m.owner];
    const owner = idNumber(m.owner);
    if (counters === undefined || owner === null) {
      out.push(`movement ${id} is owned by ${m.owner}, who has no id counters`);
    } else if (minted.counterOf("m", owner, id, counters.m) === null) {
      out.push(
        `movement ${id} was not minted for ${m.owner} at or below its counter ${counters.m}`,
      );
    }
    if (m.seq > s.seq) out.push(`movement ${id} has seq ${m.seq} above state.seq`);
  }
  for (const [id, p] of sortedEntries(s.proposals)) {
    const counters = s.ids.own[p.from];
    const owner = idNumber(p.from);
    if (counters === undefined || owner === null) {
      out.push(`proposal ${id} is from ${p.from}, who has no id counters`);
    } else if (minted.counterOf("q", owner, id, counters.q) === null) {
      out.push(`proposal ${id} was not minted for ${p.from} at or below its counter ${counters.q}`);
    }
    if (p.seq > s.seq) out.push(`proposal ${id} has seq ${p.seq} above state.seq`);
  }
  for (const pact of s.pacts) {
    if (pact.seq !== null && pact.seq > s.seq) {
      out.push(`pact ${pactKey(pact.a, pact.b)} has seq ${pact.seq} above state.seq`);
    }
  }
  return out;
}

function checkStatus(r: ReadCtx): string[] {
  const s = r.state;
  const out: string[] = [];
  if (s.status === "ended" && s.result === null) out.push("the match has ended without a result");
  if (s.status === "running" && s.result !== null) out.push("a running match has a result");
  if (s.ruleset !== r.ruleset.ref) out.push(`state.ruleset ${s.ruleset} is not ${r.ruleset.ref}`);
  return out;
}

function checkExt(r: ReadCtx): string[] {
  const parsed = r.ruleset.extSchema.safeParse(r.state.ext);
  if (parsed.success) return [];
  return parsed.error.issues.map((i) => {
    const path = i.path.map((p) => String(p)).join(".");
    return `state.ext${path === "" ? "" : `.${path}`} does not match ${r.ruleset.ref}'s extSchema: ${i.message}`;
  });
}

/** The kernel's structural invariants (§13.3), bound to a match's opaque-id cache. */
export function kernelInvariants(minted: MintedIds): readonly Invariant[] {
  return [
    { name: "kernel.queue", level: "step", check: checkQueue },
    { name: "kernel.event-refs", level: "step", check: checkEventRefs },
    { name: "kernel.entity-events", level: "step", check: checkEntityEvents },
    { name: "kernel.ids", level: "step", check: (r) => checkIds(r, minted) },
    { name: "kernel.status", level: "step", check: checkStatus },
    { name: "kernel.ext", level: "checkpoint", check: checkExt },
  ];
}

/**
 * Every invariant of a match, in the order they run: the kernel's, the domain module's and the
 * ruleset's own. Domain invariants always run; an invariant that only applies under the default
 * diplomacy checks `r.ruleset.hooks.actions` itself.
 */
export function allInvariants(
  kernel: readonly Invariant[],
  domain: DomainModule,
  ruleset: AnyRuleset,
): readonly Invariant[] {
  return [...kernel, ...domain.invariants, ...(ruleset.hooks.invariants ?? [])];
}

/**
 * Runs the invariants of `level` (`step`: step invariants only; `checkpoint`: all) and throws an
 * `EngineBug` of kind `invariant` listing every violation. A throwing invariant is reported too.
 */
export function runInvariants(
  invariants: readonly Invariant[],
  level: "step" | "checkpoint",
  r: ReadCtx,
): void {
  const failures: string[] = [];
  for (const inv of invariants) {
    if (level === "step" && inv.level !== "step") continue;
    let found: readonly string[];
    try {
      found = inv.check(r);
    } catch (error) {
      found = [`the check threw: ${error instanceof Error ? error.message : String(error)}`];
    }
    for (const f of found) failures.push(`${inv.name}: ${f}`);
  }
  if (failures.length > 0) {
    throw new EngineBug(
      "invariant",
      `${level} invariants failed at t = ${r.now}:\n  ${failures.join("\n  ")}`,
      { level, t: r.now, failures },
    );
  }
}

/**
 * The emitted-event check (§8.6): every event fits the `DomainEvent` envelope, its type is a standard
 * type or a key of `ruleset.eventSchemas`, and its data parses with that type's schema. Returns the
 * problems found.
 */
export function eventProblems(ruleset: AnyRuleset, events: readonly DomainEvent[]): string[] {
  const out: string[] = [];
  const standard: Readonly<Record<string, ZodType>> = STANDARD_EVENT_DATA;
  for (const [i, e] of events.entries()) {
    const envelope = DomainEventSchema.safeParse(e);
    if (!envelope.success) {
      for (const issue of envelope.error.issues) {
        out.push(
          `event ${i} (${e.type}): ${issue.path.map((p) => String(p)).join(".")}: ${issue.message}`,
        );
      }
      continue;
    }
    const schema = Object.hasOwn(standard, e.type)
      ? standard[e.type]
      : Object.hasOwn(ruleset.eventSchemas, e.type)
        ? ruleset.eventSchemas[e.type]
        : undefined;
    if (schema === undefined) {
      out.push(
        `event ${i} has the undeclared type "${e.type}": use a standard type or declare it in ${ruleset.ref}'s eventSchemas`,
      );
      continue;
    }
    const data = schema.safeParse(e.data);
    if (!data.success) {
      for (const issue of data.error.issues) {
        const path = issue.path.map((p) => String(p)).join(".");
        out.push(`event ${i} (${e.type}): data${path === "" ? "" : `.${path}`}: ${issue.message}`);
      }
    }
  }
  return out;
}

/** Throws an `EngineBug` of kind `invariant` when an emitted event fails the check. */
export function checkEvents(ruleset: AnyRuleset, events: readonly DomainEvent[], t: number): void {
  const problems = eventProblems(ruleset, events);
  if (problems.length > 0) {
    throw new EngineBug(
      "invariant",
      `emitted events failed the check at t = ${t}:\n  ${problems.join("\n  ")}`,
      { t, problems },
    );
  }
}
