import { fmtTime } from "@perfidia/engine/core";
import { table } from "../summary/index.ts";
import type { BatchResult, MatchRow, RunMean, VariantResult } from "./batch.ts";
import type { CountdownRow } from "./countdowns.ts";
import type { FirstTimeStat } from "./fights.ts";

// The batch tables (docs/architecture.md §12.2): one row per variant (or per match with
// `--per-match`), the fights table (end reasons, first battle, conquest and elimination, domination
// countdowns) per variant, the ends and land table (end counts, countdowns, free slots), the
// battles table (defended, empty, reliefs), the bots table (per bot label: wins per seat with
// their Wilson interval, score, cities, conquests, eliminations), every domination countdown, the
// teamwork table (joint attacks, war calls, R1 reach) and the sieges and teamwork by bot, with
// `--per-match` one row per match for the battles and land, one per seat and one per match for the
// teamwork, and with `--pacing` the per-day pacing table of §13.9. A variant name longer than its
// column is printed on a line of its own, its numbers on the next. Game times are printed on the
// game clock to the minute, `D1 13:12` (day 1, 13:12 after the match start).

const VARIANT_WIDTH = 30;
const f1 = (x: number): string => x.toFixed(1);
const f2 = (x: number): string => x.toFixed(2);
/** A nullable number to one decimal, `-` for null. */
const n1 = (x: number | null): string => (x === null ? "-" : f1(x));
const int = (x: number | null): string => (x === null ? "-" : String(x));

/** A game time on the game clock, to the minute (`D1 13:12`); `-` for none. */
export function gameClockText(t: number | null): string {
  return t === null ? "-" : fmtTime(t - (t % 60));
}

/** `mean / min` of a first-event time, with the number of runs when not every run had one. */
function firstText(stat: FirstTimeStat, runs: number): string {
  if (stat.runs === 0) return "-";
  const text = `${gameClockText(stat.mean)} / ${gameClockText(stat.min)}`;
  return stat.runs === runs ? text : `${text} (${stat.runs} of ${runs})`;
}

/** `a 3, b 1`, or `none` when there is nothing to count. */
function countsText(w: Readonly<Record<string, number>>, none = "none"): string {
  const parts = Object.entries(w).map(([s, n]) => `${s} ${n}`);
  return parts.length === 0 ? none : parts.join(", ");
}

/** Rows whose first cell is too long get it on a line of its own. */
function withLongNames(rows: readonly (readonly string[])[], right: ReadonlySet<number>): string[] {
  const fitted = rows.map((r) => ((r[0] ?? "").length > VARIANT_WIDTH ? ["", ...r.slice(1)] : r));
  const rendered = table(fitted, right);
  const out: string[] = [];
  for (const [i, r] of rows.entries()) {
    if ((r[0] ?? "").length > VARIANT_WIDTH) out.push(r[0] ?? "");
    out.push(rendered[i] ?? "");
  }
  return out;
}

/** One row per variant: runs, winners by strategy, end day, battles, conquests, eliminations, wakes. */
export function variantTable(result: BatchResult): string {
  const head = [
    "variant",
    "runs",
    "winners (by strategy)",
    "end day",
    "battles",
    "conquests",
    "elims",
    "wakes/seat/day (mean / max)",
  ];
  const rows = result.variants.map((v) => {
    const a = v.aggregate;
    return [
      v.text,
      `${a.runs}${a.fatal > 0 ? ` (${a.fatal} fatal)` : ""}`,
      countsText(a.winners),
      f1(a.endDay),
      f1(a.battles),
      f1(a.conquests),
      f1(a.eliminations),
      `${f1(a.wakesPerSeatPerDay.mean)} / ${a.wakesPerSeatPerDay.max}`,
    ];
  });
  return `${withLongNames([head, ...rows], new Set([1, 3, 4, 5, 6])).join("\n")}\n`;
}

