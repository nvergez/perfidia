import type {
  ActionHandler,
  Ctx,
  DomainModule,
  EventHandler,
  Invariant,
  ReadCtx,
} from "@perfidia/engine/contracts";
import {
  compareIds,
  type ActionOf,
  type ActionType,
  type City,
  type CityId,
  type DeepReadonly,
  type MovementId,
  type PlayerId,
  type Recipient,
  type UnitCounts,
  type Violation,
} from "@perfidia/protocol";
import { addUnits, hasUnits, must, own, sendHome, takeUnits, unitTotal } from "./util.ts";

// A fake `DomainModule` (docs/architecture.md §15 T04), enough for kernel tests and replay logs:
// builds, recruits, tail cancels, attacks, supports, spies, recalls, messages, pact proposals and
// answers, with their scheduled events and arrivals. It ignores costs and accrual: stock changes
// only when a spy spends gold. Actions it does not model are rejected with `INVALID_ARGS`.

type Fail = { ok: false; violation: Violation };

function fail(code: string, details: Violation["details"] = {}): Fail {
  return { ok: false, violation: { code, details } };
}

function ownedCity(
  r: ReadCtx,
  seat: PlayerId,
  id: CityId,
): Fail | { ok: true; city: DeepReadonly<City> } {
  const city = own(r.state.cities, id);
  if (city === undefined) return fail("UNKNOWN_ID", { city: id });
  if (city.owner !== seat) return fail("NOT_OWNER", { city: id });
  return { ok: true, city };
}

function lastEnd(r: ReadCtx, items: readonly { readonly end: number }[]): number {
  const last = items.at(-1);
  return last === undefined ? r.now : Math.max(r.now, last.end);
}

interface BuildPlan {
  readonly city: CityId;
  readonly building: string;
  readonly level: number;
  readonly start: number;
  readonly end: number;
}

const build: ActionHandler<ActionOf<"build">, BuildPlan> = {
  validate(r, seat, a) {
    const owned = ownedCity(r, seat, a.city);
    if (!owned.ok) return owned;
    const city = owned.city;
    const table = r.rules.buildings.find((b) => b.id === a.building);
    if (table === undefined) return fail("INVALID_ARGS", { building: a.building });
    if (city.build.length >= r.rules.queues.build.max) {
      return fail("QUEUE_FULL", { city: a.city, max: r.rules.queues.build.max });
    }
    const queued = city.build.filter((b) => b.building === a.building).length;
    const level = (city.buildings[a.building] ?? 0) + queued + 1;
    if (level > table.maxLevel)
      return fail("MAX_LEVEL", { building: a.building, maxLevel: table.maxLevel });
    const start = lastEnd(r, city.build);
    const duration = Math.max(1, table.time[level]?.[0] ?? 1);
    return {
      ok: true,
      plan: { city: a.city, building: a.building, level, start, end: start + duration },
    };
  },
  apply(ctx, _seat, plan) {
    const city = must(ctx.state.cities, plan.city, "city");
    const id = ctx.nextItem(plan.city);
    const seq = ctx.schedule("build_done", plan.end, plan.city);
    city.build.push({
      id,
      building: plan.building,
      level: plan.level,
      cost: { wood: 0, stone: 0, gold: 0 },
      start: plan.start,
      end: plan.end,
      seq,
    });
    return { item: id, level: plan.level, end: plan.end };
  },
};

interface RecruitPlan {
  readonly city: CityId;
  readonly queue: string;
  readonly unit: string;
  readonly count: number;
  readonly unitTime: number;
  readonly pop: number;
  readonly start: number;
}

