// `opportunist@3` (docs/architecture.md §11.2): opportunist@2 (`opportunist2.ts`, frozen) that
// fights beside its allies through the war-call protocol (`war.ts`, `respond.ts`):
// - It answers its allies' calls: a strike gets a seeded share of its attackers (with warships
//   across water) from the own cities that land inside the window, a hold or a siege a share of
//   its defenders; yes with the landing, or no with the reason, so that the caller can plan; then
//   it keeps its word at the planned launch. A call against itself, an ally or a pact partner, or
//   from a distrusted caller, is never followed.
// - It names and joins its allies' wars: "war on pX" in an ally's private message (conqueror@2
//   writes it) makes pX's cities its first raid targets for a day.
// - It calls its allies against a common enemy (no relation to it or, by the leaderboard, to any
//   of its allies) it raids: a target nearer than a seeded 4–6 h becomes a joint raid (the call
//   now, its own army leaving later so as to land that far ahead, in the middle of the call's
//   hour; called off with a cancel when the target is besieged or changed hands by then); a
//   farther one is raided at once with a call around its landing. 1–3 calls a day, never to an
//   ally that refused or ignored one of its calls within a day.
// - A player that betrayed it is never allied again, nor are its calls answered; one raid on a
//   target gets one call (a raid whose target an own call under way already names gets none).
// - Ally first, betray later, as opportunist@2: the same seeded betrayal (D3–D5, top 2), never
//   during or near its own bloc's countdown. Its betrayal may start in silence: while a betrayal
//   is in reach (an ally's city its army beats by its margin), that ally's calls get no answer,
//   and it calls that ally no more.
// - While a strike it said yes to (or a joint raid of its own) has not left, its attackers stay
//   home (no raid).
// - An ally's conquest is held with defenders (`holdConquests`), as turtle@3 does.
//
// Its draws are opportunist@2's, in the same order, then the war's: its economy, betrayal and
// raids are drawn exactly as opportunist@2's for the same seed and seat.
//
// Memory: opportunist@2's flags, the war book (`wc` memo lines: the calls it heard and its own,
// a joint raid `yes` until its army leaves), `gw<city>` (an ally's siege to hold), `wv`/`wt` (the
// player an ally named in "war on pX", and when), `wq` (its last call's number), `wd`/`wn` (the
// day of its calls, and how many it sent that day) and `wr<seat>` (when that ally refused or
// ignored one of its calls: it is not called again for a day).

import { compareIds, type MovementId, type PlayerId, type ToolCall } from "@perfidia/protocol";
import { call, countOf, DAY, fmtTime, landPop, unitsInReport } from "../kit.ts";
import { paceBuilds, paceRecruits } from "../pace.ts";
import { mainCity, type Planner } from "../plan.ts";
import {
  countdownReads,
  holdSieges,
  moraleVs,
  reliefParams,
  reliefReads,
  relieveSieges,
  spiedDefense,
  stopTheLeader,
  supportAllies,
} from "../relief.ts";
import {
  answerCalls,
  betrayers,
  closeDesk,
  holdConquests,
  keepWord,
  openDesk,
  rememberBetrayers,
  sendAnswers,
  canWakeAt,
  strikePending,
  type ResponderParams,
  type WarDesk,
} from "../respond.ts";
import { randInt } from "../rng.ts";
import {
  composeCall,
  composeCancel,
  droppedEventSearch,
  droppedWarOpens,
  droppedWarSearch,
  mayMessage,
  overlaps,
  seenEvents,
  TRUST_EVENTS,
  warId,
  warMessages,
  warTarget,
  type WarCall,
  type WarEntry,
} from "../war.ts";
import type { OtherCity, OwnCity, World } from "../world.ts";
import {
  betray,
  court,
  courtFighter,
  dominationInReach,
  FRIEND_SCAN,
  friendCities,
  friendDefense,
  holdBetrayal,
  noteLosses,
  opportunist2Params,
  RAID_SCAN,
  raidParams,
  raidSpiesToday,
  remember,
  scoutFriends,
  seatNumber,
  strangerCities,
  tidy,
  topTwo,
  tribute,
  watchFighters,
  weighable,
  type Opportunist2Params,
} from "./opportunist2.ts";
import type { StrategyDef } from "./strategy.ts";