function matchCells(v: VariantResult, m: MatchRow): string[] {
  return [
    v.text,
    String(m.seed),
    m.status === "ended" ? (m.reason ?? "?") : m.status,
    m.winners.length === 0 ? "-" : `${m.winners.join(",")} (${m.winnerStrategies.join(",")})`,
    m.endDay === null ? "-" : f1(m.endDay),
    String(m.battles),
    String(m.conquests),
    String(m.eliminations),
    gameClockText(m.firstBattleT),
    gameClockText(m.firstConquestT),
    gameClockText(m.firstEliminationT),
    m.dominationCountdowns === 0
      ? "-"
      : `${m.dominationCountdowns} from ${gameClockText(m.firstDominationT)}`,
    `${f1(m.wakesPerSeatPerDay.mean)} / ${m.wakesPerSeatPerDay.max}`,
    m.finalHash ?? "-",
  ];
}

/** `--per-match`: one row per match. */
export function matchTable(result: BatchResult): string {
  const head = [
    "variant",
    "seed",
    "end",
    "winners",
    "end day",
    "battles",
    "conquests",
    "elims",
    "1st battle",
    "1st conquest",
    "1st elim",
    "countdowns",
    "wakes/seat/day",
    "final hash",
  ];
  const rows = result.variants.flatMap((v) =>
    v.matches.map((m, i) => (i === 0 ? matchCells(v, m) : ["", ...matchCells(v, m).slice(1)])),
  );
  return `${withLongNames([head, ...rows], new Set([1, 4, 5, 6, 7])).join("\n")}\n`;
}

/**
 * Per variant: the end reasons, the first battle, conquest and elimination (mean and earliest over
 * the runs that had one), the runs with an elimination and with a domination countdown, and who
 * eliminated whom (bot versions: an elimination count may be one predator and one prey).
 */
export function fightTable(result: BatchResult): string {
  const head = [
    "variant",
    "runs",
    "ends",
    "1st battle (mean / min)",
    "1st conquest (mean / min)",
    "1st elim (mean / min)",
    "runs with elim",
    "runs with countdown",
    "elims (who > whom)",
  ];
  const rows = result.variants.map((v) => {
    const a = v.aggregate;
    return [
      v.text,
      String(a.runs),
      countsText(a.reasons, "-"),
      firstText(a.firstBattle, a.runs),
      firstText(a.firstConquest, a.runs),
      firstText(a.firstElimination, a.runs),
      String(a.runsWithElimination),
      String(a.runsWithCountdown),
      countsText(a.eliminationsBy, "-"),
    ];
  });
  const title = "fights · game clock to the minute, mean / earliest over the runs that had one";
  return `${title}\n${withLongNames([head, ...rows], new Set([1, 6, 7])).join("\n")}\n`;
}

/** `--pacing`: per variant and game day, the measures of §13.9 averaged over the seeds. */
export function pacingTable(result: BatchResult): string {
  const head = [
    "variant",
    "day",
    "runs",
    "cities/player mean",
    "min",
    "max",
    "free slots",
    "army pop",
    "score",
    "battles",
    "conquests",
    "elims",
    "sieges started",
    "held",
    "broken",
  ];
  const rows = result.variants.flatMap((v) =>
    (v.pacing ?? []).map((d, i) => [
      i === 0 ? v.text : "",
      `D${d.day}`,
      String(d.runs),
      f1(d.citiesMean),
      String(d.citiesMin),
      String(d.citiesMax),
      f1(d.freeSlots),
      f1(d.armyPopMean),
      f1(d.scoreMean),
      f1(d.battles),
      f1(d.conquests),
      f1(d.eliminations),
      f1(d.siegesStarted),
      f1(d.siegesHeld),
      f1(d.siegesBroken),
    ]),
  );
  const title = `pacing · N = ${result.players} · ${result.seeds.length} seed(s) per variant · measured at the end of each game day`;
  return `${title}\n${withLongNames([head, ...rows], new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])).join("\n")}\n`;
}

/** A run mean, with the number of runs when not every run had it. */
function runMeanText(m: RunMean, runs: number): string {
  if (m.mean === null) return "-";
  return m.runs === runs ? f1(m.mean) : `${f1(m.mean)} (${m.runs})`;
}