const recruit: ActionHandler<ActionOf<"recruit">, RecruitPlan> = {
  validate(r, seat, a) {
    const owned = ownedCity(r, seat, a.city);
    if (!owned.ok) return owned;
    const city = owned.city;
    const unit = r.rules.units.find((u) => u.id === a.unit);
    if (unit === undefined) return fail("INVALID_ARGS", { unit: a.unit });
    if (a.count > unit.maxPerOrder)
      return fail("BATCH_LIMIT", { unit: a.unit, max: unit.maxPerOrder });
    const queue = r.rules.queues.recruit.find((q) => q.id === unit.queue);
    if (queue === undefined) return fail("INVALID_ARGS", { queue: unit.queue });
    const batches = city.recruit[queue.id] ?? [];
    if (batches.length >= queue.maxBatches)
      return fail("QUEUE_FULL", { city: a.city, max: queue.maxBatches });
    const unitTime = Math.max(1, unit.time[city.buildings[queue.building] ?? 0] ?? 1);
    return {
      ok: true,
      plan: {
        city: a.city,
        queue: queue.id,
        unit: a.unit,
        count: a.count,
        unitTime,
        pop: unit.pop,
        start: lastEnd(r, batches),
      },
    };
  },
  apply(ctx, _seat, plan) {
    const city = must(ctx.state.cities, plan.city, "city");
    const id = ctx.nextItem(plan.city);
    const end = plan.start + plan.unitTime * plan.count;
    const seq = ctx.schedule("recruit_done", end, plan.city);
    const batches = city.recruit[plan.queue] ?? [];
    batches.push({
      id,
      unit: plan.unit,
      count: plan.count,
      done: 0,
      unitTime: plan.unitTime,
      costEach: { wood: 0, stone: 0, gold: 0 },
      popEach: plan.pop,
      start: plan.start,
      end,
      seq,
    });
    city.recruit[plan.queue] = batches;
    return { item: id, end };
  },
};

interface CancelPlan {
  readonly city: CityId;
  readonly queue: string;
  readonly from: number;
}

const cancelQueue: ActionHandler<ActionOf<"cancel_queue">, CancelPlan> = {
  validate(r, seat, a) {
    const owned = ownedCity(r, seat, a.city);
    if (!owned.ok) return owned;
    const city = owned.city;
    const inBuild = city.build.findIndex((b) => b.id === a.item);
    if (inBuild >= 0) return { ok: true, plan: { city: a.city, queue: "build", from: inBuild } };
    for (const [queue, batches] of Object.entries(city.recruit).toSorted((x, y) =>
      compareIds(x[0], y[0]),
    )) {
      const index = batches.findIndex((b) => b.id === a.item);
      if (index >= 0) return { ok: true, plan: { city: a.city, queue, from: index } };
    }
    return fail("QUEUE_ITEM", { city: a.city, item: a.item });
  },
  apply(ctx, _seat, plan) {
    const city = must(ctx.state.cities, plan.city, "city");
    const items = plan.queue === "build" ? city.build : (city.recruit[plan.queue] ?? []);
    const removed = items.splice(plan.from);
    for (const item of removed) ctx.cancel(item.seq);
    return { removed: removed.length };
  },
};

interface LaunchPlan {
  readonly kind: "attack" | "support" | "spy";
  readonly from: CityId;
  readonly to: CityId;
  readonly units: UnitCounts;
  readonly gold: number;
  readonly arriveAt: number;
  readonly party: PlayerId | null;
}

function launchCheck(
  r: ReadCtx,
  seat: PlayerId,
  kind: LaunchPlan["kind"],
  a: { from: CityId; to: CityId },
  units: UnitCounts,
  gold: number,
): Fail | { ok: true; plan: LaunchPlan } {
  const owned = ownedCity(r, seat, a.from);
  if (!owned.ok) return owned;
  const from = owned.city;
  const to = own(r.state.cities, a.to);
  if (to === undefined) return fail("UNKNOWN_ID", { city: a.to });
  if (to.id === from.id || (kind !== "support" && to.owner === seat)) {
    return fail("INVALID_TARGET", { city: a.to });
  }
  if (kind === "attack" && r.now < r.rules.time.attackFrom) {
    return fail("ATTACK_PROTECTION", { availableAt: r.rules.time.attackFrom });
  }
  if (kind !== "spy") {
    if (unitTotal(units) === 0) return fail("NO_UNITS", { city: a.from });
    if (!hasUnits(from.units, units)) return fail("INSUFFICIENT_UNITS", { city: a.from });
  } else {
    if (gold < r.rules.movement.spyMinGold)
      return fail("SPY_GOLD", { min: r.rules.movement.spyMinGold });
    const have = Math.floor(from.stock.gold / r.rules.resourceScale);
    if (have < gold) return fail("INSUFFICIENT_RESOURCES", { need_gold: gold, have_gold: have });
  }
  const travel = r.ruleset.hooks.travelTime(r, from.island, to.island, { kind, units });
  return {
    ok: true,
    plan: { kind, from: a.from, to: a.to, units, gold, arriveAt: r.now + travel, party: to.owner },
  };
}

