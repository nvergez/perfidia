import { parseWar } from "@perfidia/bots";
import {
  AllianceIdSchema,
  PlayerIdSchema,
  STANDARD_EVENT_DATA,
  z,
  type GameTime,
  type LogLine,
  type PlayerId,
} from "@perfidia/protocol";
import { HOMECOMING } from "./battles.ts";
import { botName } from "./seats.ts";

// Teamwork (docs/architecture.md §12.2), from the log lines alone: joint attacks (battles at one
// city by attackers of at least two players allied at the time, landing within `JOINT_WINDOW` of
// each other), how each siege was held (reinforced by its besieger, relieved, and its outcome), the
// war-call messages (`WAR#` tags of the bots' war-call protocol, `bots/src/war.ts`: private
// messages are spectator-visible and logged with their text) and how near any bloc came to the R1
// domination rule of perfidia-1@1.1.0 §13.3 (by default at least 35% of the map's city slots and
// 2N, with at least 2 of them taken; a city is taken for its owner's bloc when the owner conquered
// it and no member of the bloc ever owned it): with the match's own values when its config has
// `victory.dominationMinConquests`, else (a 1.0.0 log) 1.1.0's defaults. A bloc is an alliance (its members at the time) or a player outside any
// alliance (perfidia-1 §13.3); a city counts for its owner, besieged or not.

/** Two battles at one city are a joint attack when they land at most this far apart (s). */
export const JOINT_WINDOW = 3600;
/** A war call counts behind a joint attack when sent at most this long before its first battle. */
export const CALL_LEAD = 86400;
/**
 * The R1 values of perfidia-1@1.1.0's defaults, for a log whose config has none (1.0.0): bloc
 * cities ≥ `R1_SHARE_PM` ‰ of the map's city slots, rounded up (and ≥
 * `victory.dominationMinPerPlayer` × N), and taken cities ≥ `R1_CONQUERED`.
 */
export const R1_SHARE_PM = 350;
export const R1_CONQUERED = 2;

/** The domination rule R1 follows in a match: its numbers and when domination opens. */
export interface R1Rule {
  readonly pm: number;
  /** The threshold's floor per seat (`victory.dominationMinPerPlayer`), and the seats. */
  readonly minPerPlayer: number;
  readonly players: number;
  readonly minConquests: number;
  /** `time.dominationStart`, `time.dominationHold` and `time.matchEnd`. */
  readonly open: GameTime;
  readonly hold: number;
  readonly matchEnd: GameTime;
}

/** Battles at one city by attackers of ≥ 2 players allied at the time, landing within the window. */
export interface JointAttack {
  /** The first battle's time and the last's. */
  readonly t: GameTime;
  readonly last: GameTime;
  readonly city: string;
  /** The defending side of the first battle (a player, or `neutral`). */
  readonly defender: string;
  /** The attackers, by id, and their controllers at the first battle (without `bot:`). */
  readonly players: PlayerId[];
  readonly bots: string[];
  readonly battles: number;
  /** The player whose war call named the city, sent to another attacker, before it; or null. */
  readonly caller: PlayerId | null;
}

export type SiegeOutcome =
  | "conquered"
  | "relief"
  | "homecoming"
  | "abandoned"
  | "eliminated"
  | "open"
  | "other";

/** One siege and how it was held. */
export interface SiegeHold {
  readonly t: GameTime;
  readonly city: string;
  /** The besieged city's owner (null: the neutral city). */
  readonly owner: PlayerId | null;
  readonly by: PlayerId;
  /** The besieger's controller at the start, without `bot:`. */
  readonly bot: string;
  readonly endedAt: GameTime | null;
  /** Groups that joined the garrison after the start: the besieger's supports and later waves. */
  readonly joined: number;
  /** Supports the besieger launched to the city during the siege. */
  readonly sent: number;
  /** Relief battles fought against the garrison, and homecomings. */
  readonly reliefs: number;
  readonly homecomings: number;
  /** `conquered`, a `siege_broken` cause (`relief`, `homecoming`, `abandoned`, `eliminated`), or `open` at the end. */
  readonly outcome: SiegeOutcome;
}