/**
 * Per variant: ended runs by end reason (domination and last standing apart), the domination
 * countdowns (opened, won, cancelled, open; bloc cities at their start split into conquered,
 * founded and starting cities, totals) and the free city slots (mean at the end of D5, of D7 or at
 * an earlier match end, and at the match end).
 */
export function endsTable(result: BatchResult): string {
  const head = [
    "variant",
    "runs",
    "time",
    "domination",
    "last standing",
    "other",
    "countdowns",
    "won",
    "cancelled",
    "open",
    "bloc cities: conquered / founded / initial",
    "free slots D5 / D7 / end",
  ];
  const rows = result.variants.map((v) => {
    const a = v.aggregate;
    const c = a.countdowns;
    const runs = a.runs - a.fatal;
    return [
      v.text,
      String(a.runs),
      String(a.ends.time),
      String(a.ends.domination),
      String(a.ends.lastStanding),
      String(a.ends.other),
      String(c.opened),
      String(c.won),
      String(c.cancelled),
      String(c.open),
      c.opened === 0 ? "-" : `${c.cities}: ${c.conquered} / ${c.founded} / ${c.initial}`,
      `${runMeanText(a.freeSlots.d5, runs)} / ${runMeanText(a.freeSlots.d7, runs)} / ${runMeanText(a.freeSlots.end, runs)}`,
    ];
  });
  const title =
    "ends and land · countdown bloc cities at their start (totals) · free slots: mean at the end of D5, of D7 (or the earlier match end) and at the match end, (n) runs when not all";
  return `${title}\n${withLongNames([head, ...rows], new Set([1, 2, 3, 4, 5, 6, 7, 8, 9])).join("\n")}\n`;
}

/** Per variant, means per run: battles defended or empty, reliefs and homecomings. */
export function battlesTable(result: BatchResult): string {
  const head = [
    "variant",
    "runs",
    "battles",
    "defended",
    "empty",
    "unknown",
    "relief",
    "by owner",
    "broke siege",
    "homecoming",
  ];
  const rows = result.variants.map((v) => {
    const a = v.aggregate;
    const b = a.battleSplit;
    return [
      v.text,
      String(a.runs),
      f1(a.battles),
      f1(b.defended),
      f1(b.empty),
      f1(b.unknown),
      f2(b.relief),
      f2(b.reliefByOwner),
      f2(b.reliefBroke),
      f2(b.homecoming),
    ];
  });
  const title =
    "battles · mean per run · defended: a defending unit present, empty: none · relief: fought against the besieger of a held siege (by the city's owner, or breaking the siege)";
  return `${title}\n${withLongNames([head, ...rows], new Set([1, 2, 3, 4, 5, 6, 7, 8, 9])).join("\n")}\n`;
}

/**
 * Per variant and bot label, over the seats of the ended runs: wins per seat with its 95% Wilson
 * interval, then means per seat (score and its parts, cities at the end, founded, conquered, lost)
 * and totals (eliminations suffered and inflicted).
 */
export function strategyTable(result: BatchResult): string {
  const head = [
    "variant",
    "bot",
    "seats",
    "wins",
    "wins/seat [95% CI]",
    "score",
    "city pts",
    "levels",
    "crown",
    "battle",
    "cities",
    "founded",
    "conquered",
    "lost",
    "elims suffered",
    "inflicted",
  ];
  const rows = result.variants.flatMap((v) =>
    v.aggregate.strategies.map((b, i) => [
      i === 0 ? v.text : "",
      b.bot,
      String(b.seats),
      String(b.wins),
      `${f2(b.winsPerSeat)} [${f2(b.winsPerSeatCi[0])}, ${f2(b.winsPerSeatCi[1])}]`,
      n1(b.score),
      n1(b.cityPoints),
      n1(b.levelPoints),
      n1(b.crownPoints),
      n1(b.battleScore),
      n1(b.cities),
      f1(b.founded),
      f1(b.conquered),
      f1(b.lost),
      String(b.eliminated),
      String(b.inflicted),
    ]),
  );
  const title =
    "bots · per seat over the ended runs · wins/seat with its 95% Wilson interval · means per seat, eliminations in total";
  return `${title}\n${withLongNames([head, ...rows], new Set([2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])).join("\n")}\n`;
}

