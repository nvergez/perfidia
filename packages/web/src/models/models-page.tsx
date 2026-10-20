import type { ModelDetail, ModelsResponse } from "@perfidia/protocol/spectator";
import {
  ArrowLeft,
  Coins,
  Handshake,
  ListChecks,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Swords,
  Trophy,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiFailure } from "../api/client.ts";
import { AppLink } from "../common/link.tsx";
import { NotPublished } from "../common/not-published.tsx";
import { ReasoningKindTag } from "../common/reasoning-kind.tsx";
import { cn } from "../lib/cn.ts";
import { fmtInt, plural } from "../lib/format.ts";
import { providerReasoning, reasoningKindHint, servingProvider } from "../lib/models.ts";
import { matchHref } from "../lib/router.ts";
import { Button, buttonVariants } from "../ui/button.tsx";
import { Skeleton } from "../ui/skeleton.tsx";
import {
  channelWords,
  countsWords,
  fmtFixed,
  fmtInterval,
  fmtMs,
  fmtPermille,
  fmtShare,
  fmtTokens,
  fmtUsdFine,
  itemName,
  rankingShown,
  rehearsedModel,
  total,
} from "./format.ts";
import {
  ClaimsPanel,
  itemLine,
  MatchesTable,
  ModelsTable,
  RatingsSection,
  RehearsalNote,
  Section,
  type Item,
} from "./parts.tsx";

// The model statistics (phase-4 design §6.3, docs/phase4.md §45), a page loaded on demand:
// - `/models`: the claim state ("Too few matches: 70 more needed (power now 0.00)" until the
//   threshold is met, never a ranking below it), the ratings with their intervals above it, every
//   model's figures across the published matches (by name), and the matches they cover;
// - `/models/:id`: one model's figures in full, its rating (above the threshold) and its seats,
//   match by match.
// Costs show only when the server publishes them. Every payload is parsed with the protocol's
// schemas (`api/client.ts`); a 503 `LOADING` (a match the statistics cover is still folding) is
// retried after the server's `Retry-After`.

type Load<T> =
  | { readonly status: "loading"; readonly folding: boolean }
  | { readonly status: "ok"; readonly value: T }
  | {
      readonly status: "error";
      readonly code: string;
      readonly message: string;
      readonly hint: string;
    };

/** Seats the model page lists before "Show all". */
const SEATS_SHOWN = 50;

/** Retries of a `LOADING` answer before giving up (each after the server's `Retry-After`). */
const LOADING_RETRIES = 30;

const LOADING: Load<never> = Object.freeze({ status: "loading", folding: false });

interface Job {
  readonly abort: AbortController;
  timer: number | null;
}

function stop(job: Job | null): void {
  if (job === null) return;
  job.abort.abort();
  if (job.timer !== null) window.clearTimeout(job.timer);
}

/**
 * `fetcher(arg)` when mounted and on `retry`; a `LOADING` answer (a match the statistics cover is
 * still folding) is asked again after its `Retry-After`. `fetcher` is a module-level function.
 */
function useLoad<A, T>(
  arg: A,
  fetcher: (arg: A, signal: AbortSignal) => Promise<T>,
): [Load<T>, () => void] {
  const [state, setState] = useState<Load<T>>(LOADING);
  const current = useRef<Job | null>(null);
  const load = useCallback(() => {
    stop(current.current);
    const job: Job = { abort: new AbortController(), timer: null };
    current.current = job;
    let tries = 0;
    const run = (): void => {
      fetcher(arg, job.abort.signal)
        .then((value) => setState({ status: "ok", value }))
        .catch((e: unknown) => {
          if (job.abort.signal.aborted) return;
          if (e instanceof ApiFailure && e.code === "LOADING" && tries < LOADING_RETRIES) {
            tries += 1;
            setState({ status: "loading", folding: true });
            job.timer = window.setTimeout(run, Math.min(10, e.retryAfter ?? 2) * 1000);
            return;
          }
          setState(
            e instanceof ApiFailure
              ? { status: "error", code: e.code, message: e.message, hint: e.hint }
              : {
                  status: "error",
                  code: "NETWORK",
                  message: "the spectator server could not be reached",
                  hint: "check that it is running, then retry",
                },
          );
        });
    };
    run();
  }, [arg, fetcher]);
  useEffect(() => {
    load();
    return () => stop(current.current);
  }, [load]);
  const retry = useCallback(() => {
    setState(LOADING);
    load();
  }, [load]);
  return [state, retry];
}