/** The war-call messages of a match (private messages with a `WAR#` tag). */
export interface WarCallStat {
  /** Calls sent (a call to several allies in one message counts once). */
  readonly calls: number;
  /** Calls that got at least one answer from a recipient. */
  readonly answered: number;
  /** Answers to a known call: yes, no; and cancels of a known call. */
  readonly yes: number;
  readonly no: number;
  readonly cancels: number;
  /** Tagged items that matched no call (an answer or cancel to an unknown id, a public tag). */
  readonly stray: number;
}

/** How near a bloc came to the R1 domination rule. */
export interface R1Reach {
  /** City slots of the map (every island's), and the cities and taken cities R1 asks for. */
  readonly slots: number;
  readonly need: number;
  readonly needTaken: number;
  /** The bloc with the most cities at any time (ties: the most conquered, then the earliest). */
  readonly maxCities: number;
  readonly maxConquered: number;
  readonly maxAt: GameTime | null;
  /** Its members' controllers, without `bot:`. */
  readonly maxBloc: string[];
  /** The most cities a bloc held while ≥ `needTaken` of them were taken; null when none ever did. */
  readonly fightingMax: number | null;
  /** `need − fightingMax` (≥ 0): how many cities the best fighting bloc lacked; null when none. */
  readonly shortfall: number | null;
  /** The most taken cities any bloc held at once. */
  readonly mostConquered: number;
  /** When a bloc first met R1, and its members' controllers; null and empty when none did. */
  readonly reachedAt: GameTime | null;
  readonly reachedBy: string[];
  /**
   * Cities the bloc that first met R1 held then that one member had conquered from another (a
   * staged trade before allying, or a recapture for an ally): R1 does not count them as taken;
   * null when none met R1.
   */
  readonly takenFromBloc: number | null;
  /**
   * When a bloc first held R1 for `time.dominationHold` from the domination opening on, with the
   * same members (a domination win under R1); null when none did. With the match's own rule
   * (1.1.0) it is when the domination win fell due.
   */
  readonly heldAt: GameTime | null;
}

export interface TeamRecords {
  readonly joint: JointAttack[];
  readonly sieges: SiegeHold[];
  readonly calls: WarCallStat;
  /** War messages by sender controller: calls, answers yes and no. */
  readonly callers: Readonly<Record<string, { calls: number; yes: number; no: number }>>;
  /** Null when the initial world (cities and their owners, slots) is not given. */
  readonly r1: R1Reach | null;
}

/**
 * The initial world R1 needs: every city's starting owner (null: neutral) and the map's slots, and
 * the rule to follow (without one: the proposed values, no floor, a 24 h hold from t = 0).
 */
export interface InitialMap {
  readonly slots: number;
  readonly owners: ReadonlyMap<string, PlayerId | null>;
  readonly rule?: R1Rule;
}

const SiegeStartedSchema = z.looseObject({
  city: z.string(),
  owner: PlayerIdSchema.nullable(),
  by: PlayerIdSchema,
});
const SiegeBrokenSchema = z.looseObject({ city: z.string(), cause: z.string() });
const MessageSchema = STANDARD_EVENT_DATA.message;
const AllianceFormedSchema = z.looseObject({
  alliance: AllianceIdSchema,
  members: z.array(PlayerIdSchema),
});

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortIds = (xs: Iterable<PlayerId>): PlayerId[] =>
  [...new Set(xs)].toSorted((a, b) => Number(a.slice(1)) - Number(b.slice(1)) || byCodeUnit(a, b));