/** `p2 expander@1 + p4 opportunist@1`, with the alliance key first when the bloc is one. */
function blocText(c: CountdownRow): string {
  const members = c.members.map((m, i) => `${m} ${c.bots[i] ?? "?"}`).join(" + ");
  return c.members.some((m) => m === c.key) ? members : `${c.key}: ${members}`;
}

function outcomeText(c: CountdownRow): string {
  if (c.outcome !== "cancelled") return c.outcome;
  const why = c.detail.length === 0 ? "" : ` (${c.detail.join(", ")})`;
  return `cancelled: ${c.reason ?? "?"}${why}`;
}

/** Every domination countdown: bloc, cities at the start and their origin, how it ended. Empty when none. */
export function countdownTable(result: BatchResult): string {
  const head = [
    "variant",
    "seed",
    "start",
    "end",
    "bloc",
    "cities (threshold), taken (needed)",
    "conquered / founded / initial",
    "outcome",
  ];
  const rows = result.variants.flatMap((v) => {
    const list = v.matches.flatMap((m) => m.countdowns.map((c) => ({ seed: m.seed, c })));
    return list.map(({ seed, c }, i) => [
      i === 0 ? v.text : "",
      String(seed),
      gameClockText(c.t),
      gameClockText(c.endedAt ?? c.endsAt),
      blocText(c),
      `${c.cities}${c.threshold === null ? "" : ` (${c.threshold})`}${c.taken === undefined ? "" : `, taken ${c.taken}${c.needTaken === undefined ? "" : ` (${c.needTaken})`}`}`,
      `${c.conquered} / ${c.founded} / ${c.initial}`,
      outcomeText(c),
    ]);
  });
  if (rows.length === 0) return "";
  const title =
    "domination countdowns · bloc cities at the start: conquered / founded / initial · end: when won or cancelled, else when due";
  return `${title}\n${withLongNames([head, ...rows], new Set([1])).join("\n")}\n`;
}

/** `--per-match`: battles, reliefs, free slots and countdowns of each match. */
export function matchLandTable(result: BatchResult): string {
  const head = [
    "variant",
    "seed",
    "battles",
    "defended",
    "empty",
    "relief",
    "broke siege",
    "homecoming",
    "free slots D5",
    "D7",
    "end",
    "countdowns (won / cancelled / open)",
  ];
  const rows = result.variants.flatMap((v) =>
    v.matches.map((m, i) => {
      const b = m.battleSplit;
      const c = m.countdowns;
      const count = (o: CountdownRow["outcome"]): number => c.filter((x) => x.outcome === o).length;
      return [
        i === 0 ? v.text : "",
        String(m.seed),
        String(m.battles),
        String(b.defended),
        String(b.empty),
        String(b.relief),
        String(b.reliefBroke),
        String(b.homecoming),
        int(m.freeSlots?.d5 ?? null),
        int(m.freeSlots?.d7 ?? null),
        int(m.freeSlots?.end ?? null),
        c.length === 0
          ? "-"
          : `${c.length} (${count("won")} / ${count("cancelled")} / ${count("open")})`,
      ];
    }),
  );
  const title = "battles and land per match";
  return `${title}\n${withLongNames([head, ...rows], new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).join("\n")}\n`;
}

