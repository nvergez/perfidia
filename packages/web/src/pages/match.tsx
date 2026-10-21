import {
  ArrowLeft,
  ChartColumn,
  CircleHelp,
  Hourglass,
  Loader2,
  TriangleAlert,
  WifiOff,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { BlocProgress } from "../board/bloc-progress.tsx";
import { Leaderboard } from "../board/leaderboard.tsx";
import { preloadWhenIdle, useLatch } from "../common/lazy.tsx";
import { AppLink } from "../common/link.tsx";
import { FakeBadge, StatusBadge } from "../common/status-badge.tsx";
import { FeedPanel } from "../feed/feed-panel.tsx";
import type { PlayerId } from "../lib/ids.ts";
import { cn } from "../lib/cn.ts";
import { isFakeSeat } from "../lib/models.ts";
import { LazyCityPopover } from "../map/lazy.ts";
import { MatchMap } from "../map/match-map.tsx";
import { LazyHowToWatch } from "../onboarding/lazy.ts";
import { LazyPlayerSheet, LazyPlayersPanel } from "../players/lazy.ts";
import { useLayout, useMatch, useUi } from "../store/hooks.ts";
import { closeMatch, controls, isRunningStatus, openMatch } from "../store/session.ts";
import { isPhoneTab, isSideTab, uiActions } from "../store/ui.ts";
import { StoryStrip } from "../story/story-strip.tsx";
import { LazyThoughtsPanel } from "../thoughts/lazy.ts";
import { LazyKeyMomentsReel } from "../timeline/lazy.ts";
import { LazyTurnSheet } from "../turns/lazy.ts";
import { TimelineBar } from "../timeline/timeline-bar.tsx";
import { Badge } from "../ui/badge.tsx";
import { Button, buttonVariants } from "../ui/button.tsx";
import { Skeleton } from "../ui/skeleton.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs.tsx";
import { MomentAnnouncer } from "./announcer.tsx";

// The match view (phase-3 design §4.2.2): the story strip on top, then
// - desktop (≥ 1280 px), three columns: leaderboard and blocs | map and timeline | Feed, Thoughts,
//   Players;
// - tablet (≥ 768 px): map and timeline beside the leaderboard and blocs, the tabs below;
// - phone: the map, then tabs (Board, Feed, Thoughts, Players), the timeline pinned at the bottom.
// One layout is mounted at a time. The panels belong to the view components (`map/`, `timeline/`,
// `board/`, `story/`, `feed/`, `thoughts/`, `players/`), which read the stores themselves.

export interface MatchPageProps {
  readonly id: string;
  readonly pair: readonly [PlayerId, PlayerId] | null;
  readonly reel: boolean;
  readonly start: boolean;
  /** The URL names a turn (`?turn=`): its detail opens first, "How to watch" after it closes. */
  readonly linkedTurn?: boolean;
}

/** A column that scrolls on its own (desktop and tablet). */
function Scroller({
  children,
  label,
  className,
}: {
  readonly children: ReactNode;
  readonly label: string;
  readonly className?: string;
}) {
  return (
    <section
      aria-label={label}
      className={cn(
        "min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-width:thin]",
        className,
      )}
    >
      {children}
    </section>
  );
}

function Panel({ children, label }: { readonly children: ReactNode; readonly label: string }) {
  return (
    <Scroller label={label} className="flex-1 p-3">
      {children}
    </Scroller>
  );
}

function SideTabs() {
  const tab = useUi((s) => s.sideTab);
  return (
    <Tabs
      value={tab}
      onValueChange={(v) => {
        if (isSideTab(v)) uiActions.setSideTab(v);
      }}
      className="bg-card min-h-0 flex-1 gap-0 rounded-xl border"
    >
      <TabsList className="m-2 w-[calc(100%-1rem)]">
        <TabsTrigger value="feed">Feed</TabsTrigger>
        <TabsTrigger value="thoughts">Thoughts</TabsTrigger>
        <TabsTrigger value="players">Players</TabsTrigger>
      </TabsList>
      <TabsContent value="feed" className="flex min-h-0 flex-col">
        <Panel label="Feed">
          <FeedPanel />
        </Panel>
      </TabsContent>
      <TabsContent value="thoughts" className="flex min-h-0 flex-col">
        <Panel label="Thoughts">
          <LazyThoughtsPanel />
        </Panel>
      </TabsContent>
      <TabsContent value="players" className="flex min-h-0 flex-col">
        <Panel label="Players">
          <LazyPlayersPanel />
        </Panel>
      </TabsContent>
    </Tabs>
  );
}

function MapBox({ className }: { readonly className?: string }) {
  const known = useMatch((s) => s.known);
  const waiting = useMatch((s) => s.waiting);
  return (
    <div className={cn("relative", className)}>
      <MatchMap />
      {known ? null : (
        <div className="bg-popover/90 absolute top-2 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border px-3 py-1 text-xs">
          <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden="true" /> Loading this
          part of the match…
        </div>
      )}
      {waiting ? (
        <div className="bg-popover/90 absolute top-2 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border px-3 py-1 text-xs">
          <Hourglass className="size-3" aria-hidden="true" /> Waiting for the server…
        </div>
      ) : null}
    </div>
  );
}

/** Focuses `selector` on the next frame (after a tab switch has rendered). */
function focusLater(selector: string): void {
  window.requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(selector)?.focus();
  });
}