/** Each seat's controller at a time (without `bot:`), from the header and the `controller` lines. */
export function controllersOf(lines: Iterable<LogLine>): (seat: PlayerId, t: GameTime) => string {
  const spans = new Map<string, { from: GameTime; label: string }[]>();
  for (const line of lines) {
    if (line.k === "header") {
      for (const [seat, label] of Object.entries(line.controllers))
        spans.set(seat, [{ from: 0, label }]);
    } else if (line.k === "controller") {
      spans.set(line.seat, [...(spans.get(line.seat) ?? []), { from: line.t, label: line.label }]);
    }
  }
  return (seat, t) => {
    let label = "?";
    for (const s of spans.get(seat) ?? []) if (s.from <= t) label = s.label;
    return botName(label);
  };
}

interface Battle {
  readonly t: GameTime;
  readonly city: string;
  readonly attacker: PlayerId;
  readonly defender: string;
  /** The attacker's alliance when the battle was fought, or null. */
  readonly alliance: string | null;
}

interface SentCall {
  readonly t: GameTime;
  readonly from: PlayerId;
  readonly to: readonly PlayerId[];
  readonly id: string;
  readonly target: string;
  answered: boolean;
}

interface OpenSiege {
  readonly row: { -readonly [K in keyof SiegeHold]: SiegeHold[K] };
  readonly joinedMoves: Set<string>;
}

/** The R1 measures so far. */
interface R1Track {
  best: { cities: number; conquered: number; t: GameTime; bloc: PlayerId[] } | null;
  fightingMax: number | null;
  mostConquered: number;
  reached: { t: GameTime; bloc: PlayerId[]; fromBloc: number } | null;
  /** Since when each bloc (keyed by its members joined by `,`) has met R1 without a break. */
  since: Map<string, { t: GameTime; bloc: PlayerId[] }>;
  held: { t: GameTime; bloc: PlayerId[] } | null;
}

/** Union-find over battle indexes. */
function groups(n: number, links: readonly [number, number][]): number[][] {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] ?? r;
    return r;
  };
  for (const [a, b] of links) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
  const out = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    const r = find(i);
    out.set(r, [...(out.get(r) ?? []), i]);
  }
  return [...out.values()];
}

/**
 * The teamwork records of a log (any lines; `ev`, `act`, `header` and `controller` count). With
 * `initial`, R1 is followed from the starting owners; without it, `r1` is null.
 */
