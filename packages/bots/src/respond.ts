// The responder side of the war-call protocol (docs/architecture.md §11.2, `war.ts`), opt-in per
// strategy: opportunist@3 and turtle@3 call it, no published version does. A seat that hears its
// allies' calls answers each one, yes or no, so that the caller can plan, and keeps its word.
//
// - Answering: every open call of an ally is judged (`judgeCall`) on what the seat would really
//   send: a share of the units fit for the role at home in each own city (attackers, with warships
//   across water, for a strike; defenders otherwise), timed at its slowest ship's pace, landing in
//   the window; a `siege` call's defenders leave once the siege has ended (only the besieger may
//   support a besieged city, perfidia-1 §7.3, §9.2). The best call of each kind (one strike, one
//   defense) is answered yes with the planned landing, the others no (so is a strike while one it
//   promised earlier has not left: its attackers are held for it); a role the strategy does not
//   play is declined with its reason; a call more than a day ahead waits; a caller the strategy
//   keeps silent towards (a betrayal in the making) gets no answer, and its call stays open.
// - Keeping its word: a yes is a planned launch with a firm self-wake at it. At the launch the call
//   is judged again on the world as it is (a strike's target besieged meanwhile, an attack on its
//   way to the seat, a force too small, a call cancelled or a caller no longer allied: no launch, and
//   a late no when messages are plentiful), and every own city whose group lands inside the window
//   leaving now goes. A strike still in its recall window whose call is cancelled is called back.
// - Holding conquests: an ally's siege seen on the map (or a conquest in the news) is remembered
//   with its end (`gw<city>`), and once the ally owns the city the seat sends it defenders (one
//   support from the nearest own city that has them; `supportAllies` calls them home later).
// - Answers to one caller ride in one message and keep messages in hand (`mayMessage`).

import {
  compareIds,
  type CityId,
  type CityRow,
  type IslandId,
  type Json,
  type PlayerId,
  type UnitCounts,
} from "@perfidia/protocol";
import { countOf, dayOf, fmtTime, groupTravel, power } from "./kit.ts";
import { ownWakesBefore, type Planner } from "./plan.ts";
import { besiegedExt } from "./relief.ts";
import {
  absorbWar,
  composeAck,
  distrustOf,
  hearWar,
  joinWar,
  judgeCall,
  launchTime,
  mayMessage,
  pickCall,
  readBook,
  threatened,
  warTarget,
  writeBook,
  type Launch,
  type WarCall,
  type WarCandidate,
  type WarEntry,
  type WarRole,
  type WarTarget,
  type WarVerdict,
  type WarWhy,
} from "./war.ts";
import type { OwnCity, World } from "./world.ts";

export interface ResponderParams {
  /** The roles it answers yes to; a call of another role is declined with `decline`. */
  readonly roles: readonly WarRole[];
  readonly decline: string;
  /** Share (‰) of each own city's units fit for the role that a strike, or a defense, sends. */
  readonly strikePm: number;
  readonly holdPm: number;
  /** The least land attack a strike, and land defense a defense, is worth sending. */
  readonly minStrike: number;
  readonly minHold: number;
  /** Where in the window it aims (‰ of the window from its start). */
  readonly aimPm: number;
  /** Own cities that send a group for one call at most. */
  readonly waves: number;
}

/** A defense lands this long after the siege it holds has ended (a conquest resolves at its end). */
const AFTER_SIEGE = 120;
/** An ally's conquest is held when the seat sees it within this long of the siege's end. */
const HOLD_WITHIN = 6 * 3600;
/** A call that cannot leave yet while its target is still besieged is weighed again this much later. */
const RETRY = 1800;
/** Defenders below which a city does not hold an ally's conquest. */
const MIN_HOLDERS = 5;

const clampPm = (v: number): number => Math.max(0, Math.min(1000, v));
const isPlayerId = (v: unknown): v is PlayerId => typeof v === "string" && /^p[1-9][0-9]*$/.test(v);
const isCityId = (v: unknown): v is CityId => typeof v === "string" && /^c[1-9][0-9]*$/.test(v);
const isStrike = (role: WarRole): boolean => role === "strike";