/** Its own calls: how many a day at most, and how far ahead a joint raid lands. */
export interface CallParams {
  readonly perDay: number;
  /** A joint raid lands this long after its call at least: its allies hear it and come. */
  readonly ahead: number;
}

/** A named enemy ("war on pX") is followed this long. */
const NAMED_FOR = DAY;
/** An ally that said no to one of its calls is not called again for this long. */
const REFUSED_FOR = DAY;
/** Half the window of its own calls, around its landing. */
const CALL_HALF = 1800;
/** The public headlines it watches (`watchFighters`) when a full briefing left them out. */
const FIGHTS: readonly string[] = Object.freeze(["battle"]);
/** An ally needs this long at least to hear a call (a social wake) and land (the shortest trip). */
const CALL_REACH = 4200;

const isPlayerId = (v: unknown): v is PlayerId => typeof v === "string" && /^p[1-9][0-9]*$/.test(v);

function allies(w: World): PlayerId[] {
  return [...w.relations.entries()]
    .filter(([, kind]) => kind === "ally")
    .map(([q]) => q)
    .toSorted(compareIds);
}

/**
 * Remembers the player an ally names in a private "war on pX" (`wv`, `wt`): never the seat, an
 * ally or a pact partner.
 */
function hearNamed(p: Planner): void {
  const { w } = p;
  for (const m of warMessages(w)) {
    if (m.to === "all" || !m.to.includes(w.seat) || w.relations.get(m.from) !== "ally") continue;
    const who = /\bwar on (p[1-9][0-9]{0,3})\b/i.exec(m.text.slice(0, 300))?.[1]?.toLowerCase();
    if (!isPlayerId(who) || who === w.seat || w.relations.has(who)) continue;
    const n = seatNumber(who);
    if (n === null) continue;
    p.setFlag("wv", n);
    p.setFlag("wt", w.t);
  }
}

/** The player an ally named within `NAMED_FOR`, still no relation of the seat, or null. */
function namedEnemy(w: World): PlayerId | null {
  const n = w.memory.x["wv"];
  const at = w.memory.x["wt"];
  if (n === undefined || at === undefined || w.t - at >= NAMED_FOR) return null;
  const q: PlayerId = `p${n}`;
  return q === w.seat || w.relations.has(q) ? null : q;
}

/**
 * The allies whose city its army would beat by its betrayal margin now, while a betrayal is in its
 * seeded reach (opportunist@2's conditions: its day, the top 2, no countdown of its bloc in reach,
 * attacks open): their calls get no answer.
 */
function betrayable(p: Planner, prm: Opportunist2Params): Set<PlayerId> {
  const { w } = p;
  const out = new Set<PlayerId>();
  if (w.day < prm.betrayDay || p.flag("bt") !== null || !topTwo(w)) return out;
  if (w.t < w.kit.rules.time.attackFrom || p.attacksLeft <= 0 || dominationInReach(w)) return out;
  const main = mainCity(w);
  if (main === null) return out;
  for (const target of friendCities(w).slice(0, FRIEND_SCAN)) {
    const view = w.views.get(target.id);
    if (!weighable(w, view) || target.owner === null) continue;
    if (w.relations.get(target.owner) !== "ally") continue;
    const est = friendDefense(w, view, prm.stale);
    if (est === null) continue;
    const group = p.attackGroup(main, target.island, 0);
    if (group === null) continue;
    const a = Math.floor((group.strength * moraleVs(w, target.owner)) / 1000);
    if (a * 1000 > est * prm.marginPm) out.add(target.owner);
  }
  return out;
}

/** True when `q` has no relation to the seat nor, by the leaderboard, to any of its allies. */
function commonEnemy(w: World, q: PlayerId): boolean {
  if (q === w.seat || w.relations.has(q)) return false;
  for (const a of allies(w)) {
    if (a === q) return false;
    const row = w.board?.standings.find((s) => s.player === a);
    if (row === undefined || row.relations.some((r) => r.player === q)) return false;
  }
  return true;
}

/**
 * The allies it would call to strike `target` now: none unless the target's owner is a common
 * enemy, a call is still allowed today and messages are in hand; never an ally it keeps silent
 * towards, nor one that refused or ignored one of its calls within a day.
 */