export function teamRecords(lines: readonly LogLine[], initial: InitialMap | null): TeamRecords {
  const botAt = controllersOf(lines);
  const allianceOf = new Map<PlayerId, string>();
  const members = new Map<string, Set<PlayerId>>();
  const battles: Battle[] = [];
  const sent: SentCall[] = [];
  const calls = { calls: 0, answered: 0, yes: 0, no: 0, cancels: 0, stray: 0 };
  const callers: Record<string, { calls: number; yes: number; no: number }> = {};
  const caller = (seat: PlayerId, t: GameTime) => {
    const b = botAt(seat, t);
    callers[b] ??= { calls: 0, yes: 0, no: 0 };
    return callers[b];
  };
  const sieges: SiegeHold[] = [];
  const open = new Map<string, OpenSiege>();

  // R1: each city's owner, the cities conquered and their former owners: a city is taken for its
  // owner's bloc when the owner conquered it and no member of the bloc ever owned it. Per player,
  // cities and taken cities.
  const owner = new Map<string, PlayerId | null>(initial?.owners ?? []);
  const conqueredCities = new Set<string>();
  const formerOwners = new Map<string, Set<PlayerId>>();
  /** Conquered, and none of `bloc` (the owner's bloc, the owner included) owned it before. */
  const isTaken = (city: string, bloc: readonly PlayerId[]): boolean =>
    conqueredCities.has(city) && !bloc.some((m) => formerOwners.get(city)?.has(m) ?? false);
  /** Conquered from a member of `bloc` by another: taken for the owner alone, not for the bloc. */
  const fromOwnBloc = (city: string, o: PlayerId, bloc: readonly PlayerId[]): boolean =>
    isTaken(city, [o]) && !isTaken(city, bloc);
  const blocOf = (o: PlayerId): PlayerId[] => {
    const a = allianceOf.get(o);
    return a === undefined ? [o] : [...(members.get(a) ?? [o])];
  };
  const rule = initial?.rule;
  const need =
    initial === null
      ? 0
      : Math.max(
          rule === undefined ? 0 : rule.minPerPlayer * rule.players,
          Math.floor(((rule?.pm ?? R1_SHARE_PM) * initial.slots + 999) / 1000),
        );
  const needTaken = rule?.minConquests ?? R1_CONQUERED;
  const opensAt = rule?.open ?? 0;
  const holdFor = rule?.hold ?? 86400;
  const r: R1Track = {
    best: null,
    fightingMax: null,
    mostConquered: 0,
    reached: null,
    since: new Map(),
    held: null,
  };
  /** Records the first hold of `key` complete by `t`: `holdFor` from the opening on, by matchEnd. */
  const heldBy = (key: string, t: GameTime): void => {
    const start = r.since.get(key);
    if (start === undefined || r.held !== null) return;
    const done = Math.max(start.t, opensAt) + holdFor;
    if (done <= t && done <= (rule?.matchEnd ?? Number.MAX_SAFE_INTEGER)) {
      r.held = { t: done, bloc: start.bloc };
    }
  };
  const evaluate = (t: GameTime): void => {
    if (initial === null) return;
    const per = new Map<PlayerId, { cities: number; conquered: number }>();
    for (const [city, o] of owner) {
      if (o === null) continue;
      const x = per.get(o) ?? { cities: 0, conquered: 0 };
      x.cities += 1;
      if (isTaken(city, blocOf(o))) x.conquered += 1;
      per.set(o, x);
    }
    const blocs = new Map<string, PlayerId[]>();
    for (const p of per.keys()) {
      const key = allianceOf.get(p) ?? p;
      blocs.set(key, [...(blocs.get(key) ?? []), p]);
    }
    const meeting = new Map<string, PlayerId[]>();
    for (const bloc of blocs.values()) {
      let cities = 0;
      let conquered = 0;
      for (const p of bloc) {
        cities += per.get(p)?.cities ?? 0;
        conquered += per.get(p)?.conquered ?? 0;
      }
      const b = r.best;
      if (b === null || cities > b.cities || (cities === b.cities && conquered > b.conquered)) {
        r.best = { cities, conquered, t, bloc: sortIds(bloc) };
      }
      r.mostConquered = Math.max(r.mostConquered, conquered);
      if (conquered >= needTaken) r.fightingMax = Math.max(r.fightingMax ?? 0, cities);
      if (cities >= need && conquered >= needTaken) {
        const sorted = sortIds(bloc);
        meeting.set(sorted.join(","), sorted);
        if (r.reached === null) {
          let fromBloc = 0;
          for (const [city, o] of owner) {
            if (o !== null && bloc.includes(o) && fromOwnBloc(city, o, bloc)) fromBloc += 1;
          }
          r.reached = { t, bloc: sorted, fromBloc };
        }
      }
    }
    for (const key of r.since.keys()) {
      if (meeting.has(key)) continue;
      heldBy(key, t);
      r.since.delete(key);
    }
    for (const [key, bloc] of meeting) {
      if (!r.since.has(key)) r.since.set(key, { t, bloc });
      heldBy(key, t);
    }
  };
  evaluate(0);

  for (const line of lines) {
    if (line.k === "act") {
      const a = line.a;
      if (!line.r.ok || a.type !== "support") continue;
      const s = open.get(a.to);
      if (s !== undefined && s.row.by === line.seat) s.row.sent += 1;
      continue;
    }
    if (line.k !== "ev") continue;
    const { type, data } = line.e;
    const t = line.t;
    if (type === "alliance_formed") {
      const d = AllianceFormedSchema.safeParse(data);
      if (!d.success) continue;
      members.set(d.data.alliance, new Set(d.data.members));
      for (const m of d.data.members) allianceOf.set(m, d.data.alliance);
      evaluate(t);
    } else if (type === "alliance_joined") {
      const d = STANDARD_EVENT_DATA.alliance_joined.safeParse(data);
      if (!d.success) continue;
      members.set(
        d.data.alliance,
        new Set([...(members.get(d.data.alliance) ?? []), d.data.player]),
      );
      allianceOf.set(d.data.player, d.data.alliance);
      evaluate(t);
    } else if (type === "alliance_left") {
      const d = STANDARD_EVENT_DATA.alliance_left.safeParse(data);
      if (!d.success) continue;
      members.get(d.data.alliance)?.delete(d.data.player);
      allianceOf.delete(d.data.player);
      evaluate(t);
    } else if (type === "alliance_dissolved") {
      const d = STANDARD_EVENT_DATA.alliance_dissolved.safeParse(data);
      if (!d.success) continue;
      for (const m of members.get(d.data.alliance) ?? []) allianceOf.delete(m);
      members.delete(d.data.alliance);
      evaluate(t);
    } else if (type === "city_founded") {
      const d = STANDARD_EVENT_DATA.city_founded.safeParse(data);
      if (!d.success) continue;
      owner.set(d.data.city, d.data.owner);
      evaluate(t);
    } else if (type === "city_conquered") {
      const d = STANDARD_EVENT_DATA.city_conquered.safeParse(data);
      if (!d.success) continue;
      owner.set(d.data.city, d.data.to);
      conqueredCities.add(d.data.city);
      if (d.data.from !== null) {
        const former = formerOwners.get(d.data.city) ?? new Set<PlayerId>();
        former.add(d.data.from);
        formerOwners.set(d.data.city, former);
      }
      const s = open.get(d.data.city);
      if (s !== undefined) {
        s.row.outcome = d.data.to === s.row.by ? "conquered" : "other";
        s.row.endedAt = t;
        sieges.push(s.row);
        open.delete(d.data.city);
      }
      evaluate(t);
    } else if (type === "battle") {
      const d = STANDARD_EVENT_DATA.battle.safeParse(data);
      if (!d.success) continue;
      const s = open.get(d.data.city);
      if (s !== undefined && d.data.defender === s.row.by) {
        if (d.data.kind === HOMECOMING) s.row.homecomings += 1;
        else s.row.reliefs += 1;
      }
      if (d.data.kind === HOMECOMING) continue;
      battles.push({
        t,
        city: d.data.city,
        attacker: d.data.attacker,
        defender: d.data.defender,
        alliance: allianceOf.get(d.data.attacker) ?? null,
      });
    } else if (type === "siege_started") {
      const d = SiegeStartedSchema.safeParse(data);
      if (!d.success) continue;
      open.set(d.data.city, {
        row: {
          t,
          city: d.data.city,
          owner: d.data.owner,
          by: d.data.by,
          bot: botAt(d.data.by, t),
          endedAt: null,
          joined: 0,
          sent: 0,
          reliefs: 0,
          homecomings: 0,
          outcome: "open",
        },
        joinedMoves: new Set(),
      });
    } else if (type === "siege_broken") {
      const d = SiegeBrokenSchema.safeParse(data);
      const s = d.success ? open.get(d.data.city) : undefined;
      if (!d.success || s === undefined) continue;
      const cause = d.data.cause;
      s.row.outcome =
        cause === "relief" ||
        cause === "homecoming" ||
        cause === "abandoned" ||
        cause === "eliminated"
          ? cause
          : "other";
      s.row.endedAt = t;
      sieges.push(s.row);
      open.delete(d.data.city);
    } else if (type === "support_arrived") {
      const d = STANDARD_EVENT_DATA.support_arrived.safeParse(data);
      const s = d.success ? open.get(d.data.to) : undefined;
      if (!d.success || s === undefined || d.data.by !== s.row.by) continue;
      if (s.joinedMoves.has(d.data.movement)) continue;
      s.joinedMoves.add(d.data.movement);
      s.row.joined += 1;
    } else if (type === "message") {
      const d = MessageSchema.safeParse(data);
      if (!d.success) continue;
      const items = parseWar(d.data.text);
      if (items.length === 0) continue;
      if (d.data.to === "all") {
        calls.stray += items.length;
        continue;
      }
      const to = d.data.to;
      const from = d.data.from;
      for (const item of items) {
        if (item.kind === "call") {
          calls.calls += 1;
          caller(from, t).calls += 1;
          sent.push({ t, from, to, id: item.call.id, target: item.call.target, answered: false });
          continue;
        }
        const id = item.kind === "ack" ? item.ack.id : item.cancel.id;
        const known =
          item.kind === "ack"
            ? sent.findLast((c) => c.id === id && to.includes(c.from) && c.to.includes(from))
            : sent.findLast((c) => c.id === id && c.from === from);
        if (known === undefined) {
          calls.stray += 1;
          continue;
        }
        if (item.kind === "cancel") {
          calls.cancels += 1;
          continue;
        }
        if (!known.answered) calls.answered += 1;
        known.answered = true;
        if (item.ack.yes) {
          calls.yes += 1;
          caller(from, t).yes += 1;
        } else {
          calls.no += 1;
          caller(from, t).no += 1;
        }
      }
    }
  }
  for (const s of open.values()) sieges.push(s.row);
  sieges.sort((a, b) => a.t - b.t || byCodeUnit(a.city, b.city));

  // Joint attacks: battles at one city linked by allied attackers landing within the window.
  const joint: JointAttack[] = [];
  const byCity = new Map<string, number[]>();
  for (const [i, b] of battles.entries()) byCity.set(b.city, [...(byCity.get(b.city) ?? []), i]);
  for (const idx of byCity.values()) {
    const links: [number, number][] = [];
    for (let x = 0; x < idx.length; x += 1) {
      const a = battles[idx[x]!]!;
      for (let y = x + 1; y < idx.length; y += 1) {
        const b = battles[idx[y]!]!;
        if (b.t - a.t > JOINT_WINDOW) break;
        if (a.attacker !== b.attacker && a.alliance !== null && a.alliance === b.alliance) {
          links.push([x, y]);
        }
      }
    }
    if (links.length === 0) continue;
    for (const g of groups(idx.length, links)) {
      const bs = g.map((k) => battles[idx[k]!]!);
      const players = sortIds(bs.map((b) => b.attacker));
      if (players.length < 2) continue;
      const first = bs[0]!;
      const call = sent.findLast(
        (c) =>
          c.target === first.city &&
          c.t <= first.t &&
          first.t - c.t <= CALL_LEAD &&
          players.includes(c.from) &&
          players.some((p) => p !== c.from && c.to.includes(p)),
      );
      joint.push({
        t: first.t,
        last: bs.at(-1)!.t,
        city: first.city,
        defender: first.defender,
        players,
        bots: players.map((p) => botAt(p, first.t)),
        battles: bs.length,
        caller: call?.from ?? null,
      });
    }
  }
  joint.sort((a, b) => a.t - b.t || byCodeUnit(a.city, b.city));

  let lastT: GameTime = 0;
  for (const line of lines) {
    if (line.k === "end") lastT = Math.max(lastT, line.result.endedAt);
    else if (line.k === "ev" || line.k === "act") lastT = Math.max(lastT, line.t);
  }
  for (const key of r.since.keys()) heldBy(key, lastT);
  const { best, reached, held } = r;
  const r1: R1Reach | null =
    initial === null
      ? null
      : {
          slots: initial.slots,
          need,
          needTaken,
          maxCities: best?.cities ?? 0,
          maxConquered: best?.conquered ?? 0,
          maxAt: best?.t ?? null,
          maxBloc: best === null ? [] : best.bloc.map((p) => botAt(p, best.t)),
          fightingMax: r.fightingMax,
          shortfall: r.fightingMax === null ? null : Math.max(0, need - r.fightingMax),
          mostConquered: r.mostConquered,
          reachedAt: reached?.t ?? null,
          reachedBy: reached === null ? [] : reached.bloc.map((p) => botAt(p, reached.t)),
          takenFromBloc: reached?.fromBloc ?? null,
          heldAt: held?.t ?? null,
        };
  return { joint, sieges, calls, callers, r1 };
}

