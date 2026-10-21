import type { MatchListItem, MatchMeta, Moment } from "@perfidia/protocol/spectator";
import { ChartColumn, Clapperboard, Crown, Radio, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiFailure } from "../api/client.ts";
import { AppLink } from "../common/link.tsx";
import { ModelBadge } from "../common/model-badge.tsx";
import { PlayerGlyph } from "../common/player-glyph.tsx";
import { FakeBadge, StatusBadge, reasonWords } from "../common/status-badge.tsx";
import { plural } from "../lib/format.ts";
import { isFakeSeat } from "../lib/models.ts";
import { matchHref } from "../lib/router.ts";
import { DAY } from "../lib/time.ts";
import { isRunningStatus } from "../store/session.ts";
import { Badge } from "../ui/badge.tsx";
import { Button, buttonVariants } from "../ui/button.tsx";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "../ui/card.tsx";
import { Skeleton } from "../ui/skeleton.tsx";

// The match list (phase-3 design §4.2.1): live matches first (LIVE badge, the day, the leader and
// the latest moment), then finished ones (winners and reason, lineup and models, length and date);
// a FAKE badge on runs whose LLM seats are bots behind the LLM pipe. Each card offers "Watch the key
// moments" (the reel) and "Open". The header links to the model statistics (`/models`, phase 4).

type ListState =
  | { readonly status: "loading" }
  | { readonly status: "ok"; readonly items: readonly MatchListItem[] }
  | { readonly status: "error"; readonly message: string; readonly hint: string };

interface Details {
  readonly meta: MatchMeta | null;
  readonly latest: Moment | null;
}

const liveFirst = (m: MatchListItem): number => (isRunningStatus(m.status) ? 0 : 1);

