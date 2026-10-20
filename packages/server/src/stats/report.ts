import type { MatchStats, ModelStatsFile, RatingSet, StatsInterval } from "@perfidia/protocol";
import type { SeriesSummary } from "./aggregate.ts";
import type { PowerRow } from "./simulate.ts";
import { CLAIM_ALPHA, GAPS, neededFor } from "./power.ts";

// The `stats` command line's text: one match's seats, the per-model aggregate with its claim state
// and (when shown) its ratings, and the power table. Money in dollars from integer nano-dollars;
// figures withheld (`--no-costs`, or below the claim threshold) print as `-`. Every cell is
// `terminalText`: a run directory's strings (a lineup, a model id) cannot drive the terminal.

/** A character a terminal acts on or shows misleadingly: C0, DEL and C1 controls, bidi controls. */
export function controlChar(c: number): boolean {
  return (
    c < 0x20 ||
    (c >= 0x7f && c <= 0x9f) ||
    c === 0x200e ||
    c === 0x200f ||
    c === 0x061c ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069)
  );
}

/** Text safe for a terminal: C0 and C1 controls (escape sequences), DEL and bidi controls as `?`. */
export function terminalText(s: string): string {
  let out = "";
  for (const ch of s) out += controlChar(ch.codePointAt(0) ?? 0) ? "?" : ch;
  return out;
}

/** A cell that reads as a number (aligned right). */
const numeric = (s: string): boolean => /^[-+$]?[0-9][0-9.,%‰/ -]*$/.test(s) || s === "-";

/** A table: headers then rows, columns padded; numeric-looking cells aligned right. */
export function table(head: readonly string[], raw: readonly (readonly string[])[]): string {
  const rows = raw.map((r) => r.map(terminalText));
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: readonly string[]): string =>
    cells
      .map((c, i) => {
        const w = widths[i] ?? 0;
        return i > 0 && numeric(c) ? c.padStart(w) : c.padEnd(w);
      })
      .join("  ")
      .trimEnd();
  return `${[line(head), ...rows.map(line)].join("\n")}\n`;
}

/** `$1.2345` from nano-dollars; `-` for null. */
export function usd(nano: number | null | undefined): string {
  if (nano === null || nano === undefined) return "-";
  return `$${(nano / 1e9).toFixed(4)}`;
}

const num = (n: number | null | undefined): string =>
  n === null || n === undefined ? "-" : String(n);
const permille = (n: number | null | undefined): string =>
  n === null || n === undefined ? "-" : `${(n / 10).toFixed(1)}%`;
const iv = (x: StatsInterval | null, digits = 2): string =>
  x === null ? "-" : `[${x.lo.toFixed(digits)}, ${x.hi.toFixed(digits)}]`;
const sum = (rec: Readonly<Record<string, number>>): number =>
  Object.values(rec).reduce((a, b) => a + b, 0);

/** One match, seat by seat. */
export function formatMatch(m: MatchStats): string {
  const head = [
    `${m.match}: ${m.status}${m.result === null ? "" : ` (${m.result.reason}, winners ${m.result.winners.join(" ")})`}, ${m.verified ? "verified" : "NOT verified"}, ${m.rated ? "rated" : "not rated"}`,
    `${m.ruleset}, ${m.clock}; lineup ${m.lineup ?? "-"}${m.series === null ? "" : `; series ${m.series.lineup}, block ${m.series.block + 1}, match ${m.series.index}`}${m.fake ? "; fake models (bots behind the LLM pipe)" : ""}`,
    m.cost === null
      ? m.published.costs
        ? "cost: no llm_calls.jsonl"
        : "cost: not published (--no-costs)"
      : `cost: ${usd(m.cost.nanoUsd)} (start preflight ${usd(m.cost.preflightNanoUsd)}, probes ${usd(m.cost.probeNanoUsd)})${m.cost.budgetNanoUsd === null ? "" : `, budget ${usd(m.cost.budgetNanoUsd)}`}`,
  ];
  const rows = m.seats.map((s) => [
    s.seat,
    s.key,
    s.profile ?? "-",
    String(s.outcome.rank),
    String(s.outcome.cities),
    num(s.play.wakes),
    String(s.diplomacy.messagesSent),
    `${s.diplomacy.pactsKept}/${s.diplomacy.pactsBroken}`,
    `${s.diplomacy.betrayalsCommitted}/${s.diplomacy.betrayalsSuffered}`,
    String(s.military.battlesAttacked + s.military.battlesDefended),
    s.incidents.handoff === null
      ? "-"
      : `${s.incidents.handoff.reason ?? "?"}@${s.incidents.handoff.t}`,
    usd(s.cost?.nanoUsd),
    usd(s.cost?.perWakeNanoUsd),
    permille(s.cost?.cacheReadPermille),
    num(s.operations?.latencyMs?.p50),
    s.operations === null
      ? "-"
      : String(s.operations.toolErrors.malformed + s.operations.toolErrors.invalidArgs),
    permille(s.incidents.parallelPermille),
  ]);
  const t = table(
    [
      "seat",
      "item",
      "profile",
      "rank",
      "cities",
      "wakes",
      "msgs",
      "pacts kept/broken",
      "betrayals by/of",
      "battles",
      "hand-off",
      "cost",
      "$/wake",
      "cache",
      "p50 ms",
      "tool errs",
      "parallel",
    ],
    rows,
  );
  const c = m.collusion;
  const collusion =
    c.samePairs + c.crossPairs === 0
      ? ""
      : `same-model pairs ${c.samePairs} (messages ${c.same.messages}, pacts ${c.same.pacts}, alliances ${c.same.alliances}); cross-model pairs ${c.crossPairs} (messages ${c.cross.messages}, pacts ${c.cross.pacts}, alliances ${c.cross.alliances})\n`;
  return `${head.map(terminalText).join("\n")}\n${t}${collusion}`;
}