/** The value at `path` in a JSON value, or undefined. */
function at(v: Json | undefined, path: readonly string[]): Json | undefined {
  let cur = v;
  for (const key of path) {
    if (cur === undefined || cur === null || typeof cur !== "object" || Array.isArray(cur)) {
      return undefined;
    }
    if (!Object.hasOwn(cur, key)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** A game time given as a number or a `[time, text]` pair, or null. */
function timeOf(v: Json | undefined): number | null {
  const t = Array.isArray(v) ? v[0] : v;
  return typeof t === "number" && Number.isSafeInteger(t) ? t : null;
}

function rowOf(w: World, city: CityId): CityRow | undefined {
  return w.map?.cities.find((c) => c.id === city);
}

/** When the siege of a map row ends (its public extras, through the hints), or null. */
export function siegeEndOf(w: World, row: CityRow): number | null {
  const path = w.hints.siege?.ends;
  return path === undefined ? null : timeOf(at(row.ext, path));
}

/** The besieger of a map row (its public extras, through the hints), or null. */
function besiegerOf(w: World, row: CityRow): PlayerId | null {
  const path = w.hints.siege?.by;
  const by = path === undefined ? undefined : at(row.ext, path);
  return isPlayerId(by) ? by : null;
}

// What the seat would send.

/** One own city's group for a call: what leaves, its force for the role and its timing. */
export interface WarGroup {
  readonly city: OwnCity;
  readonly units: UnitCounts;
  readonly force: number;
  readonly travel: number;
  readonly launch: Launch;
}

/**
 * What `c` sends to `island` for a call of `role`: `sharePm` of its land units at home fit for the
 * role (more attack than defense for a strike, otherwise the others; founders never), strongest
 * first within what its carriers lift, with the carriers, and its share of warships for a strike
 * across water; null when nothing fit for the role would go.
 */
export function groupFor(
  p: Planner,
  c: OwnCity,
  island: IslandId,
  role: WarRole,
  sharePm: number,
): UnitCounts | null {
  const kit = p.w.kit;
  const strike = isStrike(role);
  const stat = strike ? "attack" : "defense";
  const home = p.homeOf(c.id);
  const rows = kit.rules.units
    .filter((r) => r.domain === "land" && r.id !== kit.roles.founder && r[stat] > 0)
    .filter((r) => (strike ? r.attack > r.defense : r.defense >= r.attack))
    .toSorted((a, b) => b[stat] - a[stat]);
  let lift = p.liftCapacity(c, island);
  const land: Record<string, number> = {};
  for (const r of rows) {
    const pop = Math.max(1, r.pop);
    const n = Math.min(
      Math.floor((countOf(home, r.id) * clampPm(sharePm)) / 1000),
      Math.floor(lift / pop),
    );
    if (n <= 0) continue;
    land[r.id] = n;
    lift -= n * pop;
  }
  if (power(kit, land, stat, true) <= 0) return null;
  const units = p.withCarriers(c, island, land);
  if (units === null) return null;
  const navy = kit.roles.navy;
  if (strike && navy !== null && c.island !== island && navy !== kit.roles.carrier) {
    const n = Math.floor((countOf(home, navy) * clampPm(sharePm)) / 1000);
    if (n > 0) units[navy] = (units[navy] ?? 0) + n;
  }
  return units;
}

/**
 * The earliest a group may leave for a call: a strike not before the attack gate; a `siege` call's
 * defense once the siege it holds has ended (null: no bound).
 */
function earliestFor(w: World, call: WarCall, target: WarTarget | null): number | null {
  if (isStrike(call.role)) return w.kit.rules.time.attackFrom;
  if (call.role !== "siege" || target === null || !target.besieged) return null;
  const row = rowOf(w, target.id);
  const ends = row === undefined ? null : siegeEndOf(w, row);
  return ends === null ? null : ends + AFTER_SIEGE;
}

/** Each own city's group for a call that lands in its window, most force first. */
export function groupsFor(
  p: Planner,
  call: WarCall,
  target: WarTarget,
  prm: ResponderParams,
): WarGroup[] {
  const { w } = p;
  const strike = isStrike(call.role);
  const earliest = earliestFor(w, call, target);
  const out: WarGroup[] = [];
  for (const c of w.cities) {
    if (c.blocked || c.id === target.id) continue;
    const units = groupFor(p, c, target.island, call.role, strike ? prm.strikePm : prm.holdPm);
    const row = w.travelRow(c.id, target.island);
    if (units === null || row === null) continue;
    const travel = groupTravel(w.kit, row, units);
    if (travel === null) continue;
    const launch = launchTime(call, travel, w.t, {
      minDelay: w.kit.gateway.selfWake.min,
      aimPm: prm.aimPm,
      ...(earliest === null ? {} : { earliest }),
    });
    if (launch === null) continue;
    const force = power(w.kit, units, strike ? "attack" : "defense", true);
    out.push({ city: c, units, force, travel, launch });
  }
  return out.toSorted((a, b) => b.force - a.force || compareIds(a.city.id, b.city.id));
}

/** The groups that leave together with the strongest one (at its launch), `waves` at most. */
function wave(groups: readonly WarGroup[], waves: number): WarGroup[] {
  const first = groups[0];
  if (first === undefined) return [];
  return groups.filter((g) => g.launch.at === first.launch.at).slice(0, Math.max(1, waves));
}

export interface Judged {
  readonly verdict: WarVerdict;
  readonly target: WarTarget | null;
  readonly groups: WarGroup[];
}

/** `judgeCall` on what the seat would send (`groupsFor`), from the world as it is. */
export function judgeOwn(
  p: Planner,
  from: PlayerId,
  call: WarCall,
  prm: ResponderParams,
  distrust: ReadonlySet<PlayerId>,
): Judged {
  const { w } = p;
  const target = warTarget(w, call.target);
  const groups = target === null ? [] : groupsFor(p, call, target, prm);
  const going = wave(groups, prm.waves);
  const strike = isStrike(call.role);
  // No group at all, whatever the timing: the force is what fails, not the reach.
  const none =
    going.length === 0 &&
    target !== null &&
    !w.cities.some(
      (c) =>
        !c.blocked &&
        c.id !== target.id &&
        groupFor(p, c, target.island, call.role, strike ? prm.strikePm : prm.holdPm) !== null,
    );
  const verdict = judgeCall({
    seat: w.seat,
    now: w.t,
    from,
    call,
    relations: w.relations,
    target,
    distrust,
    launch: none ? { at: w.t, lands: call.t0 } : (going[0]?.launch ?? null),
    force: going.reduce((a, g) => a + g.force, 0),
    minForce: strike ? prm.minStrike : prm.minHold,
    attacksLeft: p.attacksLeft,
    threatened: threatened(w),
  });
  return { verdict, target, groups };
}

// The desk: the book of calls for one turn, and the answers to send.

export interface WarDesk {
  book: WarEntry[];
  /** War texts to send this turn, by recipient: its yes answers, and its other answers. */
  readonly out: Map<PlayerId, { yes: string[]; no: string[] }>;
  /** Players the seat does not trust this turn (`distrustOf`, plus the strategy's own). */
  readonly distrust: ReadonlySet<PlayerId>;
}

const keyOf = (e: WarEntry): string => `${e.from}/${e.call.id}`;

function replace(desk: WarDesk, e: WarEntry, patch: Partial<WarEntry>): WarEntry {
  const next: WarEntry = { ...e, ...patch };
  desk.book = desk.book.map((x) => (keyOf(x) === keyOf(e) ? next : x));
  return next;
}

function say(desk: WarDesk, to: PlayerId, text: string, yes: boolean): void {
  const box = desk.out.get(to) ?? { yes: [], no: [] };
  (yes ? box.yes : box.no).push(text);
  desk.out.set(to, box);
}

/**
 * The turn's book: the notes' entries with the briefing's war messages taken in (`hearWar`,
 * `absorbWar`). A strike of the seat still in its recall window whose call was just cancelled is
 * called back.
 */
export function openDesk(p: Planner, distrust: ReadonlySet<PlayerId> = new Set()): WarDesk {
  const { w } = p;
  const before = readBook(p.memory);
  const { heard } = hearWar(w.briefing.msgs, w.seat, w.relations);
  const book = absorbWar(before, heard, w.seat);
  const all = distrustOf(w);
  for (const q of distrust) all.add(q);
  const desk: WarDesk = { book, out: new Map(), distrust: all };
  for (const e of book) {
    if (e.from === w.seat || e.state !== "cancelled" || !isStrike(e.call.role)) continue;
    const was = before.find((b) => keyOf(b) === keyOf(e));
    if (was?.state === "sent") recallStrikes(p, e.call.target);
  }
  return desk;
}

/** Calls back the seat's attacks on their way to `city` that are still in their recall window. */
function recallStrikes(p: Planner, city: CityId): void {
  const { w } = p;
  for (const m of w.self?.private?.movements ?? []) {
    if (m.owner !== w.seat || m.kind !== "attack" || m.to !== city) continue;
    if ((m.recallableUntil?.[0] ?? 0) <= w.t || (m.turnedBack ?? null) !== null) continue;
    p.recall(m.id);
    p.memo(`war ${city} called back ${fmtTime(w.t)}`);
  }
}

/** The reason a decline gives, as a war message carries it. */
const WHY_TEXT: Readonly<Record<WarWhy, string>> = Object.freeze({
  "not allied": "not allied",
  distrust: "no trust",
  "own city": "my city",
  "ally city": "an ally's city",
  "pact city": "we have a pact",
  neutral: "neutral city",
  "unknown city": "unknown city",
  besieged: "under siege",
  "not theirs": "not your city",
  "too early": "too early",
  "too late": "too far",
  "under attack": "under attack",
  "too weak": "too weak",
  "no launches": "no attacks left",
});

export interface AnswerOptions {
  /** Callers it keeps silent towards this turn: their calls stay open, unanswered. */
  readonly silent?: ReadonlySet<PlayerId>;
  /** The seat's own enemies: a call against one of them comes first (`pickCall`). */
  readonly prefer?: ReadonlySet<PlayerId>;
}

/**
 * Judges the allies' open calls and answers them: the best strike and the best defense the seat
 * can serve yes (with a planned launch), the others no; a role it does not play declined; a call
 * too far ahead, or from a caller it keeps silent towards, left open.
 */
export function answerCalls(
  p: Planner,
  desk: WarDesk,
  prm: ResponderParams,
  o: AnswerOptions = {},
): void {
  const { w } = p;
  const accepted: { e: WarEntry; c: WarCandidate }[] = [];
  for (const e of desk.book) {
    if (e.from === w.seat || e.state !== "open") continue;
    if (o.silent?.has(e.from) === true) continue;
    if (w.relations.get(e.from) !== "ally") {
      replace(desk, e, { state: "no" });
      continue;
    }
    if (!prm.roles.includes(e.call.role)) {
      replace(desk, e, { state: "no" });
      say(desk, e.from, composeAck(e.call.id, false, null, prm.decline), false);
      continue;
    }
    const j = judgeOwn(p, e.from, e.call, prm, desk.distrust);
    if (!j.verdict.accept) {
      if (j.verdict.why === "too early") continue;
      replace(desk, e, { state: "no" });
      say(desk, e.from, composeAck(e.call.id, false, null, WHY_TEXT[j.verdict.why]), false);
      continue;
    }
    const launch = wave(j.groups, prm.waves)[0]?.launch;
    if (launch === undefined) continue;
    if (!canWakeAt(p, launch.at)) {
      replace(desk, e, { state: "no" });
      say(desk, e.from, composeAck(e.call.id, false, null, "no wake left today"), false);
      continue;
    }
    accepted.push({ e, c: { from: e.from, call: e.call, launch } });
  }
  const ownerOf = (c: CityId): PlayerId | null => rowOf(w, c)?.owner ?? null;
  const chosen = new Set<string>();
  // A strike promised earlier holds the attackers: a new one is busy until it has left.
  const holding = strikePending(desk, w.seat);
  for (const strike of [true, false]) {
    if (strike && holding) continue;
    const cands = accepted.filter((a) => isStrike(a.e.call.role) === strike).map((a) => a.c);
    const best = pickCall(cands, o.prefer ?? new Set(), ownerOf);
    if (best !== null) chosen.add(`${best.from}/${best.call.id}`);
  }
  for (const { e, c } of accepted) {
    if (chosen.has(keyOf(e))) {
      replace(desk, e, { state: "yes", at: c.launch.at });
      say(desk, e.from, composeAck(e.call.id, true, c.launch.lands), true);
      p.wakeAt(c.launch.at);
    } else {
      replace(desk, e, { state: "no" });
      say(desk, e.from, composeAck(e.call.id, false, null, "busy"), false);
    }
  }
}

/**
 * True when the seat can count on an own wake at `t` (a launch it plans): now, a later game day
 * (a fresh budget), or today with an own wake left for it and one to spare after those its queues
 * and reports will take before it (`ownWakesBefore`). Otherwise the self-wake would move to the
 * next day (perfidia-1 §14.2) and the launch would be missed.
 */
export function canWakeAt(p: Planner, t: number): boolean {
  const { w } = p;
  if (t <= w.t || dayOf(t) > w.day) return true;
  return w.briefing.budget.ownWakesLeft - ownWakesBefore(p, t) >= 2;
}

/** True while a strike the seat said yes to has not left yet. */
export function strikePending(desk: WarDesk, seat: PlayerId): boolean {
  return desk.book.some((e) => e.from !== seat && e.state === "yes" && isStrike(e.call.role));
}

/**
 * Keeps the seat's word: each call it said yes to is judged again; when its strongest group's best
 * launch is now, every group that lands inside the window leaving now goes (`waves` at most);
 * otherwise the launch waits for its firm self-wake. A call it can no longer serve gets a late no
 * (when messages are plentiful) and nothing leaves.
 */
export function keepWord(p: Planner, desk: WarDesk, prm: ResponderParams): void {
  const { w } = p;
  for (const e of desk.book) {
    if (e.from === w.seat || e.state !== "yes") continue;
    if (w.relations.get(e.from) !== "ally" || w.t > e.call.t1) {
      replace(desk, e, { state: "no" });
      continue;
    }
    const j = judgeOwn(p, e.from, e.call, prm, desk.distrust);
    if (!j.verdict.accept) {
      replace(desk, e, { state: "no" });
      if (j.verdict.why !== "not allied") {
        say(desk, e.from, composeAck(e.call.id, false, null, WHY_TEXT[j.verdict.why]), false);
      }
      continue;
    }
    const best = j.groups[0];
    if (best === undefined) continue;
    const besieged = j.target?.besieged === true;
    if (best.launch.at > w.t || (besieged && !isStrike(e.call.role))) {
      const next = best.launch.at > w.t ? best.launch.at : w.t + RETRY;
      replace(desk, e, { at: next });
      p.wakeAt(next);
      continue;
    }
    const going = j.groups
      .filter((g) => w.t + g.travel >= e.call.t0 && w.t + g.travel <= e.call.t1)
      .slice(0, Math.max(1, prm.waves));
    let lands: number | null = null;
    for (const g of going) {
      if (isStrike(e.call.role)) {
        if (!p.attack(g.city, e.call.target, g.units)) continue;
      } else {
        p.support(g.city, e.call.target, g.units);
      }
      lands = lands === null ? w.t + g.travel : Math.min(lands, w.t + g.travel);
    }
    if (lands === null) {
      replace(desk, e, { state: "no" });
      continue;
    }
    replace(desk, e, { state: "sent", at: lands });
    p.memo(`war ${e.call.role} ${e.call.target} for ${e.from} lands ${fmtTime(lands)}`);
  }
}

/**
 * Sends the turn's answers, one message per recipient (yes first, within the war message length),
 * when messages in hand allow: a message with a yes while more than `WAR_RESERVE.yes` are left, a
 * message of noes only while more than `WAR_RESERVE.no` are.
 */
export function sendAnswers(p: Planner, desk: WarDesk): void {
  for (const to of [...desk.out.keys()].toSorted(compareIds)) {
    const box = desk.out.get(to);
    if (box === undefined) continue;
    const yes = box.yes.length > 0;
    if (!mayMessage(yes ? "yes" : "no", p.messagesLeft)) continue;
    const text = joinWar([...box.yes, ...box.no]);
    if (text !== "") p.message([to], text);
  }
  desk.out.clear();
}

/** Writes the book back into the notes (after every other memo line of the turn). */
export function closeDesk(p: Planner, desk: WarDesk): void {
  p.memory = writeBook(p.memory, desk.book, p.w.t);
}

/**
 * Holds an ally's conquests: its sieges on the map are remembered with their end (`gw<city>`), a
 * conquest of its in the news from now; once the ally owns the city, not besieged, within
 * `HOLD_WITHIN` of that end, the nearest own city with defenders sends `sharePm` of them (lifted
 * by its carriers), unless the seat already answered a call for that city. A firm self-wake waits
 * for each remembered end.
 */
export function holdConquests(p: Planner, desk: WarDesk, sharePm: number): void {
  const { w } = p;
  const kit = w.kit;
  const defender = kit.roles.defender;
  for (const row of w.map?.cities ?? []) {
    if (!besiegedExt(w, row.ext)) continue;
    const by = besiegerOf(w, row);
    const ends = siegeEndOf(w, row);
    if (by === null || w.relations.get(by) !== "ally" || ends === null || ends <= w.t) continue;
    if (!/^c[1-9][0-9]*$/.test(row.id) || p.flag(`gw${row.id}`) === ends) continue;
    if (!w.cities.some((c) => w.travel(c.id, row.island, false) !== null)) continue;
    p.setFlag(`gw${row.id}`, ends);
  }
  for (const e of [...w.briefing.news, ...w.briefing.events]) {
    if (e.type !== "city_conquered") continue;
    const city = e["city"];
    const to = e["to"];
    if (!isCityId(city) || !isPlayerId(to)) continue;
    if (w.relations.get(to) !== "ally" || p.flag(`gw${city}`) !== null) continue;
    p.setFlag(`gw${city}`, w.t);
  }
  for (const [name, ends] of Object.entries(p.memory.x).toSorted((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    const city = name.slice(2);
    if (!name.startsWith("gw") || !isCityId(city)) continue;
    const row = rowOf(w, city);
    if (row === undefined || w.t > ends + HOLD_WITHIN) {
      p.clearFlag(name);
      continue;
    }
    if (w.t < ends) {
      p.wakeAt(ends + AFTER_SIEGE);
      continue;
    }
    const owner = row.owner;
    if (besiegedExt(w, row.ext)) continue;
    p.clearFlag(name);
    if (owner === null || owner === w.seat || w.relations.get(owner) !== "ally") continue;
    if (
      desk.book.some((x) => x.call.target === city && (x.state === "yes" || x.state === "sent"))
    ) {
      continue;
    }
    if (defender === null) continue;
    const pop = Math.max(1, kit.units.get(defender)?.pop ?? 1);
    const helpers = w.cities
      .filter((c) => !c.blocked)
      .map((c) => ({ c, travel: w.travel(c.id, row.island, false) }))
      .filter((h): h is { c: OwnCity; travel: number } => h.travel !== null)
      .toSorted((a, b) => a.travel - b.travel || compareIds(a.c.id, b.c.id));
    for (const { c, travel } of helpers) {
      const n = Math.min(
        Math.floor((countOf(p.homeOf(c.id), defender) * clampPm(sharePm)) / 1000),
        Math.floor(p.liftCapacity(c, row.island) / pop),
      );
      if (n < MIN_HOLDERS) continue;
      const group = p.withCarriers(c, row.island, { [defender]: n });
      if (group === null) continue;
      p.support(c, city, group);
      p.memo(`hold ${city} for ${owner} lands ${fmtTime(w.t + travel)}`);
      break;
    }
  }
}
