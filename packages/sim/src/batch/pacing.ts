import { verifyLog, type ReadCtx, type ReplayReport } from "@perfidia/engine";
import { DAY } from "@perfidia/engine/core";
import { sortedIds, unitsPop } from "@perfidia/engine/std";
import type { LogLine } from "@perfidia/protocol";

// The pacing measurement (docs/architecture.md §13.9, perfidia-1 §19.5): each run is replayed
// through `verifyLog` with `onCheckpoint`, and at the end of every game day (the checkpoint of hour
// 24·d, or the final state for the day the match ends in) the state gives cities per player, free
// slots, army pop and score; the day's battles and sieges come from its `ev` lines. Reported, never
// asserted.

export interface PacingDay {
  /** 1-based game day; its measures are taken at its end. */
  readonly day: number;
  readonly citiesMean: number;
  readonly citiesMin: number;
  readonly citiesMax: number;
  /** Free city slots left on the whole map. */
  readonly freeSlots: number;
  /** Pop of every unit a player owns (home, stationed, moving), mean over the seats. */
  readonly armyPopMean: number;
  /** Mean of the standings' scores. */
  readonly scoreMean: number;
  /** Events of the day, `(d − 1)·86400 < t ≤ d·86400` (day 1 includes t = 0). */
  readonly battles: number;
  readonly siegesStarted: number;
  readonly siegesHeld: number;
  readonly siegesBroken: number;
}

interface StateMeasures {
  readonly citiesMean: number;
  readonly citiesMin: number;
  readonly citiesMax: number;
  readonly freeSlots: number;
  readonly armyPopMean: number;
  readonly scoreMean: number;
}