function callees(
  p: Planner,
  target: OtherCity,
  o: CallParams,
  silent: ReadonlySet<PlayerId>,
): PlayerId[] {
  const { w } = p;
  if (target.owner === null || !commonEnemy(w, target.owner)) return [];
  if (!mayMessage("call", p.messagesLeft) || callsToday(p) >= o.perDay) return [];
  return allies(w).filter((q) => !refused(p, q) && !silent.has(q));
}

function callsToday(p: Planner): number {
  return p.flag("wd") === p.w.day + 1 ? (p.flag("wn") ?? 0) : 0;
}

/**
 * Calls `to` (one message) to strike `target` in a window around `lands`, its own landing, and
 * enters the call in the book with `state` and `at` (`yes`: its own launch to come; `sent`: its
 * landing). False when the message could not be sent.
 */
function sendCall(
  p: Planner,
  desk: WarDesk,
  to: readonly PlayerId[],
  target: OtherCity,
  lands: number,
  state: "yes" | "sent",
  at: number,
): boolean {
  const { w } = p;
  const seq = (p.flag("wq") ?? 0) + 1;
  const t0 = Math.max(w.t + CALL_REACH, lands - CALL_HALF);
  const c: WarCall = {
    id: warId(seq),
    role: "strike",
    target: target.id,
    t0,
    t1: Math.max(t0, lands + CALL_HALF),
    vs: target.owner,
    lands,
  };
  if (!p.message(to, composeCall(c))) return false;
  const today = callsToday(p);
  p.setFlag("wq", seq);
  p.setFlag("wd", w.day + 1);
  p.setFlag("wn", today + 1);
  desk.book = [...desk.book, { from: w.seat, call: c, state, at, answers: {} }];
  return true;
}

/**
 * True when one of the seat's own calls under way (`yes`, `sent`) already names `target` with a
 * window that overlaps the one a call landing at `lands` would ask for: a second call would cost a
 * message and invite a double promise.
 */
function calledAlready(desk: WarDesk, seat: PlayerId, target: OtherCity, lands: number): boolean {
  const ask: WarCall = {
    id: "k1",
    role: "strike",
    target: target.id,
    t0: lands - CALL_HALF,
    t1: lands + CALL_HALF,
    vs: null,
    lands: null,
  };
  return desk.book.some(
    (e) =>
      e.from === seat &&
      (e.state === "yes" || e.state === "sent") &&
      e.call.target === target.id &&
      overlaps(e.call, ask),
  );
}

/** `desk`'s entry of the seat's own call `id`, patched. */
function patchOwn(desk: WarDesk, seat: PlayerId, id: string, patch: Partial<WarEntry>): void {
  desk.book = desk.book.map((x) => (x.from === seat && x.call.id === id ? { ...x, ...patch } : x));
}

/**
 * Its joint raids: at the planned launch of one of its own calls, the army of its main city leaves
 * for the target when it is still a common enemy's city, not besieged, and the army still has its
 * raiders; otherwise the call is cancelled (one message to its allies, messages in hand).
 * Before the launch, a firm self-wake waits for it.
 */
function keepOwnCalls(p: Planner, desk: WarDesk, prm: Opportunist2Params): void {
  const { w } = p;
  const attacker = w.kit.roles.attacker;
  for (const e of desk.book) {
    if (e.from !== w.seat || e.state !== "yes" || e.at === null) continue;
    if (e.at > w.t) {
      p.wakeAt(e.at);
      continue;
    }
    const target = warTarget(w, e.call.target);
    const main = mainCity(w);
    const owner = target?.owner ?? null;
    let why = "";
    if (target === null || owner === null || owner === w.seat || w.relations.has(owner)) {
      why = "target changed hands";
    } else if (target.besieged) {
      why = "target under siege";
    } else if (main === null || p.attacksLeft <= 0) {
      why = "army busy";
    } else if (w.t + (w.travel(main.id, target.island, false) ?? 0) > e.call.t1) {
      why = "too late";
    }
    const group =
      why === "" && main !== null && target !== null ? p.attackGroup(main, target.island, 0) : null;
    if (
      group !== null &&
      main !== null &&
      target !== null &&
      countOf(group.units, attacker) >= prm.minRaiders &&
      p.attack(main, target.id, group.units)
    ) {
      const lands = w.t + (w.travel(main.id, target.island, false) ?? 0);
      patchOwn(desk, w.seat, e.call.id, { state: "sent", at: lands });
      p.memo(`joint raid ${target.id} (${owner ?? "?"}) lands ${fmtTime(lands)}`);
      continue;
    }
    patchOwn(desk, w.seat, e.call.id, { state: "cancelled" });
    const to = allies(w);
    if (to.length > 0 && mayMessage("cancel", p.messagesLeft)) {
      p.message(to, composeCancel(e.call.id, why === "" ? "army busy" : why));
    }
  }
}

