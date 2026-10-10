import { DAY, fmt, fmtDuration, fmtTime } from "@perfidia/engine/core";
import type { ReadCtx } from "@perfidia/engine/contracts";
import {
  BUILD_QUEUE,
  affordableAt,
  citiesOf,
  popCap,
  popUsed,
  queueEtas,
  rates,
  relation,
  stockAt,
  storageCap,
  unitsAtHome,
} from "@perfidia/engine/std";
import { seatErrorText, seatOf, type GatewayState } from "@perfidia/gateway/seat";
import {
  DOMAIN_ERROR_CODES,
  GATEWAY_WARNING_CODES,
  RECRUIT_MAX_ORDERS,
  type City,
  type DeepReadonly,
  type PlayerId,
  type Res,
  type ResourceId,
  type ToolError,
  type ToolWarning,
  type Violation,
  type ViolationDetails,
} from "@perfidia/protocol";
import {
  RESOURCES,
  byCodeUnit,
  joinAnd,
  joinOr,
  lookup,
  orderedUnits,
  ownCity,
  stripControl,
  timeAndWait,
} from "./common.ts";

// The wording of player errors and warnings (docs/architecture.md §7.3): each domain code and
// gateway warning becomes `{message, hint}` with numbers and game times; a ruleset's own codes use
// `ruleset.errors[code]`, with the same deterministic formatter (`core`'s `fmt`). The four codes the
// seat logic raises (`DAILY_CAP`, `CALLS_CAP`, `ROUND_TRIP_CAP`, `NOTE_TOO_LONG`) are worded by
// `seatErrorText`, so the live host and the rebuild (§10.5) produce the same text.
//
// Details are the facts (§7.3: numbers and ids, no prose). Where they leave a number out, the
// explanation computes it from the state, but only from the seat's own cities, movements, groups
// and archive, or from public data: an explanation never reveals hidden data (property P10), and a
// hidden id reads exactly like a missing one.

export interface ExplainEnv {
  /** The match at the time of the call (`match.read()`). */
  readonly r: ReadCtx;
  readonly seat: PlayerId;
  readonly gw: GatewayState;
}

export interface Explanation {
  readonly message: string;
  readonly hint: string;
}

type Details = DeepReadonly<ViolationDetails>;
type Explainer = (d: Details, env: ExplainEnv) => Explanation;

// Detail readers --------------------------------------------------------------------------------

function num(d: Details, key: string): number | null {
  const v = lookup(d, key);
  return typeof v === "number" && Number.isSafeInteger(v) ? v : null;
}

/** A game time in the details: a non-negative integer, else `null`. */
function when(d: Details, key: string): number | null {
  const v = num(d, key);
  return v !== null && v >= 0 ? v : null;
}

function str(d: Details, key: string): string | null {
  const v = lookup(d, key);
  return typeof v === "string" ? stripControl(v) : null;
}