/** Focus moves past the leaderboard and the map's cities (keyboard users). */
function SkipLinks() {
  const layout = useLayout();
  const skip =
    "focus:bg-popover sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-md focus:border focus:px-3 focus:py-1.5 focus:text-sm";
  return (
    <div className="absolute top-1 left-12 flex gap-2">
      <button
        type="button"
        className={skip}
        onClick={() => focusLater('[data-timeline] [role="slider"]')}
      >
        Skip to the timeline
      </button>
      <button
        type="button"
        className={skip}
        onClick={() => {
          if (layout === "phone") uiActions.setPhoneTab("feed");
          else uiActions.setSideTab("feed");
          focusLater('[data-testid="feed"] button');
        }}
      >
        Skip to the feed
      </button>
    </div>
  );
}

function DesktopLayout() {
  // Below 1440 px, narrower side columns, so the map and the timeline keep their room (at 1366 px
  // the scrubber had 233 px with the wide ones).
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[18.5rem_minmax(0,1fr)_18rem] gap-3 px-3 pb-3 min-[1366px]:grid-cols-[20rem_minmax(0,1fr)_19rem] min-[1440px]:grid-cols-[minmax(17rem,20rem)_minmax(0,1fr)_minmax(20rem,26rem)]">
      <Scroller label="Leaderboard and blocs" className="flex flex-col gap-3">
        <Leaderboard />
        <BlocProgress />
      </Scroller>
      <div className="flex min-h-0 flex-col gap-3">
        <MapBox className="min-h-0 flex-1" />
        <TimelineBar />
      </div>
      <div className="flex min-h-0 flex-col">
        <SideTabs />
      </div>
    </div>
  );
}

function TabletLayout() {
  return (
    <div className="flex flex-col gap-3 px-3 pb-3">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)] gap-3">
        <div className="flex flex-col gap-3">
          <MapBox className="aspect-square max-h-[calc(100dvh-11rem)] w-full" />
          <TimelineBar />
        </div>
        <div className="flex flex-col gap-3">
          <Leaderboard />
          <BlocProgress />
        </div>
      </div>
      <div className="flex h-[36rem] flex-col">
        <SideTabs />
      </div>
    </div>
  );
}

function PhoneLayout() {
  const tab = useUi((s) => s.phoneTab);
  return (
    <div className="flex flex-col gap-3 px-3 pb-28">
      <MapBox className="aspect-square w-full" />
      <Tabs
        value={tab}
        onValueChange={(v) => {
          if (isPhoneTab(v)) uiActions.setPhoneTab(v);
        }}
        className="gap-3"
      >
        <TabsList className="w-full">
          <TabsTrigger value="board">Board</TabsTrigger>
          <TabsTrigger value="feed">Feed</TabsTrigger>
          <TabsTrigger value="thoughts">Thoughts</TabsTrigger>
          <TabsTrigger value="players">Players</TabsTrigger>
        </TabsList>
        <TabsContent value="board" className="flex flex-col gap-3">
          <Leaderboard />
          <BlocProgress />
        </TabsContent>
        <TabsContent value="feed">
          <FeedPanel />
        </TabsContent>
        <TabsContent value="thoughts">
          <LazyThoughtsPanel />
        </TabsContent>
        <TabsContent value="players">
          <LazyPlayersPanel />
        </TabsContent>
      </Tabs>
      <div
        data-dock=""
        className="bg-background/90 fixed inset-x-0 bottom-0 z-30 border-t p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur-sm"
      >
        <TimelineBar />
      </div>
    </div>
  );
}