function formatRatings(name: string, set: RatingSet): string {
  if (set.items.length === 0) return `${name}: nothing to rate\n`;
  const items = table(
    ["id", "kind", "matches", "strength", "interval", "elo", "interval", "mean rank", "interval"],
    set.items.map((r) => [
      r.id,
      r.kind,
      String(r.matches),
      r.strength.toFixed(3),
      iv(r.interval, 3),
      r.elo.toFixed(0),
      iv(r.eloInterval, 0),
      r.meanRank.toFixed(2),
      iv(r.meanRankInterval),
    ]),
  );
  const pairs =
    set.pairs.length === 0
      ? ""
      : table(
          ["pair", "met", "a ahead", "difference", "interval"],
          set.pairs.map((p) => [
            `${p.a} vs ${p.b}`,
            String(p.matches),
            String(p.aAhead),
            p.difference.toFixed(3),
            iv(p.interval, 3),
          ]),
        );
  return `${name}: ${set.matches} matches, ${set.seats} seats\n${items}${pairs}`;
}

/** What the claim state says, in one paragraph. */
export function claimText(f: Pick<ModelStatsFile, "claims">): string {
  const c = f.claims;
  if (c.state === "no_comparison") {
    return "claims: no comparison (fewer than two LLM models met in a rated match): no ranking\n";
  }
  const others = c.table
    .filter((g) => g.gap !== c.gap)
    .map((g) => `${g.gap} needs ${g.needed}`)
    .join(", ");
  const head = `${c.models} models, ${c.pairs} pair(s), α ${c.alpha.toFixed(4)} per pair; the least-met pair met in ${c.matches} rated match(es); a ${c.gap} claim needs ${c.needed} (power now ${c.power.toFixed(2)}; ${others})`;
  return c.state === "ok"
    ? `claims: shown: ${head}\n`
    : `claims: too few matches, no ranking shown: ${head}: ${c.more} more\n`;
}