/** `availableAt`-style keys: a time, `null` (never) or absent (`undefined`). */
function timeOrNever(d: Details, key: string): number | null | undefined {
  if (!Object.hasOwn(d, key)) return undefined;
  const v = d[key];
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/** ` (a=1, b=c)`: every detail, in code-unit order of the keys; empty without details. */
function detailsText(d: Details): string {
  const keys = Object.keys(d).toSorted(byCodeUnit);
  if (keys.length === 0) return "";
  return ` (${keys.map((k) => `${k}=${String(d[k] ?? null)}`).join(", ")})`;
}

function nextDay(now: number): number {
  return (Math.floor(now / DAY) + 1) * DAY;
}

function levelOf(c: DeepReadonly<City>, building: string): number {
  return lookup(c.buildings, building) ?? 0;
}

function unitsText(units: Readonly<Record<string, number | undefined>>): string {
  const parts = Object.entries(units).flatMap(([u, n]) => (n === undefined ? [] : [`${u} ${n}`]));
  return parts.length === 0 ? "no units" : parts.join(", ");
}

/** ` for barracks level 2`, ` for 20 guard`, ` for settler (k = 2)`, ` for this spy`, or empty. */
function forWhat(d: Details): string {
  const building = str(d, "building");
  if (building !== null) {
    const level = num(d, "level");
    return ` for ${building}${level === null ? "" : ` level ${level}`}`;
  }
  const unit = str(d, "unit");
  if (unit !== null) {
    const count = num(d, "count") ?? num(d, "requested");
    const k = num(d, "k");
    const n = count === null || count === 1 ? "" : `${count} `;
    return ` for ${n}${unit}${k === null ? "" : ` (k = ${k})`}`;
  }
  const kind = str(d, "kind");
  return kind === null ? "" : ` for this ${kind}`;
}

/** `barracks level 2`, `20 guard`, `settler (k = 2)`, `this spy`, or `this`. */
function whatOf(d: Details): string {
  const text = forWhat(d);
  return text === "" ? "this" : text.slice(" for ".length);
}

function needsOf(d: Details): { id: ResourceId; need: number }[] {
  return RESOURCES.flatMap((id) => {
    const need = num(d, `need_${id}`);
    return need === null ? [] : [{ id, need }];
  });
}

// Domain codes ------------------------------------------------------------------------------------

/** Optional tool fields a ruleset may refuse (§3.7), with what the ruleset does instead. */
const OPTION_REASONS: Readonly<Record<string, string>> = {
  slot: "always founds a city in the lowest free slot",
  until: "gives every pact its fixed duration",
};

const invalidArgs: Explainer = (d, { r }) => {
  const ref = str(d, "ruleset") ?? r.ruleset.ref;
  const field = str(d, "field");
  if (field !== null) {
    const why = lookup(OPTION_REASONS, field);
    return {
      message: `${ref} does not accept ${field}${why === undefined ? "" : `: it ${why}`}.`,
      hint: `Remove ${field} and send the call again.`,
    };
  }
  const building = str(d, "building");
  if (building !== null && !r.rules.buildings.some((b) => b.id === building)) {
    return {
      message: `"${building}" is not a building of ${ref}.`,
      hint: `Buildings: ${r.rules.buildings.map((b) => b.id).join(", ")}.`,
    };
  }
  const unit = str(d, "unit");
  if (unit !== null && !r.rules.units.some((u) => u.id === unit)) {
    return {
      message: `"${unit}" is not a unit of ${ref}.`,
      hint: `Units: ${r.rules.units.map((u) => u.id).join(", ")}.`,
    };
  }
  const tool = str(d, "tool");
  if (tool !== null && str(d, "reason") === "no_handler") {
    return {
      message: `${tool} is not available in ${ref}.`,
      hint: "The rules tool lists this ruleset's extra tools.",
    };
  }
  const path = str(d, "path");
  if (path !== null) {
    const issue = str(d, "issue");
    const expected = str(d, "expected");
    return {
      message: `Invalid argument ${path === "" ? "object" : path}${issue === null ? "" : `: ${issue}`}.`,
      hint:
        expected === null
          ? "Check the call against the tool's description."
          : `Expected ${expected}.`,
    };
  }
  return {
    message: `Invalid arguments${detailsText(d)}.`,
    hint: "Check the call against the tool's description; the rules tool lists the valid ids.",
  };
};

/** Id kinds by detail key, with where the seat can find valid ids. */
const ID_KINDS: readonly (readonly [string, string, string])[] = [
  ["city", "city", "view_map lists every city."],
  ["island", "island", "view_map lists every island."],
  ["player", "player", "leaderboard lists every player."],
  ["alliance", "alliance", "leaderboard lists every alliance."],
  [
    "movement",
    "movement",
    "view_player on yourself lists your movements; view_city shows those you can see.",
  ],
  ["proposal", "proposal", "Your briefing lists your open proposals."],
  ["message", "message", "read_notes {search} lists the messages in your archive."],
  ["report", "report", "read_notes {search} lists the reports in your archive."],
  ["id", "id", "Check the id against your briefing and views."],
];

const unknownId: Explainer = (d) => {
  for (const [key, what, hint] of ID_KINDS) {
    const id = str(d, key);
    if (id !== null) return { message: `No ${what} ${id} is known to you.`, hint };
  }
  return {
    message: `An id in this call is not known to you${detailsText(d)}.`,
    hint: "Check the ids against your briefing and views.",
  };
};

const notOwner: Explainer = (d, { r, seat }) => {
  const movement = str(d, "movement");
  if (movement !== null) {
    return {
      message: `${movement} is not your movement.`,
      hint: "view_player on yourself lists your movements.",
    };
  }
  const city = str(d, "city") ?? "This";
  const own = citiesOf(r, seat);
  return {
    message: `${city} is not your city.`,
    hint: own.length === 0 ? "You own no city." : `Your cities: ${own.join(", ")}.`,
  };
};

const turnOver: Explainer = () => ({
  message: "Your turn is over: this call was not run.",
  hint: "Calls placed after end_turn in the same round trip are not run; send them at your next wake.",
});

/** The seat codes, worded by `seatErrorText`; these fallbacks cover malformed details only. */
function seatCode(code: string, fallback: Explainer): Explainer {
  return (d, env) => seatErrorText(code, { ...d }, env.r.now) ?? fallback(d, env);
}

const roundTripCap = seatCode("ROUND_TRIP_CAP", () => ({
  message: "This wake has no round trips left.",
  hint: "End the turn with end_turn; the next wake brings new round trips.",
}));

const callsCap = seatCode("CALLS_CAP", () => ({
  message: "This call was over the call limit and was not run.",
  hint: "Send it again in the next round trip.",
}));

const dailyCap = seatCode("DAILY_CAP", (_d, { r }) => ({
  message: "Today's allowance for this kind of call is used up.",
  hint: `It restarts at ${timeAndWait(nextDay(r.now), r.now)}.`,
}));

const noteTooLong = seatCode("NOTE_TOO_LONG", (_d, { r }) => ({
  message: `The notebook would exceed its limit of ${r.rules.gateway.notesMaxChars} chars.`,
  hint: "Shorten the text, or rewrite the whole notebook with mode=replace.",
}));

const matchEnded: Explainer = (d, { r }) => {
  const end = r.state.result?.endedAt ?? when(d, "matchEnd") ?? r.rules.time.matchEnd;
  return {
    message: `The match is over: it ended at ${fmtTime(end)}.`,
    hint: "No action is accepted any more.",
  };
};

const eliminated: Explainer = (d) => {
  const at = when(d, "eliminatedAt");
  return {
    message: `You were eliminated${at === null ? "" : ` at ${fmtTime(at)}`}: you can no longer act.`,
    hint: "Nothing you send changes the game any more.",
  };
};

const insufficientResources: Explainer = (d, { r, seat }) => {
  const cityId = str(d, "city");
  const own = cityId === null ? undefined : ownCity(r, seat, cityId);
  const needs = needsOf(d);
  const stock = own === undefined ? null : stockAt(r, own.id);
  const rate = own === undefined ? null : rates(r, own.id);
  const have = (id: ResourceId): number | null => num(d, `have_${id}`) ?? stock?.[id] ?? null;
  if (needs.length === 0) {
    return {
      message: `${cityId === null ? "Not enough resources" : `${cityId} lacks resources`}${forWhat(d)}.`,
      hint: "view_city shows the stock and the production rates.",
    };
  }
  const needText = joinAnd(needs.map((x) => `${x.need} ${x.id}`));
  // One short resource reads "has 1210" (§7.3); several name each one.
  const haveText =
    needs.length === 1
      ? String(have(needs[0]?.id ?? "wood") ?? "less")
      : joinAnd(needs.map((x) => `${have(x.id) ?? "?"} ${x.id}`));
  const message =
    cityId === null
      ? `This needs ${needText}${forWhat(d)}; you have ${haveText}.`
      : `${cityId} needs ${needText}${forWhat(d)}, has ${haveText}.`;
  let at = timeOrNever(d, "availableAt");
  if (at === undefined && own !== undefined) {
    const cost: Res = { wood: 0, stone: 0, gold: 0 };
    for (const x of needs) cost[x.id] = x.need;
    at = affordableAt(r, own.id, cost);
  }
  if (at === undefined) {
    return { message, hint: "Wait for production, or receive resources with send_resources." };
  }
  const rateOf = (id: ResourceId): number | null => num(d, `rate_${id}`) ?? rate?.[id] ?? null;
  if (at !== null) {
    const rateTexts = needs.flatMap((x) => {
      const v = rateOf(x.id);
      return v === null ? [] : [`+${v} ${x.id}/h`];
    });
    const lead = rateTexts.length === needs.length ? `At ${joinAnd(rateTexts)} it` : "It";
    return { message, hint: `${lead} is affordable at ${timeAndWait(at, r.now)}.` };
  }
  if (own !== undefined) {
    const cap = storageCap(r, own.id);
    if (needs.some((x) => x.need > cap)) {
      return {
        message,
        hint: `${own.id} stores at most ${cap} of each resource: raise ${r.rules.roles.storage} first.`,
      };
    }
    const dry = needs.find((x) => rateOf(x.id) === 0);
    if (dry !== undefined) {
      const producer = r.rules.roles.producers[dry.id];
      return {
        message,
        hint: `${own.id} produces no ${dry.id}: build ${producer}, or receive ${dry.id} with send_resources.`,
      };
    }
  }
  return { message, hint: "It is not affordable at the current production rates." };
};

/** The lowest storage level that holds `need`, or `null` when none does. */
function storageLevelFor(r: ReadCtx, need: number): number | null {
  const i = r.rules.levels.storage.findIndex((cap) => cap >= need);
  return i < 0 ? null : i;
}

const exceedsStorage: Explainer = (d, { r, seat }) => {
  const cityId = str(d, "city");
  const own = cityId === null ? undefined : ownCity(r, seat, cityId);
  const storage = r.rules.roles.storage;
  const cap = num(d, "cap") ?? (own === undefined ? null : storageCap(r, own.id));
  const level = num(d, "storageLevel") ?? (own === undefined ? null : levelOf(own, storage));
  const needs = needsOf(d);
  const where = cityId ?? "The city";
  if (needs.length === 0) {
    return {
      message: `${where} cannot store what ${whatOf(d)} costs.`,
      hint: `Raise ${storage} to store more of each resource.`,
    };
  }
  const capText =
    cap === null
      ? "too little"
      : `at most ${cap} of each resource${level === null ? "" : ` (${storage} ${level})`}`;
  const costText = joinAnd(needs.map((x) => `${x.need} ${x.id}`));
  const maxNeed = needs.reduce((m, x) => Math.max(m, x.need), 0);
  const target = num(d, "needLevel") ?? storageLevelFor(r, maxNeed);
  const holds = target === null ? undefined : r.rules.levels.storage[target];
  return {
    message: `${where} stores ${capText}, and ${whatOf(d)} costs ${costText}.`,
    hint:
      target === null || holds === undefined
        ? `No ${storage} level holds ${maxNeed}.`
        : `Raise ${storage} to level ${target} (it holds ${holds}).`,
  };
};

const insufficientPopulation: Explainer = (d, { r, seat }) => {
  const cityId = str(d, "city");
  const own = cityId === null ? undefined : ownCity(r, seat, cityId);
  const used = num(d, "used") ?? (own === undefined ? null : popUsed(r, own.id));
  const cap = num(d, "cap") ?? (own === undefined ? null : popCap(r, own.id));
  const unit = str(d, "unit");
  const count = num(d, "count") ?? num(d, "requested");
  const unitPop = unit === null ? undefined : r.rules.units.find((u) => u.id === unit)?.pop;
  const need =
    num(d, "need") ??
    num(d, "pop") ??
    (count !== null && unitPop !== undefined ? count * unitPop : null);
  const free = num(d, "free") ?? (used !== null && cap !== null ? Math.max(0, cap - used) : null);
  const what = whatOf(d);
  const state =
    free === null
      ? "not enough free population"
      : `${free} free population${used === null || cap === null ? "" : ` (${used} of ${cap} used)`}`;
  const message = `${cityId ?? "The city"} has ${state}${need === null ? "" : `; ${what} would use ${need}`}.`;
  const building = r.rules.roles.population;
  const level = own === undefined ? null : levelOf(own, building);
  const next = level === null ? undefined : r.rules.levels.population[level + 1];
  return {
    message,
    hint:
      next === undefined
        ? `Recruit fewer: every unit homed in the city counts, wherever it is.`
        : `Raise ${building} (level ${(level ?? 0) + 1} allows ${next}), or recruit fewer: every unit homed in the city counts, wherever it is.`,
  };
};

const requirementMissing: Explainer = (d, { r, seat }) => {
  const cityId = str(d, "city");
  const own = cityId === null ? undefined : ownCity(r, seat, cityId);
  const building = str(d, "building");
  const unit = str(d, "unit");
  const projected = building !== null && r.rules.queues.build.requiresOn === "projected";
  const table =
    building !== null
      ? r.rules.buildings.find((b) => b.id === building)
      : unit === null
        ? undefined
        : r.rules.units.find((u) => u.id === unit);
  const missing: { b: string; need: number; have: number }[] = [];
  if (own !== undefined && table !== undefined) {
    for (const b of r.rules.buildings) {
      const need = lookup(table.requires, b.id);
      if (need === undefined) continue;
      const queued = projected ? own.build.filter((x) => x.building === b.id).length : 0;
      const have = levelOf(own, b.id) + queued;
      if (have < need) missing.push({ b: b.id, need, have });
    }
  }
  if (missing.length === 0) {
    const req = str(d, "requires") ?? str(d, "required");
    const need = num(d, "need") ?? num(d, "level");
    const have = num(d, "have");
    if (req !== null && need !== null) missing.push({ b: req, need, have: have ?? 0 });
  }
  const target = building ?? unit ?? "This";
  if (missing.length === 0) {
    return {
      message: `${target} has a requirement that is not met${detailsText(d)}.`,
      hint: "The rules tool lists the requirements of every building and unit.",
    };
  }
  const list = missing.map((x) => `${x.b} ${x.need} (now ${x.have})`);
  const firstMissing = missing[0];
  return {
    message: `${target} needs ${joinAnd(list)}${cityId === null ? "" : ` in ${cityId}`}.`,
    hint: projected
      ? `Queue ${firstMissing?.b ?? "it"} first: queued levels count for building requirements.`
      : `Build ${firstMissing?.b ?? "it"} first: only completed levels count.`,
  };
};

const maxLevel: Explainer = (d) => {
  const building = str(d, "building") ?? "This building";
  const max = num(d, "maxLevel") ?? num(d, "max");
  const city = str(d, "city");
  return {
    message: `${building} is at its maximum level${max === null ? "" : ` ${max}`}${city === null ? "" : ` in ${city}`}, queued levels included.`,
    hint: "Build or queue something else.",
  };
};

function queueLabel(queue: string | null): string {
  if (queue === null) return "queue";
  return queue === BUILD_QUEUE ? "build queue" : `${queue} queue`;
}

const queueFull: Explainer = (d, { r, seat }) => {
  const cityId = str(d, "city");
  const queue = str(d, "queue");
  const max = num(d, "max");
  const own = cityId === null ? undefined : ownCity(r, seat, cityId);
  const message = `${cityId === null ? "The" : `${cityId}'s`} ${queueLabel(queue)} is full${max === null ? "" : ` (${max} items)`}.`;
  const etas = own === undefined ? [] : queueEtas(r, own.id);
  const head = etas.find((e) => queue === null || e.queue === queue);
  return {
    message,
    hint:
      head === undefined
        ? "Wait until an item completes, or cancel one with cancel_queue."
        : `Its first item (#${head.item}) ends at ${timeAndWait(head.end, r.now)}; queue more after that.`,
  };
};

const queueItem: Explainer = (d, { r, seat, gw }) => {
  const cityId = str(d, "city");
  const item = num(d, "item");
  const hint = "cancel_queue {city, item} removes a queued item and every later item of its queue.";
  if (cityId === null || item === null) {
    return { message: "That queue item does not exist.", hint };
  }
  const own = ownCity(r, seat, cityId);
  const queued =
    own === undefined
      ? null
      : queueEtas(r, own.id)
          .map((e) => e.item)
          .toSorted((a, b) => a - b)
          .map((n) => `#${n}`);
  const done = seatOf(gw, seat).archive.findLast(
    ({ event: ev }) =>
      (ev.type === "build_done" || ev.type === "recruit_done") &&
      ev.data["city"] === cityId &&
      ev.data["item"] === item,
  );
  if (done !== undefined) {
    const now =
      queued === null
        ? ""
        : queued.length === 0
          ? `; nothing is queued in ${cityId}`
          : `; queued in ${cityId}: ${queued.join(", ")}`;
    return {
      message: `#${item} of ${cityId} completed at ${fmtTime(done.event.t)}.`,
      hint: `A completed item cannot be cancelled${now}.`,
    };
  }
  const now =
    queued === null
      ? ""
      : queued.length === 0
        ? "; nothing is queued"
        : `; queued: ${queued.join(", ")}`;
  return { message: `${cityId} has no item #${item}${now}.`, hint };
};

const batchLimit: Explainer = (d) => {
  const unit = str(d, "unit") ?? "units";
  const max = num(d, "max");
  const count = num(d, "count") ?? num(d, "requested");
  const orders = `a recruit call takes up to ${RECRUIT_MAX_ORDERS} orders`;
  if (max === null) {
    return {
      message: `Too many ${unit} in one order.`,
      hint: `Split it into smaller orders (${orders}).`,
    };
  }
  return {
    message: `At most ${max} ${unit} per order${count === null ? "" : `, and ${count} were ordered`}.`,
    hint: `Split it into orders of ${max} or fewer (${orders}).`,
  };
};

const insufficientUnits: Explainer = (d, { r, seat }) => {
  const cityId = str(d, "city");
  const unit = str(d, "unit");
  const requested = num(d, "requested");
  const home = num(d, "home");
  if (unit !== null && requested !== null && home !== null) {
    const back = timeOrNever(d, "backAt");
    return {
      message: `${cityId === null ? "" : `${cityId}: `}${requested} ${unit} requested, ${home} at home.`,
      hint:
        typeof back === "number"
          ? `More ${unit} units come home at ${timeAndWait(back, r.now)}; until then, send at most ${home}.`
          : `Send at most ${home}, or recruit more.`,
    };
  }
  const own = cityId === null ? undefined : ownCity(r, seat, cityId);
  return {
    message: `${cityId ?? "The city"} does not have these units at home.`,
    hint:
      own === undefined
        ? "view_city lists the units at home."
        : `${own.id} has ${unitsText(orderedUnits(r.rules.units, unitsAtHome(r, own.id)))} at home.`,
  };
};

const noUnits: Explainer = (d) => {
  const kind = str(d, "kind");
  const crossing = lookup(d, "crossing") === true;
  if (kind === "attack") {
    return {
      message: `This attack has no unit that can fight${crossing ? " across water" : ""}.`,
      hint: "Send a land unit with attack above 0 or, across water, a naval unit with naval strength above 0.",
    };
  }
  return {
    message: `No units were given${kind === null ? "" : ` for this ${kind}`}.`,
    hint: "List at least one unit you have at home.",
  };
};

const transportCapacity: Explainer = (d, { r }) => {
  const need = num(d, "need") ?? num(d, "required");
  const have = num(d, "capacity") ?? num(d, "have") ?? num(d, "available");
  const carriers = r.rules.units
    .filter((u) => u.capacity > 0)
    .map((u) => `${u.id}, ${u.capacity} each`);
  return {
    message:
      need === null || have === null
        ? "The land units in this group cannot all be carried across water."
        : `The land units need ${need} carrier capacity to cross water; the group carries ${have}.`,
    hint:
      carriers.length === 0
        ? "Send fewer land units across water."
        : `Add carriers (${carriers.join("; ")}) or send fewer land units.`,
  };
};

const shipmentCapacity: Explainer = (d, { r }) => {
  const city = str(d, "city") ?? "The city";
  const cap = num(d, "cap");
  const inFlight = num(d, "inFlight");
  const requested = num(d, "requested");
  const rule = r.rules.movement.shipment;
  const raise = rule === null ? "" : `, or raise ${rule.building} (+${rule.perLevel} per level)`;
  if (cap === null || inFlight === null) {
    return {
      message: `${city} cannot have that much cargo in flight.`,
      hint: `Send less${raise}; cargo counts until it arrives.`,
    };
  }
  return {
    message: `${city} can have ${cap} resources in flight; ${inFlight} already are${requested === null ? "" : `, and ${requested} were requested`}.`,
    hint: `Send at most ${Math.max(0, cap - inFlight)} now${raise}; cargo counts until it arrives.`,
  };
};

const attackProtection: Explainer = (d, { r }) => {
  const at = when(d, "availableAt") ?? r.rules.time.attackFrom;
  return {
    message: `No attack can be launched before ${fmtTime(at)}.`,
    hint: `Attacks open at ${timeAndWait(at, r.now)}.`,
  };
};

const invalidTarget: Explainer = (d) => {
  const kind = str(d, "kind");
  const player = str(d, "player");
  if (player !== null && str(d, "city") === null) {
    return {
      message: `${player} cannot receive this proposal.`,
      hint: "Propose to another player who is still in the game; a pact cannot be proposed to an ally.",
    };
  }
  const target = str(d, "city") ?? str(d, "island") ?? "This";
  const what = kind === null ? "target" : `${kind} target`;
  const hint =
    kind === "attack" || kind === "spy"
      ? "Attacks and spies go to a city you do not own."
      : kind === "support" || kind === "shipment"
        ? "Supports and shipments go to a city owned by a player, other than the city they leave."
        : kind === "found"
          ? "Found a city on an island listed by view_map."
          : "Check the target against view_map.";
  return { message: `${target} is not a valid ${what}.`, hint };
};

const noFreeSlot: Explainer = (d) => ({
  message: `${str(d, "island") ?? "This island"} has no free slot.`,
  hint: "view_map gives the number of free slots of every island.",
});

const settlerRequired: Explainer = (d, { r }) => {
  const unit = str(d, "unit") ?? r.rules.roles.settler;
  return {
    message: `Founding a city needs at least one ${unit} in the group.`,
    hint: `Add a ${unit}; recruit one first if you have none.`,
  };
};

const spyGold: Explainer = (d, { r }) => {
  const min = num(d, "min") ?? r.rules.movement.spyMinGold;
  const gold = num(d, "gold");
  return {
    message: `A spy needs at least ${min} gold${gold === null ? "" : `; ${gold} given`}.`,
    hint: `Send ${min} gold or more.`,
  };
};

const notRecallable: Explainer = (d, { r, seat }) => {
  const id = str(d, "movement");
  const recall = r.rules.movement.recall;
  const own = id === null ? undefined : lookup(r.state.movements, id);
  const until =
    when(d, "until") ??
    (own !== undefined && own.owner === seat && own.kind !== "return"
      ? own.departAt + recall.window
      : null);
  const closed =
    until !== null && until < r.now ? `: its recall window closed at ${fmtTime(until)}` : "";
  return {
    message: `${id ?? "This movement"} cannot be recalled${closed}.`,
    hint:
      recall.kinds.length === 0
        ? "Movements cannot be recalled in this ruleset."
        : `Only ${joinAnd(recall.kinds)} movements can be recalled, within ${fmtDuration(recall.window)} of departure.`,
  };
};

const nothingStationed: Explainer = (d) => {
  const city = str(d, "city") ?? "this city";
  const home = str(d, "home");
  return {
    message: `You have no units stationed in ${city}${home === null ? "" : ` from ${home}`}.`,
    hint: "view_player on yourself lists your stationed groups.",
  };
};

const ambiguousGroup: Explainer = (d, { r, seat }) => {
  const cityId = str(d, "city") ?? "this city";
  const city = lookup(r.state.cities, cityId);
  const groups = (city?.stationed ?? []).filter((g) => g.owner === seat);
  if (groups.length < 2) {
    return {
      message: `You have several groups in ${cityId}.`,
      hint: "Add home to say which group, or leave out units to recall them all.",
    };
  }
  const list = groups.map(
    (g) => `from ${g.home} (${unitsText(orderedUnits(r.rules.units, g.units))})`,
  );
  const homes = groups.map((g) => g.home);
  return {
    message: `You have ${groups.length} groups in ${cityId}: ${joinAnd(list)}.`,
    hint: `Add home (${joinOr(homes)}) to recall part of one group, or leave out units to recall them all.`,
  };
};

const textTooLong: Explainer = (d) => {
  const max = num(d, "max");
  const length = num(d, "length");
  if (max === null || length === null) {
    return { message: "The text is too long.", hint: "Shorten it." };
  }
  return {
    message: `The text has ${length} characters; the limit is ${max}.`,
    hint: `Shorten it by ${Math.max(0, length - max)} characters.`,
  };
};

const proposalLimit: Explainer = (d, { r }) => {
  const to = str(d, "to");
  const kind = str(d, "kind");
  if (to !== null && kind !== null) {
    return {
      message: `You already have an open ${kind} proposal to ${to}.`,
      hint: "Wait for its answer or its expiry before proposing again.",
    };
  }
  const max = num(d, "max") ?? r.rules.diplomacy.maxOpenProposals;
  const open = num(d, "open") ?? max;
  return {
    message: `You already have ${open} open proposals; the limit is ${max}.`,
    hint: `Wait until one is answered or expires (proposals last ${fmtDuration(r.rules.diplomacy.proposalTtl)}).`,
  };
};

const proposalNotFound: Explainer = (d) => {
  const id = str(d, "proposal");
  return {
    message: `No open proposal${id === null ? "" : ` ${id}`} is addressed to you.`,
    hint: "It may have been answered or have expired; your briefing lists your open proposals.",
  };
};

const alreadyAllied: Explainer = (d, { r, seat }) => {
  const player = str(d, "player");
  const other = player === null ? undefined : lookup(r.state.players, player);
  if (other !== undefined && relation(r, seat, other.id) === "ally") {
    return {
      message: `You and ${other.id} are already allies.`,
      hint: "Allies already share vision; a pact cannot be proposed to an ally.",
    };
  }
  const ownAlliance = lookup(r.state.players, seat)?.alliance ?? null;
  if (other !== undefined && ownAlliance !== null && other.alliance !== null) {
    return {
      message: `You and ${other.id} are both in alliances (${ownAlliance} and ${other.alliance}).`,
      hint: "One of you must leave_alliance before you can ally.",
    };
  }
  return {
    message: `This alliance cannot be formed${detailsText(d)}.`,
    hint: "A player in an alliance must leave_alliance before joining another; a pact cannot be proposed to an ally.",
  };
};

const allianceFull: Explainer = (d, { r }) => {
  const max = num(d, "max") ?? r.rules.diplomacy.allianceMax;
  return {
    message: `${str(d, "alliance") ?? "The alliance"} is full: ${max} members at most.`,
    hint: "A member must leave before anyone else can join.",
  };
};

const notInAlliance: Explainer = () => ({
  message: "You are not in an alliance.",
  hint: "To end a pact, name the partner: leave_alliance {with: player}.",
});

const pactLimit: Explainer = (d, { r }) => {
  const max = num(d, "max") ?? r.rules.diplomacy.maxPacts;
  const player = str(d, "player");
  return {
    message: `${player === null ? "You already hold" : `${player} already holds`} ${max} pacts, the limit.`,
    hint: "A pact must end or expire first; renewing an existing pact does not count.",
  };
};

const pactNotFound: Explainer = (d) => {
  const player = str(d, "player");
  return {
    message: player === null ? "There is no such pact." : `You have no pact with ${player}.`,
    hint: "leaderboard lists every pact.",
  };
};

const internal: Explainer = () => ({
  message: "The gateway failed on this call; nothing was applied.",
  hint: "Send the call again; if it fails again, do something else.",
});

const wakeClamped: Explainer = (d, { r }) => {
  const range = r.rules.gateway.selfWake;
  const requested = when(d, "requested");
  const at = when(d, "at") ?? when(d, "wakeAt");
  const span = `A self-wake is ${fmtDuration(range.min)} to ${fmtDuration(range.max)} ahead of the end_turn call.`;
  if (requested === null || at === null) {
    return { message: "The requested wake time was moved into the self-wake range.", hint: span };
  }
  return {
    message: `The wake at ${fmtTime(requested)} is outside the self-wake range; it is set to ${fmtTime(at)}.`,
    hint: span,
  };
};

type GatewayWarningCode = (typeof GATEWAY_WARNING_CODES)[number];
type DomainCode = (typeof DOMAIN_ERROR_CODES)[number];

/** The explainer of every domain code and gateway warning. */
const EXPLAINERS = {
  INVALID_ARGS: invalidArgs,
  UNKNOWN_ID: unknownId,
  NOT_OWNER: notOwner,
  TURN_OVER: turnOver,
  ROUND_TRIP_CAP: roundTripCap,
  CALLS_CAP: callsCap,
  DAILY_CAP: dailyCap,
  MATCH_ENDED: matchEnded,
  ELIMINATED: eliminated,
  NOTE_TOO_LONG: noteTooLong,
  INSUFFICIENT_RESOURCES: insufficientResources,
  EXCEEDS_STORAGE: exceedsStorage,
  INSUFFICIENT_POPULATION: insufficientPopulation,
  REQUIREMENT_MISSING: requirementMissing,
  MAX_LEVEL: maxLevel,
  QUEUE_FULL: queueFull,
  QUEUE_ITEM: queueItem,
  BATCH_LIMIT: batchLimit,
  INSUFFICIENT_UNITS: insufficientUnits,
  NO_UNITS: noUnits,
  TRANSPORT_CAPACITY: transportCapacity,
  SHIPMENT_CAPACITY: shipmentCapacity,
  ATTACK_PROTECTION: attackProtection,
  INVALID_TARGET: invalidTarget,
  NO_FREE_SLOT: noFreeSlot,
  SETTLER_REQUIRED: settlerRequired,
  SPY_GOLD: spyGold,
  NOT_RECALLABLE: notRecallable,
  NOTHING_STATIONED: nothingStationed,
  AMBIGUOUS_GROUP: ambiguousGroup,
  TEXT_TOO_LONG: textTooLong,
  PROPOSAL_LIMIT: proposalLimit,
  PROPOSAL_NOT_FOUND: proposalNotFound,
  ALREADY_ALLIED: alreadyAllied,
  ALLIANCE_FULL: allianceFull,
  NOT_IN_ALLIANCE: notInAlliance,
  PACT_LIMIT: pactLimit,
  PACT_NOT_FOUND: pactNotFound,
  INTERNAL: internal,
  WAKE_CLAMPED: wakeClamped,
} as const satisfies Readonly<Record<DomainCode | GatewayWarningCode, Explainer>>;

/** The codes this module words itself: every domain code and every gateway warning. */
export const EXPLAINED_CODES: readonly string[] = Object.keys(EXPLAINERS);

/**
 * `{message, hint}` for a violation or warning: a domain code or gateway warning by this module, a
 * ruleset code by `ruleset.errors[code]`, any other code by a generic text listing its details.
 */
export function explain(v: DeepReadonly<Violation>, env: ExplainEnv): Explanation {
  const own = lookup<Explainer>(EXPLAINERS, v.code);
  if (own !== undefined) return own(v.details, env);
  const ruleset = lookup(env.r.ruleset.errors, v.code);
  if (ruleset !== undefined) {
    const text = ruleset({ code: v.code, details: { ...v.details } }, fmt);
    return { message: text.message, hint: text.hint };
  }
  return {
    message: `${v.code}${detailsText(v.details)}.`,
    hint: "The rules tool explains the rules behind this code.",
  };
}

/** The `ToolError` of a rejected call at the current game time, with its details. */
export function toolError(v: DeepReadonly<Violation>, env: ExplainEnv): ToolError {
  const { message, hint } = explain(v, env);
  return { ok: false, t: env.r.now, code: v.code, message, hint, details: { ...v.details } };
}

/** A warning on an accepted call: the explanation's message and hint in one sentence pair. */
export function toolWarning(v: DeepReadonly<Violation>, env: ExplainEnv): ToolWarning {
  const { message, hint } = explain(v, env);
  return { code: v.code, message: `${message} ${hint}` };
}