/** True while one of its own joint raids waits for its launch. */
function ownPending(desk: WarDesk, seat: PlayerId): boolean {
  return desk.book.some((e) => e.from === seat && e.state === "yes");
}

/** True while `q` said no to one of its calls within `REFUSED_FOR` (`wr<n>`). */
function refused(p: Planner, q: PlayerId): boolean {
  const n = seatNumber(q);
  const at = n === null ? null : p.flag(`wr${n}`);
  return at !== null && p.w.t - at < REFUSED_FOR;
}

/**
 * Remembers the allies that said no to one of its own calls, or let its window pass without an
 * answer (`wr<n>`: since when).
 */
function noteRefusals(p: Planner, desk: WarDesk): void {
  const { w } = p;
  for (const e of desk.book) {
    if (e.from !== w.seat) continue;
    const silent = e.call.t1 < w.t ? allies(w).filter((q) => e.answers[q] === undefined) : [];
    const noes = Object.entries(e.answers).flatMap(([q, a]) => (a === "no" ? [q] : []));
    for (const q of [...noes, ...silent]) {
      const n = isPlayerId(q) ? seatNumber(q) : null;
      if (n !== null && p.flag(`wr${n}`) === null) p.setFlag(`wr${n}`, w.t);
    }
  }
}

/**
 * opportunist@2's raid (`opportunist2.ts`), with the cities of the enemy an ally named first, its
 * attackers kept home while a strike it promised (or a joint raid of its own) has not left, and
 * its allies called when it raids a common enemy: a target nearer than `ahead` becomes a joint
 * raid (the call now, its own launch timed to land `ahead` from now, in the call's window); a
 * farther one is raided now with a call around its landing. A target one of its calls under way
 * already names in an overlapping window (`calledAlready`) is raided now, with no second call.
 */