function launch(
  ctx: Ctx,
  seat: PlayerId,
  plan: LaunchPlan,
): { movement: MovementId; arriveAt: number } {
  const from = must(ctx.state.cities, plan.from, "city");
  const to = must(ctx.state.cities, plan.to, "city");
  takeUnits(from.units, plan.units);
  if (plan.gold > 0) from.stock.gold -= plan.gold * ctx.rules.resourceScale;
  const id = ctx.nextId("m", seat);
  const seq = ctx.schedule(`arrive_${plan.kind}`, plan.arriveAt, id);
  ctx.state.movements[id] = {
    id,
    kind: plan.kind,
    owner: seat,
    home: plan.from,
    from: plan.from,
    fromIsland: from.island,
    to: plan.to,
    toIsland: to.island,
    slot: null,
    party: plan.party,
    units: { ...plan.units },
    cargo: { wood: 0, stone: 0, gold: 0 },
    gold: plan.gold,
    departAt: ctx.now,
    arriveAt: plan.arriveAt,
    seq,
    back: null,
  };
  const target = to.owner;
  if (target !== null && target !== seat) {
    const base = {
      movement: id,
      from: plan.from,
      by: seat,
      to: plan.to,
      departAt: ctx.now,
      arriveAt: plan.arriveAt,
    };
    if (plan.kind === "attack") {
      ctx.emit({
        type: "incoming_attack",
        public: false,
        to: [{ p: target, as: "party" }],
        data: { ...base, foe: seat, homecoming: false },
      });
    } else if (plan.kind === "support") {
      ctx.emit({
        type: "incoming_support",
        public: false,
        to: [{ p: target, as: "target" }],
        data: { ...base, units: { ...plan.units } },
      });
    }
  }
  return { movement: id, arriveAt: plan.arriveAt };
}

const attack: ActionHandler<ActionOf<"attack">, LaunchPlan> = {
  validate: (r, seat, a) => launchCheck(r, seat, "attack", a, a.units, 0),
  apply: (ctx, seat, plan) => launch(ctx, seat, plan),
};

const support: ActionHandler<ActionOf<"support">, LaunchPlan> = {
  validate: (r, seat, a) => launchCheck(r, seat, "support", a, a.units, 0),
  apply: (ctx, seat, plan) => launch(ctx, seat, plan),
};

const spy: ActionHandler<ActionOf<"spy">, LaunchPlan> = {
  validate: (r, seat, a) => launchCheck(r, seat, "spy", a, {}, a.gold),
  apply: (ctx, seat, plan) => launch(ctx, seat, plan),
};

const recall: ActionHandler<ActionOf<"recall">, { readonly movement: MovementId }> = {
  validate(r, seat, a) {
    const m = own(r.state.movements, a.movement);
    if (m === undefined || m.owner !== seat) return fail("UNKNOWN_ID", { movement: a.movement });
    const kinds: readonly string[] = r.rules.movement.recall.kinds;
    if (!kinds.includes(m.kind) || r.now - m.departAt > r.rules.movement.recall.window) {
      return fail("NOT_RECALLABLE", { movement: a.movement });
    }
    return { ok: true, plan: { movement: a.movement } };
  },
  apply(ctx, seat, plan) {
    const m = must(ctx.state.movements, plan.movement, "movement");
    ctx.cancel(m.seq);
    const kind = m.kind;
    if (kind === "return") throw new Error("fake domain: a return is not recallable");
    const elapsed = Math.max(1, ctx.now - m.departAt);
    m.back = { kind, at: ctx.now };
    m.kind = "return";
    m.departAt = ctx.now;
    m.arriveAt = ctx.now + elapsed;
    m.seq = ctx.schedule("arrive_return", m.arriveAt, m.id);
    ctx.emit({
      type: "movement_recalled",
      public: false,
      to: [{ p: seat, as: "self" }],
      data: { movement: m.id, kind, by: seat, to: m.to, arriveAt: m.arriveAt },
    });
    return { movement: m.id, arriveAt: m.arriveAt };
  },
};