/** `--per-match`: one row per seat of each match. */
export function seatTable(result: BatchResult): string {
  const head = [
    "variant",
    "seed",
    "seat",
    "bot",
    "rank",
    "score",
    "city pts",
    "levels",
    "crown",
    "battle",
    "battle pts",
    "cities",
    "founded",
    "conquered",
    "lost",
    "eliminated",
    "by",
    "elims",
  ];
  const rows = result.variants.flatMap((v) =>
    v.matches.flatMap((m, mi) =>
      m.seats.map((x, i) => [
        mi === 0 && i === 0 ? v.text : "",
        i === 0 ? String(m.seed) : "",
        x.seat,
        `${x.bot}${x.winner ? " *" : ""}`,
        int(x.rank),
        int(x.score),
        int(x.cityPoints),
        int(x.levelPoints),
        int(x.crownPoints),
        int(x.battleScore),
        int(x.battlePoints),
        int(x.cities),
        String(x.founded),
        String(x.conquered),
        String(x.lost),
        gameClockText(x.eliminatedAt),
        x.eliminatedBy ?? "-",
        String(x.eliminations),
      ]),
    ),
  );
  const title =
    "seats · * winner · score parts from the final standings (levels and crown derived when not exposed) · battle pts: credited before the cap";
  return `${title}\n${withLongNames([head, ...rows], new Set([1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17])).join("\n")}\n`;
}

/** A mean to 2 decimals, `-` for null. */
const n2 = (x: number | null): string => (x === null ? "-" : f2(x));

/**
 * Per variant, teamwork: joint attacks (mean per run, runs with one, those a war call preceded),
 * the war-call messages (calls, calls answered, answers yes and no, cancels) and how near a bloc came
 * to R1 (its threshold in cities and taken cities, runs that met it, the largest bloc's cities and
 * conquered cities, and the most cities a bloc held with the taken cities R1 asks for: means over
 * the runs).
 */
export function teamTable(result: BatchResult): string {
  const head = [
    "variant",
    "runs",
    "joint attacks/run",
    "runs with one",
    "after a call",
    "war calls",
    "answered",
    "yes",
    "no",
    "cancels",
    "R1 need",
    "taken",
    "R1 met",
    "R1 held",
    "largest bloc: cities / taken",
    "bloc with the taken cities: cities (runs), short of need",
  ];
  const rows = result.variants.map((v) => {
    const t = v.aggregate.team;
    return [
      v.text,
      String(t.runs),
      f2(t.joint.mean),
      String(t.joint.runs),
      String(t.joint.called),
      String(t.calls.calls),
      String(t.calls.answered),
      String(t.calls.yes),
      String(t.calls.no),
      String(t.calls.cancels),
      int(t.r1.need),
      int(t.r1.needTaken),
      `${t.r1.reached} of ${t.r1.runs}`,
      `${t.r1.held} of ${t.r1.runs}`,
      `${n1(t.r1.maxCities)} / ${n2(t.r1.maxConquered)}`,
      t.r1.fightingRuns === 0
        ? "-"
        : `${n1(t.r1.fightingMax)} (${t.r1.fightingRuns}), ${n1(t.r1.shortfall)}`,
    ];
  });
  const title =
    "teamwork · joint attack: battles at one city by ≥ 2 players allied at the time, landing within 60 min · war calls: private WAR# messages · R1 (perfidia-1@1.1.0 §13.3 with each match's own numbers; a 1.0.0 log with 1.1.0's defaults): a bloc with ≥ need cities (dominationPm of the map's city slots, at least dominationMinPerPlayer × N), ≥ taken of them taken (conquered, and no member of the bloc owned them before); `-` when the runs differ; held: for time.dominationHold from time.dominationStart, ending by time.matchEnd";
  return `${title}\n${withLongNames([head, ...rows], new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])).join("\n")}\n`;
}

/** `n (p%)` of a part of `total`, `0` when there is none. */
function partText(n: number, total: number): string {
  return n === 0 || total === 0 ? String(n) : `${n} (${Math.round((100 * n) / total)}%)`;
}

/**
 * Per variant, sieges (all, then per bot label as the besieger) by how they were held and ended,
 * and per bot label its joint attacks (called, joined) and war messages (calls, answers yes / no).
 */
