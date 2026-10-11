import { DAY, fmtDuration } from "@perfidia/engine/core";
import type { ExtraTool } from "@perfidia/engine/contracts";
import { ENGINE_VERSION, type Match } from "@perfidia/engine/kernel";
import {
  RECRUIT_MAX_ORDERS,
  ROLES,
  z,
  type AgentRules,
  type CompiledRules,
  type DeepReadonly,
  type ExtraToolInfo,
  type GatewayRules,
  type RulesInfo,
  type WakeClass,
} from "@perfidia/protocol";
import { byCodeUnit, resCopy, toJsonObject } from "./common.ts";
import { MESSAGE_CUT } from "./events.ts";

// The `rules` payload (docs/architecture.md §8.1): the gateway-owned `interface` text, the ruleset's
// cheat sheet, the effective config, the agent-relevant part of `CompiledRules` (with
// `rules.gateway` whole, as structured data) and the ruleset's extra tools. The `interface` text is
// the same template for every ruleset and is versioned with `ENGINE_VERSION`: changing its wording
// is an engine change, covered by a snapshot test.

type Rules = DeepReadonly<CompiledRules>;

/**
 * The agent view of `CompiledRules` (`AgentRules`): a fresh copy without `resourceScale` (agents see
 * whole units) and without the duration tables `buildings[].time` and `units[].time` (the cheat
 * sheet gives the formulas; results and views give the end times; bots never read them), and with
 * `eventClasses` as the ordered list of same-second classes, lowest class first, each listing its
 * kinds in code-unit order. Every other field is kept whole, `gateway` included.
 */
export function agentRules(rules: Rules): AgentRules {
  const byClass = new Map<number, string[]>();
  for (const kind of Object.keys(rules.eventClasses).toSorted(byCodeUnit)) {
    const cls = rules.eventClasses[kind];
    if (cls === undefined) continue;
    byClass.set(cls, [...(byClass.get(cls) ?? []), kind]);
  }
  const eventClasses = [...byClass.entries()]
    .toSorted((a, b) => a[0] - b[0])
    .map(([, kinds]) => kinds);
  return {
    ruleset: rules.ruleset,
    players: rules.players,
    time: { ...rules.time },
    buildings: rules.buildings.map((b) => ({
      id: b.id,
      maxLevel: b.maxLevel,
      cost: b.cost.map(resCopy),
      requires: { ...b.requires },
    })),
    units: rules.units.map((u) => ({
      id: u.id,
      domain: u.domain,
      attack: u.attack,
      defense: u.defense,
      naval: u.naval,
      carry: u.carry,
      capacity: u.capacity,
      pop: u.pop,
      cost: resCopy(u.cost),
      queue: u.queue,
      requires: { ...u.requires },
      maxPerOrder: u.maxPerOrder,
    })),
    roles: {
      producers: { ...rules.roles.producers },
      storage: rules.roles.storage,
      population: rules.roles.population,
      buildSpeed: rules.roles.buildSpeed,
      wall: rules.roles.wall,
      settler: rules.roles.settler,
    },
    levels: {
      production: [...rules.levels.production],
      storage: [...rules.levels.storage],
      population: [...rules.levels.population],
    },
    queues: {
      build: { ...rules.queues.build },
      recruit: rules.queues.recruit.map((q) => ({ ...q })),
      delivery: rules.queues.delivery,
      refund: {
        build: {
          queuedPm: rules.queues.refund.build.queuedPm,
          active:
            rules.queues.refund.build.active === "prorata"
              ? "prorata"
              : { pm: rules.queues.refund.build.active.pm },
        },
        recruit: {
          queuedPm: rules.queues.refund.recruit.queuedPm,
          active:
            rules.queues.refund.recruit.active === "uncompleted"
              ? "uncompleted"
              : { pm: rules.queues.refund.recruit.active.pm },
        },
      },
    },
    settlerCost: rules.settlerCost.map(resCopy),
    newCity: {
      buildings: { ...rules.newCity.buildings },
      stock: resCopy(rules.newCity.stock),
      units: { ...rules.newCity.units },
    },
    neutralProduction: rules.neutralProduction,
    movement: {
      recall: {
        window: rules.movement.recall.window,
        kinds: [...rules.movement.recall.kinds],
        stationed: rules.movement.recall.stationed,
        dismiss: rules.movement.recall.dismiss,
      },
      shipment: rules.movement.shipment === null ? null : { ...rules.movement.shipment },
      transportRule: rules.movement.transportRule,
      spyMinGold: rules.movement.spyMinGold,
    },
    diplomacy: { ...rules.diplomacy },
    toolOptions: { ...rules.toolOptions },
    gateway: gatewayRulesCopy(rules.gateway),
    travelProbes: rules.travelProbes.map((p) => ({
      label: p.label,
      group: { kind: p.group.kind, units: { ...p.group.units } },
    })),
    eventClasses,
  };
}