function raid(
  p: Planner,
  prm: Opportunist2Params,
  desk: WarDesk,
  calls: CallParams,
  named: PlayerId | null,
  silent: ReadonlySet<PlayerId>,
): void {
  const { w } = p;
  const kit = w.kit;
  if (w.t < kit.rules.time.attackFrom || p.attacksLeft <= 0) return;
  const main = mainCity(w);
  if (main === null || countOf(p.homeOf(main.id), kit.roles.attacker) < prm.minRaiders) return;
  const cands = raidCandidates(w, main, named);
  if (!strikePending(desk, w.seat) && !ownPending(desk, w.seat)) {
    let best: {
      target: OtherCity;
      d: number;
      named: boolean;
      units: Record<string, number>;
    } | null = null;
    for (const target of cands) {
      const view = w.views.get(target.id);
      if (!weighable(w, view) || target.owner === null) continue;
      const lost = p.flag(`l${target.id}`);
      if (lost !== null && w.t - lost < prm.cooldown) continue;
      const travel = w.travel(main.id, target.island, false) ?? 0;
      const spied = spiedDefense(w, view, prm.stale, travel);
      if (spied === null) continue;
      const group = p.attackGroup(main, target.island, 0);
      if (group === null) continue;
      const a = Math.floor((group.strength * moraleVs(w, target.owner)) / 1000);
      if (a * 1000 < spied.d * prm.raidPm) continue;
      const isNamed = target.owner === named;
      if (
        best === null ||
        (isNamed && !best.named) ||
        (isNamed === best.named && spied.d < best.d)
      ) {
        best = { target, d: spied.d, named: isNamed, units: group.units };
      }
    }
    if (best !== null) {
      const target = best.target;
      const travel = w.travel(main.id, target.island, false);
      const to = travel === null ? [] : callees(p, target, calls, silent);
      if (
        travel !== null &&
        to.length > 0 &&
        travel < calls.ahead &&
        !calledAlready(desk, w.seat, target, w.t + calls.ahead) &&
        canWakeAt(p, w.t + calls.ahead - travel)
      ) {
        const lands = w.t + calls.ahead;
        if (sendCall(p, desk, to, target, lands, "yes", lands - travel)) {
          p.wakeAt(lands - travel);
          p.memo(`joint raid ${target.id} (${target.owner ?? "?"}) called D${w.day + 1}`);
          return;
        }
      }
      if (p.attack(main, target.id, best.units)) {
        p.memo(`raid ${target.id} (${target.owner ?? "?"}) D${w.day + 1}`);
        if (
          travel !== null &&
          to.length > 0 &&
          !calledAlready(desk, w.seat, target, w.t + travel)
        ) {
          sendCall(p, desk, to, target, w.t + travel, "sent", w.t + travel);
        }
      }
      return;
    }
  }
  // The day's spies are spread over the day, so that raids are too.
  const into = w.t - w.day * DAY;
  const allowed = Math.ceil((prm.spiesPerDay * (into + 1)) / DAY);
  if (raidSpiesToday(p) >= Math.min(prm.spiesPerDay, allowed)) return;
  for (const target of cands) {
    const view = w.views.get(target.id);
    if (!weighable(w, view) || view.access !== "public") continue;
    if (spiedDefense(w, view, prm.stale) !== null || p.inFlight("spy", target.id)) continue;
    const lost = p.flag(`l${target.id}`);
    if (lost !== null && w.t - lost < prm.cooldown) continue;
    const last = p.flag(`rv${target.id}`);
    if (last !== null && w.t - last < prm.stale) continue;
    const seen = view.intel === null ? null : landPop(kit, unitsInReport(kit, view.intel.data));
    const gold = p.spyGold(main, prm.spyMult, seen);
    if (gold === null) return;
    p.spy(main, target.id, gold);
    p.setFlag(`rv${target.id}`, w.t);
    return;
  }
}

/** Raid candidates: the named enemy's nearest city first, then the nearest strangers. */
function raidCandidates(w: World, from: OwnCity, named: PlayerId | null): OtherCity[] {
  const near = strangerCities(w, from);
  const first = named === null ? undefined : near.find((o) => o.owner === named);
  const rest = near.filter((o) => o !== first).slice(0, RAID_SCAN);
  return first === undefined ? rest : [first, ...rest.slice(0, RAID_SCAN - 1)];
}

/**
 * The seat's attacks on their way to each player's cities: those still in their recall window,
 * and whether one can no longer be called back.
 */
function raidsOnTheWay(w: World): Map<PlayerId, { recallable: MovementId[]; stuck: boolean }> {
  const out = new Map<PlayerId, { recallable: MovementId[]; stuck: boolean }>();
  for (const m of w.self?.private?.movements ?? []) {
    if (m.owner !== w.seat || m.kind !== "attack" || m.to === null) continue;
    if ((m.turnedBack ?? null) !== null || m.arrive[0] <= w.t) continue;
    const owner = w.map?.cities.find((c) => c.id === m.to)?.owner ?? null;
    if (owner === null || owner === w.seat) continue;
    const entry = out.get(owner) ?? { recallable: [], stuck: false };
    if ((m.recallableUntil?.[0] ?? 0) > w.t) entry.recallable.push(m.id);
    else entry.stuck = true;
    out.set(owner, entry);
  }
  return out;
}

/** Drops the named enemy once it is stale, so that the notes stay small. */
function tidyWar(p: Planner): void {
  const at = p.flag("wt");
  if (at !== null && p.w.t - at >= NAMED_FOR) {
    p.clearFlag("wt");
    p.clearFlag("wv");
  }
  for (const [name, v] of Object.entries(p.memory.x)) {
    if (/^wr[1-9][0-9]*$/.test(name) && p.w.t - v >= REFUSED_FOR) p.clearFlag(name);
  }
}