export function siegeTable(result: BatchResult): string {
  const head = [
    "variant",
    "besieger",
    "sieges",
    "reinforced",
    "relief came",
    "conquered",
    "broken by relief",
    "abandoned",
    "other",
    "joint: called",
    "joined",
    "war calls",
    "yes / no",
  ];
  const rows = result.variants.flatMap((v) => {
    const all = v.aggregate.team.sieges;
    const total = [
      v.text,
      "all",
      String(all.sieges),
      partText(all.reinforced, all.sieges),
      partText(all.relieved, all.sieges),
      partText(all.conquered, all.sieges),
      partText(all.broken, all.sieges),
      partText(all.abandoned, all.sieges),
      partText(all.other, all.sieges),
      String(v.aggregate.team.joint.called),
      String(v.aggregate.team.joint.total),
      String(v.aggregate.team.calls.calls),
      `${v.aggregate.team.calls.yes} / ${v.aggregate.team.calls.no}`,
    ];
    const bots = v.aggregate.teamBots.map((b) => {
      const g = b.sieges;
      return [
        "",
        b.bot,
        String(g.sieges),
        partText(g.reinforced, g.sieges),
        partText(g.relieved, g.sieges),
        partText(g.conquered, g.sieges),
        partText(g.broken, g.sieges),
        partText(g.abandoned, g.sieges),
        partText(g.other, g.sieges),
        String(b.jointCalled),
        String(b.jointJoined),
        String(b.calls),
        `${b.yes} / ${b.no}`,
      ];
    });
    return [total, ...bots];
  });
  const title =
    "sieges and teamwork by bot · totals over the runs · reinforced: the besieger sent a support or a later wave joined its garrison · other: a homecoming, the besieger eliminated, or still open at the end · joint: attacks called (by a war call) and joined (all: joint attacks in total)";
  return `${title}\n${withLongNames([head, ...rows], new Set([2, 9, 10, 11])).join("\n")}\n`;
}

/** `--per-match`: the joint attacks, sieges, war calls and R1 reach of each match. */
export function matchTeamTable(result: BatchResult): string {
  const head = [
    "variant",
    "seed",
    "joint attacks",
    "sieges: conquered / relief / abandoned / other (reinforced)",
    "war calls (answered)",
    "largest bloc",
    "R1 met",
  ];
  const rows = result.variants.flatMap((v) =>
    v.matches.map((m, i) => {
      const s = m.sieges;
      const n = (o: string): number => s.filter((x) => x.outcome === o).length;
      const conquered = n("conquered");
      const relief = n("relief");
      const abandoned = n("abandoned");
      const reinforced = s.filter((x) => x.joined > 0 || x.sent > 0).length;
      const joint =
        m.joint.length === 0
          ? "-"
          : m.joint
              .slice(0, 3)
              .map((j) => `${j.city} ${j.players.join("+")} ${gameClockText(j.t)}`)
              .join(", ") + (m.joint.length > 3 ? ` +${m.joint.length - 3}` : "");
      const r1 = m.r1;
      return [
        i === 0 ? v.text : "",
        String(m.seed),
        joint,
        s.length === 0
          ? "-"
          : `${conquered} / ${relief} / ${abandoned} / ${s.length - conquered - relief - abandoned} (${reinforced})`,
        `${m.warCalls.calls} (${m.warCalls.answered})`,
        r1 === null ? "-" : `${r1.maxCities} / ${r1.maxConquered} (${r1.maxBloc.join(" + ")})`,
        r1 === null || r1.reachedAt === null
          ? "-"
          : `${gameClockText(r1.reachedAt)}${r1.heldAt === null ? "" : `, held ${gameClockText(r1.heldAt)}`}${r1.takenFromBloc === null || r1.takenFromBloc === 0 ? "" : `, ${r1.takenFromBloc} taken in bloc`}`,
      ];
    }),
  );
  const title =
    "teamwork per match · joint attacks: city, attackers, first landing · largest bloc: cities / conquered (members)";
  return `${title}\n${withLongNames([head, ...rows], new Set([1])).join("\n")}\n`;
}