/** `performance.now()`, re-read every second while `on` (for "in 4 s", "2 min ago"). */
function useClientNow(on: boolean): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!on) return undefined;
    const h = window.setInterval(() => setNow(performance.now()), 1_000);
    return () => window.clearInterval(h);
  }, [on]);
  return now;
}

/** "45 s", "3 min". */
function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/** Shown while a running match's socket is down: the view is not live any more. */
function ConnectionBanner() {
  const running = useMatch((s) => isRunningStatus(s.status));
  const connection = useMatch((s) => s.connection);
  const retryAt = useMatch((s) => s.retryAt);
  const lost = running && connection === "closed";
  const now = useClientNow(lost);
  if (!lost) return null;
  const secs = retryAt === null ? null : Math.max(0, Math.ceil((retryAt - now) / 1000));
  return (
    <output
      data-testid="connection-lost"
      className="border-gold/50 bg-gold/10 mx-3 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-1.5 text-sm"
    >
      <WifiOff className="text-gold size-4 shrink-0" aria-hidden="true" />
      <span>
        Connection to the server lost: the match goes on without you.{" "}
        {secs === null || secs === 0 ? "Reconnecting…" : `Reconnecting in ${secs} s.`}
      </span>
      <Button size="sm" variant="outline" className="h-7" onClick={() => controls.reconnect()}>
        Retry now
      </Button>
    </output>
  );
}

/** Lockstep and live: why the clock stands still, and how long since the last move. */
function LockstepNote() {
  const lockstep = useMatch((s) => s.meta?.clock.kind === "lockstep");
  const live = useMatch((s) => s.mode === "live" && s.connection !== "closed");
  const lastLiveAt = useMatch((s) => s.lastLiveAt);
  const on = lockstep && live;
  const now = useClientNow(on);
  if (!on) return null;
  const quiet = lastLiveAt === null ? null : now - lastLiveAt;
  return (
    <span className="text-muted-foreground hidden text-xs lg:inline">
      Game time stands still while the agents think
      {quiet !== null && quiet >= 30_000 ? ` (last move ${ago(quiet)} ago)` : ""}.
    </span>
  );
}

function Header() {
  const meta = useMatch((s) => s.meta);
  const status = useMatch((s) => s.status);
  const lost = useMatch((s) => s.connection === "closed" && isRunningStatus(s.status));
  const fake = meta?.seats.some((s) => isFakeSeat(s)) ?? false;
  return (
    <header className="flex min-w-0 items-center gap-2 px-3 py-2">
      <AppLink
        href="/"
        aria-label="All matches"
        className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
      >
        <ArrowLeft />
      </AppLink>
      <h1 className="min-w-0 truncate font-serif text-lg sm:text-xl">
        <bdi>{meta?.title ?? "Loading…"}</bdi>
      </h1>
      {status === null ? null : lost ? (
        <Badge variant="secondary" className="uppercase tracking-wide">
          Offline
        </Badge>
      ) : (
        <StatusBadge status={status} />
      )}
      {fake ? <FakeBadge /> : null}
      {meta === null || fake || meta.seats.some((s) => s.kind === "llm") ? null : (
        <Badge
          variant="outline"
          className="uppercase tracking-wide"
          title="Every player is a scripted bot, not a language model: a test match"
        >
          Bots only
        </Badge>
      )}
      <LockstepNote />
      <span
        className="text-muted-foreground ml-auto hidden font-mono text-xs md:inline"
        title="The rules this match is played under (a published, versioned ruleset)"
      >
        {meta === null ? null : `rules ${meta.ruleset}`}
      </span>
      <AppLink
        href="/models"
        aria-label="How the models compare"
        title="How the models compare across matches"
        className={buttonVariants({ variant: "ghost", size: "sm" })}
      >
        <ChartColumn aria-hidden="true" /> <span className="hidden lg:inline">Models</span>
      </AppLink>
      <Button variant="ghost" size="sm" onClick={() => uiActions.openHowToWatch()}>
        <CircleHelp aria-hidden="true" /> <span className="hidden sm:inline">How to watch</span>
      </Button>
    </header>
  );
}