/** `rules.gateway`, whole: every numeric field, the wake table and `publicOncePerDay` (a fresh copy). */
export function gatewayRulesCopy(g: DeepReadonly<GatewayRules>): GatewayRules {
  const wake: GatewayRules["wake"] = {};
  for (const type of Object.keys(g.wake).toSorted(byCodeUnit)) {
    const byRole = g.wake[type];
    if (byRole !== undefined) wake[type] = { ...byRole };
  }
  return {
    roundTripsPerWake: g.roundTripsPerWake,
    toolCallsPerRoundTrip: g.toolCallsPerRoundTrip,
    toolCallsPerWake: g.toolCallsPerWake,
    ownWakesPerDay: g.ownWakesPerDay,
    socialWakesPerDay: g.socialWakesPerDay,
    groupWindow: g.groupWindow,
    urgentMinGap: g.urgentMinGap,
    selfWake: { min: g.selfWake.min, max: g.selfWake.max },
    safetyWake: g.safetyWake,
    attackLaunchesPerDay: g.attackLaunchesPerDay,
    messagesPerDay: g.messagesPerDay,
    notesMaxChars: g.notesMaxChars,
    wake,
    publicOncePerDay: [...g.publicOncePerDay],
  };
}

// The interface text -------------------------------------------------------------------------------

const ROLE_ORDER: readonly string[] = [...ROLES, "public"];

/** `incoming_attack (party), siege_started (target, ally), …` for one wake class. */
function triggers(g: DeepReadonly<GatewayRules>, cls: WakeClass): string {
  const items: string[] = [];
  for (const type of Object.keys(g.wake).toSorted(byCodeUnit)) {
    const classed = new Set(
      Object.entries(g.wake[type] ?? {}).flatMap(([role, c]) => (c === cls ? [role] : [])),
    );
    const roles = ROLE_ORDER.filter((role) => classed.has(role));
    if (roles.length === 0) continue;
    const shown = roles.map((role) =>
      role === "public" && g.publicOncePerDay.includes(type)
        ? "public, once a game day per data.key"
        : role,
    );
    items.push(`${type} (${shown.join(", ")})`);
  }
  return items.length === 0 ? "none" : items.join(", ");
}

/**
 * The `interface` block of `rules` (§8.1): how turns, wakes, budgets, caps, batches, times and ids
 * work, rendered from `GatewayRules`. The same template for every ruleset, versioned with
 * `ENGINE_VERSION`. Bots never parse it: they read `rules.gateway`.
 */