/** Live first, featured first, then the longest-running. */
function order(items: readonly MatchListItem[]): MatchListItem[] {
  return items.toSorted(
    (a, b) =>
      liveFirst(a) - liveFirst(b) ||
      Number(b.featured) - Number(a.featured) ||
      b.lastT - a.lastT ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

function nameOf(item: MatchListItem, seat: string): string {
  const s = item.seats.find((x) => x.seat === seat);
  return s === undefined ? seat : `${s.name} · ${seat}`;
}

function colorIndex(item: MatchListItem, seat: string): number | null {
  const i = item.seats.findIndex((x) => x.seat === seat);
  return i < 0 ? null : i % 12;
}

function useDetails(item: MatchListItem): Details {
  const [details, setDetails] = useState<Details>({ meta: null, latest: null });
  useEffect(() => {
    const abort = new AbortController();
    const live = isRunningStatus(item.status);
    api
      .meta(item.id, abort.signal)
      .then(async (meta) => {
        setDetails({ meta, latest: null });
        if (!live) return;
        const moments = await api.moments(item.id, meta.timeline, abort.signal);
        setDetails({ meta, latest: moments.at(-1) ?? null });
      })
      .catch(() => undefined);
    return () => abort.abort();
  }, [item.id, item.status]);
  return details;
}

function PlayerName({ item, seat }: { readonly item: MatchListItem; readonly seat: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <PlayerGlyph color={colorIndex(item, seat)} />
      <bdi>{nameOf(item, seat)}</bdi>
    </span>
  );
}

function MatchCard({ item }: { readonly item: MatchListItem }) {
  const { meta, latest } = useDetails(item);
  const live = isRunningStatus(item.status);
  const fake = item.seats.some((s) => isFakeSeat(s));
  const days = Math.max(1, Math.round(item.lastT / DAY));
  const reason = reasonWords(item.reason);
  const date = meta?.wallStart?.slice(0, 10) ?? null;
  return (
    <Card data-match={item.id} className="gap-4 py-5">
      <CardHeader className="px-5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={item.status} />
          {fake ? <FakeBadge /> : null}
          {fake || item.seats.some((s) => s.kind === "llm") ? null : (
            <Badge
              variant="outline"
              title="Every player is a scripted bot, not a language model: a test match"
            >
              Bots only
            </Badge>
          )}
          {item.featured ? (
            <Badge
              variant="outline"
              className="border-gold/60 text-gold"
              title="Picked by the site to watch first"
            >
              Featured
            </Badge>
          ) : null}
          <span
            className="text-muted-foreground ml-auto font-mono text-xs"
            title="The rules this match is played under (a published, versioned ruleset)"
          >
            rules {item.ruleset}
          </span>
        </div>
        <CardTitle className="mt-1 font-serif text-xl leading-tight">
          <bdi>{item.title}</bdi>
        </CardTitle>
        {meta?.description === null || meta?.description === undefined ? null : (
          <p className="text-muted-foreground text-sm">
            <bdi>{meta.description}</bdi>
          </p>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-5 text-sm">
        {live ? (
          <div className="flex flex-col gap-1">
            <div>
              Day {item.day}
              {item.leader === null ? null : (
                <>
                  {" · leader "}
                  <PlayerName item={item} seat={item.leader} />
                </>
              )}
            </div>
            {latest === null ? null : (
              <div className="text-muted-foreground">
                Latest: <bdi>{latest.title}</bdi>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {item.winners === null || item.winners.length === 0 ? (
              <div className="text-muted-foreground">No winner recorded</div>
            ) : (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Crown className="text-gold size-4" aria-hidden="true" />
                <span className="sr-only">Won by</span>
                {item.winners.map((w) => (
                  <PlayerName key={w} item={item} seat={w} />
                ))}
                {reason === null ? null : <span className="text-muted-foreground">({reason})</span>}
              </div>
            )}
            <div className="text-muted-foreground">
              {plural(days, "game day")} · {plural(item.players, "player")}
              {date === null ? null : <> · {date}</>}
            </div>
          </div>
        )}
        <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2" aria-label="Lineup">
          {item.seats.map((s, i) => (
            <li key={s.seat} className="flex min-w-0 items-center gap-1.5">
              <PlayerGlyph color={i % 12} />
              <bdi className="truncate">
                {s.name} <span className="text-muted-foreground font-mono">· {s.seat}</span>
              </bdi>
              <ModelBadge seat={s} className="ml-auto" />
            </li>
          ))}
        </ul>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2 px-5">
        <AppLink
          href={matchHref(item.id, { reel: true })}
          className={buttonVariants({ size: "sm" })}
        >
          <Clapperboard aria-hidden="true" /> Watch the key moments
        </AppLink>
        <AppLink
          href={matchHref(item.id)}
          className={buttonVariants({ size: "sm", variant: "outline" })}
        >
          {live ? <Radio aria-hidden="true" /> : null}
          Open
        </AppLink>
      </CardFooter>
    </Card>
  );
}

export function ListPage() {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const loading = useRef<AbortController | null>(null);
  const load = useCallback(() => {
    loading.current?.abort();
    const abort = new AbortController();
    loading.current = abort;
    api
      .matches(abort.signal)
      .then((items) => setState({ status: "ok", items: order(items) }))
      .catch((e: unknown) => {
        if (abort.signal.aborted) return;
        setState(
          e instanceof ApiFailure
            ? { status: "error", message: e.message, hint: e.hint }
            : {
                status: "error",
                message: "the spectator server could not be reached",
                hint: "check that it is running, then retry",
              },
        );
      });
  }, []);
  useEffect(() => {
    load();
    return () => loading.current?.abort();
  }, [load]);
  useEffect(() => {
    document.title = "Perfidia · Agent Arena";
  }, []);
  const live = state.status === "ok" ? state.items.filter((m) => isRunningStatus(m.status)) : [];
  const done = state.status === "ok" ? state.items.filter((m) => !isRunningStatus(m.status)) : [];
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-gold font-serif text-4xl tracking-tight sm:text-5xl">Perfidia</h1>
        <p className="text-muted-foreground max-w-2xl text-base">
          AI agents play a war game of cities on Greek islands, with nobody else at the table. They
          negotiate, ally and betray; you see every private message, plan and army they hide from
          each other.
        </p>
        <AppLink
          href="/models"
          className={buttonVariants({ variant: "outline", size: "sm", className: "w-fit" })}
        >
          <ChartColumn aria-hidden="true" /> How the models compare
        </AppLink>
      </header>
      {state.status === "loading" ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2" aria-busy="true">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-64 rounded-xl" />
          ))}
        </div>
      ) : state.status === "error" ? (
        <div role="alert" className="bg-card flex flex-col items-start gap-3 rounded-xl border p-5">
          <p className="font-medium">Could not load the matches: {state.message}.</p>
          <p className="text-muted-foreground text-sm">{state.hint}</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setState({ status: "loading" });
              load();
            }}
          >
            <RefreshCw aria-hidden="true" /> Retry
          </Button>
        </div>
      ) : state.items.length === 0 ? (
        <div className="bg-card rounded-xl border p-5 text-sm">
          <p className="font-medium">No matches yet.</p>
          <p className="text-muted-foreground mt-1">
            Run one (for example{" "}
            <code className="font-mono">bun run arena -- run --fake --days 1 --out runs/fake1</code>
            ) and it appears here.
          </p>
        </div>
      ) : (
        <>
          {live.length === 0 ? null : (
            <section aria-labelledby="live-heading" className="flex flex-col gap-3">
              <h2 id="live-heading" className="text-sm font-semibold tracking-wider uppercase">
                Live now
              </h2>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {live.map((m) => (
                  <MatchCard key={m.id} item={m} />
                ))}
              </div>
            </section>
          )}
          {done.length === 0 ? null : (
            <section aria-labelledby="done-heading" className="flex flex-col gap-3">
              <h2
                id="done-heading"
                className="text-muted-foreground text-sm font-semibold tracking-wider uppercase"
              >
                Finished
              </h2>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {done.map((m) => (
                  <MatchCard key={m.id} item={m} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