function Banner() {
  const status = useMatch((s) => s.status);
  const verified = useMatch((s) => s.meta?.verified ?? null);
  if (status !== "unverifiable" && verified?.ok !== false) return null;
  return (
    <div
      role="note"
      className="border-destructive/50 bg-destructive/10 mx-3 mb-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
    >
      <TriangleAlert className="text-destructive size-4 shrink-0" aria-hidden="true" />
      This match's log does not verify: what is shown stops where the replay diverged.
    </div>
  );
}

function ErrorView() {
  const error = useMatch((s) => s.error);
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="font-serif text-2xl">This match cannot be shown</h1>
      <p className="text-sm">{error?.message ?? "Something went wrong."}</p>
      {error === null ? null : <p className="text-muted-foreground text-sm">{error.hint}</p>}
      <AppLink href="/" className={buttonVariants({ variant: "secondary" })}>
        All matches
      </AppLink>
    </main>
  );
}

function LoadingView() {
  return (
    <div className="flex flex-col gap-3 px-3 pb-3" aria-busy="true">
      <Skeleton className="h-10 w-full rounded-xl" />
      <div className="grid gap-3 xl:grid-cols-[20rem_1fr_26rem]">
        <Skeleton className="hidden h-96 rounded-xl xl:block" />
        <Skeleton className="aspect-square w-full rounded-xl xl:aspect-auto xl:h-[70dvh]" />
        <Skeleton className="hidden h-96 rounded-xl xl:block" />
      </div>
    </div>
  );
}

/**
 * The sheets and dialogs over the page, each a chunk loaded on demand (docs/phase3.md §16): mounted
 * once first opened and kept mounted after (closing animations, focus return). The ones a viewer
 * is likely to open are preloaded when the browser is idle.
 */
function Overlays() {
  const ready = useMatch((s) => s.phase === "ready");
  const player = useLatch(useUi((s) => s.selectedPlayer !== null));
  const how = useLatch(useUi((s) => s.howToWatchOpen));
  const reel = useLatch(useUi((s) => s.reelActive));
  const turn = useLatch(useUi((s) => s.openTurn !== null));
  useEffect(() => (ready ? preloadWhenIdle(LazyPlayerSheet, LazyCityPopover) : undefined), [ready]);
  return (
    <>
      {player ? <LazyPlayerSheet /> : null}
      {how ? <LazyHowToWatch /> : null}
      {reel ? <LazyKeyMomentsReel /> : null}
      {turn ? <LazyTurnSheet /> : null}
    </>
  );
}

export function MatchPage({ id, pair, reel, start, linkedTurn = false }: MatchPageProps) {
  const layout = useLayout();
  const phase = useMatch((s) => s.phase);
  const hasFrame = useMatch((s) => s.frame !== null);
  const title = useMatch((s) => s.meta?.title ?? null);
  const seen = useUi((s) => s.onboardingSeen);
  const howOpen = useUi((s) => s.howToWatchOpen);
  const turnOpen = useUi((s) => s.openTurn !== null);

  useEffect(() => {
    uiActions.resetForMatch();
    openMatch(id, { start });
    return () => closeMatch();
  }, [id, start]);

  useEffect(() => {
    uiActions.syncPair(pair);
  }, [pair]);

  // A first visit opens "How to watch"; one that arrives by a shared turn link sees that turn
  // first, and "How to watch" once its detail is closed (never two sheets stacked).
  useEffect(() => {
    if (phase === "ready" && !seen && !linkedTurn && !turnOpen) uiActions.openHowToWatch();
  }, [phase, seen, linkedTurn, turnOpen]);

  useEffect(() => {
    if (reel && phase === "ready" && !howOpen && seen) uiActions.startReel();
  }, [reel, phase, howOpen, seen]);

  useEffect(() => {
    document.title = title === null ? "Perfidia" : `${title} · Perfidia`;
  }, [title]);

  if (phase === "error") return <ErrorView />;
  return (
    <div className={cn("relative flex flex-col", layout === "desktop" ? "h-dvh" : "min-h-dvh")}>
      <SkipLinks />
      <Header />
      <Banner />
      <ConnectionBanner />
      {!hasFrame ? (
        <LoadingView />
      ) : (
        <>
          <div className="px-3 pb-3">
            <StoryStrip />
          </div>
          {layout === "desktop" ? (
            <DesktopLayout />
          ) : layout === "tablet" ? (
            <TabletLayout />
          ) : (
            <PhoneLayout />
          )}
        </>
      )}
      <Overlays />
      <MomentAnnouncer />
    </div>
  );
}