// Per variant.

/** Sieges by how they were held and how they ended. */
export interface SiegeCounts {
  readonly sieges: number;
  /** The besieger sent or landed reinforcements (a support, or a later wave joining the garrison). */
  readonly reinforced: number;
  /** At least one relief battle was fought against the garrison. */
  readonly relieved: number;
  readonly conquered: number;
  /** Broken by a relief. */
  readonly broken: number;
  readonly abandoned: number;
  /** Broken by a homecoming or the besieger's elimination, still open at the end, or anything else. */
  readonly other: number;
}

/** A variant's teamwork over its runs. */
export interface TeamStat {
  readonly runs: number;
  /** Joint attacks: mean per run, runs with one, the total and those a war call preceded. */
  readonly joint: {
    readonly mean: number;
    readonly runs: number;
    readonly total: number;
    readonly called: number;
  };
  /** War-call messages, totals. */
  readonly calls: WarCallStat;
  /** Sieges, totals. */
  readonly sieges: SiegeCounts;
  /** R1 over the runs that know their map: the threshold (when the same for all), runs that met it, means. */
  readonly r1: {
    readonly runs: number;
    readonly need: number | null;
    /** The taken cities R1 asks for, when the same for all runs. */
    readonly needTaken: number | null;
    readonly reached: number;
    /** Runs where a bloc held R1 for the domination hold from the opening on (a win under R1). */
    readonly held: number;
    /** Means of the largest bloc's cities and conquered cities. */
    readonly maxCities: number | null;
    readonly maxConquered: number | null;
    /**
     * Runs where a bloc held the taken cities R1 asks for, the mean of the most cities it then
     * held, and the mean of what it lacked of the threshold (`R1Reach.shortfall`).
     */
    readonly fightingRuns: number;
    readonly fightingMax: number | null;
    readonly shortfall: number | null;
  };
}