const sendMessage: ActionHandler<ActionOf<"send_message">, ActionOf<"send_message">> = {
  validate(r, seat, a) {
    const max = r.rules.diplomacy.messageMaxChars;
    if (a.text.length > max) return fail("TEXT_TOO_LONG", { max, length: a.text.length });
    if (a.to !== "all") {
      for (const p of a.to) {
        if (own(r.state.players, p) === undefined || p === seat)
          return fail("UNKNOWN_ID", { player: p });
      }
    }
    return { ok: true, plan: a };
  },
  apply(ctx, seat, a) {
    const id = ctx.nextId("g", seat);
    const to: Recipient[] =
      a.to === "all"
        ? []
        : [...new Set(a.to)].toSorted(compareIds).map((p) => ({ p, as: "target" }));
    ctx.emit({
      type: "message",
      public: a.to === "all",
      to,
      data: { message: id, from: seat, to: a.to === "all" ? "all" : [...a.to], text: a.text },
    });
    return { message: id };
  },
};

const propose: ActionHandler<ActionOf<"propose">, ActionOf<"propose">> = {
  validate(r, seat, a) {
    if (own(r.state.players, a.to) === undefined || a.to === seat)
      return fail("INVALID_TARGET", { player: a.to });
    const d = r.rules.diplomacy;
    if (a.text.length > d.proposalTextMaxChars) {
      return fail("TEXT_TOO_LONG", { max: d.proposalTextMaxChars, length: a.text.length });
    }
    if (a.until !== null && !r.rules.toolOptions.pactUntil)
      return fail("INVALID_ARGS", { field: "until" });
    const open = Object.values(r.state.proposals).filter((p) => p.from === seat).length;
    if (open >= d.maxOpenProposals) return fail("PROPOSAL_LIMIT", { max: d.maxOpenProposals });
    return { ok: true, plan: a };
  },
  apply(ctx, seat, a) {
    const id = ctx.nextId("q", seat);
    const expiresAt = ctx.now + ctx.rules.diplomacy.proposalTtl;
    const seq = ctx.schedule("proposal_expire", expiresAt, id);
    ctx.state.proposals[id] = {
      id,
      from: seat,
      to: a.to,
      kind: a.kind,
      name: a.name,
      until: null,
      expiresAt,
      seq,
    };
    ctx.emit({
      type: "proposal",
      public: false,
      to: [
        { p: seat, as: "self" },
        { p: a.to, as: "target" },
      ],
      data: {
        proposal: id,
        from: seat,
        to: a.to,
        kind: a.kind,
        name: a.name,
        text: a.text,
        until: null,
        expiresAt,
      },
    });
    return { proposal: id, expiresAt };
  },
};

function pactKey(a: PlayerId, b: PlayerId): string {
  return `${a}|${b}`;
}