interface EventMeasures {
  battles: number;
  siegesStarted: number;
  siegesHeld: number;
  siegesBroken: number;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;
const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : round2(xs.reduce((a, b) => a + b, 0) / xs.length);

/** The day an event or a match end at `t` counts for: `max(1, ceil(t / 86400))`. */
export function dayOf(t: number): number {
  return Math.max(1, Math.ceil(t / DAY));
}

/** The state measures of the pacing table at one moment. */
export function measureState(r: ReadCtx): StateMeasures {
  const s = r.state;
  const players = sortedIds(s.players);
  const cities = new Map<string, number>(players.map((p) => [p, 0]));
  const army = new Map<string, number>(players.map((p) => [p, 0]));
  const used = new Map<string, number>();
  const addArmy = (p: string, pop: number): void => {
    if (army.has(p)) army.set(p, (army.get(p) ?? 0) + pop);
  };
  for (const c of Object.values(s.cities)) {
    used.set(c.island, (used.get(c.island) ?? 0) + 1);
    if (c.owner !== null) {
      if (cities.has(c.owner)) cities.set(c.owner, (cities.get(c.owner) ?? 0) + 1);
      addArmy(c.owner, unitsPop(r.rules, c.units));
    }
    for (const g of c.stationed) addArmy(g.owner, unitsPop(r.rules, g.units));
  }
  for (const m of Object.values(s.movements)) addArmy(m.owner, unitsPop(r.rules, m.units));
  let freeSlots = 0;
  for (const isl of Object.values(s.islands)) {
    freeSlots += Math.max(0, isl.slots - (used.get(isl.id) ?? 0));
  }
  const counts = [...cities.values()];
  const scores = r.ruleset.hooks.standings(r).map((st) => st.score);
  return {
    citiesMean: mean(counts),
    citiesMin: Math.min(...counts),
    citiesMax: Math.max(...counts),
    freeSlots,
    armyPopMean: mean([...army.values()]),
    scoreMean: mean(scores),
  };
}

/** The battles and sieges of each day, from the `ev` lines. */
function eventMeasures(lines: Iterable<LogLine>): Map<number, EventMeasures> {
  const out = new Map<number, EventMeasures>();
  const open = new Set<string>();
  const at = (t: number): EventMeasures => {
    const d = dayOf(t);
    let m = out.get(d);
    if (m === undefined) {
      m = { battles: 0, siegesStarted: 0, siegesHeld: 0, siegesBroken: 0 };
      out.set(d, m);
    }
    return m;
  };
  for (const line of lines) {
    if (line.k !== "ev") continue;
    const e = line.e;
    const raw = Object.hasOwn(e.data, "city") ? e.data["city"] : undefined;
    const city = typeof raw === "string" ? raw : null;
    if (e.type === "battle") at(line.t).battles += 1;
    else if (e.type === "siege_started") {
      at(line.t).siegesStarted += 1;
      if (city !== null) open.add(city);
    } else if (e.type === "siege_broken") {
      at(line.t).siegesBroken += 1;
      if (city !== null) open.delete(city);
    } else if (e.type === "city_conquered" && city !== null && open.delete(city)) {
      at(line.t).siegesHeld += 1;
    }
  }
  return out;
}

/**
 * The pacing days of a log, replayed at Level E (the report says whether the replay matched the
 * log; a divergence stops the measures where it occurred).
 */
export function pacingOf(lines: readonly LogLine[]): {
  readonly report: ReplayReport;
  readonly days: PacingDay[];
} {
  const states = new Map<number, StateMeasures>();
  const report = verifyLog(lines, {
    onCheckpoint(hour, r) {
      if (hour % 24 === 0) states.set(hour / 24, measureState(r));
    },
    onLine(line, r) {
      if (line.k === "end" && !states.has(dayOf(line.t)))
        states.set(dayOf(line.t), measureState(r));
    },
  });
  const events = eventMeasures(lines);
  const days = [...states.keys()]
    .toSorted((a, b) => a - b)
    .map((day): PacingDay => {
      const s = states.get(day);
      const e = events.get(day);
      return {
        day,
        citiesMean: s?.citiesMean ?? 0,
        citiesMin: s?.citiesMin ?? 0,
        citiesMax: s?.citiesMax ?? 0,
        freeSlots: s?.freeSlots ?? 0,
        armyPopMean: s?.armyPopMean ?? 0,
        scoreMean: s?.scoreMean ?? 0,
        battles: e?.battles ?? 0,
        siegesStarted: e?.siegesStarted ?? 0,
        siegesHeld: e?.siegesHeld ?? 0,
        siegesBroken: e?.siegesBroken ?? 0,
      };
    });
  return { report, days };
}

/** One row of a variant's pacing table: the day's measures averaged over the matches that reached it. */
export interface PacingRow extends PacingDay {
  /** Matches with a measure for this day. */
  readonly runs: number;
}

/** Per day: means over the matches, except `citiesMin` (the lowest) and `citiesMax` (the highest). */
export function aggregatePacing(matches: readonly (readonly PacingDay[])[]): PacingRow[] {
  const byDay = new Map<number, PacingDay[]>();
  for (const days of matches) {
    for (const d of days) {
      const list = byDay.get(d.day) ?? [];
      list.push(d);
      byDay.set(d.day, list);
    }
  }
  return [...byDay.keys()]
    .toSorted((a, b) => a - b)
    .map((day): PacingRow => {
      const list = byDay.get(day) ?? [];
      const avg = (f: (d: PacingDay) => number): number => mean(list.map(f));
      return {
        day,
        runs: list.length,
        citiesMean: avg((d) => d.citiesMean),
        citiesMin: Math.min(...list.map((d) => d.citiesMin)),
        citiesMax: Math.max(...list.map((d) => d.citiesMax)),
        freeSlots: avg((d) => d.freeSlots),
        armyPopMean: avg((d) => d.armyPopMean),
        scoreMean: avg((d) => d.scoreMean),
        battles: avg((d) => d.battles),
        siegesStarted: avg((d) => d.siegesStarted),
        siegesHeld: avg((d) => d.siegesHeld),
        siegesBroken: avg((d) => d.siegesBroken),
      };
    });
}