export const opportunist3: StrategyDef = Object.freeze<StrategyDef>({
  name: "opportunist",
  version: 3,
  brain(rng) {
    // opportunist@2's draws, in the same order, then the war's.
    const base = opportunist2Params(rng);
    const knobs = {
      cadence: randInt(rng, 5400, 7200),
      settle: true,
      maxCities: 64,
      producerBase: 4,
      producerPerDay: 2,
      wallBase: 0,
      wallPerDay: 0,
      spendPm: randInt(rng, 650, 800),
      mix: { defender: 1, attacker: 2, navy: 0 },
      carriers: true,
      supportOwn: true,
      escort: randInt(rng, 2, 3),
      militaryFirst: false,
    };
    const prm = raidParams(rng, base);
    const relief = reliefParams(rng);
    const war: ResponderParams = {
      roles: ["strike", "siege", "hold"],
      decline: "",
      strikePm: randInt(rng, 700, 900),
      minStrike: randInt(rng, 150, 300),
      holdPm: relief.sharePm,
      minHold: randInt(rng, 200, 400),
      aimPm: randInt(rng, 300, 700),
      waves: 2,
    };
    const calls: CallParams = {
      perDay: randInt(rng, 1, 3),
      ahead: randInt(rng, 4 * 3600, 6 * 3600),
    };
    return {
      knobs,
      reads(w: World): ToolCall[] {
        const out: ToolCall[] = [call("leaderboard", {})];
        out.push(...reliefReads(w, true), ...countdownReads(w, true));
        if (w.day >= prm.betrayDay - 1) {
          for (const o of friendCities(w).slice(0, FRIEND_SCAN)) {
            out.push(call("view_city", { city: o.id }));
          }
        }
        const main = mainCity(w);
        if (main !== null) {
          for (const o of raidCandidates(w, main, namedEnemy(w))) {
            out.push(call("view_city", { city: o.id }));
          }
        }
        out.push(...droppedWarSearch(w), ...droppedEventSearch(w, TRUST_EVENTS));
        out.push(...droppedEventSearch(w, FIGHTS));
        return out;
      },
      moreReads: droppedWarOpens,
      plan(p) {
        const { w } = p;
        const betrayed = p.flag("bt") !== null;
        let allied = w.self?.alliance !== null && w.self?.alliance !== undefined;
        // Pacts unless it betrayed; one alliance from anyone while it has none. A raid on its way
        // to the proposer would land as a betrayal (and end the countdown the alliance may start):
        // it is called back when it still can be, otherwise the proposal waits for it to land.
        const raids = raidsOnTheWay(w);
        rememberBetrayers(p);
        const traitors = betrayers(p);
        p.answer((pr) => {
          if (traitors.has(pr.from)) return false;
          if (pr.kind === "pact" && betrayed) return false;
          if (pr.kind === "alliance" && allied) return false;
          const mine = raids.get(pr.from);
          if (mine !== undefined && mine.stuck) return null;
          for (const m of mine?.recallable ?? []) p.recall(m);
          raids.delete(pr.from);
          if (pr.kind === "alliance") allied = true;
          return true;
        });
        remember(p);
        watchFighters(p, seenEvents(w));
        noteLosses(p);
        hearNamed(p);
        const desk = openDesk(p);
        noteRefusals(p, desk);
        holdBetrayal(p);
        relieveSieges(p, relief, true, 0);
        holdSieges(p, relief);
        const keepFounders = stopTheLeader(p, relief, 300, true);
        const named = namedEnemy(p.w);
        const silent = betrayable(p, prm);
        answerCalls(p, desk, war, { silent, prefer: new Set(named === null ? [] : [named]) });
        keepWord(p, desk, war);
        keepOwnCalls(p, desk, prm);
        betray(p, prm);
        scoutFriends(p, prm);
        raid(p, prm, desk, calls, named, silent);
        court(p, prm);
        courtFighter(p);
        tribute(p, prm);
        p.supportThreatened();
        supportAllies(p, relief);
        holdConquests(p, desk, relief.sharePm);
        sendAnswers(p, desk);
        if (!keepFounders) p.settle();
        p.founder();
        paceBuilds(p);
        p.economy();
        paceRecruits(p);
        p.units();
        tidy(p, prm);
        tidyWar(p);
        closeDesk(p, desk);
      },
    };
  },
});