const fetchModels = (_: null, signal: AbortSignal): Promise<ModelsResponse> => api.models(signal);
const fetchModel = (id: string, signal: AbortSignal): Promise<ModelDetail> => api.model(id, signal);

function Shell({ children, back }: { readonly children: ReactNode; readonly back?: boolean }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
      <nav className="flex flex-wrap items-center gap-2 text-sm" aria-label="Back">
        <AppLink href="/" className={buttonVariants({ variant: "ghost", size: "sm" })}>
          <ArrowLeft aria-hidden="true" /> All matches
        </AppLink>
        {back === true ? (
          <AppLink href="/models" className={buttonVariants({ variant: "ghost", size: "sm" })}>
            <ArrowLeft aria-hidden="true" /> All models
          </AppLink>
        ) : null}
      </nav>
      {children}
    </main>
  );
}

const PROBLEMS: Readonly<Record<string, string>> = Object.freeze({
  NO_STATS: "No model statistics are published on this server yet.",
  STATS_NOT_PUBLIC:
    "The model statistics are not public right now: they cover a match that is not published.",
  NO_MODEL: "These statistics have no such model.",
});

function Problem({
  state,
  onRetry,
}: {
  readonly state: Extract<Load<unknown>, { status: "error" }>;
  readonly onRetry: () => void;
}) {
  const known = PROBLEMS[state.code];
  return (
    <div
      role="alert"
      data-testid="models-problem"
      data-code={state.code}
      className="bg-card flex flex-col items-start gap-3 rounded-xl border p-5"
    >
      <p className="font-medium">
        {known ?? `Could not load the model statistics: ${state.message}.`}
      </p>
      <p className="text-muted-foreground text-sm">
        {known === undefined
          ? state.hint
          : "Statistics come from finished, published matches; the operator publishes them with bun run stats."}
      </p>
      {known === undefined ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RefreshCw aria-hidden="true" /> Retry
        </Button>
      ) : null}
    </div>
  );
}