const answer: ActionHandler<ActionOf<"answer">, ActionOf<"answer">> = {
  validate(r, seat, a) {
    const p = own(r.state.proposals, a.proposal);
    if (p === undefined || p.to !== seat)
      return fail("PROPOSAL_NOT_FOUND", { proposal: a.proposal });
    return { ok: true, plan: a };
  },
  apply(ctx, _seat, a) {
    const p = must(ctx.state.proposals, a.proposal, "proposal");
    ctx.cancel(p.seq);
    delete ctx.state.proposals[p.id];
    ctx.emit({
      type: "proposal_answered",
      public: false,
      to: [
        { p: p.from, as: "self" },
        { p: p.to, as: "target" },
      ],
      data: { proposal: p.id, from: p.from, to: p.to, kind: p.kind, accept: a.accept },
    });
    if (!a.accept || p.kind !== "pact") return { accepted: a.accept };
    const [x, y] = [p.from, p.to].toSorted(compareIds);
    if (x === undefined || y === undefined)
      throw new Error("fake domain: pact without two players");
    if (ctx.state.pacts.some((pact) => pact.a === x && pact.b === y)) return { accepted: true };
    const duration = ctx.rules.diplomacy.pactDuration;
    const expiresAt = duration === null ? null : ctx.now + duration;
    const seq = expiresAt === null ? null : ctx.schedule("pact_expire", expiresAt, pactKey(x, y));
    ctx.state.pacts = [...ctx.state.pacts, { a: x, b: y, since: ctx.now, expiresAt, seq }].toSorted(
      (u, v) => compareIds(u.a, v.a) || compareIds(u.b, v.b),
    );
    ctx.emit({ type: "pact_signed", public: true, to: [], data: { a: x, b: y, expiresAt } });
    return { accepted: true };
  },
};

function unsupported<T extends Exclude<ActionType, "ext">>(
  type: T,
): ActionHandler<ActionOf<T>, never> {
  return {
    validate: () => fail("INVALID_ARGS", { action: type, reason: "unsupported_by_fake_domain" }),
    apply: () => {
      throw new Error(`fake domain: ${type} is not supported`);
    },
  };
}

function owner(ctx: Ctx, city: CityId): PlayerId | null {
  return must(ctx.state.cities, city, "city").owner;
}

function self(p: PlayerId | null): Recipient[] {
  return p === null ? [] : [{ p, as: "self" }];
}

const buildDone: EventHandler = (ctx, ev) => {
  const city = must(ctx.state.cities, ev.ref, "city");
  const index = city.build.findIndex((b) => b.seq === ev.seq);
  if (index < 0) throw new Error(`fake domain: no build item with seq ${ev.seq}`);
  const [item] = city.build.splice(index, 1);
  if (item === undefined) throw new Error(`fake domain: no build item with seq ${ev.seq}`);
  const max = ctx.rules.buildings.find((b) => b.id === item.building)?.maxLevel ?? item.level;
  const level = Math.min(max, (city.buildings[item.building] ?? 0) + 1);
  city.buildings[item.building] = level;
  const to = self(owner(ctx, city.id));
  ctx.emit({
    type: "build_done",
    public: false,
    to,
    data: { city: city.id, item: item.id, building: item.building, level },
  });
  if (city.build.length === 0) {
    ctx.emit({ type: "queue_empty", public: false, to, data: { city: city.id, queue: "build" } });
  }
};

const recruitDone: EventHandler = (ctx, ev) => {
  const city = must(ctx.state.cities, ev.ref, "city");
  for (const [queue, batches] of Object.entries(city.recruit).toSorted((x, y) =>
    compareIds(x[0], y[0]),
  )) {
    const index = batches.findIndex((b) => b.seq === ev.seq);
    if (index < 0) continue;
    const [batch] = batches.splice(index, 1);
    if (batch === undefined) break;
    const units = { [batch.unit]: batch.count };
    addUnits(city.units, units);
    const entry = ctx.state.ledger[city.owner ?? "neutral"];
    if (entry !== undefined) addUnits(entry.made, units);
    const to = self(city.owner);
    ctx.emit({
      type: "recruit_done",
      public: false,
      to,
      data: { city: city.id, item: batch.id, queue, unit: batch.unit, count: batch.count },
    });
    if (batches.length === 0)
      ctx.emit({ type: "queue_empty", public: false, to, data: { city: city.id, queue } });
    return;
  }
  throw new Error(`fake domain: no recruit batch with seq ${ev.seq}`);
};

const proposalExpire: EventHandler = (ctx, ev) => {
  const p = must(ctx.state.proposals, ev.ref, "proposal");
  delete ctx.state.proposals[p.id];
  ctx.emit({
    type: "proposal_expired",
    public: false,
    to: [
      { p: p.from, as: "self" },
      { p: p.to, as: "target" },
    ],
    data: { proposal: p.id, from: p.from, to: p.to, kind: p.kind },
  });
};