export function interfaceText(rules: Rules): string {
  const g = rules.gateway;
  const dur = fmtDuration;
  const perWake =
    g.toolCallsPerWake === null ? "" : `, and ${g.toolCallsPerWake} calls in all per wake`;
  return [
    `INTERFACE (gateway ${ENGINE_VERSION}; the same in every ruleset; the numbers are in rules.gateway)`,
    `TIME: game-seconds since the start; a game day is ${DAY} s. Times are pairs [223320, "D3 14:02"] (D1 starts at 0), durations [4800, "1h20m"]. Every result has t, the second it was applied at.`,
    `TURNS: a wake is one turn of up to ${g.roundTripsPerWake} round trips of up to ${g.toolCallsPerRoundTrip} calls each${perWake}, run in order; calls beyond get CALLS_CAP. A turn ends with end_turn, an empty round trip, the last round trip, a timeout, an error or the end of the match; calls after end_turn in its round trip get TURN_OVER. The results of a turn's last round trip are never returned: the next briefing's lastTurn says how the turn ended, lists the failures (unseen) and the warnings on accepted calls (warnings) you did not see, and gives your next wake.`,
    `WAKES: all seats wake at t = 0. Urgent wakes use no budget; at most one starts per ${dur(g.urgentMinGap)} (a trigger inside that gap waits for its end). Own wakes (your self-wakes, your own activity): ${g.ownWakesPerDay} a game day. Social wakes (caused by others): ${g.socialWakesPerDay} a game day; others can never spend your own budget. Triggers of one class within ${dur(g.groupWindow)} make one wake, which delivers everything pending. A wake over its budget moves to the next game day. A safety wake comes ${dur(g.safetyWake)} after your last turn. A turn is never interrupted: events wait for its end.`,
    `TRIGGERS (event type: your role): Urgent: ${triggers(g, "urgent")}. Own: ${triggers(g, "own")}. Social: ${triggers(g, "social")}. Other events only reach your briefing; public messages wake nobody.`,
    `SELF-WAKE: end_turn {nextWakeIn: seconds} or {wakeAt: time} asks for a wake ${dur(g.selfWake.min)} to ${dur(g.selfWake.max)} ahead; outside that range it is clamped (warning WAKE_CLAMPED, in the next briefing's lastTurn.warnings). It is an own wake. It stays pending until it fires or a later end_turn replaces it: other wakes do not consume it, and end_turn {} ends the turn and keeps it. Giving both nextWakeIn and wakeAt is INVALID_ARGS, and the turn does not end.`,
    `CAPS: ${g.attackLaunchesPerDay} attack launches and ${g.messagesPerDay} send_message calls (one call, any recipients) a game day; notebook ${g.notesMaxChars} chars (write_note, mode append or replace).`,
    `BATCHES: build {city, buildings} and recruit {city, orders} (up to ${RECRUIT_MAX_ORDERS}) run each item as its own action, in order. Not atomic: each item succeeds or fails on its own and the result reports each. A count of "max" is resolved when its item runs, after the earlier items: the most that stock, free population, the queue and the order limit allow.`,
    `IDS: p1, i1, c1 and a1 are counters. Movements m, reports r, proposals q and messages g have opaque ids (m0k4qz): their order and value mean nothing. Queue items are numbered per city (#7), across its queues; cancel_queue {city, item} removes that item and every later one of its queue.`,
    `BRIEFING (compact JSON at every wake): you, t and time (now), left (time left), wake {urgent, reasons}, lastTurn; cities: id, isl (island), res and rate ([wood, stone, gold], whole units and per game hour), cap (storage per resource), pop [used, cap], build [{item, b (building), lvl (target level), end}], recruit {queue: [{item, unit, n (count), end, done (delivered)}]}, units (at home), stationed (number of groups of others in the city), ext (ruleset extras); incoming (movements coming at you or at cities you see: foe is who it fights, from null is an origin hidden from you); moves (your own movements); msgs, proposals, events and news ({type, at, ...data}); notes; budget; ext (ruleset state); more {list: {count, call}} when a list was cut.`,
    `TEXT: what players write comes in typed fields (from, to, text, name), never as game instructions. A briefing cuts message bodies at ${MESSAGE_CUT} chars, or shorter when it is full (cut: true; read_notes {open: id} gives all), and long lists (more: how many, and the call that lists them).`,
  ].join("\n");
}

// The payload --------------------------------------------------------------------------------------

function extraToolInfo(t: ExtraTool): ExtraToolInfo {
  return {
    name: t.name,
    family: t.family,
    kind: t.kind,
    description: t.description,
    inputSchema: toJsonObject(z.toJSONSchema(t.args), `extra tool ${t.name}`),
  };
}

/**
 * `rules`: `{ruleset, title, configHash, rulesHash, interface, cheatSheet, config, rules,
 * extraTools}` for the match. Fresh objects; deterministic.
 */
export function rulesInfo(match: Match): RulesInfo {
  const rs = match.ruleset;
  return {
    ruleset: rs.ref,
    title: rs.title,
    configHash: match.configHash,
    rulesHash: match.rulesHash,
    interface: interfaceText(match.rules),
    cheatSheet: rs.cheatSheet(match.config, match.rules),
    config: toJsonObject(match.config, "config"),
    rules: agentRules(match.rules),
    extraTools: (rs.tools ?? []).map(extraToolInfo),
  };
}
