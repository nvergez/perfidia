import type {
  Claims,
  ModelAggregate,
  ModelsResponse,
  RatingItem,
  Ratings,
} from "@perfidia/protocol/spectator";
import { Info, Scale, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { AppLink } from "../common/link.tsx";
import { NotPublished } from "../common/not-published.tsx";
import { cn } from "../lib/cn.ts";
import { fmtInt, plural } from "../lib/format.ts";
import { effortWords, modelName, providerName, servingProvider } from "../lib/models.ts";
import { matchHref, modelHref } from "../lib/router.ts";
import {
  balanceWords,
  claimExplanation,
  claimHeadline,
  countsWords,
  displayOrder,
  fmtFixed,
  fmtInterval,
  fmtPermille,
  fmtProb,
  fmtUsdFine,
  intervalWords,
  itemName,
  rankingShown,
  ratingOrder,
  rehearsedModel,
  scalePercent,
  separated,
  seriesWords,
  shownClaim,
  shownRatings,
  total,
} from "./format.ts";

// The parts of the model statistics pages (`models-page.tsx`): the claim state, the ratings (shown
// only once the claim threshold is met), the per-model table, and the matches the statistics
// cover. Plain text only: ids, keys and lineups are the operator's strings, shown as text.

export type Item = ModelAggregate;

/**
 * Who an item is, in a line under its name: provider, endpoint and effort in the vendor's terms
 * ("OpenRouter · z-ai/fp8 · reasoning effort low"), a rehearsal, or a bot.
 */
export function itemLine(m: Item): string {
  if (m.kind === "bot") return "Scripted bot (a reference player)";
  if (m.model === null) return m.key;
  const ref = m.fake ? rehearsedModel(m.model) : m.model;
  const provider = servingProvider(ref);
  const effort = effortWords(provider, m.model.effort);
  if (m.fake) return `Rehearsal: a scripted bot · ${effort}`;
  const ep = m.model.endpoint;
  return `${providerName(provider)}${ep === null ? "" : ` · ${ep}`} · ${effort}`;
}

/** A short name for a seat in a match's lineup: "GPT-6 Luna", "Fake for GLM-5.3 Flash". */
export function itemShort(m: Item | undefined, fallback: string): string {
  if (m === undefined) return fallback;
  if (m.kind === "bot") return m.key.replace(/^bot:/, "");
  if (m.model === null) return m.key;
  const short = modelName(m.model.model);
  return m.fake ? `Fake for ${short}` : short;
}

export function Section({
  title,
  icon: Icon,
  children,
  testId,
  note,
}: {
  readonly title: string;
  readonly icon?: typeof Info;
  readonly children: ReactNode;
  readonly testId?: string;
  readonly note?: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3" data-testid={testId}>
      <div className="flex flex-col gap-1">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-wider uppercase">
          {Icon === undefined ? null : <Icon className="size-4" aria-hidden="true" />}
          {title}
        </h2>
        {note === undefined ? null : <p className="text-muted-foreground text-sm">{note}</p>}
      </div>
      {children}
    </section>
  );
}

/** The claim state: a ranking above the threshold, else how many more matches it needs. */
export function ClaimsPanel({
  claims,
  compact = false,
  names,
}: {
  readonly claims: Claims;
  readonly compact?: boolean;
  /** Display names by model id (for the rotation's imbalances). */
  readonly names?: ReadonlyMap<string, string>;
}) {
  const ok = rankingShown(claims);
  const balance = balanceWords(claims, (id) => names?.get(id) ?? id);
  return (
    <div
      role="note"
      data-testid="claims"
      data-claims={claims.state}
      className={cn(
        "flex flex-col gap-2 rounded-xl border p-4 text-sm",
        ok ? "border-primary/50 bg-primary/5" : "border-gold/50 bg-gold/5",
      )}
    >
      <p className="flex items-start gap-2 font-medium">
        {ok ? (
          <Scale className="text-primary mt-0.5 size-4 shrink-0" aria-hidden="true" />
        ) : (
          <TriangleAlert className="text-gold mt-0.5 size-4 shrink-0" aria-hidden="true" />
        )}
        <span data-testid="claims-headline">{claimHeadline(claims)}.</span>
      </p>
      {ok ? null : (
        <p>
          No ranking is shown until then: the models are listed by name, and no rank, rating or win
          count appears.
        </p>
      )}
      {balance === null ? null : <p data-testid="claims-balance">{balance}</p>}
      {compact ? null : (
        <>
          <p className="text-muted-foreground">{claimExplanation(claims)}</p>
          {claims.table.length === 0 ? null : (
            <div className="overflow-x-auto">
              <p className="text-muted-foreground mb-1 text-xs">
                Matches each pair needs for other gaps (80% power), and the power now:
              </p>
              <table className="text-xs" aria-label="Matches needed by head-to-head gap">
                <thead>
                  <tr className="text-muted-foreground text-left">
                    <th scope="col" className="pr-4 font-medium">
                      Head-to-head gap
                    </th>
                    <th scope="col" className="pr-4 text-right font-medium">
                      Matches needed
                    </th>
                    <th scope="col" className="text-right font-medium">
                      Power now
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {claims.table.map((r) => (
                    <tr key={r.gap} className={r.gap === claims.gap ? "font-semibold" : undefined}>
                      <td className="pr-4">{r.gap}</td>
                      <td className="pr-4 text-right tabular-nums">{fmtInt(r.needed)}</td>
                      <td className="text-right tabular-nums">{fmtProb(r.power)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Ratings (above the threshold only) -----------------------------------------------------------

function IntervalBar({
  value,
  lo,
  hi,
  min,
  max,
}: {
  readonly value: number;
  readonly lo: number;
  readonly hi: number;
  readonly min: number;
  readonly max: number;
}) {
  const a = scalePercent(lo, min, max);
  const b = scalePercent(hi, min, max);
  const v = scalePercent(value, min, max);
  return (
    <span aria-hidden="true" className="bg-muted relative block h-2 w-full min-w-24 rounded-full">
      <span
        className="bg-primary/40 absolute inset-y-0 rounded-full"
        style={{ left: `${a}%`, width: `${Math.max(1, b - a)}%` }}
      />
      <span
        className="bg-primary absolute inset-y-[-2px] w-0.5 rounded-full"
        style={{ left: `${v}%` }}
      />
    </span>
  );
}

function RatingTable({
  items,
  names,
  caption,
}: {
  readonly items: readonly RatingItem[];
  readonly names: ReadonlyMap<string, string>;
  readonly caption: string;
}) {
  const ordered = ratingOrder(items);
  const min = Math.min(...ordered.map((r) => r.eloInterval.lo));
  const max = Math.max(...ordered.map((r) => r.eloInterval.hi));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] text-sm">
        <caption className="text-muted-foreground mb-2 text-left text-xs">{caption}</caption>
        <thead>
          <tr className="text-muted-foreground border-b text-left text-xs">
            <th scope="col" className="py-1.5 pr-3 font-medium">
              #
            </th>
            <th scope="col" className="py-1.5 pr-3 font-medium">
              Model
            </th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium">
              Rating
            </th>
            <th scope="col" className="py-1.5 pr-3 font-medium">
              95% interval
            </th>
            <th scope="col" className="w-1/4 py-1.5 pr-3 font-medium">
              <span className="sr-only">Interval on a common scale</span>
            </th>
            <th scope="col" className="py-1.5 pr-3 text-right font-medium">
              Mean rank
            </th>
            <th scope="col" className="py-1.5 text-right font-medium">
              Rated matches
            </th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((r, i) => (
            <tr key={r.id} data-rating={r.id} className="border-b last:border-b-0">
              <td className="py-1.5 pr-3 tabular-nums">{i + 1}</td>
              <td className="py-1.5 pr-3">
                <AppLink href={modelHref(r.id)} className="hover:underline">
                  {names.get(r.id) ?? r.key}
                </AppLink>
              </td>
              <td className="py-1.5 pr-3 text-right font-medium tabular-nums">
                {fmtInt(Math.round(r.elo))}
              </td>
              <td className="text-muted-foreground py-1.5 pr-3 whitespace-nowrap tabular-nums">
                {fmtInterval(r.eloInterval, 0)}
              </td>
              <td className="py-1.5 pr-3">
                <IntervalBar
                  value={r.elo}
                  lo={r.eloInterval.lo}
                  hi={r.eloInterval.hi}
                  min={min}
                  max={max}
                />
              </td>
              <td className="py-1.5 pr-3 text-right whitespace-nowrap tabular-nums">
                {fmtFixed(r.meanRank, 2)}
                {r.meanRankInterval === null ? null : (
                  <span className="text-muted-foreground"> {fmtInterval(r.meanRankInterval)}</span>
                )}
              </td>
              <td className="py-1.5 text-right tabular-nums">{fmtInt(r.matches)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The ratings, their method and the head-to-head pairs: only when the claim state is `ok`. */
export function RatingsSection({
  ratings: served,
  claims,
  names,
}: {
  readonly ratings: Ratings | null;
  readonly claims: Claims;
  readonly names: ReadonlyMap<string, string>;
}) {
  const ratings = shownRatings(claims, served);
  if (ratings === null) return null;
  const h = ratings.headline;
  return (
    <Section
      title="Ratings"
      icon={Scale}
      testId="ratings"
      note={`MAP Plackett–Luce over each rated match's full ranking (prior σ ${fmtFixed(ratings.priorSigma, 1)}), on an Elo-like scale centred on 1,500 for the models; ${intervalWords(ratings)}. Every seat counts as it started, handed-off seats included.`}
    >
      <RatingTable
        items={h.items}
        names={names}
        caption={`${plural(h.matches, "rated match", "rated matches")}, ${plural(h.seats, "seat")}`}
      />
      {h.pairs.length === 0 ? null : (
        <details className="group">
          <summary className="text-primary hover:text-primary/80 cursor-pointer text-sm font-medium select-none">
            Head to head ({plural(h.pairs.length, "pair")})
          </summary>
          <p className="text-muted-foreground mt-2 text-xs">
            Each difference's interval is at {fmtFixed(ratings.intervals.pairLevel * 100, 1)}%: the
            0.05 the ranking claim allows, split over the {plural(h.pairs.length, "pair")}, so a
            pair reads as separated only at the level the ranking is claimed at.
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {h.pairs.map((p) => {
              const clear = separated(p.interval);
              return (
                <li key={`${p.a}|${p.b}`} data-pair={`${p.a}|${p.b}`}>
                  <span className="font-medium">{names.get(p.a) ?? p.a}</span> finished ahead of{" "}
                  <span className="font-medium">{names.get(p.b) ?? p.b}</span> in {fmtInt(p.aAhead)}{" "}
                  of {plural(p.matches, "match", "matches")}; strength difference{" "}
                  {fmtFixed(p.difference)} {fmtInterval(p.interval)}
                  {clear ? (
                    <span className="text-primary"> (separated at the corrected level)</span>
                  ) : (
                    <span className="text-muted-foreground"> (not separated)</span>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      )}
      <details>
        <summary className="text-primary hover:text-primary/80 cursor-pointer text-sm font-medium select-none">
          Sensitivity: without handed-off seats
        </summary>
        <div className="mt-2">
          <RatingTable
            items={ratings.clean.items}
            names={names}
            caption={`Clean seats only: ${plural(ratings.clean.matches, "rated match", "rated matches")}, ${plural(ratings.clean.seats, "seat")}`}
          />
        </div>
      </details>
    </Section>
  );
}

// The per-model table -------------------------------------------------------------------------

function Num({
  children,
  muted = false,
}: {
  readonly children: ReactNode;
  readonly muted?: boolean;
}) {
  return (
    <td
      className={cn(
        "px-2 py-1.5 text-right whitespace-nowrap tabular-nums",
        muted && "text-muted-foreground",
      )}
    >
      {children}
    </td>
  );
}

function Th({ children, title }: { readonly children: ReactNode; readonly title?: string }) {
  return (
    <th scope="col" title={title} className="px-2 py-1.5 text-right align-bottom font-medium">
      {children}
    </th>
  );
}

/** Every item, by name (never by outcome): what it did, what went wrong, what it cost. */
export function ModelsTable({
  models,
  costs,
  claims,
}: {
  readonly models: readonly Item[];
  readonly costs: boolean;
  readonly claims: Claims;
}) {
  const outcome = rankingShown(claims);
  return (
    <div className="flex flex-col gap-2">
      {costs ? null : <NotPublished what="Costs" where="on this server" />}
      <p className="text-muted-foreground text-xs" data-testid="models-legend">
        {costs
          ? "Cost per rated match: all of a model's seats in a match together, over every lineup (its page gives it per lineup); cost per wake: its spend over its wakes. "
          : null}
        Tool-call errors: calls the provider could not parse and arguments the game refused.
        Parallel: of its tool rounds, those with two or more calls at once. Hand-offs: seats handed
        to their bot (budget, cap, outage, operator).
      </p>
      <div className="bg-card overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[56rem] text-sm" data-testid="models-table">
          <thead>
            <tr className="text-muted-foreground border-b text-xs">
              <th
                scope="col"
                className="bg-card sticky left-0 z-10 px-3 py-1.5 text-left align-bottom font-medium"
              >
                Model
              </th>
              <Th title="Matches it played, and its seats in them">Matches</Th>
              <Th title="Turns an LLM controlled">Wakes</Th>
              {costs ? (
                <>
                  <Th title="All its seats in a rated match together, over every lineup (fees included)">
                    Cost per match
                  </Th>
                  <Th title="Its spend over its wakes">Cost per wake</Th>
                  <Th title="Prompt tokens read from the cache">Cache reads</Th>
                </>
              ) : null}
              <Th title="Malformed calls and the gateway's INVALID_ARGS">Tool-call errors</Th>
              <Th title="Of the tool rounds, those with two or more calls at once">Parallel</Th>
              <Th title="Seats handed to their bot (budget, cap, outage, operator)">Hand-offs</Th>
              <Th title="Messages sent">Messages</Th>
              <Th title="Pacts kept and broken">Pacts kept · broken</Th>
              <Th title="Betrayals committed and suffered">Betrayals by · of</Th>
              <Th title="Battles won of those it took part in">Battles won</Th>
              {outcome ? (
                <>
                  <Th title="Mean final rank over rated matches (1 is first)">Mean rank</Th>
                  <Th title="Wins (of which by domination)">Wins</Th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {displayOrder(models).map((m) => {
              const result = shownClaim(claims, m.outcome);
              const battles = m.military.battlesAttacked + m.military.battlesDefended;
              const tools =
                m.operations === null
                  ? null
                  : m.operations.toolErrors.malformed + m.operations.toolErrors.invalidArgs;
              const handoffs = total(m.handoffs);
              return (
                <tr key={m.id} data-model={m.id} className="border-b last:border-b-0">
                  <th
                    scope="row"
                    className="bg-card sticky left-0 z-10 w-[11rem] max-w-[11rem] px-3 py-1.5 text-left font-normal sm:w-auto sm:max-w-[18rem]"
                  >
                    <AppLink
                      href={modelHref(m.id)}
                      className={cn("font-medium hover:underline", m.fake && "text-gold")}
                    >
                      {itemName(m)}
                    </AppLink>
                    <span className="text-muted-foreground block text-xs">{itemLine(m)}</span>
                  </th>
                  <Num>
                    {fmtInt(m.matches)}
                    {m.seats === m.matches ? null : (
                      <span className="text-muted-foreground"> ({fmtInt(m.seats)} seats)</span>
                    )}
                  </Num>
                  <Num muted={m.kind === "bot"}>
                    {m.kind === "bot" ? "–" : fmtInt(m.play.wakes)}
                  </Num>
                  {costs ? (
                    <>
                      <Num>
                        {m.cost === null || m.cost.perMatchNanoUsd === null
                          ? "–"
                          : fmtUsdFine(m.cost.perMatchNanoUsd)}
                      </Num>
                      <Num>
                        {m.cost === null || m.cost.perWakeNanoUsd === null
                          ? "–"
                          : fmtUsdFine(m.cost.perWakeNanoUsd)}
                      </Num>
                      <Num>{m.cost === null ? "–" : fmtPermille(m.cost.cacheReadPermille)}</Num>
                    </>
                  ) : null}
                  <Num>{tools === null ? "–" : fmtInt(tools)}</Num>
                  <Num>{fmtPermille(m.incidents.parallelPermille)}</Num>
                  <Num>
                    <span title={countsWords(m.handoffs)}>{fmtInt(handoffs)}</span>
                  </Num>
                  <Num>{fmtInt(m.diplomacy.messagesSent)}</Num>
                  <Num>
                    {fmtInt(m.diplomacy.pactsKept)} · {fmtInt(m.diplomacy.pactsBroken)}
                  </Num>
                  <Num>
                    {fmtInt(m.diplomacy.betrayalsCommitted)} ·{" "}
                    {fmtInt(m.diplomacy.betrayalsSuffered)}
                  </Num>
                  <Num>
                    {fmtInt(m.military.battlesWon)}
                    <span className="text-muted-foreground"> of {fmtInt(battles)}</span>
                  </Num>
                  {outcome ? (
                    <>
                      <Num>{result === null ? "–" : fmtFixed(result.meanRank, 2)}</Num>
                      <Num>
                        {result === null ? "–" : fmtInt(result.wins)}
                        {result === null || result.dominationWins === 0 ? null : (
                          <span className="text-muted-foreground">
                            {" "}
                            ({fmtInt(result.dominationWins)})
                          </span>
                        )}
                      </Num>
                    </>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// The matches -----------------------------------------------------------------------------------

/** How many matches the table shows before "Show all". */
const MATCHES_SHOWN = 50;

export function MatchesTable({
  data,
  names,
  all,
  onAll,
}: {
  readonly data: ModelsResponse;
  readonly names: ReadonlyMap<string, Item>;
  readonly all: boolean;
  readonly onAll: () => void;
}) {
  const shown = all ? data.matches : data.matches.slice(0, MATCHES_SHOWN);
  return (
    <div className="flex flex-col gap-2">
      {data.series.length === 0 ? null : (
        <ul className="flex flex-col gap-1 text-sm" aria-label="Series">
          {data.series.map((s) => (
            <li key={s.lineup}>
              Series <span className="font-mono">{s.lineup}</span>
              {s.fake ? <span className="text-gold"> (rehearsal)</span> : null}: {fmtInt(s.found)}{" "}
              of {plural(s.planned, "planned match", "planned matches")} found;{" "}
              {plural(s.blocks, "block")} of {fmtInt(s.order)}
              {s.orthogonal ? " (each model on each profile once per block)" : ""}
            </li>
          ))}
        </ul>
      )}
      <div className="bg-card overflow-x-auto rounded-xl border">
        <table className="w-full min-w-[40rem] text-sm" data-testid="matches-table">
          <thead>
            <tr className="text-muted-foreground border-b text-left text-xs">
              <th scope="col" className="px-3 py-1.5 font-medium">
                Match
              </th>
              <th scope="col" className="px-2 py-1.5 font-medium">
                Lineup
              </th>
              <th scope="col" className="px-2 py-1.5 font-medium">
                Rated
              </th>
              <th scope="col" className="px-2 py-1.5 font-medium">
                Seats
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => (
              <tr
                key={m.match}
                data-match-row={m.match}
                className="border-b align-top last:border-b-0"
              >
                <td className="px-3 py-1.5 whitespace-nowrap">
                  <AppLink href={matchHref(m.match)} className="font-mono hover:underline">
                    {m.match}
                  </AppLink>
                  {m.fake ? <span className="text-gold block text-xs">rehearsal</span> : null}
                </td>
                <td className="px-2 py-1.5 whitespace-nowrap">
                  {m.lineup === null ? "–" : <span className="font-mono">{m.lineup}</span>}
                  {m.series === null ? null : (
                    <span className="text-muted-foreground block text-xs">
                      {seriesWords(m.series)}
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5">
                  {m.rated ? "yes" : <span className="text-muted-foreground">no ({m.status})</span>}
                </td>
                <td className="px-2 py-1.5 text-xs">
                  {m.seats.map((s, i) => (
                    <span key={s.seat} className="whitespace-nowrap">
                      {i > 0 ? " · " : null}
                      <span className="text-muted-foreground font-mono">{s.seat}</span>{" "}
                      {itemShort(names.get(s.id), s.id)}
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.matches.length > shown.length ? (
        <button
          type="button"
          onClick={onAll}
          className="text-primary hover:text-primary/80 w-fit text-sm font-medium"
        >
          Show all {fmtInt(data.matches.length)} matches
        </button>
      ) : null}
    </div>
  );
}

/** The rehearsal note: fake seats test the pipeline and say nothing about any model. */
export function RehearsalNote({ all }: { readonly all: boolean }) {
  return (
    <p
      role="note"
      data-testid="rehearsal-note"
      className="border-gold/50 bg-gold/5 flex items-start gap-2 rounded-xl border p-3 text-sm"
    >
      <Info className="text-gold mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>
        {all ? "Every language-model seat here" : "Some seats here"} played in a rehearsal: a
        scripted bot behind the language-model pipe (a <span className="font-mono">--fake</span>{" "}
        run), priced at the cards of the models it stands in for. These figures test the arena; they
        say nothing about any model.
      </span>
    </p>
  );
}