/** One bot label's teamwork over a variant's runs. */
export interface TeamBotRow {
  readonly bot: string;
  /** Joint attacks it took part in as the caller, and without having called them. */
  readonly jointCalled: number;
  readonly jointJoined: number;
  /** Its sieges as the besieger. */
  readonly sieges: SiegeCounts;
  /** War-call messages it sent: calls, answers yes and no. */
  readonly calls: number;
  readonly yes: number;
  readonly no: number;
}

/** What `teamStat` and `teamBotRows` read of a match row. */
export interface TeamOfMatch {
  readonly joint: readonly JointAttack[];
  readonly sieges: readonly SiegeHold[];
  readonly warCalls: WarCallStat;
  readonly warCallers: Readonly<Record<string, { calls: number; yes: number; no: number }>>;
  readonly r1: R1Reach | null;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;
const meanOrNull = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : round2(xs.reduce((a, b) => a + b, 0) / xs.length);

/** Sieges counted by how they were held and ended. */
export function siegeCounts(list: readonly SiegeHold[]): SiegeCounts {
  const n = (f: (s: SiegeHold) => boolean): number => list.filter(f).length;
  return {
    sieges: list.length,
    reinforced: n((s) => s.joined > 0 || s.sent > 0),
    relieved: n((s) => s.reliefs > 0),
    conquered: n((s) => s.outcome === "conquered"),
    broken: n((s) => s.outcome === "relief"),
    abandoned: n((s) => s.outcome === "abandoned"),
    other: n((s) => !["conquered", "relief", "abandoned"].includes(s.outcome)),
  };
}

/** The teamwork of a variant's runs. */
export function teamStat(matches: readonly TeamOfMatch[]): TeamStat {
  const sum = (f: (m: TeamOfMatch) => number): number => matches.reduce((a, m) => a + f(m), 0);
  const known = matches.flatMap((m) => (m.r1 === null ? [] : [m.r1]));
  const needs = [...new Set(known.map((r) => r.need))];
  const takens = [...new Set(known.map((r) => r.needTaken))];
  const fighting = known.flatMap((r) => (r.fightingMax === null ? [] : [r.fightingMax]));
  return {
    runs: matches.length,
    joint: {
      mean: matches.length === 0 ? 0 : round2(sum((m) => m.joint.length) / matches.length),
      runs: matches.filter((m) => m.joint.length > 0).length,
      total: sum((m) => m.joint.length),
      called: sum((m) => m.joint.filter((j) => j.caller !== null).length),
    },
    calls: {
      calls: sum((m) => m.warCalls.calls),
      answered: sum((m) => m.warCalls.answered),
      yes: sum((m) => m.warCalls.yes),
      no: sum((m) => m.warCalls.no),
      cancels: sum((m) => m.warCalls.cancels),
      stray: sum((m) => m.warCalls.stray),
    },
    sieges: siegeCounts(matches.flatMap((m) => m.sieges)),
    r1: {
      runs: known.length,
      need: needs.length === 1 ? (needs[0] ?? null) : null,
      needTaken: takens.length === 1 ? (takens[0] ?? null) : null,
      reached: known.filter((r) => r.reachedAt !== null).length,
      held: known.filter((r) => r.heldAt !== null).length,
      maxCities: meanOrNull(known.map((r) => r.maxCities)),
      maxConquered: meanOrNull(known.map((r) => r.maxConquered)),
      fightingRuns: fighting.length,
      fightingMax: meanOrNull(fighting),
      shortfall: meanOrNull(known.flatMap((r) => (r.shortfall === null ? [] : [r.shortfall]))),
    },
  };
}

/** One row per bot label: joint attacks called and joined, sieges held, war messages sent. */
export function teamBotRows(matches: readonly TeamOfMatch[]): TeamBotRow[] {
  const called = new Map<string, number>();
  const joined = new Map<string, number>();
  const sieges = new Map<string, SiegeHold[]>();
  const sent = new Map<string, { calls: number; yes: number; no: number }>();
  const bots = new Set<string>();
  for (const m of matches) {
    for (const j of m.joint) {
      for (const [i, p] of j.players.entries()) {
        const bot = j.bots[i] ?? "?";
        bots.add(bot);
        const map = p === j.caller ? called : joined;
        map.set(bot, (map.get(bot) ?? 0) + 1);
      }
    }
    for (const s of m.sieges) {
      bots.add(s.bot);
      sieges.set(s.bot, [...(sieges.get(s.bot) ?? []), s]);
    }
    for (const [bot, c] of Object.entries(m.warCallers)) {
      bots.add(bot);
      const x = sent.get(bot) ?? { calls: 0, yes: 0, no: 0 };
      sent.set(bot, { calls: x.calls + c.calls, yes: x.yes + c.yes, no: x.no + c.no });
    }
  }
  return [...bots].toSorted(byCodeUnit).map((bot) => ({
    bot,
    jointCalled: called.get(bot) ?? 0,
    jointJoined: joined.get(bot) ?? 0,
    sieges: siegeCounts(sieges.get(bot) ?? []),
    calls: sent.get(bot)?.calls ?? 0,
    yes: sent.get(bot)?.yes ?? 0,
    no: sent.get(bot)?.no ?? 0,
  }));
}