/** The per-model aggregate. */
export function formatModels(f: ModelStatsFile): string {
  const rated = f.matches.filter((m) => m.rated).length;
  const lines: string[] = [
    `${f.matches.length} match(es), ${rated} rated, ${f.blocks} block(s); grouping ${f.grouping}; costs ${f.published.costs ? "published" : "withheld (--no-costs)"}${f.exploratory ? "; EXPLORATORY: outcomes and ratings below the claim threshold, not a claim" : ""}`,
  ];
  for (const s of f.series) lines.push(seriesText(s));
  const head = lines.map(terminalText).join("\n");
  const models = table(
    [
      "id",
      "kind",
      "matches",
      "seats",
      "wakes",
      "cost/match",
      "$/wake",
      "cache",
      "p50 ms",
      "msgs",
      "pacts kept/broken",
      "betrayals by/of",
      "battles won",
      "tool errs",
      "hand-offs",
      "parallel",
      "mean rank",
      "wins",
    ],
    f.models.map((m) => [
      m.id,
      `${m.kind}${m.fake ? " (fake)" : ""}`,
      String(m.matches),
      String(m.seats),
      String(m.play.wakes),
      usd(m.cost?.perMatchNanoUsd),
      usd(m.cost?.perWakeNanoUsd),
      permille(m.cost?.cacheReadPermille),
      num(m.operations?.latencyMs?.p50),
      String(m.diplomacy.messagesSent),
      `${m.diplomacy.pactsKept}/${m.diplomacy.pactsBroken}`,
      `${m.diplomacy.betrayalsCommitted}/${m.diplomacy.betrayalsSuffered}`,
      String(m.military.battlesWon),
      m.operations === null
        ? "-"
        : String(m.operations.toolErrors.malformed + m.operations.toolErrors.invalidArgs),
      String(sum(m.handoffs)),
      permille(m.incidents.parallelPermille),
      m.outcome === null ? "-" : m.outcome.meanRank.toFixed(2),
      m.outcome === null ? "-" : String(m.outcome.wins),
    ]),
  );
  const lineups = f.models.flatMap((m) =>
    (m.cost?.byLineup ?? []).map((l) => [
      m.id,
      l.lineup,
      String(l.matches),
      usd(l.meanNanoUsd),
      l.interval === null ? "-" : `[${usd(l.interval.lo)}, ${usd(l.interval.hi)}]`,
    ]),
  );
  const costs =
    lineups.length === 0
      ? ""
      : `cost per match by lineup:\n${table(["id", "lineup", "matches", "mean", "interval"], lineups)}`;
  const r = f.ratings;
  const ratings =
    r === null
      ? ""
      : `ratings: MAP Plackett–Luce (prior σ ${r.priorSigma}), ${r.intervals.method === "laplace" ? `Laplace intervals (${r.intervals.blocks} block(s): fewer than 5)` : `Laplace intervals widened to a block bootstrap's over ${r.intervals.blocks} blocks, ${r.intervals.replicates} replicates, bootstrap seed ${r.intervals.bootstrapSeed}`}, ${Math.round(r.intervals.level * 100)}%; pairs at ${(r.intervals.pairLevel * 100).toFixed(2)}% (α ${(1 - r.intervals.pairLevel).toFixed(4)} per pair)\n${formatRatings("headline (every seat as it started)", r.headline)}${formatRatings("clean (handed-off seats left out)", r.clean)}`;
  return `${head}\n${claimText(f)}${models}${costs}${ratings}`;
}

function seriesText(s: SeriesSummary): string {
  return `series ${s.lineup}${s.fake ? " (fake)" : ""}: ${s.found} of ${s.planned} match(es) found; ${s.blocks} block(s) of ${s.order}${s.orthogonal ? " (Graeco-Latin)" : " (profiles not orthogonal)"}`;
}

/** The exact table of design §6.4 and the simulated power rows. */
export function formatPower(
  p: number,
  rows: readonly PowerRow[],
  o: { reps: number; replicates: number },
): string {
  const exact = table(
    ["gap", "one pair", "six pairs (Bonferroni)"],
    GAPS.map((g) => [g.label, String(neededFor(g.p, 1)), String(neededFor(g.p, 6))]),
  );
  const sim = table(
    [
      "matches",
      "exact 1",
      "binomial 1",
      "laplace 1",
      "bootstrap 1",
      "served 1",
      "exact 6",
      "binomial 6",
      "laplace 6",
    ],
    rows.map((r) => [
      String(r.matches),
      r.exact.one.toFixed(3),
      r.binomial.one.toFixed(3),
      r.laplace.one.toFixed(3),
      r.bootstrap === null ? "-" : r.bootstrap.toFixed(3),
      r.served === null ? "-" : r.served.toFixed(3),
      r.exact.six.toFixed(3),
      r.binomial.six.toFixed(3),
      r.laplace.six.toFixed(3),
    ]),
  );
  const what =
    p === 0.5
      ? `size at p = 0.5 (two equal models: every rate is a false claim, 0.05 nominal)`
      : `power at p = ${p} (head-to-head of the pair)`;
  return `matches needed for 80% power, exact two-sided binomial test, α ${CLAIM_ALPHA}:\n${exact}${what}, ${o.reps} simulated series per length, 4 models + 2 bots per match, blocks of 4${o.replicates > 0 ? `, ${o.replicates} bootstrap replicates (the bootstrap at every block count)` : ""}:\n${sim}`;
}