function Loading({ folding }: { readonly folding: boolean }) {
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
        {folding
          ? "The server is still reading a match these statistics cover; trying again shortly…"
          : "Loading the model statistics…"}
      </p>
      <Skeleton className="h-28 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}

function namesOf(models: readonly Item[]): Map<string, string> {
  return new Map(models.map((m) => [m.id, itemName(m)]));
}

function Overview({ data }: { readonly data: ModelsResponse }) {
  const [all, setAll] = useState(false);
  const names = useMemo(() => namesOf(data.models), [data.models]);
  const byId = useMemo(() => new Map(data.models.map((m) => [m.id, m])), [data.models]);
  const llm = data.models.filter((m) => m.kind === "llm");
  const fakes = llm.filter((m) => m.fake).length;
  const rated = data.matches.filter((m) => m.rated).length;
  return (
    <>
      <header className="flex flex-col gap-2">
        <h1 className="text-gold font-serif text-4xl tracking-tight">Models</h1>
        <p className="text-muted-foreground max-w-3xl">
          How each model played across{" "}
          {plural(data.matches.length, "published match", "published matches")} ({fmtInt(rated)}{" "}
          rated): what it did, what went wrong, what it cost and, once there are enough matches, how
          the models rank against each other.
          {data.grouping === "model" ? null : ` Grouped by ${data.grouping}.`}
        </p>
      </header>
      {fakes === 0 ? null : <RehearsalNote all={fakes === llm.length} />}
      <ClaimsPanel claims={data.claims} />
      {data.ratings === null ? null : (
        <RatingsSection ratings={data.ratings} claims={data.claims} names={names} />
      )}
      <Section
        title="Per model"
        icon={ListChecks}
        note="Sums over every seat a model played, by name; open a model for all of its figures and its seats match by match."
      >
        <ModelsTable models={data.models} costs={data.published.costs} claims={data.claims} />
      </Section>
      <Section title="Matches" icon={Swords} testId="matches">
        <MatchesTable data={data} names={byId} all={all} onAll={() => setAll(true)} />
      </Section>
    </>
  );
}

function Stat({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b py-1 last:border-b-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right tabular-nums">{children}</dd>
    </div>
  );
}

function Card({
  title,
  icon: Icon,
  children,
}: {
  readonly title: string;
  readonly icon: typeof Swords;
  readonly children: ReactNode;
}) {
  return (
    <section className="bg-card flex flex-col gap-1 rounded-xl border p-4 text-sm">
      <h2 className="text-muted-foreground mb-1 flex items-center gap-1.5 text-xs font-semibold tracking-wider uppercase">
        <Icon className="size-3.5" aria-hidden="true" /> {title}
      </h2>
      <dl>{children}</dl>
    </section>
  );
}

function Detail({ data }: { readonly data: ModelDetail }) {
  const m = data.model;
  const ok = rankingShown(data.claims);
  const costs = data.published.costs;
  const ops = m.operations;
  const cost = m.cost;
  const rating = ok ? data.rating : null;
  const [allSeats, setAllSeats] = useState(false);
  const seats = allSeats ? data.seats : data.seats.slice(0, SEATS_SHOWN);
  const kind =
    m.model === null
      ? null
      : providerReasoning(servingProvider(m.fake ? rehearsedModel(m.model) : m.model));
  const tokens =
    cost === null
      ? 0
      : cost.tokens.input +
        cost.tokens.cacheWrite5m +
        cost.tokens.cacheWrite1h +
        cost.tokens.cacheRead +
        cost.tokens.output;
  return (
    <div className="flex flex-col gap-6" data-testid="model-detail" data-model={m.id}>
      <header className="flex flex-col gap-1">
        <h1 className={cn("font-serif text-3xl tracking-tight sm:text-4xl", m.fake && "text-gold")}>
          {itemName(m)}
        </h1>
        <p className="text-muted-foreground">{itemLine(m)}</p>
        {kind === null ? null : (
          <p className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-sm">
            Reasoning shown to spectators: <ReasoningKindTag kind={kind} />
            <span>{reasoningKindHint(kind)}</span>
          </p>
        )}
        <p className="text-muted-foreground font-mono text-xs break-all">{m.key}</p>
      </header>
      {m.fake ? <RehearsalNote all /> : null}
      <ClaimsPanel claims={data.claims} compact />
      {rating === null ? null : (
        <p className="text-sm" data-testid="model-rating">
          Rating <strong className="tabular-nums">{fmtInt(Math.round(rating.elo))}</strong>{" "}
          <span className="text-muted-foreground">{fmtInterval(rating.eloInterval, 0)}</span> ·
          strength {fmtFixed(rating.strength)} {fmtInterval(rating.interval)} · mean rank{" "}
          {fmtFixed(rating.meanRank)}
          {rating.meanRankInterval === null ? null : (
            <> {fmtInterval(rating.meanRankInterval)}</>
          )} ·{" "}
          {plural(rating.matches, "rated match", "rated matches")}
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        <Card title="Play" icon={ListChecks}>
          <Stat label="Matches · seats">
            {fmtInt(m.matches)} · {fmtInt(m.seats)}
          </Stat>
          <Stat label="Seats in rated matches">{fmtInt(m.rated)}</Stat>
          {m.kind === "bot" ? null : (
            <>
              <Stat label="Wakes">{fmtInt(m.play.wakes)}</Stat>
              <Stat label="Rounds a wake">
                {m.play.wakes === 0 ? "–" : fmtFixed(m.play.rounds / m.play.wakes, 1)}
              </Stat>
              <Stat label="Tool calls a round">
                {m.play.rounds === 0 ? "–" : fmtFixed(m.play.calls / m.play.rounds, 1)}
              </Stat>
              <Stat label="Wakes with a public thought">
                {fmtShare(m.play.thoughts, m.play.wakes)}
              </Stat>
            </>
          )}
          <Stat label="Rejected calls">{countsWords(m.play.rejections, 3)}</Stat>
        </Card>
        <Card title="Diplomacy" icon={Handshake}>
          <Stat label="Messages sent · received">
            {fmtInt(m.diplomacy.messagesSent)} · {fmtInt(m.diplomacy.messagesReceived)}
          </Stat>
          <Stat label="Pacts signed">{fmtInt(m.diplomacy.pactsSigned)}</Stat>
          <Stat label="Pacts kept · broken">
            {fmtInt(m.diplomacy.pactsKept)} · {fmtInt(m.diplomacy.pactsBroken)}
          </Stat>
          <Stat label="Betrayals committed · suffered">
            {fmtInt(m.diplomacy.betrayalsCommitted)} · {fmtInt(m.diplomacy.betrayalsSuffered)}
          </Stat>
          <Stat label="Alliances founded · joined">
            {fmtInt(m.diplomacy.alliancesFounded)} · {fmtInt(m.diplomacy.alliancesJoined)}
          </Stat>
          {m.kind === "bot" ? null : (
            <Stat label="Messages naming a model or vendor">
              {fmtInt(m.diplomacy.selfIdentification)}
            </Stat>
          )}
        </Card>
        <Card title="Battles" icon={Swords}>
          <Stat label="Attacked · defended">
            {fmtInt(m.military.battlesAttacked)} · {fmtInt(m.military.battlesDefended)}
          </Stat>
          <Stat label="Won">{fmtInt(m.military.battlesWon)}</Stat>
          <Stat label="Cities conquered · lost">
            {fmtInt(m.military.citiesConquered)} · {fmtInt(m.military.citiesLost)}
          </Stat>
        </Card>
        {m.kind === "bot" ? null : (
          <Card title="Incidents" icon={ShieldAlert}>
            <Stat label="Hand-offs">
              {total(m.handoffs) === 0 ? "none" : countsWords(m.handoffs)}
            </Stat>
            <Stat label="Wake caps · prompt caps">
              {fmtInt(m.incidents.wakeCaps)} · {fmtInt(m.incidents.promptCaps)}
            </Stat>
            <Stat label="Wakes ended by an error">{fmtInt(m.incidents.errorWakes)}</Stat>
            <Stat label="Refusals">{countsWords(m.incidents.refusals, 3)}</Stat>
            <Stat label="Parallel tool rounds">{fmtPermille(m.incidents.parallelPermille)}</Stat>
          </Card>
        )}
        {ops === null ? null : (
          <Card title="Model calls" icon={Wrench}>
            <Stat label="Attempts">{fmtInt(ops.attempts)}</Stat>
            <Stat label="Stops">{countsWords(ops.stops, 3)}</Stat>
            <Stat label="Errors">{countsWords(ops.errors, 3)}</Stat>
            <Stat label="Tool-call errors (malformed · invalid)">
              {fmtInt(ops.toolErrors.malformed)} · {fmtInt(ops.toolErrors.invalidArgs)}
            </Stat>
            <Stat label="Latency (median · p95)">
              {ops.latencyMs === null ? (
                costs ? (
                  "–"
                ) : (
                  "not published"
                )
              ) : ops.latencyMs.p95 === 0 ? (
                "not measured"
              ) : (
                <>
                  {fmtMs(ops.latencyMs.p50)} · {fmtMs(ops.latencyMs.p95)}
                </>
              )}
            </Stat>
          </Card>
        )}
        {m.kind === "bot" ? null : (
          <Card title="Cost" icon={Coins}>
            {!costs ? (
              <NotPublished what="Costs" where="on this server" className="py-1" />
            ) : cost === null ? (
              <Stat label="Spent">–</Stat>
            ) : (
              <>
                <Stat label="In all">{fmtUsdFine(cost.nanoUsd)}</Stat>
                <Stat label="A match">{fmtUsdFine(cost.perMatchNanoUsd)}</Stat>
                <Stat label="A wake">
                  {cost.perWakeNanoUsd === null ? "–" : fmtUsdFine(cost.perWakeNanoUsd)}
                </Stat>
                <Stat label="Cache reads of the prompt">{fmtPermille(cost.cacheReadPermille)}</Stat>
                <Stat label="Tokens">{fmtTokens(tokens)}</Stat>
                {cost.byLineup.map((l) => (
                  <Stat key={l.lineup} label={`A match in ${l.lineup}`}>
                    {fmtUsdFine(l.meanNanoUsd)}
                    {l.interval === null ? null : (
                      <span className="text-muted-foreground">
                        {" "}
                        [{fmtUsdFine(Math.round(l.interval.lo))},{" "}
                        {fmtUsdFine(Math.round(l.interval.hi))}]
                      </span>
                    )}{" "}
                    <span className="text-muted-foreground">
                      ({plural(l.matches, "match", "matches")})
                    </span>
                  </Stat>
                ))}
              </>
            )}
          </Card>
        )}
        {!ok || m.outcome === null ? null : (
          <Card title="Outcome" icon={Trophy}>
            <Stat label="Rated seats">{fmtInt(m.outcome.rated)}</Stat>
            <Stat label="Mean rank">{fmtFixed(m.outcome.meanRank, 2)}</Stat>
            <Stat label="Finished 1st, 2nd, …">
              {m.outcome.ranks.map((n) => fmtInt(n)).join(" · ")}
            </Stat>
            <Stat label="Wins (by domination)">
              {fmtInt(m.outcome.wins)} ({fmtInt(m.outcome.dominationWins)})
            </Stat>
            <Stat label="Cities at the end, mean">{fmtFixed(m.outcome.citiesMean, 1)}</Stat>
          </Card>
        )}
      </div>
      <Section title="Seats" icon={ListChecks} testId="model-seats">
        <div className="bg-card overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="text-muted-foreground border-b text-left text-xs">
                <th scope="col" className="px-3 py-1.5 font-medium">
                  Match
                </th>
                <th scope="col" className="px-2 py-1.5 font-medium">
                  Seat
                </th>
                <th scope="col" className="px-2 py-1.5 font-medium">
                  Lineup
                </th>
                <th scope="col" className="px-2 py-1.5 font-medium">
                  Profile and harness notes
                </th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">
                  Wakes
                </th>
                {costs ? (
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">
                    Cost
                  </th>
                ) : null}
                {ok ? (
                  <th scope="col" className="px-2 py-1.5 text-right font-medium">
                    Rank
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {seats.map((s) => (
                <tr key={`${s.match}|${s.seat}`} className="border-b last:border-b-0">
                  <td className="px-3 py-1.5">
                    <AppLink href={matchHref(s.match)} className="font-mono hover:underline">
                      {s.match}
                    </AppLink>
                    {s.rated ? null : (
                      <span className="text-muted-foreground block text-xs">not rated</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 font-mono">
                    {s.seat}
                    {s.handedOff ? (
                      <span className="text-gold block font-sans text-xs">handed off</span>
                    ) : null}
                  </td>
                  <td className="px-2 py-1.5">
                    {s.lineup === null ? "–" : <span className="font-mono">{s.lineup}</span>}
                  </td>
                  <td className="px-2 py-1.5">
                    {s.profile === null ? "–" : <span className="font-mono">{s.profile}</span>}
                    {s.promptVariant === null ? null : (
                      <span className="text-muted-foreground block text-xs">
                        {channelWords(s.promptVariant)}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{fmtInt(s.wakes)}</td>
                  {costs ? (
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {s.costNanoUsd === null ? "–" : fmtUsdFine(s.costNanoUsd)}
                    </td>
                  ) : null}
                  {ok ? (
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {s.rank === null ? "–" : fmtInt(s.rank)}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data.seats.length > seats.length ? (
          <button
            type="button"
            onClick={() => setAllSeats(true)}
            className="text-primary hover:text-primary/80 w-fit text-sm font-medium"
          >
            Show all {plural(data.seats.length, "seat")}
          </button>
        ) : null}
      </Section>
    </div>
  );
}

function OverviewPage() {
  const [list, retry] = useLoad(null, fetchModels);
  useEffect(() => {
    document.title = "Models · Perfidia";
  }, []);
  return (
    <Shell>
      {list.status === "loading" ? (
        <Loading folding={list.folding} />
      ) : list.status === "error" ? (
        <>
          <h1 className="text-gold font-serif text-4xl tracking-tight">Models</h1>
          <Problem state={list} onRetry={retry} />
        </>
      ) : (
        <Overview data={list.value} />
      )}
    </Shell>
  );
}

function DetailPage({ id }: { readonly id: string }) {
  const [one, retry] = useLoad(id, fetchModel);
  const name = one.status === "ok" ? itemName(one.value.model) : null;
  useEffect(() => {
    document.title = name === null ? "Model · Perfidia" : `${name} · Models · Perfidia`;
  }, [name]);
  return (
    <Shell back>
      {one.status === "loading" ? (
        <Loading folding={one.folding} />
      ) : one.status === "error" ? (
        <Problem state={one} onRetry={retry} />
      ) : (
        <Detail data={one.value} />
      )}
    </Shell>
  );
}

/** `/models` (`id` null) or `/models/:id`. */
export function ModelsPage({ id }: { readonly id: string | null }) {
  return id === null ? <OverviewPage /> : <DetailPage key={id} id={id} />;
}