const pactExpire: EventHandler = (ctx, ev) => {
  const pact = ctx.state.pacts.find((x) => pactKey(x.a, x.b) === ev.ref);
  if (pact === undefined) throw new Error(`fake domain: no pact ${ev.ref}`);
  ctx.state.pacts = ctx.state.pacts.filter((x) => x !== pact);
  ctx.emit({ type: "pact_expired", public: true, to: [], data: { a: pact.a, b: pact.b } });
};

function arriveSupport(ctx: Ctx, id: MovementId): void {
  const m = must(ctx.state.movements, id, "movement");
  ctx.emit({
    type: "support_arrived",
    public: false,
    to: [{ p: m.owner, as: "self" }],
    data: { movement: m.id, by: m.owner, to: m.to ?? m.home },
  });
  sendHome(ctx, id);
}

function arriveReturn(ctx: Ctx, id: MovementId): void {
  const m = must(ctx.state.movements, id, "movement");
  const home = own(ctx.state.cities, m.home);
  if (home !== undefined && home.owner === m.owner) addUnits(home.units, m.units);
  else {
    const entry = ctx.state.ledger[m.owner];
    if (entry !== undefined) addUnits(entry.gone, m.units);
  }
  delete ctx.state.movements[m.id];
  ctx.emit({
    type: "returned",
    public: false,
    to: [{ p: m.owner, as: "self" }],
    data: { movement: m.id, city: m.home, units: { ...m.units }, cargo: { ...m.cargo } },
  });
}

/** Units conservation per owner and unit: home + stationed + moving = made − gone. */
const conservation: Invariant = {
  name: "fake.conservation",
  level: "step",
  check(r) {
    const counted = new Map<string, number>();
    const count = (who: string, units: Readonly<UnitCounts>): void => {
      for (const [unit, n] of Object.entries(units)) {
        const key = `${who}:${unit}`;
        counted.set(key, (counted.get(key) ?? 0) + (n ?? 0));
      }
    };
    for (const city of Object.values(r.state.cities)) {
      count(city.owner ?? "neutral", city.units);
      for (const g of city.stationed) count(g.owner, g.units);
    }
    for (const m of Object.values(r.state.movements)) count(m.owner, m.units);
    const out: string[] = [];
    const keys = new Set(counted.keys());
    for (const [who, entry] of Object.entries(r.state.ledger)) {
      for (const unit of Object.keys({ ...entry.made, ...entry.gone })) keys.add(`${who}:${unit}`);
    }
    for (const key of [...keys].toSorted(compareIds)) {
      const [who = "", unit = ""] = key.split(":");
      const entry = own(r.state.ledger, who);
      const expected = (entry?.made[unit] ?? 0) - (entry?.gone[unit] ?? 0);
      const actual = counted.get(key) ?? 0;
      if (expected !== actual)
        out.push(`${who} has ${actual} ${unit}, the ledger says ${expected}`);
    }
    return out;
  },
};

const ARRIVAL_DEFAULTS: Readonly<
  Record<"support" | "shipment" | "found" | "return", (ctx: Ctx, m: MovementId) => void>
> = {
  support: arriveSupport,
  shipment: (ctx, m) => sendHome(ctx, m),
  found: (ctx, m) => sendHome(ctx, m),
  return: arriveReturn,
};

/** The fake domain module of the testing kit. */
export const fakeDomain: DomainModule = {
  actions: {
    build,
    recruit,
    cancel_queue: cancelQueue,
    send_resources: unsupported("send_resources"),
    attack,
    support,
    spy,
    found_city: unsupported("found_city"),
    recall,
    recall_stationed: unsupported("recall_stationed"),
    dismiss: unsupported("dismiss"),
    send_message: sendMessage,
    propose,
    answer,
    leave: unsupported("leave"),
  },
  events: {
    build_done: buildDone,
    recruit_done: recruitDone,
    proposal_expire: proposalExpire,
    pact_expire: pactExpire,
  },
  arrivals: ARRIVAL_DEFAULTS,
  invariants: [conservation],
};
